// Headless Edge capture/verification for the engine-audio harness.
//
//   node probes/audio/capture_harness.mjs [--edge <msedge.exe>] [--port 0]
//
// Starts the read-only server, loads the page, presses Play, and records:
//   * model identity and the exact RPM curves loaded
//   * decoded AudioBuffer durations
//   * AudioContext state and sample rate
//   * per-loop gain/playbackRate at 1500/3015/6000 RPM
//   * analyser RMS/peak (proves non-silent decoded audio is flowing)
//   * a screenshot and all console messages
//
// Evidence: _work/audio/harness-evidence.json, _work/audio/harness.png
// Log:      _work/logs/audio/harness-edge.log

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
const DEBUG_PORT = Number(option('--debug-port', '9347'));
const PROFILE = path.join(OUT, 'edge-profile');
const VIEWPORT = { width: 1280, height: 760 };
mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = startServer({ port: PORT });
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = spawn(edge, [
  '--headless=new',
  '--autoplay-policy=no-user-gesture-required',
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

await send('Page.navigate', { url: origin + '/' });
let ready = null;
for (let attempt = 0; attempt < 200; attempt++) {
  ready = await evaluate(`(()=>{const p=window.audioHarnessProbe;return p?{
    mode:p.mode, hasModel:!!p.model, loops:p.loops.length}:null})()`).catch(() => null);
  if (ready && ready.hasModel) break;
  await sleep(100);
}
if (!ready || !ready.hasModel) throw new Error('harness never loaded engine-model.json');

const modelResponse = await fetch(origin + '/_work/audio/engine-model.json');
const model = await modelResponse.json();

// Start from a trusted-ish evaluation. Headless Edge is launched with
// --autoplay-policy=no-user-gesture-required, so resume() succeeds.
await evaluate(`window.audioHarnessProbe.start()`);
let live = null;
for (let attempt = 0; attempt < 200; attempt++) {
  live = await evaluate(`(()=>{const p=window.audioHarnessProbe;return p?{
    playing:p.playing, context:p.contextState, sampleRate:p.sampleRate,
    decoded:p.decoded, sources:p.sources, levels:p.levels}:null})()`).catch(() => null);
  if (live && live.playing && live.decoded.length === 6) break;
  await sleep(100);
}
if (!live || !live.playing) throw new Error('harness did not start playing: ' + JSON.stringify(live));
if (live.context !== 'running') throw new Error('AudioContext is ' + live.context);
if (live.decoded.length !== 6) throw new Error('decoded ' + live.decoded.length + ' of 6 buffers');

// Let the gain envelopes reach their targets before the first level snapshot.
await sleep(600);
live = await evaluate(`(()=>{const p=window.audioHarnessProbe;return {
  playing:p.playing, context:p.contextState, sampleRate:p.sampleRate,
  decoded:p.decoded, sources:p.sources, levels:p.levels}})()`);

const oscillator = await evaluate(`window.audioHarnessProbe.testOscillator()`);
const bufferTest = await evaluate(`window.audioHarnessProbe.testBuffer(1)`);
const masterTest = await evaluate(`window.audioHarnessProbe.testMaster()`);

function evalPlf(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

const samples = [];
for (const rpm of [1500, 3015, 6000]) {
  await evaluate(`window.audioHarnessProbe.setRpm(${rpm})`);
  await sleep(350);
  const state = await evaluate(`(()=>{const p=window.audioHarnessProbe;return {
    rpm:Number(document.getElementById('rpm').value), sources:p.sources, levels:p.levels}})()`);
  const x = rpm * 0.0001;
  const expected = model.loops.filter((loop) => loop.rpmLabel !== null).map((loop) => ({
    slot: loop.slot, wave: loop.wave, rpmLabel: loop.rpmLabel,
    gain: evalPlf(loop.volume, x),
    rate: Math.max(0.00390625, evalPlf(loop.pitch, x)),
  }));
  const actual = new Map(state.sources.map((entry) => [entry.slot, entry]));
  const deltas = expected.map((want) => {
    const got = actual.get(want.slot);
    return {
      slot: want.slot, wave: want.wave,
      gainDelta: got ? Math.abs(got.gain - want.gain) : Infinity,
      rateDelta: got ? Math.abs(got.rate - want.rate) : Infinity,
    };
  });
  samples.push({ rpm, x, levels: state.levels, expected, actual: state.sources, deltas });
}

await evaluate(`window.audioHarnessProbe.setRpm(3015)`);
await sleep(250);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const shotFile = path.join(OUT, 'harness.png');
writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));

const failures = [];
const check = (label, ok, detail) => { if (!ok) failures.push(label + (detail ? ': ' + detail : '')); };
check('six retail WAVs decoded', live.decoded.length === 6, String(live.decoded.length));
check('AudioContext running', live.context === 'running', live.context);
check('non-silent analyser RMS', samples.some((sample) => sample.levels && sample.levels.rms > 0.001),
  JSON.stringify(samples.map((sample) => [sample.rpm, sample.levels])));
for (const sample of samples) {
  for (const delta of sample.deltas) {
    check(`RPM ${sample.rpm} ${delta.wave} gain matches the retail PLF`,
      delta.gainDelta < 0.01, 'delta ' + delta.gainDelta);
    check(`RPM ${sample.rpm} ${delta.wave} playbackRate matches RPM/label`,
      delta.rateDelta < 0.01, 'delta ' + delta.rateDelta);
  }
}
const blocking = messages.filter((entry) => entry.source !== 'console.log' && entry.source !== 'console.info');
check('console clean', blocking.length === 0,
  blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));

const evidence = {
  generatedAt: new Date().toISOString(),
  browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT,
    autoplayPolicy: 'no-user-gesture-required' },
  url: origin + '/',
  model: {
    object: model.object,
    datSha256: model.datSha256,
    dat: model.dat,
    declaredComponents: model.header.declaredComponents,
    parsedComponents: model.header.parsedComponents,
    walkError: model.header.walkError,
    loops: model.loops,
  },
  runtime: {
    contextState: live.context,
    sampleRate: live.sampleRate,
    decoded: live.decoded,
    levels: live.levels,
    sources: live.sources,
    oscillator,
    bufferTest,
    masterTest,
  },
  samples,
  screenshot: path.relative(ROOT, shotFile).split(path.sep).join('/'),
  console: { total: messages.length, errorsAndWarnings: blocking.length, messages: messages.slice() },
  assertions: { ok: failures.length === 0, failures },
  verdict: failures.length === 0 ? 'decoded-audio-playing-and-curves-match' : 'failed',
};

const evidenceFile = path.join(OUT, 'harness-evidence.json');
writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
writeFileSync(path.join(LOGS, 'harness-edge.log'), browserLog, 'utf8');
await shutdown();
await sleep(300);
console.log(JSON.stringify({
  verdict: evidence.verdict,
  consoleMessages: evidence.console.total,
  errorsAndWarnings: evidence.console.errorsAndWarnings,
  failures,
  contextState: evidence.runtime.contextState,
  sampleRate: evidence.runtime.sampleRate,
  levels: evidence.runtime.levels,
  oscillator: evidence.runtime.oscillator,
  bufferTest: evidence.runtime.bufferTest,
  masterTest: evidence.runtime.masterTest,
  screenshot: evidence.screenshot,
  samples: samples.map((sample) => ({ rpm: sample.rpm,
    gains: sample.actual.map((entry) => [entry.slot, Number(entry.gain.toFixed(3))]),
    rates: sample.actual.map((entry) => [entry.slot, Number(entry.rate.toFixed(4))]) })),
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
