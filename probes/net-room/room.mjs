// Room coordinator: roles, joins/leaves, capacity, version handshake, host
// election/migration, bounded state handover and late-join snapshots.
//
// This module is intentionally transport-free. `RoomCoordinator.handle()` takes
// one client message and returns an array of outbound envelopes; the caller (a
// real room service or the deterministic scenario harness in this probe) routes
// them. `PeerRoom` is the client-side replica used to test deterministic
// election and split-brain reconciliation.
//
// Design rule: the room service is the only host arbiter. Peer election is a
// fallback for a partition and is official only after `host.claim` is ratified.
// Migration never invents state: a missing or stale checkpoint is a restart,
// not a guess.

import { canonicalJson, sha256Hex } from '../net-mvp/hash.mjs';
import {
  CONTINUITY_SCHEMA,
  DEFAULT_MAX_SPECTATORS,
  ERROR_CODES,
  HANDOVER_SCHEMA,
  HOST_GRACE_MS,
  MAX_CHECKPOINT_AGE_MS,
  MAX_CHECKPOINT_BYTES,
  MAX_HANDOVER_BYTES,
  MAX_PLAYERS,
  MAX_RESULTS,
  MAX_REWIND_TICKS,
  MAX_SNAPSHOT_BYTES,
  MAX_SPECTATORS,
  MIN_PLAYERS,
  MIN_RACERS,
  RESUME_WINDOW_MS,
  ROOM_PROTOCOL_VERSION,
  ROOM_SCHEMA,
  RoomError,
  SNAPSHOT_SCHEMA,
  TICK_HZ,
  checkCompatBlock,
  checkState,
  compareCompat,
  isInteger,
  isObject,
  messageBytes,
  validCapacity,
  validCar,
  validHash,
  validName,
  validReason,
  validRole,
  validRoomCode,
  validSpectatorCapacity,
  validTick
} from './protocol.mjs';

function shortHash(value, length = 16) {
  return sha256Hex(String(value)).slice(0, length);
}

function at(clock, now) {
  return Number.isFinite(now) ? now : clock();
}

function assert(condition, code, message, detail = null) {
  if (!condition) throw new RoomError(code, message, detail);
}

/** Rank used by every election. Lower wins. Never uses wall-clock time. */
export function rankOf(entry) {
  return {
    seat: Number.isInteger(entry.seat) ? entry.seat : Number.MAX_SAFE_INTEGER,
    joinedSeq: Number.isInteger(entry.joinedSeq) ? entry.joinedSeq : Number.MAX_SAFE_INTEGER,
    playerId: String(entry.playerId ?? entry.id ?? '')
  };
}

export function compareRank(a, b) {
  if (a.seat !== b.seat) return a.seat - b.seat;
  if (a.joinedSeq !== b.joinedSeq) return a.joinedSeq - b.joinedSeq;
  return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
}

/**
 * Deterministic host election. Eligible = connected, non-spectator, not retired,
 * handover-capable. Sorted by (seat, joinedSeq, playerId).
 */
export function electHost(entries) {
  const eligible = entries
    .filter((entry) => entry && entry.connected !== false &&
      entry.role !== 'spectator' &&
      entry.retired !== true &&
      entry.handoverCapable !== false &&
      (entry.role === 'host' || entry.role === 'guest' || entry.role === 'candidate'))
    .map((entry) => ({ entry, rank: rankOf(entry) }))
    .sort((a, b) => compareRank(a.rank, b.rank));
  return eligible.length ? eligible[0].entry : null;
}

/** Stable digest of a rules ledger (sorted by seat then id). */
export function ledgerDigest(rows) {
  const canonical = [...rows]
    .map((row) => ({
      playerId: row.playerId,
      seat: row.seat,
      revision: row.revision ?? 0,
      checkpoint: row.checkpoint ?? 0,
      lap: row.lap ?? 0,
      finishTick: row.finishTick ?? null,
      finishHash: row.finishHash ?? null,
      dnf: row.dnf === true,
      retired: row.retired === true
    }))
    .sort((a, b) => (a.seat - b.seat) || (a.playerId < b.playerId ? -1 : 1));
  return 'sha256:' + sha256Hex(canonicalJson(canonical));
}

function rowProgress(row) {
  return [row.checkpoint ?? 0, row.lap ?? 0, row.finishTick === null || row.finishTick === undefined ? -1 : row.finishTick];
}

function compareLedgerRow(a, b) {
  const revA = a.revision ?? 0;
  const revB = b.revision ?? 0;
  if (revA === revB) {
    const same = a.checkpoint === b.checkpoint && a.lap === b.lap &&
      (a.finishTick ?? null) === (b.finishTick ?? null) &&
      (a.finishHash ?? null) === (b.finishHash ?? null) &&
      (a.dnf === true) === (b.dnf === true) &&
      (a.retired === true) === (b.retired === true);
    return same ? 0 : 'diverged';
  }
  const older = revA < revB ? a : b;
  const newer = revA < revB ? b : a;
  if ((newer.finishTick ?? null) !== null && (older.finishTick ?? null) !== null &&
      newer.finishTick !== older.finishTick) return 'diverged';
  if ((newer.finishHash ?? null) !== null && (older.finishHash ?? null) !== null &&
      newer.finishHash !== older.finishHash) return 'diverged';
  if (older.dnf === true && newer.dnf !== true) return 'diverged';
  const olderFinish = older.finishTick ?? Number.MAX_SAFE_INTEGER;
  const newerFinish = newer.finishTick ?? Number.MAX_SAFE_INTEGER;
  if (older.checkpoint > newer.checkpoint || older.lap > newer.lap || olderFinish < newerFinish) {
    return 'diverged';
  }
  return revA < revB ? -1 : 1;
}

/**
 * Compare two ledgers for migration reconciliation.
 * Returns { relation:'a-before-b'|'b-before-a'|'equal'|'diverged', conflicts[] }.
 */
export function compareLedgers(a, b) {
  const mapA = new Map(a.map((row) => [row.playerId, row]));
  const mapB = new Map(b.map((row) => [row.playerId, row]));
  const ids = new Set([...mapA.keys(), ...mapB.keys()]);
  let aLater = false;
  let bLater = false;
  const conflicts = [];
  for (const id of [...ids].sort()) {
    const rowA = mapA.get(id);
    const rowB = mapB.get(id);
    if (!rowA || !rowB) {
      const present = rowA ?? rowB;
      const missingSide = rowA ? 'b' : 'a';
      if ((present.revision ?? 0) > 0) {
        if (missingSide === 'a') aLater = true;
        else bLater = true;
      }
      continue;
    }
    const outcome = compareLedgerRow(rowA, rowB);
    if (outcome === 'diverged') {
      conflicts.push({ playerId: id, a: rowA.revision ?? 0, b: rowB.revision ?? 0, reason: 'row-diverged' });
      continue;
    }
    if (outcome < 0) bLater = true;
    else if (outcome > 0) aLater = true;
  }
  if (conflicts.length > 0) return { relation: 'diverged', conflicts };
  if (aLater && bLater) return { relation: 'diverged', conflicts: [{ reason: 'interleaved-progress' }] };
  if (aLater) return { relation: 'a-before-b', conflicts: [] };
  if (bLater) return { relation: 'b-before-a', conflicts: [] };
  return { relation: 'equal', conflicts: [] };
}

/**
 * Decide whether a migration can continue the race or must restart.
 * The basis is recorded so the UI and the report can state it.
 */
export function evaluateContinuity({
  checkpoint,
  now,
  newHostTick,
  phase,
  aiCount = 0,
  projectilesDropped = 0,
  maxAgeMs = MAX_CHECKPOINT_AGE_MS,
  maxRewindTicks = MAX_REWIND_TICKS
}) {
  const continuity = {
    schema: CONTINUITY_SCHEMA,
    transfers: {
      raceClock: false,
      positions: false,
      rulesLedger: false,
      powerupInventory: false,
      projectiles: false,
      results: false,
      ai: false
    },
    dropped: [],
    rewindTicks: 0,
    restartRequired: true,
    reason: null,
    basis: []
  };
  if (phase === 'finished') {
    continuity.transfers.results = true;
    continuity.transfers.rulesLedger = true;
    continuity.restartRequired = false;
    continuity.reason = 'results-phase';
    continuity.basis.push('race already finished; only the result ledger is needed');
    if (aiCount > 0) continuity.dropped.push('aiDriverState');
    return continuity;
  }
  if (!checkpoint) {
    continuity.reason = 'no-checkpoint';
    continuity.basis.push('the host never mirrored a rules checkpoint; there is no state to hand over');
    if (aiCount > 0) continuity.dropped.push('aiDriverState');
    if (projectilesDropped > 0) continuity.dropped.push('activeProjectiles');
    return continuity;
  }
  const age = now - checkpoint.producedAt;
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
    continuity.reason = 'checkpoint-stale';
    continuity.basis.push('last checkpoint age ' + age + ' ms exceeds ' + maxAgeMs + ' ms');
    continuity.dropped.push('pendingRaceProgress');
    if (aiCount > 0) continuity.dropped.push('aiDriverState');
    return continuity;
  }
  const rewindTicks = Math.max(0, newHostTick - checkpoint.tick);
  if (rewindTicks > maxRewindTicks) {
    continuity.reason = 'rewind-exceeds-limit';
    continuity.rewindTicks = rewindTicks;
    continuity.basis.push('new host local tick ' + newHostTick + ' is ' + rewindTicks +
      ' ticks ahead of the checkpoint, above the ' + maxRewindTicks + ' tick limit');
    return continuity;
  }
  continuity.transfers.raceClock = true;
  continuity.transfers.positions = true;
  continuity.transfers.rulesLedger = true;
  continuity.transfers.powerupInventory = true;
  continuity.transfers.results = true;
  continuity.rewindTicks = rewindTicks;
  continuity.restartRequired = false;
  continuity.reason = 'checkpoint-accepted';
  continuity.basis.push('checkpoint tick ' + checkpoint.tick + ' accepted, ' +
    age + ' ms old, rewind ' + rewindTicks + ' ticks');
  if (aiCount > 0) {
    continuity.dropped.push('aiDriverState');
    continuity.basis.push('host-local AI wasm worlds are not serialisable; AI is frozen and marked DNF');
  }
  if (projectilesDropped > 0) {
    continuity.dropped.push('activeProjectiles');
    continuity.basis.push(projectilesDropped + ' in-flight projectiles are transient and are removed, not recreated');
  }
  return continuity;
}

/** Validate a handover produced by another host. Throws RoomError. */
export function validateHandover(handover, { toHostId = null } = {}) {
  assert(isObject(handover), ERROR_CODES.NET_HANDOVER_INVALID, 'handover must be an object');
  assert(handover.schema === HANDOVER_SCHEMA, ERROR_CODES.NET_HANDOVER_INVALID, 'handover schema mismatch', {
    expected: HANDOVER_SCHEMA, got: handover.schema ?? null
  });
  assert(typeof handover.roomCode === 'string' && validRoomCode(handover.roomCode),
    ERROR_CODES.NET_HANDOVER_INVALID, 'handover roomCode is invalid');
  assert(typeof handover.raceId === 'string' && handover.raceId.length > 0,
    ERROR_CODES.NET_HANDOVER_INVALID, 'handover raceId is required');
  assert(isInteger(handover.epoch) && handover.epoch >= 1,
    ERROR_CODES.NET_HANDOVER_INVALID, 'handover epoch must be >= 1');
  if (toHostId !== null) {
    assert(handover.toHostId === toHostId, ERROR_CODES.NET_HANDOVER_INVALID, 'handover addressed to another host', {
      expected: toHostId, got: handover.toHostId ?? null
    });
  }
  assert(isObject(handover.race), ERROR_CODES.NET_HANDOVER_INVALID, 'handover.race is required');
  assert(validTick(handover.race.tick), ERROR_CODES.NET_HANDOVER_INVALID, 'handover.race.tick is invalid');
  assert(validTick(handover.race.startTick), ERROR_CODES.NET_HANDOVER_INVALID, 'handover.race.startTick is invalid');
  assert(typeof handover.race.seed === 'string' && handover.race.seed.length > 0,
    ERROR_CODES.NET_HANDOVER_INVALID, 'handover.race.seed is required');
  assert(handover.race.tickHz === TICK_HZ, ERROR_CODES.NET_HANDOVER_INVALID, 'handover tickHz must be ' + TICK_HZ);
  assert(isObject(handover.ledger) && Array.isArray(handover.ledger.players),
    ERROR_CODES.NET_HANDOVER_INVALID, 'handover.ledger.players is required');
  assert(handover.ledger.players.length <= MAX_PLAYERS,
    ERROR_CODES.NET_HANDOVER_INVALID, 'handover ledger exceeds the player cap');
  for (const row of handover.ledger.players) {
    assert(isObject(row) && typeof row.playerId === 'string' &&
      isInteger(row.seat) && isInteger(row.checkpoint) && isInteger(row.lap) &&
      isInteger(row.revision), ERROR_CODES.NET_HANDOVER_INVALID, 'handover ledger row is invalid', { row });
    assert(row.finishTick === null || row.finishTick === undefined || validTick(row.finishTick),
      ERROR_CODES.NET_HANDOVER_INVALID, 'handover finishTick is invalid', { row });
    assert(row.finishHash === null || row.finishHash === undefined || validHash(row.finishHash),
      ERROR_CODES.NET_HANDOVER_INVALID, 'handover finishHash is invalid', { row });
  }
  assert(isObject(handover.continuity), ERROR_CODES.NET_HANDOVER_INVALID, 'handover.continuity is required');
  assert(typeof handover.continuity.restartRequired === 'boolean',
    ERROR_CODES.NET_HANDOVER_INVALID, 'handover.continuity.restartRequired must be boolean');
  const bytes = messageBytes(handover);
  assert(bytes <= MAX_HANDOVER_BYTES, ERROR_CODES.NET_HANDOVER_INVALID, 'handover exceeds the byte cap', {
    bytes, cap: MAX_HANDOVER_BYTES
  });
  return { bytes };
}

/** Deterministic request-free error envelope. */
function errorEvent(to, code, message, detail = null, requestId = null) {
  return {
    to,
    message: { type: 'error', code, message, detail, requestId, fatal: false }
  };
}

export class RoomCoordinator {
  constructor({
    roomCode = 'ABCDE',
    compat,
    serverCompat = null,
    maxPlayers = 8,
    maxSpectators = DEFAULT_MAX_SPECTATORS,
    lateJoinPolicy = 'spectate',
    createdAt = 0,
    minRacers = MIN_RACERS,
    clock = () => 0,
    resumeWindowMs = RESUME_WINDOW_MS,
    hostGraceMs = HOST_GRACE_MS,
    checkpointIntervalMs = 1_000,
    maxCheckpointAgeMs = MAX_CHECKPOINT_AGE_MS,
    maxRewindTicks = MAX_REWIND_TICKS,
    ai = []
  } = {}) {
    assert(validRoomCode(roomCode), ERROR_CODES.NET_CONFIG, 'roomCode must be 5 unambiguous characters');
    assert(checkCompatBlock(compat) === null, ERROR_CODES.NET_CONFIG, 'invalid room compat block', {
      problem: checkCompatBlock(compat)
    });
    assert(validCapacity(maxPlayers), ERROR_CODES.NET_CONFIG, 'maxPlayers out of range');
    assert(validSpectatorCapacity(maxSpectators), ERROR_CODES.NET_CONFIG, 'maxSpectators out of range');
    assert(['spectate', 'queue'].includes(lateJoinPolicy), ERROR_CODES.NET_CONFIG, 'invalid lateJoinPolicy');
    assert(isInteger(minRacers) && minRacers >= 1 && minRacers <= maxPlayers,
      ERROR_CODES.NET_CONFIG, 'minRacers out of range');

    this.clock = clock;
    this.resumeWindowMs = resumeWindowMs;
    this.hostGraceMs = hostGraceMs;
    this.checkpointIntervalMs = checkpointIntervalMs;
    this.maxCheckpointAgeMs = maxCheckpointAgeMs;
    this.maxRewindTicks = maxRewindTicks;
    this.minRacers = minRacers;

    this.room = {
      code: roomCode,
      createdAt,
      lastActivityAt: createdAt,
      phase: 'lobby',
      hostId: null,
      epoch: 0,
      raceId: null,
      seed: null,
      startTick: null,
      startedAt: null,
      tickHz: TICK_HZ,
      paused: false,
      pauseReason: null,
      restartRequired: false,
      compat: structuredClone(compat),
      serverCompat: structuredClone(serverCompat ?? compat),
      maxPlayers,
      maxSpectators,
      lateJoinPolicy,
      pendingCapacity: null,
      players: new Map(),
      spectators: new Map(),
      connections: new Map(),
      ledger: new Map(),
      lastStates: new Map(),
      results: null,
      resultsHash: null,
      resultsHistory: [],
      checkpoint: null,
      checkpointSeq: 0,
      ai: ai.map((entry) => ({ ...entry })),
      projectiles: [],
      startCount: 0,
      joinSeq: 0,
      hostLostAt: null,
      hostReconnectDeadline: null,
      closedAt: null,
      closeReason: null,
      kicked: []
    };

    this.stats = {
      messagesIn: 0,
      messagesOut: 0,
      bytesIn: 0,
      bytesOut: 0,
      byType: {},
      joins: 0,
      lateJoins: 0,
      resumes: 0,
      leaves: 0,
      kicks: 0,
      disconnects: 0,
      migrations: 0,
      restarts: 0,
      checkpoints: 0,
      rejections: 0,
      versionRejections: 0,
      capacityRejections: 0
    };
  }

  // ------------------------------------------------------------- accounting
  _countOut(message) {
    const bytes = messageBytes(message);
    this.stats.messagesOut++;
    this.stats.bytesOut += bytes;
    const entry = this.stats.byType[message.type] ?? { count: 0, bytes: 0 };
    entry.count++;
    entry.bytes += bytes;
    this.stats.byType[message.type] = entry;
    return bytes;
  }

  _send(events, to, message) {
    const bytes = this._countOut(message);
    events.push({ to, message, bytes });
    return events;
  }

  _reply(events, to, message, requestId = null) {
    if (requestId !== null) message = { ...message, requestId };
    return this._send(events, to, message);
  }

  _broadcast(events, message, { except = null, includeSpectators = true, onlyIds = null } = {}) {
    const room = this.room;
    const targets = [];
    for (const player of room.players.values()) {
      if (!player.connected) continue;
      if (player.playerId === except) continue;
      if (onlyIds && !onlyIds.includes(player.playerId)) continue;
      targets.push(player.playerId);
    }
    if (includeSpectators) {
      for (const spectator of room.spectators.values()) {
        if (!spectator.connected) continue;
        if (spectator.playerId === except) continue;
        if (onlyIds && !onlyIds.includes(spectator.playerId)) continue;
        targets.push(spectator.playerId);
      }
    }
    targets.sort();
    for (const target of targets) this._send(events, target, message);
    return events;
  }

  _touch() {
    this.room.lastActivityAt = this.clock();
  }

  _connection(playerId) {
    const connection = this.room.connections.get(playerId);
    assert(connection, ERROR_CODES.NET_NOT_CONNECTED, 'connection is not established', { playerId });
    assert(connection.welcomed, ERROR_CODES.NET_NOT_CONNECTED, 'hello has not completed', { playerId });
    return connection;
  }

  _member(playerId) {
    return this.room.players.get(playerId) ?? this.room.spectators.get(playerId) ?? null;
  }

  _requireMember(playerId) {
    const member = this._member(playerId);
    assert(member, ERROR_CODES.NET_NOT_IN_ROOM, 'player is not in the room', { playerId });
    return member;
  }

  _requireHost(playerId) {
    const member = this._requireMember(playerId);
    const room = this.room;
    assert(room.hostId === playerId, ERROR_CODES.NET_NOT_HOST, 'only the host can do this', {
      hostId: room.hostId, playerId
    });
    assert(member.role === 'host', ERROR_CODES.NET_NOT_HOST, 'sender is not the host role');
    return member;
  }

  _requirePhase(...phases) {
    assert(phases.includes(this.room.phase), ERROR_CODES.NET_PHASE, 'message is not valid in phase ' + this.room.phase, {
      phase: this.room.phase, allowed: phases
    });
  }

  _allocateSeat() {
    const used = new Set([...this.room.players.values()].map((player) => player.seat));
    for (let seat = 1; seat <= this.room.maxPlayers; seat++) {
      if (!used.has(seat)) return seat;
    }
    return null;
  }

  _newPlayer({ playerId, name, role, car, seat, handoverCapable = true, lateJoiner = false }) {
    const room = this.room;
    return {
      playerId,
      name: name.trim(),
      seat,
      role,
      car,
      ready: false,
      connected: true,
      resumeToken: 'rt_' + shortHash(playerId + '|' + room.code + '|' + room.joinSeq, 24),
      joinedSeq: ++room.joinSeq,
      joinedAt: this.clock(),
      lateJoiner,
      race: 'idle',
      resumedCount: 0,
      handoverCapable: handoverCapable !== false,
      lastTick: 0,
      disconnectedAt: null,
      resumeDeadline: null,
      follow: null
    };
  }

  _newSpectator({ playerId, name, lateJoiner = false, follow = null }) {
    const room = this.room;
    return {
      playerId,
      name: name.trim(),
      role: 'spectator',
      connected: true,
      resumeToken: 'rt_' + shortHash(playerId + '|' + room.code + '|' + room.joinSeq, 24),
      joinedSeq: ++room.joinSeq,
      joinedAt: this.clock(),
      lateJoiner,
      resumedCount: 0,
      handoverCapable: false,
      follow,
      lastTick: 0,
      disconnectedAt: null,
      resumeDeadline: null
    };
  }

  _ledgerRow(player) {
    return {
      playerId: player.playerId,
      seat: player.seat,
      revision: 0,
      checkpoint: 0,
      lap: 0,
      finishTick: null,
      finishHash: null,
      dnf: false,
      retired: false,
      powerups: [],
      seqHigh: { input: 0, state: 0 },
      ai: false
    };
  }

  _ensureLedger(player) {
    const room = this.room;
    if (!room.ledger.has(player.playerId)) room.ledger.set(player.playerId, this._ledgerRow(player));
    return room.ledger.get(player.playerId);
  }

  _playerView(player) {
    return {
      id: player.playerId,
      seat: player.seat,
      name: player.name,
      role: player.role,
      car: player.car,
      ready: player.ready === true,
      connected: player.connected === true,
      host: this.room.hostId === player.playerId,
      race: player.race,
      lateJoiner: player.lateJoiner === true,
      resumedCount: player.resumedCount,
      lastTick: player.lastTick
    };
  }

  _spectatorView(spectator) {
    return {
      id: spectator.playerId,
      name: spectator.name,
      connected: spectator.connected === true,
      lateJoiner: spectator.lateJoiner === true,
      follow: spectator.follow,
      resumedCount: spectator.resumedCount
    };
  }

  roomView() {
    const room = this.room;
    const players = [...room.players.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((player) => this._playerView(player));
    const spectators = [...room.spectators.values()]
      .sort((a, b) => a.joinedSeq - b.joinedSeq)
      .map((spectator) => this._spectatorView(spectator));
    return {
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      epoch: room.epoch,
      raceId: room.raceId,
      seed: room.seed,
      startTick: room.startTick,
      tickHz: room.tickHz,
      paused: room.paused,
      pauseReason: room.pauseReason,
      restartRequired: room.restartRequired,
      maxPlayers: room.maxPlayers,
      maxSpectators: room.maxSpectators,
      lateJoinPolicy: room.lateJoinPolicy,
      pendingCapacity: room.pendingCapacity,
      compat: room.compat,
      playerCount: players.length,
      spectatorCount: spectators.length,
      players,
      spectators,
      hostReconnecting: room.hostLostAt !== null && room.hostId !== null &&
        room.players.get(room.hostId)?.connected === false,
      serverTime: this.clock()
    };
  }

  youView(member) {
    const isPlayer = this.room.players.has(member.playerId);
    return {
      id: member.playerId,
      name: member.name,
      role: member.role,
      seat: isPlayer ? member.seat : null,
      race: isPlayer ? member.race : 'spectating',
      host: this.room.hostId === member.playerId,
      lateJoiner: member.lateJoiner === true,
      resumeToken: member.resumeToken,
      follow: isPlayer ? null : member.follow
    };
  }

  _ledgerRows() {
    return [...this.room.ledger.values()]
      .map((row) => ({
        playerId: row.playerId,
        seat: row.seat,
        revision: row.revision,
        checkpoint: row.checkpoint,
        lap: row.lap,
        finishTick: row.finishTick,
        finishHash: row.finishHash,
        dnf: row.dnf,
        retired: row.retired,
        ai: row.ai === true,
        powerups: [...(row.powerups ?? [])]
      }))
      .sort((a, b) => (a.seat - b.seat) || (a.playerId < b.playerId ? -1 : 1));
  }

  _lastStates() {
    return [...this.room.lastStates.entries()]
      .map(([playerId, state]) => ({ playerId, ...state }))
      .sort((a, b) => (a.playerId < b.playerId ? -1 : 1));
  }

  _snapshot(member) {
    const room = this.room;
    const snapshot = {
      schema: SNAPSHOT_SCHEMA,
      roomCode: room.code,
      phase: room.phase,
      hostId: room.hostId,
      epoch: room.epoch,
      compat: room.compat,
      maxPlayers: room.maxPlayers,
      maxSpectators: room.maxSpectators,
      lateJoinPolicy: room.lateJoinPolicy,
      you: this.youView(member),
      race: room.phase === 'lobby'
        ? null
        : {
            raceId: room.raceId,
            tick: room.checkpoint?.tick ?? 0,
            startTick: room.startTick,
            seed: room.seed,
            tickHz: room.tickHz,
            paused: room.paused,
            restartRequired: room.restartRequired
          },
      players: [...room.players.values()].sort((a, b) => a.seat - b.seat).map((player) => this._playerView(player)),
      spectators: [...room.spectators.values()].sort((a, b) => a.joinedSeq - b.joinedSeq)
        .map((spectator) => this._spectatorView(spectator)),
      ledger: this._ledgerRows(),
      lastStates: this._lastStates(),
      results: room.results,
      ai: room.ai.map((entry) => ({ ...entry }))
    };
    const bytes = messageBytes(snapshot);
    assert(bytes <= MAX_SNAPSHOT_BYTES, ERROR_CODES.NET_SNAPSHOT_TOO_LARGE, 'late-join snapshot exceeds the byte cap', {
      bytes, cap: MAX_SNAPSHOT_BYTES
    });
    return { snapshot, bytes };
  }

  // ------------------------------------------------------------- connection
  _hello(playerId, message, now) {
    const room = this.room;
    const existing = room.connections.get(playerId);
    if (existing?.welcomed) {
      throw new RoomError(ERROR_CODES.NET_ALREADY_IN_ROOM, 'hello already completed');
    }
    const compat = message.compat;
    const comparison = compareCompat(room.serverCompat, compat);
    if (!comparison.ok) {
      this.stats.rejections++;
      this.stats.versionRejections++;
      const events = [];
      this._send(events, playerId, {
        type: 'error',
        code: comparison.code,
        message: 'client compatibility rejected: ' + comparison.field,
        detail: {
          field: comparison.field,
          expected: comparison.expected,
          got: comparison.got,
          missing: comparison.missing ?? null,
          roomCode: room.code
        },
        requestId: message.requestId ?? null,
        fatal: true
      });
      return events;
    }
    room.connections.set(playerId, {
      playerId,
      compat: structuredClone(compat),
      features: Array.isArray(compat.features) ? [...compat.features] : [],
      welcomed: true,
      connectedAt: now
    });
    const events = [];
    this._send(events, playerId, {
      type: 'welcome',
      schema: ROOM_SCHEMA,
      protocolVersion: ROOM_PROTOCOL_VERSION,
      buildId: room.serverCompat.buildId,
      contentHash: room.serverCompat.contentHash,
      rulesHash: room.serverCompat.rulesHash,
      roomCode: room.code,
      serverTime: now,
      limits: {
        minPlayers: MIN_PLAYERS,
        maxPlayers: MAX_PLAYERS,
        defaultMaxPlayers: 8,
        maxSpectators: MAX_SPECTATORS,
        resumeWindowMs: this.resumeWindowMs,
        hostGraceMs: this.hostGraceMs,
        checkpointIntervalMs: this.checkpointIntervalMs,
        maxRewindTicks: this.maxRewindTicks,
        tickHz: TICK_HZ
      }
    });
    return events;
  }

  _resume(member, { now, requestId }) {
    const room = this.room;
    assert(member.resumeToken, ERROR_CODES.NET_RESUME_UNKNOWN, 'this member can no longer resume');
    assert(member.connected !== true, ERROR_CODES.NET_RESUME_IN_USE, 'player is already connected', {
      playerId: member.playerId
    });
    assert(now <= member.resumeDeadline, ERROR_CODES.NET_RESUME_UNKNOWN, 'resume window has expired', {
      playerId: member.playerId, deadline: member.resumeDeadline, now
    });
    member.connected = true;
    member.disconnectedAt = null;
    member.resumeDeadline = null;
    member.resumedCount += 1;
    this.stats.resumes++;
    const events = [];

    const wasHost = room.hostId === member.playerId;
    if (!this.room.players.has(member.playerId) && wasHost) {
      // Unreachable: the host is always a player.
      throw new RoomError(ERROR_CODES.NET_PROTOCOL, 'host resume invariant failed');
    }
    if (wasHost) {
      room.hostLostAt = null;
      room.hostReconnectDeadline = null;
      room.paused = false;
      room.pauseReason = null;
    } else if (member.role === 'host') {
      // The host lost the role during a migration while this member was away.
      member.role = 'guest';
    }

    const response = {
      type: 'room.joined',
      room: this.roomView(),
      you: this.youView(member),
      resumed: true,
      serverTime: now
    };
    if (room.phase !== 'lobby' || member.role === 'spectator') {
      const { snapshot, bytes } = this._snapshot(member);
      response.snapshot = snapshot;
      this.stats.byType.snapshot = this.stats.byType.snapshot ?? { count: 0, bytes: 0 };
      this.stats.byType.snapshot.count++;
      this.stats.byType.snapshot.bytes += bytes;
    }
    this._reply(events, member.playerId, response, requestId);
    this._broadcast(events, {
      type: 'player.resumed',
      playerId: member.playerId,
      seat: room.players.get(member.playerId)?.seat ?? null,
      role: member.role,
      resumedCount: member.resumedCount,
      serverTime: now
    }, { except: member.playerId });
    if (wasHost) {
      this._broadcast(events, {
        type: 'race.resumed',
        reason: 'host-reconnected',
        tick: room.checkpoint?.tick ?? 0,
        epoch: room.epoch,
        serverTime: now
      });
    }
    this._broadcast(events, { type: 'room.state', room: this.roomView(), serverTime: now });
    return events;
  }

  _join(playerId, message, now) {
    const room = this.room;
    const connection = this._connection(playerId);
    const existing = this._member(playerId);
    if (existing) throw new RoomError(ERROR_CODES.NET_ALREADY_IN_ROOM, 'already in the room');

    const token = message.resumeToken;
    if (token !== undefined && token !== null) {
      const member = [...room.players.values(), ...room.spectators.values()]
        .find((entry) => entry.resumeToken === token);
      assert(member, ERROR_CODES.NET_RESUME_UNKNOWN, 'resume token is unknown or expired');
      return this._resume(member, { now, requestId: message.requestId ?? null });
    }

    assert(validName(message.name), ERROR_CODES.NET_PROTOCOL, 'invalid player name');
    const requestedRole = message.role ?? 'guest';
    assert(requestedRole === 'guest' || requestedRole === 'spectator', ERROR_CODES.NET_PROTOCOL,
      'join role must be guest or spectator', { role: requestedRole });
    const car = message.car ?? 'corvette-zr1-stock';
    assert(validCar(car), ERROR_CODES.NET_PROTOCOL, 'invalid car selector', { car });
    assert(room.phase !== 'closed', ERROR_CODES.NET_ROOM_CLOSED, 'room is closed');

    let role = requestedRole;
    let lateJoiner = false;
    let queued = false;

    if (requestedRole === 'spectator') {
      this._assertSpectatorCapacity();
    } else if (room.phase === 'lobby') {
      if (room.players.size >= room.maxPlayers) {
        this._assertSpectatorCapacity();
        role = 'spectator';
      }
    } else if (room.phase === 'running') {
      lateJoiner = true;
      if (room.lateJoinPolicy === 'queue' && room.players.size < room.maxPlayers) {
        queued = true;
      } else {
        role = 'spectator';
        this._assertSpectatorCapacity();
      }
    } else if (room.phase === 'finished') {
      lateJoiner = true;
      if (room.players.size < room.maxPlayers) queued = true;
      else {
        role = 'spectator';
        this._assertSpectatorCapacity();
      }
    }

    const events = [];
    let member;
    if (role === 'spectator') {
      member = this._newSpectator({ playerId, name: message.name, lateJoiner, follow: message.follow ?? null });
      room.spectators.set(playerId, member);
    } else {
      const seat = this._allocateSeat();
      assert(seat !== null, ERROR_CODES.NET_ROOM_FULL, 'no free seat', { maxPlayers: room.maxPlayers });
      member = this._newPlayer({
        playerId,
        name: message.name,
        role: 'guest',
        car,
        seat,
        handoverCapable: !(connection.features ?? []).includes('no-handover'),
        lateJoiner
      });
      member.race = queued ? 'queued' : 'idle';
      room.players.set(playerId, member);
      this._ensureLedger(member);
      if (room.hostId === null) {
        member.role = 'host';
        room.hostId = playerId;
      }
    }

    this.stats.joins++;
    if (lateJoiner) this.stats.lateJoins++;

    const response = {
      type: 'room.joined',
      room: this.roomView(),
      you: this.youView(member),
      resumed: false,
      lateJoin: lateJoiner,
      queuedForNextRace: queued,
      serverTime: now
    };
    if (lateJoiner) {
      const { snapshot, bytes } = this._snapshot(member);
      response.snapshot = snapshot;
      response.snapshotBytes = bytes;
      this.stats.byType.snapshot = this.stats.byType.snapshot ?? { count: 0, bytes: 0 };
      this.stats.byType.snapshot.count++;
      this.stats.byType.snapshot.bytes += bytes;
    }
    this._reply(events, playerId, response, message.requestId ?? null);
    this._broadcast(events, {
      type: 'player.joined',
      playerId,
      seat: member.seat ?? null,
      role: member.role,
      lateJoin: lateJoiner,
      serverTime: now
    }, { except: playerId });
    this._broadcast(events, { type: 'room.state', room: this.roomView(), serverTime: now });
    return events;
  }

  _assertSpectatorCapacity() {
    const room = this.room;
    assert(room.spectators.size < room.maxSpectators, ERROR_CODES.NET_ROOM_FULL, 'spectator capacity reached', {
      scope: 'spectators', limit: room.maxSpectators, occupied: room.spectators.size
    });
  }

  // --------------------------------------------------------------- departure
  _removeMember(playerId, { now, reason, by = null, kick = false, expire = false }, events = []) {
    const room = this.room;
    const member = this._member(playerId);
    if (!member) return events;
    const wasHost = room.hostId === playerId;
    const wasPlayer = room.players.has(playerId);

    if (wasPlayer) {
      const player = room.players.get(playerId);
      if (room.phase === 'running' && player.race === 'racing') {
        const row = this._ensureLedger(player);
        row.retired = true;
        row.dnf = true;
        row.revision += 1;
        row.retiredReason = reason;
        player.race = 'retired';
      } else if (room.phase === 'lobby') {
        room.ledger.delete(playerId);
        room.lastStates.delete(playerId);
      }
      room.players.delete(playerId);
    } else {
      room.spectators.delete(playerId);
    }
    if (kick) {
      member.resumeToken = null;
      this.stats.kicks++;
      room.kicked.push({ playerId, by, reason, at: now });
      this._send(events, playerId, {
        type: 'room.kicked',
        playerId,
        by,
        reason,
        rejoinAllowed: false,
        serverTime: now
      });
      this._broadcast(events, {
        type: 'player.kicked',
        playerId,
        by,
        reason,
        serverTime: now
      }, { except: playerId });
    } else {
      member.resumeToken = null;
      this._send(events, playerId, {
        type: 'room.left',
        playerId,
        reason,
        serverTime: now
      });
      this._broadcast(events, {
        type: 'player.left',
        playerId,
        seat: wasPlayer ? room.ledger.get(playerId)?.seat ?? null : null,
        reason,
        expired: expire === true,
        serverTime: now
      }, { except: playerId });
    }
    this.stats.leaves++;

    if (wasHost && room.hostId === playerId) {
      if (room.phase === 'running') {
        room.paused = true;
        room.pauseReason = reason;
      }
      this._migrate(events, { now, reason: kick ? 'host-kicked' : 'host-left' });
    }
    if (room.players.size === 0 && room.spectators.size === 0) {
      room.phase = 'closed';
      room.closedAt = now;
      room.closeReason = 'empty';
      this._send(events, playerId, { type: 'room.closed', reason: 'empty', serverTime: now });
    } else {
      this._broadcast(events, { type: 'room.state', room: this.roomView(), serverTime: now });
    }
    return events;
  }

  // ---------------------------------------------------------------- election
  _eligibleForElection(excludeId = null) {
    return [...this.room.players.values()]
      .filter((player) => player.playerId !== excludeId)
      .map((player) => ({ ...player }));
  }

  _migrate(events, { now, reason, targetHostId = null, claim = null }) {
    const room = this.room;
    if (room.phase === 'closed') return events;
    const previousHostId = room.hostId;

    let newHost = null;
    if (targetHostId !== null) {
      newHost = room.players.get(targetHostId) ?? null;
      assert(newHost && newHost.connected && newHost.role !== 'spectator',
        ERROR_CODES.NET_NOT_ALLOWED, 'migration target is not an eligible connected player', {
          targetHostId
        });
    } else {
      newHost = electHost(this._eligibleForElection(previousHostId));
    }

    if (!newHost) {
      room.epoch += 1;
      room.hostId = null;
      room.paused = room.phase === 'running';
      room.pauseReason = 'host-unresolved';
      this._broadcast(events, {
        type: 'host.changed',
        room: this.roomView(),
        hostId: null,
        previousHostId,
        epoch: room.epoch,
        reason,
        hostless: true,
        continuity: null,
        restartRequired: room.phase === 'running',
        serverTime: now
      });
      return events;
    }

    room.epoch += 1;
    const checkpoint = room.checkpoint;
    const newHostTick = newHost.lastTick ?? checkpoint?.tick ?? 0;
    const continuity = evaluateContinuity({
      checkpoint,
      now,
      newHostTick,
      phase: room.phase,
      aiCount: room.ai.length,
      projectilesDropped: room.projectiles.length,
      maxAgeMs: this.maxCheckpointAgeMs,
      maxRewindTicks: this.maxRewindTicks
    });

    // Never claim continuity from a checkpoint that cannot be transferred.
    const handover = checkpoint && !continuity.restartRequired
      ? this._buildHandover({
          epoch: room.epoch,
          fromHostId: previousHostId,
          toHostId: newHost.playerId,
          reason,
          now,
          continuity
        })
      : null;

    const previousHost = previousHostId ? room.players.get(previousHostId) : null;
    if (previousHost) previousHost.role = 'guest';
    newHost.role = 'host';
    room.hostId = newHost.playerId;
    room.hostLostAt = null;
    room.hostReconnectDeadline = null;
    room.paused = room.phase === 'running';
    room.pauseReason = handover ? 'migration' : 'migration-restart';
    room.restartRequired = continuity.restartRequired && room.phase === 'running';
    this.stats.migrations++;

    this._broadcast(events, {
      type: 'host.changed',
      room: this.roomView(),
      hostId: newHost.playerId,
      previousHostId,
      epoch: room.epoch,
      reason,
      claim: claim ? { playerId: claim.playerId, epoch: claim.epoch } : null,
      continuity: {
        restartRequired: continuity.restartRequired,
        rewindTicks: continuity.rewindTicks,
        reason: continuity.reason,
        dropped: continuity.dropped
      },
      restartRequired: continuity.restartRequired,
      resumeAtTick: continuity.restartRequired ? null : checkpoint?.tick ?? 0,
      serverTime: now
    });
    if (handover) {
      const bytes = this._countOut(handover);
      this.stats.byType['host.handover'] = this.stats.byType['host.handover'] ?? { count: 0, bytes: 0 };
      // _countOut already accounted the message; keep the envelope for routing.
      events.push({ to: newHost.playerId, message: handover, bytes });
    } else if (room.phase === 'finished' && room.results) {
      // A finished race has no live state to hand over, but the new host must
      // still be able to show and rematch the recorded result.
      this._send(events, newHost.playerId, {
        type: 'room.finished',
        room: this.roomView(),
        results: room.results,
        hash: room.resultsHash,
        serverTime: now
      });
    }
    return events;
  }

  _buildHandover({ epoch, fromHostId, toHostId, reason, now, continuity }) {
    const room = this.room;
    const checkpoint = room.checkpoint;
    const handover = {
      schema: HANDOVER_SCHEMA,
      roomCode: room.code,
      raceId: room.raceId,
      epoch,
      fromHostId,
      toHostId,
      reason,
      phase: room.phase,
      race: {
        tick: checkpoint.tick,
        startTick: room.startTick,
        seed: room.seed,
        tickHz: room.tickHz,
        startedAt: room.startedAt,
        paused: true,
        resumeAtTick: checkpoint.tick
      },
      ledger: { players: this._ledgerRows() },
      powerups: {
        inventory: [...room.ledger.values()]
          .map((row) => ({ playerId: row.playerId, items: [...(row.powerups ?? [])] }))
          .sort((a, b) => (a.playerId < b.playerId ? -1 : 1)),
        projectilesDropped: room.projectiles.length
      },
      ai: room.ai.map((entry) => ({
        ...entry,
        frozen: true,
        dnf: true,
        reason: 'host-migration-ai-state-lost'
      })),
      lastStates: this._lastStates(),
      results: room.results,
      resultsHash: room.resultsHash,
      seqHigh: [...room.ledger.values()]
        .map((row) => ({ playerId: row.playerId, input: row.seqHigh.input, state: row.seqHigh.state }))
        .sort((a, b) => (a.playerId < b.playerId ? -1 : 1)),
      producedAt: now,
      sourceCheckpoint: {
        seq: checkpoint.seq,
        producedAt: checkpoint.producedAt,
        tick: checkpoint.tick
      },
      continuity
    };
    const bytes = messageBytes(handover);
    assert(bytes <= MAX_HANDOVER_BYTES, ERROR_CODES.NET_HANDOVER_INVALID, 'handover exceeds the byte cap', {
      bytes, cap: MAX_HANDOVER_BYTES
    });
    return handover;
  }

  // ------------------------------------------------------------------ public
  /**
   * Handle one client message. Returns outbound envelopes
   * `[{ to, message, bytes }]`. A protocol failure becomes a typed `error`
   * envelope; it is never a silent drop.
   */
  handle(playerId, message, now = undefined) {
    const room = this.room;
    const timestamp = at(this.clock, now);
    this.stats.messagesIn++;
    const text = JSON.stringify(message);
    this.stats.bytesIn += messageBytes(message);
    void text;
    room.lastActivityAt = timestamp;

    try {
      assert(isObject(message) && typeof message.type === 'string', ERROR_CODES.NET_PROTOCOL,
        'message.type is required');
      if (message.type === 'hello') return this._hello(playerId, message, timestamp);
      this._connection(playerId);
      switch (message.type) {
        case 'ping':
          return this._reply([], playerId, {
            type: 'pong', id: message.id ?? null, t: message.t ?? null, serverTime: timestamp
          }, message.requestId ?? null);
        case 'room.join':
          return this._join(playerId, message, timestamp);
        case 'room.leave': {
          const member = this._requireMember(playerId);
          return this._removeMember(member.playerId, {
            now: timestamp, reason: message.reason ?? 'leave', by: playerId
          });
        }
        case 'room.ready': {
          const member = this._requireMember(playerId);
          assert(room.players.has(playerId), ERROR_CODES.NET_ROLE, 'spectators cannot ready');
          this._requirePhase('lobby');
          assert(typeof message.ready === 'boolean', ERROR_CODES.NET_PROTOCOL, 'ready must be boolean');
          member.ready = message.ready;
          const events = [];
          this._reply(events, playerId, {
            type: 'ok', action: 'room.ready', ready: member.ready, serverTime: timestamp
          }, message.requestId ?? null);
          this._broadcast(events, { type: 'room.state', room: this.roomView(), serverTime: timestamp });
          return events;
        }
        case 'room.select': {
          const member = this._requireMember(playerId);
          this._requirePhase('lobby');
          assert(validCar(message.car), ERROR_CODES.NET_PROTOCOL, 'invalid car selector');
          assert(room.players.has(playerId), ERROR_CODES.NET_ROLE, 'spectators cannot select a car');
          member.car = message.car;
          const events = [];
          this._reply(events, playerId, {
            type: 'ok', action: 'room.select', car: member.car, serverTime: timestamp
          }, message.requestId ?? null);
          this._broadcast(events, { type: 'room.state', room: this.roomView(), serverTime: timestamp });
          return events;
        }
        case 'room.spectate': {
          const member = this._requireMember(playerId);
          assert(!room.players.has(playerId), ERROR_CODES.NET_ROLE, 'seated players cannot set a spectator follow target');
          const follow = message.follow ?? null;
          assert(follow === null || room.players.has(follow), ERROR_CODES.NET_PLAYER_NOT_FOUND,
            'follow target is not a seated player', { follow });
          member.follow = follow;
          const events = [];
          this._reply(events, playerId, {
            type: 'ok', action: 'room.spectate', follow, serverTime: timestamp
          }, message.requestId ?? null);
          this._broadcast(events, { type: 'room.state', room: this.roomView(), serverTime: timestamp });
          return events;
        }
        case 'room.start': {
          this._requireHost(playerId);
          this._requirePhase('lobby');
          const connectedPlayers = [...room.players.values()].filter((player) => player.connected);
          const solo = message.solo === true;
          const required = solo ? 1 : this.minRacers;
          assert(connectedPlayers.length >= required, ERROR_CODES.NET_NOT_ENOUGH_PLAYERS,
            'need at least ' + required + ' connected players', {
              connected: connectedPlayers.length, required
            });
          const notReady = connectedPlayers.filter((player) => !player.ready);
          assert(notReady.length === 0, ERROR_CODES.NET_NOT_READY, 'players are not ready', {
            players: notReady.map((player) => player.playerId)
          });
          assert(room.players.size <= room.maxPlayers, ERROR_CODES.NET_CAPACITY, 'room exceeds capacity');
          const seed = typeof message.seed === 'string' ? message.seed : shortHash(room.code + '|' + timestamp, 16);
          assert(/^[A-Za-z0-9_.:-]{1,64}$/.test(seed), ERROR_CODES.NET_PROTOCOL, 'invalid seed');
          room.startCount += 1;
          room.raceId = 'race_' + shortHash(room.code + '|' + seed + '|' + room.startCount + '|' + room.epoch, 16);
          room.seed = seed;
          room.startTick = 1;
          room.startedAt = timestamp;
          room.phase = 'running';
          room.paused = false;
          room.pauseReason = null;
          room.restartRequired = false;
          room.checkpoint = null;
          room.checkpointSeq = 0;
          room.results = null;
          room.resultsHash = null;
          for (const player of room.players.values()) {
            player.race = 'racing';
            player.ready = false;
            const row = this._ensureLedger(player);
            row.revision += 1;
            row.checkpoint = 0;
            row.lap = 0;
            row.finishTick = null;
            row.finishHash = null;
            row.dnf = false;
            row.retired = false;
            row.seqHigh = { input: 0, state: 0 };
          }
          for (const spectator of room.spectators.values()) spectator.follow = spectator.follow ?? null;
          const events = [];
          this._broadcast(events, {
            type: 'room.started',
            room: this.roomView(),
            raceId: room.raceId,
            seed: room.seed,
            startTick: room.startTick,
            tickHz: room.tickHz,
            epoch: room.epoch,
            serverTime: timestamp
          });
          return events;
        }
        case 'host.checkpoint': {
          return this._handleCheckpoint(playerId, message, timestamp);
        }
        case 'host.finished': {
          return this._handleFinished(playerId, message, timestamp);
        }
        case 'host.pause': {
          this._requireHost(playerId);
          this._requirePhase('running');
          assert(validTick(message.tick), ERROR_CODES.NET_PROTOCOL, 'pause tick is invalid');
          assert(validReason(message.reason), ERROR_CODES.NET_PROTOCOL, 'pause reason is invalid');
          room.paused = true;
          room.pauseReason = message.reason ?? 'host-paused';
          const events = [];
          this._broadcast(events, {
            type: 'race.paused',
            reason: room.pauseReason,
            tick: message.tick,
            epoch: room.epoch,
            serverTime: timestamp
          });
          return events;
        }
        case 'host.resume': {
          this._requireHost(playerId);
          this._requirePhase('running');
          assert(validTick(message.tick), ERROR_CODES.NET_PROTOCOL, 'resume tick is invalid');
          assert(room.restartRequired !== true, ERROR_CODES.NET_PHASE, 'a restart is required before resuming');
          room.paused = false;
          room.pauseReason = null;
          const events = [];
          this._broadcast(events, {
            type: 'race.resumed',
            reason: message.reason ?? 'host-resumed',
            tick: message.tick,
            epoch: room.epoch,
            serverTime: timestamp
          });
          return events;
        }
        case 'host.claim': {
          return this._handleClaim(playerId, message, timestamp);
        }
        case 'room.kick': {
          this._requireHost(playerId);
          assert(message.targetId !== playerId, ERROR_CODES.NET_NOT_ALLOWED, 'the host cannot kick itself');
          const target = this._member(message.targetId);
          assert(target, ERROR_CODES.NET_PLAYER_NOT_FOUND, 'kick target is not in the room');
          assert(validReason(message.reason), ERROR_CODES.NET_PROTOCOL, 'kick reason is invalid');
          return this._removeMember(message.targetId, {
            now: timestamp,
            reason: message.reason ?? 'kicked',
            by: playerId,
            kick: true
          });
        }
        case 'room.transferHost': {
          this._requireHost(playerId);
          const target = room.players.get(message.targetId);
          assert(target && target.connected, ERROR_CODES.NET_PLAYER_NOT_FOUND, 'transfer target is not a connected player');
          assert(message.targetId !== playerId, ERROR_CODES.NET_NOT_ALLOWED, 'already host');
          return this._migrate([], {
            now: timestamp,
            reason: 'transfer',
            targetHostId: message.targetId
          });
        }
        case 'room.capacity': {
          this._requireHost(playerId);
          return this._handleCapacity(playerId, message, timestamp);
        }
        case 'room.role': {
          this._requireHost(playerId);
          return this._handleRole(playerId, message, timestamp);
        }
        case 'room.rematch': {
          this._requireHost(playerId);
          this._requirePhase('finished');
          return this._resetToLobby({ now: timestamp, reason: 'rematch' });
        }
        case 'room.restart': {
          this._requireHost(playerId);
          this._requirePhase('running', 'finished');
          this.stats.restarts++;
          return this._resetToLobby({ now: timestamp, reason: message.reason ?? 'restart' });
        }
        case 'room.state': {
          this._requireMember(playerId);
          return this._reply([], playerId, {
            type: 'room.state', room: this.roomView(), serverTime: timestamp
          }, message.requestId ?? null);
        }
        default:
          throw new RoomError(ERROR_CODES.NET_UNEXPECTED_MESSAGE, 'unknown message type: ' + message.type);
      }
    } catch (error) {
      this.stats.rejections++;
      if (error instanceof RoomError) {
        return [errorEvent(playerId, error.code, error.message, error.detail, message?.requestId ?? null)];
      }
      return [errorEvent(playerId, ERROR_CODES.NET_PROTOCOL, 'handler error: ' + String(error?.message || error),
        null, message?.requestId ?? null)];
    }
  }

  _handleCheckpoint(playerId, message, now) {
    const room = this.room;
    this._requireHost(playerId);
    this._requirePhase('running', 'finished');
    const checkpoint = message.checkpoint;
    assert(isObject(checkpoint), ERROR_CODES.NET_CHECKPOINT_INVALID, 'checkpoint must be an object');
    assert(checkpoint.raceId === room.raceId, ERROR_CODES.NET_CHECKPOINT_STALE,
      'checkpoint belongs to another race', { expected: room.raceId, got: checkpoint.raceId ?? null });
    assert(checkpoint.epoch === room.epoch, ERROR_CODES.NET_CHECKPOINT_STALE,
      'checkpoint epoch is stale', { expected: room.epoch, got: checkpoint.epoch ?? null });
    assert(validTick(checkpoint.tick), ERROR_CODES.NET_CHECKPOINT_INVALID, 'checkpoint tick is invalid');
    if (room.checkpoint && checkpoint.tick < room.checkpoint.tick) {
      throw new RoomError(ERROR_CODES.NET_CHECKPOINT_STALE, 'checkpoint tick went backwards', {
        previous: room.checkpoint.tick, got: checkpoint.tick
      });
    }
    assert(Array.isArray(checkpoint.players), ERROR_CODES.NET_CHECKPOINT_INVALID, 'checkpoint.players must be an array');
    assert(checkpoint.players.length <= MAX_PLAYERS, ERROR_CODES.NET_CHECKPOINT_INVALID,
      'checkpoint exceeds the player cap');
    const bytes = messageBytes(checkpoint);
    assert(bytes <= MAX_CHECKPOINT_BYTES, ERROR_CODES.NET_CHECKPOINT_INVALID, 'checkpoint exceeds the byte cap', {
      bytes, cap: MAX_CHECKPOINT_BYTES
    });
    for (const row of checkpoint.players) {
      assert(isObject(row) && typeof row.playerId === 'string' && room.ledger.has(row.playerId),
        ERROR_CODES.NET_CHECKPOINT_INVALID, 'checkpoint references an unknown player', {
          playerId: row?.playerId ?? null
        });
      assert(isInteger(row.checkpoint) && isInteger(row.lap) && isInteger(row.revision),
        ERROR_CODES.NET_CHECKPOINT_INVALID, 'checkpoint row counters are invalid', { row });
      assert(row.finishTick === null || row.finishTick === undefined || validTick(row.finishTick),
        ERROR_CODES.NET_CHECKPOINT_INVALID, 'checkpoint finishTick is invalid', { row });
      assert(row.finishHash === null || row.finishHash === undefined || validHash(row.finishHash),
        ERROR_CODES.NET_CHECKPOINT_INVALID, 'checkpoint finishHash is invalid', { row });
    }
    for (const row of checkpoint.players) {
      const target = room.ledger.get(row.playerId);
      const revision = row.revision ?? 0;
      if (revision < target.revision) {
        throw new RoomError(ERROR_CODES.NET_CHECKPOINT_STALE, 'checkpoint row revision went backwards', {
          playerId: row.playerId, previous: target.revision, got: revision
        });
      }
      target.revision = revision;
      target.checkpoint = row.checkpoint;
      target.lap = row.lap ?? 0;
      target.finishTick = row.finishTick ?? null;
      target.finishHash = row.finishHash ?? null;
      target.dnf = row.dnf === true;
      target.retired = row.retired === true;
    }
    if (Array.isArray(checkpoint.seqHigh)) {
      for (const entry of checkpoint.seqHigh) {
        const target = room.ledger.get(entry.playerId);
        if (!target) continue;
        if (isInteger(entry.input) && entry.input >= target.seqHigh.input) target.seqHigh.input = entry.input;
        if (isInteger(entry.state) && entry.state >= target.seqHigh.state) target.seqHigh.state = entry.state;
      }
    }
    room.checkpointSeq += 1;
    room.checkpoint = {
      seq: room.checkpointSeq,
      epoch: room.epoch,
      tick: checkpoint.tick,
      producedAt: now,
      payload: structuredClone(checkpoint)
    };
    this.stats.checkpoints++;
    const events = [];
    this._reply(events, playerId, {
      type: 'room.checkpoint',
      tick: checkpoint.tick,
      epoch: room.epoch,
      seq: room.checkpointSeq,
      serverTime: now
    }, message.requestId ?? null);
    return events;
  }

  _handleFinished(playerId, message, now) {
    const room = this.room;
    this._requireHost(playerId);
    this._requirePhase('running', 'finished');
    assert(Array.isArray(message.rows), ERROR_CODES.NET_PROTOCOL, 'host.finished rows must be an array');
    assert(message.rows.length <= MAX_RESULTS, ERROR_CODES.NET_PROTOCOL, 'too many result rows');
    assert(validHash(message.hash), ERROR_CODES.NET_PROTOCOL, 'result hash must be sha256:<64 hex>');
    for (const row of message.rows) {
      assert(isObject(row) && typeof row.playerId === 'string' && room.ledger.has(row.playerId),
        ERROR_CODES.NET_PROTOCOL, 'result row references an unknown player');
      assert(row.dnf === true || validTick(row.tick), ERROR_CODES.NET_PROTOCOL, 'result tick is invalid');
      assert(row.dnf === true || validHash(row.hash), ERROR_CODES.NET_PROTOCOL, 'result hash is invalid');
    }
    for (const row of message.rows) {
      const target = room.ledger.get(row.playerId);
      target.finishTick = row.dnf === true ? null : row.tick;
      target.finishHash = row.dnf === true ? null : row.hash;
      target.dnf = row.dnf === true;
      target.revision += 1;
    }
    room.results = message.rows.map((row) => ({ ...row })).sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
    room.resultsHash = message.hash;
    room.phase = 'finished';
    room.paused = false;
    room.pauseReason = null;
    const events = [];
    this._reply(events, playerId, {
      type: 'ok', action: 'host.finished', serverTime: now
    }, message.requestId ?? null);
    this._broadcast(events, {
      type: 'room.finished',
      room: this.roomView(),
      results: room.results,
      hash: room.resultsHash,
      serverTime: now
    });
    return events;
  }

  _handleClaim(playerId, message, now) {
    const room = this.room;
    const claimant = room.players.get(playerId);
    assert(claimant && claimant.connected, ERROR_CODES.NET_NOT_IN_ROOM, 'claimant is not a connected player');
    const claim = message.claim;
    assert(isObject(claim), ERROR_CODES.NET_PROTOCOL, 'claim is required');
    const election = electHost([...room.players.values()].filter((player) => player.connected));
    assert(election && election.playerId === playerId, ERROR_CODES.NET_NOT_HOST,
      'claimant is not the deterministic election winner', {
        expected: election?.playerId ?? null, got: playerId
      });
    const current = room.hostId ? room.players.get(room.hostId) : null;
    if (current && current.connected && current.playerId !== playerId) {
      throw new RoomError(ERROR_CODES.NET_NOT_ALLOWED, 'the current host is still connected');
    }
    this.stats.migrations++;
    return this._migrate([], {
      now,
      reason: 'peer-election',
      targetHostId: playerId,
      claim: { playerId, epoch: isInteger(claim.epoch) ? claim.epoch : room.epoch }
    });
  }

  _handleCapacity(playerId, message, now) {
    const room = this.room;
    const events = [];
    let queued = false;
    if (message.maxSpectators !== undefined) {
      assert(validSpectatorCapacity(message.maxSpectators), ERROR_CODES.NET_PROTOCOL,
        'maxSpectators must be 0..' + MAX_SPECTATORS);
      const connectedSpectators = [...room.spectators.values()].filter((spectator) => spectator.connected).length;
      assert(message.maxSpectators >= room.spectators.size, ERROR_CODES.NET_CAPACITY,
        'maxSpectators is below the current spectator count', {
          scope: 'spectators', occupied: room.spectators.size, connected: connectedSpectators,
          requested: message.maxSpectators
        });
      room.maxSpectators = message.maxSpectators;
    }
    if (message.maxPlayers !== undefined) {
      assert(validCapacity(message.maxPlayers), ERROR_CODES.NET_PROTOCOL,
        'maxPlayers must be ' + MIN_PLAYERS + '..' + MAX_PLAYERS);
      assert(message.maxPlayers >= room.players.size, ERROR_CODES.NET_CAPACITY,
        'maxPlayers is below the occupied seat count', {
          scope: 'players', occupied: room.players.size, requested: message.maxPlayers
        });
      if (room.phase === 'lobby') {
        room.maxPlayers = message.maxPlayers;
        room.pendingCapacity = null;
      } else {
        room.pendingCapacity = { maxPlayers: message.maxPlayers, appliesAt: 'next-lobby' };
        queued = true;
      }
    }
    this._reply(events, playerId, {
      type: 'ok', action: 'room.capacity', serverTime: now
    }, message.requestId ?? null);
    this._broadcast(events, {
      type: 'room.capacity',
      maxPlayers: room.maxPlayers,
      maxSpectators: room.maxSpectators,
      pending: room.pendingCapacity,
      queued,
      serverTime: now
    });
    this._broadcast(events, { type: 'room.state', room: this.roomView(), serverTime: now });
    return events;
  }

  _handleRole(playerId, message, now) {
    const room = this.room;
    assert(room.phase === 'lobby', ERROR_CODES.NET_PHASE, 'role changes are lobby-only');
    const target = this._member(message.targetId);
    assert(target, ERROR_CODES.NET_PLAYER_NOT_FOUND, 'role target is not in the room');
    assert(validRole(message.role), ERROR_CODES.NET_PROTOCOL, 'role must be host, guest or spectator');
    assert(message.role !== 'host', ERROR_CODES.NET_NOT_ALLOWED, 'host role is assigned by the coordinator');
    if (room.players.has(message.targetId)) {
      assert(message.role === 'spectator', ERROR_CODES.NET_ROLE, 'a seated player can only be demoted to spectator');
      const player = room.players.get(message.targetId);
      assert(player.playerId !== room.hostId, ERROR_CODES.NET_NOT_ALLOWED, 'the host cannot be demoted');
      room.players.delete(player.playerId);
      room.ledger.delete(player.playerId);
      room.lastStates.delete(player.playerId);
      player.role = 'spectator';
      player.ready = false;
      player.race = 'idle';
      room.spectators.set(player.playerId, player);
    } else {
      assert(message.role === 'guest', ERROR_CODES.NET_ROLE, 'a spectator can only be promoted to guest');
      const seat = this._allocateSeat();
      assert(seat !== null, ERROR_CODES.NET_ROOM_FULL, 'no free seat for promotion', {
        maxPlayers: room.maxPlayers
      });
      room.spectators.delete(message.targetId);
      target.role = 'guest';
      target.seat = seat;
      target.race = 'idle';
      target.lateJoiner = true;
      target.handoverCapable = true;
      room.players.set(target.playerId, target);
      this._ensureLedger(target);
    }
    const events = [];
    this._reply(events, playerId, {
      type: 'ok', action: 'room.role', targetId: message.targetId, role: message.role, serverTime: now
    }, message.requestId ?? null);
    this._send(events, message.targetId, {
      type: 'player.role', playerId: message.targetId, role: message.role, serverTime: now
    });
    this._broadcast(events, { type: 'room.state', room: this.roomView(), serverTime: now });
    return events;
  }

  _resetToLobby({ now, reason }) {
    const room = this.room;
    const previousRaceId = room.raceId;
    if (room.results) room.resultsHistory.push({ raceId: previousRaceId, results: room.results, hash: room.resultsHash });
    room.phase = 'lobby';
    room.raceId = null;
    room.seed = null;
    room.startTick = null;
    room.startedAt = null;
    room.paused = false;
    room.pauseReason = null;
    room.restartRequired = false;
    room.results = null;
    room.resultsHash = null;
    room.checkpoint = null;
    room.checkpointSeq = 0;
    room.ledger.clear();
    room.lastStates.clear();
    for (const player of room.players.values()) {
      player.race = 'idle';
      player.ready = false;
      this._ensureLedger(player);
    }
    if (room.pendingCapacity) {
      room.maxPlayers = room.pendingCapacity.maxPlayers;
      room.pendingCapacity = null;
    }
    const events = [];
    this.stats.restarts++;
    this._broadcast(events, {
      type: 'room.restarted',
      reason,
      previousRaceId,
      room: this.roomView(),
      serverTime: now
    });
    this._broadcast(events, { type: 'room.state', room: this.roomView(), serverTime: now });
    return events;
  }

  // ------------------------------------------------------- data-plane hooks
  /** Integration calls this when relaying a `state` snapshot. Bounded copy. */
  noteState(playerId, state) {
    const player = this.room.players.get(playerId);
    if (!player) return false;
    if (checkState(state) !== null) return false;
    this.room.lastStates.set(playerId, {
      tick: state.tick,
      position: [...state.position],
      quaternion: [...state.quaternion],
      speed: state.speed
    });
    if (state.tick > player.lastTick) player.lastTick = state.tick;
    return true;
  }

  /** Integration calls this when the host's power-up model changes. */
  notePowerups(playerId, items) {
    const row = this.room.ledger.get(playerId);
    if (!row) return false;
    if (!Array.isArray(items) || items.length > 16) return false;
    row.powerups = items.map((item) => String(item).slice(0, 32));
    return true;
  }

  /** Integration calls this when the host creates/removes projectiles. */
  noteProjectiles(projectiles) {
    if (!Array.isArray(projectiles) || projectiles.length > 64) return false;
    this.room.projectiles = projectiles.map((entry) => ({ ...entry }));
    return true;
  }

  /** Advance timers: host grace expiry and resume-window expiry. Deterministic. */
  tick(now = undefined) {
    const timestamp = at(this.clock, now);
    const room = this.room;
    const events = [];
    if (room.hostLostAt !== null && room.hostReconnectDeadline !== null &&
        timestamp >= room.hostReconnectDeadline) {
      const host = room.hostId ? room.players.get(room.hostId) : null;
      if (host && host.connected === false) {
        this._migrate(events, { now: timestamp, reason: 'host-timeout' });
      } else {
        room.hostLostAt = null;
        room.hostReconnectDeadline = null;
      }
    }
    for (const member of [...room.players.values(), ...room.spectators.values()]) {
      if (member.connected === false && member.resumeDeadline !== null &&
          timestamp > member.resumeDeadline) {
        this._removeMember(member.playerId, { now: timestamp, reason: 'resume-expired', expire: true }, events);
      }
    }
    return events;
  }

  /** The old host's own view; useful for scenarios and the integration. */
  snapshotFor(playerId) {
    const member = this._member(playerId);
    assert(member, ERROR_CODES.NET_NOT_IN_ROOM, 'player is not in the room');
    return this._snapshot(member);
  }

  /** Deterministic server-side election preview. */
  election() {
    return electHost([...this.room.players.values()]);
  }

  view() {
    return this.roomView();
  }

  ledgerView() {
    return this._ledgerRows();
  }
}

/**
 * Client-side replica. It follows the room service and can run the fallback
 * election when the service is unreachable. It never invents a role or a tick.
 */
export class PeerRoom {
  constructor({ playerId, compat, clock = () => 0 }) {
    this.playerId = playerId;
    this.compat = compat ? structuredClone(compat) : null;
    this.clock = clock;
    this.welcome = null;
    this.room = null;
    this.you = null;
    this.hostId = null;
    this.epoch = -1;
    this.ledger = [];
    this.race = null;
    this.results = null;
    this.restartRequired = false;
    this.continuity = null;
    this.errors = [];
    this.receivedTypes = {};
    this.hostSeenAt = 0;
    this.claim = null;
  }

  _count(type) {
    this.receivedTypes[type] = (this.receivedTypes[type] ?? 0) + 1;
  }

  receive(message, now = undefined) {
    const timestamp = now === undefined ? this.clock() : now;
    if (!isObject(message) || typeof message.type !== 'string') {
      throw new RoomError(ERROR_CODES.NET_PROTOCOL, 'peer message must be an object with type');
    }
    this._count(message.type);
    switch (message.type) {
      case 'welcome':
        this.welcome = message;
        return this;
      case 'room.joined':
        this._setRoom(message.room);
        this.you = message.you;
        if (message.snapshot) {
          this.ledger = message.snapshot.ledger ?? [];
          this.race = message.snapshot.race ?? null;
          this.results = message.snapshot.results ?? null;
          this.epoch = message.snapshot.epoch ?? this.epoch;
          this.hostId = message.snapshot.hostId ?? this.hostId;
          this.hostSeenAt = timestamp;
        }
        return this;
      case 'room.state':
        this._setRoom(message.room);
        this.hostSeenAt = timestamp;
        return this;
      case 'room.started':
        this._setRoom(message.room);
        this.race = {
          raceId: message.raceId,
          seed: message.seed,
          startTick: message.startTick,
          tickHz: message.tickHz,
          tick: message.startTick ?? 1,
          paused: false
        };
        this.results = null;
        this.restartRequired = false;
        this.hostSeenAt = timestamp;
        return this;
      case 'host.changed':
        this._setRoom(message.room);
        this.hostId = message.hostId;
        this.epoch = message.epoch;
        this.restartRequired = message.restartRequired === true;
        this.continuity = message.continuity ?? null;
        if (this.room?.paused === false) this.race = this.race ? { ...this.race, paused: false } : null;
        if (this.room?.paused === true && this.race) this.race = { ...this.race, paused: true };
        this.hostSeenAt = timestamp;
        return this;
      case 'host.handover': {
        const applied = applyHandover(this, message, { now: timestamp });
        this.continuity = applied.continuity;
        this.restartRequired = applied.restartRequired;
        this.ledger = applied.ledger;
        this.race = applied.race;
        this.epoch = message.epoch;
        this.hostId = message.toHostId;
        this.hostSeenAt = timestamp;
        return this;
      }
      case 'room.checkpoint':
        if (this.race) this.race = { ...this.race, tick: Math.max(this.race.tick ?? 0, message.tick) };
        this.hostSeenAt = timestamp;
        return this;
      case 'race.paused':
        if (this.race) this.race = { ...this.race, paused: true, tick: message.tick ?? this.race.tick };
        return this;
      case 'race.resumed':
        if (this.race) this.race = { ...this.race, paused: false, tick: message.tick ?? this.race.tick };
        this.hostSeenAt = timestamp;
        return this;
      case 'room.finished':
        this._setRoom(message.room);
        this.results = message.results;
        this.hostSeenAt = timestamp;
        return this;
      case 'room.restarted':
        this._setRoom(message.room);
        this.race = null;
        this.results = null;
        this.restartRequired = false;
        this.ledger = [];
        return this;
      case 'player.joined':
      case 'player.resumed':
      case 'player.left':
      case 'player.kicked':
      case 'player.role':
      case 'room.capacity':
      case 'room.left':
      case 'room.kicked':
      case 'room.closed':
      case 'ok':
      case 'pong':
        return this;
      case 'error':
        this.errors.push(message);
        return this;
      default:
        throw new RoomError(ERROR_CODES.NET_UNEXPECTED_MESSAGE, 'unexpected peer message: ' + message.type);
    }
  }

  _setRoom(room) {
    if (!isObject(room)) throw new RoomError(ERROR_CODES.NET_PROTOCOL, 'room payload is malformed');
    this.room = room;
    this.hostId = room.hostId;
    this.epoch = room.epoch;
    if (this.race && typeof room.paused === 'boolean') {
      this.race = { ...this.race, paused: room.paused };
    }
  }

  get role() {
    if (!this.room || !this.you) return null;
    const player = this.room.players.find((entry) => entry.id === this.playerId);
    if (player) return player.role;
    const spectator = this.room.spectators?.find((entry) => entry.id === this.playerId);
    return spectator ? 'spectator' : null;
  }

  get seat() {
    return this.room?.players.find((entry) => entry.id === this.playerId)?.seat ?? null;
  }

  get isHost() {
    return this.hostId === this.playerId;
  }

  rank() {
    const self = this.room?.players.find((entry) => entry.id === this.playerId);
    return rankOf({
      seat: self?.seat,
      joinedSeq: self ? this.room.players.indexOf(self) + 1 : Number.MAX_SAFE_INTEGER,
      playerId: this.playerId
    });
  }

  election() {
    if (!this.room) return null;
    return electHost(this.room.players.map((entry) => ({
      ...entry,
      playerId: entry.id,
      joinedSeq: this.room.players.indexOf(entry) + 1,
      handoverCapable: entry.role !== 'spectator'
    })));
  }

  buildClaim({ tick = null } = {}) {
    const election = this.election();
    if (!election) return null;
    const rank = rankOf(election);
    this.claim = {
      playerId: this.playerId,
      epoch: (this.epoch ?? -1) + 1,
      raceId: this.race?.raceId ?? null,
      tick: tick ?? this.race?.tick ?? null,
      rank,
      ledgerDigest: ledgerDigest(this.ledger),
      ledger: [...this.ledger],
      electedId: election.playerId,
      claimedAt: this.clock()
    };
    return this.claim;
  }

  hostSilentFor(now = this.clock()) {
    return now - this.hostSeenAt;
  }

  noteHostMessage(now = this.clock()) {
    this.hostSeenAt = now;
  }
}

/** Apply a validated handover to a peer replica. Never extrapolates. */
export function applyHandover(peer, handover, { now = 0 } = {}) {
  validateHandover(handover, { toHostId: peer.playerId });
  const localTick = peer.race?.tick ?? handover.race.tick;
  const rewindTicks = Math.max(0, localTick - handover.race.tick);
  const continuity = { ...handover.continuity, rewindTicks };
  if (rewindTicks > MAX_REWIND_TICKS) {
    continuity.restartRequired = true;
    continuity.reason = 'rewind-exceeds-limit';
    continuity.dropped = [...new Set([...continuity.dropped, 'pendingRaceProgress'])];
  }
  return {
    ok: true,
    restartRequired: continuity.restartRequired === true,
    rewindTicks,
    continuity,
    ledger: handover.ledger.players.map((row) => ({ ...row })),
    race: {
      raceId: handover.raceId,
      seed: handover.race.seed,
      startTick: handover.race.startTick,
      tickHz: handover.race.tickHz,
      tick: handover.race.tick,
      paused: continuity.restartRequired === true ? true : handover.race.paused === true,
      restartRequired: continuity.restartRequired === true,
      appliedAt: now
    },
    results: handover.results ?? null,
    seqHigh: handover.seqHigh ?? [],
    ai: handover.ai ?? [],
    powerups: handover.powerups ?? { inventory: [], projectilesDropped: 0 }
  };
}

/**
 * Reconcile two or more fallback host claims after a partition heals.
 * Winner: highest epoch, then lowest rank. A divergent ledger is reported and
 * forces a restart; no entries are merged.
 */
export function reconcileClaims(claims) {
  assert(Array.isArray(claims) && claims.length > 0, ERROR_CODES.NET_CONFIG, 'claims must be a non-empty array');
  const sorted = [...claims].sort((a, b) => {
    if ((b.epoch ?? -1) !== (a.epoch ?? -1)) return (b.epoch ?? -1) - (a.epoch ?? -1);
    return compareRank(a.rank ?? rankOf(a), b.rank ?? rankOf(b));
  });
  const winner = sorted[0];
  const conflicts = [];
  for (const other of sorted.slice(1)) {
    if (other.playerId === winner.playerId) continue;
    const ledgerA = Array.isArray(winner.ledger) ? winner.ledger : [];
    const ledgerB = Array.isArray(other.ledger) ? other.ledger : [];
    const hasProgress = (rows) => rows.some((row) => (row.revision ?? 0) > 0);
    if ((winner.raceId ?? null) !== (other.raceId ?? null) && (hasProgress(ledgerA) || hasProgress(ledgerB))) {
      conflicts.push({
        withPlayerId: other.playerId,
        relation: 'different-race',
        conflicts: [{ reason: 'different-race', a: winner.raceId ?? null, b: other.raceId ?? null }]
      });
      continue;
    }
    const comparison = compareLedgers(ledgerA, ledgerB);
    if (comparison.relation === 'diverged') {
      conflicts.push({
        withPlayerId: other.playerId,
        relation: comparison.relation,
        conflicts: comparison.conflicts
      });
    }
  }
  return {
    winnerPlayerId: winner.playerId,
    epoch: winner.epoch ?? null,
    raceId: winner.raceId ?? null,
    restartRequired: conflicts.length > 0,
    conflicts,
    claims: sorted
  };
}
