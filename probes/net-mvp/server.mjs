// Dependency-free room service for the net-mvp gate.
//
//   * HTTP static server for probes/net-mvp/web plus four shared modules;
//   * minimal RFC 6455 WebSocket server on /ws (text frames only);
//   * room create/join with a 5-character code, host assignment, roster,
//     ready/start, car/map selection, heartbeat, disconnect/resume token;
//   * relay of sequence-numbered input/state/ack/resync/final messages.
//
// No npm packages, no database, no game assets, no accounts. Everything is in
// one process and in memory; restarting the process loses rooms by design.
//
// The implementation is intentionally bounded: 64 KiB message cap, 8 players
// per room, 400 messages/s per socket, 30 s resume window, 2 h room TTL.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROTOCOL_VERSION,
  MESSAGE_SCHEMA,
  MAX_MESSAGE_BYTES,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  DEFAULT_MAX_PLAYERS,
  HARD_MAX_PLAYERS,
  MIN_PLAYERS_TO_START,
  RESUME_WINDOW_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  ROOM_TTL_MS,
  RATE_LIMIT_PER_SECOND,
  TICK_HZ,
  ERROR_CODES,
  NetError,
  isObject,
  isInteger,
  validName,
  validSelector,
  validRoomCode,
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
  constructor(socket, { id, onMessage, onClose, onError }) {
    this.id = id;
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.onError = onError;
    this.closed = false;
    this.closeSent = false;
    this.buffer = Buffer.alloc(0);
    this.fragment = null; // { opcode, parts, length }
    this.maxBuffered = 2 * 1024 * 1024;
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
    if (payload.length > MAX_MESSAGE_BYTES) {
      throw new NetError(ERROR_CODES.NET_PROTOCOL, 'outbound message exceeds cap', { bytes: payload.length });
    }
    if (this.socket.destroyed || !this.socket.writable) {
      throw new NetError(ERROR_CODES.NET_NOT_CONNECTED, 'websocket is not writable');
    }
    if (this.socket.writableLength > this.maxBuffered) {
      this.close(1011, 'outbound queue cap');
      throw new NetError(ERROR_CODES.NET_NOT_CONNECTED, 'outbound queue cap exceeded');
    }
    this.socket.write(encodeFrame(0x1, payload));
  }

  sendControl(opcode, payload = Buffer.alloc(0)) {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(encodeFrame(opcode, payload));
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

  feed(chunk) {
    if (this.closed) return;
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
      if (rsv !== 0) return this.fail(1002, 'RSV bits are not negotiated');
      if (!masked) return this.fail(1002, 'client frames must be masked');
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        if (high !== 0 || low > MAX_MESSAGE_BYTES) return this.fail(1009, 'message too large');
        length = low;
        offset = 10;
      }
      if (length > MAX_MESSAGE_BYTES) return this.fail(1009, 'message too large');
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
        if (!fin || length > 125) return this.fail(1002, 'invalid control frame');
        if (opcode === 0x8) {
          this.sendControl(0x8, payload.subarray(0, Math.min(2, payload.length)));
          this.closeSent = true;
          this.socket.end();
          this.finish('peer-close');
          return;
        }
        if (opcode === 0x9) { this.sendControl(0xa, payload); continue; }
        if (opcode === 0xa) continue;
        return this.fail(1002, 'unknown control opcode');
      }

      if (opcode === 0x2) return this.fail(1003, 'binary frames are not supported');
      if (opcode === 0x1) {
        if (this.fragment) return this.fail(1002, 'new data frame during fragmentation');
        if (fin) {
          this.deliver(payload);
        } else {
          this.fragment = { parts: [payload], length: payload.length };
        }
        continue;
      }
      if (opcode === 0x0) {
        if (!this.fragment) return this.fail(1002, 'continuation without a fragment');
        this.fragment.parts.push(payload);
        this.fragment.length += payload.length;
        if (this.fragment.length > MAX_MESSAGE_BYTES) return this.fail(1009, 'message too large');
        if (fin) {
          const message = Buffer.concat(this.fragment.parts);
          this.fragment = null;
          this.deliver(message);
        }
        continue;
      }
      return this.fail(1002, 'unknown data opcode');
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

/** Serve only the probe web tree and the four shared modules. */
function createStaticHandler() {
  return (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
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
 * Returns { server, port, origin, close(), stats(), snapshot() }.
 */
export async function startRoomServer({
  port = 0,
  host = '127.0.0.1',
  resumeWindowMs = RESUME_WINDOW_MS,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
  roomTtlMs = ROOM_TTL_MS,
  maxMessageBytes = MAX_MESSAGE_BYTES,
  log = () => {}
} = {}) {
  const rooms = new Map();
  const sessions = new Map();
  const timers = new Set();
  const startedAt = Date.now();
  const stats = {
    connections: 0,
    messagesIn: 0,
    messagesOut: 0,
    messagesRelayed: 0,
    protocolErrors: 0,
    roomsCreated: 0,
    roomsFinished: 0,
    resumes: 0,
    disconnects: 0,
    expiredPlayers: 0,
    maxPlayersSeen: 0
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

  function send(session, message) {
    try {
      session.connection.sendText(JSON.stringify(message));
      stats.messagesOut++;
      return true;
    } catch (error) {
      log({ event: 'send-failed', playerId: session.playerId, error: String(error?.message || error) });
      return false;
    }
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
    const now = Date.now();
    if (now - session.rateWindowStart >= 1000) {
      session.rateWindowStart = now;
      session.rateCount = 0;
    }
    session.rateCount++;
    if (session.rateCount > RATE_LIMIT_PER_SECOND) {
      sendError(session, ERROR_CODES.NET_RATE_LIMIT, 'message rate exceeded', { fatal: true });
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
          const name = message.name;
          if (!validName(name)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid player name');
          const maxPlayers = message.maxPlayers ?? DEFAULT_MAX_PLAYERS;
          if (!isInteger(maxPlayers) || maxPlayers < MIN_PLAYERS_TO_START || maxPlayers > HARD_MAX_PLAYERS) {
            throw new NetError(ERROR_CODES.NET_PROTOCOL, 'maxPlayers must be ' + MIN_PLAYERS_TO_START + '..' + HARD_MAX_PLAYERS);
          }
          const map = message.map ?? 'usa_la_river';
          if (!validSelector(map)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid map selector');
          const car = message.car ?? 'corvette-zr1-stock';
          if (!validSelector(car)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid car selector');
          if (rooms.size >= 64) throw new NetError(ERROR_CODES.NET_REJECTED, 'room capacity reached');

          let code = roomCode();
          for (let attempt = 0; rooms.has(code) && attempt < 32; attempt++) code = roomCode();
          if (rooms.has(code)) throw new NetError(ERROR_CODES.NET_REJECTED, 'could not allocate a room code');
          const room = {
            code,
            createdAt: Date.now(),
            phase: 'lobby',
            hostId: null,
            map,
            maxPlayers,
            seed: null,
            startTick: null,
            players: new Map(),
            finished: new Map(),
            nextSlot: 1
          };
          const player = {
            id: 'pl_' + hex(8),
            slot: room.nextSlot++,
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
          if (!validRoomCode(message.code)) throw new NetError(ERROR_CODES.NET_ROOM_NOT_FOUND, 'invalid room code');
          const room = rooms.get(message.code);
          if (!room) throw new NetError(ERROR_CODES.NET_ROOM_NOT_FOUND, 'room not found');
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
          if (connected >= room.maxPlayers) throw new NetError(ERROR_CODES.NET_ROOM_FULL, 'room is full');
          if (!validName(message.name)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid player name');
          const car = message.car ?? 'corvette-zr1-stock';
          if (!validSelector(car)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid car selector');
          const player = {
            id: 'pl_' + hex(8),
            slot: room.nextSlot++,
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
          if (room.phase !== 'lobby') throw new NetError(ERROR_CODES.NET_ROOM_NOT_RUNNING, 'ready is only valid in the lobby');
          if (typeof message.ready !== 'boolean') throw new NetError(ERROR_CODES.NET_PROTOCOL, 'ready must be boolean');
          player.ready = message.ready;
          send(session, { type: 'ok', requestId, action: 'player.ready', ready: player.ready });
          broadcastRoom(room);
          return;
        }
        case 'player.select': {
          const { room, player } = requireRoom(session);
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
          send(session, { type: 'ok', requestId, action: 'player.select', car: player.car, map: room.map });
          broadcastRoom(room);
          return;
        }
        case 'room.start': {
          const { room, player } = requireRoom(session);
          if (room.hostId !== player.id) throw new NetError(ERROR_CODES.NET_NOT_HOST, 'only the host can start');
          if (room.phase !== 'lobby') throw new NetError(ERROR_CODES.NET_ROOM_NOT_RUNNING, 'room is not in the lobby phase');
          const connected = [...room.players.values()].filter((entry) => entry.connected);
          if (connected.length < MIN_PLAYERS_TO_START) throw new NetError(ERROR_CODES.NET_NOT_ENOUGH_PLAYERS, 'need at least ' + MIN_PLAYERS_TO_START + ' connected players');
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

  const server = createServer(createStaticHandler());
  const clients = new Set();

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const key = request.headers['sec-websocket-key'];
    const version = request.headers['sec-websocket-version'];
    if (url.pathname !== '/ws' || request.headers.upgrade?.toLowerCase() !== 'websocket' ||
        typeof key !== 'string' || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
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
      onMessage: (conn, text) => handleMessage(sessions.get(conn.id), text),
      onClose: (conn, reason) => {
        const session = sessions.get(conn.id);
        clients.delete(conn);
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
      roomCode: null,
      playerId: null,
      lastSeen: Date.now(),
      rateWindowStart: Date.now(),
      rateCount: 0,
      closed: false
    };
    sessions.set(connection.id, session);
    clients.add(connection);
    stats.connections++;
    send(session, {
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      schema: MESSAGE_SCHEMA,
      connectionId: connection.id,
      serverTime: Date.now(),
      heartbeatMs: heartbeatIntervalMs,
      resumeWindowMs,
      maxMessageBytes
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

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const connection of clients) {
      const session = sessions.get(connection.id);
      if (!session) continue;
      if (now - session.lastSeen > heartbeatTimeoutMs) {
        log({ event: 'heartbeat-timeout', connectionId: connection.id, playerId: session.playerId });
        connection.close(1001, 'heartbeat timeout');
        continue;
      }
      send(session, { type: 'heartbeat', serverTime: now, uptimeMs: now - startedAt });
    }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.players.size === 0 && now - room.createdAt > 60_000) deleteRoom(room);
      else if (now - room.createdAt > roomTtlMs) {
        for (const player of room.players.values()) player.session?.connection.close(1001, 'room expired');
        deleteRoom(room);
      }
    }
  }, 60_000);
  sweeper.unref?.();

  async function close() {
    clearInterval(heartbeat);
    clearInterval(sweeper);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const connection of clients) connection.close(1001, 'server shutdown');
    await new Promise((resolve) => server.close(resolve));
  }

  return {
    server,
    port: actualPort,
    origin: 'http://' + host + ':' + actualPort,
    wsUrl: 'ws://' + host + ':' + actualPort + '/ws',
    close,
    stats: () => ({ ...stats, rooms: rooms.size, sessions: sessions.size }),
    snapshot: () => [...rooms.values()].map(roomView)
  };
}

// Direct CLI: `node probes/net-mvp/server.mjs [--port 8810]`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--port');
  const port = Number(index >= 0 ? args[index + 1] : 8810);
  const { origin, wsUrl } = await startRoomServer({
    port,
    log: (event) => console.log('[net-mvp]', JSON.stringify(event))
  });
  console.log('net-mvp room service: ' + origin + '/');
  console.log('websocket endpoint:   ' + wsUrl);
}
