// Headless Edge verification for probes/audio/web/tyre-collision-audio.js.
//
//   node probes/audio/capture_tyre_collision.mjs [--edge <msedge.exe>] [--port 0]
//
// Loaded WITHOUT --autoplay-policy=no-user-gesture-required. The verifier checks
// that no AudioContext exists before the synthetic click on "Start audio", then
// requires the context to become `running`.
//
// Evidence: _work/audio/tyre-collision-evidence.json
//           _work/audio/tyre-collision-harness.png
// Log:      _work/logs/audio/tyre-collision-edge.log

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/audio');
const LOGS = path.join(ROOT, '_work/logs/audio');
const MODEL = path.join(OUT, 'tyre-collision-model.json');
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
if (!existsSync(MODEL)) throw new Error(`missing ${MODEL}; run probes/audio/dump_tyre_collision.py first`);

const PORT = Number(option('--port', '0'));
const DEBUG_PORT = Number(option('--debug-port', '9351'));
const PROFILE = path.join(OUT, 'edge-profile-tyre-collision');
const VIEWPORT = { width: 1280, height: 900 };
const SETTLE_MS = 500;
mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = startServer({ port: PORT });
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

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
    messages.push({
      source: 'log.' + message.params.entry.level,
      text: message.params.entry.text,
      url: message.params.entry.url,
    });
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

await send('Page.navigate', { url: origin + '/web/tyre-collision.html' });

let boot = null;
for (let attempt = 0; attempt < 200; attempt++) {
  boot = await evaluate(`(()=>{const p=window.tyreCollisionProbe;return p?{
    ready:p.ready, state:p.state, surfaces:Object.keys(p.surfaces).length}:null})()`).catch(() => null);
  if (boot && boot.ready) break;
  await sleep(100);
}
if (!boot || !boot.ready) throw new Error('tyre/collision harness never became ready: ' + JSON.stringify(boot));

const beforeGesture = await evaluate(`(()=>{const p=window.tyreCollisionProbe;const d=p.diagnostics;return {
  state:d.state, contextState:d.contextState, decoded:d.decoded.length,
  levels:d.levels, surfaces:d.collision.surfaces, routes:d.collision.materialRoutes,
  errors:p.errors}})()`);

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

// A second instance, constructed before the gesture, must refuse a trigger.
const preStartTrigger = await evaluate(`window.tyreCollisionProbe.triggerImpact(50, 'Metal')`);

await clickSelector('#play');

let live = null;
for (let attempt = 0; attempt < 400; attempt++) {
  live = await evaluate(`(()=>{const p=window.tyreCollisionProbe;const d=p.diagnostics;return {
    state:d.state, reason:d.reason, detail:d.detail, contextState:d.contextState,
    sampleRate:d.sampleRate, decoded:d.decoded, tyreLayers:d.tyreLayers,
    collision:d.collision, levels:d.levels, errors:p.errors}})()`).catch(() => null);
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

await sleep(SETTLE_MS);

const model = JSON.parse(readFileSync(MODEL, 'utf8'));

function evalPlf(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points[points.length - 1][1];
}
const clampRate = (rate) => Math.max(0.00390625, rate);
const graphCurves = (name) => Object.fromEntries(
  model.graphs[name].curves.map((curve) => [curve.name, curve.points]));

const dry = graphCurves('wheel_dry');
const offroad = graphCurves('wheel_offroad');
const collisionWorld = graphCurves('collisionworld');

const moduleTables = await evaluate(`(()=>{const p=window.tyreCollisionProbe;return {
  surfaces:p.surfaces, materials:p.materials, tables:p.tables, provenance:p.provenance}})()`);

const samePoints = (a, b) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length
  && a.every((point, index) => Math.abs(point[0] - b[index][0]) <= 1e-12
    && Math.abs(point[1] - b[index][1]) <= 1e-12);

const moduleTyre = moduleTables.tables;
const tableChecks = [];
function compareCurve(label, modulePoints, modelPoints) {
  tableChecks.push({ label, match: samePoints(modulePoints, modelPoints) });
}
compareCurve('dry.roadGain', moduleTyre.dry.roadGain, dry.DryRoadSpeedVolumeTrue);
compareCurve('dry.skidSpeed', moduleTyre.dry.skidSpeed, dry.SkidSpeedVolume);
compareCurve('dry.skidSlip[0]', moduleTyre.dry.skidSlip[0], dry.Asphalt_Skid0VolumePLF);
compareCurve('dry.skidSlip[1]', moduleTyre.dry.skidSlip[1], dry.Asphalt_Skid1VolumePLF);
compareCurve('dry.skidSlip[2]', moduleTyre.dry.skidSlip[2], dry.Asphalt_Skid2VolumePLF);
compareCurve('dry.skidPitchSpeed', moduleTyre.dry.skidPitchSpeed, dry.SkidSpeedPitch);
compareCurve('dry.skidPitchSlip', moduleTyre.dry.skidPitchSlip, dry.Asphalt_SkidSlidePitchModifier);
compareCurve('offroad.roadGain', moduleTyre.offroad.roadGain, offroad.OffRoadSpeedVolume);
compareCurve('offroad.skidSpeed', moduleTyre.offroad.skidSpeed, offroad.OffRoadSkidSpeedVolume);
compareCurve('offroad.skidSlip', moduleTyre.offroad.skidSlip, offroad.OffRoadSkidVolumePLF);
compareCurve('offroad.skidPitchSpeed', moduleTyre.offroad.skidPitchSpeed, offroad.OffRoadSkidSpeedPitch);
compareCurve('offroad.skidPitchSlip', moduleTyre.offroad.skidPitchSlip, offroad.OffRoadSkidSlidePitch);
compareCurve('collision.volumeDb', moduleTyre.collisionVolumeDb, collisionWorld.CollisionVolume);

function expectedDry(slip, speed) {
  const speedGain = evalPlf(dry.SkidSpeedVolume, speed);
  const speedPitch = evalPlf(dry.SkidSpeedPitch, speed);
  const slipPitch = evalPlf(dry.Asphalt_SkidSlidePitchModifier, slip);
  return [
    { id: 'road', wave: 'Asphalt_Road', gain: evalPlf(dry.DryRoadSpeedVolumeTrue, speed), rate: 1 },
    { id: 'skid0', wave: 'Asphalt_Lateral_1', gain: speedGain * evalPlf(dry.Asphalt_Skid0VolumePLF, slip), rate: clampRate(speedPitch * slipPitch) },
    { id: 'skid1', wave: 'Asphalt_Lateral_2', gain: speedGain * evalPlf(dry.Asphalt_Skid1VolumePLF, slip), rate: clampRate(speedPitch * slipPitch) },
    { id: 'skid2', wave: 'Asphalt_Lateral_3', gain: speedGain * evalPlf(dry.Asphalt_Skid2VolumePLF, slip), rate: clampRate(speedPitch * slipPitch) },
  ];
}

const WAVES = {
  gravel: { road: 'Gravel_road', skid: 'Gravel_skid' },
  grass: { road: 'Dirt_road', skid: 'Dirt_skid' },
  sand: { road: 'Sand_road', skid: 'Sand_skid' },
  foliage: { road: 'Foliage_road', skid: null },
};

function expectedOffroad(substrate, slip, speed) {
  const waves = WAVES[substrate];
  const speedGain = evalPlf(offroad.OffRoadSkidSpeedVolume, speed);
  const speedPitch = evalPlf(offroad.OffRoadSkidSpeedPitch, speed);
  const slipPitch = evalPlf(offroad.OffRoadSkidSlidePitch, slip);
  const layers = [{ id: 'road', wave: waves.road, gain: evalPlf(offroad.OffRoadSpeedVolume, speed), rate: 1 }];
  if (waves.skid) {
    layers.push({
      id: 'skid',
      wave: waves.skid,
      gain: speedGain * evalPlf(offroad.OffRoadSkidVolumePLF, slip),
      rate: clampRate(speedPitch * slipPitch),
    });
  }
  return layers;
}

function compareLayers(expected, actual) {
  const byWave = new Map((actual.targets ?? []).map((layer) => [layer.wave, layer]));
  const live = new Map((actual.live ?? []).map((layer) => [layer.wave, layer]));
  return expected.map((want) => {
    const target = byWave.get(want.wave);
    const real = live.get(want.wave);
    return {
      wave: want.wave,
      targetGainDelta: target ? Math.abs(target.gain - want.gain) : Infinity,
      targetRateDelta: target ? Math.abs(target.rate - want.rate) : Infinity,
      liveGainDelta: real ? Math.abs(real.gain - want.gain) : Infinity,
      liveRateDelta: real ? Math.abs(real.rate - want.rate) : Infinity,
    };
  });
}

async function tyreState(surface, substrate, slip, speed) {
  await evaluate(`window.tyreCollisionProbe.setSurface(${JSON.stringify(surface)}, ${JSON.stringify(substrate)})`);
  await evaluate(`window.tyreCollisionProbe.setSlip(${slip}, ${speed})`);
  await sleep(SETTLE_MS);
  return evaluate(`(()=>{const d=window.tyreCollisionProbe.diagnostics;return {
    surface:d.surface, substrate:d.substrate, slip:d.slip, speed:d.speed,
    targets:d.tyreTargets, live:d.tyreLayers, levels:d.levels}})()`);
}

const tyreCases = [];
const TYRE_CASES = [
  ['dry', 'gravel', 0.2, 20, () => expectedDry(0.2, 20)],
  ['dry', 'gravel', -0.35, 5, () => expectedDry(-0.35, 5)],
  ['dry', 'gravel', 0, 0, () => expectedDry(0, 0)],
  ['offroad', 'gravel', 0.2, 20, () => expectedOffroad('gravel', 0.2, 20)],
  ['offroad', 'grass', -0.3, 10, () => expectedOffroad('grass', -0.3, 10)],
  ['offroad', 'sand', 0.5, 30, () => expectedOffroad('sand', 0.5, 30)],
  ['offroad', 'foliage', 0.1, 15, () => expectedOffroad('foliage', 0.1, 15)],
];
for (const [surface, substrate, slip, speed, expected] of TYRE_CASES) {
  const state = await tyreState(surface, substrate, slip, speed);
  const wanted = expected();
  const activeWaves = new Set(wanted.map((layer) => layer.wave));
  const inactiveMaxGain = Math.max(0, ...state.live
    .filter((layer) => !activeWaves.has(layer.wave))
    .map((layer) => layer.gain));
  tyreCases.push({
    surface, substrate, slip, speed,
    reported: { surface: state.surface, substrate: state.substrate, slip: state.slip, speed: state.speed },
    expected: wanted, targets: state.targets, live: state.live, levels: state.levels,
    inactiveMaxGain, deltas: compareLayers(wanted, state),
  });
}

// Collision material routing must match the decoded CollisionScript exactly.
const routingChecks = [];
for (const route of model.graphs.collisionworld.collisionRouting) {
  const sound = model.graphs.collisionworld.sounds.find((entry) => entry.name === route.targetName);
  const surfaceKey = Object.entries(moduleTables.surfaces).find(([, entry]) =>
    entry.bank === sound.bank
    && entry.waves.length === sound.waves.length
    && entry.waves.every((wave, index) => wave === sound.waves[index]))?.[0] ?? null;
  const sample = await evaluate(
    `window.tyreCollisionProbe.sampleCollision(50, ${route.surfaceValue})`);
  routingChecks.push({
    surfaceValue: route.surfaceValue, targetName: route.targetName,
    bank: sound.bank, waves: sound.waves,
    expectedSurface: surfaceKey, actualSurface: sample.surface,
    supported: sample.supported, match: sample.surface === surfaceKey,
  });
}

const unsupportedMaterial = await evaluate(`window.tyreCollisionProbe.sampleCollision(50, 'Tarmac')`);

// Impact gating, retrigger and unsupported material.
async function trigger(strength, material) {
  return evaluate(`window.tyreCollisionProbe.triggerImpact(${strength}, ${JSON.stringify(material)})`);
}
const firstImpact = await trigger(150, 'Rubber');
await sleep(80);
const impactRms = await evaluate(`(()=>{const d=window.tyreCollisionProbe.diagnostics;return {
  active:d.collision.active, wave:d.collision.activeWave, levels:d.levels}})()`);
const gatedImpact = await trigger(150, 'Rubber');
const idle = await evaluate(`window.tyreCollisionProbe.waitForImpactIdle(5000)`);
await sleep(120);
const secondImpact = await trigger(150, 'Rubber');
const idle2 = await evaluate(`window.tyreCollisionProbe.waitForImpactIdle(5000)`);
const unsupportedImpact = await trigger(50, 'Tarmac');

// Leave the page on a representative frame for the screenshot: tyre layers at
// speed plus an active Metal impact.
await evaluate(`window.tyreCollisionProbe.setSurface('dry', 'gravel')`);
await evaluate(`window.tyreCollisionProbe.setSlip(0.2, 20)`);
await sleep(SETTLE_MS);
const screenshotImpact = await trigger(50, 'Metal');
await sleep(80);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const shotFile = path.join(OUT, 'tyre-collision-harness.png');
writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));

// Failure paths, mute/unmute and dispose.
await clickSelector('#failure');
let failurePath = null;
for (let attempt = 0; attempt < 120; attempt++) {
  failurePath = await evaluate(`(()=>{const p=window.tyreCollisionProbe;return p.failureResult})()`);
  if (failurePath && !failurePath.pending) break;
  await sleep(100);
}
const mainAfterFailure = await evaluate(`(()=>{const d=window.tyreCollisionProbe.diagnostics;return {
  state:d.state, contextState:d.contextState, decoded:d.decoded.length, levels:d.levels}})()`);

await evaluate(`window.tyreCollisionProbe.setMuted(true)`);
await sleep(500);
const muted = await evaluate(`(()=>{const d=window.tyreCollisionProbe.diagnostics;return {
  muted:d.muted, levels:d.levels, state:d.state, contextState:d.contextState}})()`);
await evaluate(`window.tyreCollisionProbe.setMuted(false)`);
await sleep(500);
const unmuted = await evaluate(`(()=>{const d=window.tyreCollisionProbe.diagnostics;return {
  muted:d.muted, levels:d.levels, state:d.state, contextState:d.contextState}})()`);

const beforeDispose = await evaluate(`(()=>{const d=window.tyreCollisionProbe.diagnostics;return {
  state:d.state, contextState:d.contextState}})()`);
await evaluate(`window.tyreCollisionProbe.dispose()`);
await sleep(500);
const afterDispose = await evaluate(`(()=>{const p=window.tyreCollisionProbe;const d=p.diagnostics;return {
  state:d.state, contextState:d.contextState, decoded:d.decoded.length,
  layers:d.tyreLayers.length, levels:d.levels}})()`);

// Served WAVs must hash-match the decoded bank reports.
const waveHashes = new Map();
for (const bank of Object.values(model.banks)) {
  for (const wave of bank.waves) {
    if (wave.wavSha256) waveHashes.set(wave.name, { sha256: wave.wavSha256, bytes: wave.wavBytes, bank: bank.bankName });
  }
}
const wavChecks = [];
for (const wave of live.decoded.map((entry) => entry.wave)) {
  const response = await fetch(origin + '/_work/audio/' + encodeURIComponent(wave) + '.wav');
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const expected = waveHashes.get(wave);
  wavChecks.push({ wave, bytes: bytes.length, sha256, expected: expected?.sha256 ?? null,
    match: Boolean(expected) && sha256 === expected.sha256 && bytes.length === expected.bytes });
}

const failures = [];
const check = (label, ok, detail) => { if (!ok) failures.push(label + (detail ? ': ' + detail : '')); };

check('no AudioContext before the gesture', beforeGesture.contextState === 'none', beforeGesture.contextState);
check('module idle before the gesture', beforeGesture.state === 'idle', beforeGesture.state);
check('nothing decoded before the gesture', beforeGesture.decoded === 0, String(beforeGesture.decoded));
check('no autoplay levels before the gesture', beforeGesture.levels === null, JSON.stringify(beforeGesture.levels));
check('trigger before the gesture is refused with not-running',
  preStartTrigger && preStartTrigger.triggered === false && preStartTrigger.reason === 'not-running',
  JSON.stringify(preStartTrigger));
check('AudioContext running after the synthetic user gesture', live.contextState === 'running', live.contextState);
check('AudioContext reports a working sample rate',
  Number.isFinite(live.sampleRate) && live.sampleRate >= 32000, String(live.sampleRate));
check('53 retail WAVs decoded (11 tyre + 42 collision)', live.decoded.length === 53, String(live.decoded.length));
check('all tyre loops started once', live.tyreLayers.length === 11, String(live.tyreLayers.length));
check('decoded buffers are mono at the context sample rate',
  live.decoded.every((entry) => entry.channels === 1 && entry.sampleRate === live.sampleRate),
  JSON.stringify(live.decoded.filter((entry) => entry.channels !== 1 || entry.sampleRate !== live.sampleRate)));
check('decoded buffers are non-silent',
  live.decoded.every((entry) => entry.peak > 0.001),
  JSON.stringify(live.decoded.filter((entry) => entry.peak <= 0.001).map((entry) => entry.wave)));
check('14 collision surface tables present', beforeGesture.surfaces === 14, String(beforeGesture.surfaces));
check('18 material routes present', beforeGesture.routes === 18, String(beforeGesture.routes));
check('module embedded curves equal the reference model within 1e-12',
  tableChecks.every((entry) => entry.match),
  JSON.stringify(tableChecks.filter((entry) => !entry.match)));

for (const sample of tyreCases) {
  const label = `${sample.surface}/${sample.substrate} slip ${sample.slip} speed ${sample.speed}`;
  check(`${label}: surface/slip/speed reached the module`,
    sample.reported.surface === sample.surface
    && sample.reported.slip === sample.slip
    && sample.reported.speed === sample.speed,
    JSON.stringify(sample.reported));
  for (const delta of sample.deltas) {
    check(`${label} ${delta.wave}: target gain matches the retail PLF`,
      delta.targetGainDelta < 1e-9, String(delta.targetGainDelta));
    check(`${label} ${delta.wave}: target rate matches the retail PLF`,
      delta.targetRateDelta < 1e-9, String(delta.targetRateDelta));
    check(`${label} ${delta.wave}: live gain matches the retail PLF within 1e-3`,
      delta.liveGainDelta < 1e-3, String(delta.liveGainDelta));
    check(`${label} ${delta.wave}: live rate matches the retail PLF within 1e-3`,
      delta.liveRateDelta < 1e-3, String(delta.liveRateDelta));
  }
  const silent = sample.speed === 0;
  check(`${label}: analyser ${silent ? 'is silent' : 'is non-silent'}`,
    Boolean(sample.levels) && (silent ? sample.levels.rms < 0.002 : sample.levels.rms > 0.001),
    JSON.stringify(sample.levels));
  check(`${label}: layers from other surfaces are silent`,
    sample.inactiveMaxGain < 1e-3, String(sample.inactiveMaxGain));
}

for (const route of routingChecks) {
  check(`material ${route.surfaceValue} (${route.targetName}) routes to ${route.expectedSurface}`,
    route.match && route.supported, JSON.stringify(route));
}
check('unsupported material (Tarmac) is refuted, not substituted',
  unsupportedMaterial && unsupportedMaterial.supported === false && unsupportedMaterial.surface === null,
  JSON.stringify(unsupportedMaterial));

check('impact 1 triggered', firstImpact && firstImpact.triggered === true, JSON.stringify(firstImpact));
check('impact 1 used the rubber_tyre table and first wave',
  firstImpact?.surface === 'rubber_tyre' && firstImpact?.waveIndex === 0, JSON.stringify(firstImpact));
check('impact gain matches 10^(CollisionVolume(dB)/20) at strength 150',
  firstImpact && Math.abs(firstImpact.gain - 10 ** (evalPlf(collisionWorld.CollisionVolume, 150) / 20)) < 1e-9,
  JSON.stringify(firstImpact));
check('impact is audible while active', impactRms.levels && impactRms.levels.rms > 0.001,
  JSON.stringify(impactRms));
check('second trigger during playback is gated with in-progress',
  gatedImpact && gatedImpact.triggered === false && gatedImpact.reason === 'in-progress',
  JSON.stringify(gatedImpact));
check('impact gate clears after the one-shot ends', idle === true, String(idle));
check('retrigger after the gate plays the next wave',
  secondImpact && secondImpact.triggered === true && secondImpact.waveIndex === 1
  && secondImpact.wave !== firstImpact.wave, JSON.stringify(secondImpact));
check('second impact gate clears', idle2 === true, String(idle2));
check('unsupported material impact is refused with unsupported-material',
  unsupportedImpact && unsupportedImpact.triggered === false
  && unsupportedImpact.reason === 'unsupported-material', JSON.stringify(unsupportedImpact));

check('mute silences the analyser', Boolean(muted.levels && muted.levels.rms < 0.002), JSON.stringify(muted.levels));
check('mute keeps the context running', muted.contextState === 'running', muted.contextState);
check('unmute restores output', Boolean(unmuted.levels && unmuted.levels.rms > 0.001), JSON.stringify(unmuted.levels));

check('dispose reports the disposed state', afterDispose.state === 'disposed', afterDispose.state);
check('dispose closes the AudioContext', afterDispose.contextState === 'closed', afterDispose.contextState);
check('dispose drops buffers and layers', afterDispose.decoded === 0 && afterDispose.layers === 0,
  JSON.stringify(afterDispose));

check('served WAV bytes match the decoded bank hashes',
  wavChecks.length === 53 && wavChecks.every((entry) => entry.match),
  JSON.stringify(wavChecks.filter((entry) => !entry.match).slice(0, 5)));

check('failure paths report unavailable with typed reasons',
  Boolean(failurePath) && Array.isArray(failurePath.results)
    && failurePath.results.length === 2
    && failurePath.results.every((entry) => entry.state === 'unavailable'),
  JSON.stringify(failurePath));
check('failure paths expose fetch-failed and decode-failed',
  Boolean(failurePath) && JSON.stringify(failurePath.results.map((entry) => entry.reason).sort())
    === JSON.stringify(['decode-failed', 'fetch-failed']),
  JSON.stringify(failurePath?.results?.map((entry) => entry.reason)));
check('failure paths decoded nothing',
  Boolean(failurePath) && failurePath.results.every((entry) => entry.decoded === 0),
  JSON.stringify(failurePath?.results?.map((entry) => entry.decoded)));
check('failure path did not disturb the running instance',
  mainAfterFailure.state === 'running' && mainAfterFailure.contextState === 'running'
    && mainAfterFailure.decoded === 53 && mainAfterFailure.levels.rms > 0.001,
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
  module: 'probes/audio/web/tyre-collision-audio.js',
  page: origin + '/web/tyre-collision.html',
  browser: {
    executable: edge,
    mode: 'headless=new',
    viewport: VIEWPORT,
    autoplayPolicyOverride: null,
    gesture: 'Input.dispatchMouseEvent (mousePressed/mouseReleased) on #play',
  },
  model: {
    reference: '_work/audio/tyre-collision-model.json',
    wheelDrySha256: model.graphs.wheel_dry.sha256,
    wheelOffroadSha256: model.graphs.wheel_offroad.sha256,
    collisionWorldSha256: model.graphs.collisionworld.sha256,
  },
  beforeGesture,
  afterGesture: {
    state: live.state, contextState: live.contextState, sampleRate: live.sampleRate,
    decoded: live.decoded.length, tyreLayers: live.tyreLayers.length,
  },
  tableChecks,
  tyreCases,
  routingChecks,
  unsupportedMaterial,
  impacts: {
    first: firstImpact, gated: gatedImpact, second: secondImpact,
    unsupported: unsupportedImpact, impactRms, screenshotImpact,
  },
  wavChecks,
  mute: { muted, unmuted },
  dispose: { before: beforeDispose, after: afterDispose },
  failurePath: { reported: failurePath, mainAfter: mainAfterFailure },
  screenshot: path.relative(ROOT, shotFile).split(path.sep).join('/'),
  console: { total: messages.length, errorsAndWarnings: blocking.length, messages: messages.slice() },
  assertions: { ok: failures.length === 0, failures },
  verdict: failures.length === 0 ? 'tyre-collision-audio-module-verified' : 'failed',
};

writeFileSync(path.join(OUT, 'tyre-collision-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
writeFileSync(path.join(LOGS, 'tyre-collision-edge.log'), browserLog, 'utf8');
await shutdown();
await sleep(300);

console.log(JSON.stringify({
  verdict: evidence.verdict,
  consoleMessages: evidence.console.total,
  errorsAndWarnings: evidence.console.errorsAndWarnings,
  failures,
  beforeGesture,
  afterGesture: evidence.afterGesture,
  tyreCases: tyreCases.map((sample) => ({
    state: `${sample.surface}/${sample.substrate} slip=${sample.slip} speed=${sample.speed}`,
    rms: Number((sample.levels?.rms ?? 0).toFixed(5)),
    peak: Number((sample.levels?.peak ?? 0).toFixed(5)),
    layers: sample.targets.map((layer) => ({
      wave: layer.wave, gain: Number(layer.gain.toFixed(5)), rate: Number(layer.rate.toFixed(5)),
    })),
    maxLiveGainDelta: Number(Math.max(...sample.deltas.map((d) => d.liveGainDelta)).toExponential(2)),
    maxLiveRateDelta: Number(Math.max(...sample.deltas.map((d) => d.liveRateDelta)).toExponential(2)),
    inactiveMaxGain: Number(sample.inactiveMaxGain.toExponential(2)),
  })),
  routing: routingChecks.map((entry) => ({
    value: entry.surfaceValue, expected: entry.expectedSurface, actual: entry.actualSurface, match: entry.match,
  })),
  impacts: {
    first: firstImpact && { wave: firstImpact.wave, gain: firstImpact.gain, triggered: firstImpact.triggered },
    gated: gatedImpact && gatedImpact.reason,
    second: secondImpact && { wave: secondImpact.wave, waveIndex: secondImpact.waveIndex },
    unsupported: unsupportedImpact && unsupportedImpact.reason,
    rms: impactRms.levels?.rms,
  },
  mute: { rmsMuted: muted.levels?.rms, rmsUnmuted: unmuted.levels?.rms },
  failurePath,
  dispose: afterDispose,
  screenshot: evidence.screenshot,
  screenshotBytes: shotBytes,
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
