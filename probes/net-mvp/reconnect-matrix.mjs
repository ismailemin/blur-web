// Reconnect / mobile-link matrix.
//
//   node probes/net-mvp/reconnect-matrix.mjs [--seconds 50]
//
// One three-player room through a reverse proxy. Three forced events:
//   1. a clean socket close (`simulateDrop`);
//   2. a 5 s silent stall (no FIN, no data, new connects refused);
//   3. a 15 s silent stall.
//
// The proxy models a mobile radio loss. Both ends must use their heartbeat
// timeout; the client then resumes with the room token. A resume that arrives
// before the server has reaped the old half-open socket gets
// NET_RESUME_IN_USE, which the client retries quickly without consuming the
// normal reconnect budget.
//
// Checks: same player id, no duplicate player, host stable, sequence
// convergence, final hash, every resume inside the 30 s grace window.
//
// Evidence: _work/net-mvp/reconnect-matrix.json
// Log:      _work/logs/net-mvp/reconnect-matrix.log

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRoomServer } from './server.mjs';
import { startReverseProxy } from './proxy.mjs';
import { NetError } from './client.mjs';
import { ERROR_CODES } from './protocol.mjs';
import { finalTickForSeconds } from './race.mjs';
import {
  connectClients, openRoom, runToFinish, sequenceRows, waitEvent, closeClients
} from './scenario.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/net-mvp');
const LOGS = path.join(ROOT, '_work/logs/net-mvp');
mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });
const REPORT_FILE = path.join(OUT, 'reconnect-matrix.json');
const LOG_FILE = path.join(LOGS, 'reconnect-matrix.log');
writeFileSync(LOG_FILE, '');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const PLAYERS = 3;
const SECONDS = Number(option('--seconds', '50'));
const SEED = option('--seed', 'blur-net-mvp-reconnect-v1');
const FINAL_TICK = finalTickForSeconds(SECONDS);
const startedAt = Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (event) => appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
const matrixT0 = Date.now();
const serverEvents = [];
const serverLog = (event) => {
  if (event.event?.startsWith('player-') || event.event?.startsWith('room-') || event.event === 'heartbeat-timeout') {
    serverEvents.push({ atMs: Date.now() - matrixT0, ...event });
  }
  log({ event: 'server', ...event });
};

function counters(client) {
  const stats = client.stats();
  return {
    reconnects: stats.counters.reconnects,
    forcedDisconnects: stats.counters.forcedDisconnects,
    resumeInUseRetries: stats.counters.resumeInUseRetries,
    serverShutdowns: stats.counters.serverShutdowns,
    heartbeatTimeouts: stats.counters.heartbeatTimeouts,
    disconnected: stats.counters.disconnected
  };
}

async function stallScenario({ client, proxy, ms, name }) {
  const playerId = client.playerId;
  const before = counters(client);
  const events = [];
  const t0 = Date.now();
  const offs = [
    client.on('disconnected', (detail) => events.push({
      event: 'disconnected', atMs: Date.now() - t0, code: detail.code, reason: detail.reason
    })),
    client.on('reconnectAttempt', (detail) => events.push({
      event: 'reconnectAttempt', atMs: Date.now() - t0, attempt: detail.attempt, code: detail.error?.code ?? null
    })),
    client.on('resumed', () => events.push({ event: 'resumed', atMs: Date.now() - t0 }))
  ];
  const resumed = waitEvent(client, 'resumed', ms + 25_000);
  const stallPromise = proxy.stall(ms);
  let result = null;
  let error = null;
  try {
    result = await resumed;
  } catch (caught) {
    error = caught instanceof NetError ? caught.toJSON() : { message: String(caught?.message || caught) };
  }
  const resumeMs = Date.now() - t0;
  const stallInfo = await stallPromise;
  for (const off of offs) off();
  const after = counters(client);
  const players = client.room?.players ?? [];
  const self = players.find((player) => player.id === playerId);
  const stallStartMs = t0 - matrixT0;
  const serverDetach = serverEvents.find((event) => event.event === 'player-disconnected' &&
    event.playerId === playerId && event.atMs >= stallStartMs);
  const serverResume = serverEvents.find((event) => event.event === 'player-resumed' &&
    event.playerId === playerId && event.atMs >= stallStartMs);
  const row = {
    name,
    stallRequestedMs: ms,
    stallActualMs: stallInfo.endedAt - stallInfo.startedAt,
    resumeMs,
    detectMs: events.find((event) => event.event === 'disconnected')?.atMs ?? null,
    serverDetachMs: serverDetach ? serverDetach.atMs - (t0 - matrixT0) : null,
    serverResumeMs: serverResume ? serverResume.atMs - (t0 - matrixT0) : null,
    events,
    error,
    resumed: result !== null,
    samePlayerId: client.playerId === playerId,
    playerRowsForId: players.filter((player) => player.id === playerId).length,
    roomPlayers: players.length,
    hostStable: client.hostId === client.room?.players.find((player) => player.slot === 1)?.id,
    resumedCount: self?.resumedCount ?? null,
    countersBefore: before,
    countersAfter: after,
    reconnectDelta: after.reconnects - before.reconnects,
    resumeInUseRetriesDelta: after.resumeInUseRetries - before.resumeInUseRetries,
    proxy: proxy.stats()
  };
  log({ event: 'stall-scenario', ...row });
  return row;
}

async function main() {
  const server = await startRoomServer({ port: 0, log: serverLog });
  const proxy = await startReverseProxy({ targetPort: server.port, log: (event) => log({ event: 'proxy', ...event }) });
  const { clients, roster, errors } = await connectClients({ server, players: PLAYERS, url: proxy.wsUrl });
  const report = {
    schema: 'blur.net-mvp.reconnect-matrix/1',
    command: 'node probes/net-mvp/reconnect-matrix.mjs ' + args.join(' '),
    startedAt: new Date(startedAt).toISOString(),
    config: {
      players: PLAYERS,
      seconds: SECONDS,
      finalTick: FINAL_TICK,
      seed: SEED,
      resumeWindowMs: server.health().limits.resumeWindowMs,
      heartbeatTimeoutMs: server.health().limits.heartbeatTimeoutMs,
      heartbeatIntervalMs: server.health().limits.heartbeatIntervalMs
    },
    server: { port: server.port, origin: server.origin },
    proxy: { port: proxy.port, origin: proxy.origin },
    scenarios: [],
    checks: {},
    passed: false
  };
  let failure = null;
  try {
    const opened = await openRoom(clients, roster, { maxPlayers: PLAYERS, seed: SEED });
    report.room = { code: opened.room.code, maxPlayers: opened.room.maxPlayers };
    const racePromise = runToFinish({ clients, roster, seconds: SECONDS, seed: SEED });
    const target = clients[1];
    const hostId = clients[0].playerId;

    await sleep(2000);
    {
      const playerId = target.playerId;
      const before = counters(target);
      const t0 = Date.now();
      const result = await target.simulateDrop({ timeoutMs: 25_000 });
      const after = counters(target);
      const self = target.room.players.find((player) => player.id === playerId);
      const row = {
        name: 'forced-socket-drop',
        resumeMs: Date.now() - t0,
        resumed: result.resumed === true,
        samePlayerId: target.playerId === playerId,
        playerRowsForId: target.room.players.filter((player) => player.id === playerId).length,
        roomPlayers: target.room.players.length,
        hostStable: target.hostId === hostId,
        resumedCount: self?.resumedCount ?? null,
        reconnectDelta: after.reconnects - before.reconnects
      };
      report.scenarios.push(row);
      log({ event: 'forced-drop', ...row });
    }

    await sleep(1000);
    report.scenarios.push(await stallScenario({ client: target, proxy, ms: 5000, name: '5s-silent-stall' }));
    await sleep(1000);
    report.scenarios.push(await stallScenario({ client: target, proxy, ms: 15_000, name: '15s-silent-stall' }));

    const run = await racePromise;
    const sequences = sequenceRows(clients, roster);
    const hashMatch = run.hashes.every((hash) => hash === run.hashes[0]);
    const finalTick = run.tables.every((table) => table.every((player) => player.tick === FINAL_TICK));
    const allScenarios = report.scenarios.every((row) =>
      row.resumed && row.samePlayerId && row.playerRowsForId === 1 && row.roomPlayers === PLAYERS && row.hostStable);
    const withinWindow = report.scenarios.every((row) => row.resumeMs < report.config.resumeWindowMs);
    const detects = report.scenarios.filter((row) => row.detectMs !== undefined && row.detectMs !== null);
    report.checks = {
      scenariosResumed: allScenarios,
      noDuplicatePlayer: report.scenarios.every((row) => row.playerRowsForId === 1),
      hostStable: report.scenarios.every((row) => row.hostStable),
      withinResumeWindow: withinWindow,
      stalledSocketsDetected: detects.every((row) => row.detectMs > 0 && row.detectMs < 7000),
      samePlayerId: report.scenarios.every((row) => row.samePlayerId),
      hashMatch,
      finalTick,
      sequenceComplete: sequences.ok,
      noClientErrors: errors.length === 0,
      noProtocolErrors: server.stats().protocolErrors === 0,
      roomFinished: clients.every((client) => client.room?.phase === 'finished'),
      proxyUsed: proxy.stats().upgrades >= PLAYERS,
      resumeInUseHandled: report.scenarios.every((row) => (row.resumeInUseRetriesDelta ?? 0) >= 0)
    };
    report.hashes = { final: run.hashes[0], perClient: run.hashes };
    report.sequences = {
      ok: sequences.ok,
      rows: sequences.rows.length,
      violations: sequences.rows.reduce((sum, row) => sum + row.violations, 0),
      duplicates: sequences.rows.reduce((sum, row) => sum + row.duplicates, 0)
    };
    report.server.stats = server.stats();
    report.proxy.stats = proxy.stats();
    report.serverEvents = serverEvents;
    report.clientErrors = errors;
    report.passed = Object.values(report.checks).every(Boolean);
  } catch (error) {
    failure = error instanceof NetError ? error.toJSON() : { message: String(error?.stack || error) };
    log({ event: 'reconnect-matrix-failed', error: failure });
  } finally {
    closeClients(clients);
    await proxy.close().catch(() => {});
    await server.close({ drainMs: 50 }).catch(() => {});
  }
  report.failure = failure;
  report.elapsedMs = Date.now() - startedAt;
  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');

  if (report.passed) {
    console.log('PASS net-mvp reconnect matrix');
    for (const row of report.scenarios) {
      console.log('  ' + row.name + ': resume ' + row.resumeMs + ' ms' +
        (row.detectMs !== undefined && row.detectMs !== null ? ', detected ' + row.detectMs + ' ms' : '') +
        ', same player ' + row.samePlayerId + ', in-use retries ' + (row.resumeInUseRetriesDelta ?? 0));
    }
    console.log('  final hash: ' + report.hashes.final);
    console.log('  report: ' + path.relative(ROOT, REPORT_FILE).split(path.sep).join('/'));
    return 0;
  }
  console.error('FAIL net-mvp reconnect matrix');
  if (failure) console.error('  ' + JSON.stringify(failure));
  for (const [name, value] of Object.entries(report.checks)) if (!value) console.error('  failed: ' + name);
  console.error('  report: ' + path.relative(ROOT, REPORT_FILE).split(path.sep).join('/'));
  return 1;
}

process.exit(await main());
