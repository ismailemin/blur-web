// Dependency-free room service for the net-mvp gate.
//
//   * HTTP static server for probes/net-mvp/web plus four shared modules;
//   * minimal RFC 6455 WebSocket server on /ws (text frames only);
//   * room create/join with a 5-character code, host assignment, roster,
//     ready/start, car/map selection, heartbeat, disconnect/resume token;
//   * relay of sequence-numbered input/state/ack/resync/final messages.
//
// No npm packages, no database, no game assets, no accounts. Rooms live in
// memory by default; `--state-file` optionally persists a bounded room snapshot
// across a graceful restart so a resume token is not stranded.
//
// The implementation is intentionally bounded: 64 KiB message cap, 8 players
// per room by default (2..20), 64 rooms, 4,000 messages/s per socket, a 4.5 s
// heartbeat ceiling, a 30 s resume window, a 5 min idle-room reap and a 2 h
// room TTL. Every limit rejects with a typed error.

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROTOCOL_VERSION,
  MESSAGE_SCHEMA,
  MAX_MESSAGE_BYTES,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  MIN_ROOM_CAPACITY,
  DEFAULT_MAX_PLAYERS,
  HARD_MAX_PLAYERS,
  MIN_PLAYERS_TO_START,
  RESUME_WINDOW_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  ROOM_TTL_MS,
  IDLE_ROOM_MS,
  EMPTY_ROOM_MS,
  DEFAULT_MAX_ROOMS,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_CONNECTIONS_PER_IP,
  JOIN_RATE_CAPACITY,
  JOIN_RATE_REFILL_PER_SECOND,
  CREATE_RATE_CAPACITY,
  CREATE_RATE_REFILL_PER_SECOND,
  RATE_LIMIT_PER_SECOND,
  TICK_HZ,
  ERROR_CODES,
  NetError,
  isObject,
  isInteger,
  validName,
  validSelector,
  validRoomCode,
  normalizeRoomCode,
  validCapacity,
  validChannel,
  validState,
  validInput,
  validSeq,
  validTick
} from './protocol.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROBE = path.join(ROOT, 'probes/net-mvp');
const WEB = path.join(PROBE, 'web');
const SHARED_MODULES = new Set(['client.mjs', 'protocol.mjs', 'hash.mjs', 'race.mjs']);

const ROOM_STATE_SCHEMA = 'blur.net-mvp.rooms/1';
const HEALTH_SCHEMA = 'blur.net-mvp.health/1';
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_RATE_BUCKETS = 4096;

/** Token bucket. `refillPerSecond` may be 0 to make the bucket a hard burst. */
function makeBucket(capacity, refillPerSecond, now = Date.now()) {
  return { capacity, refillPerSecond, tokens: capacity, updatedAt: now };
}

function takeToken(bucket, now) {
  if (bucket.refillPerSecond > 0) {
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerSecond);
  }
  bucket.updatedAt = now;
  if (bucket.tokens < 1) {
    const retryAfterMs = bucket.refillPerSecond > 0
      ? Math.ceil(((1 - bucket.tokens) / bucket.refillPerSecond) * 1000)
      : 60_000;
    return { ok: false, retryAfterMs };
  }
  bucket.tokens -= 1;
  return { ok: true, remaining: Math.floor(bucket.tokens) };
}

function sha256Prefix(text, length = 12) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, length);
}

function writeJsonAtomic(file, value) {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = file + '.tmp-' + process.pid;
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
  try { chmodSync(file, 0o600); } catch { /* Windows has no POSIX mode */ }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function hex(bytes = 12) {
  return randomBytes(bytes).toString('hex');
}

function roomCode() {
  let code = '';
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  for (let index = 0; index < ROOM_CODE_LENGTH; index++) {
    code += ROOM_CODE_ALPHABET[bytes[index] % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

function safeJoin(base, relative) {
  const resolved = path.resolve(base, '.' + path.posix.normalize('/' + relative));
  return resolved === base || resolved.startsWith(base + path.sep) ? resolved : null;
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(length / 0x100000000), 2);
    header.writeUInt32BE(length >>> 0, 6);
  }
  header[0] = 0x80 | opcode; // FIN, server frames are not masked
  return Buffer.concat([header, payload]);
}

class WebSocketConnection {
  constructor(socket, { id, onMessage, onClose, onError, maxMessageBytes = MAX_MESSAGE_BYTES }) {
    this.id = id;
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.onError = onError;
    this.maxMessageBytes = maxMessageBytes;
    this.closed = false;
    this.closeSent = false;
    this.buffer = Buffer.alloc(0);
    this.fragment = null; // { opcode, parts, length }
    this.maxBuffered = 2 * 1024 * 1024;
    this.bytesIn = 0;
    this.bytesOut = 0;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.feed(chunk));
    socket.on('close', () => this.finish('socket-close'));
    socket.on('end', () => this.finish('socket-end'));
    socket.on('error', (error) => {
      this.onError?.(this, error);
      this.finish('socket-error');
    });
  }

  sendText(text) {
    if (this.closed) throw new NetError(ERROR_CODES.NET_CLOSED, 'websocket is closed');
    const payload = Buffer.from(text, 'utf8');
    if (payload.length > this.maxMessageBytes) {
      throw new NetError(ERROR_CODES.NET_MESSAGE_TOO_LARGE, 'outbound message exceeds cap', {
        bytes: payload.length, cap: this.maxMessageBytes
      });
    }
    if (this.socket.destroyed || !this.socket.writable) {
      throw new NetError(ERROR_CODES.NET_NOT_CONNECTED, 'websocket is not writable');
    }
    if (this.socket.writableLength > this.maxBuffered) {
      this.close(1011, 'outbound queue cap');
      throw new NetError(ERROR_CODES.NET_NOT_CONNECTED, 'outbound queue cap exceeded');
    }
    const frame = encodeFrame(0x1, payload);
    this.bytesOut += frame.length;
    this.socket.write(frame);
  }

  sendControl(opcode, payload = Buffer.alloc(0)) {
    if (this.closed || this.socket.destroyed) return;
    const frame = encodeFrame(opcode, payload);
    this.bytesOut += frame.length;
    this.socket.write(frame);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    if (!this.closeSent) {
      let payload = Buffer.alloc(0);
      if (Number.isInteger(code)) {
        const reasonBytes = Buffer.from(String(reason || '').slice(0, 120), 'utf8');
        payload = Buffer.alloc(2 + reasonBytes.length);
        payload.writeUInt16BE(code, 0);
        reasonBytes.copy(payload, 2);
      }
      this.sendControl(0x8, payload);
      this.closeSent = true;
    }
    this.socket.end();
  }

  finish(reason) {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(this, reason);
  }

  fail(code, reason) {
    this.close(code, reason);
    this.finish('protocol-error:' + code);
  }

  /**
   * Send a typed error frame, then close. Used for frame-level rejections that
   * cannot reach the room handler (oversize, binary, fragmentation abuse).
   */
  failWithError(netCode, message, detail = null, closeCode = 1008, reason = 'protocol error') {
    if (!this.closed && !this.closeSent) {
      try {
        this.sendText(JSON.stringify({
          type: 'error', code: netCode, message, detail, requestId: null, fatal: true
        }));
      } catch { /* the socket may already be gone */ }
    }
    this.close(closeCode, reason);
    this.finish('protocol-error:' + netCode);
  }

  feed(chunk) {
    if (this.closed) return;
    this.bytesIn += chunk.length;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (!this.closed) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (rsv !== 0) return this.failWithError(ERROR_CODES.NET_PROTOCOL, 'RSV bits are not negotiated', null, 1002);
      if (!masked) return this.failWithError(ERROR_CODES.NET_PROTOCOL, 'client frames must be masked', null, 1002);
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        if (high !== 0 || low > this.maxMessageBytes) {
          return this.failWithError(ERROR_CODES.NET_MESSAGE_TOO_LARGE, 'message too large', {
            bytes: high * 0x100000000 + low, cap: this.maxMessageBytes
          }, 1009);
        }
        length = low;
        offset = 10;
      }
      if (length > this.maxMessageBytes) {
        return this.failWithError(ERROR_CODES.NET_MESSAGE_TOO_LARGE, 'message too large', {
          bytes: length, cap: this.maxMessageBytes
        }, 1009);
      }
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index++) {
        payload[index] = this.buffer[offset + index] ^ mask[index & 3];
      }
      this.buffer = this.buffer.subarray(offset + length);

      const control = opcode >= 0x8;
      if (control) {
        if (!fin || length > 125) return this.failWithError(ERROR_CODES.NET_PROTOCOL, 'invalid control frame', null, 1002);
        if (opcode === 0x8) {
          this.sendControl(0x8, payload.subarray(0, Math.min(2, payload.length)));
          this.closeSent = true;
          this.socket.end();
          this.finish('peer-close');
          return;
        }
        if (opcode === 0x9) { this.sendControl(0xa, payload); continue; }
        if (opcode === 0xa) continue;
        return this.failWithError(ERROR_CODES.NET_PROTOCOL, 'unknown control opcode', null, 1002);
      }

      if (opcode === 0x2) return this.failWithError(ERROR_CODES.NET_BINARY_UNSUPPORTED, 'binary frames are not supported', null, 1003);
      if (opcode === 0x1) {
        if (this.fragment) return this.failWithError(ERROR_CODES.NET_PROTOCOL, 'new data frame during fragmentation', null, 1002);
        if (fin) {
          this.deliver(payload);
        } else {
          this.fragment = { parts: [payload], length: payload.length };
        }
        continue;
      }
      if (opcode === 0x0) {
        if (!this.fragment) return this.failWithError(ERROR_CODES.NET_PROTOCOL, 'continuation without a fragment', null, 1002);
        this.fragment.parts.push(payload);
        this.fragment.length += payload.length;
        if (this.fragment.length > this.maxMessageBytes) {
          return this.failWithError(ERROR_CODES.NET_MESSAGE_TOO_LARGE, 'message too large', {
            bytes: this.fragment.length, cap: this.maxMessageBytes
          }, 1009);
        }
        if (fin) {
          const message = Buffer.concat(this.fragment.parts);
          this.fragment = null;
          this.deliver(message);
        }
        continue;
      }
      return this.failWithError(ERROR_CODES.NET_PROTOCOL, 'unknown data opcode', null, 1002);
    }
  }

  deliver(payload) {
    let text;
    try {
      text = payload.toString('utf8');
    } catch (error) {
      return this.fail(1007, 'invalid UTF-8');
    }
    try {
      this.onMessage?.(this, text);
    } catch (error) {
      this.onError?.(this, error);
      this.close(1011, 'handler failure');
      this.finish('handler-failure');
    }
  }
}

/** Serve only the probe web tree, the health endpoint and the shared modules. */
function createStaticHandler({ health = null } = {}) {
  return (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === '/healthz' || pathname === '/readyz') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' });
          response.end(JSON.stringify({ type: 'error', code: ERROR_CODES.NET_PROTOCOL, message: 'health is GET only' }));
          return;
        }
        const view = health ? health(request) : { schema: HEALTH_SCHEMA, status: 'ok' };
        response.writeHead(view.status === 'ok' ? 200 : 503, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        });
        if (request.method === 'HEAD') { response.end(); return; }
        response.end(JSON.stringify(view) + '\n');
        return;
      }
      if (pathname === '/ws') {
        response.writeHead(426, { 'content-type': 'text/plain' });
        response.end('websocket upgrade required');
        return;
      }
      let file = null;
      if (pathname === '/' || pathname === '/index.html') file = path.join(WEB, 'index.html');
      else {
        const moduleName = pathname.replace(/^\//, '');
        if (SHARED_MODULES.has(moduleName)) file = path.join(PROBE, moduleName);
        else file = safeJoin(WEB, pathname.slice(1));
      }
      if (!file || !existsSync(file) || !statSync(file).isFile()) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found: ' + pathname);
        return;
      }
      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      response.writeHead(200, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      if (request.method === 'HEAD') { response.end(); return; }
      createReadStream(file).pipe(response);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('server error');
    }
  };
}

/**
 * Start the room service. `port: 0` picks a free port.
 * Returns { server, port, origin, wsUrl, tls, close(), stats(), snapshot(),
 *           bandwidth(), resetBandwidth(), health(), statePath }.
 */
export async function startRoomServer({
  port = 0,
  host = '127.0.0.1',
  defaultMaxPlayers = DEFAULT_MAX_PLAYERS,
  hardMaxPlayers = HARD_MAX_PLAYERS,
  maxRooms = DEFAULT_MAX_ROOMS,
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  maxConnectionsPerIp = DEFAULT_MAX_CONNECTIONS_PER_IP,
  resumeWindowMs = RESUME_WINDOW_MS,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
  roomTtlMs = ROOM_TTL_MS,
  idleRoomMs = IDLE_ROOM_MS,
  emptyRoomMs = EMPTY_ROOM_MS,
  maxMessageBytes = MAX_MESSAGE_BYTES,
  rateLimitPerSecond = RATE_LIMIT_PER_SECOND,
  joinRateLimit = null,
  createRateLimit = null,
  sweepIntervalMs = null,
  trustProxy = false,
  tls = null,
  stateFile = null,
  saveStateIntervalMs = 30_000,
  log = () => {}
} = {}) {
  if (!validCapacity(defaultMaxPlayers) || !validCapacity(hardMaxPlayers) || defaultMaxPlayers > hardMaxPlayers) {
    throw new NetError(ERROR_CODES.NET_CONFIG,
      'defaultMaxPlayers/hardMaxPlayers must satisfy ' + MIN_ROOM_CAPACITY + ' <= default <= hard <= ' + HARD_MAX_PLAYERS,
      { defaultMaxPlayers, hardMaxPlayers });
  }
  if (!isInteger(maxRooms) || maxRooms < 1 || maxRooms > 4096) {
    throw new NetError(ERROR_CODES.NET_CONFIG, 'maxRooms must be 1..4096', { maxRooms });
  }
  if (!isInteger(maxConnections) || maxConnections < 1 || maxConnections > 100_000) {
    throw new NetError(ERROR_CODES.NET_CONFIG, 'maxConnections must be 1..100000', { maxConnections });
  }
  if (!isInteger(maxConnectionsPerIp) || maxConnectionsPerIp < 1 || maxConnectionsPerIp > 4096) {
    throw new NetError(ERROR_CODES.NET_CONFIG, 'maxConnectionsPerIp must be 1..4096', { maxConnectionsPerIp });
  }
  if (!isInteger(maxMessageBytes) || maxMessageBytes < 1024 || maxMessageBytes > MAX_MESSAGE_BYTES) {
    throw new NetError(ERROR_CODES.NET_CONFIG,
      'maxMessageBytes must be 1024..' + MAX_MESSAGE_BYTES, { maxMessageBytes });
  }
  if (!isInteger(rateLimitPerSecond) || rateLimitPerSecond < 10 || rateLimitPerSecond > 1_000_000) {
    throw new NetError(ERROR_CODES.NET_CONFIG, 'rateLimitPerSecond must be 10..1000000', { rateLimitPerSecond });
  }
  for (const [name, value] of Object.entries({
    resumeWindowMs, heartbeatIntervalMs, heartbeatTimeoutMs, roomTtlMs, idleRoomMs, emptyRoomMs
  })) {
    if (!Number.isFinite(value) || value < 25) {
      throw new NetError(ERROR_CODES.NET_CONFIG, name + ' must be a positive millisecond value', { [name]: value });
    }
  }

  const joinBucketOptions = {
    capacity: joinRateLimit?.capacity ?? JOIN_RATE_CAPACITY,
    refillPerSecond: joinRateLimit?.refillPerSecond ?? JOIN_RATE_REFILL_PER_SECOND
  };
  const createBucketOptions = {
    capacity: createRateLimit?.capacity ?? CREATE_RATE_CAPACITY,
    refillPerSecond: createRateLimit?.refillPerSecond ?? CREATE_RATE_REFILL_PER_SECOND
  };
  for (const bucket of [joinBucketOptions, createBucketOptions]) {
    if (!(bucket.capacity >= 1) || !(bucket.refillPerSecond >= 0)) {
      throw new NetError(ERROR_CODES.NET_CONFIG, 'rate bucket capacity/refill must be non-negative', bucket);
    }
  }

  const rooms = new Map();
  const sessions = new Map();
  const timers = new Set();
  const ipBuckets = new Map();
  const ipConnectionCounts = new Map();
  const startedAt = Date.now();
  let shuttingDown = false;
  let closePromise = null;
  let stateLoaded = false;
  let stateSkipped = 0;

  const stats = {
    connections: 0,
    messagesIn: 0,
    messagesOut: 0,
    messagesRelayed: 0,
    protocolErrors: 0,
    roomsCreated: 0,
    roomsRestored: 0,
    roomsFinished: 0,
    resumes: 0,
    disconnects: 0,
    expiredPlayers: 0,
    maxPlayersSeen: 0,
    rateLimited: 0,
    joinRateLimited: 0,
    createRateLimited: 0,
    idleRoomsReaped: 0,
    expiredRoomsReaped: 0,
    oversizeRejected: 0,
    binaryRejected: 0,
    upgradesRejected: 0,
    heartbeatTimeouts: 0,
    shutdowns: 0,
    stateSkipped: 0,
    bytesIn: 0,
    bytesOut: 0,
    byType: {},
    proxyHeaders: {}
  };

  const later = (callback, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, Math.max(0, delay));
    timer.unref?.();
    timers.add(timer);
    return timer;
  };
  const clearLater = (timer) => {
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(timer);
  };

  function touchRoom(room) {
    if (room) room.lastActivityAt = Date.now();
  }

  function typeBucket(type, bytes) {
    const entry = stats.byType[type] ?? { count: 0, bytes: 0 };
    entry.count++;
    entry.bytes += bytes;
    stats.byType[type] = entry;
  }

  function send(session, message) {
    try {
      const text = JSON.stringify(message);
      const bytes = Buffer.byteLength(text, 'utf8');
      session.connection.sendText(text);
      stats.messagesOut++;
      stats.bytesOut += bytes;
      typeBucket(message.type, bytes);
      return true;
    } catch (error) {
      if (error?.code === ERROR_CODES.NET_MESSAGE_TOO_LARGE) stats.oversizeRejected++;
      log({ event: 'send-failed', playerId: session.playerId, error: String(error?.message || error) });
      return false;
    }
  }

  // --------------------------------------------------------------- client IP
  function resolveClientIp(request) {
    const remote = request.socket?.remoteAddress ?? null;
    if (!trustProxy) return { ip: remote, source: 'socket' };
    const header = (name) => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const candidates = [
      ['cf-connecting-ip', header('cf-connecting-ip')],
      ['x-forwarded-for', header('x-forwarded-for')],
      ['x-real-ip', header('x-real-ip')]
    ];
    for (const [source, value] of candidates) {
      if (typeof value !== 'string') continue;
      const first = source === 'x-forwarded-for' ? value.split(',')[0].trim() : value.trim();
      if (isIP(first)) return { ip: first, source };
    }
    return { ip: remote, source: 'socket' };
  }

  function clientIpHash(ip) {
    return ip ? sha256Prefix(ip, 12) : null;
  }

  // ---------------------------------------------------------- per-IP buckets
  function bucketFor(ip) {
    const key = ip || 'unknown';
    let entry = ipBuckets.get(key);
    if (!entry) {
      if (ipBuckets.size >= MAX_RATE_BUCKETS) {
        // Bounded memory: drop the least recently used half instead of growing.
        const keys = [...ipBuckets.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
        for (let index = 0; index < Math.ceil(keys.length / 2); index++) ipBuckets.delete(keys[index][0]);
      }
      entry = {
        join: makeBucket(joinBucketOptions.capacity, joinBucketOptions.refillPerSecond),
        create: makeBucket(createBucketOptions.capacity, createBucketOptions.refillPerSecond),
        lastSeen: Date.now()
      };
      ipBuckets.set(key, entry);
    }
    entry.lastSeen = Date.now();
    return entry;
  }

  function consumeRate(session, scope) {
    const bucket = bucketFor(session.ip)[scope];
    const result = takeToken(bucket, Date.now());
    if (result.ok) return;
    stats.rateLimited++;
    const code = scope === 'join' ? ERROR_CODES.NET_JOIN_RATE_LIMIT : ERROR_CODES.NET_CREATE_RATE_LIMIT;
    if (scope === 'join') stats.joinRateLimited++;
    else stats.createRateLimited++;
    throw new NetError(code, scope + ' rate limit exceeded', {
      scope, retryAfterMs: result.retryAfterMs, ipHash: clientIpHash(session.ip)
    });
  }

  // ----------------------------------------------------------- health/state
  function healthView(request = null) {
    const resolved = request ? resolveClientIp(request) : { ip: null, source: 'none' };
    const connectedPlayers = [...rooms.values()].reduce(
      (sum, room) => sum + [...room.players.values()].filter((player) => player.connected).length, 0);
    return {
      schema: HEALTH_SCHEMA,
      status: shuttingDown ? 'shutting-down' : 'ok',
      serverTime: Date.now(),
      uptimeMs: Date.now() - startedAt,
      protocol: PROTOCOL_VERSION,
      protocolSchema: MESSAGE_SCHEMA,
      tls: Boolean(tls),
      rooms: rooms.size,
      sessions: sessions.size,
      connections: clients.size,
      connectedPlayers,
      limits: {
        defaultMaxPlayers,
        hardMaxPlayers,
        maxRooms,
        maxConnections,
        maxConnectionsPerIp,
        maxMessageBytes,
        rateLimitPerSecond,
        resumeWindowMs,
        heartbeatIntervalMs,
        heartbeatTimeoutMs,
        roomTtlMs,
        idleRoomMs,
        statePersistence: Boolean(stateFile)
      },
      proxy: {
        trusted: trustProxy,
        source: resolved.source,
        clientIpHash: clientIpHash(resolved.ip)
      },
      counters: {
        roomsCreated: stats.roomsCreated,
        roomsRestored: stats.roomsRestored,
        roomsFinished: stats.roomsFinished,
        resumes: stats.resumes,
        disconnects: stats.disconnects,
        protocolErrors: stats.protocolErrors,
        rateLimited: stats.rateLimited,
        idleRoomsReaped: stats.idleRoomsReaped
      }
    };
  }

  function serializeRooms() {
    const now = Date.now();
    return {
      schema: ROOM_STATE_SCHEMA,
      savedAt: now,
      rooms: [...rooms.values()].map((room) => ({
        code: room.code,
        createdAt: room.createdAt,
        lastActivityAt: room.lastActivityAt,
        phase: room.phase,
        hostId: room.hostId,
        map: room.map,
        powerups: room.powerups === true,
        maxPlayers: room.maxPlayers,
        seed: room.seed,
        startTick: room.startTick,
        players: [...room.players.values()].map((player) => ({
          id: player.id,
          slot: player.slot,
          name: player.name,
          car: player.car,
          ready: player.ready,
          resumeToken: player.resumeToken,
          joinedAt: player.joinedAt,
          resumedCount: player.resumedCount
        }))
      }))
    };
  }

  function saveStateFile() {
    if (!stateFile) return false;
    try {
      writeJsonAtomic(stateFile, serializeRooms());
      log({ event: 'state-saved', path: stateFile, rooms: rooms.size });
      return true;
    } catch (error) {
      log({ event: 'state-save-failed', path: stateFile, error: String(error?.message || error) });
      return false;
    }
  }

  function restoreStateFile() {
    if (!stateFile || !existsSync(stateFile) || stateLoaded) return;
    stateLoaded = true;
    let data;
    try {
      const size = statSync(stateFile).size;
      if (size > MAX_STATE_BYTES) {
        throw new NetError(ERROR_CODES.NET_CONFIG, 'state file exceeds cap', { bytes: size, cap: MAX_STATE_BYTES });
      }
      data = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch (error) {
      stateSkipped++;
      log({ event: 'state-load-failed', path: stateFile, error: String(error?.message || error) });
      return;
    }
    if (!isObject(data) || data.schema !== ROOM_STATE_SCHEMA || !Array.isArray(data.rooms)) {
      stateSkipped++;
      log({ event: 'state-load-schema-mismatch', path: stateFile, schema: data?.schema ?? null });
      return;
    }
    const now = Date.now();
    let restored = 0;
    for (const record of data.rooms) {
      // Restore only what validates. A bad record is skipped and logged with
      // its reason; nothing is guessed or defaulted into a live room.
      if (!isObject(record) || !validRoomCode(record.code) || rooms.has(record.code)) { stateSkipped++; continue; }
      if (!validCapacity(record.maxPlayers) || record.maxPlayers > hardMaxPlayers) { stateSkipped++; continue; }
      if (!['lobby', 'running', 'finished'].includes(record.phase)) { stateSkipped++; continue; }
      if (!Array.isArray(record.players) || record.players.length === 0 || record.players.length > record.maxPlayers) {
        stateSkipped++;
        continue;
      }
      if (now - Number(record.createdAt) > roomTtlMs) { stateSkipped++; continue; }
      const players = new Map();
      let hostId = null;
      let valid = true;
      for (const entry of record.players) {
        if (!isObject(entry) || typeof entry.id !== 'string' || !/^pl_[0-9a-f]{16}$/.test(entry.id) ||
            !isInteger(entry.slot) || entry.slot < 1 || entry.slot > record.maxPlayers ||
            !validName(entry.name) || !validSelector(entry.car) ||
            typeof entry.resumeToken !== 'string' || !/^[0-9a-f]{48}$/.test(entry.resumeToken)) {
          valid = false;
          break;
        }
        players.set(entry.id, {
          id: entry.id,
          slot: entry.slot,
          name: entry.name.trim(),
          car: entry.car,
          ready: entry.ready === true,
          connected: false,
          session: null,
          resumeToken: entry.resumeToken,
          joinedAt: Number(entry.joinedAt) || now,
          lastSeen: now,
          disconnectedAt: now,
          resumeDeadline: now + resumeWindowMs,
          resumeTimer: null,
          resumedCount: Number.isInteger(entry.resumedCount) ? entry.resumedCount : 0
        });
        if (entry.id === record.hostId) hostId = entry.id;
      }
      if (!valid || players.size !== record.players.length || !hostId) { stateSkipped++; continue; }
      const room = {
        code: record.code,
        createdAt: Number(record.createdAt) || now,
        lastActivityAt: now,
        phase: record.phase,
        hostId,
        map: validSelector(record.map) ? record.map : 'usa_la_river',
        maxPlayers: record.maxPlayers,
        seed: typeof record.seed === 'string' ? record.seed : null,
        startTick: isInteger(record.startTick) ? record.startTick : null,
        players,
        finished: new Map()
      };
      rooms.set(room.code, room);
      for (const player of room.players.values()) {
        player.resumeTimer = later(() => expirePlayer(room.code, player.id), resumeWindowMs);
      }
      restored++;
    }
    stats.roomsRestored = restored;
    log({ event: 'state-restored', path: stateFile, rooms: restored, skipped: stateSkipped });
  }

  function bandwidthView() {
    return [...sessions.values()].map((session) => ({
      connectionId: session.id,
      playerId: session.playerId,
      roomCode: session.roomCode,
      connected: session.connection.closed === false,
      bytesIn: session.connection.bytesIn,
      bytesOut: session.connection.bytesOut
    }));
  }

  function resetBandwidth() {
    stats.bytesIn = 0;
    stats.bytesOut = 0;
    stats.byType = {};
    for (const session of sessions.values()) {
      session.connection.bytesIn = 0;
      session.connection.bytesOut = 0;
    }
    return { resetAt: Date.now() };
  }

  function allocateSlot(room) {
    const used = new Set([...room.players.values()].map((player) => player.slot));
    for (let slot = 1; slot <= room.maxPlayers; slot++) {
      if (!used.has(slot)) return slot;
    }
    return null;
  }

  function sendError(session, code, message, { requestId = null, detail = null, fatal = false } = {}) {
    stats.protocolErrors++;
    send(session, { type: 'error', code, message, detail, requestId, fatal });
    if (fatal) session.connection.close(1008, code);
  }

  function findSessionPlayer(session) {
    if (!session.roomCode || !session.playerId) return null;
    const room = rooms.get(session.roomCode);
    if (!room) return null;
    const player = room.players.get(session.playerId);
    return player ? { room, player } : null;
  }

  function playerView(player, room) {
    return {
      id: player.id,
      slot: player.slot,
      name: player.name,
      car: player.car,
      ready: player.ready,
      connected: player.connected,
      host: room.hostId === player.id,
      resumedCount: player.resumedCount
    };
  }

  function roomView(room) {
    return {
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      map: room.map,
      powerups: room.powerups === true,
      maxPlayers: room.maxPlayers,
      seed: room.seed,
      startTick: room.startTick,
      tickHz: TICK_HZ,
      createdAt: room.createdAt,
      players: [...room.players.values()]
        .sort((a, b) => a.slot - b.slot)
        .map((player) => playerView(player, room))
    };
  }

  function selfView(player, room) {
    return {
      id: player.id,
      slot: player.slot,
      name: player.name,
      resumeToken: player.resumeToken,
      host: room.hostId === player.id
    };
  }

  function foreachConnected(room, callback, exceptPlayerId = null) {
    for (const player of room.players.values()) {
      if (!player.connected || !player.session) continue;
      if (player.id === exceptPlayerId) continue;
      callback(player);
    }
  }

  function broadcastRoom(room, exceptPlayerId = null) {
    const view = roomView(room);
    foreachConnected(room, (player) => send(player.session, { type: 'room.state', room: view, serverTime: Date.now() }), exceptPlayerId);
  }

  function sendToPlayer(room, playerId, message) {
    const target = room.players.get(playerId);
    if (!target || !target.connected || !target.session) return false;
    return send(target.session, message);
  }

  function promoteHost(room) {
    const candidates = [...room.players.values()]
      .filter((player) => player.connected && player.id !== room.hostId)
      .sort((a, b) => a.slot - b.slot);
    if (candidates.length === 0) return false;
    room.hostId = candidates[0].id;
    broadcastRoom(room);
    log({ event: 'host-promoted', room: room.code, hostId: room.hostId });
    return true;
  }

  function deleteRoom(room) {
    for (const player of room.players.values()) clearLater(player.resumeTimer);
    rooms.delete(room.code);
    log({ event: 'room-deleted', room: room.code });
  }

  function expirePlayer(roomCode, playerId) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const player = room.players.get(playerId);
    if (!player || player.connected) return;
    room.players.delete(playerId);
    room.finished.delete(playerId);
    stats.expiredPlayers++;
    log({ event: 'player-expired', room: room.code, playerId });
    if (room.hostId === playerId) promoteHost(room);
    if (room.players.size === 0) deleteRoom(room);
    else broadcastRoom(room);
  }

  function detach(session, reason) {
    if (!session.roomCode || !session.playerId) return;
    const room = rooms.get(session.roomCode);
    if (!room) return;
    const player = room.players.get(session.playerId);
    if (!player) return;
    player.connected = false;
    player.session = null;
    room.lastActivityAt = Date.now();
    player.disconnectedAt = Date.now();
    player.resumeDeadline = Date.now() + resumeWindowMs;
    clearLater(player.resumeTimer);
    player.resumeTimer = later(() => expirePlayer(room.code, player.id), resumeWindowMs);
    stats.disconnects++;
    log({ event: 'player-disconnected', room: room.code, playerId: player.id, reason });
    broadcastRoom(room);
  }

  function requireRoom(session) {
    const found = findSessionPlayer(session);
    if (!found) throw new NetError(ERROR_CODES.NET_NOT_IN_ROOM, 'not in a room');
    return found;
  }

  function handleMessage(session, text) {
    session.lastSeen = Date.now();
    stats.messagesIn++;
    stats.bytesIn += Buffer.byteLength(text, 'utf8');
    const now = Date.now();
    if (now - session.rateWindowStart >= 1000) {
      session.rateWindowStart = now;
      session.rateCount = 0;
    }
    session.rateCount++;
    if (session.rateCount > rateLimitPerSecond) {
      sendError(session, ERROR_CODES.NET_RATE_LIMIT, 'message rate exceeded', {
        fatal: true, detail: { limit: rateLimitPerSecond, windowMs: 1000 }
      });
      return;
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      sendError(session, ERROR_CODES.NET_PROTOCOL, 'message is not JSON', { fatal: true });
      return;
    }
    if (!isObject(message) || typeof message.type !== 'string') {
      sendError(session, ERROR_CODES.NET_PROTOCOL, 'message.type is required', { fatal: true });
      return;
    }
    const requestId = typeof message.requestId === 'string' ? message.requestId : null;

    try {
      switch (message.type) {
        case 'ping': {
          if (requestId) send(session, { type: 'pong', requestId, id: message.id ?? null, t: message.t ?? null, serverTime: Date.now() });
          else send(session, { type: 'pong', id: message.id ?? null, t: message.t ?? null, serverTime: Date.now() });
          return;
        }
        case 'room.create': {
          if (session.roomCode) throw new NetError(ERROR_CODES.NET_ALREADY_IN_ROOM, 'already in a room');
          consumeRate(session, 'create');
          const name = message.name;
          if (!validName(name)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid player name');
          const maxPlayers = message.maxPlayers ?? defaultMaxPlayers;
          if (!validCapacity(maxPlayers) || maxPlayers > hardMaxPlayers) {
            throw new NetError(ERROR_CODES.NET_CAPACITY,
              'maxPlayers must be ' + MIN_ROOM_CAPACITY + '..' + hardMaxPlayers,
              { requested: maxPlayers, min: MIN_ROOM_CAPACITY, max: hardMaxPlayers });
          }
          const map = message.map ?? 'usa_la_river';
          if (!validSelector(map)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid map selector');
          const car = message.car ?? 'corvette-zr1-stock';
          if (!validSelector(car)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid car selector');
          if (rooms.size >= maxRooms) {
            throw new NetError(ERROR_CODES.NET_CAPACITY, 'room capacity reached', {
              scope: 'rooms', limit: maxRooms, rooms: rooms.size
            });
          }

          let code = roomCode();
          for (let attempt = 0; rooms.has(code) && attempt < 32; attempt++) code = roomCode();
          if (rooms.has(code)) {
            throw new NetError(ERROR_CODES.NET_CAPACITY, 'could not allocate a room code', {
              scope: 'room-code', attempts: 32
            });
          }
          const room = {
            code,
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            phase: 'lobby',
            hostId: null,
            map,
            maxPlayers,
            // Room-level power-up flag (M2): the host sets it and every client
            // enables the same slice, so a guest never has to add ?powerups=1.
            powerups: message.powerups === true,
            seed: null,
            startTick: null,
            players: new Map(),
            finished: new Map()
          };
          const player = {
            id: 'pl_' + hex(8),
            slot: allocateSlot(room),
            name: name.trim(),
            car,
            ready: false,
            connected: true,
            session,
            resumeToken: hex(24),
            joinedAt: Date.now(),
            lastSeen: Date.now(),
            disconnectedAt: null,
            resumeDeadline: null,
            resumeTimer: null,
            resumedCount: 0
          };
          room.players.set(player.id, player);
          room.hostId = player.id;
          rooms.set(code, room);
          session.roomCode = code;
          session.playerId = player.id;
          stats.roomsCreated++;
          stats.maxPlayersSeen = Math.max(stats.maxPlayersSeen, room.players.size);
          log({ event: 'room-created', room: code, hostId: player.id, maxPlayers });
          send(session, {
            type: 'room.created',
            requestId,
            room: roomView(room),
            you: selfView(player, room),
            serverTime: Date.now()
          });
          return;
        }
        case 'room.join': {
          if (session.roomCode) throw new NetError(ERROR_CODES.NET_ALREADY_IN_ROOM, 'already in a room');
          consumeRate(session, 'join');
          const code = normalizeRoomCode(message.code);
          if (!validRoomCode(code)) throw new NetError(ERROR_CODES.NET_ROOM_NOT_FOUND, 'invalid room code');
          const room = rooms.get(code);
          if (!room) throw new NetError(ERROR_CODES.NET_ROOM_NOT_FOUND, 'room not found');
          touchRoom(room);
          const token = typeof message.resumeToken === 'string' ? message.resumeToken : null;
          if (token) {
            const existing = [...room.players.values()].find((player) => player.resumeToken === token);
            if (!existing) throw new NetError(ERROR_CODES.NET_RESUME_UNKNOWN, 'resume token is unknown or expired');
            if (existing.connected && existing.session && existing.session !== session) {
              throw new NetError(ERROR_CODES.NET_RESUME_IN_USE, 'player is already connected');
            }
            clearLater(existing.resumeTimer);
            existing.resumeTimer = null;
            existing.connected = true;
            existing.session = session;
            existing.lastSeen = Date.now();
            existing.disconnectedAt = null;
            existing.resumeDeadline = null;
            existing.resumedCount++;
            session.roomCode = room.code;
            session.playerId = existing.id;
            stats.resumes++;
            log({ event: 'player-resumed', room: room.code, playerId: existing.id, resumedCount: existing.resumedCount });
            send(session, {
              type: 'room.joined',
              requestId,
              resumed: true,
              room: roomView(room),
              you: selfView(existing, room),
              serverTime: Date.now()
            });
            foreachConnected(room, (player) => {
              send(player.session, { type: 'player.resumed', playerId: existing.id, slot: existing.slot, serverTime: Date.now() });
            }, existing.id);
            broadcastRoom(room);
            return;
          }

          if (room.phase !== 'lobby') throw new NetError(ERROR_CODES.NET_ROOM_STARTED, 'room is not in the lobby phase');
          const connected = [...room.players.values()].filter((player) => player.connected).length;
          // A disconnected player keeps its seat for the resume window. Count
          // reserved seats, not only connected ones, so a new join cannot
          // oversubscribe the room while a resume is still possible.
          if (room.players.size >= room.maxPlayers) {
            throw new NetError(ERROR_CODES.NET_ROOM_FULL, 'room is full', {
              maxPlayers: room.maxPlayers, connected, reserved: room.players.size
            });
          }
          const slot = allocateSlot(room);
          if (slot === null) throw new NetError(ERROR_CODES.NET_ROOM_FULL, 'no free slot', { maxPlayers: room.maxPlayers });
          if (!validName(message.name)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid player name');
          const car = message.car ?? 'corvette-zr1-stock';
          if (!validSelector(car)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid car selector');
          const player = {
            id: 'pl_' + hex(8),
            slot,
            name: message.name.trim(),
            car,
            ready: false,
            connected: true,
            session,
            resumeToken: hex(24),
            joinedAt: Date.now(),
            lastSeen: Date.now(),
            disconnectedAt: null,
            resumeDeadline: null,
            resumeTimer: null,
            resumedCount: 0
          };
          room.players.set(player.id, player);
          session.roomCode = room.code;
          session.playerId = player.id;
          stats.maxPlayersSeen = Math.max(stats.maxPlayersSeen, room.players.size);
          log({ event: 'player-joined', room: room.code, playerId: player.id, slot: player.slot });
          send(session, {
            type: 'room.joined',
            requestId,
            resumed: false,
            room: roomView(room),
            you: selfView(player, room),
            serverTime: Date.now()
          });
          broadcastRoom(room, player.id);
          return;
        }
        case 'room.leave': {
          const { room, player } = requireRoom(session);
          touchRoom(room);
          clearLater(player.resumeTimer);
          room.players.delete(player.id);
          room.finished.delete(player.id);
          session.roomCode = null;
          session.playerId = null;
          send(session, { type: 'ok', requestId, action: 'room.leave' });
          log({ event: 'player-left', room: room.code, playerId: player.id });
          if (room.hostId === player.id) promoteHost(room);
          if (room.players.size === 0) deleteRoom(room);
          else broadcastRoom(room);
          return;
        }
        case 'player.ready': {
          const { room, player } = requireRoom(session);
          touchRoom(room);
          if (room.phase !== 'lobby') throw new NetError(ERROR_CODES.NET_ROOM_NOT_RUNNING, 'ready is only valid in the lobby');
          if (typeof message.ready !== 'boolean') throw new NetError(ERROR_CODES.NET_PROTOCOL, 'ready must be boolean');
          player.ready = message.ready;
          send(session, { type: 'ok', requestId, action: 'player.ready', ready: player.ready });
          broadcastRoom(room);
          return;
        }
        case 'player.select': {
          const { room, player } = requireRoom(session);
          touchRoom(room);
          if (room.phase !== 'lobby') throw new NetError(ERROR_CODES.NET_ROOM_NOT_RUNNING, 'selection is only valid in the lobby');
          if (message.car !== undefined) {
            if (!validSelector(message.car)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid car selector');
            player.car = message.car;
          }
          if (message.map !== undefined) {
            if (room.hostId !== player.id) throw new NetError(ERROR_CODES.NET_NOT_HOST, 'only the host selects the map');
            if (!validSelector(message.map)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid map selector');
            room.map = message.map;
          }
          if (message.powerups !== undefined) {
            if (room.hostId !== player.id) throw new NetError(ERROR_CODES.NET_NOT_HOST, 'only the host sets power-ups');
            room.powerups = message.powerups === true;
          }
          send(session, { type: 'ok', requestId, action: 'player.select', car: player.car, map: room.map, powerups: room.powerups === true });
          broadcastRoom(room);
          return;
        }
        case 'room.start': {
          const { room, player } = requireRoom(session);
          touchRoom(room);
          if (room.hostId !== player.id) throw new NetError(ERROR_CODES.NET_NOT_HOST, 'only the host can start');
          if (room.phase !== 'lobby') throw new NetError(ERROR_CODES.NET_ROOM_NOT_RUNNING, 'room is not in the lobby phase');
          const connected = [...room.players.values()].filter((entry) => entry.connected);
          // A host + host-simulated AI room has one human; the page sends
          // `solo:true` only when it has AI participants. Two-human rooms keep
          // the original minimum.
          const minPlayers = message.solo === true ? 1 : MIN_PLAYERS_TO_START;
          if (connected.length < minPlayers) throw new NetError(ERROR_CODES.NET_NOT_ENOUGH_PLAYERS, 'need at least ' + minPlayers + ' connected players');
          const notReady = connected.filter((entry) => !entry.ready);
          if (notReady.length) {
            throw new NetError(ERROR_CODES.NET_NOT_READY, 'players not ready', { players: notReady.map((entry) => entry.id) });
          }
          const requestedSeed = typeof message.seed === 'string' ? message.seed : null;
          if (requestedSeed !== null && !/^[A-Za-z0-9_.:-]{1,64}$/.test(requestedSeed)) {
            throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid seed');
          }
          room.phase = 'running';
          room.seed = requestedSeed ?? hex(8);
          room.startTick = 1;
          room.startedAt = Date.now();
          room.finished.clear();
          const started = {
            type: 'room.started',
            room: roomView(room),
            startTick: room.startTick,
            seed: room.seed,
            tickHz: TICK_HZ,
            serverTime: Date.now()
          };
          send(session, { ...started, requestId });
          foreachConnected(room, (entry) => send(entry.session, started), player.id);
          log({ event: 'room-started', room: room.code, seed: room.seed, players: connected.length });
          return;
        }
        case 'state':
        case 'input': {
          const { room, player } = requireRoom(session);
          touchRoom(room);
          if (room.phase !== 'running') throw new NetError(ERROR_CODES.NET_ROOM_NOT_RUNNING, 'room is not running');
          if (!validSeq(message.seq)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid sequence');
          if (!validTick(message.tick)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid tick');
          if (message.type === 'state') {
            if (!validState(message.state)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid state');
            if (message.state.tick !== message.tick) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'state.tick must equal message.tick');
          } else if (!validInput(message.input)) {
            throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid input');
          }
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
          foreachConnected(room, (entry) => {
            stats.messagesRelayed++;
            send(entry.session, relay);
          }, player.id);
          return;
        }
        case 'stream.final': {
          const { room, player } = requireRoom(session);
          touchRoom(room);
          if (!validChannel(message.channel) || !validSeq(message.lastSeq) || !validTick(message.tick)) {
            throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid stream.final');
          }
          const relay = {
            type: 'stream.final',
            from: player.id,
            channel: message.channel,
            lastSeq: message.lastSeq,
            tick: message.tick
          };
          foreachConnected(room, (entry) => {
            stats.messagesRelayed++;
            send(entry.session, relay);
          }, player.id);
          return;
        }
        case 'ack':
        case 'resync':
        case 'stream.error': {
          const { room, player } = requireRoom(session);
          touchRoom(room);
          if (!validChannel(message.channel)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid channel');
          const targetId = message.to;
          if (typeof targetId !== 'string' || !room.players.has(targetId)) {
            throw new NetError(ERROR_CODES.NET_PLAYER_NOT_FOUND, 'target player not found');
          }
          if (message.type === 'ack' && !validSeq(message.seq)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid ack sequence');
          if (message.type === 'resync' && !validSeq(message.fromSeq)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid resync sequence');
          const relay = {
            type: message.type,
            from: player.id,
            to: targetId,
            channel: message.channel,
            seq: message.type === 'ack' ? message.seq : undefined,
            sentAt: Number.isFinite(message.sentAt) ? message.sentAt : null,
            fromSeq: message.type === 'resync' ? message.fromSeq : undefined,
            code: message.type === 'stream.error' ? message.code : undefined,
            detail: message.type === 'stream.error' ? message.detail ?? null : undefined
          };
          const target = room.players.get(targetId);
          if (!target.connected || !target.session) return;
          stats.messagesRelayed++;
          send(target.session, relay);
          return;
        }
        case 'client.finished': {
          const { room, player } = requireRoom(session);
          touchRoom(room);
          if (room.phase !== 'running' && room.phase !== 'finished') throw new NetError(ERROR_CODES.NET_ROOM_NOT_RUNNING, 'room is not running');
          if (!validTick(message.tick) || typeof message.hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(message.hash)) {
            throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid finish payload');
          }
          room.finished.set(player.id, { tick: message.tick, hash: message.hash });
          send(session, { type: 'ok', requestId, action: 'client.finished' });
          foreachConnected(room, (entry) => {
            send(entry.session, { type: 'player.finished', playerId: player.id, tick: message.tick, hash: message.hash });
          }, player.id);
          const connected = [...room.players.values()].filter((entry) => entry.connected);
          if (connected.length > 0 && connected.every((entry) => room.finished.has(entry.id))) {
            room.phase = 'finished';
            stats.roomsFinished++;
            const results = connected
              .sort((a, b) => a.slot - b.slot)
              .map((entry) => ({ playerId: entry.id, slot: entry.slot, ...room.finished.get(entry.id) }));
            const finished = { type: 'room.finished', room: roomView(room), results, serverTime: Date.now() };
            foreachConnected(room, (entry) => send(entry.session, finished));
            log({ event: 'room-finished', room: room.code, results });
          }
          return;
        }
        default:
          throw new NetError(ERROR_CODES.NET_PROTOCOL, 'unknown message type: ' + message.type);
      }
    } catch (error) {
      if (error instanceof NetError) {
        sendError(session, error.code, error.message, { requestId, detail: error.detail });
        return;
      }
      sendError(session, ERROR_CODES.NET_REJECTED, 'handler error: ' + String(error?.message || error), { requestId });
    }
  }

  let tlsOptions = null;
  if (tls) {
    if (!isObject(tls)) throw new NetError(ERROR_CODES.NET_CONFIG, 'tls must be an object');
    try {
      if (tls.pfx) {
        tlsOptions = { pfx: readFileSync(tls.pfx), passphrase: tls.passphrase ?? undefined };
      } else if (tls.cert && tls.key) {
        tlsOptions = { cert: readFileSync(tls.cert), key: readFileSync(tls.key) };
        if (tls.ca) tlsOptions.ca = readFileSync(tls.ca);
      } else {
        throw new NetError(ERROR_CODES.NET_CONFIG, 'tls requires cert+key (PEM) or pfx');
      }
    } catch (error) {
      if (error instanceof NetError) throw error;
      throw new NetError(ERROR_CODES.NET_CONFIG, 'could not read TLS material: ' + String(error?.message || error), {
        cert: tls.cert ?? null, key: tls.key ?? null, pfx: tls.pfx ?? null
      });
    }
  }

  const handler = createStaticHandler({ health: (request) => healthView(request) });
  const server = tlsOptions ? createHttpsServer(tlsOptions, handler) : createHttpServer(handler);
  const clients = new Set();

  function rejectUpgrade(socket, status, code, message, detail = null) {
    stats.upgradesRejected++;
    const body = JSON.stringify({ type: 'error', code, message, detail, fatal: true });
    try {
      socket.write(
        'HTTP/1.1 ' + status + ' ' + (status === 503 ? 'Service Unavailable' : 'Bad Request') + '\r\n' +
        'Connection: close\r\n' +
        'Content-Type: application/json; charset=utf-8\r\n' +
        'Content-Length: ' + Buffer.byteLength(body) + '\r\n' +
        'X-Net-Error: ' + code + '\r\n\r\n' + body
      );
    } catch { /* socket already gone */ }
    socket.destroy();
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const key = request.headers['sec-websocket-key'];
    const version = request.headers['sec-websocket-version'];
    if (url.pathname !== '/ws' || request.headers.upgrade?.toLowerCase() !== 'websocket' ||
        typeof key !== 'string' || version !== '13') {
      rejectUpgrade(socket, 400, ERROR_CODES.NET_PROTOCOL, 'websocket upgrade required');
      return;
    }
    if (shuttingDown) {
      rejectUpgrade(socket, 503, ERROR_CODES.NET_SHUTDOWN, 'server is shutting down');
      return;
    }
    const resolved = resolveClientIp(request);
    if (clients.size >= maxConnections) {
      rejectUpgrade(socket, 503, ERROR_CODES.NET_CAPACITY, 'connection capacity reached', {
        scope: 'connections', limit: maxConnections
      });
      return;
    }
    const ipCount = ipConnectionCounts.get(resolved.ip) ?? 0;
    if (resolved.ip && ipCount >= maxConnectionsPerIp) {
      rejectUpgrade(socket, 503, ERROR_CODES.NET_CAPACITY, 'per-IP connection capacity reached', {
        scope: 'ip-connections', limit: maxConnectionsPerIp, ipHash: clientIpHash(resolved.ip)
      });
      return;
    }
    stats.proxyHeaders[resolved.source] = (stats.proxyHeaders[resolved.source] ?? 0) + 1;

    const accept = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    if (head && head.length) socket.unshift(head);

    const connection = new WebSocketConnection(socket, {
      id: 'cn_' + hex(6),
      maxMessageBytes,
      onMessage: (conn, text) => {
        const session = sessions.get(conn.id);
        if (session) handleMessage(session, text);
      },
      onClose: (conn, reason) => {
        if (reason === 'protocol-error:' + ERROR_CODES.NET_MESSAGE_TOO_LARGE) stats.oversizeRejected++;
        if (reason === 'protocol-error:' + ERROR_CODES.NET_BINARY_UNSUPPORTED) stats.binaryRejected++;
        const session = sessions.get(conn.id);
        clients.delete(conn);
        if (session?.ip) {
          const next = (ipConnectionCounts.get(session.ip) ?? 1) - 1;
          if (next <= 0) ipConnectionCounts.delete(session.ip);
          else ipConnectionCounts.set(session.ip, next);
        }
        if (!session) return;
        sessions.delete(conn.id);
        detach(session, reason);
      },
      onError: (conn, error) => {
        log({ event: 'socket-error', connectionId: conn.id, error: String(error?.message || error) });
      }
    });
    const session = {
      id: connection.id,
      connection,
      ip: resolved.ip,
      ipSource: resolved.source,
      roomCode: null,
      playerId: null,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      rateWindowStart: Date.now(),
      rateCount: 0,
      closed: false
    };
    sessions.set(connection.id, session);
    clients.add(connection);
    if (resolved.ip) ipConnectionCounts.set(resolved.ip, ipCount + 1);
    stats.connections++;
    send(session, {
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      schema: MESSAGE_SCHEMA,
      connectionId: connection.id,
      serverTime: Date.now(),
      heartbeatMs: heartbeatIntervalMs,
      heartbeatTimeoutMs,
      resumeWindowMs,
      maxMessageBytes,
      maxPlayers: defaultMaxPlayers,
      hardMaxPlayers,
      tls: Boolean(tlsOptions)
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  restoreStateFile();

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const connection of clients) {
      const session = sessions.get(connection.id);
      if (!session) continue;
      if (now - session.lastSeen > heartbeatTimeoutMs) {
        stats.heartbeatTimeouts++;
        log({ event: 'heartbeat-timeout', connectionId: connection.id, playerId: session.playerId, lastSeenAgoMs: now - session.lastSeen });
        try {
          send(session, {
            type: 'error', code: ERROR_CODES.NET_TIMEOUT, message: 'heartbeat timeout',
            detail: { timeoutMs: heartbeatTimeoutMs }, requestId: null, fatal: true
          });
        } catch { /* socket already gone */ }
        connection.close(1001, 'heartbeat timeout');
        continue;
      }
      send(session, { type: 'heartbeat', serverTime: now, uptimeMs: now - startedAt });
    }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  const sweepEvery = sweepIntervalMs ?? Math.min(15_000, Math.max(250, Math.floor(idleRoomMs / 2)));
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      const connected = [...room.players.values()].filter((player) => player.connected);
      if (connected.length === 0 && now - room.lastActivityAt > emptyRoomMs) {
        deleteRoom(room);
        continue;
      }
      if (now - room.lastActivityAt > idleRoomMs) {
        stats.idleRoomsReaped++;
        log({ event: 'room-idle', room: room.code, idleMs: now - room.lastActivityAt });
        for (const player of room.players.values()) {
          if (!player.session) continue;
          try {
            send(player.session, {
              type: 'error', code: ERROR_CODES.NET_ROOM_IDLE, message: 'room was idle and has been reaped',
              detail: { idleMs: idleRoomMs }, requestId: null, fatal: true
            });
          } catch { /* socket already gone */ }
          player.session.connection.close(1012, 'room idle');
        }
        deleteRoom(room);
        continue;
      }
      if (now - room.createdAt > roomTtlMs) {
        stats.expiredRoomsReaped++;
        log({ event: 'room-expired', room: room.code, ageMs: now - room.createdAt });
        for (const player of room.players.values()) {
          if (!player.session) continue;
          try {
            send(player.session, {
              type: 'error', code: ERROR_CODES.NET_ROOM_EXPIRED, message: 'room reached its TTL',
              detail: { ttlMs: roomTtlMs }, requestId: null, fatal: true
            });
          } catch { /* socket already gone */ }
          player.session.connection.close(1012, 'room expired');
        }
        deleteRoom(room);
      }
    }
    if (ipBuckets.size > MAX_RATE_BUCKETS / 2) {
      for (const [key, entry] of ipBuckets) {
        if (now - entry.lastSeen > 60 * 60 * 1000) ipBuckets.delete(key);
      }
    }
  }, sweepEvery);
  sweeper.unref?.();

  const stateTimer = stateFile
    ? setInterval(() => saveStateFile(), Math.max(1_000, saveStateIntervalMs))
    : null;
  stateTimer?.unref?.();

  async function waitForClients(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (clients.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function close({ reason = 'server shutdown', drainMs = 2000, save = true } = {}) {
    if (closePromise) return closePromise;
    shuttingDown = true;
    stats.shutdowns++;
    const closed = new Promise((resolve) => server.close(() => resolve()));
    closePromise = (async () => {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      if (stateTimer) clearInterval(stateTimer);
      if (save) saveStateFile();
      for (const connection of clients) {
        const session = sessions.get(connection.id);
        if (session) {
          send(session, {
            type: 'server.shutdown', reason, resumeWindowMs, serverTime: Date.now()
          });
        }
        connection.close(1012, 'server shutdown');
      }
      await waitForClients(Math.max(0, drainMs));
      for (const connection of clients) {
        try { connection.socket.destroy(); } catch { /* already closed */ }
      }
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections?.();
      await closed;
    })();
    return closePromise;
  }

  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const urlHost = displayHost.includes(':') ? '[' + displayHost + ']' : displayHost;
  const originProtocol = tlsOptions ? 'https' : 'http';
  const wsProtocol = tlsOptions ? 'wss' : 'ws';

  return {
    server,
    port: actualPort,
    tls: Boolean(tlsOptions),
    origin: originProtocol + '://' + urlHost + ':' + actualPort,
    wsUrl: wsProtocol + '://' + urlHost + ':' + actualPort + '/ws',
    statePath: stateFile,
    close,
    health: () => healthView(null),
    stats: () => ({
      ...stats,
      byType: Object.fromEntries(Object.entries(stats.byType).map(([key, value]) => [key, { ...value }])),
      proxyHeaders: { ...stats.proxyHeaders },
      rooms: rooms.size,
      sessions: sessions.size
    }),
    bandwidth: bandwidthView,
    resetBandwidth,
    snapshot: () => [...rooms.values()].map(roomView)
  };
}

// --------------------------------------------------------------- CLI helpers

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function parseArgs(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      index++;
    } else {
      flags.set(name, 'true');
    }
  }
  return flags;
}

function readInteger(flags, env, names, fallback, envNames = []) {
  for (const name of names) {
    if (flags.has(name)) return Number(flags.get(name));
  }
  for (const name of envNames) {
    if (env[name] !== undefined && env[name] !== '') return Number(env[name]);
  }
  return fallback;
}

function readString(flags, env, names, fallback, envNames = []) {
  for (const name of names) if (flags.has(name)) return flags.get(name);
  for (const name of envNames) if (env[name] !== undefined && env[name] !== '') return env[name];
  return fallback;
}

function loadCliConfig(argv, env) {
  const flags = parseArgs(argv);
  if (flags.has('help')) return { help: true };
  const tlsCert = readString(flags, env, ['tls-cert'], null, ['NET_MVP_TLS_CERT']);
  const tlsKey = readString(flags, env, ['tls-key'], null, ['NET_MVP_TLS_KEY']);
  const tlsPfx = readString(flags, env, ['tls-pfx'], null, ['NET_MVP_TLS_PFX']);
  const tlsPassphrase = readString(flags, env, ['tls-pfx-passphrase'], null, ['NET_MVP_TLS_PFX_PASSPHRASE']);
  const tls = tlsPfx
    ? { pfx: tlsPfx, passphrase: tlsPassphrase }
    : tlsCert || tlsKey
      ? { cert: tlsCert, key: tlsKey }
      : null;
  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
    throw new NetError(ERROR_CODES.NET_CONFIG, 'both --tls-cert and --tls-key are required');
  }
  const defaultMaxPlayers = readInteger(flags, env, ['default-max-players'], DEFAULT_MAX_PLAYERS, ['NET_MVP_DEFAULT_MAX_PLAYERS']);
  const hardMaxPlayers = readInteger(flags, env, ['hard-max-players'], HARD_MAX_PLAYERS, ['NET_MVP_HARD_MAX_PLAYERS']);
  return {
    port: readInteger(flags, env, ['port'], 8810, ['NET_MVP_PORT', 'PORT']),
    host: readString(flags, env, ['host'], '127.0.0.1', ['NET_MVP_HOST']),
    defaultMaxPlayers,
    hardMaxPlayers,
    maxRooms: readInteger(flags, env, ['max-rooms'], DEFAULT_MAX_ROOMS, ['NET_MVP_MAX_ROOMS']),
    maxConnections: readInteger(flags, env, ['max-connections'], DEFAULT_MAX_CONNECTIONS, ['NET_MVP_MAX_CONNECTIONS']),
    maxConnectionsPerIp: readInteger(flags, env, ['max-connections-per-ip'], DEFAULT_MAX_CONNECTIONS_PER_IP, ['NET_MVP_MAX_CONNECTIONS_PER_IP']),
    maxMessageBytes: readInteger(flags, env, ['max-message-bytes'], MAX_MESSAGE_BYTES, ['NET_MVP_MAX_MESSAGE_BYTES']),
    rateLimitPerSecond: readInteger(flags, env, ['rate-limit-per-second'], RATE_LIMIT_PER_SECOND, ['NET_MVP_RATE_LIMIT_PER_SECOND']),
    resumeWindowMs: readInteger(flags, env, ['resume-window-ms'], RESUME_WINDOW_MS, ['NET_MVP_RESUME_WINDOW_MS']),
    heartbeatIntervalMs: readInteger(flags, env, ['heartbeat-ms'], HEARTBEAT_INTERVAL_MS, ['NET_MVP_HEARTBEAT_MS']),
    heartbeatTimeoutMs: readInteger(flags, env, ['heartbeat-timeout-ms'], HEARTBEAT_TIMEOUT_MS, ['NET_MVP_HEARTBEAT_TIMEOUT_MS']),
    roomTtlMs: readInteger(flags, env, ['room-ttl-ms'], ROOM_TTL_MS, ['NET_MVP_ROOM_TTL_MS']),
    idleRoomMs: readInteger(flags, env, ['idle-room-ms'], IDLE_ROOM_MS, ['NET_MVP_IDLE_ROOM_MS']),
    emptyRoomMs: readInteger(flags, env, ['empty-room-ms'], EMPTY_ROOM_MS, ['NET_MVP_EMPTY_ROOM_MS']),
    trustProxy: parseBoolean(flags.get('trust-proxy') ?? env.NET_MVP_TRUST_PROXY, false),
    stateFile: readString(flags, env, ['state-file'], null, ['NET_MVP_STATE_FILE']),
    tls,
    joinRateLimit: {
      capacity: readInteger(flags, env, ['join-burst'], JOIN_RATE_CAPACITY, ['NET_MVP_JOIN_BURST']),
      refillPerSecond: Number(readString(flags, env, ['join-rate-per-second'], String(JOIN_RATE_REFILL_PER_SECOND), ['NET_MVP_JOIN_RATE_PER_SECOND']))
    },
    createRateLimit: {
      capacity: readInteger(flags, env, ['create-burst'], CREATE_RATE_CAPACITY, ['NET_MVP_CREATE_BURST']),
      refillPerSecond: Number(readString(flags, env, ['create-rate-per-second'], String(CREATE_RATE_REFILL_PER_SECOND), ['NET_MVP_CREATE_RATE_PER_SECOND']))
    },
    logLevel: readString(flags, env, ['log-level'], 'info', ['NET_MVP_LOG_LEVEL'])
  };
}

// Direct CLI: `node probes/net-mvp/server.mjs [--port 8810] [--tls-cert ... --tls-key ...]`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadCliConfig(process.argv.slice(2), process.env);
  if (config.help) {
    console.log([
      'net-mvp room service',
      '',
      '  --port <n>                     default 8810 (env NET_MVP_PORT/PORT)',
      '  --host <addr>                  default 127.0.0.1; 0.0.0.0 behind a proxy',
      '  --default-max-players <2..20>  default 8',
      '  --hard-max-players <2..20>     default 20',
      '  --max-rooms <n>                default 64',
      '  --max-connections <n>          default 512',
      '  --max-connections-per-ip <n>   default 16',
      '  --max-message-bytes <n>        default 65536, max 65536',
      '  --resume-window-ms <n>         default 30000',
      '  --heartbeat-ms <n>             default 1000',
      '  --heartbeat-timeout-ms <n>     default 4500',
      '  --idle-room-ms <n>             default 300000',
      '  --room-ttl-ms <n>              default 7200000',
      '  --join-burst / --join-rate-per-second      default 30 / 1',
      '  --create-burst / --create-rate-per-second  default 10 / 0.2',
      '  --trust-proxy                  honour CF-Connecting-IP / X-Forwarded-For',
      '  --tls-cert <pem> --tls-key <pem>           native wss://',
      '  --tls-pfx <p12> [--tls-pfx-passphrase <p>] test/Windows convenience',
      '  --state-file <json>            restore rooms across a graceful restart',
      '  --log-level <info|quiet>'
    ].join('\n'));
    process.exit(0);
  }
  const logger = config.logLevel === 'quiet'
    ? () => {}
    : (event) => console.log('[net-mvp]', JSON.stringify(event));
  if (!config.tls && config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
    logger({ event: 'insecure-listener', host: config.host, note: 'plain ws is LAN-only; terminate TLS in a reverse proxy or pass --tls-cert/--tls-key' });
  }
  try {
    const server = await startRoomServer({ ...config, log: logger });
    console.log('net-mvp room service: ' + server.origin + '/');
    console.log('websocket endpoint:   ' + server.wsUrl);
    console.log('health endpoint:      ' + server.origin + '/healthz');
    console.log('capacity:             default ' + config.defaultMaxPlayers + ', hard ' + config.hardMaxPlayers +
      ', rooms ' + config.maxRooms + ', connections ' + config.maxConnections);
    if (server.statePath) console.log('state file:           ' + server.statePath);
    const shutdown = (signal) => {
      console.log('[net-mvp] received ' + signal + ', draining');
      server.close({ reason: 'signal ' + signal }).then(() => process.exit(0)).catch((error) => {
        console.error('[net-mvp] shutdown failed:', String(error?.message || error));
        process.exit(1);
      });
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('[net-mvp] fatal:', error instanceof NetError ? JSON.stringify(error.toJSON()) : String(error?.stack || error));
    process.exit(1);
  }
}

