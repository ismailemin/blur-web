// Capacity / bandwidth gate: 4, 6 and 8 headless clients in one room.
//
//   node probes/net-mvp/capacity.mjs [--players 4,6,8] [--seconds 10]
//
// Each scenario uses a fresh server and a fresh room. The server resets its
// wire counters immediately before the drivers start, and the report records
// per-client inbound/outbound bytes per second, the 20 Hz state payload size,
// the relay/ack fan-out model and an extrapolation to 12/16/20 clients.
//
// Evidence: _work/net-mvp/capacity-report.json
// Log:      _work/logs/net-mvp/capacity.log

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRoomServer } from './server.mjs';
import { NetError } from './client.mjs';
import { ERROR_CODES, STATE_HZ, INPUT_HZ, TICK_HZ } from './protocol.mjs';
import { finalTickForSeconds } from './race.mjs';
import {
  connectClients, openRoom, runToFinish, sequenceRows, bandwidthReport,
  closeClients, rosterFor
} from './scenario.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/net-mvp');
const LOGS = path.join(ROOT, '_work/logs/net-mvp');
mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });
const REPORT_FILE = path.join(OUT, 'capacity-report.json');
const LOG_FILE = path.join(LOGS, 'capacity.log');
writeFileSync(LOG_FILE, '');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const PLAYERS = String(option('--players', '4,6,8')).split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value >= 2 && value <= 20);
const SECONDS = Number(option('--seconds', '10'));
const SEED = option('--seed', 'blur-net-mvp-capacity-v1');
const FINAL_TICK = finalTickForSeconds(SECONDS);
const startedAt = Date.now();

const log = (event) => appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');

function messageSizes() {
  const state = {
    type: 'state', from: 'pl_0000000000000000', channel: 'state', seq: 600, tick: 1800,
    sentAt: 123456.789, authority: false,
    state: { tick: 1800, position: [-19.123456, 0.35, 4.8], quaternion: [0, -0.045453, 0, 0.998966], speed: 22.6 }
  };
  const input = {
    type: 'input', from: 'pl_0000000000000000', channel: 'input', seq: 1800, tick: 1800,
    sentAt: 123456.789, authority: false,
    input: { throttle: 1, brake: 0, steer: 0.1234, handbrake: 0 }
  };
  const ack = {
    type: 'ack', from: 'pl_0000000000000000', to: 'pl_1111111111111111',
    channel: 'state', seq: 600, sentAt: 123456.789
  };
  return {
    state: Buffer.byteLength(JSON.stringify(state)),
    input: Buffer.byteLength(JSON.stringify(input)),
    ack: Buffer.byteLength(JSON.stringify(ack)),
    note: 'JSON text-frame payload bytes; the server reports exact wire bytes including RFC 6455 framing.'
  };
}

function model(sizes, players) {
  const peers = players - 1;
  const perPeerBytesPerSecond = STATE_HZ * sizes.state + INPUT_HZ * sizes.input;
  const ackMessagesPerSecond = peers * (STATE_HZ + INPUT_HZ);
  const ackBytesPerSecond = ackMessagesPerSecond * sizes.ack;
  const perClientInbound = peers * perPeerBytesPerSecond + ackBytesPerSecond;
  const perClientOutbound = perPeerBytesPerSecond + ackBytesPerSecond;
  return {
    players,
    peers,
    perPeerBytesPerSecond,
    ackMessagesPerSecond,
    ackBytesPerSecond,
    perClientInboundBytesPerSecond: perClientInbound,
    perClientOutboundBytesPerSecond: perClientOutbound,
    serverOutboundBytesPerSecond: players * perClientInbound,
    serverInboundBytesPerSecond: players * perClientOutbound
  };
}

async function runScenario(players) {
  const server = await startRoomServer({ port: 0, log: (event) => log({ event: 'server', players, ...event }) });
  const { clients, roster, errors } = await connectClients({ server, players });
  let opened = null;
  let run = null;
  try {
    opened = await openRoom(clients, roster, { maxPlayers: undefined, seed: SEED });
    server.resetBandwidth();
    const cpuStart = process.cpuUsage();
    const wallStart = Date.now();
    run = await runToFinish({ clients, roster, seconds: SECONDS, seed: SEED });
    const cpu = process.cpuUsage(cpuStart);
    const elapsedSeconds = (Date.now() - wallStart) / 1000;
    const sequences = sequenceRows(clients, roster);
    const bandwidth = bandwidthReport(server, clients, run.raceElapsedMs / 1000);
    const stats = server.stats();
    const expectedStates = Math.floor(FINAL_TICK / (TICK_HZ / STATE_HZ)) + (FINAL_TICK % (TICK_HZ / STATE_HZ) === 0 ? 0 : 1);
    const checks = {
      playerCount: clients.every((client) => client.room.players.length === players),
      defaultCapacity: opened.room.maxPlayers === 8,
      hostStable: clients.every((client) => client.hostId === clients[0].playerId),
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
      bandwidthMeasured: bandwidth.perClient.every((row) => row.bytesInPerSecond > 0 && row.bytesOutPerSecond > 0)
    };
    log({ event: 'scenario-finished', players, checks, elapsedSeconds, hash: run.hashes[0] });
    return {
      players,
      requestedMaxPlayers: null,
      roomMaxPlayers: opened.room.maxPlayers,
      seconds: SECONDS,
      finalTick: FINAL_TICK,
      elapsedSeconds: Math.round(elapsedSeconds * 1000) / 1000,
      raceElapsedSeconds: Math.round((run.raceElapsedMs / 1000) * 1000) / 1000,
      hash: run.hashes[0],
      hashes: run.hashes,
      checks: { all: Object.values(checks).every(Boolean), ...checks },
      sequences: {
        ok: sequences.ok,
        rows: sequences.rows.length,
        violations: sequences.rows.reduce((sum, row) => sum + row.violations, 0),
        duplicates: sequences.rows.reduce((sum, row) => sum + row.duplicates, 0)
      },
      bandwidth,
      server: {
        stats: {
          connections: stats.connections,
          messagesIn: stats.messagesIn,
          messagesOut: stats.messagesOut,
          messagesRelayed: stats.messagesRelayed,
          protocolErrors: stats.protocolErrors,
          maxPlayersSeen: stats.maxPlayersSeen,
          roomsCreated: stats.roomsCreated,
          roomsFinished: stats.roomsFinished,
          bytesIn: stats.bytesIn,
          bytesOut: stats.bytesOut,
          byType: stats.byType
        },
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024))
      },
      drivers: run.drivers,
      clientErrors: errors
    };
  } finally {
    closeClients(clients);
    await server.close({ drainMs: 50 }).catch(() => {});
  }
}

async function main() {
  const report = {
    schema: 'blur.net-mvp.capacity/1',
    command: 'node probes/net-mvp/capacity.mjs ' + args.join(' '),
    startedAt: new Date(startedAt).toISOString(),
    config: { players: PLAYERS, seconds: SECONDS, finalTick: FINAL_TICK, seed: SEED },
    messageSizes: messageSizes(),
    model: {
      formula: [
        'perPeerBytesPerSecond = 20*stateBytes + 60*inputBytes',
        'ackMessagesPerSecond = (N-1)*(20+60)',
        'perClientInbound = (N-1)*perPeer + acks',
        'perClientOutbound = perPeer + acks',
        'serverOutbound = N*perClientInbound',
        'serverInbound = N*perClientOutbound'
      ],
      at: Object.fromEntries(PLAYERS.map((players) => [String(players), model(messageSizes(), players)])),
      extrapolated: Object.fromEntries([12, 16, 20].map((players) => [String(players), model(messageSizes(), players)]))
    },
    scenarios: [],
    passed: false,
    elapsedMs: 0
  };
  let failure = null;
  try {
    for (const players of PLAYERS) {
      log({ event: 'scenario-start', players });
      report.scenarios.push(await runScenario(players));
    }
  } catch (error) {
    failure = error instanceof NetError ? error.toJSON() : { message: String(error?.stack || error) };
    log({ event: 'capacity-failed', error: failure });
  }
  report.passed = !failure && report.scenarios.length === PLAYERS.length &&
    report.scenarios.every((scenario) => scenario.checks.all);
  report.failure = failure;
  report.elapsedMs = Date.now() - startedAt;
  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');

  if (report.passed) {
    console.log('PASS net-mvp capacity');
    for (const scenario of report.scenarios) {
      const totals = scenario.bandwidth.totals;
      console.log('  ' + scenario.players + ' clients: ' +
        'per-client out ' + scenario.bandwidth.perClient[0].kbitOutPerSecond + ' kbit/s, in ' +
        scenario.bandwidth.perClient[0].kbitInPerSecond + ' kbit/s; ' +
        'server out ' + Math.round(totals.bytesOutPerSecond / 1000) + ' kB/s; hash ' + scenario.hash.slice(0, 23) + '…');
    }
    console.log('  report: ' + path.relative(ROOT, REPORT_FILE).split(path.sep).join('/'));
    return 0;
  }
  console.error('FAIL net-mvp capacity');
  if (failure) console.error('  ' + JSON.stringify(failure));
  for (const scenario of report.scenarios) {
    const failed = Object.entries(scenario.checks).filter(([, value]) => value === false).map(([name]) => name);
    if (failed.length) console.error('  ' + scenario.players + ' clients failed: ' + failed.join(', '));
  }
  console.error('  report: ' + path.relative(ROOT, REPORT_FILE).split(path.sep).join('/'));
  return 1;
}

process.exit(await main());
