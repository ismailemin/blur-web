// Multiplayer session wrapper for the E1 drive slice (M1, two browsers; M4, up
// to eight humans in one room).
//
// This module is deliberately DOM-free and dependency-injected: the page passes
// the committed `NetClient` class from `/net-mvp/client.mjs`, and the Node
// verifier passes the same class from `probes/net-mvp/client.mjs`. That keeps
// the room/lobby/result logic identical in both environments and testable
// without a browser.
//
// M1/M4 scope:
//   * up to eight players, one measured 310 m River course, one car for every
//     body (car picks are lobby metadata; the host's car is the session car);
//   * the room service carries the lobby, 60 Hz inputs and 20 Hz per-player
//     state snapshots; the host runs the authoritative rules/result;
//   * the result table is a pure function of the room's finish broadcast, so
//     every client renders the same positions/times from the same bytes.

import { hashOf } from './packet-hash.js';
import { MP_MAP_IDS, resolveMap } from './map-registry.js';

export const MP_KIND = 'e1-drive.mp/1';
export const MP_SCHEMA = 'e1-drive.mp/1';
export const MP_MAP = 'river';
export const MP_LEGACY_MAP = 'usa_la_river';
export const MP_MAX_PLAYERS = 8;
export const MP_DEFAULT_ROOM_PORT = 8811;
export const MP_TICK_HZ = 60;
export const MP_INPUT_HZ = 60;
export const MP_STATE_HZ = 20;
export const MP_STATE_EVERY_TICKS = Math.round(MP_TICK_HZ / MP_STATE_HZ);
export const MP_REMOTE_DELAY_TICKS = 3;
export const MP_POSITION_THRESHOLD_METRES = 0.5;
export const MP_ANGLE_THRESHOLD_RAD = 0.25;
export const MP_BLEND_TICKS = 3;
export const MP_RESULT_KIND = 'e1-drive.mp.result';
export const MP_RESULT_VERSION = 1;
export const MP_RESULT_NOTE =
  'host-authoritative finish validation; both overlays render this table from the room finish broadcast';
export const MP_ROOM_CLOSED = 'MP_ROOM_CLOSED';

export class MpSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MpSessionError';
    this.code = code;
  }
}

/**
 * Canonical reported finish tick from the authoritative local race time.
 * A respawn rebuild resets the engine tick, so `event.tick` alone can differ
 * from the race clock by a tick; the shared table and the finish report use
 * this time-derived tick instead.
 */
export function mpFinishTick(timeSeconds, countdownTicks, tickHz = MP_TICK_HZ) {
  if (!Number.isFinite(timeSeconds) || !Number.isFinite(countdownTicks) || !(tickHz > 0)) return null;
  return Math.round(timeSeconds * tickHz) + Math.round(countdownTicks);
}

// --------------------------------------------------------------- room map record
// The room protocol already carries a `map` selector in `room.create`,
// `player.select` and the `room.started` room view. The selector is the map id
// (`river`|`amboy`|`gracia`); the typed record below is the committed hash
// agreement every client derives locally from `map-registry.js`. No new wire
// message is added: `map-ready` is reported through the existing ready flag
// after the client's own bytes match this record. A mismatch is a typed
// refusal, never a River fallback.
export const MP_MAP_MISMATCH = 'MAP_PACKAGE_MISMATCH';
export const MP_MAP_NOT_MULTIPLAYER = 'MAP_NOT_MULTIPLAYER';
export const MP_MAP_UNKNOWN = 'MAP_UNKNOWN';

export class MpMapError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'MpMapError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

/** Normalise the room map selector; the legacy River selector maps to `river`. */
export function normalizeMpMapId(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  return text === MP_LEGACY_MAP ? MP_MAP : text;
}

/** The committed multiplayer record for a map id (throws a typed error). */
export function mpMapRecord(value) {
  const id = normalizeMpMapId(value);
  if (id === null) throw new MpMapError(MP_MAP_UNKNOWN, 'room map id is missing');
  if (!MP_MAP_IDS.includes(id)) {
    throw new MpMapError(MP_MAP_UNKNOWN,
      'unknown multiplayer map ' + JSON.stringify(value) + ' (use ' + MP_MAP_IDS.join(', ') + ')');
  }
  const map = resolveMap(id);
  if (map.multiplayer !== true) {
    throw new MpMapError(MP_MAP_NOT_MULTIPLAYER, map.label + ' is not enabled for the online room');
  }
  const pins = map.mpPins;
  if (!pins) throw new MpMapError(MP_MAP_UNKNOWN, map.label + ' has no pinned multiplayer record');
  return {
    id: map.id,
    label: map.label,
    level: map.level,
    packageHash: pins.packageHash ?? null,
    layoutHash: pins.layoutHash ?? null,
    physicsHash: pins.physicsHash ?? null,
    packageFileSha256: pins.packageFileSha256 ?? null,
    layoutFileSha256: pins.layoutFileSha256 ?? null,
    physicsFileSha256: pins.physicsFileSha256 ?? null,
    packageBytes: pins.packageBytes ?? null,
    layoutBytes: pins.layoutBytes ?? null,
    physicsBytes: pins.physicsBytes ?? null,
    source: 'map-registry'
  };
}

/**
 * Compare the record carried by the room (registry-derived) with the record the
 * page measured from the bytes it actually loaded. Only the three content
 * hashes and the id are agreement fields; byte counts/timing are diagnostics.
 */
export function compareMpMapRecords(expected, actual) {
  const fields = ['id', 'packageHash', 'layoutHash', 'physicsHash'];
  const mismatches = [];
  for (const field of fields) {
    if (!expected || !actual || expected[field] !== actual[field]) {
      mismatches.push({
        field,
        expected: expected?.[field] ?? null,
        actual: actual?.[field] ?? null
      });
    }
  }
  return {
    ok: mismatches.length === 0,
    code: mismatches.length === 0 ? null : MP_MAP_MISMATCH,
    mismatches
  };
}

/** Throw the typed refusal the lobby/start gate uses when the hashes disagree. */
export function assertMpMapAgreement(expected, actual, context = 'map package') {
  const check = compareMpMapRecords(expected, actual);
  if (!check.ok) {
    const detail = check.mismatches.map((row) =>
      row.field + ' expected ' + row.expected + ', loaded ' + row.actual).join('; ');
    throw new MpMapError(MP_MAP_MISMATCH, context + ' mismatch: ' + detail, check);
  }
  return check;
}

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const round6 = (value) => Math.round(value * 1e6) / 1e6;

/** Default room-service origin for a page served from the game server. */
export function defaultRoomUrl(locationLike = typeof location !== 'undefined' ? location : null) {
  const secure = locationLike?.protocol === 'https:';
  const host = locationLike?.hostname || '127.0.0.1';
  return (secure ? 'wss:' : 'ws:') + '//' + host + ':' + MP_DEFAULT_ROOM_PORT + '/ws';
}

/** Uppercase and validate a room code without inventing a replacement. */
export function normalizeRoomCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (code.length !== 5) return null;
  for (const character of code) if (!ROOM_ALPHABET.includes(character)) return null;
  return code;
}

/** Sanitise a player name to the room service's 1..24 printable-character rule. */
export function normalizePlayerName(value, fallback = 'Player') {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  return text || fallback;
}

/**
 * The session car for M1. The host's car at room creation is the one both
 * engines load; a guest pick is lobby metadata only. This function is pure so
 * the lobby and the verifier agree.
 */
export function sessionCarForRoom(room, fallback = null) {
  const host = room?.players?.find((player) => player.host === true || player.id === room.hostId);
  return host?.car ?? fallback ?? null;
}

/** Player view used by the result builder (roster order is by slot). */
export function rosterForResult(room) {
  return [...(room?.players ?? [])]
    .sort((a, b) => a.slot - b.slot)
    .map((player) => ({
      id: player.id,
      slot: player.slot,
      name: player.name,
      car: player.car,
      host: player.host === true || player.id === room.hostId,
      connected: player.connected !== false
    }));
}

/**
 * Build the shared result table from the room's `room.finished` payload.
 *
 * Both clients call this with the same `room` and `results`, so the rows,
 * positions, times and hash are identical. A finish tick is an engine tick that
 * includes the countdown; the reported race time subtracts the committed layout
 * countdown. A missing/invalid tick is an explicit DNF row, never a guessed
 * time.
 *
 * AI opponents (M4) are host-controlled participants that never appear on the
 * room wire as players. The host broadcasts their finished/DNF rows through the
 * AI relay; both pages merge the same `aiPlayers` + `aiResults` into this table.
 * With zero AI the output object and hash are byte-identical to the M1 builder.
 */
export function buildMpResult({
  layout, room, results, aiPlayers = [], aiResults = [],
  tickHz = MP_TICK_HZ, note = MP_RESULT_NOTE
} = {}) {
  if (!layout?.gates?.length) throw new Error('mp result needs the committed sprint layout');
  if (!room?.players?.length) throw new Error('mp result needs the room roster');
  if (!Array.isArray(results)) throw new Error('mp result needs the room finish results');
  if (!Array.isArray(aiPlayers) || !Array.isArray(aiResults)) throw new Error('mp AI result needs arrays');
  const withAi = aiPlayers.length > 0;
  const countdownTicks = layout.countdown?.ticks ?? 0;
  const finishGate = layout.gates[layout.gates.length - 1];
  const finishPosition = [
    round6(finishGate.x),
    round6(finishGate.height ?? finishGate.groundY ?? 0),
    round6(finishGate.z)
  ];
  const rows = rosterForResult(room).map((player) => {
    const result = results.find((entry) => entry?.playerId === player.id) ?? null;
    const tick = Number.isInteger(result?.tick) && result.tick > countdownTicks ? result.tick : null;
    const raceTicks = tick === null ? null : tick - countdownTicks;
    return {
      playerId: player.id,
      slot: player.slot,
      name: player.name,
      car: player.car,
      host: player.host,
      ...(withAi ? { ai: false, profile: null } : {}),
      status: tick === null ? 'dnf' : 'finished',
      tick,
      raceTicks,
      timeSeconds: raceTicks === null ? null : round6(raceTicks / tickHz),
      position: tick === null ? null : finishPosition.slice(),
      finishHash: typeof result?.hash === 'string' ? result.hash : null,
      note: tick === null ? (result ? 'finish tick is not after the countdown' : 'no finish broadcast for this player') : null
    };
  });
  for (const player of withAi ? aiPlayers : []) {
    const result = aiResults.find((entry) => entry?.playerId === player.id) ?? null;
    const tick = Number.isInteger(result?.tick) && result.tick > countdownTicks ? result.tick : null;
    const raceTicks = tick === null ? null : tick - countdownTicks;
    rows.push({
      playerId: player.id,
      slot: player.slot,
      name: player.name ?? player.id,
      car: player.car ?? null,
      host: false,
      ai: true,
      profile: player.profile ?? null,
      status: tick === null ? 'dnf' : 'finished',
      tick,
      raceTicks,
      timeSeconds: raceTicks === null ? null : round6(raceTicks / tickHz),
      position: tick === null ? null : finishPosition.slice(),
      finishHash: typeof result?.hash === 'string' ? result.hash : null,
      note: tick === null
        ? (result
          ? (result.reason ?? 'AI finish tick is not after the countdown')
          : 'no host AI result for this participant')
        : null
    });
  }
  const finished = rows.filter((row) => row.status === 'finished')
    .sort((a, b) => a.tick - b.tick || a.slot - b.slot);
  const dnf = rows.filter((row) => row.status === 'dnf').sort((a, b) => a.slot - b.slot);
  const ordered = [...finished, ...dnf];
  let lastTick = null;
  let lastPosition = 0;
  for (let index = 0; index < ordered.length; index++) {
    const row = ordered[index];
    if (row.status === 'finished' && row.tick === lastTick) {
      row.positionNumber = lastPosition;
      row.tied = true;
    } else {
      row.positionNumber = index + 1;
      lastPosition = row.positionNumber;
      row.tied = false;
    }
    if (row.status === 'finished') lastTick = row.tick;
  }
  const body = {
    kind: MP_RESULT_KIND,
    version: MP_RESULT_VERSION,
    courseId: layout.courseId ?? null,
    layoutHash: layout.hash ?? null,
    tickHz,
    countdownTicks,
    finishGate: finishPosition,
    rows: ordered,
    order: ordered.map((row) => row.playerId),
    finishers: finished.map((row) => row.playerId),
    dnf: dnf.map((row) => row.playerId),
    winnerId: finished[0]?.playerId ?? null,
    ...(withAi ? {
      ai: aiPlayers.map((player) => ({
        playerId: player.id,
        slot: player.slot,
        name: player.name ?? player.id,
        car: player.car ?? null,
        profile: player.profile ?? null
      }))
    } : {}),
    note
  };
  return { ...body, hash: hashOf(body) };
}

/**
 * Room/lobby/sync wrapper around the injected NetClient.
 *
 * Events emitted through `onEvent(type, payload)`:
 *   welcome, lobby, started, remoteState, remoteInput, peerDisconnected,
 *   peerResumed, peerFinished, reconnecting, resumed, result, error, closed
 */
export class MpSession {
  constructor({
    NetClient,
    url,
    name,
    host = false,
    code = null,
    car = null,
    map = MP_MAP,
    maxPlayers = MP_MAX_PLAYERS,
    autoReconnect = true,
    onEvent = () => {}
  } = {}) {
    if (typeof NetClient !== 'function') throw new Error('MpSession needs the NetClient constructor');
    this.requestedCode = code ? normalizeRoomCode(code) : null;
    if (code && !this.requestedCode) throw new Error('invalid room code ' + JSON.stringify(code));
    this.host = Boolean(host);
    this.name = normalizePlayerName(name, host ? 'Host' : 'Guest');
    this.car = car;
    this.map = normalizeMpMapId(map) ?? MP_MAP;
    this.maxPlayers = maxPlayers;
    this.onEvent = onEvent;
    this.net = new NetClient({
      url,
      name: this.name,
      autoReconnect,
      // No impairment in the game path; the transport probe owns that option.
    });
    this.url = url;
    this.room = null;
    this.you = null;
    this.startedInfo = null;
    this.requestedCodeMismatch = false;
    this._bind();
  }

  _emit(type, payload) {
    try { this.onEvent(type, payload); } catch (error) {
      // Listener failures must not break the transport; surface them as events.
      try { this.onEvent('error', error); } catch { /* ignore */ }
    }
  }

  _bind() {
    const net = this.net;
    net.on('welcome', (message) => this._emit('welcome', message));
    net.on('room', ({ room, you, resumed }) => {
      this.room = room;
      this.you = you;
      if (you) this.requestedCodeMismatch = Boolean(this.requestedCode && room.code !== this.requestedCode);
      this._emit('lobby', { room, you, resumed });
    });
    net.on('started', (info) => {
      this.room = net.room;
      // The wire carries the map selector only. The typed record (id + layout,
      // package and physics hashes) is derived from the committed registry on
      // every client, so the check is deterministic without a protocol change.
      const mapId = normalizeMpMapId(net.room?.map ?? info?.room?.map ?? this.map);
      let map = null;
      let mapError = null;
      try { map = mapId === null ? null : mpMapRecord(mapId); }
      catch (error) {
        mapError = { code: error.code ?? MP_MAP_UNKNOWN, message: error.message };
      }
      this.startedInfo = { ...info, mapId, map, mapError };
      this._emit('started', this.startedInfo);
    });
    net.on('stateApplied', (record) => this._emit('remoteState', record));
    net.on('inputApplied', (record) => this._emit('remoteInput', record));
    net.on('player.disconnected', (message) => {
      this.room = net.room;
      this._emit('peerDisconnected', message);
    });
    net.on('player.resumed', (message) => {
      this.room = net.room;
      this._emit('peerResumed', message);
    });
    net.on('player.finished', (message) => this._emit('peerFinished', message));
    net.on('resumed', (payload) => {
      this.room = net.room;
      this._emit('resumed', payload);
    });
    net.on('reconnectAttempt', (payload) => this._emit('reconnecting', payload));
    net.on('disconnected', (payload) => this._emit('reconnecting', payload));
    net.on('reconnectFailed', (error) => this._emit('error', error));
    net.on('finished', (message) => {
      this.room = net.room;
      this._emit('result', message);
    });
    net.on('error', (error) => this._emit('error', error));
    net.on('closed', (payload) => this._emit('closed', payload));
  }

  get code() { return this.room?.code ?? null; }
  get playerId() { return this.net.playerId; }
  get slot() {
    const self = this.room?.players?.find((player) => player.id === this.playerId);
    return self?.slot ?? this.you?.slot ?? null;
  }
  get hostId() { return this.room?.hostId ?? null; }
  get isHost() { return this.net.isHost; }
  get phase() { return this.room?.phase ?? 'idle'; }
  get players() { return this.room?.players ?? []; }
  get sessionCar() { return sessionCarForRoom(this.room, this.car); }
  get roomMapId() { return normalizeMpMapId(this.room?.map); }
  get mapRecord() {
    const id = this.roomMapId ?? this.map;
    try { return id === null ? null : mpMapRecord(id); } catch { return null; }
  }

  async open() {
    await this.net.connect();
    let response;
    if (this.host) {
      response = await this.net.createRoom({
        name: this.name,
        maxPlayers: this.maxPlayers,
        map: this.map,
        car: this.car ?? 'corvette-zr1-stock'
      });
    } else {
      if (!this.requestedCode) throw new Error('a guest needs a 5-character room code (?room=CODE)');
      response = await this.net.joinRoom({
        code: this.requestedCode,
        name: this.name,
        car: this.car ?? 'corvette-zr1-stock'
      });
    }
    this.room = response.room;
    this.you = response.you;
    this.requestedCodeMismatch = Boolean(this.requestedCode && response.room.code !== this.requestedCode);
    return response;
  }

  async setReady(ready) { return this.net.setReady(Boolean(ready)); }
  async selectCar(car) { return this.net.select({ car }); }
  /** Host-only in the room service; validated here before it reaches the wire. */
  async selectMap(map) {
    const id = normalizeMpMapId(map);
    if (id === null) throw new MpMapError(MP_MAP_UNKNOWN, 'map id is missing');
    mpMapRecord(id);
    return this.net.select({ map: id });
  }
  async start(options = {}) { return this.net.start(options); }
  async leave() { return this.net.leave(); }

  sendInput(input, tick) { return this.net.sendInput(input, tick); }
  sendState(state) { return this.net.sendState(state); }
  reportFinished(payload) {
    // The race is open while the room is still running. Once the room has
    // broadcast its result, a duplicate/late report is rejected instead of
    // rewriting the closed table.
    if (this.room?.phase === 'finished') {
      return Promise.reject(new MpSessionError(MP_ROOM_CLOSED,
        'the room result has already been broadcast; a late finish report is rejected'));
    }
    return this.net.reportFinished(payload);
  }
  finalizeStreams() { return this.net.finalizeStreams(); }
  streamsConverged() { return this.net.streamsConverged(); }
  waitForStreams(timeoutMs = 8000) { return this.net.waitForStreams(timeoutMs); }
  buildFinalTable(tick) { return this.net.buildFinalTable(tick); }

  sampleRemote(playerId, renderTick) { return this.net.sampleRemote(playerId, renderTick); }
  latestRemote(playerId) { return this.net.latestRemote(playerId); }
  correctorFor(playerId, options = {}) { return this.net.correctorFor(playerId, options); }
  stats() { return this.net.stats(); }

  remotePlayer() {
    return this.room?.players?.find((player) => player.id !== this.playerId) ?? null;
  }

  close() { this.net.close(); }
}

/** Compact lobby/status projection for the page and the capture probe. */
export function mpStatus(session, extra = {}) {
  if (!session) return { schema: MP_SCHEMA, phase: 'off', ...extra };
  const stats = session.stats();
  const remote = session.remotePlayer();
  return {
    schema: MP_SCHEMA,
    code: session.code,
    phase: session.phase,
    hostId: session.hostId,
    playerId: session.playerId,
    slot: session.slot,
    isHost: session.isHost,
    requestedCode: session.requestedCode,
    requestedCodeMismatch: session.requestedCodeMismatch,
    sessionCar: session.sessionCar,
    mapId: session.roomMapId ?? session.startedInfo?.mapId ?? session.map ?? null,
    map: session.startedInfo?.map ?? session.mapRecord,
    players: rosterForResult(session.room),
    remote: remote ? { id: remote.id, slot: remote.slot, name: remote.name, car: remote.car, connected: remote.connected !== false } : null,
    stats,
    updatedAt: nowMs(),
    ...extra
  };
}
