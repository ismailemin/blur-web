// 8-client 5-minute soak.
//
//   node probes/net-mvp/soak.mjs [--players 8] [--seconds 300]
//
// One room, the maximum supported human count, 60 Hz input + 20 Hz state for
// five minutes, then the normal finalize/converge/hash gate. Memory is sampled
// every 30 s; the report records RSS/heap growth, server message/byte counters
// and any send or listener error.
//
// Evidence: _work/net-mvp/soak-report.json
// Log:      _work/logs/net-mvp/soak.log

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRoomServer } from './server.mjs';
import { NetError } from './client.mjs';
import { ERROR_CODES, STATE_HZ, TICK_HZ } from './protocol.mjs';
import { finalTickForSeconds } from './race.mjs';
import {
  connectClients, openRoom, runToFinish, sequenceRows, bandwidthReport,
  closeClients
} from './scenario.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/net-mvp');
const LOGS = path.join(ROOT, '_work/logs/net-mvp');
mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });
const REPORT_FILE = path.join(OUT, 'soak-report.json');
const LOG_FILE = path.join(LOGS, 'soak.log');
writeFileSync(LOG_FILE, '');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const PLAYERS = Math.max(2, Math.min(20, Number(option('--players', '8'))));
const SECONDS = Number(option('--seconds', '300'));
const SEED = option('--seed', 'blur-net-mvp-soak-v1');
const FINAL_TICK = finalTickForSeconds(SECONDS);
const startedAt = Date.now();
const log = (event) => appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
const mb = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

async function main() {
  const server = await startRoomServer({ port: 0, log: (event) => log({ event: 'server', ...event }) });
  const { clients, roster, errors } = await connectClients({ server, players: PLAYERS });
  const samples = [];
  let sampleTimer = null;
  const report = {
    schema: 'blur.net-mvp.soak/1',
    command: 'node probes/net-mvp/soak.mjs ' + args.join(' '),
    startedAt: new Date(startedAt).toISOString(),
    config: { players: PLAYERS, seconds: SECONDS, finalTick: FINAL_TICK, seed: SEED },
    samples,
    checks: {},
    passed: false,
    elapsedMs: 0
  };
  let failure = null;
  try {
    const opened = await openRoom(clients, roster, { maxPlayers: PLAYERS, seed: SEED });
    report.room = { code: opened.room.code, maxPlayers: opened.room.maxPlayers };
    const baseline = process.memoryUsage();
    samples.push({
      atMs: 0, rssMb: mb(baseline.rss), heapUsedMb: mb(baseline.heapUsed),
      rooms: server.stats().rooms, sessions: server.stats().sessions
    });
    sampleTimer = setInterval(() => {
      const usage = process.memoryUsage();
      const sample = {
        atMs: Date.now() - startedAt,
        rssMb: mb(usage.rss),
        heapUsedMb: mb(usage.heapUsed),
        rooms: server.stats().rooms,
        sessions: server.stats().sessions,
        messagesOut: server.stats().messagesOut,
        bytesOut: server.stats().bytesOut
      };
      samples.push(sample);
      log({ event: 'soak-sample', ...sample });
    }, 30_000);
    sampleTimer.unref?.();

    server.resetBandwidth();
    const cpuStart = process.cpuUsage();
    const wallStart = Date.now();
    log({ event: 'soak-start', players: PLAYERS, seconds: SECONDS });
    const run = await runToFinish({ clients, roster, seconds: SECONDS, seed: SEED });
    const cpu = process.cpuUsage(cpuStart);
    const elapsedSeconds = (Date.now() - wallStart) / 1000;
    const sequences = sequenceRows(clients, roster);
    const bandwidth = bandwidthReport(server, clients, run.raceElapsedMs / 1000);
    const finalMemory = process.memoryUsage();
    const stats = server.stats();
    const expectedStates = Math.floor(FINAL_TICK / (TICK_HZ / STATE_HZ)) + (FINAL_TICK % (TICK_HZ / STATE_HZ) === 0 ? 0 : 1);
    const rssGrowthMb = mb(finalMemory.rss) - mb(baseline.rss);
    report.checks = {
      playerCount: clients.every((client) => client.room.players.length === PLAYERS),
      hashMatch: run.hashes.every((hash) => hash === run.hashes[0]),
      finalTick: run.tables.every((table) => table.every((player) => player.tick === FINAL_TICK)),
      sequenceComplete: sequences.ok,
      expectedMessageCounts: clients.every((client) => {
        const clientStats = client.stats();
        return clientStats.sent.state === expectedStates && clientStats.sent.input === FINAL_TICK;
      }),
      noSendErrors: run.drivers.every((driver) => driver.sendErrors.length === 0),
      noClientErrors: errors.length === 0,
      noProtocolErrors: stats.protocolErrors === 0,
      roomFinished: clients.every((client) => client.room?.phase === 'finished'),
      memoryBounded: rssGrowthMb < 256,
      duration: elapsedSeconds >= SECONDS - 1
    };
    report.hash = run.hashes[0];
    report.hashes = run.hashes;
    report.elapsedSeconds = Math.round(elapsedSeconds * 1000) / 1000;
    report.raceElapsedSeconds = Math.round((run.raceElapsedMs / 1000) * 1000) / 1000;
    report.memory = {
      baseline: { rssMb: mb(baseline.rss), heapUsedMb: mb(baseline.heapUsed) },
      final: { rssMb: mb(finalMemory.rss), heapUsedMb: mb(finalMemory.heapUsed) },
      rssGrowthMb,
      heapGrowthMb: mb(finalMemory.heapUsed) - mb(baseline.heapUsed),
      samples
    };
    report.sequences = {
      ok: sequences.ok,
      rows: sequences.rows.length,
      violations: sequences.rows.reduce((sum, row) => sum + row.violations, 0),
      duplicates: sequences.rows.reduce((sum, row) => sum + row.duplicates, 0)
    };
    report.bandwidth = bandwidth;
    report.server = {
      stats: {
        connections: stats.connections,
        messagesIn: stats.messagesIn,
        messagesOut: stats.messagesOut,
        messagesRelayed: stats.messagesRelayed,
        protocolErrors: stats.protocolErrors,
        roomsCreated: stats.roomsCreated,
        roomsFinished: stats.roomsFinished,
        bytesIn: stats.bytesIn,
        bytesOut: stats.bytesOut,
        maxPlayersSeen: stats.maxPlayersSeen
      },
      cpuMs: Math.round((cpu.user + cpu.system) / 1000)
    };
    report.drivers = run.drivers;
    report.clientErrors = errors;
    report.passed = Object.values(report.checks).every(Boolean);
    log({ event: 'soak-finished', checks: report.checks, hash: run.hashes[0] });
  } catch (error) {
    failure = error instanceof NetError ? error.toJSON() : { message: String(error?.stack || error) };
    log({ event: 'soak-failed', error: failure });
  } finally {
    if (sampleTimer) clearInterval(sampleTimer);
    closeClients(clients);
    await server.close({ drainMs: 50, save: false }).catch(() => {});
  }
  report.failure = failure;
  report.elapsedMs = Date.now() - startedAt;
  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');

  if (report.passed) {
    console.log('PASS net-mvp soak');
    console.log('  clients:   ' + PLAYERS);
    console.log('  seconds:   ' + report.elapsedSeconds);
    console.log('  hash:      ' + report.hash);
    console.log('  RSS:       ' + report.memory.baseline.rssMb + ' -> ' + report.memory.final.rssMb +
      ' MB (Δ ' + report.memory.rssGrowthMb + ')');
    console.log('  server:    ' + report.server.stats.messagesOut + ' out, ' +
      Math.round(report.server.stats.bytesOut / (1024 * 1024)) + ' MB payload');
    console.log('  report:    ' + path.relative(ROOT, REPORT_FILE).split(path.sep).join('/'));
    return 0;
  }
  console.error('FAIL net-mvp soak');
  if (failure) console.error('  ' + JSON.stringify(failure));
  for (const [name, value] of Object.entries(report.checks)) if (!value) console.error('  failed: ' + name);
  console.error('  report: ' + path.relative(ROOT, REPORT_FILE).split(path.sep).join('/'));
  return 1;
}

process.exit(await main());
