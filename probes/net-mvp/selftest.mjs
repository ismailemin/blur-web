// Fast unit + negative-path test for the net-mvp probe.
//
//   node probes/net-mvp/selftest.mjs
//
// Covers hashing, canonical JSON, protocol validation, strict ordering,
// interpolation, bounded correction, and the room service's typed rejection
// paths (bad code, duplicate join, non-host start, join after start, unknown
// resume token) plus one real token resume. No game data, no browser.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRoomServer } from './server.mjs';
import { NetClient, OrderedStream, InterpolationBuffer, BoundedCorrector, NetError } from './client.mjs';
import { sha256Hex, canonicalJson, hashOf } from './hash.mjs';
import { validRoomCode, quantizeState, quantizeInput, checkState, ERROR_CODES } from './protocol.mjs';
import { stateAt, inputAt, finalHash } from './race.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/net-mvp');
mkdirSync(OUT, { recursive: true });

const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push({ name, pass: true });
  } catch (error) {
    checks.push({ name, pass: false, error: String(error?.stack || error) });
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    checks.push({ name, pass: true });
  } catch (error) {
    checks.push({ name, pass: false, error: String(error?.stack || error) });
  }
};
const expectCode = (code) => (error) => {
  assert.ok(error instanceof NetError, 'expected NetError, got ' + String(error));
  assert.equal(error.code, code);
  return true;
};

check('sha256 empty', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
check('sha256 abc', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
check('canonical json sorts keys', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});
check('hash ignores key order', () => {
  assert.equal(hashOf({ a: 1, b: 2 }), hashOf({ b: 2, a: 1 }));
});
check('room code validation', () => {
  assert.equal(validRoomCode('ABCDE'), true);
  assert.equal(validRoomCode('abcde'), false);
  assert.equal(validRoomCode('ABCD'), false);
  assert.equal(validRoomCode('ABC0E'), false); // 0 is not in the alphabet
});
check('state validation rejects non-unit quaternion', () => {
  assert.equal(checkState({ tick: 1, position: [0, 0, 0], quaternion: [0, 0, 0, 2], speed: 1 }) !== null, true);
  assert.equal(checkState(stateAt('seed', 1, 'car', 1)), null);
});
check('input validation rejects out-of-range', () => {
  assert.throws(() => quantizeInput({ throttle: 2, brake: 0, steer: 0, handbrake: 0 }), expectCode(ERROR_CODES.NET_PROTOCOL));
  assert.doesNotThrow(() => quantizeInput({ throttle: 1, brake: 0, steer: -0.2, handbrake: 0 }));
});
check('quantized state is stable', () => {
  const state = stateAt('seed', 2, 'car', 42);
  assert.equal(canonicalJson(quantizeState(state)), canonicalJson(state));
});
check('ordered stream buffers gaps then applies in order', () => {
  const stream = new OrderedStream({ channel: 'state' });
  assert.equal(stream.receive({ seq: 1, tick: 1 }).applied.length, 1);
  const future = stream.receive({ seq: 3, tick: 3 });
  assert.equal(future.applied.length, 0);
  assert.equal(future.buffered, true);
  const fill = stream.receive({ seq: 2, tick: 2 });
  assert.deepEqual(fill.applied.map((row) => row.seq), [2, 3]);
  assert.equal(stream.receive({ seq: 2, tick: 2 }).duplicate, true);
  assert.equal(stream.lastApplied, 3);
  assert.equal(stream.appliedSeqCount, 3);
  assert.equal(stream.violations, 0);
});
check('ordered stream reports overflow, never drops silently', () => {
  const stream = new OrderedStream({ channel: 'state', maxPending: 2 });
  stream.receive({ seq: 2, tick: 2 });
  stream.receive({ seq: 3, tick: 3 });
  const overflow = stream.receive({ seq: 4, tick: 4 });
  assert.equal(overflow.overflow, true);
  assert.equal(stream.overflow, 1);
});
check('interpolation uses neighbors and clamps outside', () => {
  const buffer = new InterpolationBuffer();
  buffer.add({ tick: 0, position: [0, 0, 0], quaternion: [0, 0, 0, 1], speed: 0 });
  buffer.add({ tick: 10, position: [10, 0, 0], quaternion: [0, 0, 0, 1], speed: 10 });
  const middle = buffer.sample(5);
  assert.equal(middle.interpolated, true);
  assert.equal(middle.position[0], 5);
  assert.equal(middle.clamped, false);
  const outside = buffer.sample(20);
  assert.equal(outside.clamped, true);
  assert.equal(outside.position[0], 10);
  assert.equal(buffer.misses, 1);
});
check('bounded correction caps every step and converges', () => {
  const corrector = new BoundedCorrector({ maxPositionSpeed: 2.5, maxAngularSpeed: 2 });
  corrector.reset({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
  const target = { position: [5, 0, 0], quaternion: [0, 0, 0, 1] };
  let maxStep = 0;
  for (let index = 0; index < 180; index++) {
    const result = corrector.correct(target, 1 / 60);
    maxStep = Math.max(maxStep, result.appliedDistance);
  }
  assert.ok(maxStep <= 2.5 / 60 + 1e-9, 'max step ' + maxStep);
  assert.ok(Math.abs(corrector.position[0] - 5) < 1e-9);
  assert.ok(corrector.clampedSteps > 0);
});
check('final hash is slot-sorted and tick-bound', () => {
  const a = { slot: 1, car: 'a', ...stateAt('seed', 1, 'a', 10) };
  const b = { slot: 2, car: 'b', ...stateAt('seed', 2, 'b', 10) };
  assert.equal(finalHash({ seed: 'seed', tick: 10, players: [a, b] }), finalHash({ seed: 'seed', tick: 10, players: [b, a] }));
  assert.throws(() => finalHash({ seed: 'seed', tick: 11, players: [a, b] }));
});

async function waitEvent(client, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const off = client.on(event, (payload) => { clearTimeout(timer); off(); resolve(payload); });
    const timer = setTimeout(() => { off(); reject(new Error('timeout waiting for ' + event)); }, timeoutMs);
  });
}

const server = await startRoomServer({ port: 0 });
const clients = [];
try {
  const a = new NetClient({ url: server.wsUrl, name: 'SelftestA' });
  const b = new NetClient({ url: server.wsUrl, name: 'SelftestB' });
  const c = new NetClient({ url: server.wsUrl, name: 'SelftestC' });
  clients.push(a, b, c);
  for (const client of clients) await client.connect();

  const created = await a.createRoom({ name: 'SelftestA', maxPlayers: 4, map: 'usa_la_river', car: 'corvette-zr1-stock' });
  const code = created.room.code;
  await b.joinRoom({ code, name: 'SelftestB', car: 'lotus-exige-cup260' });

  await checkAsync('duplicate join rejected with NET_ALREADY_IN_ROOM', async () => {
    await assert.rejects(b.createRoom({ name: 'SelftestB' }), expectCode(ERROR_CODES.NET_ALREADY_IN_ROOM));
  });
  await checkAsync('unknown room rejected with NET_ROOM_NOT_FOUND', async () => {
    await assert.rejects(c.joinRoom({ code: 'ZZZZZ', name: 'SelftestC' }), expectCode(ERROR_CODES.NET_ROOM_NOT_FOUND));
  });
  await checkAsync('unknown resume token rejected with NET_RESUME_UNKNOWN', async () => {
    await assert.rejects(c.joinRoom({ code, name: 'SelftestC', resumeToken: '00'.repeat(24) }), expectCode(ERROR_CODES.NET_RESUME_UNKNOWN));
  });
  await checkAsync('host map and player car selection accepted', async () => {
    const mapResult = await a.select({ map: 'usa_la_river' });
    assert.equal(mapResult.action, 'player.select');
    const carResult = await b.select({ car: 'lotus-exige-cup260' });
    assert.equal(carResult.action, 'player.select');
  });
  await checkAsync('non-host map selection rejected with NET_NOT_HOST', async () => {
    await assert.rejects(b.select({ map: 'other_map' }), expectCode(ERROR_CODES.NET_NOT_HOST));
  });
  await checkAsync('non-host start rejected with NET_NOT_HOST', async () => {
    await a.setReady(true);
    await b.setReady(true);
    await assert.rejects(b.start(), expectCode(ERROR_CODES.NET_NOT_HOST));
  });

  const startedB = waitEvent(b, 'started');
  await a.start({ seed: 'selftest-seed' });
  await startedB;

  await checkAsync('join after start rejected with NET_ROOM_STARTED', async () => {
    await assert.rejects(c.joinRoom({ code, name: 'SelftestC' }), expectCode(ERROR_CODES.NET_ROOM_STARTED));
  });

  await checkAsync('forced drop resumes the same player id and room', async () => {
    const playerId = b.playerId;
    const result = await b.simulateDrop();
    assert.equal(result.resumed, true);
    assert.equal(b.playerId, playerId);
    assert.equal(b.room.code, code);
    assert.equal(b.room.phase, 'running');
    assert.equal(b.stats().counters.reconnects, 1);
  });

  await checkAsync('state send works only while running', async () => {
    const sent = a.sendState(stateAt('selftest-seed', 1, 'corvette-zr1-stock', 1));
    assert.equal(sent.seq, 1);
    assert.equal(a.sendInput(inputAt('selftest-seed', 1, 1), 1).seq, 1);
  });
} finally {
  for (const client of clients) client.close();
  await server.close();
}

const failed = checks.filter((row) => !row.pass);
const report = {
  schema: 'blur.net-mvp.selftest/1',
  command: 'node probes/net-mvp/selftest.mjs',
  checks,
  passed: failed.length === 0,
  counts: { total: checks.length, pass: checks.length - failed.length, fail: failed.length }
};
writeFileSync(path.join(OUT, 'selftest.json'), JSON.stringify(report, null, 2) + '\n');
console.log((report.passed ? 'PASS' : 'FAIL') + ' net-mvp selftest · ' + report.counts.pass + '/' + report.counts.total);
for (const row of failed) console.error('  FAIL ' + row.name + '\n    ' + row.error);
process.exit(report.passed ? 0 : 1);
