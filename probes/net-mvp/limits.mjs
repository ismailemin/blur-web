// Safety / policy gate for the internet-ready room service.
//
//   node probes/net-mvp/limits.mjs
//
// Covers the typed rejections and bounded resources added for internet play:
//   * capacity: default 8, explicit 2..20, 21 rejected with NET_CAPACITY;
//   * room full, including a seat reserved for a disconnected player;
//   * per-IP join rate limit (NET_JOIN_RATE_LIMIT);
//   * max message size (NET_MESSAGE_TOO_LARGE + close 1009);
//   * idle-room reaping (NET_ROOM_IDLE);
//   * server-wide room cap;
//   * room-code case normalisation;
//   * graceful shutdown + state-file restore (a restart does not strand a room).
//
// Evidence: _work/net-mvp/limits-report.json

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRoomServer } from './server.mjs';
import { NetClient, NetError } from './client.mjs';
import { ERROR_CODES } from './protocol.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/net-mvp');
mkdirSync(OUT, { recursive: true });
const REPORT_FILE = path.join(OUT, 'limits-report.json');
const STATE_FILE = path.join(OUT, 'state', 'limits-rooms.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
const check = async (name, fn) => {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    checks.push({ name, pass: true, elapsedMs: Date.now() - startedAt, detail: detail ?? null });
  } catch (error) {
    checks.push({
      name, pass: false, elapsedMs: Date.now() - startedAt,
      error: error instanceof NetError ? error.toJSON() : String(error?.stack || error)
    });
  }
};

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof NetError, 'expected NetError, got ' + String(error));
    assert.equal(error.code, code);
    return true;
  };
}

async function withServer(options, fn) {
  const server = await startRoomServer({ port: 0, ...options });
  const clients = [];
  try {
    return await fn(server, clients);
  } finally {
    for (const client of clients) { try { client.close(); } catch { /* noop */ } }
    await server.close({ drainMs: 50, save: false }).catch(() => {});
  }
}

function newClient(server, name, options = {}) {
  return new NetClient({ url: server.wsUrl, name, autoReconnect: false, ...options });
}

async function main() {
  const startedAt = Date.now();

  await check('capacity default 8 and range 2..20 with NET_CAPACITY', async () => {
    return withServer({}, async (server, clients) => {
      const a = newClient(server, 'CapA'); clients.push(a); await a.connect();
      const defaults = await a.createRoom({ name: 'CapA' });
      assert.equal(defaults.room.maxPlayers, 8);
      await a.leave();
      await assert.rejects(a.createRoom({ name: 'CapA', maxPlayers: 21 }), expectCode(ERROR_CODES.NET_CAPACITY));
      await assert.rejects(a.createRoom({ name: 'CapA', maxPlayers: 1 }), expectCode(ERROR_CODES.NET_CAPACITY));
      const max = await a.createRoom({ name: 'CapA', maxPlayers: 20 });
      assert.equal(max.room.maxPlayers, 20);
      return { default: 8, hard: 20 };
    });
  });

  await check('room full counts reserved disconnected seats', async () => {
    return withServer({}, async (server, clients) => {
      const a = newClient(server, 'FullA'); const b = newClient(server, 'FullB'); const c = newClient(server, 'FullC');
      clients.push(a, b, c);
      await Promise.all([a.connect(), b.connect(), c.connect()]);
      const created = await a.createRoom({ name: 'FullA', maxPlayers: 2 });
      await b.joinRoom({ code: created.room.code, name: 'FullB' });
      await assert.rejects(c.joinRoom({ code: created.room.code, name: 'FullC' }), expectCode(ERROR_CODES.NET_ROOM_FULL));
      // Close B without an explicit leave: the seat is reserved for 30 s.
      b.close();
      await sleep(150);
      await assert.rejects(c.joinRoom({ code: created.room.code, name: 'FullC' }), expectCode(ERROR_CODES.NET_ROOM_FULL));
      return { maxPlayers: 2, reserved: 1 };
    });
  });

  await check('per-IP join rate limit is NET_JOIN_RATE_LIMIT', async () => {
    return withServer({ joinRateLimit: { capacity: 2, refillPerSecond: 0 } }, async (server, clients) => {
      const a = newClient(server, 'RateA'); const b = newClient(server, 'RateB');
      clients.push(a, b);
      await Promise.all([a.connect(), b.connect()]);
      const created = await a.createRoom({ name: 'RateA', maxPlayers: 4 });
      await b.joinRoom({ code: created.room.code, name: 'RateB' });
      await b.leave();
      await b.joinRoom({ code: created.room.code, name: 'RateB' });
      await b.leave();
      await assert.rejects(b.joinRoom({ code: created.room.code, name: 'RateB' }), expectCode(ERROR_CODES.NET_JOIN_RATE_LIMIT));
      return { capacity: 2 };
    });
  });

  await check('max message size is NET_MESSAGE_TOO_LARGE and close 1009', async () => {
    return withServer({ maxMessageBytes: 1024 }, async (server, clients) => {
      const a = newClient(server, 'BigA'); clients.push(a);
      const errors = [];
      a.on('error', (error) => errors.push(error.code));
      a.on('fatal', (error) => errors.push(error.code));
      await a.connect();
      a._sendMessage({ type: 'ping', id: 'big', t: 1, padding: 'x'.repeat(2048) });
      await sleep(250);
      assert.ok(errors.includes(ERROR_CODES.NET_MESSAGE_TOO_LARGE), 'errors: ' + JSON.stringify(errors));
      assert.equal(a.connected, false);
      assert.equal(server.stats().oversizeRejected, 1);
      return { errors, cap: 1024 };
    });
  });

  await check('idle room is reaped with NET_ROOM_IDLE', async () => {
    return withServer({ idleRoomMs: 500, sweepIntervalMs: 100, emptyRoomMs: 100_000 }, async (server, clients) => {
      const a = newClient(server, 'IdleA'); clients.push(a);
      const errors = [];
      a.on('error', (error) => errors.push(error.code));
      a.on('fatal', (error) => errors.push(error.code));
      await a.connect();
      await a.createRoom({ name: 'IdleA', maxPlayers: 4 });
      await sleep(900);
      assert.ok(errors.includes(ERROR_CODES.NET_ROOM_IDLE), 'errors: ' + JSON.stringify(errors));
      assert.equal(server.stats().idleRoomsReaped, 1);
      assert.equal(server.stats().rooms, 0);
      return { errors };
    });
  });

  await check('server room cap is NET_CAPACITY', async () => {
    return withServer({ maxRooms: 1 }, async (server, clients) => {
      const a = newClient(server, 'RoomA'); const b = newClient(server, 'RoomB');
      clients.push(a, b);
      await Promise.all([a.connect(), b.connect()]);
      await a.createRoom({ name: 'RoomA' });
      await assert.rejects(b.createRoom({ name: 'RoomB' }), expectCode(ERROR_CODES.NET_CAPACITY));
      return { maxRooms: 1 };
    });
  });

  await check('room code is case-insensitive at the API boundary', async () => {
    return withServer({}, async (server, clients) => {
      const a = newClient(server, 'CodeA'); const b = newClient(server, 'CodeB');
      clients.push(a, b);
      await Promise.all([a.connect(), b.connect()]);
      const created = await a.createRoom({ name: 'CodeA' });
      const joined = await b.joinRoom({ code: created.room.code.toLowerCase(), name: 'CodeB' });
      assert.equal(joined.room.code, created.room.code);
      return { code: created.room.code };
    });
  });

  await check('graceful shutdown + state file resumes the same room/player', async () => {
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
    const first = await startRoomServer({ port: 0, stateFile: STATE_FILE });
    const a = new NetClient({ url: first.wsUrl, name: 'PersistA', autoReconnect: false });
    let code = null; let playerId = null; let token = null; let slot = null;
    try {
      await a.connect();
      const created = await a.createRoom({ name: 'PersistA', maxPlayers: 4, map: 'usa_la_river' });
      code = created.room.code; playerId = created.you.id; token = created.you.resumeToken; slot = created.you.slot;
      await a.setReady(true);
      await first.close({ drainMs: 100 });
      assert.equal(existsSync(STATE_FILE), true);
      const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      assert.equal(saved.schema, 'blur.net-mvp.rooms/1');
      assert.equal(saved.rooms.length, 1);
    } finally {
      a.close();
      await first.close({ drainMs: 50, save: false }).catch(() => {});
    }

    const second = await startRoomServer({ port: 0, stateFile: STATE_FILE });
    const b = new NetClient({ url: second.wsUrl, name: 'PersistA', autoReconnect: false });
    try {
      await b.connect();
      const joined = await b.joinRoom({ code, name: 'PersistA', resumeToken: token });
      assert.equal(joined.resumed, true);
      assert.equal(b.playerId, playerId);
      assert.equal(b.room.code, code);
      assert.equal(b.room.players.find((player) => player.id === b.playerId)?.slot, slot);
      assert.equal(b.room.players.find((player) => player.id === b.playerId)?.ready, true);
      assert.equal(second.health().counters.roomsRestored, 1);
      return { code, restoredRooms: 1, samePlayer: b.playerId === playerId };
    } finally {
      b.close();
      await second.close({ drainMs: 50, save: false }).catch(() => {});
      if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
    }
  });

  const failed = checks.filter((row) => !row.pass);
  const report = {
    schema: 'blur.net-mvp.limits/1',
    command: 'node probes/net-mvp/limits.mjs',
    startedAt: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt,
    checks,
    passed: failed.length === 0,
    counts: { total: checks.length, pass: checks.length - failed.length, fail: failed.length }
  };
  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
  console.log((report.passed ? 'PASS' : 'FAIL') + ' net-mvp limits · ' +
    report.counts.pass + '/' + report.counts.total);
  for (const row of failed) console.error('  FAIL ' + row.name + '\n    ' + JSON.stringify(row.error));
  return report.passed ? 0 : 1;
}

process.exit(await main());
