// Deterministic fakes for the WebRTC adapter test harness.
//
//   FakeHub                 in-process room service speaking the net-mvp v1
//                           room protocol plus the signal.* relay
//   FakeWebSocket           the subset of WebSocket that NetClient uses
//   FakePeerNetwork         two RTCPeerConnections with SCTP-shaped channels
//   FakeRTCPeerConnection   the subset of the browser API the adapter touches
//
// The network is intentionally not a WebRTC implementation. It models the two
// properties the adapter depends on: reliable/ordered event delivery and
// unreliable/unordered snapshot delivery with deterministic loss and reorder.
// ICE is reduced to a session that can be failed, restarted or blocked.
//
// No Node imports, so the same fakes can be loaded by a browser page.

import {
  PROTOCOL_VERSION,
  MESSAGE_SCHEMA,
  ROOM_CODE_ALPHABET,
  TICK_HZ,
  validRoomCode
} from '../net-mvp/protocol.mjs';

const ALPHABET = ROOM_CODE_ALPHABET;
let idCounter = 0;

function nextId(prefix) {
  idCounter++;
  let value = idCounter;
  let text = '';
  for (let index = 0; index < 16; index++) {
    text += (value % 16).toString(16);
    value = Math.floor(value / 16) + index * 7;
  }
  return prefix + text;
}

function token() {
  let text = '';
  let value = (idCounter + 1) * 2654435761;
  for (let index = 0; index < 48; index++) {
    value = (value * 1103515245 + 12345) >>> 0;
    text += (value % 16).toString(16);
  }
  return text;
}

function roomCode(counter) {
  let value = counter;
  let code = '';
  for (let index = 0; index < 5; index++) {
    code += ALPHABET[value % ALPHABET.length];
    value = Math.floor(value / ALPHABET.length) + 13;
  }
  return code;
}

function encodeSdp(sessionId, generation) {
  return 'v=0\r\nfake-session:' + sessionId + '\r\nfake-generation:' + generation + '\r\n';
}

function decodeSdp(text) {
  if (typeof text !== 'string') return null;
  const match = /fake-session:([^\r\n]+)/.exec(text);
  if (!match) return null;
  const generation = /fake-generation:(\d+)/.exec(text);
  return { sessionId: match[1], generation: generation ? Number(generation[1]) : 1 };
}

/**
 * Room service fake. It implements exactly the messages the adapter (and the
 * inherited NetClient) sends, with the same reply shapes as net-mvp.
 */
export class FakeHub {
  constructor() {
    this.rooms = new Map();
    this.sessions = new Map();
    this.stats = {
      connections: 0,
      messagesIn: 0,
      messagesOut: 0,
      relayed: 0,
      signalsRelayed: 0,
      bytesIn: 0,
      bytesOut: 0,
      roomsCreated: 0,
      resumes: 0,
      closes: 0,
      errors: 0,
      byType: {}
    };
    this.roomCounter = 0;
    this.delivery = 'sync';
    this.closed = false;
  }

  connect() {
    if (this.closed) throw new Error('hub is closed');
    const session = {
      id: 'cn_' + (++idCounter),
      socket: null,
      roomCode: null,
      playerId: null,
      lastSeen: Date.now()
    };
    const socket = new FakeWebSocket(this, session);
    session.socket = socket;
    this.sessions.set(session.id, session);
    this.stats.connections++;
    return socket;
  }

  _count(type, bytes, direction) {
    const entry = this.stats.byType[type] ?? { in: 0, out: 0, bytesIn: 0, bytesOut: 0 };
    entry[direction]++;
    entry[direction === 'in' ? 'bytesIn' : 'bytesOut'] += bytes;
    this.stats.byType[type] = entry;
  }

  send(session, message) {
    if (!session.socket || session.socket.readyState !== 1) return false;
    const text = JSON.stringify(message);
    this.stats.messagesOut++;
    this.stats.bytesOut += text.length;
    this._count(message.type, text.length, 'out');
    session.socket._deliver(text);
    return true;
  }

  error(session, code, message, requestId = null, fatal = false) {
    this.stats.errors++;
    this.send(session, { type: 'error', code, message, detail: null, requestId, fatal });
  }

  receive(session, text) {
    this.stats.messagesIn++;
    this.stats.bytesIn += String(text).length;
    let message;
    try { message = JSON.parse(text); } catch {
      this.error(session, 'NET_PROTOCOL', 'message is not JSON', null, true);
      return;
    }
    if (!message || typeof message.type !== 'string') {
      this.error(session, 'NET_PROTOCOL', 'message.type is required', null, true);
      return;
    }
    this._count(message.type, String(text).length, 'in');
    const requestId = typeof message.requestId === 'string' ? message.requestId : null;
    try {
      this._handle(session, message, requestId);
    } catch (error) {
      this.error(session, error.code ?? 'NET_REJECTED', String(error.message ?? error), requestId);
    }
  }

  _roomFor(session) {
    const room = this.rooms.get(session.roomCode);
    if (!room) throw Object.assign(new Error('not in a room'), { code: 'NET_NOT_IN_ROOM' });
    const player = room.players.get(session.playerId);
    if (!player) throw Object.assign(new Error('player missing'), { code: 'NET_NOT_IN_ROOM' });
    return { room, player };
  }

  _view(room) {
    return {
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      map: room.map,
      maxPlayers: room.maxPlayers,
      seed: room.seed,
      startTick: room.startTick,
      tickHz: TICK_HZ,
      createdAt: room.createdAt,
      players: [...room.players.values()]
        .sort((a, b) => a.slot - b.slot)
        .map((player) => ({
          id: player.id,
          slot: player.slot,
          name: player.name,
          car: player.car,
          ready: player.ready,
          connected: player.connected,
          host: room.hostId === player.id,
          resumedCount: player.resumedCount
        }))
    };
  }

  _broadcast(room, message, exceptId = null) {
    for (const player of room.players.values()) {
      if (!player.connected || !player.session) continue;
      if (player.id === exceptId) continue;
      this.send(player.session, message);
    }
  }

  _broadcastRoom(room, exceptId = null) {
    this._broadcast(room, { type: 'room.state', room: this._view(room), serverTime: Date.now() }, exceptId);
  }

  _slot(room) {
    const used = new Set([...room.players.values()].map((player) => player.slot));
    for (let slot = 1; slot <= room.maxPlayers; slot++) if (!used.has(slot)) return slot;
    return null;
  }

  _handle(session, message, requestId) {
    switch (message.type) {
      case 'ping':
        this.send(session, { type: 'pong', requestId, id: message.id ?? null, t: message.t ?? null, serverTime: Date.now() });
        return;
      case 'room.create': {
        if (session.roomCode) throw Object.assign(new Error('already in a room'), { code: 'NET_ALREADY_IN_ROOM' });
        const code = roomCode(++this.roomCounter);
        const room = {
          code,
          phase: 'lobby',
          hostId: null,
          map: message.map ?? 'usa_la_river',
          maxPlayers: Math.max(2, Math.min(20, message.maxPlayers ?? 8)),
          seed: null,
          startTick: null,
          createdAt: Date.now(),
          players: new Map(),
          finished: new Map()
        };
        const player = this._addPlayer(room, session, message.name ?? 'Host', message.car ?? 'car');
        room.hostId = player.id;
        this.rooms.set(code, room);
        this.stats.roomsCreated++;
        this.send(session, {
          type: 'room.created', requestId, room: this._view(room),
          you: { id: player.id, slot: player.slot, name: player.name, resumeToken: player.resumeToken, host: true },
          serverTime: Date.now()
        });
        return;
      }
      case 'room.join': {
        if (session.roomCode) throw Object.assign(new Error('already in a room'), { code: 'NET_ALREADY_IN_ROOM' });
        const code = String(message.code ?? '').trim().toUpperCase();
        if (!validRoomCode(code)) throw Object.assign(new Error('invalid room code'), { code: 'NET_ROOM_NOT_FOUND' });
        const room = this.rooms.get(code);
        if (!room) throw Object.assign(new Error('room not found'), { code: 'NET_ROOM_NOT_FOUND' });
        if (typeof message.resumeToken === 'string') {
          const existing = [...room.players.values()].find((player) => player.resumeToken === message.resumeToken);
          if (!existing) throw Object.assign(new Error('unknown resume token'), { code: 'NET_RESUME_UNKNOWN' });
          existing.connected = true;
          existing.session = session;
          existing.resumedCount++;
          session.roomCode = room.code;
          session.playerId = existing.id;
          this.stats.resumes++;
          this.send(session, {
            type: 'room.joined', requestId, resumed: true, room: this._view(room),
            you: { id: existing.id, slot: existing.slot, name: existing.name, resumeToken: existing.resumeToken, host: room.hostId === existing.id },
            serverTime: Date.now()
          });
          this._broadcast(room, { type: 'player.resumed', playerId: existing.id, slot: existing.slot, serverTime: Date.now() }, existing.id);
          this._broadcastRoom(room);
          return;
        }
        if (room.phase !== 'lobby') throw Object.assign(new Error('room started'), { code: 'NET_ROOM_STARTED' });
        if (room.players.size >= room.maxPlayers) throw Object.assign(new Error('room full'), { code: 'NET_ROOM_FULL' });
        const player = this._addPlayer(room, session, message.name ?? 'Guest', message.car ?? 'car');
        session.roomCode = room.code;
        session.playerId = player.id;
        this.send(session, {
          type: 'room.joined', requestId, resumed: false, room: this._view(room),
          you: { id: player.id, slot: player.slot, name: player.name, resumeToken: player.resumeToken, host: false },
          serverTime: Date.now()
        });
        this._broadcastRoom(room, player.id);
        return;
      }
      case 'room.leave': {
        const { room, player } = this._roomFor(session);
        room.players.delete(player.id);
        session.roomCode = null;
        session.playerId = null;
        this.send(session, { type: 'ok', requestId, action: 'room.leave' });
        if (room.hostId === player.id) {
          const next = [...room.players.values()].sort((a, b) => a.slot - b.slot)[0];
          if (next) room.hostId = next.id;
        }
        this._broadcastRoom(room);
        return;
      }
      case 'player.ready': {
        const { room, player } = this._roomFor(session);
        player.ready = message.ready === true;
        this.send(session, { type: 'ok', requestId, action: 'player.ready', ready: player.ready });
        this._broadcastRoom(room);
        return;
      }
      case 'player.select': {
        const { room, player } = this._roomFor(session);
        if (message.car !== undefined) player.car = message.car;
        if (message.map !== undefined) {
          if (room.hostId !== player.id) throw Object.assign(new Error('only host selects map'), { code: 'NET_NOT_HOST' });
          room.map = message.map;
        }
        this.send(session, { type: 'ok', requestId, action: 'player.select', car: player.car, map: room.map });
        this._broadcastRoom(room);
        return;
      }
      case 'room.start': {
        const { room, player } = this._roomFor(session);
        if (room.hostId !== player.id) throw Object.assign(new Error('only the host can start'), { code: 'NET_NOT_HOST' });
        if (room.phase !== 'lobby') throw Object.assign(new Error('not in lobby'), { code: 'NET_ROOM_NOT_RUNNING' });
        const connected = [...room.players.values()].filter((entry) => entry.connected);
        const minPlayers = message.solo === true ? 1 : 2;
        if (connected.length < minPlayers) throw Object.assign(new Error('not enough players'), { code: 'NET_NOT_ENOUGH_PLAYERS' });
        if (connected.some((entry) => !entry.ready)) throw Object.assign(new Error('players not ready'), { code: 'NET_NOT_READY' });
        room.phase = 'running';
        room.seed = message.seed ?? 'fake-seed';
        room.startTick = 1;
        room.finished.clear();
        const started = {
          type: 'room.started', room: this._view(room), startTick: 1, seed: room.seed,
          tickHz: TICK_HZ, serverTime: Date.now()
        };
        this.send(session, { ...started, requestId });
        this._broadcast(room, started, player.id);
        return;
      }
      case 'state':
      case 'input': {
        const { room, player } = this._roomFor(session);
        if (room.phase !== 'running') throw Object.assign(new Error('not running'), { code: 'NET_ROOM_NOT_RUNNING' });
        const relay = {
          type: message.type,
          from: player.id,
          channel: message.type,
          seq: message.seq,
          tick: message.tick,
          sentAt: Number.isFinite(message.sentAt) ? message.sentAt : null,
          authority: room.hostId === player.id
        };
        if (message.type === 'state') relay.state = message.state;
        else relay.input = message.input;
        this.stats.relayed++;
        this._broadcast(room, relay, player.id);
        return;
      }
      case 'ack':
      case 'resync':
      case 'stream.error': {
        const { room, player } = this._roomFor(session);
        const target = room.players.get(message.to);
        if (!target || !target.connected || !target.session) return;
        const relay = { ...message, from: player.id };
        delete relay.requestId;
        this.stats.relayed++;
        this.send(target.session, relay);
        return;
      }
      case 'stream.final': {
        const { room, player } = this._roomFor(session);
        this.stats.relayed++;
        this._broadcast(room, { ...message, from: player.id }, player.id);
        return;
      }
      case 'client.finished': {
        const { room, player } = this._roomFor(session);
        room.finished.set(player.id, { tick: message.tick, hash: message.hash });
        this.send(session, { type: 'ok', requestId, action: 'client.finished' });
        this._broadcast(room, { type: 'player.finished', playerId: player.id, tick: message.tick, hash: message.hash }, player.id);
        const connected = [...room.players.values()].filter((entry) => entry.connected);
        if (connected.length > 0 && connected.every((entry) => room.finished.has(entry.id))) {
          room.phase = 'finished';
          const results = connected.sort((a, b) => a.slot - b.slot)
            .map((entry) => ({ playerId: entry.id, slot: entry.slot, ...room.finished.get(entry.id) }));
          this._broadcast(room, { type: 'room.finished', room: this._view(room), results, serverTime: Date.now() });
        }
        return;
      }
      case 'signal.offer':
      case 'signal.answer':
      case 'signal.ice':
      case 'signal.bye': {
        const { room, player } = this._roomFor(session);
        const target = room.players.get(message.to);
        if (!target) throw Object.assign(new Error('unknown signal target'), { code: 'NET_PLAYER_NOT_FOUND' });
        this.stats.signalsRelayed++;
        this.send(target.session, {
          type: message.type,
          from: player.id,
          to: target.id,
          epoch: message.epoch,
          sdp: message.sdp,
          candidate: message.candidate,
          reason: message.reason
        });
        return;
      }
      default:
        throw Object.assign(new Error('unknown message type: ' + message.type), { code: 'NET_PROTOCOL' });
    }
  }

  _addPlayer(room, session, name, car) {
    const player = {
      id: nextId('pl_'),
      slot: this._slot(room),
      name: String(name).slice(0, 24),
      car,
      ready: false,
      connected: true,
      session,
      resumeToken: token(),
      resumedCount: 0
    };
    room.players.set(player.id, player);
    session.roomCode = room.code;
    session.playerId = player.id;
    return player;
  }

  closeSession(session, reason = 'closed') {
    this.stats.closes++;
    if (!session.roomCode) return;
    const room = this.rooms.get(session.roomCode);
    if (!room) return;
    const player = room.players.get(session.playerId);
    if (!player) return;
    player.connected = false;
    player.session = null;
    this._broadcastRoom(room);
  }

  close() {
    this.closed = true;
    for (const session of this.sessions.values()) {
      try { session.socket?._forceClose(); } catch { /* ignore */ }
    }
  }
}

/** The subset of the WebSocket client API that NetClient uses. */
export class FakeWebSocket {
  constructor(hub, session) {
    this._hub = hub;
    this._session = session;
    this._listeners = new Map();
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.binaryType = 'arraybuffer';
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this._dispatch('open', {});
      this._hub.send(this._session, {
        type: 'welcome',
        protocol: PROTOCOL_VERSION,
        schema: MESSAGE_SCHEMA,
        connectionId: this._session.id,
        heartbeatMs: 1000,
        resumeWindowMs: 30000
      });
    }, 0);
  }

  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this._listeners.get(type)?.delete(listener);
  }

  _dispatch(type, event) {
    for (const listener of [...(this._listeners.get(type) ?? [])]) {
      try { listener(event); } catch { /* a listener error is the caller's problem */ }
    }
  }

  _deliver(text) {
    if (this.readyState !== 1) return;
    this._dispatch('message', { data: text });
  }

  send(text) {
    if (this.readyState !== 1) throw Object.assign(new Error('websocket is not open'), { name: 'InvalidStateError' });
    this._hub.receive(this._session, text);
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    setTimeout(() => this._forceClose(code, reason), 0);
  }

  _forceClose(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this._hub.closeSession(this._session, reason);
    this._dispatch('close', { code, reason });
  }
}

// ---------------------------------------------------------------- peer network

/**
 * Two peer connections and their channels. `latencyMs` applies to every
 * delivery, `lossRate` only to the unreliable channel, `reorderRate` adds a
 * random extra delay to snapshots (never to the event channel).
 */
export class FakePeerNetwork {
  constructor({ latencyMs = 0, lossRate = 0, reorderRate = 0, duplicateRate = 0, reorderDelayMs = 20, seed = 7 } = {}) {
    this.latencyMs = latencyMs;
    this.lossRate = lossRate;
    this.reorderRate = reorderRate;
    this.duplicateRate = duplicateRate;
    this.reorderDelayMs = reorderDelayMs;
    this.seed = seed >>> 0;
    this.sessions = new Map();
    this.pcs = new Set();
    this.sessionCounter = 0;
    this.blocked = new Set();
    this.stats = {
      snapshotSent: 0,
      snapshotDelivered: 0,
      snapshotDropped: 0,
      snapshotReordered: 0,
      snapshotDuplicated: 0,
      eventSent: 0,
      eventDelivered: 0,
      eventDropped: 0,
      bytesSent: 0,
      bytesDelivered: 0,
      pairs: 0,
      failures: 0,
      restarts: 0
    };
    this.timers = new Set();
  }

  random() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 0x100000000;
  }

  later(callback, delay) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      try { callback(); } catch { /* delivery must not throw into the test */ }
    }, Math.max(0, delay));
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  newSession() {
    this.sessionCounter++;
    return 'sess_' + this.sessionCounter;
  }

  registerOfferer(pc, sessionId, generation) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { id: sessionId, offerer: pc, answerer: null, generation, connected: false };
      this.sessions.set(sessionId, session);
    } else {
      session.offerer = pc;
      session.generation = generation;
    }
    return session;
  }

  registerAnswerer(pc, sessionId, generation) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { id: sessionId, offerer: null, answerer: pc, generation, connected: false };
      this.sessions.set(sessionId, session);
    } else {
      session.answerer = pc;
      session.generation = generation;
    }
    return session;
  }

  maybePair(session) {
    if (!session.offerer || !session.answerer) return false;
    if (this.blocked.has(session.id)) {
      this.later(() => this.failSession(session.id, { hard: true }), 0);
      return false;
    }
    if (session.connected) return true;
    session.connected = true;
    this.stats.pairs++;
    for (const pc of [session.offerer, session.answerer]) {
      pc.connectionState = 'connected';
      pc.iceConnectionState = 'completed';
      pc.remoteDescriptionSet = true;
      this.later(() => {
        pc._openChannels();
        pc._fireState();
      }, 0);
    }
    return true;
  }

  failSession(sessionId, { hard = false } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (hard) this.blocked.add(sessionId);
    this.stats.failures++;
    session.connected = false;
    for (const pc of [session.offerer, session.answerer]) {
      if (!pc || pc.connectionState === 'closed') continue;
      pc.connectionState = 'failed';
      pc.iceConnectionState = 'failed';
      pc._closeChannels(false);
      pc._fireState();
    }
    return true;
  }

  restartSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (this.blocked.has(sessionId)) return false;
    this.stats.restarts++;
    session.connected = false;
    this.maybePair(session);
    return true;
  }

  closePc(pc) {
    for (const session of this.sessions.values()) {
      if (session.offerer === pc || session.answerer === pc) {
        session.connected = false;
        const other = session.offerer === pc ? session.answerer : session.offerer;
        if (other && other.connectionState !== 'closed') {
          other.connectionState = 'closed';
          other.iceConnectionState = 'closed';
          other._closeChannels(false);
          other._fireState();
        }
      }
    }
    this.pcs.delete(pc);
  }

  deliver(channel, text) {
    const peerChannel = channel._remote;
    if (!peerChannel || peerChannel.readyState !== 'open') return;
    this.stats.bytesDelivered += text.length;
    if (peerChannel._kind === 'snapshot') this.stats.snapshotDelivered++;
    else this.stats.eventDelivered++;
    try { peerChannel.onmessage?.({ data: text }); } catch { /* ignore */ }
  }

  transmit(channel, text) {
    const kind = channel._kind;
    this.stats.bytesSent += text.length;
    if (kind === 'snapshot') {
      this.stats.snapshotSent++;
      if (this.random() < this.lossRate) {
        this.stats.snapshotDropped++;
        channel._dropped++;
        return;
      }
      let delay = this.latencyMs;
      if (this.random() < this.reorderRate) {
        this.stats.snapshotReordered++;
        delay += this.reorderDelayMs * (1 + Math.floor(this.random() * 3));
      }
      this.later(() => this.deliver(channel, text), delay);
      if (this.random() < this.duplicateRate) {
        this.stats.snapshotDuplicated++;
        this.later(() => this.deliver(channel, text), delay + this.reorderDelayMs);
      }
      return;
    }
    this.stats.eventSent++;
    this.later(() => this.deliver(channel, text), this.latencyMs);
  }

  setImpairment({ latencyMs, lossRate, reorderRate, duplicateRate } = {}) {
    if (latencyMs !== undefined) this.latencyMs = latencyMs;
    if (lossRate !== undefined) this.lossRate = lossRate;
    if (reorderRate !== undefined) this.reorderRate = reorderRate;
    if (duplicateRate !== undefined) this.duplicateRate = duplicateRate;
  }

  clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

export class FakeDataChannel {
  constructor(pc, label, options) {
    this._pc = pc;
    this.label = label;
    this.id = options?.id ?? null;
    this.ordered = options?.ordered !== false;
    this.maxRetransmits = options?.maxRetransmits ?? null;
    this.negotiated = options?.negotiated === true;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this._kind = options?.id === 1 ? 'snapshot' : 'event';
    this._remote = null;
    this._dropped = 0;
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    this.sentMessages = 0;
  }

  send(text) {
    if (this.readyState !== 'open') throw Object.assign(new Error('data channel is not open'), { name: 'InvalidStateError' });
    this.sentMessages++;
    this._pc._network.transmit(this, String(text));
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    try { this.onclose?.({}); } catch { /* ignore */ }
  }
}

export class FakeRTCPeerConnection {
  constructor(network, config = {}) {
    this._network = network;
    this.config = config;
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.remoteDescriptionSet = false;
    this.channels = [];
    this._sessionId = null;
    this._generation = 1;
    this._restartRequested = false;
    this.onicecandidate = null;
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
    this.ondatachannel = null;
    this.stats = { candidatesSent: 0, candidatesReceived: 0 };
    network.pcs.add(this);
  }

  createDataChannel(label, options = {}) {
    const channel = new FakeDataChannel(this, label, options);
    this.channels.push(channel);
    return channel;
  }

  async createOffer(options = {}) {
    const iceRestart = options?.iceRestart === true;
    if (iceRestart) {
      this._generation++;
      this._restartRequested = true;
    }
    if (!this._sessionId) this._sessionId = this._network.newSession();
    return { type: 'offer', sdp: encodeSdp(this._sessionId, this._generation) };
  }

  async createAnswer() {
    if (!this._sessionId) throw new Error('answer without remote offer');
    return { type: 'answer', sdp: encodeSdp(this._sessionId, this._generation) };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
    const decoded = decodeSdp(description?.sdp);
    if (!decoded) throw new Error('fake SDP is malformed');
    this._sessionId = decoded.sessionId;
    this._generation = decoded.generation;
    if (description.type === 'offer') {
      const session = this._network.registerOfferer(this, this._sessionId, this._generation);
      if (this._network.blocked.has(this._sessionId)) {
        this._network.later(() => {
          this.connectionState = 'failed';
          this.iceConnectionState = 'failed';
          this._fireState();
        }, 0);
        return;
      }
      if (session.answerer) this._network.maybePair(session);
      return;
    }
    const session = this._network.sessions.get(this._sessionId);
    if (session) this._network.maybePair(session);
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.remoteDescriptionSet = true;
    const decoded = decodeSdp(description?.sdp);
    if (!decoded) throw new Error('fake SDP is malformed');
    this._sessionId = decoded.sessionId;
    this._generation = decoded.generation;
    if (description.type === 'offer') {
      this._network.registerAnswerer(this, this._sessionId, this._generation);
    } else {
      const session = this._network.registerOfferer(this, this._sessionId, this._generation);
      if (this._network.blocked.has(this._sessionId)) {
        this._network.later(() => {
          this.connectionState = 'failed';
          this.iceConnectionState = 'failed';
          this._fireState();
        }, 0);
        return;
      }
      if (session.answerer) this._network.maybePair(session);
    }
  }

  async addIceCandidate(candidate) {
    if (!candidate) return;
    this.stats.candidatesReceived++;
    if (!this.remoteDescriptionSet) throw new Error('ICE candidate before remote description');
  }

  restartIce() {
    this._restartRequested = true;
  }

  _openChannels() {
    const session = this._network.sessions.get(this._sessionId);
    if (!session) return;
    const other = session.offerer === this ? session.answerer : session.offerer;
    if (!other) return;
    for (const channel of this.channels) {
      const peerChannel = other.channels.find((entry) => entry.id === channel.id);
      if (!peerChannel) continue;
      channel._remote = peerChannel;
      peerChannel._remote = channel;
      if (channel.readyState !== 'open') {
        channel.readyState = 'open';
        try { channel.onopen?.({}); } catch { /* ignore */ }
      }
      if (peerChannel.readyState !== 'open') {
        peerChannel.readyState = 'open';
        try { peerChannel.onopen?.({}); } catch { /* ignore */ }
      }
    }
    this.connectionState = 'connected';
    this.iceConnectionState = 'completed';
    this._fireState();
  }

  _closeChannels(notify = true) {
    for (const channel of this.channels) {
      if (channel.readyState === 'open' && notify) {
        channel.readyState = 'closed';
        try { channel.onclose?.({}); } catch { /* ignore */ }
      } else {
        channel.readyState = 'closed';
      }
    }
  }

  _fireState() {
    try { this.oniceconnectionstatechange?.({}); } catch { /* ignore */ }
    try { this.onconnectionstatechange?.({}); } catch { /* ignore */ }
  }

  close() {
    if (this.connectionState === 'closed') return;
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
    this._closeChannels(true);
    this._network.closePc(this);
    this._fireState();
  }

  async getStats() {
    const map = new Map();
    map.set('transport', { id: 'transport', type: 'transport', dtlsState: 'connected', selectedCandidatePairId: 'pair' });
    map.set('pair', {
      id: 'pair', type: 'candidate-pair', state: 'succeeded',
      localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: 0
    });
    map.set('local', { id: 'local', type: 'local-candidate', candidateType: 'host' });
    map.set('remote', { id: 'remote', type: 'remote-candidate', candidateType: 'host' });
    return map;
  }
}

/** Factory pair ready to hand to WebRtcNetClient. */
export function makeFakeFactories(network, hub) {
  return {
    RTCPeerConnection: function FakeRtcFactory(config) {
      return new FakeRTCPeerConnection(network, config);
    },
    WebSocket: function FakeWsFactory(url) {
      if (!hub) throw new Error('no hub');
      const socket = hub.connect(url);
      return socket;
    }
  };
}

export { roomCode as fakeRoomCode, nextId as fakePlayerId };
