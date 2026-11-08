// Wire contract for the net-room coordinator probe.
//
// This is an original project protocol layered *above* the existing
// `probes/net-mvp/` room protocol. It does not replace the net-mvp data plane
// (input/state/ack/resync/final) and it is not a retail Blur protocol. The
// room coordinator owns roles, joining/leaving, capacity, the version
// handshake, the host-election policy and the bounded host-state handover.
//
// Every rejection is a typed RoomError. Nothing is silently clamped, defaulted
// into a live room, or guessed.

import { isObject, isInteger } from '../net-mvp/protocol.mjs';

export const ROOM_SCHEMA = 'blur.net-room/1';
export const HANDOVER_SCHEMA = 'blur.net-room.handover/1';
export const SNAPSHOT_SCHEMA = 'blur.net-room.snapshot/1';
export const CONTINUITY_SCHEMA = 'blur.net-room.continuity/1';
export const ROOM_PROTOCOL_VERSION = 1;
export const ROOM_PROTOCOL_MIN = 1;
export const ROOM_PROTOCOL_MAX = 1;

export const ROLES = Object.freeze(['host', 'guest', 'spectator']);
export const RACER_ROLES = Object.freeze(['host', 'guest']);
export const RACE_STATES = Object.freeze(['idle', 'queued', 'racing', 'finished', 'dnf', 'retired']);
export const PHASES = Object.freeze(['lobby', 'running', 'finished', 'closed']);
export const LATE_JOIN_POLICIES = Object.freeze(['spectate', 'queue']);

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 20;
export const MAX_SPECTATORS = 32;
export const DEFAULT_MAX_SPECTATORS = 8;
export const MIN_RACERS = 2;
export const TICK_HZ = 60;

// Host loss policy. The room service sees the socket close immediately and
// pauses the race; the host then has HOST_GRACE_MS to resume before a
// deterministic election runs. A peer that cannot reach the room service at all
// may elect a fallback host after PEER_ELECTION_TIMEOUT_MS; that claim is only
// official once the room service ratifies it.
export const HOST_GRACE_MS = 5_000;
export const HOST_SILENCE_MS = 1_500;
export const PEER_ELECTION_TIMEOUT_MS = 8_000;
export const RESUME_WINDOW_MS = 30_000;

// The host mirrors the rules ledger to the room service at most once per
// interval. Migration hands the last accepted checkpoint to the new host. The
// checkpoint is bounded and stale checkpoints are refused, not extrapolated.
export const CHECKPOINT_INTERVAL_MS = 1_000;
export const MAX_CHECKPOINT_AGE_MS = 3_000;
export const MAX_REWIND_TICKS = 120; // 2 s at 60 Hz
export const MAX_CHECKPOINT_BYTES = 32 * 1024;
export const MAX_HANDOVER_BYTES = 48 * 1024;
export const MAX_SNAPSHOT_BYTES = 64 * 1024;

export const MAX_NAME_LENGTH = 24;
export const MAX_REASON_LENGTH = 200;
export const MAX_RESULTS = 32;

export const ERROR_CODES = Object.freeze({
  NET_PROTOCOL: 'NET_PROTOCOL',
  NET_VERSION: 'NET_VERSION',
  NET_CONTENT_MISMATCH: 'NET_CONTENT_MISMATCH',
  NET_RULES_MISMATCH: 'NET_RULES_MISMATCH',
  NET_FEATURE_MISMATCH: 'NET_FEATURE_MISMATCH',
  NET_ROOM_NOT_FOUND: 'NET_ROOM_NOT_FOUND',
  NET_ROOM_FULL: 'NET_ROOM_FULL',
  NET_ROOM_CLOSED: 'NET_ROOM_CLOSED',
  NET_ROOM_STARTED: 'NET_ROOM_STARTED',
  NET_NOT_HOST: 'NET_NOT_HOST',
  NET_NOT_ALLOWED: 'NET_NOT_ALLOWED',
  NET_ROLE: 'NET_ROLE',
  NET_PHASE: 'NET_PHASE',
  NET_NOT_READY: 'NET_NOT_READY',
  NET_NOT_ENOUGH_PLAYERS: 'NET_NOT_ENOUGH_PLAYERS',
  NET_RESUME_UNKNOWN: 'NET_RESUME_UNKNOWN',
  NET_RESUME_IN_USE: 'NET_RESUME_IN_USE',
  NET_NOT_IN_ROOM: 'NET_NOT_IN_ROOM',
  NET_PLAYER_NOT_FOUND: 'NET_PLAYER_NOT_FOUND',
  NET_ALREADY_IN_ROOM: 'NET_ALREADY_IN_ROOM',
  NET_CAPACITY: 'NET_CAPACITY',
  NET_CHECKPOINT_INVALID: 'NET_CHECKPOINT_INVALID',
  NET_CHECKPOINT_STALE: 'NET_CHECKPOINT_STALE',
  NET_HANDOVER_INVALID: 'NET_HANDOVER_INVALID',
  NET_LEDGER_DIVERGED: 'NET_LEDGER_DIVERGED',
  NET_HOST_UNRESOLVED: 'NET_HOST_UNRESOLVED',
  NET_KICKED: 'NET_KICKED',
  NET_SNAPSHOT_TOO_LARGE: 'NET_SNAPSHOT_TOO_LARGE',
  NET_NOT_CONNECTED: 'NET_NOT_CONNECTED',
  NET_TIMEOUT: 'NET_TIMEOUT',
  NET_CONFIG: 'NET_CONFIG',
  NET_UNEXPECTED_MESSAGE: 'NET_UNEXPECTED_MESSAGE'
});

export class RoomError extends Error {
  constructor(code, message, detail = null) {
    super(message || code);
    this.name = 'RoomError';
    this.code = code;
    this.detail = detail;
  }
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, detail: this.detail };
  }
}

export function validName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= MAX_NAME_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(name);
}

export function validCar(car) {
  return typeof car === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(car);
}

export function validRoomCode(code) {
  return typeof code === 'string' && /^[A-Z2-9]{5}$/.test(code) &&
    !/[IO01]/.test(code);
}

export function validHash(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function validTick(tick) {
  return isInteger(tick) && tick >= 0 && tick <= 100_000_000;
}

export function validReason(reason) {
  return reason === undefined || reason === null ||
    (typeof reason === 'string' && reason.length <= MAX_REASON_LENGTH && !/[\u0000-\u001f\u007f]/.test(reason));
}

export function validRole(role) {
  return ROLES.includes(role);
}

export function validPhase(phase) {
  return PHASES.includes(phase);
}

export function validCapacity(maxPlayers) {
  return isInteger(maxPlayers) && maxPlayers >= MIN_PLAYERS && maxPlayers <= MAX_PLAYERS;
}

export function validSpectatorCapacity(maxSpectators) {
  return isInteger(maxSpectators) && maxSpectators >= 0 && maxSpectators <= MAX_SPECTATORS;
}

/** Validate the E1-shaped snapshot without inventing fields. */
export function checkState(state) {
  if (!isObject(state)) return 'state must be an object';
  if (!validTick(state.tick)) return 'state.tick must be a non-negative integer';
  if (!Array.isArray(state.position) || state.position.length !== 3 ||
      !state.position.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return 'state.position must be [x,y,z] finite numbers';
  }
  if (!Array.isArray(state.quaternion) || state.quaternion.length !== 4 ||
      !state.quaternion.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return 'state.quaternion must be [x,y,z,w] finite numbers';
  }
  const norm = Math.sqrt(state.quaternion.reduce((sum, value) => sum + value * value, 0));
  if (!(norm > 0) || Math.abs(norm - 1) > 1e-3) return 'state.quaternion must be unit length';
  if (typeof state.speed !== 'number' || !Number.isFinite(state.speed)) return 'state.speed must be finite';
  return null;
}

/** A compatibility block. Two sides are compatible only on exact content. */
export function checkCompatBlock(compat) {
  if (!isObject(compat)) return 'compat must be an object';
  if (compat.schema !== ROOM_SCHEMA) return 'compat.schema must be ' + ROOM_SCHEMA;
  if (!isInteger(compat.protocolVersion) || compat.protocolVersion < ROOM_PROTOCOL_MIN ||
      compat.protocolVersion > ROOM_PROTOCOL_MAX) {
    return 'compat.protocolVersion must be in ' + ROOM_PROTOCOL_MIN + '..' + ROOM_PROTOCOL_MAX;
  }
  if (typeof compat.buildId !== 'string' || compat.buildId.length === 0 || compat.buildId.length > 64) {
    return 'compat.buildId must be 1..64 characters';
  }
  if (!validHash(compat.contentHash)) return 'compat.contentHash must be sha256:<64 hex>';
  if (!validHash(compat.rulesHash)) return 'compat.rulesHash must be sha256:<64 hex>';
  if (compat.requiredFeatures !== undefined) {
    if (!Array.isArray(compat.requiredFeatures) ||
        !compat.requiredFeatures.every((flag) => typeof flag === 'string' && /^[a-z0-9-]{1,32}$/.test(flag))) {
      return 'compat.requiredFeatures must be an array of feature slugs';
    }
  }
  return null;
}

/**
 * Compare a joining client's compat block against the room's block.
 * Returns { ok:true } or { ok:false, code, field, expected, got, missing? }.
 * Content and rules hashes are exact: a mismatch is refused, never downgraded.
 */
export function compareCompat(roomCompat, clientCompat) {
  const roomProblem = checkCompatBlock(roomCompat);
  if (roomProblem) {
    return { ok: false, code: ERROR_CODES.NET_CONFIG, field: 'room', expected: null, got: roomProblem };
  }
  if (!isObject(clientCompat)) {
    return { ok: false, code: ERROR_CODES.NET_PROTOCOL, field: 'compat', expected: 'object', got: typeof clientCompat };
  }
  if (clientCompat.schema !== roomCompat.schema) {
    return {
      ok: false, code: ERROR_CODES.NET_VERSION, field: 'schema',
      expected: roomCompat.schema, got: clientCompat.schema ?? null
    };
  }
  if (!isInteger(clientCompat.protocolVersion) ||
      clientCompat.protocolVersion < ROOM_PROTOCOL_MIN ||
      clientCompat.protocolVersion > ROOM_PROTOCOL_MAX ||
      clientCompat.protocolVersion !== roomCompat.protocolVersion) {
    return {
      ok: false, code: ERROR_CODES.NET_VERSION, field: 'protocolVersion',
      expected: roomCompat.protocolVersion, got: clientCompat.protocolVersion ?? null
    };
  }
  if (clientCompat.buildId !== roomCompat.buildId) {
    return {
      ok: false, code: ERROR_CODES.NET_VERSION, field: 'buildId',
      expected: roomCompat.buildId, got: clientCompat.buildId ?? null
    };
  }
  if (clientCompat.contentHash !== roomCompat.contentHash) {
    return {
      ok: false, code: ERROR_CODES.NET_CONTENT_MISMATCH, field: 'contentHash',
      expected: roomCompat.contentHash, got: clientCompat.contentHash ?? null
    };
  }
  if (clientCompat.rulesHash !== roomCompat.rulesHash) {
    return {
      ok: false, code: ERROR_CODES.NET_RULES_MISMATCH, field: 'rulesHash',
      expected: roomCompat.rulesHash, got: clientCompat.rulesHash ?? null
    };
  }
  const required = roomCompat.requiredFeatures ?? [];
  const offered = new Set(Array.isArray(clientCompat.features) ? clientCompat.features : []);
  const missing = required.filter((flag) => !offered.has(flag));
  if (missing.length > 0) {
    return {
      ok: false, code: ERROR_CODES.NET_FEATURE_MISMATCH, field: 'features',
      expected: required, got: [...offered].sort(), missing
    };
  }
  return { ok: true };
}

/** UTF-8 byte length without Node-only APIs. */
export function utf8Bytes(text) {
  return new TextEncoder().encode(String(text)).length;
}

export function messageBytes(message) {
  return utf8Bytes(JSON.stringify(message));
}

export function asObject(value) {
  return isObject(value) ? value : null;
}

export function requireInteger(value, field, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!isInteger(value) || value < min || value > max) {
    throw new RoomError(ERROR_CODES.NET_PROTOCOL, field + ' must be an integer in ' + min + '..' + max, {
      field, value
    });
  }
  return value;
}

export { isObject, isInteger };
