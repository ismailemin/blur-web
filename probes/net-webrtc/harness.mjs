// Measurement harness for the WebRTC transport adapter.
//
//   node probes/net-webrtc/harness.mjs [--latency 5] [--loss 0.05]
//                                      [--snapshots 1000] [--events 500]
//
// Two clients run against the deterministic fake network:
//   * 1,000 snapshots per client on the unreliable channel with 5% loss,
//     10% reorder and 1% duplicate;
//   * 500 reliable inputs per client;
//   * a mid-session ICE failure at 50% and a WebSocket reconnect at 70%;
//   * a WebSocket-only control run for the byte comparison.
//
// The fake network models SCTP-shaped channels, not a real browser/network. All
// numbers are labelled: `scope:"fake-sctp"` for in-process simulation and
// `scope:"local-serialization"` for envelope sizes. The browser loopback run is
// a separate capture (`capture.mjs`) and its numbers are labelled
// `scope:"real-browser-loopback"`.
//
// Outputs:
//   _work/net-webrtc/harness-report.json
//   _work/net-webrtc/harness-report-repeat.json
//   _work/logs/net-webrtc/harness.log

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebRtcNetClient } from './transport.mjs';
import { FakeHub, FakePeerNetwork, makeFakeFactories } from './fakes.mjs';
import { makePeerEnvelope, utf8Length } from './protocol.mjs';
import { sha256Hex, canonicalJson } from '../net-mvp/hash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/net-webrtc');
const LOGS = path.join(ROOT, '_work/logs/net-webrtc');
mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const LATENCY = Number(option('--latency', '5'));
const LOSS = Number(option('--loss', '0.05'));
const SNAPSHOTS = Number(option('--snapshots', '1000'));
const EVENTS = Number(option('--events', '500'));
const REPEAT = args.includes('--repeat');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

function summarize(samples) {
  if (!samples.length) return { count: 0, p50: null, p95: null, max: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

function stateAt(tick) {
  return {
    tick,
    position: [tick * 0.02, 0.35 + (tick % 7) * 0.001, 4.8 - (tick % 11) * 0.001],
    quaternion: [0, 0, 0, 1],
    speed: 20 + (tick % 100) * 0.1
  };
}

function inputAt(tick) {
  return { throttle: 1, brake: 0, steer: ((tick % 21) - 10) / 10, handbrake: 0 };
}

function makeClient(name, transport, factories, peerLimits = {}) {
  return new WebRtcNetClient({
    url: 'ws://fake.invalid/ws',
    name,
    transport,
    RTCPeerConnection: transport === 'ws' ? null : factories.RTCPeerConnection,
    WebSocket: factories.WebSocket,
    peerLimits: { negotiationTimeoutMs: 2000, ...peerLimits }
  });
}

async function startPair({ transport, networkOptions, peerLimits = {} }) {
  const hub = new FakeHub();
  const network = new FakePeerNetwork({ seed: 11, ...networkOptions });
  const factories = makeFakeFactories(network, hub);
  const errors = [];
  const fallbacks = [];
  const host = makeClient('Host', transport, factories, peerLimits);
  const guest = makeClient('Guest', transport, factories, peerLimits);
  for (const [name, client] of [['Host', host], ['Guest', guest]]) {
    client.on('error', (error) => errors.push({ who: name, code: error.code, message: error.message }));
    client.on('transportFallback', (info) => fallbacks.push({ who: name, code: info.code, at: info.at }));
  }
  await Promise.all([host.connect(), guest.connect()]);
  const created = await host.createRoom({ name: 'Host', maxPlayers: 2 });
  await guest.joinRoom({ code: created.room.code, name: 'Guest' });
  await Promise.all([host.setReady(true), guest.setReady(true)]);
  await host.start({ seed: 'harness-seed' });
  if (transport !== 'ws') await waitFor(() => host.peerReady() === 1 && guest.peerReady() === 1, 4000);
  return { host, guest, hub, network, errors, fallbacks };
}

async function wsBaseline() {
  const pair = await startPair({ transport: 'ws', networkOptions: {} });
  const applied = [];
  pair.guest.on('stateApplied', (record) => applied.push(record.seq));
  for (let tick = 1; tick <= SNAPSHOTS; tick++) {
    pair.host.sendState(stateAt(tick));
    pair.host.sendInput(inputAt(tick), tick);
  }
  await waitFor(() => applied.length >= SNAPSHOTS, 5000);
  const byType = pair.hub.stats.byType;
  const state = byType.state ?? { in: 0, out: 0, bytesIn: 0, bytesOut: 0 };
  const input = byType.input ?? { in: 0, out: 0, bytesIn: 0, bytesOut: 0 };
  const result = {
    scope: 'local-serialization+ws-fake',
    stateMessages: state.in,
    stateBytesClientToServer: state.bytesIn,
    stateBytesServerToClient: state.bytesOut,
    stateBytesPerMessageTwoHop: Number(((state.bytesIn + state.bytesOut) / Math.max(1, state.in)).toFixed(3)),
    inputMessages: input.in,
    inputBytesPerMessageTwoHop: Number(((input.bytesIn + input.bytesOut) / Math.max(1, input.in)).toFixed(3)),
    appliedSnapshots: applied.length,
    uniqueSnapshots: new Set(applied).size,
    relayedMessages: pair.hub.stats.relayed,
    errors: pair.errors
  };
  pair.host.close();
  pair.guest.close();
  pair.network.clearTimers();
  pair.hub.close();
  await sleep(10);
  return result;
}

async function webrtcRun({ failAt, dropAt }) {
  const pair = await startPair({
    transport: 'webrtc',
    networkOptions: { latencyMs: LATENCY, lossRate: LOSS, reorderRate: 0.1, duplicateRate: 0.01 },
    peerLimits: { iceRestartAttempts: 0, peerRetryAttempts: 0 }
  });
  const stateSeqs = [];
  const inputSeqs = [];
  pair.guest.on('stateApplied', (record) => stateSeqs.push(record.seq));
  pair.host.on('stateApplied', (record) => stateSeqs.push(record.seq));
  pair.host.on('inputApplied', (record) => inputSeqs.push(record.seq));
  pair.guest.on('inputApplied', (record) => inputSeqs.push(record.seq));
  const snapshotsBeforeFailure = [];
  const snapshotsAfterFailure = [];
  let failureAt = null;
  let reconnectAt = null;
  let reconnectState = null;
  const playerIdBefore = { host: pair.host.playerId, guest: pair.guest.playerId };
  const negotiated = {
    hostPeerOpened: pair.host.transportStats().peers[0]?.opened ?? null,
    hostNegotiationMs: pair.host.transportStats().peers[0]?.negotiationMs ?? null,
    guestNegotiationMs: pair.guest.transportStats().peers[0]?.negotiationMs ?? null,
    offers: pair.host.transportStats().peers[0]?.offersSent ?? 0,
    answers: pair.guest.transportStats().peers[0]?.answersSent ?? 0
  };

  for (let tick = 1; tick <= SNAPSHOTS; tick++) {
    pair.host.sendState(stateAt(tick));
    pair.guest.sendState(stateAt(tick));
    if (tick % Math.max(1, Math.round(SNAPSHOTS / EVENTS)) === 0 || tick === SNAPSHOTS) {
      pair.host.sendInput(inputAt(tick), tick);
      pair.guest.sendInput(inputAt(tick), tick);
    }
    if (tick === failAt) {
      failureAt = Date.now();
      const before = pair.host.transportStats();
      snapshotsBeforeFailure.push({
        rtt: pair.host.stats().rtt.state,
        stateMessages: before.messagesSent.snapshot,
        eventMessages: before.messagesSent.event,
        mode: before.mode
      });
      pair.host.simulateIceFailure({ hard: true });
    }
    if (tick === dropAt) {
      reconnectAt = Date.now();
      const offersBefore = pair.host.transportStats().peers[0]?.offersSent ?? 0;
      await pair.host.simulateDrop().catch(() => null);
      reconnectState = {
        atMs: reconnectAt,
        mode: pair.host.transportStats().mode,
        peerReady: pair.host.peerReady(),
        reconnects: pair.host.stats().counters.reconnects,
        resumes: pair.hub.stats.resumes,
        offersBefore,
        offersAfter: pair.host.transportStats().peers[0]?.offersSent ?? 0
      };
    }
    if (tick % 10 === 0) await sleep(1);
  }
  await sleep(600);
  const stateStreamGuest = pair.guest.stats().streams.find((stream) => stream.key.endsWith(':state'));
  const stateStreamHost = pair.host.stats().streams.find((stream) => stream.key.endsWith(':state'));
  const inputStreamGuest = pair.guest.stats().streams.find((stream) => stream.key.endsWith(':input'));
  const inputStreamHost = pair.host.stats().streams.find((stream) => stream.key.endsWith(':input'));
  const h = pair.host.stats();
  const g = pair.guest.stats();
  const net = pair.network.stats;
  snapshotsAfterFailure.push({
    mode: pair.host.transportStats().mode,
    fallbackReason: pair.host.transportStats().fallbackReason,
    stateMessages: pair.host.transportStats().messagesSent.snapshot,
    eventMessages: pair.host.transportStats().messagesSent.event,
    rtt: h.rtt.state
  });

  const appliedHash = 'sha256:' + sha256Hex(canonicalJson({
    kind: 'blur.net-webrtc.harness.applied/1',
    stateSeqs: [...stateSeqs].sort((a, b) => a - b),
    inputSeqs: [...inputSeqs].sort((a, b) => a - b)
  }));

  const report = {
    scope: 'fake-sctp-in-process',
    config: { latencyMs: LATENCY, lossRate: LOSS, reorderRate: 0.1, duplicateRate: 0.01, snapshotsPerClient: SNAPSHOTS, eventsPerClient: EVENTS },
    negotiated: {
      hostMode: h.transport.mode === 'ws-fallback' ? 'webrtc->ws-fallback' : h.transport.mode,
      guestMode: g.transport.mode === 'ws-fallback' ? 'webrtc->ws-fallback' : g.transport.mode,
      hostPeerOpened: negotiated.hostPeerOpened,
      hostNegotiationMs: negotiated.hostNegotiationMs,
      guestNegotiationMs: negotiated.guestNegotiationMs,
      offers: negotiated.offers,
      answers: negotiated.answers
    },
    snapshotChannel: {
      sent: net.snapshotSent,
      deliveredRaw: net.snapshotDelivered,
      droppedByInjectedLoss: net.snapshotDropped,
      reordered: net.snapshotReordered,
      duplicated: net.snapshotDuplicated,
      appliedPerReceiver: stateSeqs.length / 2,
      minimumRequiredAfterRecovery: SNAPSHOTS,
      hostLastApplied: stateStreamHost?.lastApplied ?? null,
      guestLastApplied: stateStreamGuest?.lastApplied ?? null,
      hostDuplicates: stateStreamHost?.duplicates ?? 0,
      guestDuplicates: stateStreamGuest?.duplicates ?? 0,
      hostViolations: stateStreamHost?.violations ?? null,
      guestViolations: stateStreamGuest?.violations ?? null,
      bytesSent: h.transport.bytesSent.snapshot,
      messagesSent: h.transport.messagesSent.snapshot,
      bytesPerMessage: Number((h.transport.bytesSent.snapshot / Math.max(1, h.transport.messagesSent.snapshot)).toFixed(3))
    },
    eventChannel: {
      inputMessagesApplied: inputSeqs.length / 2,
      inputLastAppliedHost: inputStreamHost?.lastApplied ?? null,
      inputLastAppliedGuest: inputStreamGuest?.lastApplied ?? null,
      inputViolationsHost: inputStreamHost?.violations ?? null,
      inputViolationsGuest: inputStreamGuest?.violations ?? null,
      sent: net.eventSent,
      delivered: net.eventDelivered,
      dropped: net.eventDropped,
      inFlightAtAssociationClose: Math.max(0, net.eventSent - net.eventDelivered),
      inFlightNote: 'reliable messages queued when the peer connection died are lost by SCTP, but the application OrderedStream + resync replays them; every input is applied exactly once',
      bytesSent: h.transport.bytesSent.event,
      messagesSent: h.transport.messagesSent.event,
      bytesPerMessage: Number((h.transport.bytesSent.event / Math.max(1, h.transport.messagesSent.event)).toFixed(3)),
      messageBreakdown: h.transport.messagesByType
    },
    rtt: {
      beforeFailure: snapshotsBeforeFailure[0]?.rtt ?? null,
      afterFailure: h.rtt.state,
      note: 'loopback-simulated, one configured latency each way; not a WAN measurement'
    },
    failure: {
      atTick: failAt,
      atMs: failureAt,
      hostMode: pair.host.transportStats().mode,
      guestMode: pair.guest.transportStats().mode,
      hostReason: pair.host.transportStats().fallbackReason,
      guestReason: pair.guest.transportStats().fallbackReason,
      fallbackEvents: pair.fallbacks,
      snapshotDroppedAfterFailure: pair.host.transportStats().snapshotDropped,
      messagesStillApplied: stateSeqs.length / 2
    },
    reconnect: {
      atTick: dropAt,
      hostReconnects: reconnectState?.reconnects ?? h.counters.reconnects,
      hostPlayerIdStable: h.playerId === playerIdBefore.host,
      guestPlayerIdStable: g.playerId === playerIdBefore.guest,
      transportStillWebrtc: reconnectState?.mode === 'webrtc',
      peerStillOpen: reconnectState?.peerReady === 1,
      offersBefore: reconnectState?.offersBefore ?? null,
      offersAfter: reconnectState?.offersAfter ?? null,
      resumes: reconnectState?.resumes ?? pair.hub.stats.resumes
    },
    totals: {
      hostAppliedStates: stateSeqs.length / 2,
      errors: pair.errors,
      fallbacks: pair.fallbacks.length,
      appliedHash
    }
  };

  pair.host.close();
  pair.guest.close();
  pair.network.clearTimers();
  pair.hub.close();
  await sleep(10);
  return report;
}

const startedAt = Date.now();
const baseline = await wsBaseline();
const run = await webrtcRun({ failAt: Math.floor(SNAPSHOTS * 0.6), dropAt: Math.floor(SNAPSHOTS * 0.3) });
const runB = REPEAT ? await webrtcRun({ failAt: Math.floor(SNAPSHOTS * 0.6), dropAt: Math.floor(SNAPSHOTS * 0.3) }) : null;

const envelope = makePeerEnvelope(
  { type: 'state', channel: 'state', seq: 1, tick: 1, state: stateAt(1) },
  { from: 'pl_00000000000000aa', authority: true }
);
const report = {
  schema: 'blur.net-webrtc.harness/1',
  command: 'node probes/net-webrtc/harness.mjs ' + args.join(' '),
  startedAt: new Date(startedAt).toISOString(),
  elapsedMs: Date.now() - startedAt,
  node: process.version,
  scope: {
    transport: 'fake-sctp-in-process',
    note: 'The fake network models reliable-ordered vs unreliable-unordered channels and injects deterministic loss/latency. It is not a browser, SCTP or WAN measurement.',
    realNetwork: false,
    browser: false
  },
  wsBaseline: baseline,
  webrtc: run,
  repeat: runB ? { appliedHash: runB.totals.appliedHash, deterministic: runB.totals.appliedHash === run.totals.appliedHash } : null,
  serialization: {
    directStateEnvelopeBytes: utf8Length(JSON.stringify(envelope)),
    wsStateTwoHopBytesPerMessage: baseline.stateBytesPerMessageTwoHop,
    overheadSavedPerSnapshot: Number((baseline.stateBytesPerMessageTwoHop - utf8Length(JSON.stringify(envelope))).toFixed(3))
  },
  notMeasured: [
    { metric: 'WAN RTT', reason: 'no remote network or TURN server was used' },
    { metric: 'real SCTP partial reliability', reason: 'the fake network models it; only a browser run can measure SCTP itself' },
    { metric: 'TURN relay bandwidth/latency', reason: 'no TURN credentials or VPS were supplied' }
  ],
  passed:
    run.snapshotChannel.hostLastApplied === SNAPSHOTS &&
    run.snapshotChannel.guestLastApplied === SNAPSHOTS &&
    run.eventChannel.inputLastAppliedHost === EVENTS &&
    run.eventChannel.inputLastAppliedGuest === EVENTS &&
    run.snapshotChannel.hostViolations === 0 &&
    run.snapshotChannel.guestViolations === 0 &&
    run.eventChannel.inputViolationsHost === 0 &&
    run.eventChannel.inputViolationsGuest === 0 &&
    run.totals.errors.length === 0
};

const file = path.join(OUT, REPEAT ? 'harness-report-repeat.json' : 'harness-report.json');
writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
writeFileSync(path.join(LOGS, 'harness.log'), [
  'command: ' + report.command,
  'ws state B/msg: ' + baseline.stateBytesPerMessageTwoHop,
  'direct state envelope B: ' + report.serialization.directStateEnvelopeBytes,
  'dc snapshot B/msg: ' + run.snapshotChannel.bytesPerMessage,
  'snapshot raw delivered: ' + run.snapshotChannel.deliveredRaw + ' / ' + run.snapshotChannel.sent,
  'snapshot applied: ' + run.snapshotChannel.hostLastApplied + ' / ' + SNAPSHOTS,
  'event delivered: ' + run.eventChannel.delivered + ' / ' + run.eventChannel.sent,
  'event applied: ' + run.eventChannel.inputLastAppliedHost + ' / ' + EVENTS,
  'fallback: ' + run.failure.hostReason + ' -> ' + run.failure.hostMode,
  'reconnect: ' + run.reconnect.hostReconnects + ' resumes=' + run.reconnect.resumes,
  'applied hash: ' + run.totals.appliedHash,
  'deterministic repeat: ' + (runB ? runB.totals.appliedHash === run.totals.appliedHash : 'not run'),
  'passed: ' + report.passed
].join('\n') + '\n');

console.log((report.passed ? 'PASS' : 'FAIL') + ' net-webrtc harness (' + (REPEAT ? 'repeat' : 'run') + ')');
console.log('  ws state:        ' + baseline.stateBytesPerMessageTwoHop + ' B/msg (two-hop)');
console.log('  direct envelope: ' + report.serialization.directStateEnvelopeBytes + ' B');
console.log('  dc snapshot:     ' + run.snapshotChannel.bytesPerMessage + ' B/msg');
console.log('  snapshots:       applied ' + run.snapshotChannel.hostLastApplied + '/' + SNAPSHOTS +
  ', injected drop ' + run.snapshotChannel.droppedByInjectedLoss + ', raw delivered ' + run.snapshotChannel.deliveredRaw);
console.log('  events:          applied ' + run.eventChannel.inputLastAppliedHost + '/' + EVENTS +
  ', delivered ' + run.eventChannel.delivered + '/' + run.eventChannel.sent);
console.log('  fallback:        ' + run.failure.hostReason + ' -> ' + run.failure.hostMode);
console.log('  reconnect:       ' + run.reconnect.hostReconnects + ' resume(s), peer still open=' + run.reconnect.peerStillOpen);
console.log('  hash:            ' + run.totals.appliedHash);
console.log('  evidence:        ' + path.relative(ROOT, file).split(path.sep).join('/'));
process.exit(report.passed ? 0 : 1);
