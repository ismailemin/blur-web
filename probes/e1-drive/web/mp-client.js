// Multiplayer session wrapper for the E1 drive slice (M1, two browsers).
//
// This module is deliberately DOM-free and dependency-injected: the page passes
// the committed `NetClient` class from `/net-mvp/client.mjs`, and the Node
// verifier passes the same class from `probes/net-mvp/client.mjs`. That keeps
// the room/lobby/result logic identical in both environments and testable
// without a browser.
//
// M1 scope:
//   * two players, one measured 310 m River course, one car for both bodies
//     (car picks are lobby metadata; the host's car is the session car);
//   * the room service carries the lobby, 60 Hz inputs and 20 Hz per-player
//     state snapshots; the host runs the authoritative rules/result;
//   * the result table is a pure function of the room's finish broadcast, so
//     both clients render the same positions/times from the same bytes.

import { hashOf } from './packet-hash.js';

export const MP_KIND = 'e1-drive.mp/1';
export const MP_SCHEMA = 'e1-drive.mp/1';
export const MP_MAP = 'usa_la_river';
export const MP_MAX_PLAYERS = 2;
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
 * Build the shared M1 result table from the room's `room.finished` payload.
 *
 * Both clients call this with the same `room` and `results`, so the rows,
 * positions, times and hash are identical. A finish tick is an engine tick that
 * includes the countdown; the reported race time subtracts the committed layout
 * countdown. A missing/invalid tick is an explicit DNF row, never a guessed
 * time.
 */
export function buildMpResult({ layout, room, results, tickHz = MP_TICK_HZ, note = MP_RESULT_NOTE } = {}) {
  if (!layout?.gates?.length) throw new Error('mp result needs the committed sprint layout');
  if (!room?.players?.length) throw new Error('mp result needs the room roster');
  if (!Array.isArray(results)) throw new Error('mp result needs the room finish results');
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
      status: tick === null ? 'dnf' : 'finished',
      tick,
      raceTicks,
      timeSeconds: raceTicks === null ? null : round6(raceTicks / tickHz),
      position: tick === null ? null : finishPosition.slice(),
      finishHash: typeof result?.hash === 'string' ? result.hash : null,
      note: tick === null ? (result ? 'finish tick is not after the countdown' : 'no finish broadcast for this player') : null
    };
  });
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
    this.map = map;
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
      this.startedInfo = info;
      this.room = net.room;
      this._emit('started', info);
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
  async start(options = {}) { return this.net.start(options); }
  async leave() { return this.net.leave(); }

  sendInput(input, tick) { return this.net.sendInput(input, tick); }
  sendState(state) { return this.net.sendState(state); }
  reportFinished(payload) { return this.net.reportFinished(payload); }
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
    players: rosterForResult(session.room),
    remote: remote ? { id: remote.id, slot: remote.slot, name: remote.name, car: remote.car, connected: remote.connected !== false } : null,
    stats,
    updatedAt: nowMs(),
    ...extra
  };
}
