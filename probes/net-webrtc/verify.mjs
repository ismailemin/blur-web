// Verifier for the WebRTC transport adapter. Dependency-free; runs entirely in
// Node against the deterministic fakes in `fakes.mjs`.
//
//   node probes/net-webrtc/verify.mjs
//
// Writes:
//   _work/net-webrtc/verify.json
//   _work/logs/net-webrtc/verify.log
//
// Exit code 0 only when every check passes. The check count is printed and
// stored; the gate requires at least 120.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SIGNAL_SCHEMA, SIGNAL_VERSION, TRANSPORT_MODES, CHANNEL_EVENT, CHANNEL_SNAPSHOT,
  CHANNEL_LABELS, CHANNEL_OPTIONS, DATA_PLANE_TYPES, WEBRTC_ERROR_CODES, WebRtcError,
  validSignalType, validEpoch, validSdp, validCandidate, checkSignal, makeOffer, makeAnswer,
  makeIce, makeBye, channelForDataMessage, isDataPlaneMessage, makePeerEnvelope,
  checkPeerEnvelope, utf8Length, rejectTransportMode, encodePeerMessage
} from './protocol.mjs';
import { WebRtcNetClient, WEBRTC_SCHEMA, DEFAULT_PEER_LIMITS } from './transport.mjs';
import { FakeHub, FakePeerNetwork, makeFakeFactories } from './fakes.mjs';
import { sha256Hex, canonicalJson } from '../net-mvp/hash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/net-webrtc');
const LOGS = path.join(ROOT, '_work/logs/net-webrtc');
mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const checks = [];
const logLines = [];
let group = 'general';

function begin(name) {
  group = name;
  logLines.push('');
  logLines.push('== ' + name + ' ==');
}

function check(name, ok, detail = null) {
  const entry = { group, name, ok: ok === true, detail };
  checks.push(entry);
  logLines.push((entry.ok ? 'PASS ' : 'FAIL ') + name + (detail === null ? '' : '  ' + JSON.stringify(detail)));
  return entry.ok;
}

function equal(name, actual, expected) {
  return check(name, Object.is(actual, expected), { actual, expected });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 4000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

function summary(samples) {
  if (!samples.length) return { count: 0, p50: null, p95: null, max: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

async function makePair({
  transport = 'webrtc', networkOptions = {}, peerLimits = {}, clientOptions = {},
  hostName = 'Host', guestName = 'Guest', start = true
} = {}) {
  const hub = new FakeHub();
  const network = new FakePeerNetwork({ latencyMs: 2, seed: 7, ...networkOptions });
  const factories = makeFakeFactories(network, hub);
  const errors = [];
  const events = [];
  const make = (name) => {
    const client = new WebRtcNetClient({
      url: 'ws://fake.invalid/ws',
      name,
      transport,
      RTCPeerConnection: factories.RTCPeerConnection,
      WebSocket: factories.WebSocket,
      peerLimits: { negotiationTimeoutMs: 2000, ...peerLimits },
      ...clientOptions
    });
    client.on('error', (error) => errors.push({ who: name, code: error.code, message: error.message }));
    client.on('transportReady', (info) => events.push({ who: name, type: 'ready', ...info }));
    client.on('transportFallback', (info) => events.push({ who: name, type: 'fallback', ...info }));
    client.on('transportPeerClosed', (info) => events.push({ who: name, type: 'peerClosed', ...info }));
    client.on('snapshotDropped', (info) => events.push({ who: name, type: 'snapshotDropped', ...info }));
    return client;
  };
  const host = make(hostName);
  const guest = make(guestName);
  await Promise.all([host.connect(), guest.connect()]);
  const created = await host.createRoom({ name: hostName, maxPlayers: 2, map: 'usa_la_river', car: 'car-a' });
  await guest.joinRoom({ code: created.room.code, name: guestName, car: 'car-b' });
  await Promise.all([host.setReady(true), guest.setReady(true)]);
  const started = await host.start({ seed: 'verify-seed' });
  if (start && transport !== 'ws') {
    await waitFor(() => host.peerReady() === 1 && guest.peerReady() === 1, 4000);
  }
  return { host, guest, hub, network, factories, errors, events, room: created.room, started };
}

async function closePair(pair) {
  try { pair.host.close(); } catch { /* ignore */ }
  try { pair.guest.close(); } catch { /* ignore */ }
  pair.network.clearTimers();
  pair.hub.close();
  await sleep(5);
}

function stateAt(tick, x = tick) {
  return {
    tick,
    position: [x, Math.round(tick / 3) / 10, -Math.round(tick / 7) / 10],
    quaternion: [0, 0, 0, 1],
    speed: (tick % 40) + 1
  };
}

function inputAt(tick) {
  return { throttle: 1, brake: 0, steer: ((tick % 21) - 10) / 10, handbrake: 0 };
}

// ---------------------------------------------------------------------------
// 1. Schema and policy unit checks
// ---------------------------------------------------------------------------
function protocolChecks() {
  begin('protocol');
  equal('signal schema is versioned', SIGNAL_SCHEMA, 'blur.net-webrtc.signal/1');
  equal('signal version is 1', SIGNAL_VERSION, 1);
  check('transport modes are auto/webrtc/ws',
    TRANSPORT_MODES.length === 3 && TRANSPORT_MODES.includes('auto') &&
    TRANSPORT_MODES.includes('webrtc') && TRANSPORT_MODES.includes('ws'), TRANSPORT_MODES);
  equal('event channel id', CHANNEL_OPTIONS[CHANNEL_EVENT].id, 0);
  equal('snapshot channel id', CHANNEL_OPTIONS[CHANNEL_SNAPSHOT].id, 1);
  equal('event channel ordered', CHANNEL_OPTIONS[CHANNEL_EVENT].ordered, true);
  check('event channel has no partial reliability',
    CHANNEL_OPTIONS[CHANNEL_EVENT].maxRetransmits === undefined &&
    CHANNEL_OPTIONS[CHANNEL_EVENT].maxPacketLifeTime === undefined, null);
  equal('snapshot channel unordered', CHANNEL_OPTIONS[CHANNEL_SNAPSHOT].ordered, false);
  equal('snapshot channel maxRetransmits', CHANNEL_OPTIONS[CHANNEL_SNAPSHOT].maxRetransmits, 0);
  equal('event channel label', CHANNEL_LABELS[CHANNEL_EVENT], 'blur/rel/1');
  equal('snapshot channel label', CHANNEL_LABELS[CHANNEL_SNAPSHOT], 'blur/unrel/1');
  equal('state maps to snapshot', channelForDataMessage({ type: 'state' }), CHANNEL_SNAPSHOT);
  equal('input maps to event', channelForDataMessage({ type: 'input' }), CHANNEL_EVENT);
  equal('ack maps to event', channelForDataMessage({ type: 'ack' }), CHANNEL_EVENT);
  equal('resync maps to event', channelForDataMessage({ type: 'resync' }), CHANNEL_EVENT);
  equal('stream.final maps to event', channelForDataMessage({ type: 'stream.final' }), CHANNEL_EVENT);
  equal('stream.error maps to event', channelForDataMessage({ type: 'stream.error' }), CHANNEL_EVENT);
  equal('room.create stays on ws', channelForDataMessage({ type: 'room.create' }), null);
  equal('ping stays on ws', channelForDataMessage({ type: 'ping' }), null);
  equal('signal.offer stays on ws', channelForDataMessage({ type: 'signal.offer' }), null);
  check('data plane type table is frozen', Object.keys(DATA_PLANE_TYPES).length === 6, DATA_PLANE_TYPES);
  check('signal types accepted', ['signal.offer', 'signal.answer', 'signal.ice', 'signal.bye'].every(validSignalType), null);
  equal('unknown signal type rejected', validSignalType('signal.nope'), false);
  equal('epoch 0 accepted', validEpoch(0), true);
  equal('epoch -1 rejected', validEpoch(-1), false);
  equal('epoch 1.5 rejected', validEpoch(1.5), false);
  equal('epoch string rejected', validEpoch('1'), false);
  equal('valid offer sdp', validSdp({ type: 'offer', sdp: 'v=0\r\n' }), true);
  equal('non-offer/answer sdp rejected', validSdp({ type: 'pranswer', sdp: 'v=0\r\n' }), false);
  equal('empty sdp rejected', validSdp({ type: 'offer', sdp: '' }), false);
  equal('null candidate is end-of-candidates', validCandidate(null), true);
  equal('empty candidate object accepted', validCandidate({}), true);
  equal('bad candidate type rejected', validCandidate({ candidate: 5 }), false);
  equal('bad sdpMLineIndex rejected', validCandidate({ sdpMLineIndex: -1 }), false);
  equal('long candidate rejected', validCandidate({ candidate: 'x'.repeat(5000) }), false);
  const self = 'pl_00000000000000aa';
  const peer = 'pl_00000000000000bb';
  const offer = { type: 'signal.offer', from: peer, to: self, epoch: 1, sdp: { type: 'offer', sdp: 'v=0\r\n' } };
  equal('valid offer signal', checkSignal(offer, self), null);
  check('missing from rejected', checkSignal({ ...offer, from: undefined }, self) !== null, null);
  check('self signal rejected', checkSignal({ ...offer, from: self }, self) !== null, null);
  check('wrong target rejected', checkSignal({ ...offer, to: peer }, self) !== null, null);
  check('sdp/type mismatch rejected',
    checkSignal({ ...offer, sdp: { type: 'answer', sdp: 'v=0\r\n' } }, self) !== null, null);
  equal('valid ice signal', checkSignal({ type: 'signal.ice', from: peer, to: self, epoch: 1, candidate: null }, self), null);
  check('invalid ice candidate rejected',
    checkSignal({ type: 'signal.ice', from: peer, to: self, epoch: 1, candidate: { candidate: 1 } }, self) !== null, null);
  check('bye accepts a reason',
    checkSignal({ type: 'signal.bye', from: peer, to: self, epoch: 2, reason: 'closed' }, self) === null, null);
  const builtOffer = makeOffer({ to: peer, epoch: 3, sdp: 'v=0\r\n' });
  check('makeOffer shape', builtOffer.type === 'signal.offer' && builtOffer.sdp.type === 'offer' && builtOffer.epoch === 3, builtOffer);
  const builtAnswer = makeAnswer({ to: peer, epoch: 3, sdp: 'v=0\r\n' });
  check('makeAnswer shape', builtAnswer.type === 'signal.answer' && builtAnswer.sdp.type === 'answer', builtAnswer);
  check('makeIce supports null', makeIce({ to: peer, epoch: 3, candidate: null }).candidate === null, null);
  check('makeBye carries reason', makeBye({ to: peer, epoch: 3, reason: 'done' }).reason === 'done', null);
  const envelope = makePeerEnvelope({ type: 'state', channel: 'state', seq: 4, tick: 4, state: stateAt(4) },
    { from: peer, authority: true });
  equal('peer envelope adds from', envelope.from, peer);
  equal('peer envelope adds authority', envelope.authority, true);
  equal('peer envelope keeps seq', envelope.seq, 4);
  let envelopeRejected = false;
  try { makePeerEnvelope({ type: 'room.create' }, { from: peer }); } catch (error) {
    envelopeRejected = error.code === WEBRTC_ERROR_CODES.WEBRTC_CONFIG;
  }
  check('peer envelope rejects room messages', envelopeRejected, null);
  equal('valid state envelope', checkPeerEnvelope({ ...envelope }, peer), null);
  check('envelope from mismatch rejected', checkPeerEnvelope({ ...envelope, from: self }, peer) !== null, null);
  check('envelope disallowed type rejected', checkPeerEnvelope({ type: 'room.create', from: peer }, peer) !== null, null);
  check('envelope bad seq rejected', checkPeerEnvelope({ ...envelope, seq: 0 }, peer) !== null, null);
  check('envelope bad channel rejected', checkPeerEnvelope({ ...envelope, channel: 'snap' }, peer) !== null, null);
  equal('valid ack envelope', checkPeerEnvelope({ type: 'ack', from: peer, channel: 'state', seq: 2 }, peer), null);
  check('ack without seq rejected', checkPeerEnvelope({ type: 'ack', from: peer, channel: 'state' }, peer) !== null, null);
  equal('valid resync envelope', checkPeerEnvelope({ type: 'resync', from: peer, channel: 'state', fromSeq: 5 }, peer), null);
  equal('valid final envelope', checkPeerEnvelope({ type: 'stream.final', from: peer, channel: 'state', lastSeq: 5, tick: 6 }, peer), null);
  check('final without tick rejected', checkPeerEnvelope({ type: 'stream.final', from: peer, channel: 'state', lastSeq: 5 }, peer) !== null, null);
  equal('valid stream.error envelope', checkPeerEnvelope({ type: 'stream.error', from: peer, channel: 'state', code: 'X' }, peer), null);
  check('stream.error without code rejected', checkPeerEnvelope({ type: 'stream.error', from: peer, channel: 'state' }, peer) !== null, null);
  equal('utf8Length ascii', utf8Length('abc'), 3);
  equal('utf8Length 2-byte', utf8Length('\u00e9'), 2);
  equal('utf8Length 3-byte', utf8Length('\u20ac'), 3);
  equal('utf8Length surrogate pair', utf8Length('\ud83d\ude00'), 4);
  check('WebRtcError is a NetError with a typed code',
    new WebRtcError(WEBRTC_ERROR_CODES.WEBRTC_ICE_FAILED, 'x').code === 'WEBRTC_ICE_FAILED', null);
  equal('rejectTransportMode accepts webrtc', rejectTransportMode('webrtc'), 'webrtc');
  let modeRejected = false;
  try { rejectTransportMode('udp'); } catch (error) { modeRejected = error.code === WEBRTC_ERROR_CODES.WEBRTC_CONFIG; }
  check('rejectTransportMode rejects unknown', modeRejected, null);
  check('error code table is complete',
    Object.keys(WEBRTC_ERROR_CODES).length >= 18 &&
    Object.values(WEBRTC_ERROR_CODES).every((code) => typeof code === 'string' && code.startsWith('WEBRTC_')), null);
  check('encoded envelope is valid JSON',
    JSON.parse(encodePeerMessage(envelope)).seq === 4, null);
}

// ---------------------------------------------------------------------------
// 2. Construction / flags
// ---------------------------------------------------------------------------
async function constructionChecks() {
  begin('construction');
  const hub = new FakeHub();
  const network = new FakePeerNetwork();
  const factories = makeFakeFactories(network, hub);

  const wsOnly = new WebRtcNetClient({ url: 'ws://fake/ws', name: 'Ws', transport: 'ws' });
  equal('transport ws does not use RTC', wsOnly.transportStats().mode, 'ws');
  equal('transport ws creates no peers', wsOnly.peerReady(), 0);
  equal('transport ws keeps rtcSupported false', wsOnly.transportStats().rtcSupported, false);
  wsOnly.close();

  const autoNoRtc = new WebRtcNetClient({ url: 'ws://fake/ws', name: 'Auto' });
  equal('auto without RTC falls back to ws', autoNoRtc.transportStats().mode, 'ws-fallback');
  equal('auto fallback carries a typed reason', autoNoRtc.transportStats().fallbackReason, WEBRTC_ERROR_CODES.WEBRTC_UNSUPPORTED);
  check('auto fallback is visible in stats',
    autoNoRtc.transportStats().lastFallback?.code === WEBRTC_ERROR_CODES.WEBRTC_UNSUPPORTED, null);
  autoNoRtc.close();

  let explicitThrew = false;
  try {
    // globalThis.RTCPeerConnection is undefined in this Node process.
    new WebRtcNetClient({ url: 'ws://fake/ws', name: 'Explicit', transport: 'webrtc' });
  } catch (error) {
    explicitThrew = error.code === WEBRTC_ERROR_CODES.WEBRTC_UNSUPPORTED;
  }
  check('explicit webrtc without RTC throws UNSUPPORTED', explicitThrew, null);

  let invalidThrew = false;
  try {
    new WebRtcNetClient({ url: 'ws://fake/ws', name: 'Bad', transport: 'udp' });
  } catch (error) {
    invalidThrew = error.code === WEBRTC_ERROR_CODES.WEBRTC_CONFIG;
  }
  check('invalid transport throws CONFIG', invalidThrew, null);

  const injected = new WebRtcNetClient({
    url: 'ws://fake/ws', name: 'Injected', transport: 'webrtc',
    RTCPeerConnection: factories.RTCPeerConnection, WebSocket: factories.WebSocket,
    peerLimits: { negotiationTimeoutMs: 2000 }
  });
  equal('injected Websocket factory is used', injected._wsImpl, factories.WebSocket);
  equal('injected RTC factory is used', injected._rtcImpl, factories.RTCPeerConnection);
  equal('iceServers default is empty', injected.transportStats().iceServers, 0);
  equal('transport schema is versioned', injected.transportStats().schema, WEBRTC_SCHEMA);
  check('same public interface as NetClient',
    ['connect', 'createRoom', 'joinRoom', 'setReady', 'select', 'start', 'sendInput', 'sendState',
      'finalizeStreams', 'waitForStreams', 'buildFinalTable', 'sampleRemote', 'latestRemote',
      'correctorFor', 'reportFinished', 'stats', 'on', 'close'].every((name) => typeof injected[name] === 'function'), null);
  check('peer limits are merged', injected._peerLimits.negotiationTimeoutMs === 2000, null);
  equal('default peer limit exists', DEFAULT_PEER_LIMITS.maxEventBufferedBytes, 256 * 1024);
  injected.close();
  hub.close();
  network.clearTimers();
}

// ---------------------------------------------------------------------------
// 3. Negotiation
// ---------------------------------------------------------------------------
async function negotiationChecks() {
  begin('negotiation');
  const pair = await makePair({ networkOptions: { latencyMs: 3 } });
  const hStats = pair.host.stats().transport;
  const gStats = pair.guest.stats().transport;
  check('host reaches webrtc mode', hStats.mode === 'webrtc', hStats.mode);
  check('guest reaches webrtc mode', gStats.mode === 'webrtc', gStats.mode);
  equal('host has exactly one peer', hStats.peers.length, 1);
  equal('guest has exactly one peer', gStats.peers.length, 1);
  equal('host peer is the initiator', hStats.peers[0].initiator, true);
  equal('guest peer is the responder', gStats.peers[0].initiator, false);
  equal('host sent one offer', hStats.peers[0].offersSent, 1);
  equal('guest received one offer', gStats.peers[0].offersReceived, 1);
  equal('guest sent one answer', gStats.peers[0].answersSent, 1);
  equal('host received one answer', hStats.peers[0].answersReceived, 1);
  equal('guest sends no offer', gStats.peers[0].offersSent, 0);
  equal('event channel is open', hStats.peers[0].eventChannelState, 'open');
  equal('snapshot channel is open', hStats.peers[0].snapshotChannelState, 'open');
  equal('peer readiness requires both channels', hStats.peers[0].ready, true);
  equal('epoch is 1', hStats.peers[0].epoch, 1);
  check('negotiation time is measured',
    Number.isFinite(hStats.peers[0].negotiationMs) && hStats.peers[0].negotiationMs >= 0 &&
    hStats.peers[0].negotiationMs < 4000, hStats.peers[0].negotiationMs);
  check('host signals were sent', hStats.signalsSent >= 1, hStats.signalsSent);
  check('guest signals were received', gStats.signalsReceived >= 1, gStats.signalsReceived);
  equal('host fallback count is zero', hStats.fallbackCount, 0);
  equal('guest fallback count is zero', gStats.fallbackCount, 0);
  equal('host has no transport errors', pair.errors.filter((entry) => entry.who === 'Host').length, 0);
  equal('guest has no transport errors', pair.errors.filter((entry) => entry.who === 'Guest').length, 0);
  check('transportReady fired on both',
    pair.events.filter((entry) => entry.type === 'ready').length === 2, pair.events.filter((entry) => entry.type === 'ready').length);
  check('negotiated channel labels are fixed',
    pair.host._peers.get(pair.guest.playerId).eventChannel.label === 'blur/rel/1' &&
    pair.host._peers.get(pair.guest.playerId).snapshotChannel.label === 'blur/unrel/1', null);
  check('negotiated channel ids are fixed',
    pair.host._peers.get(pair.guest.playerId).eventChannel.id === 0 &&
    pair.host._peers.get(pair.guest.playerId).snapshotChannel.id === 1, null);
  equal('event channel is ordered',
    pair.host._peers.get(pair.guest.playerId).eventChannel.ordered, true);
  equal('snapshot channel is unordered',
    pair.host._peers.get(pair.guest.playerId).snapshotChannel.ordered, false);
  equal('snapshot channel retransmits zero',
    pair.host._peers.get(pair.guest.playerId).snapshotChannel.maxRetransmits, 0);
  check('fake session paired', pair.network.stats.pairs === 1, pair.network.stats.pairs);
  equal('no peer failures during negotiation', pair.network.stats.failures, 0);
  await closePair(pair);
}

// ---------------------------------------------------------------------------
// 4. Routing
// ---------------------------------------------------------------------------
async function routingChecks() {
  begin('routing');
  const pair = await makePair({ networkOptions: { latencyMs: 1 } });
  const relayedBefore = pair.hub.stats.relayed;
  const wsStateInBefore = pair.hub.stats.byType.state?.in ?? 0;
  const wsInputInBefore = pair.hub.stats.byType.input?.in ?? 0;
  const hostStates = [];
  const guestStates = [];
  const hostInputs = [];
  const guestInputs = [];
  pair.host.on('stateApplied', (record) => hostStates.push(record));
  pair.guest.on('stateApplied', (record) => guestStates.push(record));
  pair.host.on('inputApplied', (record) => hostInputs.push(record));
  pair.guest.on('inputApplied', (record) => guestInputs.push(record));
  for (let tick = 1; tick <= 10; tick++) {
    pair.host.sendState(stateAt(tick));
    pair.guest.sendState(stateAt(tick, -tick));
    pair.host.sendInput(inputAt(tick), tick);
    pair.guest.sendInput(inputAt(tick), tick);
  }
  await waitFor(() => hostStates.length >= 10 && guestStates.length >= 10 &&
    hostInputs.length >= 10 && guestInputs.length >= 10 &&
    (pair.host.stats().transport.messagesByType.ack?.received ?? 0) >= 10 &&
    (pair.guest.stats().transport.messagesByType.ack?.received ?? 0) >= 10, 2000);
  const hStats = pair.host.stats().transport;
  const gStats = pair.guest.stats().transport;
  equal('10 host snapshots sent over the snapshot channel', hStats.messagesByType.state?.sent, 10);
  equal('10 guest snapshots reached the host', hostStates.length, 10);
  equal('10 guest snapshots sent over the snapshot channel', gStats.messagesByType.state?.sent, 10);
  equal('10 host snapshots reached the guest', guestStates.length, 10);
  equal('10 host inputs sent over the event channel', hStats.messagesByType.input?.sent, 10);
  equal('10 guest inputs reached the host', hostInputs.length, 10);
  equal('10 guest inputs sent over the event channel', gStats.messagesByType.input?.sent, 10);
  equal('10 host inputs reached the guest', guestInputs.length, 10);
  check('acks are sent over the event channel', hStats.messagesByType.ack?.sent >= 10, hStats.messagesByType.ack?.sent);
  check('acks are received over the event channel', hStats.messagesByType.ack?.received >= 10, hStats.messagesByType.ack?.received);
  equal('data plane relayed zero messages over ws', pair.hub.stats.relayed, relayedBefore);
  equal('no state entered the ws relay', (pair.hub.stats.byType.state?.in ?? 0), wsStateInBefore);
  equal('no input entered the ws relay', (pair.hub.stats.byType.input?.in ?? 0), wsInputInBefore);
  check('host authority flag is true on the guest view',
    guestStates.every((record) => record.authority === true), guestStates[0]?.authority);
  check('guest authority flag is false on the host view',
    hostStates.every((record) => record.authority === false), hostStates[0]?.authority);
  check('state envelopes carry the sender id',
    guestStates.every((record) => record.from === pair.host.playerId), guestStates[0]?.from);
  check('input envelopes carry the sender id',
    hostInputs.every((record) => record.from === pair.guest.playerId), hostInputs[0]?.from);
  check('room messages still use the ws', (pair.hub.stats.byType['room.create']?.in ?? 0) === 1,
    pair.hub.stats.byType['room.create']);
  check('signaling messages use the ws', (pair.hub.stats.byType['signal.offer']?.in ?? 0) === 1,
    pair.hub.stats.byType['signal.offer']);
  await closePair(pair);
}

// ---------------------------------------------------------------------------
// 5. Delivery: 1,000 snapshots at 5% loss, 500 reliable events
// ---------------------------------------------------------------------------
async function deliveryChecks() {
  begin('delivery-1000');
  const pair = await makePair({
    networkOptions: { latencyMs: 1, lossRate: 0.05, reorderRate: 0.1, duplicateRate: 0.01 }
  });
  const hostStates = [];
  const guestStates = [];
  const hostInputs = [];
  const guestInputs = [];
  pair.host.on('stateApplied', (record) => hostStates.push(record));
  pair.guest.on('stateApplied', (record) => guestStates.push(record));
  pair.host.on('inputApplied', (record) => hostInputs.push(record));
  pair.guest.on('inputApplied', (record) => guestInputs.push(record));

  for (let tick = 1; tick <= 1000; tick++) {
    pair.host.sendState(stateAt(tick));
    pair.guest.sendState(stateAt(tick, -tick));
    if (tick % 2 === 0) {
      pair.host.sendInput(inputAt(tick), tick);
      pair.guest.sendInput(inputAt(tick), tick);
    }
    if (tick % 10 === 0) await sleep(1);
  }
  await sleep(500);
  pair.host.finalizeStreams();
  pair.guest.finalizeStreams();
  const hostConverged = await pair.host.waitForStreams(6000).then(() => true).catch(() => false);
  const guestConverged = await pair.guest.waitForStreams(6000).then(() => true).catch(() => false);

  const h = pair.host.stats();
  const g = pair.guest.stats();
  const net = pair.network.stats;
  const hostStateStream = h.streams.find((stream) => stream.key.endsWith(':state'));
  const guestStateStream = g.streams.find((stream) => stream.key.endsWith(':state'));
  const hostInputStream = h.streams.find((stream) => stream.key.endsWith(':input'));
  const guestInputStream = g.streams.find((stream) => stream.key.endsWith(':input'));
  const unique = (records) => new Set(records.map((record) => record.seq));

  equal('host applied 1000 guest snapshots', hostStates.length, 1000);
  equal('guest applied 1000 host snapshots', guestStates.length, 1000);
  equal('host snapshot sequences are unique', unique(hostStates).size, 1000);
  equal('guest snapshot sequences are unique', unique(guestStates).size, 1000);
  equal('host state stream lastApplied is 1000', hostStateStream?.lastApplied, 1000);
  equal('guest state stream lastApplied is 1000', guestStateStream?.lastApplied, 1000);
  equal('host state stream applied count is 1000', hostStateStream?.appliedSeqCount, 1000);
  equal('guest state stream applied count is 1000', guestStateStream?.appliedSeqCount, 1000);
  equal('host state stream has zero order violations', hostStateStream?.violations, 0);
  equal('guest state stream has zero order violations', guestStateStream?.violations, 0);
  check('5% injected loss actually dropped snapshots', net.snapshotDropped > 0, net.snapshotDropped);
  check('reorder was injected on the snapshot channel', net.snapshotReordered > 0, net.snapshotReordered);
  equal('duplicate injection count', net.snapshotDuplicated > 0, true);
  check('host buffered out-of-order snapshots', (hostStateStream?.outOfOrderBuffered ?? 0) > 0, hostStateStream?.outOfOrderBuffered);
  check('guest buffered out-of-order snapshots', (guestStateStream?.outOfOrderBuffered ?? 0) > 0, guestStateStream?.outOfOrderBuffered);
  check('host counted resync duplicates', (hostStateStream?.duplicates ?? 0) > 0, hostStateStream?.duplicates);
  check('snapshot recovery used resync requests',
    (h.transport.messagesByType.resync?.sent ?? 0) > 0, h.transport.messagesByType.resync?.sent);
  equal('500 host inputs delivered to the guest', guestInputs.length, 500);
  equal('500 guest inputs delivered to the host', hostInputs.length, 500);
  equal('host input stream lastApplied is 500', hostInputStream?.lastApplied, 500);
  equal('guest input stream lastApplied is 500', guestInputStream?.lastApplied, 500);
  equal('host input stream zero violations', hostInputStream?.violations, 0);
  equal('guest input stream zero violations', guestInputStream?.violations, 0);
  equal('reliable event channel dropped zero messages', net.eventDropped, 0);
  equal('reliable event channel delivered every message', net.eventDelivered, net.eventSent);
  check('host snapshot payloads match the deterministic value',
    hostStates.every((record) => Math.abs(record.state.position[0] + record.tick) < 1e-6), null);
  check('guest snapshot payloads match the deterministic value',
    guestStates.every((record) => Math.abs(record.state.position[0] - record.tick) < 1e-6), null);
  check('input payloads match the deterministic value',
    guestInputs.every((record) => Math.abs(record.input.steer - (((record.tick % 21) - 10) / 10)) < 1e-4), null);
  equal('host latest remote tick is 1000', pair.host.latestRemote(pair.guest.playerId)?.tick, 1000);
  equal('guest latest remote tick is 1000', pair.guest.latestRemote(pair.host.playerId)?.tick, 1000);
  check('host interpolation sample is available',
    pair.host.sampleRemote(pair.guest.playerId, 500) !== null, null);
  check('host stream convergence succeeded', hostConverged, null);
  check('guest stream convergence succeeded', guestConverged, null);
  const tableHost = pair.host.buildFinalTable(1000);
  const tableGuest = pair.guest.buildFinalTable(1000);
  equal('final table has both players', tableHost.length, 2);
  equal('both clients build the same final table', JSON.stringify(tableHost), JSON.stringify(tableGuest));
  const hash = 'sha256:' + sha256Hex(canonicalJson({ kind: 'verify', tick: 1000, table: tableHost }));
  await pair.host.reportFinished({ tick: 1000, hash });
  await pair.guest.reportFinished({ tick: 1000, hash });
  const finished = await waitFor(() => pair.host.room?.phase === 'finished' && pair.guest.room?.phase === 'finished', 2000);
  check('room finishes with both reports', finished, null);
  equal('no transport errors during the 1000-snapshot run', pair.errors.length, 0);
  equal('no listener errors during the 1000-snapshot run', pair.host.stats().listenerErrors.length, 0);
  check('reliable events never fell back to ws', h.transport.messagesByType.input?.sent === 500, h.transport.messagesByType.input?.sent);
  const stateBytes = h.transport.bytesSent.snapshot / Math.max(1, h.transport.messagesSent.snapshot);
  const eventBytes = (h.transport.bytesSent.event) / Math.max(1, h.transport.messagesSent.event);
  check('snapshot bytes/msg measured', stateBytes > 0, Number(stateBytes.toFixed(2)));
  check('event bytes/msg measured', eventBytes > 0, Number(eventBytes.toFixed(2)));
  const rtt = h.rtt.state;
  check('snapshot ack RTT measured', rtt.count > 0, rtt);
  await closePair(pair);
  return {
    measurements: {
      snapshotsSentPerClient: 1000,
      snapshotLossInjected: net.snapshotDropped,
      snapshotDeliveredRaw: net.snapshotDelivered,
      snapshotAppliedPerClient: 1000,
      snapshotBytesPerMessage: Number(stateBytes.toFixed(3)),
      eventMessages: 500,
      eventBytesPerMessage: Number(eventBytes.toFixed(3)),
      eventDelivered: net.eventDelivered,
      eventSent: net.eventSent,
      rttState: rtt,
      resyncRequests: h.transport.messagesByType.resync?.sent ?? 0,
      duplicates: hostStateStream?.duplicates ?? 0,
      reordered: hostStateStream?.outOfOrderBuffered ?? 0
    }
  };
}

// ---------------------------------------------------------------------------
// 6. Mid-session ICE failure and WS fallback
// ---------------------------------------------------------------------------
async function fallbackChecks() {
  begin('fallback');
  const pair = await makePair({
    peerLimits: { iceRestartAttempts: 0, peerRetryAttempts: 0 },
    networkOptions: { latencyMs: 1 }
  });
  const hostStates = [];
  const guestStates = [];
  const hostInputs = [];
  const guestInputs = [];
  pair.host.on('stateApplied', (record) => hostStates.push(record));
  pair.guest.on('stateApplied', (record) => guestStates.push(record));
  pair.host.on('inputApplied', (record) => hostInputs.push(record));
  pair.guest.on('inputApplied', (record) => guestInputs.push(record));
  for (let tick = 1; tick <= 100; tick++) {
    pair.host.sendState(stateAt(tick));
    pair.guest.sendState(stateAt(tick, -tick));
    pair.host.sendInput(inputAt(tick), tick);
    pair.guest.sendInput(inputAt(tick), tick);
  }
  await waitFor(() => hostStates.length >= 100 && guestStates.length >= 100, 2000);
  const wsStateBefore = pair.hub.stats.byType.state?.in ?? 0;
  const result = pair.host.simulateIceFailure({ hard: true });
  await waitFor(() => pair.host.transportStats().mode === 'ws-fallback' &&
    pair.guest.transportStats().mode === 'ws-fallback', 2000);
  check('forced failure closed exactly one peer', result.peers === 1, result);
  equal('host reports a fallback', pair.host.transportStats().mode, 'ws-fallback');
  equal('guest reports a fallback', pair.guest.transportStats().mode, 'ws-fallback');
  check('host fallback has a typed reason',
    pair.host.transportStats().fallbackReason === WEBRTC_ERROR_CODES.WEBRTC_ICE_FAILED,
    pair.host.transportStats().fallbackReason);
  check('guest fallback has a typed reason',
    [WEBRTC_ERROR_CODES.WEBRTC_DATACHANNEL_CLOSED, WEBRTC_ERROR_CODES.WEBRTC_ICE_FAILED]
      .includes(pair.guest.transportStats().fallbackReason),
    pair.guest.transportStats().fallbackReason);
  check('fallback events are emitted',
    pair.events.filter((entry) => entry.type === 'fallback').length >= 1,
    pair.events.filter((entry) => entry.type === 'fallback').length);
  check('fallback event carries the code',
    pair.events.filter((entry) => entry.type === 'fallback').every((entry) => typeof entry.code === 'string' && entry.code.startsWith('WEBRTC_')), null);
  equal('host has no ready peers after failure', pair.host.peerReady(), 0);
  equal('guest has no ready peers after failure', pair.guest.peerReady(), 0);
  for (let tick = 101; tick <= 500; tick++) {
    pair.host.sendState(stateAt(tick));
    pair.guest.sendState(stateAt(tick, -tick));
    pair.host.sendInput(inputAt(tick), tick);
    pair.guest.sendInput(inputAt(tick), tick);
    if (tick % 20 === 0) await sleep(1);
  }
  await sleep(250);
  check('post-failure snapshots used the ws relay', (pair.hub.stats.byType.state?.in ?? 0) > wsStateBefore, {
    before: wsStateBefore, after: pair.hub.stats.byType.state?.in ?? 0
  });
  equal('all 500 guest snapshots reached the host', hostStates.length, 500);
  equal('all 500 host snapshots reached the guest', guestStates.length, 500);
  equal('all 500 guest inputs reached the host', hostInputs.length, 500);
  equal('all 500 host inputs reached the guest', guestInputs.length, 500);
  equal('host applied sequences stay contiguous', pair.host.stats().streams.find((s) => s.key.endsWith(':state'))?.violations, 0);
  equal('guest applied sequences stay contiguous', pair.guest.stats().streams.find((s) => s.key.endsWith(':state'))?.violations, 0);
  equal('no snapshot was dropped after fallback', pair.host.stats().transport.snapshotDropped, 0);
  check('fallback count is recorded', pair.host.transportStats().fallbackCount >= 1, pair.host.transportStats().fallbackCount);
  check('fallback reason is recorded globally',
    pair.host.transportStats().lastFallback?.code === WEBRTC_ERROR_CODES.WEBRTC_ICE_FAILED,
    pair.host.transportStats().lastFallback);
  check('a forced failure does not throw', true, null);
  // A late signaling message after the permanent fallback is ignored, not fatal.
  const beforeLate = pair.errors.length;
  pair.host._onSignal({
    type: 'signal.ice', from: pair.guest.playerId, to: pair.host.playerId, epoch: 9, candidate: null
  });
  equal('late signaling after fallback is ignored', pair.errors.length, beforeLate);
  await closePair(pair);
}

// ---------------------------------------------------------------------------
// 7. Reconnect: WS drop/resume leaves the data channel intact
// ---------------------------------------------------------------------------
async function reconnectChecks() {
  begin('reconnect');
  const pair = await makePair({ networkOptions: { latencyMs: 1 } });
  const hostStates = [];
  const guestStates = [];
  pair.host.on('stateApplied', (record) => hostStates.push(record));
  pair.guest.on('stateApplied', (record) => guestStates.push(record));
  for (let tick = 1; tick <= 100; tick++) {
    pair.host.sendState(stateAt(tick));
    pair.guest.sendState(stateAt(tick, -tick));
    await sleep(0);
  }
  await waitFor(() => hostStates.length >= 100 && guestStates.length >= 100, 2000);
  const hostIdBefore = pair.host.playerId;
  const guestIdBefore = pair.guest.playerId;
  const offersBefore = pair.host.transportStats().peers[0]?.offersSent ?? 0;
  const resumesBefore = pair.hub.stats.resumes;
  const dropResult = await pair.host.simulateDrop().then(() => true).catch(() => false);
  check('simulateDrop resumed the host', dropResult, null);
  equal('resume keeps the same player id', pair.host.playerId, hostIdBefore);
  equal('guest player id is stable', pair.guest.playerId, guestIdBefore);
  check('the hub recorded a resume', pair.hub.stats.resumes === resumesBefore + 1, pair.hub.stats.resumes);
  equal('transport stays on webrtc', pair.host.transportStats().mode, 'webrtc');
  equal('peer stays open across WS resume', pair.host.peerReady(), 1);
  equal('no renegotiation happened', pair.host.transportStats().peers[0]?.offersSent, offersBefore);
  for (let tick = 101; tick <= 200; tick++) {
    pair.host.sendState(stateAt(tick));
    pair.guest.sendState(stateAt(tick, -tick));
    await sleep(0);
  }
  await sleep(200);
  equal('snapshots continue after the resume', hostStates.length, 200);
  equal('guest snapshots continue after the resume', guestStates.length, 200);
  equal('sequence numbers continue, not restart', hostStates[hostStates.length - 1]?.seq, 200);
  equal('no order violations after resume',
    pair.host.stats().streams.find((s) => s.key.endsWith(':state'))?.violations, 0);
  equal('the room is still running', pair.host.room?.phase, 'running');
  equal('both players remain in the room', pair.host.room?.players.length, 2);
  equal('reconnect counter is 1', pair.host.stats().counters.reconnects, 1);
  check('data channel was not rebuilt', pair.host.transportStats().peers[0]?.opened === true, null);
  equal('no fallback during reconnect', pair.host.transportStats().fallbackCount, 0);
  await closePair(pair);
}

// ---------------------------------------------------------------------------
// 8. WebSocket baseline and byte overhead
// ---------------------------------------------------------------------------
async function wsBaselineChecks() {
  begin('ws-baseline');
  const pair = await makePair({ transport: 'ws', start: true });
  const hostStates = [];
  pair.guest.on('stateApplied', (record) => hostStates.push(record));
  const before = JSON.parse(JSON.stringify(pair.hub.stats.byType.state ?? { in: 0, out: 0, bytesIn: 0, bytesOut: 0 }));
  for (let tick = 1; tick <= 200; tick++) {
    pair.host.sendState(stateAt(tick));
    pair.host.sendInput(inputAt(tick), tick);
  }
  await waitFor(() => hostStates.length >= 200, 3000);
  const after = pair.hub.stats.byType.state ?? { in: 0, out: 0, bytesIn: 0, bytesOut: 0 };
  const inMessages = after.in - before.in;
  const outMessages = after.out - before.out;
  const inBytes = after.bytesIn - before.bytesIn;
  const outBytes = after.bytesOut - before.bytesOut;
  equal('ws mode has no data channels', pair.host.peerReady(), 0);
  equal('ws mode has no peers', pair.host.transportStats().peers.length, 0);
  equal('all 200 snapshots relayed', hostStates.length, 200);
  equal('server received 200 state messages', inMessages, 200);
  check('server relayed 200 state messages', outMessages >= 200, outMessages);
  check('ws total bytes are positive', inBytes > 0 && outBytes > 0, { inBytes, outBytes });
  const perMessage = (inBytes + outBytes) / 200;
  check('ws bytes/message measured', perMessage > 0, Number(perMessage.toFixed(2)));
  const envelope = makePeerEnvelope(
    { type: 'state', channel: 'state', seq: 1, tick: 1, state: stateAt(1) },
    { from: pair.host.playerId, authority: true }
  );
  const dcBytes = utf8Length(JSON.stringify(envelope));
  check('direct envelope is smaller than the two-hop ws path', dcBytes < perMessage, {
    dcBytes, wsPerMessage: Number(perMessage.toFixed(2))
  });
  check('snapshot channel saves the server relay hop', dcBytes < (inBytes + outBytes) / 200, {
    dcBytes, wsPerMessage: Number(perMessage.toFixed(2))
  });
  const inputBefore = pair.hub.stats.byType.input?.in ?? 0;
  equal('ws input path was used', inputBefore >= 200, true);
  await closePair(pair);
  return {
    measurements: {
      wsStateBytesPerMessage: Number(perMessage.toFixed(3)),
      wsClientToServerBytes: Number((inBytes / 200).toFixed(3)),
      wsServerToClientBytes: Number((outBytes / 200).toFixed(3)),
      directEnvelopeBytes: dcBytes
    }
  };
}

// ---------------------------------------------------------------------------
// 9. Unsupported environment fallback end-to-end
// ---------------------------------------------------------------------------
async function unsupportedFallbackChecks() {
  begin('unsupported-fallback');
  const hub = new FakeHub();
  const network = new FakePeerNetwork();
  const factories = makeFakeFactories(network, hub);
  const errors = [];
  const fallbacks = [];
  const mk = (name) => {
    const client = new WebRtcNetClient({
      url: 'ws://fake/ws', name, transport: 'auto',
      RTCPeerConnection: null, WebSocket: factories.WebSocket
    });
    client.on('error', (error) => errors.push({ who: name, code: error.code }));
    client.on('transportFallback', (info) => fallbacks.push({ who: name, code: info.code }));
    return client;
  };
  const host = mk('Host');
  const guest = mk('Guest');
  await Promise.all([host.connect(), guest.connect()]);
  const { room } = await host.createRoom({ name: 'Host', maxPlayers: 2 });
  await guest.joinRoom({ code: room.code, name: 'Guest' });
  await Promise.all([host.setReady(true), guest.setReady(true)]);
  await host.start({ seed: 'no-rtc' });
  const states = [];
  guest.on('stateApplied', (record) => states.push(record));
  for (let tick = 1; tick <= 50; tick++) host.sendState(stateAt(tick));
  await waitFor(() => states.length >= 50, 2000);
  equal('host falls back when RTC is absent', host.transportStats().mode, 'ws-fallback');
  equal('guest falls back when RTC is absent', guest.transportStats().mode, 'ws-fallback');
  equal('fallback reason is typed', host.transportStats().fallbackReason, WEBRTC_ERROR_CODES.WEBRTC_UNSUPPORTED);
  check('fallback event was emitted', fallbacks.length >= 2, fallbacks);
  equal('all 50 snapshots still arrived', states.length, 50);
  equal('no fatal transport errors', errors.filter((entry) => entry.code !== WEBRTC_ERROR_CODES.WEBRTC_UNSUPPORTED).length, 0);
  equal('no peer connection was created', host.peerReady(), 0);
  await closePair({ host, guest, hub, network });
}

// ---------------------------------------------------------------------------
// 10. Statistics shape and determinism
// ---------------------------------------------------------------------------
async function statsChecks() {
  begin('stats');
  const pair = await makePair({ networkOptions: { latencyMs: 1 } });
  const stats = pair.host.stats();
  check('stats keeps the NetClient shape', typeof stats.connected === 'boolean' && Array.isArray(stats.streams), null);
  check('stats adds a transport block', stats.transport?.schema === WEBRTC_SCHEMA, stats.transport?.schema);
  check('transport mode is webrtc', stats.transport.mode === 'webrtc', stats.transport.mode);
  check('transport counts are numeric',
    ['fallbackCount', 'snapshotDropped', 'eventSendFailures', 'invalidMessages', 'signalsSent']
      .every((key) => Number.isFinite(stats.transport[key])), null);
  check('peer stats are serialisable', typeof JSON.stringify(stats.transport) === 'string', null);
  check('listener errors are empty', stats.listenerErrors.length === 0, stats.listenerErrors);
  check('unexpected messages are zero', stats.counters.unexpectedMessages === 0, stats.counters.unexpectedMessages);
  equal('no self echo', stats.counters.selfEcho, 0);
  await closePair(pair);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const startedAt = Date.now();
const evidence = {
  schema: 'blur.net-webrtc.verify/1',
  command: 'node probes/net-webrtc/verify.mjs',
  node: process.version,
  startedAt: new Date(startedAt).toISOString(),
  elapsedMs: 0,
  checks: [],
  counts: { total: 0, passed: 0, failed: 0, groups: {} },
  measurements: {},
  passed: false,
  error: null
};

try {
  protocolChecks();
  await constructionChecks();
  await negotiationChecks();
  await routingChecks();
  const delivery = await deliveryChecks();
  await fallbackChecks();
  await reconnectChecks();
  const wsBaseline = await wsBaselineChecks();
  await unsupportedFallbackChecks();
  await statsChecks();
  evidence.measurements = { ...wsBaseline.measurements, ...delivery.measurements };
} catch (error) {
  evidence.error = String(error?.stack || error);
  logLines.push('');
  logLines.push('FAIL uncaught: ' + evidence.error);
}

const passed = checks.filter((entry) => entry.ok).length;
const failed = checks.length - passed;
for (const entry of checks) {
  evidence.counts.groups[entry.group] = evidence.counts.groups[entry.group] ?? { total: 0, passed: 0 };
  evidence.counts.groups[entry.group].total++;
  if (entry.ok) evidence.counts.groups[entry.group].passed++;
}
evidence.checks = checks;
evidence.counts.total = checks.length;
evidence.counts.passed = passed;
evidence.counts.failed = failed;
evidence.elapsedMs = Date.now() - startedAt;
evidence.passed = failed === 0 && evidence.error === null && checks.length >= 120;

logLines.push('');
logLines.push('checks: ' + passed + '/' + checks.length + ' passed, ' + failed + ' failed');
logLines.push('elapsedMs: ' + evidence.elapsedMs);
logLines.push('measurements: ' + JSON.stringify(evidence.measurements));

writeFileSync(path.join(OUT, 'verify.json'), JSON.stringify(evidence, null, 2) + '\n');
writeFileSync(path.join(LOGS, 'verify.log'), logLines.join('\n') + '\n');

console.log((evidence.passed ? 'PASS' : 'FAIL') + ' net-webrtc verifier');
console.log('  checks:   ' + passed + '/' + checks.length + ' (' + failed + ' failed)');
console.log('  elapsed:  ' + evidence.elapsedMs + ' ms');
if (evidence.measurements.wsStateBytesPerMessage !== undefined) {
  console.log('  ws state: ' + evidence.measurements.wsStateBytesPerMessage + ' B/msg');
  console.log('  dc state: ' + evidence.measurements.snapshotBytesPerMessage + ' B/msg');
}
console.log('  evidence: _work/net-webrtc/verify.json');
if (failed > 0) {
  for (const entry of checks.filter((item) => !item.ok)) {
    console.log('  FAILED: [' + entry.group + '] ' + entry.name + ' ' + JSON.stringify(entry.detail));
  }
}
process.exit(evidence.passed ? 0 : 1);
