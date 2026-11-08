// Room client and state-sync library. Runs unchanged in Node (global WebSocket)
// and in a browser ES module.
//
// Responsibilities:
//   * connect to the room service and typed-error every rejection;
//   * join a room and follow roster/host/ready/start state;
//   * send input at 60 Hz and state at 20 Hz with per-sender sequence numbers;
//   * apply only strictly increasing sequence numbers (duplicates and
//     out-of-order messages never reach the application);
//   * ack applied messages, request resync of a gap, and replay from a bounded
//     sender cache;
//   * keep an interpolation buffer and a bounded correction helper;
//   * heartbeat, detect a dead socket and resume with the room token.
//
// There is no silent fallback: malformed data, an unknown message, a sequence
// buffer overflow, an unrecoverable resync or a missing final snapshot is a
// typed NetError and is surfaced to the caller.

import {
  PROTOCOL_VERSION,
  MESSAGE_SCHEMA,
  MAX_MESSAGE_BYTES,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  ERROR_CODES,
  NetError,
  isObject,
  isInteger,
  validName,
  validSeq,
  validTick,
  validChannel,
  validState,
  validInput,
  quantizeState,
  quantizeInput,
  errorFromMessage
} from './protocol.mjs';

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function summarize(samples) {
  if (!samples.length) return { count: 0, min: null, p50: null, p95: null, max: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return {
    count: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1]
  };
}

function quatDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

function quatNormalize(q) {
  const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  if (!(length > 0)) return [0, 0, 0, 1];
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

function quatSlerp(a, b, t) {
  let target = b;
  let dot = quatDot(a, target);
  if (dot < 0) { target = [-b[0], -b[1], -b[2], -b[3]]; dot = -dot; }
  if (dot > 0.9995) {
    return quatNormalize([
      a[0] + (target[0] - a[0]) * t,
      a[1] + (target[1] - a[1]) * t,
      a[2] + (target[2] - a[2]) * t,
      a[3] + (target[3] - a[3]) * t
    ]);
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinTheta = Math.sin(theta);
  const w0 = Math.sin((1 - t) * theta) / sinTheta;
  const w1 = Math.sin(t * theta) / sinTheta;
  return quatNormalize([
    a[0] * w0 + target[0] * w1,
    a[1] * w0 + target[1] * w1,
    a[2] * w0 + target[2] * w1,
    a[3] * w0 + target[3] * w1
  ]);
}

function quatAngle(a, b) {
  return 2 * Math.acos(Math.min(1, Math.abs(quatDot(a, b))));
}

/**
 * Deterministic outbound loss/latency on one channel. Used by the harness to
 * simulate 1% loss and 80 ms latency for one client's state channel. Control
 * messages (ack/resync/final) are never impaired, so recovery is measurable.
 */
export class LossLatencyImpairment {
  constructor({ lossRate = 0, latencyMs = 0, seed = 1, channel = 'state' } = {}) {
    if (!(lossRate >= 0 && lossRate <= 1)) throw new NetError(ERROR_CODES.NET_CONFIG, 'lossRate must be 0..1');
    if (!(latencyMs >= 0 && latencyMs <= 5000)) throw new NetError(ERROR_CODES.NET_CONFIG, 'latencyMs must be 0..5000');
    this.lossRate = lossRate;
    this.latencyMs = latencyMs;
    this.channel = channel;
    this.random = makeRng(seed);
    this.injectedDrops = 0;
    this.delayed = 0;
    this.failedSends = 0;
    this.pending = new Set();
  }

  dispatch(send) {
    if (this.lossRate > 0 && this.random() < this.lossRate) {
      this.injectedDrops++;
      return 'dropped';
    }
    if (this.latencyMs > 0) {
      const timer = setTimeout(() => {
        this.pending.delete(timer);
        try { send(); } catch { this.failedSends++; }
      }, this.latencyMs);
      this.pending.add(timer);
      this.delayed++;
      return 'delayed';
    }
    try { send(); } catch { this.failedSends++; return 'failed'; }
    return 'sent';
  }

  clear() {
    for (const timer of this.pending) clearTimeout(timer);
    this.pending.clear();
  }

  stats() {
    return {
      channel: this.channel,
      lossRate: this.lossRate,
      latencyMs: this.latencyMs,
      injectedDrops: this.injectedDrops,
      delayed: this.delayed,
      failedSends: this.failedSends,
      pending: this.pending.size
    };
  }
}

/**
 * Strictly ordered application of one sender's channel. Future sequence numbers
 * are buffered but never applied until the gap is filled. A duplicate is
 * counted and dropped. Applied sequence numbers are therefore contiguous by
 * construction; `violations` stays 0 unless the class itself is broken.
 */
export class OrderedStream {
  constructor({ channel, maxPending = 128 } = {}) {
    if (!validChannel(channel)) throw new NetError(ERROR_CODES.NET_CONFIG, 'invalid stream channel');
    this.channel = channel;
    this.expected = 1;
    this.lastApplied = 0;
    this.appliedSeqCount = 0;
    this.target = null;
    this.pending = new Map();
    this.maxPending = maxPending;
    this.duplicates = 0;
    this.outOfOrderBuffered = 0;
    this.overflow = 0;
    this.violations = 0;
  }

  _apply(message, applied) {
    if (message.seq !== this.lastApplied + 1) this.violations++;
    this.lastApplied = message.seq;
    this.expected = message.seq + 1;
    this.appliedSeqCount++;
    applied.push(message);
  }

  receive(message) {
    if (!validSeq(message.seq)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid sequence number');
    if (message.seq < this.expected) {
      this.duplicates++;
      return { applied: [], duplicate: true, buffered: false, overflow: false };
    }
    if (message.seq === this.expected) {
      const applied = [];
      this._apply(message, applied);
      while (this.pending.has(this.expected)) {
        const next = this.pending.get(this.expected);
        this.pending.delete(this.expected);
        this._apply(next, applied);
      }
      return { applied, duplicate: false, buffered: false, overflow: false };
    }
    if (this.pending.has(message.seq)) {
      this.duplicates++;
      return { applied: [], duplicate: true, buffered: false, overflow: false };
    }
    if (this.pending.size >= this.maxPending) {
      this.overflow++;
      return { applied: [], duplicate: false, buffered: false, overflow: true };
    }
    this.pending.set(message.seq, message);
    this.outOfOrderBuffered++;
    return { applied: [], duplicate: false, buffered: true, overflow: false };
  }

  markTarget(lastSeq) {
    if (!validSeq(lastSeq)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid target sequence');
    this.target = lastSeq;
  }

  get converged() {
    return this.target !== null && this.lastApplied >= this.target;
  }
}

/** Snapshot buffer with position lerp and quaternion slerp; never extrapolates. */
export class InterpolationBuffer {
  constructor({ maxTicks = 1200 } = {}) {
    this.states = new Map();
    this.ticks = [];
    this.maxTicks = maxTicks;
    this.misses = 0;
  }

  add(state) {
    if (this.states.has(state.tick)) return false;
    this.states.set(state.tick, state);
    let low = 0;
    let high = this.ticks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.ticks[middle] < state.tick) low = middle + 1;
      else high = middle;
    }
    this.ticks.splice(low, 0, state.tick);
    while (this.ticks.length > this.maxTicks) {
      const removed = this.ticks.shift();
      this.states.delete(removed);
    }
    return true;
  }

  latest() {
    return this.ticks.length ? this.states.get(this.ticks[this.ticks.length - 1]) : null;
  }

  /** Returns null when empty; `clamped:true` when renderTick is outside the buffer. */
  sample(renderTick) {
    if (!Number.isFinite(renderTick) || this.ticks.length === 0) return null;
    if (this.states.has(renderTick)) {
      return { ...this.states.get(renderTick), interpolated: false, clamped: false, alpha: 0 };
    }
    let low = 0;
    let high = this.ticks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.ticks[middle] < renderTick) low = middle + 1;
      else high = middle;
    }
    if (low === 0 || low >= this.ticks.length) {
      this.misses++;
      const state = this.states.get(this.ticks[low === 0 ? 0 : this.ticks.length - 1]);
      return { ...state, interpolated: false, clamped: true, alpha: 0 };
    }
    const a = this.states.get(this.ticks[low - 1]);
    const b = this.states.get(this.ticks[low]);
    const alpha = (renderTick - a.tick) / (b.tick - a.tick);
    return {
      tick: renderTick,
      position: [
        a.position[0] + (b.position[0] - a.position[0]) * alpha,
        a.position[1] + (b.position[1] - a.position[1]) * alpha,
        a.position[2] + (b.position[2] - a.position[2]) * alpha
      ],
      quaternion: quatSlerp(a.quaternion, b.quaternion, alpha),
      speed: a.speed + (b.speed - a.speed) * alpha,
      interpolated: true,
      clamped: false,
      alpha,
      from: a.tick,
      to: b.tick
    };
  }
}

/** Bounded correction: move at most maxPositionSpeed m/s and maxAngularSpeed rad/s. */
export class BoundedCorrector {
  constructor({ maxPositionSpeed = 2.5, maxAngularSpeed = 2.0 } = {}) {
    if (!(maxPositionSpeed > 0) || !(maxAngularSpeed > 0)) {
      throw new NetError(ERROR_CODES.NET_CONFIG, 'correction speeds must be positive');
    }
    this.maxPositionSpeed = maxPositionSpeed;
    this.maxAngularSpeed = maxAngularSpeed;
    this.position = [0, 0, 0];
    this.quaternion = [0, 0, 0, 1];
    this.steps = 0;
    this.maxStepDistance = 0;
    this.maxStepAngle = 0;
    this.clampedSteps = 0;
  }

  reset(state) {
    this.position = [...state.position];
    this.quaternion = [...state.quaternion];
  }

  correct(target, dt) {
    if (!(dt > 0)) throw new NetError(ERROR_CODES.NET_CONFIG, 'dt must be positive');
    const delta = [
      target.position[0] - this.position[0],
      target.position[1] - this.position[1],
      target.position[2] - this.position[2]
    ];
    const distance = Math.sqrt(delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]);
    const maxDistance = this.maxPositionSpeed * dt;
    const appliedDistance = Math.min(distance, maxDistance);
    if (distance > 0) {
      const factor = appliedDistance / distance;
      this.position = [
        this.position[0] + delta[0] * factor,
        this.position[1] + delta[1] * factor,
        this.position[2] + delta[2] * factor
      ];
    }
    const angle = quatAngle(this.quaternion, target.quaternion);
    const maxAngle = this.maxAngularSpeed * dt;
    const appliedAngle = Math.min(angle, maxAngle);
    if (angle > 0) this.quaternion = quatSlerp(this.quaternion, target.quaternion, appliedAngle / angle);
    const clamped = appliedDistance < distance - 1e-12 || appliedAngle < angle - 1e-12;
    if (clamped) this.clampedSteps++;
    this.steps++;
    this.maxStepDistance = Math.max(this.maxStepDistance, appliedDistance);
    this.maxStepAngle = Math.max(this.maxStepAngle, appliedAngle);
    return {
      position: [...this.position],
      quaternion: [...this.quaternion],
      remainingDistance: Math.max(0, distance - appliedDistance),
      remainingAngle: Math.max(0, angle - appliedAngle),
      appliedDistance,
      appliedAngle,
      clamped
    };
  }
}

export class NetClient {
  constructor(options = {}) {
    const {
      url,
      name,
      build = null,
      dataHash = null,
      autoReconnect = true,
      // The resume window is 30 s. A 250 ms base with a 1.5 s ceiling and 14
      // attempts covers ~18 s of failed connects, leaving time for the final
      // successful resume. A `NET_RESUME_IN_USE` reply is retried quickly and
      // separately: it means the server has not reaped the old half-open socket
      // yet, not that the token is invalid.
      maxReconnectAttempts = 14,
      reconnectDelayMs = 250,
      reconnectMaxDelayMs = 1500,
      resumeInUseRetryMs = 200,
      maxResumeInUseRetries = 30,
      requestTimeoutMs = 6000,
      heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
      impairment = null,
      maxPending = 128,
      // 20 s of replay covers the 15 s mobile-stall gate plus margin. At 60 Hz
      // input and 20 Hz state this is ~1,600 messages, below the 2,000 cap.
      // The resume window remains 30 s; the cache is per sender, bounded.
      cacheMs = 20_000,
      cacheMax = 2000
    } = options;

    if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) throw new NetError(ERROR_CODES.NET_CONFIG, 'url must be ws:// or wss://');
    if (!validName(name)) throw new NetError(ERROR_CODES.NET_CONFIG, 'name must be 1..24 printable characters');
    this.url = url;
    this.name = name.trim();
    this.build = build;
    this.dataHash = dataHash;
    this.autoReconnect = autoReconnect;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.reconnectDelayMs = reconnectDelayMs;
    this.reconnectMaxDelayMs = Math.max(reconnectDelayMs, reconnectMaxDelayMs);
    this.resumeInUseRetryMs = Math.max(25, resumeInUseRetryMs);
    this.maxResumeInUseRetries = Math.max(1, maxResumeInUseRetries);
    this.requestTimeoutMs = requestTimeoutMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.maxPending = maxPending;
    this.cacheMs = cacheMs;
    this.cacheMax = cacheMax;

    this._socket = null;
    this._connected = false;
    this._closing = false;
    this._welcome = null;
    this._room = null;
    this._self = null;
    this._started = null;
    this._lastMessageAt = 0;
    this._requestSeq = 0;
    this._pendingRequests = new Map();
    this._streams = new Map();
    this._latest = new Map();
    this._interp = new Map();
    this._correctors = new Map();
    this._sent = { state: 0, input: 0 };
    this._lastSent = { state: null, input: null };
    this._cache = { state: new Map(), input: new Map() };
    this._sentTimes = { state: new Map(), input: new Map() };
    this._finalTargets = new Map();
    this._rtt = { control: [], state: [], input: [] };
    this._resyncTimers = new Map();
    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._resumeInUseRetries = 0;
    this._serverShutdown = null;
    this._forcedDrop = null;
    this._listeners = new Map();
    this._listenerErrors = [];
    this._stats = {
      connects: 0,
      reconnects: 0,
      forcedDisconnects: 0,
      disconnected: 0,
      sendFailures: 0,
      selfEcho: 0,
      streamErrors: 0,
      unexpectedMessages: 0,
      retransmits: 0,
      resumeInUseRetries: 0,
      serverShutdowns: 0,
      heartbeatTimeouts: 0
    };
    this._impairment = impairment
      ? (impairment instanceof LossLatencyImpairment ? impairment : new LossLatencyImpairment(impairment))
      : null;
  }

  // ---------------------------------------------------------------- events
  on(event, listener) {
    if (typeof listener !== 'function') throw new NetError(ERROR_CODES.NET_CONFIG, 'listener must be a function');
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(listener);
    return () => this._listeners.get(event)?.delete(listener);
  }

  _emit(event, payload) {
    const listeners = this._listeners.get(event);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch (error) {
        this._listenerErrors.push({ event, message: String(error?.message || error) });
      }
    }
  }

  // -------------------------------------------------------------- getters
  get connected() { return this._connected; }
  get room() { return this._room; }
  get welcome() { return this._welcome; }
  get playerId() { return this._self?.id ?? null; }
  get resumeToken() { return this._self?.resumeToken ?? null; }
  get hostId() { return this._room?.hostId ?? null; }
  get isHost() { return this.playerId !== null && this.playerId === this.hostId; }
  get started() { return this._started; }

  // ------------------------------------------------------------- transport
  async connect() {
    if (this._socket) throw new NetError(ERROR_CODES.NET_ALREADY_IN_ROOM, 'socket already exists');
    this._closing = false;
    return this._openSocket();
  }

  _openSocket() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        finish(new NetError(ERROR_CODES.NET_TIMEOUT, 'welcome timed out', { url: this.url }));
        try { this._socket?.close(4000, 'welcome timeout'); } catch {}
      }, this.requestTimeoutMs);

      let socket;
      try {
        socket = new WebSocket(this.url);
      } catch (error) {
        finish(new NetError(ERROR_CODES.NET_CONFIG, 'WebSocket construction failed: ' + String(error?.message || error)));
        return;
      }
      this._socket = socket;
      this._welcome = null;
      this._stats.connects++;

      socket.addEventListener('message', (event) => {
        if (this._socket !== socket) return; // stale socket from a previous epoch
        this._onMessage(event, finish);
      });
      socket.addEventListener('close', (event) => {
        if (this._socket !== socket) {
          if (!settled) finish(new NetError(ERROR_CODES.NET_CLOSED, 'socket closed before welcome', { code: event.code, reason: event.reason }));
          return;
        }
        this._handleClose(event);
        if (!settled) finish(new NetError(ERROR_CODES.NET_CLOSED, 'socket closed before welcome', { code: event.code, reason: event.reason }));
      });
      socket.addEventListener('error', () => {
        if (!settled) finish(new NetError(ERROR_CODES.NET_NOT_CONNECTED, 'WebSocket error before welcome'));
      });
      socket.addEventListener('open', () => {});
    });
  }

  async _onMessage(event, connectFinish) {
    let text = event.data;
    try {
      if (typeof text !== 'string') {
        if (text instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(text));
        else if (ArrayBuffer.isView(text)) text = new TextDecoder().decode(text);
        else if (typeof text?.text === 'function') text = await text.text();
        else text = String(text);
      }
      const message = JSON.parse(text);
      if (!isObject(message) || typeof message.type !== 'string') {
        throw new NetError(ERROR_CODES.NET_PROTOCOL, 'server message must be an object with type');
      }
      this._lastMessageAt = nowMs();
      if (!this._welcome) {
        if (message.type !== 'welcome') {
          throw new NetError(ERROR_CODES.NET_PROTOCOL, 'first server message must be welcome, got ' + message.type);
        }
        if (message.protocol !== PROTOCOL_VERSION || message.schema !== MESSAGE_SCHEMA) {
          throw new NetError(ERROR_CODES.NET_VERSION, 'protocol mismatch', {
            expected: { protocol: PROTOCOL_VERSION, schema: MESSAGE_SCHEMA },
            got: { protocol: message.protocol, schema: message.schema }
          });
        }
        this._welcome = message;
        this._connected = true;
        this._startHeartbeat();
        connectFinish?.(null, message);
        this._emit('welcome', message);
        return;
      }
      this._dispatch(message);
    } catch (error) {
      const netError = error instanceof NetError ? error : new NetError(ERROR_CODES.NET_PROTOCOL, String(error?.message || error));
      if (connectFinish) connectFinish(netError);
      this._emit('error', netError);
      try { this._socket?.close(4002, netError.code); } catch {}
    }
  }

  _sendMessage(message) {
    if (!this._connected || !this._socket || this._socket.readyState !== 1) {
      throw new NetError(ERROR_CODES.NET_NOT_CONNECTED, 'socket is not open');
    }
    const text = JSON.stringify(message);
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > MAX_MESSAGE_BYTES) {
      throw new NetError(ERROR_CODES.NET_PROTOCOL, 'outbound message exceeds cap', { bytes, cap: MAX_MESSAGE_BYTES });
    }
    this._socket.send(text);
  }

  _request(type, payload, expectedTypes, timeoutMs = this.requestTimeoutMs) {
    if (!this._connected) return Promise.reject(new NetError(ERROR_CODES.NET_NOT_CONNECTED, 'not connected'));
    const requestId = 'rq_' + (++this._requestSeq);
    const expected = new Set(Array.isArray(expectedTypes) ? expectedTypes : [expectedTypes]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(requestId);
        reject(new NetError(ERROR_CODES.NET_TIMEOUT, 'request timed out: ' + type, { type, requestId }));
      }, timeoutMs);
      this._pendingRequests.set(requestId, { expected, resolve, reject, timer, type });
      try {
        this._sendMessage({ type, requestId, ...payload });
      } catch (error) {
        clearTimeout(timer);
        this._pendingRequests.delete(requestId);
        reject(error);
      }
    });
  }

  _resolveRequest(requestId, message) {
    const pending = this._pendingRequests.get(requestId);
    if (!pending) return false;
    if (!pending.expected.has(message.type)) return false;
    clearTimeout(pending.timer);
    this._pendingRequests.delete(requestId);
    pending.resolve(message);
    return true;
  }

  _rejectRequest(requestId, error) {
    const pending = this._pendingRequests.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this._pendingRequests.delete(requestId);
    pending.reject(error);
    return true;
  }

  _rejectRequests(error) {
    for (const [requestId, pending] of this._pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this._pendingRequests.delete(requestId);
    }
  }

  _startHeartbeat() {
    clearInterval(this._heartbeatTimer);
    this._lastMessageAt = nowMs();
    this._heartbeatTimer = setInterval(() => {
      if (!this._connected) return;
      if (nowMs() - this._lastMessageAt > this.heartbeatTimeoutMs) {
        this._stats.heartbeatTimeouts++;
        try { this._socket?.close(4001, 'heartbeat timeout'); } catch {}
        return;
      }
      try {
        this._sendMessage({ type: 'ping', id: 'hb_' + this._requestSeq, t: nowMs() });
      } catch (error) {
        this._stats.sendFailures++;
      }
    }, this.heartbeatIntervalMs);
  }

  _handleClose(event) {
    const wasConnected = this._connected;
    this._connected = false;
    this._socket = null;
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
    this._impairment?.clear();
    for (const timer of this._resyncTimers.values()) clearTimeout(timer);
    this._resyncTimers.clear();
    this._rejectRequests(new NetError(ERROR_CODES.NET_CLOSED, 'socket closed', { code: event?.code, reason: event?.reason }));
    if (this._closing) {
      this._emit('closed', { code: event?.code ?? 1000, reason: event?.reason ?? '' });
      return;
    }
    if (wasConnected) this._stats.disconnected++;
    const serverRestart = event?.code === 1012 || /server shutdown|service restart/i.test(event?.reason ?? '');
    if (serverRestart) {
      this._stats.serverShutdowns++;
      this._emit('serverShutdown', {
        code: event?.code ?? 1012,
        reason: event?.reason ?? 'server shutdown',
        message: this._serverShutdown
      });
    }
    this._emit('disconnected', { code: event?.code ?? null, reason: event?.reason ?? '' });
    if (this.autoReconnect && this._room && this._self?.resumeToken) {
      this._scheduleReconnect(serverRestart ? Math.max(500, this.reconnectDelayMs) : null);
    } else if (this._forcedDrop) {
      this._failForcedDrop(new NetError(ERROR_CODES.NET_NOT_CONNECTED, 'disconnected and reconnect is disabled'));
    }
  }

  _scheduleReconnect(delayOverride = null) {
    if (this._reconnectTimer) return;
    if (this._reconnectAttempts >= this.maxReconnectAttempts) {
      const error = new NetError(ERROR_CODES.NET_TIMEOUT, 'reconnect attempts exhausted');
      this._failForcedDrop(error);
      this._emit('reconnectFailed', error);
      return;
    }
    const delay = delayOverride ?? Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectDelayMs * 2 ** this._reconnectAttempts
    );
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectAttempts++;
      this._tryReconnect();
    }, Math.max(0, delay));
  }

  async _tryReconnect() {
    try {
      await this._openSocket();
      const joined = await this._request('room.join', {
        code: this._room.code,
        resumeToken: this._self.resumeToken,
        name: this.name
      }, 'room.joined');
      if (!joined.resumed) throw new NetError(ERROR_CODES.NET_RESUME_UNKNOWN, 'server did not resume the player');
      this._reconnectAttempts = 0;
      this._resumeInUseRetries = 0;
      this._stats.reconnects++;
      this._resyncAll();
      this._emit('resumed', { room: this._room, you: this._self, attempts: this._stats.reconnects });
      if (this._forcedDrop) {
        clearTimeout(this._forcedDrop.timer);
        this._forcedDrop.resolve({ resumed: true, room: this._room, you: this._self });
        this._forcedDrop = null;
      }
    } catch (error) {
      const netError = error instanceof NetError ? error : new NetError(ERROR_CODES.NET_REJECTED, String(error?.message || error));
      if (netError.code === ERROR_CODES.NET_RESUME_UNKNOWN ||
          netError.code === ERROR_CODES.NET_ROOM_NOT_FOUND ||
          netError.code === ERROR_CODES.NET_VERSION) {
        this._failForcedDrop(netError);
        this._emit('error', netError);
        this._emit('reconnectFailed', netError);
        return;
      }
      this._emit('reconnectAttempt', { attempt: this._reconnectAttempts, error: netError });
      if (netError.code === ERROR_CODES.NET_RESUME_IN_USE) {
        // The server still has the old half-open socket. It will reap it at its
        // heartbeat timeout; retry quickly without consuming the normal budget.
        this._resumeInUseRetries++;
        this._stats.resumeInUseRetries++;
        if (this._resumeInUseRetries > this.maxResumeInUseRetries) {
          this._failForcedDrop(netError);
          this._emit('error', netError);
          this._emit('reconnectFailed', netError);
          return;
        }
        this._reconnectAttempts = Math.max(0, this._reconnectAttempts - 1);
        this._scheduleReconnect(this.resumeInUseRetryMs);
        return;
      }
      if (netError.code === ERROR_CODES.NET_JOIN_RATE_LIMIT) {
        const retry = Number(netError.detail?.retryAfterMs);
        this._reconnectAttempts = Math.max(0, this._reconnectAttempts - 1);
        this._scheduleReconnect(Number.isFinite(retry) ? Math.min(5000, Math.max(100, retry)) : 1000);
        return;
      }
      this._scheduleReconnect();
    }
  }

  _resyncAll() {
    if (!this._room) return;
    for (const player of this._room.players) {
      if (player.id === this.playerId) continue;
      for (const channel of ['input', 'state']) {
        const stream = this._streams.get(this._key(player.id, channel));
        if (!stream) continue;
        this._requestResync(player.id, channel, stream.expected);
      }
    }
  }

  _failForcedDrop(error) {
    if (!this._forcedDrop) return;
    clearTimeout(this._forcedDrop.timer);
    this._forcedDrop.reject(error);
    this._forcedDrop = null;
  }

  /** Force a socket drop; resolves only after the room token has resumed. */
  simulateDrop({ timeoutMs = 15000 } = {}) {
    if (!this._connected || !this._room) {
      return Promise.reject(new NetError(ERROR_CODES.NET_NOT_CONNECTED, 'cannot drop a client that is not in a room'));
    }
    if (this._forcedDrop) return Promise.reject(new NetError(ERROR_CODES.NET_CONFIG, 'a forced drop is already pending'));
    this._stats.forcedDisconnects++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._forcedDrop = null;
        reject(new NetError(ERROR_CODES.NET_TIMEOUT, 'resume timed out'));
      }, timeoutMs);
      this._forcedDrop = { resolve, reject, timer };
      try { this._socket.close(4000, 'simulated drop'); } catch (error) {
        clearTimeout(timer);
        this._forcedDrop = null;
        reject(error);
      }
    });
  }

  close() {
    this._closing = true;
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    for (const timer of this._resyncTimers.values()) clearTimeout(timer);
    this._resyncTimers.clear();
    this._impairment?.clear();
    this._rejectRequests(new NetError(ERROR_CODES.NET_CLOSED, 'client closed'));
    this._failForcedDrop(new NetError(ERROR_CODES.NET_CLOSED, 'client closed'));
    if (this._socket) {
      try { this._socket.close(1000, 'client close'); } catch {}
    }
    this._connected = false;
  }

  // --------------------------------------------------------------- dispatch
  _dispatch(message) {
    switch (message.type) {
      case 'heartbeat':
        return this._emit('heartbeat', message);
      case 'server.shutdown':
        this._serverShutdown = message;
        this._emit('serverShutdown', message);
        return;
      case 'pong':
        if (Number.isFinite(message.t)) this._rtt.control.push(nowMs() - message.t);
        this._emit('pong', message);
        return;
      case 'room.created':
      case 'room.joined': {
        if (!isObject(message.room) || !Array.isArray(message.room.players) || !isObject(message.you)) {
          throw new NetError(ERROR_CODES.NET_PROTOCOL, 'room create/join response is malformed');
        }
        this._room = message.room;
        this._self = message.you;
        if (this._resolveRequest(message.requestId, message)) { /* handled */ }
        this._emit('room', { room: this._room, you: this._self, resumed: message.resumed === true });
        return;
      }
      case 'room.state': {
        if (!isObject(message.room) || !Array.isArray(message.room.players)) {
          throw new NetError(ERROR_CODES.NET_PROTOCOL, 'room.state is malformed');
        }
        this._room = message.room;
        if (this._self) {
          const self = this._room.players.find((player) => player.id === this._self.id);
          if (self) this._self = { ...this._self, host: self.host };
        }
        this._emit('room', { room: this._room, you: this._self, resumed: false });
        return;
      }
      case 'room.started': {
        if (!isObject(message.room) || !Number.isInteger(message.startTick) || typeof message.seed !== 'string') {
          throw new NetError(ERROR_CODES.NET_PROTOCOL, 'room.started is malformed');
        }
        this._room = message.room;
        this._started = { startTick: message.startTick, seed: message.seed, tickHz: message.tickHz ?? 60 };
        this._resolveRequest(message.requestId, message);
        this._emit('started', this._started);
        return;
      }
      case 'room.finished':
        if (isObject(message.room)) this._room = message.room;
        this._emit('finished', message);
        return;
      case 'player.joined':
      case 'player.resumed':
      case 'player.disconnected':
      case 'player.left':
      case 'player.finished':
        this._emit(message.type, message);
        return;
      case 'state':
      case 'input':
        return this._receiveStream(message);
      case 'ack':
        return this._receiveAck(message);
      case 'resync':
        return this._replayFromCache(message);
      case 'stream.final':
        return this._receiveFinal(message);
      case 'stream.error': {
        this._stats.streamErrors++;
        const error = new NetError(message.code === ERROR_CODES.NET_RESYNC_RANGE ? ERROR_CODES.NET_RESYNC_RANGE : ERROR_CODES.NET_REJECTED,
          'sender reports a stream error', { from: message.from, channel: message.channel, detail: message.detail ?? null });
        this._emit('error', error);
        return;
      }
      case 'ok':
        if (!this._resolveRequest(message.requestId, message)) {
          this._emit('ok', message);
        }
        return;
      case 'error': {
        const error = errorFromMessage(message);
        if (message.requestId && this._rejectRequest(message.requestId, error)) return;
        this._emit('error', error);
        if (message.fatal) {
          this._emit('fatal', error);
          try { this._socket?.close(1008, error.code); } catch {}
        }
        return;
      }
      default:
        this._stats.unexpectedMessages++;
        this._emit('error', new NetError(ERROR_CODES.NET_UNEXPECTED_MESSAGE, 'unexpected server message type: ' + message.type));
    }
  }

  _key(playerId, channel) { return playerId + ':' + channel; }

  _stream(playerId, channel) {
    const key = this._key(playerId, channel);
    let stream = this._streams.get(key);
    if (!stream) {
      stream = new OrderedStream({ channel, maxPending: this.maxPending });
      this._streams.set(key, stream);
    }
    return stream;
  }

  _receiveStream(message) {
    if (typeof message.from !== 'string' || !validChannel(message.channel) || !validSeq(message.seq) || !validTick(message.tick)) {
      throw new NetError(ERROR_CODES.NET_PROTOCOL, 'state/input envelope is malformed');
    }
    if (message.from === this.playerId) {
      this._stats.selfEcho++;
      return;
    }
    if (message.channel === 'state') {
      if (!validState(message.state)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'relayed state is invalid');
      if (message.state.tick !== message.tick) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'relayed state tick mismatch');
    } else if (!validInput(message.input)) {
      throw new NetError(ERROR_CODES.NET_PROTOCOL, 'relayed input is invalid');
    }
    const stream = this._stream(message.from, message.channel);
    const outcome = stream.receive(message);
    if (outcome.overflow) {
      const error = new NetError(ERROR_CODES.NET_BUFFER_OVERFLOW, 'receive buffer overflow', {
        from: message.from, channel: message.channel, pending: stream.pending.size, cap: stream.maxPending
      });
      this._emit('error', error);
      throw error;
    }
    for (const applied of outcome.applied) {
      if (message.channel === 'state') {
        const state = quantizeState(applied.state);
        const record = { from: applied.from, seq: applied.seq, tick: applied.tick, state, authority: applied.authority === true, sentAt: applied.sentAt };
        this._latest.set(applied.from, record);
        const interp = this._interp.get(applied.from) ?? new InterpolationBuffer();
        interp.add(state);
        this._interp.set(applied.from, interp);
        this._emit('stateApplied', record);
      } else {
        this._emit('inputApplied', {
          from: applied.from, seq: applied.seq, tick: applied.tick,
          input: quantizeInput(applied.input), authority: applied.authority === true
        });
      }
      this._sendMessage({
        type: 'ack',
        channel: applied.channel,
        to: applied.from,
        seq: applied.seq,
        sentAt: applied.sentAt ?? null
      });
    }
    if (outcome.buffered || stream.pending.size > 0) {
      this._scheduleResync(message.from, message.channel, 40);
    }
  }

  _receiveAck(message) {
    if (!validChannel(message.channel) || !validSeq(message.seq)) {
      throw new NetError(ERROR_CODES.NET_PROTOCOL, 'ack is malformed');
    }
    const times = this._sentTimes[message.channel];
    const sentAt = times.get(message.seq);
    if (Number.isFinite(sentAt)) {
      const rtt = nowMs() - sentAt;
      this._rtt[message.channel].push(rtt);
      if (this._rtt[message.channel].length > 4000) this._rtt[message.channel].splice(0, 1000);
      this._emit('ack', { channel: message.channel, seq: message.seq, rtt, from: message.from });
    }
  }

  _receiveFinal(message) {
    if (typeof message.from !== 'string' || !validChannel(message.channel) || !validSeq(message.lastSeq) || !validTick(message.tick)) {
      throw new NetError(ERROR_CODES.NET_PROTOCOL, 'stream.final is malformed');
    }
    if (message.from === this.playerId) return;
    const stream = this._stream(message.from, message.channel);
    stream.markTarget(message.lastSeq);
    this._finalTargets.set(this._key(message.from, message.channel), {
      from: message.from, channel: message.channel, lastSeq: message.lastSeq, tick: message.tick
    });
    this._emit('streamFinal', message);
    if (!stream.converged) this._scheduleResync(message.from, message.channel, 25);
  }

  _scheduleResync(playerId, channel, delayMs = 60) {
    const key = this._key(playerId, channel);
    if (this._resyncTimers.has(key)) return;
    const timer = setTimeout(() => {
      this._resyncTimers.delete(key);
      const stream = this._streams.get(key);
      if (!stream || stream.converged) return;
      this._requestResync(playerId, channel, stream.expected);
      if (stream.target !== null && !stream.converged) this._scheduleResync(playerId, channel, 200);
    }, delayMs);
    this._resyncTimers.set(key, timer);
  }

  _requestResync(playerId, channel, fromSeq) {
    if (!this._connected) return;
    try {
      this._sendMessage({ type: 'resync', channel, to: playerId, fromSeq });
    } catch (error) {
      this._stats.sendFailures++;
    }
  }

  _replayFromCache(message) {
    if (!validChannel(message.channel) || typeof message.to !== 'string' || !validSeq(message.fromSeq)) {
      throw new NetError(ERROR_CODES.NET_PROTOCOL, 'resync is malformed');
    }
    const cache = this._cache[message.channel];
    const entries = [...cache.entries()].sort((a, b) => a[0] - b[0]);
    if (entries.length === 0 || message.fromSeq < entries[0][0]) {
      try {
        this._sendMessage({
          type: 'stream.error', channel: message.channel, to: message.to,
          code: ERROR_CODES.NET_RESYNC_RANGE,
          detail: { fromSeq: message.fromSeq, oldest: entries[0]?.[0] ?? null }
        });
      } catch { this._stats.sendFailures++; }
      return;
    }
    for (const [seq, entry] of entries) {
      if (seq < message.fromSeq) continue;
      this._transmit(entry.message, true);
    }
  }

  // -------------------------------------------------------------- public API
  async createRoom({ name = this.name, maxPlayers, map, car, powerups } = {}) {
    const message = await this._request('room.create', { name, maxPlayers, map, car, powerups }, 'room.created');
    return { room: message.room, you: message.you };
  }

  async joinRoom({ code, car, resumeToken = null, name = this.name } = {}) {
    const normalized = typeof code === 'string' ? code.trim().toUpperCase() : code;
    const message = await this._request('room.join', { code: normalized, car, resumeToken, name }, 'room.joined');
    return { room: message.room, you: message.you, resumed: message.resumed === true };
  }

  async leave() {
    return this._request('room.leave', {}, 'ok');
  }

  async setReady(ready) {
    return this._request('player.ready', { ready: Boolean(ready) }, 'ok');
  }

  async select({ car, map, powerups } = {}) {
    return this._request('player.select', { car, map, powerups }, 'ok');
  }

  async start({ seed, solo } = {}) {
    const payload = {};
    if (seed !== undefined) payload.seed = seed;
    if (solo === true) payload.solo = true;
    const message = await this._request('room.start', payload, 'room.started');
    return { room: message.room, startTick: message.startTick, seed: message.seed, tickHz: message.tickHz };
  }

  _transmit(message, retransmit = false) {
    if (retransmit) this._stats.retransmits++;
    if (this._impairment && message.type === 'state') {
      this._impairment.dispatch(() => this._sendMessage(message));
      return;
    }
    this._sendMessage(message);
  }

  _cacheMessage(channel, message) {
    const cache = this._cache[channel];
    const at = nowMs();
    cache.set(message.seq, { message, at });
    while (cache.size > this.cacheMax) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    for (const [seq, entry] of cache) {
      if (at - entry.at <= this.cacheMs) break;
      cache.delete(seq);
    }
  }

  sendInput(input, tick) {
    if (!this._connected) throw new NetError(ERROR_CODES.NET_NOT_CONNECTED, 'not connected');
    if (!this._room || this._room.phase !== 'running') throw new NetError(ERROR_CODES.NET_ROOM_NOT_RUNNING, 'room is not running');
    if (!validTick(tick)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'input tick must be a non-negative integer');
    const quantized = quantizeInput(input);
    const seq = ++this._sent.input;
    const message = { type: 'input', channel: 'input', seq, tick, input: quantized, sentAt: nowMs() };
    this._lastSent.input = { tick, input: quantized };
    this._sentTimes.input.set(seq, message.sentAt);
    this._cacheMessage('input', message);
    this._transmit(message);
    return { seq, tick };
  }

  sendState(state) {
    if (!this._connected) throw new NetError(ERROR_CODES.NET_NOT_CONNECTED, 'not connected');
    if (!this._room || this._room.phase !== 'running') throw new NetError(ERROR_CODES.NET_ROOM_NOT_RUNNING, 'room is not running');
    const quantized = quantizeState(state);
    const seq = ++this._sent.state;
    const message = { type: 'state', channel: 'state', seq, tick: quantized.tick, state: quantized, sentAt: nowMs() };
    this._lastSent.state = quantized;
    this._sentTimes.state.set(seq, message.sentAt);
    this._cacheMessage('state', message);
    this._transmit(message);
    return { seq, tick: quantized.tick };
  }

  finalizeStreams() {
    if (!this._connected) throw new NetError(ERROR_CODES.NET_NOT_CONNECTED, 'not connected');
    const tick = this._lastSent.state?.tick ?? this._lastSent.input?.tick ?? 0;
    for (const channel of ['state', 'input']) {
      this._sendMessage({ type: 'stream.final', channel, lastSeq: this._sent[channel], tick });
    }
    return { state: this._sent.state, input: this._sent.input, tick };
  }

  streamsConverged() {
    if (!this._room) return false;
    for (const player of this._room.players) {
      if (player.id === this.playerId) continue;
      for (const channel of ['input', 'state']) {
        const stream = this._streams.get(this._key(player.id, channel));
        if (!stream || stream.target === null || !stream.converged) return false;
      }
    }
    return true;
  }

  async waitForStreams(timeoutMs = 8000) {
    const deadline = nowMs() + timeoutMs;
    while (nowMs() < deadline) {
      if (this.streamsConverged()) return this.stats();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const missing = [];
    if (this._room) {
      for (const player of this._room.players) {
        if (player.id === this.playerId) continue;
        for (const channel of ['input', 'state']) {
          const stream = this._streams.get(this._key(player.id, channel));
          if (!stream || stream.target === null || !stream.converged) {
            missing.push({
              playerId: player.id, channel,
              target: stream?.target ?? null, lastApplied: stream?.lastApplied ?? 0,
              expected: stream?.expected ?? 1
            });
          }
        }
      }
    }
    throw new NetError(ERROR_CODES.NET_TIMEOUT, 'streams did not converge', { timeoutMs, missing });
  }

  buildFinalTable(tick) {
    if (!this._room) throw new NetError(ERROR_CODES.NET_NOT_IN_ROOM, 'not in a room');
    if (!validTick(tick)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid final tick');
    const rows = [];
    for (const player of [...this._room.players].sort((a, b) => a.slot - b.slot)) {
      if (player.id === this.playerId) {
        const state = this._lastSent.state;
        if (!state || state.tick !== tick) {
          throw new NetError(ERROR_CODES.NET_FINAL_MISSING, 'own final state is not at the final tick', { tick, have: state?.tick ?? null });
        }
        rows.push({ id: player.id, slot: player.slot, car: player.car, state });
      } else {
        const stream = this._streams.get(this._key(player.id, 'state'));
        if (!stream || stream.target === null || !stream.converged) {
          throw new NetError(ERROR_CODES.NET_FINAL_MISSING, 'remote final stream did not converge', {
            playerId: player.id, target: stream?.target ?? null, lastApplied: stream?.lastApplied ?? 0
          });
        }
        const latest = this._latest.get(player.id);
        if (!latest || latest.state.tick !== tick) {
          throw new NetError(ERROR_CODES.NET_FINAL_MISSING, 'remote final snapshot is not at the final tick', {
            playerId: player.id, tick, have: latest?.state.tick ?? null
          });
        }
        rows.push({ id: player.id, slot: player.slot, car: player.car, state: latest.state });
      }
    }
    return rows.map((row) => ({
      slot: row.slot,
      car: row.car,
      tick: row.state.tick,
      position: row.state.position,
      quaternion: row.state.quaternion,
      speed: row.state.speed
    }));
  }

  sampleRemote(playerId, renderTick) {
    return this._interp.get(playerId)?.sample(renderTick) ?? null;
  }

  latestRemote(playerId) {
    return this._latest.get(playerId) ?? null;
  }

  correctorFor(playerId, options = {}) {
    let corrector = this._correctors.get(playerId);
    if (!corrector) {
      corrector = new BoundedCorrector(options);
      const latest = this._latest.get(playerId);
      if (latest) corrector.reset(latest.state);
      this._correctors.set(playerId, corrector);
    }
    return corrector;
  }

  async reportFinished({ tick, hash }) {
    return this._request('client.finished', { tick, hash }, 'ok');
  }

  stats() {
    const streams = [...this._streams.entries()].map(([key, stream]) => ({
      key,
      channel: stream.channel,
      from: key.slice(0, key.lastIndexOf(':')),
      expected: stream.expected,
      lastApplied: stream.lastApplied,
      appliedSeqCount: stream.appliedSeqCount,
      target: stream.target,
      converged: stream.converged,
      duplicates: stream.duplicates,
      outOfOrderBuffered: stream.outOfOrderBuffered,
      overflow: stream.overflow,
      violations: stream.violations,
      pending: stream.pending.size
    }));
    const targets = [...this._finalTargets.values()];
    return {
      connected: this._connected,
      playerId: this.playerId,
      playerSlot: this._room?.players.find((player) => player.id === this.playerId)?.slot ?? null,
      hostId: this.hostId,
      isHost: this.isHost,
      roomCode: this._room?.code ?? null,
      roomPhase: this._room?.phase ?? null,
      sent: { ...this._sent },
      received: {
        state: streams.filter((stream) => stream.channel === 'state').reduce((sum, stream) => sum + stream.appliedSeqCount, 0),
        input: streams.filter((stream) => stream.channel === 'input').reduce((sum, stream) => sum + stream.appliedSeqCount, 0)
      },
      streams,
      finalTargets: targets,
      rtt: {
        control: summarize(this._rtt.control),
        state: summarize(this._rtt.state),
        input: summarize(this._rtt.input)
      },
      impairment: this._impairment?.stats() ?? null,
      counters: { ...this._stats },
      listenerErrors: [...this._listenerErrors]
    };
  }
}

export { NetError, ERROR_CODES };
