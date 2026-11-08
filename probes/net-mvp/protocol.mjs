// Wire contract for the net-mvp room service and state-sync client.
//
// This is an original project protocol. It is not a retail Blur protocol and
// carries no game asset bytes. Messages are JSON text frames over RFC 6455
// WebSocket. The client library validates every field before it is applied; an
// unknown or malformed message raises a typed NetError instead of being ignored.
//
// Channel vocabulary:
//   'input' -> 60 Hz controls, sequence-numbered per sender
//   'state' -> 20 Hz vehicle snapshots, sequence-numbered per sender
// Both channels carry { from, channel, seq, tick, sentAt } and are relayed by
// the room service. 'state' snapshots use the existing E1 state shape:
//   { tick, position:[x,y,z], quaternion:[x,y,z,w], speed }
// No matrix, rotation axis or engine struct is invented here.

export const PROTOCOL_VERSION = 1;
export const MESSAGE_SCHEMA = 'blur.net-mvp/1';
export const MAX_MESSAGE_BYTES = 64 * 1024;

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;

// A room defaults to 8 seats and accepts an explicit 2..20. The upper bound is
// a transport policy: every snapshot is relayed to every peer, so server egress
// grows quadratically. A request above 20 is rejected with NET_CAPACITY instead
// of being silently clamped.
export const MIN_ROOM_CAPACITY = 2;
export const DEFAULT_MAX_PLAYERS = 8;
export const HARD_MAX_PLAYERS = 20;
export const MIN_PLAYERS_TO_START = 2;

export const RESUME_WINDOW_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 1_000;
// Server and client use the same ceiling. A socket that has produced no inbound
// traffic for 4.5 s is treated as half-open; the client reconnects with its
// resume token. The shorter detection leaves more of the 30 s grace window for
// retries on a mobile link.
export const HEARTBEAT_TIMEOUT_MS = 4_500;
export const ROOM_TTL_MS = 2 * 60 * 60 * 1_000;
export const IDLE_ROOM_MS = 5 * 60 * 1_000;
export const EMPTY_ROOM_MS = 60 * 1_000;

export const DEFAULT_MAX_ROOMS = 64;
export const DEFAULT_MAX_CONNECTIONS = 512;
export const DEFAULT_MAX_CONNECTIONS_PER_IP = 16;

// Per-IP token buckets. A join burst of 30 and a sustained 60/min is generous
// for a lobby behind NAT while keeping code enumeration impractical
// (32^5 = 33,554,432 codes). Creates are tighter because a room is a new server
// object.
export const JOIN_RATE_CAPACITY = 30;
export const JOIN_RATE_REFILL_PER_SECOND = 1;
export const CREATE_RATE_CAPACITY = 10;
export const CREATE_RATE_REFILL_PER_SECOND = 0.2;

// The gate acks each applied message to measure per-message RTT, so an 8-client
// room legitimately reaches ~1,120 messages/s per client. A 15 s stall replay
// from the 20 s sender cache can additionally burst ~2,400 relayed messages and
// their acks into one second, so the socket ceiling is 12,000 messages/s. That
// is still a bounded policy (a flood is rejected), not a production limit.
export const RATE_LIMIT_PER_SECOND = 12_000;

export const TICK_HZ = 60;
export const INPUT_HZ = 60;
export const STATE_HZ = 20;
export const STATE_EVERY_TICKS = TICK_HZ / STATE_HZ;
export const DEFAULT_SECONDS = 30;
export const DEFAULT_FINAL_TICK = DEFAULT_SECONDS * TICK_HZ;

export const PHASES = Object.freeze(['lobby', 'running', 'finished']);

export const CHANNELS = Object.freeze(['input', 'state']);

export const ERROR_CODES = Object.freeze({
  NET_PROTOCOL: 'NET_PROTOCOL',
  NET_VERSION: 'NET_VERSION',
  NET_ROOM_NOT_FOUND: 'NET_ROOM_NOT_FOUND',
  NET_ROOM_FULL: 'NET_ROOM_FULL',
  NET_ROOM_STARTED: 'NET_ROOM_STARTED',
  NET_ROOM_NOT_RUNNING: 'NET_ROOM_NOT_RUNNING',
  NET_NOT_HOST: 'NET_NOT_HOST',
  NET_NOT_READY: 'NET_NOT_READY',
  NET_NOT_ENOUGH_PLAYERS: 'NET_NOT_ENOUGH_PLAYERS',
  NET_RESUME_UNKNOWN: 'NET_RESUME_UNKNOWN',
  NET_RESUME_IN_USE: 'NET_RESUME_IN_USE',
  NET_NOT_CONNECTED: 'NET_NOT_CONNECTED',
  NET_TIMEOUT: 'NET_TIMEOUT',
  NET_RATE_LIMIT: 'NET_RATE_LIMIT',
  NET_ALREADY_IN_ROOM: 'NET_ALREADY_IN_ROOM',
  NET_NOT_IN_ROOM: 'NET_NOT_IN_ROOM',
  NET_BUFFER_OVERFLOW: 'NET_BUFFER_OVERFLOW',
  NET_RESYNC_RANGE: 'NET_RESYNC_RANGE',
  NET_FINAL_MISSING: 'NET_FINAL_MISSING',
  NET_PLAYER_NOT_FOUND: 'NET_PLAYER_NOT_FOUND',
  NET_CLOSED: 'NET_CLOSED',
  NET_REJECTED: 'NET_REJECTED',
  NET_CONFIG: 'NET_CONFIG',
  NET_UNEXPECTED_MESSAGE: 'NET_UNEXPECTED_MESSAGE',
  // Capacity and policy rejections. Every one is returned as an `error`
  // message before a close (or as the HTTP x-net-error header when the upgrade
  // itself is refused).
  NET_CAPACITY: 'NET_CAPACITY',
  NET_JOIN_RATE_LIMIT: 'NET_JOIN_RATE_LIMIT',
  NET_CREATE_RATE_LIMIT: 'NET_CREATE_RATE_LIMIT',
  NET_ROOM_IDLE: 'NET_ROOM_IDLE',
  NET_ROOM_EXPIRED: 'NET_ROOM_EXPIRED',
  NET_MESSAGE_TOO_LARGE: 'NET_MESSAGE_TOO_LARGE',
  NET_BINARY_UNSUPPORTED: 'NET_BINARY_UNSUPPORTED',
  NET_ORIGIN_REJECTED: 'NET_ORIGIN_REJECTED',
  NET_SHUTDOWN: 'NET_SHUTDOWN'
});

export class NetError extends Error {
  constructor(code, message, detail = null) {
    super(message || code);
    this.name = 'NetError';
    this.code = code;
    this.detail = detail;
  }
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, detail: this.detail };
  }
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isInteger(value) {
  return Number.isInteger(value);
}

export function validName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 24 &&
    !/[\u0000-\u001f\u007f]/.test(name);
}

export function validSelector(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value);
}

export function validRoomCode(code) {
  if (typeof code !== 'string' || code.length !== ROOM_CODE_LENGTH) return false;
  for (const character of code) if (!ROOM_CODE_ALPHABET.includes(character)) return false;
  return true;
}

/**
 * Room codes are case-insensitive at the API boundary: the alphabet is upper
 * case and the unambiguous characters exclude I/O/0/1. This only changes case
 * and surrounding whitespace; it never substitutes a look-alike character.
 */
export function normalizeRoomCode(code) {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

export function validCapacity(maxPlayers) {
  return isInteger(maxPlayers) && maxPlayers >= MIN_ROOM_CAPACITY && maxPlayers <= HARD_MAX_PLAYERS;
}

export function validChannel(channel) {
  return channel === 'input' || channel === 'state';
}

export function quantizeNumber(value, digits = 6) {
  if (!Number.isFinite(value)) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'non-finite number');
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Validate the E1-shaped snapshot. `state` is not mutated. */
export function checkState(state) {
  if (!isObject(state)) return 'state must be an object';
  if (!isInteger(state.tick) || state.tick < 0) return 'state.tick must be a non-negative integer';
  if (!Array.isArray(state.position) || state.position.length !== 3) return 'state.position must be [x,y,z]';
  if (!state.position.every(isFiniteNumber)) return 'state.position must be finite numbers';
  if (!Array.isArray(state.quaternion) || state.quaternion.length !== 4) return 'state.quaternion must be [x,y,z,w]';
  if (!state.quaternion.every(isFiniteNumber)) return 'state.quaternion must be finite numbers';
  const norm = Math.sqrt(state.quaternion.reduce((sum, component) => sum + component * component, 0));
  if (!(norm > 0) || Math.abs(norm - 1) > 1e-3) return 'state.quaternion must be unit length (got ' + norm + ')';
  if (!isFiniteNumber(state.speed)) return 'state.speed must be a finite number';
  return null;
}

export function validState(state) {
  return checkState(state) === null;
}

/** Return a fresh quantized, canonical-order snapshot. Throws NetError on bad input. */
export function quantizeState(state) {
  const problem = checkState(state);
  if (problem) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid state: ' + problem);
  return {
    tick: state.tick,
    position: state.position.map((value) => quantizeNumber(value)),
    quaternion: state.quaternion.map((value) => quantizeNumber(value)),
    speed: quantizeNumber(state.speed)
  };
}

export function checkInput(input) {
  if (!isObject(input)) return 'input must be an object';
  const fields = ['throttle', 'brake', 'steer', 'handbrake'];
  for (const field of fields) {
    if (!isFiniteNumber(input[field])) return 'input.' + field + ' must be a finite number';
    if (input[field] < -1 || input[field] > 1) return 'input.' + field + ' must be in [-1, 1]';
  }
  return null;
}

export function validInput(input) {
  return checkInput(input) === null;
}

export function quantizeInput(input) {
  const problem = checkInput(input);
  if (problem) throw new NetError(ERROR_CODES.NET_PROTOCOL, 'invalid input: ' + problem);
  return {
    throttle: quantizeNumber(input.throttle, 4),
    brake: quantizeNumber(input.brake, 4),
    steer: quantizeNumber(input.steer, 4),
    handbrake: quantizeNumber(input.handbrake, 4)
  };
}

export function validSeq(seq) {
  return isInteger(seq) && seq >= 1 && seq <= Number.MAX_SAFE_INTEGER;
}

export function validTick(tick) {
  return isInteger(tick) && tick >= 0 && tick <= 100_000_000;
}

/** Client error event payload for a server error message. */
export function errorFromMessage(message) {
  const code = Object.values(ERROR_CODES).includes(message.code) ? message.code : ERROR_CODES.NET_REJECTED;
  return new NetError(code, message.message || code, message.detail ?? null);
}
