// Headless Edge verification for probes/audio/web/engine-audio.js.
//
//   node probes/audio/capture_module.mjs [--edge <msedge.exe>] [--port 0]
//
// The page is loaded WITHOUT --autoplay-policy=no-user-gesture-required, so the
// claim "no audio autoplay outside a gesture" is actually tested: the verifier
// checks that no AudioContext exists before it clicks "Start audio", then
// dispatches a real mouse click through the DevTools Input domain and requires
// the AudioContext to become `running`.
//
// Evidence: _work/audio/module-evidence.json, _work/audio/module-harness.png
// Log:      _work/logs/audio/module-edge.log
// (The P62 files harness-evidence.json / harness.png are not touched.)

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/audio');
const LOGS = path.join(ROOT, '_work/logs/audio');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

const EDGE_CANDIDATES = [
  option('--edge', ''),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const edge = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
if (!edge) throw new Error('msedge.exe not found; pass --edge <path>');

const PORT = Number(option('--port', '0'));
const DEBUG_PORT = Number(option('--debug-port', '9348'));
const PROFILE = path.join(OUT, 'edge-profile-module');
const VIEWPORT = { width: 1280, height: 760 };
const SAMPLE_RPMS = [1500, 3015, 6000];
const SETTLE_MS = 500;
mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = startServer({ port: PORT });
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// Deliberately no --autoplay-policy override.
const browser = spawn(edge, [
  '--headless=new',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + PROFILE,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-sync',
  '--disable-component-update',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let browserLog = '';
browser.stderr.on('data', (chunk) => { browserLog += chunk.toString(); });
browser.stdout.on('data', (chunk) => { browserLog += chunk.toString(); });
const shutdown = async () => {
  try { browser.kill(); } catch { /* ignore */ }
  await new Promise((resolve) => server.close(resolve));
};
process.on('exit', () => { try { browser.kill(); } catch { /* ignore */ } });

async function target() {
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      if (response.ok) {
        const list = await response.json();
        const page = list.find((entry) => entry.type === 'page');
        if (page) return page;
      }
    } catch { /* not ready */ }
    await sleep(250);
  }
  throw new Error('Edge devtools endpoint unreachable. Log tail:\n' + browserLog.slice(-1200));
}

const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const messages = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    messages.push({ source: 'console.' + message.params.type,
      text: message.params.args.map((arg) => arg.value ?? arg.description).join(' ') });
  } else if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    messages.push({ source: 'exception', text: details.exception?.description ?? details.text });
  } else if (message.method === 'Log.entryAdded') {
    messages.push({ source: 'log.' + message.params.entry.level, text: message.params.entry.text });
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error('evaluate failed: ' + (details.exception?.description ?? details.text ?? JSON.stringify(details)));
  }
  return result.result.value;
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride',
  { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });

await send('Page.navigate', { url: origin + '/web/' });

let boot = null;
for (let attempt = 0; attempt < 200; attempt++) {
  boot = await evaluate(`(()=>{const p=window.engineAudioProbe;return p?{
    ready:p.ready, state:p.state, hasModel:!!p.model,
    curveCheck:p.curveCheck?.ok ?? null}:null})()`).catch(() => null);
  if (boot && boot.ready) break;
  await sleep(100);
}
if (!boot || !boot.ready) throw new Error('module harness never became ready: ' + JSON.stringify(boot));

const beforeGesture = await evaluate(`(()=>{const p=window.engineAudioProbe;const d=p.diagnostics;return {
  state:d.state, contextState:d.contextState, decoded:d.decoded.length,
  levels:d.levels, rpm:d.rpm, errors:p.errors}})()`);

// Real mouse click, dispatched through the Input domain.
async function clickSelector(selector) {
  const rect = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {
    x:r.x + r.width/2, y:r.y + r.height/2, w:r.width, h:r.height}})()`);
  if (!(rect.w > 0 && rect.h > 0)) throw new Error('no layout box for ' + selector + ': ' + JSON.stringify(rect));
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none' });
  await sleep(60);
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1,
  });
}

await clickSelector('#play');

let live = null;
for (let attempt = 0; attempt < 300; attempt++) {
  live = await evaluate(`(()=>{const p=window.engineAudioProbe;const d=p.diagnostics;return {
    state:d.state, reason:d.reason, detail:d.detail, contextState:d.contextState,
    sampleRate:d.sampleRate, decoded:d.decoded, layers:d.layers, targets:d.targets,
    levels:d.levels, errors:p.errors}})()`).catch(() => null);
  if (live && (live.state === 'running' || live.state === 'unavailable')) break;
  await sleep(100);
}
if (!live) throw new Error('no diagnostics after the gesture');
if (live.state !== 'running') {
  throw new Error('module did not start after the click: ' + JSON.stringify(live));
}
if (live.contextState !== 'running') {
  throw new Error('AudioContext is ' + live.contextState + ' after the click');
}

// Settle the setTargetAtTime envelopes (tau = 0.02 s).
await sleep(SETTLE_MS);

const modelResponse = await fetch(origin + '/_work/audio/engine-model.json');
const model = await modelResponse.json();

// Independent check that the bytes the module decoded are the P62 fixtures.
const wavChecks = [];
for (const loop of model.loops.filter((entry) => entry.rpmLabel !== null)) {
  const url = origin + '/_work/audio/' + encodeURIComponent(loop.wave) + '.wav';
  const response = await fetch(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const expected = model.wavFiles[loop.wave].sha256;
  wavChecks.push({ wave: loop.wave, bytes: bytes.length, sha256, expected,
    match: sha256 === expected && bytes.length === model.wavFiles[loop.wave].bytes });
}

function evalPlf(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

const activeLoops = model.loops.filter((loop) => loop.rpmLabel !== null);

const samples = [];
for (const rpm of SAMPLE_RPMS) {
  await evaluate(`window.engineAudioProbe.setRpm(${rpm})`);
  await sleep(SETTLE_MS);
  const state = await evaluate(`(()=>{const p=window.engineAudioProbe;const d=p.diagnostics;return {
    rpm:d.rpm, x:d.x, appliedRpm:d.appliedRpm, state:d.state, layers:d.layers,
    targets:d.targets, levels:d.levels}})()`);
  const x = rpm * 0.0001;
  const expected = activeLoops.map((loop) => ({
    slot: loop.slot, wave: loop.wave, rpmLabel: loop.rpmLabel,
    gain: evalPlf(loop.volume, x),
    rate: Math.max(0.00390625, evalPlf(loop.pitch, x)),
  }));
  const actual = new Map(state.layers.map((entry) => [entry.slot, entry]));
  const targets = new Map(state.targets.map((entry) => [entry.slot, entry]));
  const deltas = expected.map((want) => {
    const got = actual.get(want.slot);
    const target = targets.get(want.slot);
    return {
      slot: want.slot,
      wave: want.wave,
      gainDelta: got ? Math.abs(got.gain - want.gain) : Infinity,
      rateDelta: got ? Math.abs(got.rate - want.rate) : Infinity,
      targetGainDelta: target ? Math.abs(target.gain - want.gain) : Infinity,
      targetRateDelta: target ? Math.abs(target.rate - want.rate) : Infinity,
    };
  });
  samples.push({
    requestedRpm: rpm, reportedRpm: state.rpm, x, state: state.state,
    appliedRpm: state.appliedRpm, levels: state.levels,
    expected, actual: state.layers, targets: state.targets, deltas,
  });
}

// Leave the page on a representative frame for the screenshot.
await evaluate(`window.engineAudioProbe.setRpm(3015)`);
await sleep(SETTLE_MS);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const shotFile = path.join(OUT, 'module-harness.png');
writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));

// Failure path: a second engine pointed at a URL the server refuses. Started
// from a real click so the AudioContext is allowed; it must end `unavailable`
// with a reason and leave the running engine untouched.
await clickSelector('#failure');
let failurePath = null;
for (let attempt = 0; attempt < 100; attempt++) {
  failurePath = await evaluate(`(()=>{const p=window.engineAudioProbe;return p.failureResult})()`);
  if (failurePath && !failurePath.pending) break;
  await sleep(100);
}
const mainAfterFailure = await evaluate(`(()=>{const d=window.engineAudioProbe.diagnostics;return {
  state:d.state, contextState:d.contextState, decoded:d.decoded.length,
  levels:d.levels}})()`);

// Mute/unmute through the module's master gain.
await evaluate(`window.engineAudioProbe.setMuted(true)`);
await sleep(400);
const muted = await evaluate(`(()=>{const d=window.engineAudioProbe.diagnostics;return {
  muted:d.muted, levels:d.levels, state:d.state, contextState:d.contextState}})()`);
await evaluate(`window.engineAudioProbe.setMuted(false)`);
await sleep(400);
const unmuted = await evaluate(`(()=>{const d=window.engineAudioProbe.diagnostics;return {
  muted:d.muted, levels:d.levels, state:d.state, contextState:d.contextState}})()`);

// Teardown path.
const beforeDispose = await evaluate(`(()=>{const d=window.engineAudioProbe.diagnostics;return {
  state:d.state, contextState:d.contextState}})()`);
await evaluate(`window.engineAudioProbe.dispose()`);
await sleep(500);
const afterDispose = await evaluate(`(()=>{const p=window.engineAudioProbe;const d=p.diagnostics;return {
  state:d.state, contextState:d.contextState, decoded:d.decoded.length,
  layers:d.layers.length, levels:d.levels}})()`);

const failures = [];
const check = (label, ok, detail) => { if (!ok) failures.push(label + (detail ? ': ' + detail : '')); };

check('no AudioContext before the gesture', beforeGesture.contextState === 'none',
  beforeGesture.contextState);
check('module idle before the gesture', beforeGesture.state === 'idle', beforeGesture.state);
check('nothing decoded before the gesture', beforeGesture.decoded === 0, String(beforeGesture.decoded));
check('no autoplay levels before the gesture', beforeGesture.levels === null,
  JSON.stringify(beforeGesture.levels));
check('AudioContext running after the synthetic user gesture', live.contextState === 'running',
  live.contextState);
check('six retail WAVs decoded', live.decoded.length === 6, String(live.decoded.length));
check('six layers started', live.layers.length === 6, String(live.layers.length));
check('AudioContext reports a working sample rate',
  Number.isFinite(live.sampleRate) && live.sampleRate >= 32000, String(live.sampleRate));
check('decoded buffers are mono at the context sample rate',
  live.decoded.every((entry) => entry.channels === 1 && entry.sampleRate === live.sampleRate),
  JSON.stringify(live.decoded.map((entry) => [entry.wave, entry.sampleRate, entry.channels])));
check('decoded buffers are non-silent',
  live.decoded.every((entry) => entry.peak > 0.01),
  JSON.stringify(live.decoded.map((entry) => [entry.wave, Number(entry.peak.toFixed(4))])));
check('served WAV bytes match the P62 model hashes',
  wavChecks.every((entry) => entry.match),
  JSON.stringify(wavChecks.filter((entry) => !entry.match)));
check('module curve table equals the reference model (no drift)',
  boot.curveCheck === true, String(boot.curveCheck));

for (const sample of samples) {
  check(`RPM ${sample.requestedRpm} reached the module unchanged`,
    sample.reportedRpm === sample.requestedRpm && sample.appliedRpm === sample.requestedRpm,
    `${sample.reportedRpm} / applied ${sample.appliedRpm}`);
  check(`RPM ${sample.requestedRpm} module running`, sample.state === 'running', sample.state);
  check(`RPM ${sample.requestedRpm} non-silent analyser RMS`,
    Boolean(sample.levels && sample.levels.rms > 0.001),
    JSON.stringify(sample.levels));
  for (const delta of sample.deltas) {
    check(`RPM ${sample.requestedRpm} ${delta.wave} target gain matches the retail PLF`,
      delta.targetGainDelta < 1e-9, 'delta ' + delta.targetGainDelta);
    check(`RPM ${sample.requestedRpm} ${delta.wave} target rate matches the retail PLF`,
      delta.targetRateDelta < 1e-9, 'delta ' + delta.targetRateDelta);
    check(`RPM ${sample.requestedRpm} ${delta.wave} live gain matches the retail PLF within 1e-3`,
      delta.gainDelta < 1e-3, 'delta ' + delta.gainDelta);
    check(`RPM ${sample.requestedRpm} ${delta.wave} live rate matches the retail PLF within 1e-3`,
      delta.rateDelta < 1e-3, 'delta ' + delta.rateDelta);
  }
}

check('mute silences the analyser', Boolean(muted.levels && muted.levels.rms < 0.002),
  JSON.stringify(muted.levels));
check('mute keeps the context running', muted.contextState === 'running', muted.contextState);
check('unmute restores output', Boolean(unmuted.levels && unmuted.levels.rms > 0.001),
  JSON.stringify(unmuted.levels));
check('dispose reports the disposed state', afterDispose.state === 'disposed', afterDispose.state);
check('dispose closes the AudioContext', afterDispose.contextState === 'closed',
  afterDispose.contextState);
check('dispose drops buffers and layers',
  afterDispose.decoded === 0 && afterDispose.layers === 0,
  JSON.stringify(afterDispose));

check('failure paths report unavailable with typed reasons',
  Boolean(failurePath) && Array.isArray(failurePath.results)
    && failurePath.results.length === 2
    && failurePath.results.every((entry) => entry.state === 'unavailable'),
  JSON.stringify(failurePath));
check('failure paths expose fetch-failed and decode-failed',
  Boolean(failurePath) && Array.isArray(failurePath.results)
    && JSON.stringify(failurePath.results.map((entry) => entry.reason).sort())
      === JSON.stringify(['decode-failed', 'fetch-failed']),
  JSON.stringify(failurePath?.results?.map((entry) => entry.reason)));
check('failure paths decoded nothing',
  Boolean(failurePath) && Array.isArray(failurePath.results)
    && failurePath.results.every((entry) => entry.decoded === 0),
  JSON.stringify(failurePath?.results?.map((entry) => entry.decoded)));
check('failure path did not disturb the running engine',
  mainAfterFailure.state === 'running' && mainAfterFailure.contextState === 'running'
    && mainAfterFailure.decoded === 6 && mainAfterFailure.levels.rms > 0.001,
  JSON.stringify(mainAfterFailure));

check('no page errors captured', live.errors.length === 0, JSON.stringify(live.errors));
const blocking = messages.filter((entry) => entry.source !== 'console.log'
  && entry.source !== 'console.info');
check('console clean', blocking.length === 0,
  blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));
const shotBytes = statSync(shotFile).size;
check('screenshot written', shotBytes > 20000, shotBytes + ' bytes');

const evidence = {
  generatedAt: new Date().toISOString(),
  module: 'probes/audio/web/engine-audio.js',
  page: origin + '/web/',
  browser: {
    executable: edge,
    mode: 'headless=new',
    viewport: VIEWPORT,
    autoplayPolicyOverride: null,
    gesture: 'Input.dispatchMouseEvent (mousePressed/mouseReleased) on #play',
  },
  curveSource: {
    object: model.object,
    dat: model.dat,
    datSha256: model.datSha256,
    modelReference: '_work/audio/engine-model.json',
    layers: activeLoops.length,
  },
  beforeGesture,
  afterGesture: {
    state: live.state, contextState: live.contextState, sampleRate: live.sampleRate,
    decoded: live.decoded, layers: live.layers,
  },
  wavChecks,
  samples,
  mute: { muted, unmuted },
  dispose: { before: beforeDispose, after: afterDispose },
  failurePath: { reported: failurePath, mainEngineAfter: mainAfterFailure },
  screenshot: path.relative(ROOT, shotFile).split(path.sep).join('/'),
  console: { total: messages.length, errorsAndWarnings: blocking.length, messages: messages.slice() },
  assertions: { ok: failures.length === 0, failures },
  verdict: failures.length === 0 ? 'engine-audio-module-verified' : 'failed',
};

writeFileSync(path.join(OUT, 'module-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
writeFileSync(path.join(LOGS, 'module-edge.log'), browserLog, 'utf8');
await shutdown();
await sleep(300);

console.log(JSON.stringify({
  verdict: evidence.verdict,
  consoleMessages: evidence.console.total,
  errorsAndWarnings: evidence.console.errorsAndWarnings,
  failures,
  beforeGesture: {
    state: beforeGesture.state, contextState: beforeGesture.contextState,
    decoded: beforeGesture.decoded, levels: beforeGesture.levels,
  },
  afterGesture: {
    state: live.state, contextState: live.contextState, sampleRate: live.sampleRate,
    decoded: live.decoded.map((entry) => ({
      wave: entry.wave, duration: Number(entry.duration.toFixed(3)),
      sampleRate: entry.sampleRate, channels: entry.channels,
    })),
  },
  samples: samples.map((sample) => ({
    rpm: sample.requestedRpm,
    rms: Number(sample.levels.rms.toFixed(5)),
    peak: Number(sample.levels.peak.toFixed(5)),
    layers: sample.actual.map((entry) => ({
      slot: entry.slot,
      wave: entry.wave,
      gain: Number(entry.gain.toFixed(5)),
      rate: Number(entry.rate.toFixed(5)),
      targetGain: Number(entry.targetGain.toFixed(5)),
      targetRate: Number(entry.targetRate.toFixed(5)),
    })),
    maxGainDelta: Number(Math.max(...sample.deltas.map((d) => d.gainDelta)).toExponential(2)),
    maxRateDelta: Number(Math.max(...sample.deltas.map((d) => d.rateDelta)).toExponential(2)),
  })),
  mute: { rmsMuted: muted.levels?.rms, rmsUnmuted: unmuted.levels?.rms },
  failurePath,
  dispose: afterDispose,
  screenshot: evidence.screenshot,
  screenshotBytes: shotBytes,
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
