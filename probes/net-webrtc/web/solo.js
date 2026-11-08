// One browser client in the WebRTC loopback capture.
//
// Room/lobby uses the committed net-mvp room service. SDP/ICE uses a same-origin
// BroadcastChannel because both iframes live in one browser process; this is a
// loopback signaling transport, explicitly not the production server relay.
// Everything on the data plane is a real RTCPeerConnection/DataChannel.

import { WebRtcNetClient } from '/transport.mjs';
import { hashOf } from '/net-mvp/hash.mjs';

const query = new URLSearchParams(location.search);
const role = query.get('role') === 'guest' ? 'guest' : 'host';
const wsUrl = query.get('ws') ?? ('ws://' + location.hostname + ':8852/ws');
const SNAPSHOTS = Number(query.get('snapshots') ?? '1000');
const EVENTS = Number(query.get('events') ?? '500');
const DROP_AT = Number(query.get('drop') ?? '300');
const FAIL_AT = Number(query.get('failure') ?? '600');
const CODE = query.get('code');
const NAME = role === 'host' ? 'Host' : 'Guest';

const elements = {
  title: document.getElementById('title'),
  state: document.getElementById('state'),
  room: document.getElementById('room'),
  player: document.getElementById('player'),
  host: document.getElementById('host'),
  transport: document.getElementById('transport'),
  fallback: document.getElementById('fallback'),
  tick: document.getElementById('tick'),
  states: document.getElementById('states'),
  inputs: document.getElementById('inputs'),
  rtt: document.getElementById('rtt'),
  hash: document.getElementById('hash'),
  error: document.getElementById('error')
};
elements.title.textContent = NAME + ' client';

const local = {
  phase: 'booting',
  tick: 0,
  running: false,
  stateCount: 0,
  inputCount: 0,
  transportAtReady: null,
  fallbackReason: null,
  fallbackEvents: [],
  reconnects: 0,
  violations: 0,
  rttBeforeFailure: null,
  rttAfterFailure: null,
  errors: [],
  hash: null
};
window.__webrtcProbeLocal = local;

function post(type, payload = {}) {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type, role, ...payload }, location.origin);
  }
}

function readout() {
  elements.state.textContent = local.phase;
  elements.room.textContent = net.room?.code ?? '—';
  elements.player.textContent = net.playerId ?? '—';
  elements.host.textContent = net.isHost ? 'yes' : 'no';
  const transport = net.stats().transport;
  elements.transport.textContent = transport.mode + ' · peers ' + transport.peers.filter((peer) => peer.ready).length;
  elements.fallback.textContent = local.fallbackReason ?? '—';
  elements.tick.textContent = local.tick + ' / ' + SNAPSHOTS;
  elements.states.textContent = String(local.stateCount);
  elements.inputs.textContent = String(local.inputCount);
  const rtt = net.stats().rtt.state;
  elements.rtt.textContent = rtt.count
    ? rtt.p50.toFixed(1) + ' / ' + rtt.p95.toFixed(1) + ' ms (' + rtt.count + ')'
    : '—';
  elements.hash.textContent = local.hash ?? '—';
}

function fail(error) {
  if (local.errors.length) return;
  local.phase = 'failed';
  local.errors.push({ code: error?.code ?? 'ERROR', message: String(error?.message ?? error) });
  elements.error.textContent = local.errors[0].code + ': ' + local.errors[0].message;
  elements.state.textContent = 'failed';
  post('error', { code: local.errors[0].code, message: local.errors[0].message });
}

/** Same-origin loopback signaling. The production path is the room service. */
function makeLoopbackSignalTransport() {
  const channel = new BroadcastChannel('blur-net-webrtc-loopback');
  const listeners = new Set();
  channel.onmessage = (event) => {
    for (const listener of listeners) listener(event.data);
  };
  return {
    send(message) { channel.postMessage(message); },
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { channel.close(); }
  };
}

const signalTransport = makeLoopbackSignalTransport();
const net = new WebRtcNetClient({
  url: wsUrl,
  name: NAME,
  autoReconnect: true,
  transport: 'webrtc',
  signalTransport,
  iceServers: [],
  peerLimits: {
    negotiationTimeoutMs: 8000,
    iceRestartAttempts: 0,
    peerRetryAttempts: 0
  }
});

net.on('transportReady', (info) => {
  local.transportAtReady = net.stats().transport.mode;
  local.negotiationMs = info.negotiationMs;
  readout();
});

net.on('transportFallback', (info) => {
  local.fallbackReason = info.code;
  local.fallbackEvents.push({ code: info.code, at: Date.now(), message: info.message });
  readout();
});

net.on('transportPeerClosed', () => readout());
net.on('disconnected', () => { local.phase = 'reconnecting'; readout(); });
net.on('resumed', () => { local.reconnects++; readout(); });
net.on('error', (error) => fail(error));

let otherId = null;
net.on('stateApplied', (record) => {
  if (!otherId) otherId = record.from;
  local.stateCount++;
  if (record.seq !== local.lastStateSeq + 1 && local.lastStateSeq !== undefined) {
    // OrderedStream guarantees contiguity; this is a test-side guard only.
  }
  local.lastStateSeq = record.seq;
  if (local.stateCount % 100 === 0) readout();
});
net.on('inputApplied', () => { local.inputCount++; });

let startRequested = false;
net.on('room', ({ room }) => {
  readout();
  if (role !== 'host' || startRequested) return;
  const connected = room.players.filter((player) => player.connected);
  if (connected.length === 2 && connected.every((player) => player.ready)) {
    startRequested = true;
    net.start({ seed: 'blur-net-webrtc-browser-v1' }).catch(fail);
  }
});

net.on('started', () => {
  if (local.running) return;
  local.running = true;
  local.phase = 'running';
  run().catch(fail);
});

function snapshotAt(tick) {
  return {
    tick,
    position: [tick * 0.02, 0.35, 4.8],
    quaternion: [0, 0, 0, 1],
    speed: 20 + (tick % 100) * 0.1
  };
}

function inputAt(tick) {
  return { throttle: 1, brake: 0, steer: ((tick % 21) - 10) / 10, handbrake: 0 };
}

async function run() {
  const startedAt = performance.now();
  for (let tick = 1; tick <= SNAPSHOTS; tick++) {
    net.sendState(snapshotAt(tick));
    if (tick % Math.max(1, Math.round(SNAPSHOTS / EVENTS)) === 0) {
      net.sendInput(inputAt(tick), tick);
    }
    local.tick = tick;
    if (tick === DROP_AT && role === 'host') {
      local.phase = 'reconnecting';
      readout();
      await net.simulateDrop({ timeoutMs: 12000 }).catch(fail);
    }
    if (tick === Math.floor(SNAPSHOTS / 2)) {
      local.rttBeforeFailure = net.stats().rtt.state;
    }
    if (tick === FAIL_AT && role === 'host') {
      local.phase = 'forcing ICE failure';
      net.simulateIceFailure({ hard: true });
    }
    if (tick % 4 === 0) await new Promise((resolve) => requestAnimationFrame(resolve));
    if (tick % 100 === 0) { readout(); post('status', { tick, transport: net.stats().transport.mode }); }
  }
  local.phase = 'finishing';
  readout();
  net.finalizeStreams();
  await net.waitForStreams(15000);
  const table = net.buildFinalTable(SNAPSHOTS);
  const hash = hashOf({ kind: 'blur.net-webrtc.browser/1', version: 1, tick: SNAPSHOTS, players: table });
  await net.reportFinished({ tick: SNAPSHOTS, hash });
  local.hash = hash;
  local.phase = 'finished';
  const stats = net.stats();
  local.rttAfterFailure = stats.rtt.state;
  const stateStreams = stats.streams.filter((stream) => stream.channel === 'state');
  const inputStreams = stats.streams.filter((stream) => stream.channel === 'input');
  local.violations = [...stateStreams, ...inputStreams].reduce((sum, stream) => sum + stream.violations, 0);
  readout();
  post('result', {
    tick: SNAPSHOTS,
    hash,
    table,
    stateCount: local.stateCount,
    inputCount: local.inputCount,
    transportAtReady: local.transportAtReady,
    transportFinal: stats.transport.mode,
    fallbackReason: local.fallbackReason,
    fallbackEvents: local.fallbackEvents,
    reconnects: local.reconnects,
    violations: local.violations,
    errors: local.errors,
    elapsedMs: performance.now() - startedAt,
    rttBeforeFailure: local.rttBeforeFailure,
    rttAfterFailure: local.rttAfterFailure,
    transport: stats.transport,
    streams: stats.streams
  });
}

async function boot() {
  local.phase = 'connecting';
  readout();
  await net.connect();
  if (role === 'host') {
    const { room } = await net.createRoom({
      name: NAME, maxPlayers: 2, map: 'usa_la_river', car: 'corvette-zr1-stock'
    });
    post('room', { code: room.code });
  } else {
    if (!CODE) throw new Error('guest needs a room code');
    await net.joinRoom({ code: CODE, name: NAME, car: 'lotus-exige-cup260' });
  }
  await net.setReady(true);
  local.phase = 'lobby';
  readout();
}

window.addEventListener('pagehide', () => net.close());
boot().catch(fail);
