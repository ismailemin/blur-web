// One browser client. Loaded in an iframe by index.html. It joins the room,
// waits for the host start, runs the deterministic 30 s synthetic race at
// 60 Hz input / 20 Hz state, resyncs losses, and publishes a final hash.
//
// No console output: failures are visible in the readout and posted to the
// parent as typed error objects.

import { NetClient, NetError, ERROR_CODES } from '/client.mjs';
import { canonicalJson } from '/hash.mjs';
import { stateAt, inputAt, finalHash, finalTickForSeconds } from '/race.mjs';

const query = new URLSearchParams(location.search);
const role = query.get('role') === 'b' ? 'b' : 'a';
const seconds = Number(query.get('seconds') ?? 30);
const finalTick = finalTickForSeconds(seconds);
const roomCode = query.get('code');
const roleName = role === 'a' ? 'Host' : 'Guest';
const storedSeed = 'blur-net-mvp-browser-v1';

const elements = {
  title: document.getElementById('title'),
  state: document.getElementById('state'),
  room: document.getElementById('room'),
  player: document.getElementById('player'),
  host: document.getElementById('host'),
  content: document.getElementById('content'),
  phase: document.getElementById('phase'),
  tick: document.getElementById('tick'),
  sent: document.getElementById('sent'),
  applied: document.getElementById('applied'),
  dedup: document.getElementById('dedup'),
  rtt: document.getElementById('rtt'),
  interp: document.getElementById('interp'),
  hash: document.getElementById('hash'),
  error: document.getElementById('error')
};
elements.title.textContent = roleName + ' client';
elements.tick.textContent = '0 / ' + finalTick;

const net = new NetClient({
  url: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
  name: roleName,
  autoReconnect: true
});

const local = {
  seed: null,
  tick: 0,
  phase: 'booting',
  started: false,
  finished: false,
  starting: false,
  slot: null,
  car: null,
  lastSentState: null,
  appliedMismatches: 0,
  inputMismatches: 0,
  remoteChecked: 0,
  lastStatusAt: 0,
  error: null
};
window.__soloProbe = local;

function post(type, payload = {}) {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type, role, ...payload }, location.origin);
  }
}

function setState(state, text, tone = 'wait') {
  local.phase = state;
  elements.state.textContent = text;
  elements.state.className = 'state ' + tone;
}

function postStatus() {
  const stats = net.stats();
  const other = net.room?.players.find((player) => player.id !== net.playerId);
  const sample = other ? net.sampleRemote(other.id, Math.max(0, local.tick - 6)) : null;
  post('status', {
    phase: local.phase,
    tick: local.tick,
    finalTick,
    seed: local.seed,
    roomCode: net.room?.code ?? null,
    playerId: net.playerId,
    hostId: net.hostId,
    isHost: net.isHost,
    sent: stats.sent,
    received: stats.received,
    rtt: stats.rtt,
    sample,
    error: local.error
  });
}

function renderReadout() {
  const stats = net.stats();
  const other = net.room?.players.find((player) => player.id !== net.playerId);
  const sample = other ? net.sampleRemote(other.id, Math.max(0, local.tick - 6)) : null;
  elements.room.textContent = net.room?.code ?? '—';
  elements.player.textContent = net.playerId ?? '—';
  elements.host.textContent = net.isHost ? 'yes' : 'no (' + (net.hostId ?? '—') + ')';
  const self = net.room?.players.find((player) => player.id === net.playerId);
  elements.content.textContent = (self?.car ?? '—') + ' · ' + (net.room?.map ?? '—');
  elements.phase.textContent = net.room?.phase ?? '—';
  elements.tick.textContent = local.tick + ' / ' + finalTick;
  elements.sent.textContent = stats.sent.state + ' / ' + stats.sent.input;
  elements.applied.textContent = stats.received.state + ' / ' + stats.received.input;
  const duplicates = stats.streams.reduce((sum, stream) => sum + stream.duplicates, 0);
  const buffered = stats.streams.reduce((sum, stream) => sum + stream.outOfOrderBuffered, 0);
  elements.dedup.textContent = duplicates + ' / ' + buffered;
  const rtt = stats.rtt.state;
  elements.rtt.textContent = rtt.count
    ? rtt.p50.toFixed(1) + ' / ' + rtt.p95.toFixed(1) + ' ms (' + rtt.count + ' acks)'
    : '—';
  elements.interp.textContent = sample
    ? sample.tick.toFixed(1) + ' · [' + sample.position.map((value) => value.toFixed(2)).join(', ') + ']' +
      (sample.clamped ? ' clamped' : sample.interpolated ? ' slerp' : ' exact')
    : '—';
  elements.hash.textContent = local.finalHash ?? '—';
  if (local.error) elements.error.textContent = local.error;
}

function fail(error) {
  if (local.error) return;
  const netError = error instanceof NetError
    ? error
    : new NetError(ERROR_CODES.NET_REJECTED, String(error?.message || error));
  local.error = netError.message + (netError.code ? ' [' + netError.code + ']' : '');
  setState('failed', 'FAILED · ' + local.error, 'bad');
  elements.error.textContent = local.error + (netError.detail ? ' ' + JSON.stringify(netError.detail) : '');
  post('error', { code: netError.code, message: netError.message, detail: netError.detail });
}

async function boot() {
  setState('joining', 'connecting', 'wait');
  const welcome = await net.connect();
  local.roomCode = welcome ? net.room?.code : null;
  let joined;
  if (role === 'a') {
    joined = await net.createRoom({
      name: 'Host',
      maxPlayers: 2,
      map: 'usa_la_river',
      car: 'corvette-zr1-stock'
    });
    post('room', { code: joined.room.code });
    setState('waiting', 'room created · waiting for guest', 'wait');
    await net.setReady(true);
  } else {
    if (!roomCode) throw new NetError(ERROR_CODES.NET_CONFIG, 'guest requires a room code');
    joined = await net.joinRoom({ code: roomCode, name: 'Guest', car: 'lotus-exige-cup260' });
    setState('waiting', 'joined room · ready', 'wait');
    await net.setReady(true);
  }
  elements.room.textContent = joined.room.code;
  elements.player.textContent = joined.you.id;
  postStatus();
}

net.on('room', ({ room }) => {
  renderReadout();
  if (role === 'a' && room.phase === 'lobby' && !local.starting) {
    const connected = room.players.filter((player) => player.connected);
    if (connected.length >= 2 && connected.every((player) => player.ready)) {
      local.starting = true;
      net.start({ seed: storedSeed }).catch(fail);
    }
  }
});

net.on('finished', () => {
  local.phase = 'finished';
  elements.phase.textContent = 'finished';
  renderReadout();
  postStatus();
});

net.on('started', (started) => {
  if (local.started) return;
  local.started = true;
  local.seed = started.seed;
  const self = net.room.players.find((player) => player.id === net.playerId);
  local.slot = self?.slot ?? null;
  local.car = self?.car ?? null;
  if (!local.slot || !local.car) { fail(new NetError(ERROR_CODES.NET_FINAL_MISSING, 'own slot/car missing at start')); return; }
  setState('running', 'racing · seed ' + started.seed, 'ok');
  startRaceLoop();
});

net.on('stateApplied', ({ from, tick, state }) => {
  if (local.seed === null) return;
  const player = net.room?.players.find((entry) => entry.id === from);
  if (!player) return;
  const expected = stateAt(local.seed, player.slot, player.car, tick);
  local.remoteChecked++;
  if (canonicalJson(expected) !== canonicalJson(state)) local.appliedMismatches++;
});

net.on('inputApplied', ({ from, tick, input }) => {
  if (local.seed === null) return;
  const player = net.room?.players.find((entry) => entry.id === from);
  if (!player) return;
  const expected = inputAt(local.seed, player.slot, tick);
  if (canonicalJson(expected) !== canonicalJson(input)) local.inputMismatches++;
});

net.on('error', (error) => {
  // Any asynchronous transport error is a gate failure; there is no silent path.
  fail(error);
});

function startRaceLoop() {
  let accumulator = 0;
  let last = performance.now();
  const frame = (now) => {
    if (local.finished) return;
    const dt = Math.min(0.5, Math.max(0, (now - last) / 1000));
    last = now;
    accumulator += dt;
    while (accumulator >= 1 / 60 && local.tick < finalTick) {
      accumulator -= 1 / 60;
      local.tick++;
      try {
        net.sendInput(inputAt(local.seed, local.slot, local.tick), local.tick);
        if (local.tick % 3 === 0 || local.tick === finalTick) {
          const state = stateAt(local.seed, local.slot, local.car, local.tick);
          net.sendState(state);
          local.lastSentState = state;
        }
      } catch (error) {
        fail(error);
        return;
      }
    }
    renderReadout();
    const nowMs = performance.now();
    if (nowMs - local.lastStatusAt >= 100) {
      local.lastStatusAt = nowMs;
      postStatus();
    }
    if (local.tick >= finalTick) {
      finalise();
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function finalise() {
  if (local.finished) return;
  local.finished = true;
  try {
    setState('finishing', 'waiting for stream convergence', 'wait');
    net.finalizeStreams();
    await net.waitForStreams(10000);
    const table = net.buildFinalTable(finalTick);
    const hash = finalHash({ seed: local.seed, tick: finalTick, players: table });
    await net.reportFinished({ tick: finalTick, hash });
    local.finalHash = hash;
    const stats = net.stats();
    const checks = {
      appliedMatch: local.appliedMismatches === 0,
      inputMatch: local.inputMismatches === 0,
      converged: true,
      remoteStatesChecked: local.remoteChecked,
      remoteMismatches: local.appliedMismatches,
      inputMismatches: local.inputMismatches,
      duplicates: stats.streams.reduce((sum, stream) => sum + stream.duplicates, 0),
      outOfOrderBuffered: stats.streams.reduce((sum, stream) => sum + stream.outOfOrderBuffered, 0),
      violations: stats.streams.reduce((sum, stream) => sum + stream.violations, 0)
    };
    setState('finished', 'finished · ' + hash.slice(0, 24) + '…', 'ok');
    renderReadout();
    postStatus();
    post('result', { tick: finalTick, hash, table, checks, stats });
  } catch (error) {
    fail(error);
  }
}

window.addEventListener('pagehide', () => net.close());
boot().catch(fail);
