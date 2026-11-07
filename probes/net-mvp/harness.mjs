// Deterministic multi-client transport gate.
//
//   node probes/net-mvp/harness.mjs [--players 4] [--seconds 30]
//                                   [--seed blur-net-mvp-harness-v1]
//                                   [--reconnect-at 15]
//
// Starts the room service on an ephemeral port, joins 2-4 Node clients, starts
// the race, sends input at 60 Hz and state at 20 Hz for 30 s, injects 1% loss
// and 80 ms latency on client #2's state channel, forces one disconnect and
// resume, then verifies:
//
//   * every sender's applied sequence is contiguous and complete at its final
//     target (no duplicate application, no out-of-order application);
//   * every applied snapshot equals the deterministic expected snapshot;
//   * the reconnect resumed the same player id/room/host with no duplicate;
//   * all clients produce the same final-tick state hash.
//
// Exit code 0 on pass, 1 on failure. Evidence:
//   _work/net-mvp/harness-report.json
//   _work/logs/net-mvp/harness.log

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRoomServer } from './server.mjs';
import { NetClient, NetError } from './client.mjs';
import { canonicalJson } from './hash.mjs';
import { ERROR_CODES } from './protocol.mjs';
import { stateAt, inputAt, finalHash, finalTickForSeconds } from './race.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/net-mvp');
const LOGS = path.join(ROOT, '_work/logs/net-mvp');
mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });
const REPORT_FILE = path.join(OUT, 'harness-report.json');
const LOG_FILE = path.join(LOGS, 'harness.log');
writeFileSync(LOG_FILE, '');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const PLAYERS = Math.max(2, Math.min(4, Number(option('--players', '4'))));
const SECONDS = Number(option('--seconds', '30'));
const SEED = option('--seed', 'blur-net-mvp-harness-v1');
const RECONNECT_AT_SECONDS = Number(option('--reconnect-at', '15'));
const FINAL_TICK = finalTickForSeconds(SECONDS);
const RECONNECT_AT_MS = Math.max(250, RECONNECT_AT_SECONDS * 1000);
const ROSTER = [
  { name: 'Host', car: 'corvette-zr1-stock' },
  { name: 'Bravo', car: 'lotus-exige-cup260' },
  { name: 'Charlie', car: 'dodge-challenger-stock' },
  { name: 'Delta', car: 'audi-r8v10-stock' }
];

const startedAt = Date.now();
const log = (event) => appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const ms = (value) => Math.round(value * 1000) / 1000;

function waitEvent(client, event, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const off = client.on(event, (payload) => {
      clearTimeout(timer);
      off();
      resolve(payload);
    });
    const timer = setTimeout(() => {
      off();
      reject(new NetError(ERROR_CODES.NET_TIMEOUT, 'timed out waiting for ' + event));
    }, timeoutMs);
  });
}

class Driver {
  constructor(client, index) {
    this.client = client;
    this.index = index;
    this.startedAt = null;
    this.nextTick = 1;
    this.timer = null;
    this.done = null;
    this.sendErrors = [];
    this.sentStates = 0;
    this.sentInputs = 0;
  }

  start() {
    this.startedAt = nowMs();
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
    this.timer = setInterval(() => this.pump(), 4);
    this.pump();
    return this.done;
  }

  pump() {
    if (this.nextTick > FINAL_TICK) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.resolveDone?.();
      return;
    }
    if (!this.client.connected || this.client.room?.phase !== 'running') return;
    const target = Math.min(FINAL_TICK, 1 + Math.floor((nowMs() - this.startedAt) * 60 / 1000));
    const self = this.client.room.players.find((player) => player.id === this.client.playerId);
    if (!self) return;
    while (this.nextTick <= target) {
      const tick = this.nextTick++;
      try {
        this.client.sendInput(inputAt(SEED, self.slot, tick), tick);
        this.sentInputs++;
        if (tick % 3 === 0 || tick === FINAL_TICK) {
          this.client.sendState(stateAt(SEED, self.slot, self.car, tick));
          this.sentStates++;
        }
      } catch (error) {
        // A forced reconnect can close the socket in the middle of a burst. That
        // is the expected transport event, not a data error: the tick is skipped
        // and the driver resumes after the token restores the room.
        if (error?.code === ERROR_CODES.NET_NOT_CONNECTED) return;
        this.sendErrors.push({ tick, code: error?.code ?? null, message: String(error?.message || error) });
        throw error;
      }
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function summarizeObserved(rows) {
  return rows.map((row) => ({ ...row, example: row.example ?? null }));
}

async function main() {
  let server = null;
  const clients = [];
  let failed = false;
  const failureDetail = [];
  const observe = [];
  const drivers = [];
  const asyncErrors = [];
  const reconnect = { attempted: false, ok: false, error: null };

  const report = {
    schema: 'blur.net-mvp.harness/1',
    config: {
      players: PLAYERS,
      seconds: SECONDS,
      finalTick: FINAL_TICK,
      seed: SEED,
      reconnectAtSeconds: RECONNECT_AT_SECONDS,
      impairment: { client: 2, channel: 'state', lossRate: 0.01, latencyMs: 80 },
      protocolVersion: 1
    },
    startedAt: new Date(startedAt).toISOString(),
    command: 'node probes/net-mvp/harness.mjs ' + args.join(' '),
    server: null,
    clients: [],
    observations: [],
    checks: {},
    hashes: null,
    passed: false,
    failureDetail: []
  };

  try {
    server = await startRoomServer({ port: 0, log: (event) => log({ event: 'server', ...event }) });
    log({ event: 'server-started', port: server.port, origin: server.origin });
    report.server = { port: server.port, origin: server.origin, wsUrl: server.wsUrl };

    for (let index = 0; index < PLAYERS; index++) {
      const impairment = index === 1
        ? { lossRate: 0.01, latencyMs: 80, seed: 0x51ed270b, channel: 'state' }
        : null;
      const client = new NetClient({
        url: server.wsUrl,
        name: ROSTER[index].name,
        autoReconnect: true,
        impairment
      });
      clients.push(client);
      observe.push({ client: ROSTER[index].name, states: 0, stateMismatches: 0, inputs: 0, inputMismatches: 0, example: null });
      client.on('disconnected', (detail) => log({ event: 'client-disconnected', client: ROSTER[index].name, ...detail }));
      client.on('error', (error) => {
        asyncErrors.push({ client: ROSTER[index].name, error: error?.toJSON?.() ?? { message: String(error) } });
        log({ event: 'client-error', client: ROSTER[index].name, error: error?.toJSON?.() ?? String(error) });
      });
      client.on('fatal', (error) => {
        asyncErrors.push({ client: ROSTER[index].name, fatal: true, error: error?.toJSON?.() ?? { message: String(error) } });
        log({ event: 'client-fatal', client: ROSTER[index].name, error: error?.toJSON?.() ?? String(error) });
      });
      client.on('reconnectAttempt', (detail) => log({ event: 'client-reconnect-attempt', client: ROSTER[index].name, attempt: detail.attempt, error: detail.error?.toJSON?.() ?? String(detail.error) }));
    }

    await Promise.all(clients.map((client) => client.connect()));
    log({ event: 'clients-connected', count: clients.length });

    const created = await clients[0].createRoom({
      name: ROSTER[0].name,
      maxPlayers: PLAYERS,
      map: 'usa_la_river',
      car: ROSTER[0].car
    });
    const code = created.room.code;
    log({ event: 'room-created', code, hostId: created.you.id });

    for (let index = 1; index < clients.length; index++) {
      await clients[index].joinRoom({ code, name: ROSTER[index].name, car: ROSTER[index].car });
    }
    await Promise.all(clients.map((client) => client.setReady(true)));
    log({ event: 'all-ready', code, players: clients.length });

    // Observe every applied snapshot/input and compare it with the deterministic
    // expected value for the sender's slot/car. This is independent of the
    // final table and catches a wrong-source or corrupted application.
    clients.forEach((client, clientIndex) => {
      client.on('stateApplied', ({ from, tick, state }) => {
        const row = observe[clientIndex];
        const sender = client.room?.players.find((player) => player.id === from);
        if (!sender) return;
        const expected = stateAt(SEED, sender.slot, sender.car, tick);
        row.states++;
        if (canonicalJson(expected) !== canonicalJson(state)) {
          row.stateMismatches++;
          if (!row.example) row.example = { kind: 'state', from, tick, expected, received: state };
        }
      });
      client.on('inputApplied', ({ from, tick, input }) => {
        const row = observe[clientIndex];
        const sender = client.room?.players.find((player) => player.id === from);
        if (!sender) return;
        const expected = inputAt(SEED, sender.slot, tick);
        row.inputs++;
        if (canonicalJson(expected) !== canonicalJson(input)) {
          row.inputMismatches++;
          if (!row.example) row.example = { kind: 'input', from, tick, expected, received: input };
        }
      });
    });

    const startedEvents = clients.map((client) => waitEvent(client, 'started', 8000));
    const started = await clients[0].start({ seed: SEED });
    await Promise.all(startedEvents);
    const startWall = nowMs();
    log({ event: 'race-started', seed: started.seed, startTick: started.startTick, finalTick: FINAL_TICK });

    for (let index = 0; index < clients.length; index++) {
      const driver = new Driver(clients[index], index);
      drivers.push(driver);
      driver.start();
    }

    if (PLAYERS > 1) {
      setTimeout(async () => {
        reconnect.attempted = true;
        try {
          log({ event: 'forced-drop-begin', client: ROSTER[1].name });
          const result = await clients[1].simulateDrop();
          reconnect.ok = result.resumed === true;
          log({ event: 'forced-drop-resumed', client: ROSTER[1].name, playerId: result.you.id });
        } catch (error) {
          reconnect.error = error instanceof NetError ? error.toJSON() : { message: String(error?.message || error) };
          log({ event: 'forced-drop-failed', error: reconnect.error });
        }
      }, RECONNECT_AT_MS);
    }

    const timeoutMs = SECONDS * 1000 + 20000;
    const driversDone = Promise.all(drivers.map((driver) => driver.done));
    await Promise.race([
      driversDone,
      new Promise((_, reject) => setTimeout(() => reject(new NetError(ERROR_CODES.NET_TIMEOUT, 'race drivers timed out')), timeoutMs))
    ]);
    await sleep(400); // drain the 80 ms impaired channel and final relay
    log({ event: 'race-drivers-done', elapsedMs: ms(nowMs() - startWall) });

    for (const client of clients) client.finalizeStreams();
    await Promise.all(clients.map((client) => client.waitForStreams(12000)));
    log({ event: 'streams-converged' });

    const tables = clients.map((client) => client.buildFinalTable(FINAL_TICK));
    const hashes = tables.map((table) => finalHash({ seed: SEED, tick: FINAL_TICK, players: table }));
    const finishedEvents = clients.map((client) => waitEvent(client, 'finished', 5000));
    await Promise.all(clients.map((client, index) => client.reportFinished({ tick: FINAL_TICK, hash: hashes[index] })));
    await Promise.all(finishedEvents);
    log({ event: 'room-finished', hashes });

    // ------------------------------------------------------------- checks
    const checks = {};
    checks.playerCount = clients.every((client) => client.room.players.length === PLAYERS);
    checks.roomCodeMatch = clients.every((client) => client.room.code === code);
    checks.hostStable = clients.every((client) => client.hostId === clients[0].playerId) &&
      clients[1].room.hostId === clients[0].playerId;
    checks.hashMatch = hashes.every((hash) => hash === hashes[0]);
    checks.finalTick = tables.every((table) => table.every((player) => player.tick === FINAL_TICK));

    const sequenceRows = [];
    let sequenceOk = true;
    for (let receiverIndex = 0; receiverIndex < clients.length; receiverIndex++) {
      const client = clients[receiverIndex];
      const stats = client.stats();
      for (const sender of clients) {
        if (sender.playerId === client.playerId) continue;
        const stream = stats.streams.find((row) => row.from === sender.playerId && row.channel === 'state');
        const input = stats.streams.find((row) => row.from === sender.playerId && row.channel === 'input');
        const expectedTarget = sender.stats().sent.state;
        const expectedInputTarget = sender.stats().sent.input;
        const row = {
          receiver: ROSTER[receiverIndex].name,
          sender: sender.name,
          target: stream?.target ?? null,
          expectedTarget,
          lastApplied: stream?.lastApplied ?? 0,
          appliedSeqCount: stream?.appliedSeqCount ?? 0,
          duplicates: stream?.duplicates ?? 0,
          outOfOrderBuffered: stream?.outOfOrderBuffered ?? 0,
          violations: stream?.violations ?? 0,
          converged: stream?.converged ?? false,
          inputTarget: input?.target ?? null,
          expectedInputTarget,
          inputLastApplied: input?.lastApplied ?? 0
        };
        if (row.target !== expectedTarget || row.lastApplied !== expectedTarget ||
            row.appliedSeqCount !== expectedTarget || row.lastApplied !== row.appliedSeqCount ||
            row.violations !== 0 || row.converged !== true ||
            row.inputTarget !== expectedInputTarget || row.inputLastApplied !== expectedInputTarget) {
          sequenceOk = false;
        }
        sequenceRows.push(row);
      }
    }
    checks.sequenceComplete = sequenceOk;
    checks.streamsConverged = clients.every((client) => client.streamsConverged());

    const mismatches = observe.reduce((sum, row) => sum + row.stateMismatches + row.inputMismatches, 0);
    checks.appliedPayloadMatchesDeterministic = mismatches === 0;

    const reconnectStats = clients[1]?.stats();
    const resumedPlayer = clients[1]?.room.players.find((player) => player.id === clients[1].playerId);
    checks.reconnectResumed = reconnect.attempted && reconnect.ok &&
      reconnectStats.counters.reconnects === 1 &&
      reconnectStats.counters.forcedDisconnects === 1 &&
      resumedPlayer?.resumedCount === 1;
    checks.reconnectSamePlayer = resumedPlayer?.id === clients[1].playerId && clients[1].room.players.length === PLAYERS;
    const impairment = reconnectStats.impairment;
    checks.lossInjected = impairment !== null && impairment.injectedDrops >= 1;
    checks.latencyObserved = (reconnectStats.rtt.state.count > 0) && (reconnectStats.rtt.state.p50 >= 60);
    checks.noDuplicateApplication = sequenceRows.every((row) => row.lastApplied === row.appliedSeqCount);
    checks.hostAuthoritySequence = sequenceRows
      .filter((row) => row.sender === ROSTER[0].name)
      .every((row) => row.target === row.expectedTarget && row.lastApplied === row.target);
    checks.noAsyncErrors = asyncErrors.length === 0;
    checks.noListenerErrors = clients.every((client) => client.stats().listenerErrors.length === 0);
    checks.noSendErrors = drivers.every((driver) => driver.sendErrors.length === 0);
    const expectedStates = Math.floor(FINAL_TICK / 3) + (FINAL_TICK % 3 === 0 ? 0 : 1);
    checks.expectedMessageCounts = clients.every((client) => {
      const stats = client.stats();
      return stats.sent.state === expectedStates && stats.sent.input === FINAL_TICK;
    });
    checks.heartbeatObserved = clients.every((client) => client.stats().rtt.control.count > 0);
    checks.ackObserved = clients.every((client) => client.stats().rtt.state.count > 0);
    checks.roomPhaseFinished = clients.every((client) => client.room?.phase === 'finished');

    report.server = { ...report.server, stats: server.stats(), snapshot: server.snapshot() };
    report.clients = clients.map((client, index) => ({
      name: ROSTER[index].name,
      car: ROSTER[index].car,
      stats: client.stats(),
      table: tables[index],
      hash: hashes[index],
      driver: { sentStates: drivers[index].sentStates, sentInputs: drivers[index].sentInputs, sendErrors: drivers[index].sendErrors }
    }));
    report.observations = summarizeObserved(observe);
    report.sequences = sequenceRows;
    report.asyncErrors = asyncErrors;
    report.reconnect = reconnect;
    report.hashes = {
      final: hashes[0],
      perClient: hashes.map((hash, index) => ({ client: ROSTER[index].name, hash })),
      deterministicSeed: SEED,
      finalTick: FINAL_TICK
    };
    report.checks = checks;
    report.elapsedMs = Date.now() - startedAt;
    report.passed = Object.values(checks).every(Boolean) && !failureDetail.length;
    report.failureDetail = failureDetail;

    log({ event: 'checks', checks, hash: hashes[0] });
    writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    failed = true;
    const detail = error instanceof NetError ? error.toJSON() : { message: String(error?.stack || error) };
    failureDetail.push(detail);
    log({ event: 'harness-failed', detail });
    console.error('FAIL', JSON.stringify(detail));
    report.passed = false;
    report.failureDetail = failureDetail;
    report.elapsedMs = Date.now() - startedAt;
    try {
      report.clients = clients.map((client, index) => ({ name: ROSTER[index]?.name, stats: client.stats() }));
      report.server = server ? { ...report.server, stats: server.stats(), snapshot: server.snapshot() } : null;
    } catch {}
    writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
  } finally {
    for (const driver of drivers) driver.stop();
    for (const client of clients) client.close();
    if (server) await server.close().catch(() => {});
  }

  if (!failed && report.passed) {
    console.log('PASS net-mvp harness');
    console.log('  clients:      ' + PLAYERS);
    console.log('  final tick:   ' + FINAL_TICK + ' (' + SECONDS + ' s @ 60 Hz)');
    console.log('  final hash:   ' + report.hashes.final);
    console.log('  loss injected:' + report.clients[1]?.stats.impairment.injectedDrops +
      ' (80 ms delayed packets: ' + report.clients[1]?.stats.impairment.delayed + ')');
    console.log('  state RTT:    p50 ' + report.clients[1]?.stats.rtt.state.p50?.toFixed(1) +
      ' / p95 ' + report.clients[1]?.stats.rtt.state.p95?.toFixed(1) + ' ms');
    console.log('  reconnect:    resumed same player, ' + report.clients[1]?.stats.counters.reconnects + ' reconnect');
    console.log('  report:       ' + path.relative(ROOT, REPORT_FILE).split(path.sep).join('/'));
    console.log('  log:          ' + path.relative(ROOT, LOG_FILE).split(path.sep).join('/'));
    return 0;
  }

  console.error('FAIL net-mvp harness');
  const failedChecks = Object.entries(report.checks || {}).filter(([, value]) => !value).map(([name]) => name);
  if (failedChecks.length) console.error('  failed checks: ' + failedChecks.join(', '));
  if (report.failureDetail?.length) console.error('  detail: ' + JSON.stringify(report.failureDetail));
  console.error('  report: ' + path.relative(ROOT, REPORT_FILE).split(path.sep).join('/'));
  return 1;
}

const code = await main();
process.exit(code);
