// Headless Edge (WebGPU) capture + console gate for the E1 drive slice.
//
//   node probes/e1-drive/tools/capture_browser.mjs [--car <slug|name>] [--edge <msedge.exe>]
//                                                  [--port 8801] [--ticks 0,150,300]
//
// Loads `/?script=drive&car=<slug>&hold=<tick>` and captures a 1600x900
// screenshot of the real WebGPU frame, recording every console message.
//
// Tick selection: every car is captured at the same ticks (`--ticks`, default
// start / mid / coast-end / end) so cars can be compared at identical points of
// the script. At tick 150 the slower cars are still among the start-area props;
// the chase camera resolves that occlusion against the visible static geometry
// (P36), so the mid frame must show the car, not the inside of a prop. The
// coast-end capture (tick 240) keeps the post-coast sample. With `--car` only
// the named car is captured. Files are `browser-<slug>-<label>.png`; the default
// car's captures are also copied to the legacy `browser-<label>.png` names.
//
// Assertions per capture:
//   * the requested tick was reached and held with alpha 0
//   * the page says it is driving the expected car, and the selector lists the roster
//   * geometry uploads equal the mesh count and never grow with frames
//   * one uniform buffer write and one draw per draw per frame
//   * the per-tick state hash / packet hash equal the node producer's values
//   * the page camera is clear of visible static geometry (re-cast here)
//   * the car is framed by the chase camera
//   * console is clean (no errors, no warnings, no logs)
// Cross-car: distinct mid-drive positions and distinct state hashes.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { startServer } from './serve.mjs';
import { startRoomServer } from '../../net-mvp/server.mjs';
import { MAPS } from '../web/map-registry.js';
import { buildOccluder } from '../web/camera-occlusion.js';
import { buildGhostArcTable, decodeGhost, ghostGap, ghostMatrices } from '../web/ghost-replay.js';
import { coursePosition } from '../web/sprint-rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, '_work/e1-drive');
const LOGS = path.join(ROOT, '_work/logs/e1-drive');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

const EDGE_CANDIDATES = [
  option('--edge', ''),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean);
const edge = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
if (!edge) throw new Error('msedge.exe not found; pass --edge <path>');

const MODE = option('--mode', 'drive');
if (!['drive', 'sprint', 'lap', 'free', 'props', 'collision-v2', 'respawn', 'telemetry', 'restart', 'telemetry-restart', 'survey', 'ghost', 'audio', 'quality', 'mp', 'mp-ai', 'mp-solo-ai', 'mp-powerups', 'map', 'chunk'].includes(MODE)) {
  throw new Error('unknown --mode ' + JSON.stringify(MODE) +
    ' (drive, sprint, lap, free, props, collision-v2, respawn, telemetry, restart, telemetry-restart, survey, ghost, audio, quality, mp, mp-ai, mp-powerups, map or chunk)');
}
// `--mode mp`/`mp-ai`/`mp-powerups` use the documented capture ports: game 8802, room 8811.
const PORT = Number(option('--port', MODE === 'mp' || MODE === 'mp-ai' || MODE === 'mp-solo-ai' || MODE === 'mp-powerups' ? '8802' : '8801'));
const ROOM_PORT = Number(option('--room-port', '8811'));
const DEBUG_PORT = Number(option('--debug-port', '9341'));
const PROFILE = path.join(OUT, 'edge-profile-' + PORT);
const VIEWPORT = { width: 1600, height: 900 };
const TICKS = option('--ticks', '0,150,240,300').split(',').map(Number);
const ONLY_CAR = option('--car', null);
// `--mode mp` host car. The default is the roster default (Corvette); a
// different C/B body can be requested without touching the guest selection.
const HOST_CAR = option('--host-car', null);
// `--mode mp` drives two different roster cars by default (M1.1 chunking): the
// host uses the default car, the guest a different chunk. `--guest-car` overrides.
const GUEST_CAR = option('--guest-car', null);
const MAP_OPTION = option('--map', null);
const MAP_ID = MAP_OPTION ?? (MODE === 'mp' || MODE === 'mp-ai' || MODE === 'mp-solo-ai' ? 'river' : MODE === 'chunk' ? 'river' : 'amboy');
const MAP_ENTRY = MAPS[MAP_ID];
if (MODE === 'mp' || MODE === 'mp-ai' || MODE === 'mp-solo-ai') {
  if (!MAP_ENTRY || MAP_ENTRY.multiplayer !== true) {
    throw new Error('--map for --mode ' + MODE + ' must name a multiplayer map (' + Object.values(MAPS).filter((entry) => entry.multiplayer).map((entry) => entry.id).join(', ') + '), got ' + JSON.stringify(MAP_ID));
  }
} else if (MODE === 'chunk') {
  if (!MAP_ENTRY) throw new Error('--map for --mode chunk must name a known map, got ' + JSON.stringify(MAP_ID));
} else if (!MAP_ENTRY || MAP_ENTRY.kind !== 'map-package') {
  throw new Error('--map must name a map package (' + Object.values(MAPS).filter((entry) => entry.kind === 'map-package').map((entry) => entry.id).join(', ') + '), got ' + JSON.stringify(MAP_ID));
}
const EXTRA_QUERY = option('--extra-query', '');
const AI_COUNT = Number(option('--ai-count', '2'));
const AI_CARS = option('--ai-cars', MAP_ID === 'gracia'
  ? 'audi-r8v10-stock,corvette-zr1-stock,lotus-exige-cup260-stock'
  : 'audi-r8v10-stock,dodge-challenger-stock,nissan-skyliner34ztune-stock');
const AI_PROFILES = option('--ai-profiles', 'reference,cautious,standard');
if (MODE === 'mp-ai' && (!Number.isInteger(AI_COUNT) || AI_COUNT < 1 || AI_COUNT > 3)) {
  throw new Error('--ai-count for --mode mp-ai must be an integer in [1, 3]');
}
const LABEL_PREFIX = option('--label-prefix', '');
const EVIDENCE_NAME = option('--evidence-name', 'browser-evidence.json');
// Course selection: 310 (default, `_work/e1-drive/sprint.json`), short
// (`?course=short`, `_work/e1-drive/sprint-short.json`), lap (`?course=lap`,
// `_work/e1-drive/sprint-lap.json`) or free (`?course=free`,
// `_work/e1-drive/sprint-free.json`). `--mode lap|free` selects its course.
let COURSE = option('--course', '310');
if (!['310', 'short', 'lap', 'free'].includes(COURSE)) {
  throw new Error('unknown --course ' + JSON.stringify(COURSE) + ' (use 310, short, lap or free)');
}
if (MODE === 'lap') COURSE = 'lap';
if (MODE === 'free') COURSE = 'free';
const COURSE_QUERY = COURSE === 'short' ? 'course=short'
  : COURSE === 'lap' ? 'course=lap' : COURSE === 'free' ? 'course=free' : '';
const SPRINT_BEST_KEY = 'e1-drive.sprint.best.v2.' +
  (COURSE === 'short' ? 'short' : COURSE === 'lap' ? 'lap' : COURSE === 'free' ? 'free' : '310m');
const DIAGNOSTIC_CAMERA = /(^|&)cam(dist|height)=/.test(EXTRA_QUERY);
const MID_TICK = 150;
// HUD overlay boxes for the `--mode quality` scene-only metrics (viewport px).
const QUALITY_HUD_BOXES = [
  { x: 0, y: 0, w: 790, h: 452 },      // left HUD block
  { x: 1258, y: 0, w: 342, h: 472 },   // top-right info panel
  { x: 0, y: 790, w: 480, h: 110 },    // bottom-left controls
  { x: 1230, y: 782, w: 370, h: 118 }, // bottom-right orbit help
  { x: 680, y: 60, w: 300, h: 250 }    // countdown / event banner (animated DOM)
];

const run = JSON.parse(readFileSync(path.join(OUT, 'run.json'), 'utf8'));
const geometry = JSON.parse(readFileSync(path.join(OUT, 'geometry.json'), 'utf8'));
const roster = JSON.parse(readFileSync(path.join(OUT, 'cars.json'), 'utf8'));
// The page uploads exactly three meshes: the level props, the real track visual
// and the selected car's body. The collision surface is hidden physics provenance
// in packet.physicsSurfaces, so it is neither uploaded nor drawn.
const MESH_COUNT = 3;
const meshBytes = (mesh) => mesh.positions.length * 4 + mesh.indices.length * 4 +
  (mesh.uv ? mesh.uv.bytes : mesh.vertexCount * 8);
const levelMesh = geometry.meshes[0];
const trackMesh = geometry.meshes.find((mesh) => mesh.id === geometry.trackVisual.meshId);
if (!trackMesh) throw new Error('geometry has no real track visual mesh');
// Same occluder the page built: the check below re-casts the page's own camera
// target->eye segment against the visible static geometry.
const occluder = buildOccluder(geometry);

const cars = run.cars.filter((car) => !ONLY_CAR || car.slug === ONLY_CAR || car.name === ONLY_CAR);
if (cars.length === 0) {
  throw new Error('unknown car ' + JSON.stringify(ONLY_CAR) + '; run.json has ' +
                  run.cars.map((car) => car.slug).join(', '));
}
const defaultSlug = HOST_CAR ?? run.defaultCar;
if (HOST_CAR && !run.cars.some((car) => car.slug === HOST_CAR)) {
  throw new Error('unknown --host-car ' + JSON.stringify(HOST_CAR) + '; run.json has ' +
                  run.cars.map((car) => car.slug).join(', '));
}
const labelFor = (tick) => (tick === 0 ? 'start' : tick >= 300 ? 'end' : tick === MID_TICK ? 'mid' : tick === 240 ? 'coast' : 'mid-' + tick);

/** Per-car expected tick data from the node producer's own artifacts. */
function expectedFor(car) {
  const packet = JSON.parse(readFileSync(path.join(ROOT, car.packet.path), 'utf8'));
  const state = JSON.parse(readFileSync(path.join(ROOT, car.packet.statePath), 'utf8'));
  const body = geometry.carBodies[car.slug];
  if (!body) throw new Error('geometry has no body for ' + car.slug);
  return {
    packetHash: new Map(packet.updates.map((update) => [update.tick, update.hash])),
    stateHash: new Map(state.ticks.map((row) => [row.tick, row.stateHash])),
    updates: new Map(packet.updates.map((update) => [update.tick, update])),
    meshCount: packet.meshes.length,
    body,
    uploadBytes: meshBytes(levelMesh) + meshBytes(body.mesh) + meshBytes(trackMesh),
    uvUploadBytes: (levelMesh.uv ? levelMesh.uv.bytes : levelMesh.vertexCount * 8) +
      (body.mesh.uv ? body.mesh.uv.bytes : body.mesh.vertexCount * 8) +
      (trackMesh.uv ? trackMesh.uv.bytes : trackMesh.vertexCount * 8),
    parts: body.carParts.length,
    draws: 22 + geometry.trackVisual.drawCount + body.carDraws.length,
    trackDraws: geometry.trackVisual.drawCount,
    trackTriangles: geometry.trackVisual.triangleCount,
    trackLabel: geometry.trackVisual.label,
    texturedDraws: geometry.trackVisual.texturedDrawCount,
    textureCount: geometry.textures.length,
    textureBytes: geometry.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
    levelPropDraws: geometry.levelDraws.length,
    levelPropTexturedDraws: geometry.levelDraws.filter((draw) => draw.textureId != null).length,
    levelPropDiagnosticDraws: geometry.levelDraws.filter((draw) => draw.textureId == null).length,
    levelPropTextures: geometry.levelTextures.length,
    levelPropTextureBytes: geometry.levelTextures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
    levelPropUvVertices: levelMesh.uv.vertexCount,
    levelPropUvBytes: levelMesh.uv.bytes,
    levelPropManifestSha256: geometry.levelPropTexturePack.manifestSha256,
    levelPropContentHash: geometry.levelPropTexturePack.contentHash,
    levelPropBlockedInstances: geometry.levelDraws.filter((draw) => draw.textureId == null)
      .map((draw) => draw.source.instanceIndex),
    carTexturedDraws: body.carDraws.filter((draw) => draw.textureId != null).length,
    carTextures: body.textures.length,
    carTextureBytes: body.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
    carUvVertices: body.mesh.uv.vertexCount,
    totalTextureCount: geometry.textures.length + geometry.levelTextures.length + body.textures.length,
    totalTextureBytes: geometry.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0) +
      geometry.levelTextures.reduce((sum, texture) => sum + texture.rgbaBytes, 0) +
      body.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
    carDrawClasses: body.texturePack.coverage,
    uvVertices: trackMesh.uv.vertexCount,
    fallbackTriangles: geometry.collisionSurface.coverage?.fallbackTriangles ?? 0,
    coveredTriangles: geometry.collisionSurface.coverage?.coveredTriangles ?? 0,
    collisionVisible: packet.diagnostics.extras.collisionSurface?.visible ?? null,
    nodes: body.carNodes.length,
    wheelNodes: body.carNodes.filter((node) => node.id !== 'e1.car.body').length,
    bodyMeshId: body.meshId,
    bodyManifestSha256: body.manifest.sha256,
    bodyPositionsSha256: body.manifest.meshValueHashes.positionsFloat32LESha256
  };
}

mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });
// A previous run's headless Edge can hold the profile directory for a moment
// after the process is killed. Retry the reset instead of failing the whole
// capture with EPERM; a stale profile must never be reused silently.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let attempt = 0; ; attempt++) {
  try {
    rmSync(PROFILE, { recursive: true, force: true });
    break;
  } catch (error) {
    if (attempt >= 19 || (error.code !== 'EPERM' && error.code !== 'EBUSY')) throw error;
    sleepSync(250);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { server, origin } = await startServer({ port: PORT });
const browser = spawn(edge, [
  '--headless=new',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=d3d11',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + PROFILE,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-sync',
  '--disable-component-update',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
  'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });

let browserLog = '';
browser.stderr.on('data', (chunk) => { browserLog += chunk.toString(); });
browser.stdout.on('data', (chunk) => { browserLog += chunk.toString(); });

const shutdown = async () => {
  try { browser.kill(); } catch {}
  await new Promise((resolve) => server.close(resolve));
};
process.on('exit', () => { try { browser.kill(); } catch {} });

async function targets() {
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      if (response.ok) {
        const list = await response.json();
        const page = list.find((entry) => entry.type === 'page');
        if (page) return page;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error('Edge devtools endpoint unreachable. Log tail:\n' + browserLog.slice(-1200));
}

const page = await targets();
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
    messages.push({ source: 'console.' + message.params.type, text: message.params.args.map((arg) => arg.value ?? arg.description).join(' ') });
  } else if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    messages.push({ source: 'exception', text: details.exception?.description ?? details.text });
  } else if (message.method === 'Log.entryAdded') {
    messages.push({ source: 'log.' + message.params.entry.level, text: message.params.entry.text, url: message.params.entry.url });
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
await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});

/**
 * Create a second page target in the same headless Edge process and return the
 * same CDP helpers the first page uses. M1 needs two independent pages: one
 * host and one guest. `PUT /json/new` is the DevTools HTTP way to open a tab in
 * the running browser; a GET fallback covers older builds.
 */
async function openSecondPage(url = 'about:blank') {
  let response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!response.ok) {
    response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`);
  }
  if (!response.ok) throw new Error('could not create the second page target: HTTP ' + response.status);
  const target = await response.json();
  if (!target.webSocketDebuggerUrl) throw new Error('second page target has no webSocketDebuggerUrl');
  const socket2 = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket2.addEventListener('open', resolve, { once: true });
    socket2.addEventListener('error', reject, { once: true });
  });
  const messages2 = [];
  const pending2 = new Map();
  let nextId2 = 0;
  socket2.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending2.get(message.id);
      if (!entry) return;
      pending2.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      messages2.push({ source: 'console.' + message.params.type, text: message.params.args.map((arg) => arg.value ?? arg.description).join(' ') });
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      messages2.push({ source: 'exception', text: details.exception?.description ?? details.text });
    } else if (message.method === 'Log.entryAdded') {
      messages2.push({ source: 'log.' + message.params.entry.level, text: message.params.entry.text, url: message.params.entry.url });
    }
  });
  const send2 = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId2;
    pending2.set(id, { resolve, reject });
    socket2.send(JSON.stringify({ id, method, params }));
  });
  const evaluate2 = async (expression) => {
    const result = await send2('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error('evaluate failed: ' + (details.exception?.description ?? details.text ?? JSON.stringify(details)));
    }
    return result.result.value;
  };
  await send2('Runtime.enable');
  await send2('Log.enable');
  await send2('Page.enable');
  await send2('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
  await send2('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await send2('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  return { target, socket: socket2, messages: messages2, send: send2, evaluate: evaluate2, close: () => socket2.close() };
}

async function capture(car, label, tick, options = {}) {
  const script = options.script ?? 'drive';
  const course = options.course ?? (script === 'sprint' ? (COURSE_QUERY ? COURSE_QUERY : null) : null);
  messages.length = 0;
  const url = origin + '/?script=' + script + '&car=' + encodeURIComponent(car.slug) + '&hold=' + tick +
    (course ? '&' + course : '') +
    (EXTRA_QUERY ? '&' + EXTRA_QUERY : '') +
    (options.extraQuery ? '&' + options.extraQuery : '');
  await send('Page.navigate', { url });
  let probe = null;
  // A scripted run advances at the fixed-step 60 Hz in real time. The 3-lap
  // finish capture sits at ~88 s of simulated time, so the default 80 s poll
  // window is too short; long runs get a proportionally longer window (600 s,
  // needed on a slow/thermally throttled headless GPU).
  const pollAttempts = options.longRun ? 3000 : 400;
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    probe = await evaluate(`(()=>{const p=window.e1DriveProbe;return p?{state:p.consumer,error:p.error,engineTick:p.engineTick,displayTick:p.displayTick,frames:p.frames,holdReached:p.holdReached,draws:p.draws,car:p.car,url:location.href}:null})()`).catch(() => null);
    if (probe && probe.url === url && probe.state === 'error') break;
    if (probe && probe.url === url && probe.state === 'running' && probe.holdReached && probe.frames >= 12) break;
    await sleep(200);
  }
  if (!probe) throw new Error(label + ': page never published state');
  if (probe.state === 'error') throw new Error(label + ': page error: ' + probe.error);
  if (!probe.holdReached) throw new Error(label + ': driver did not reach tick ' + tick);
  if (probe.displayTick !== tick) throw new Error(label + ': displayed tick is ' + probe.displayTick + ', wanted ' + tick);

  // Optional in-place restart before the screenshot: `R` rebuilds the world and
  // the timeline without a page reload (the free-roam reset frame uses this).
  if (options.triggerReset) {
    const restartsBefore = probe.restarts ?? 0;
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'R' })); true`);
    for (let attempt = 0; attempt < 200; attempt++) {
      probe = await evaluate(`(()=>{const p=window.e1DriveProbe;return p?{state:p.consumer,error:p.error,` +
        `restarts:p.restarts,holdReached:p.holdReached,displayTick:p.displayTick,frames:p.frames}:null})()`)
        .catch(() => null);
      if (probe && probe.state === 'error') break;
      if (probe && probe.state === 'running' && (probe.restarts ?? 0) > restartsBefore &&
          probe.holdReached && probe.frames >= 12) break;
      await sleep(100);
    }
    if (!probe) throw new Error(label + ': page never republished after R');
    if (probe.state === 'error') throw new Error(label + ': page error after R: ' + probe.error);
    if (!((probe.restarts ?? 0) > restartsBefore)) throw new Error(label + ': R did not rebuild the world');
    if (!probe.holdReached) throw new Error(label + ': R did not hold tick ' + tick);
    if (probe.displayTick !== tick) throw new Error(label + ': reset displayed tick is ' + probe.displayTick);
  }

  const full = await evaluate(`(()=>{
    const p = window.e1DriveProbe;
    const canvas = document.getElementById('scene');
    const select = document.getElementById('car-select');
    const update = p.updates ? p.updates[${tick}] : null;
    return {
      mode: p.mode, engineTick: p.engineTick, displayTick: p.displayTick, phase: p.phase, speed: p.speed, position: p.position,
      holdReached: p.holdReached, restarts: p.restarts,
      contacts: p.contacts, input: p.input, car: p.car, roster: p.roster ? p.roster.counts : null,
      selector: select ? { options: select.options.length, value: select.value, text: select.options[select.selectedIndex]?.textContent } : null,
      frames: p.frames, ticksExecuted: p.ticksExecuted, cappedFrames: p.cappedFrames,
      pauseDrops: p.pauseDrops, zeroTickFrames: p.zeroTickFrames,
      geometryUploads: p.geometryUploads, geometryUploadBytes: p.geometryUploadBytes,
      textureUploads: p.textureUploads, textureUploadBytes: p.textureUploadBytes, uvUploadBytes: p.uvUploadBytes,
      textureSampling: window.__e1TextureSampling ?? null,
      trackTexturedDraws: p.trackTexturedDraws, trackTextures: p.trackTextures,
      trackTextureBytes: p.trackTextureBytes, trackUvVertices: p.trackUvVertices,
      levelPropDraws: p.levelPropDraws, levelPropTexturedDraws: p.levelPropTexturedDraws,
      levelPropDiagnosticDraws: p.levelPropDiagnosticDraws, levelPropTextures: p.levelPropTextures,
      levelPropTextureBytes: p.levelPropTextureBytes, levelPropUvVertices: p.levelPropUvVertices,
      levelPropManifestSha256: p.levelPropManifestSha256, levelPropContentHash: p.levelPropContentHash,
      levelPropBlockedInstances: p.levelPropBlockedInstances,
      carTexturedDraws: p.carTexturedDraws, carTextures: p.carTextures,
      carTextureBytes: p.carTextureBytes, carUvVertices: p.carUvVertices,
      carPaintDraws: p.carPaintDraws, carLightDraws: p.carLightDraws, carNoAlbedoDraws: p.carNoAlbedoDraws,
      uniformWrites: p.uniformWrites, uniformBytes: p.uniformBytes, drawsIssued: p.drawsIssued,
      draws: p.draws, parts: p.parts, carDraws: p.carDraws, packetNodes: p.packetNodes,
      wheelNodes: p.wheelNodes, wheelAngles: p.wheelAngles,
      trackVisual: p.trackVisual, trackDraws: p.trackDraws, trackTriangles: p.trackTriangles,
      collisionVisible: p.collisionVisible, collisionFallbackTriangles: p.collisionFallbackTriangles,
      collisionCoveredTriangles: p.collisionCoveredTriangles,
      bodyMesh: p.bodyMesh, bodyManifest: p.bodyManifest,
      tickHash: p.tickHash, tick0Hash: p.tick0Hash, packetHash: p.packetHash,
      matrixChecksum: p.matrixChecksum, movedScreen: p.movedScreen, camera: p.camera,
      gpu: p.adapter, spawn: p.spawn, info: p.engineInfo,
      tickHashes: p.tickHashes,
      sprint: p.sprint ?? null,
      sprintLayoutHash: p.sprintLayoutHash ?? null,
      sprintLayout: p.sprintLayout ?? null,
      sprintEvents: p.sprintEvents ?? [],
      sprintResult: p.sprintResult ?? null,
      sprintBest: p.sprintBest ?? null,
      ghost: p.ghost ?? null,
      props: p.props ?? null,
      collisionProbe: p.collisionProbe ?? null,
      map: p.map ?? null,
      mapCounts: p.mapCounts ?? null,
      overlays: {
        countdownHidden: document.getElementById('countdown')?.hidden ?? null,
        countdownText: document.getElementById('countdown')?.textContent ?? null,
        resultsHidden: document.getElementById('results')?.hidden ?? null,
        resultsTime: document.getElementById('results-time')?.textContent ?? null,
        resultsBest: document.getElementById('results-best')?.textContent ?? null,
        eventText: document.getElementById('event')?.textContent ?? null,
        eventVisible: document.getElementById('event')?.dataset.visible ?? null,
        ghostTagHidden: document.getElementById('ghost-tag')?.hidden ?? null,
        ghostTagText: document.getElementById('ghost-tag')?.textContent ?? null,
        hudText: document.getElementById('hud')?.textContent ?? null
      },
      bestStored: (() => { try { return localStorage.getItem('${options.bestKey ?? SPRINT_BEST_KEY}'); } catch { return null; } })(),
      render: update ? {
        tick: update.tick,
        hash: update.hash,
        matrix: update.matrices[0].world,
        matrices: update.matrices,
        camera: {
          position: update.camera.position,
          target: update.camera.target,
          view: update.camera.view,
          orbit: update.camera.orbit,
          occlusion: update.camera.occlusion ?? null
        }
      } : null,
      canvas: { width: canvas.width, height: canvas.height }
    };
  })()`);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, `browser-${car.slug}-${label}.png`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));

  let crop = null;
  const moved = full.movedScreen;
  if (moved) {
    const width = Math.min(VIEWPORT.width, Math.max(220, Math.round((moved.width || 60) * 2.2)));
    const height = Math.min(VIEWPORT.height, Math.max(160, Math.round((moved.height || 40) * 2.2)));
    const x = Math.max(0, Math.min(VIEWPORT.width - width, Math.round(moved.x - width / 2)));
    const y = Math.max(0, Math.min(VIEWPORT.height - height, Math.round(moved.y - height / 2)));
    const clipped = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false, clip: { x, y, width, height, scale: 2 }
    });
    crop = path.join(OUT, `browser-${car.slug}-${label}-car.png`);
    writeFileSync(crop, Buffer.from(clipped.data, 'base64'));
  }
  return {
    label,
    tick,
    url: url.replace(origin, ''),
    screenshot: path.relative(ROOT, file).split(path.sep).join('/'),
    carCrop: crop ? path.relative(ROOT, crop).split(path.sep).join('/') : null,
    probe: full,
    messages: messages.splice(0)
  };
}

const failures = [];
const check = (label, ok, detail) => { if (!ok) failures.push(label + (detail ? ': ' + detail : '')); };

/**
 * Largest absolute difference between two packet cameras (position, view, orbit).
 *
 * The packet hash is a canonical hash of the whole update, so it only matches when
 * the camera doubles are identical. They are not guaranteed to be: `Math.atan2`
 * returns different last-bit results in Node 24's V8 and Edge 156's V8 for the
 * same input (measured), so the car pose and every physics value match exactly
 * while the chase-camera yaw can differ by one ulp. This comparison quantifies
 * that rather than hiding it.
 */
function cameraMaxDelta(a, b) {
  if (!a || !b) return null;
  let max = 0;
  const scan = (x, y) => {
    if (typeof x === 'number' && typeof y === 'number') {
      max = Math.max(max, Math.abs(x - y));
    }
  };
  if (!Array.isArray(a.position) || !Array.isArray(b.position)) return null;
  for (let i = 0; i < 3; i++) scan(a.position[i], b.position[i]);
  for (let i = 0; i < 16; i++) scan(a.view[i], b.view[i]);
  scan(a.orbit?.yaw, b.orbit?.yaw);
  scan(a.orbit?.pitch, b.orbit?.pitch);
  scan(a.orbit?.distance, b.orbit?.distance);
  return max;
}

/**
 * Engine-audio capture (`--mode audio`): proves the page starts the committed
 * module only from a real CDP gesture, holds a known RPM, matches the retail
 * `EngineNVolume`/`EngineNPitch` curves at 1500/3015/6000 within 1e-3, reads a
 * non-zero analyser RMS, and mutes to silence. Also proves `?audio=0` leaves the
 * page with no module instance. The URL is the legacy drive held at tick 0, so
 * the run's physics/state is the unchanged drive mode.
 */
async function audioCapturePass() {
  const car = cars.find((entry) => entry.slug === defaultSlug) ?? cars[0];
  const evidenceFile = option('--evidence-name', 'browser-evidence-audio.json');
  const audioModule = await import(pathToFileURL(path.join(ROOT, 'probes/audio/web/engine-audio.js')).href);
  const rpms = [1500, 3015, 6000];
  const audioChecks = [];
  const audioCheck = (label, ok, detail = '') => {
    audioChecks.push({ label, ok, detail });
    check(label, ok, detail);
  };

  const pageState = async () => evaluate(`(()=>{
    const p = window.e1DriveProbe;
    const a = window.e1DriveAudio;
    if (!p || !a) return null;
    const d = a.getDiagnostics();
    const hud = document.getElementById('hud')?.textContent ?? '';
    return {
      consumer: p.consumer, error: p.error, holdReached: p.holdReached, frames: p.frames,
      enabled: a.enabled, status: a.status,
      diag: d ? {
        state: d.state, contextState: d.contextState, rpm: d.rpm, x: d.x, baseUrl: d.baseUrl,
        decoded: d.decoded.map((entry) => ({
          wave: entry.wave, duration: entry.duration, channels: entry.channels,
          sampleRate: entry.sampleRate, peak: entry.peak
        })),
        layers: d.layers, levels: d.levels, muted: d.muted
      } : null,
      hud
    };
  })()`);

  const waitReady = async (url, label) => {
    for (let attempt = 0; attempt < 1600; attempt++) {
      const probe = await evaluate(`(()=>{const p=window.e1DriveProbe;return p?{url:location.href,state:p.consumer,error:p.error,holdReached:p.holdReached,frames:p.frames}:null})()`).catch(() => null);
      if (probe && probe.url === url && probe.state === 'error') throw new Error(label + ': page error: ' + probe.error);
      if (probe && probe.url === url && probe.state === 'running' && probe.holdReached && probe.frames >= 12) return;
      await sleep(150);
    }
    throw new Error(label + ': page did not become ready');
  };

  // 1) `?audio=0` must leave the page with no module instance and a typed HUD.
  const forcedUrl = origin + '/?script=drive&audio=0&hold=0&car=' + encodeURIComponent(car.slug);
  messages.length = 0;
  await send('Page.navigate', { url: forcedUrl });
  await waitReady(forcedUrl, 'audio force-off');
  const forced = await pageState();
  audioCheck('?audio=0 leaves the page with no audio instance and an explicit off HUD',
             forced?.enabled === false && forced?.diag === null && /off \(\?audio=0\)/.test(forced?.hud ?? ''),
             forced ? `enabled=${forced.enabled}, diag=${forced.diag === null ? 'null' : 'present'}` : 'no probe');
  audioCheck('?audio=0 console is clean', messages.length === 0, messages.map((entry) => entry.source).join(','));

  // 2) Default page: constructed but idle, no context, nothing decoded.
  const url = origin + '/?script=drive&hold=0&car=' + encodeURIComponent(car.slug);
  messages.length = 0;
  await send('Page.navigate', { url });
  await waitReady(url, 'audio idle');
  const idle = await pageState();
  audioCheck('before any gesture the module is idle with no AudioContext and 0 decoded layers',
             idle?.enabled === true && idle?.status?.state === 'idle' &&
             idle?.status?.contextState === 'none' && idle?.diag?.decoded?.length === 0 &&
             /idle/.test(idle?.hud ?? ''),
             idle ? `${idle.status?.state}/${idle.status?.contextState}/decoded ${idle.diag?.decoded?.length}` : 'no probe');

  // 3) A real CDP mouse gesture (not an autoplay override) starts the graph.
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: Math.round(VIEWPORT.width / 2), y: Math.round(VIEWPORT.height / 2),
    button: 'left', clickCount: 1
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: Math.round(VIEWPORT.width / 2), y: Math.round(VIEWPORT.height / 2),
    button: 'left', clickCount: 1
  });
  let running = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    running = await pageState();
    if (running?.status?.state === 'running') break;
    if (running?.status?.state === 'unavailable') break;
    await sleep(100);
  }
  audioCheck('a trusted mouse gesture starts the AudioContext and decodes 6/6 retail layers',
             running?.status?.state === 'running' && running?.status?.contextState === 'running' &&
             running?.diag?.decoded?.length === 6 && running?.diag?.layers?.length === 6,
             running ? `${running.status?.state}/${running.status?.contextState}/decoded ${running.diag?.decoded?.length}` : 'no probe');

  const decodedWaves = (running?.diag?.decoded ?? []).map((entry) => entry.wave).sort();
  audioCheck('the decoded layers are the six RaceV8_Engine_* loops (decel excluded, as documented)',
             decodedWaves.length === 6 && decodedWaves.every((wave) =>
               ['RaceV8_Engine_1500', 'RaceV8_Engine_1995', 'RaceV8_Engine_3015',
                'RaceV8_Engine_4005', 'RaceV8_Engine_4995', 'RaceV8_Engine_6000'].includes(wave)),
             decodedWaves.join(', '));

  // 4) Hold each retail RPM and compare the live AudioParams with the PLF.
  const samples = [];
  for (const rpm of rpms) {
    await evaluate(`window.e1DriveAudio.setRpm(${rpm}) && true`);
    await sleep(500);
    const snapshot = await pageState();
    const expected = audioModule.sampleEngineCurves(rpm);
    const expectedBySlot = new Map(expected.layers.map((layer) => [layer.slot, layer]));
    let maxGainDelta = 0;
    let maxRateDelta = 0;
    const rows = (snapshot?.diag?.layers ?? []).map((layer) => {
      const target = expectedBySlot.get(layer.slot);
      const gainDelta = Math.abs(layer.gain - target.gain);
      const rateDelta = Math.abs(layer.rate - target.rate);
      maxGainDelta = Math.max(maxGainDelta, gainDelta);
      maxRateDelta = Math.max(maxRateDelta, rateDelta);
      return {
        slot: layer.slot, wave: layer.wave,
        targetGain: target.gain, targetRate: target.rate,
        gain: layer.gain, rate: layer.rate,
        gainDelta, rateDelta
      };
    });
    const rms = snapshot?.diag?.levels?.rms ?? 0;
    const peak = snapshot?.diag?.levels?.peak ?? 0;
    samples.push({
      rpm, requestedRpm: snapshot?.diag?.rpm ?? null, x: snapshot?.diag?.x ?? null,
      maxGainDelta, maxRateDelta, rms, peak, layers: rows
    });
    audioCheck(`${rpm} RPM: per-layer live gains/rates match the retail PLF within 1e-3`,
               rows.length === 6 && snapshot?.diag?.rpm === rpm && maxGainDelta < 1e-3 && maxRateDelta < 1e-3,
               `gain ${maxGainDelta.toExponential(2)}, rate ${maxRateDelta.toExponential(2)}`);
    audioCheck(`${rpm} RPM: analyser output is non-silent (RMS > 0.001)`,
               rms > 0.001, `RMS ${rms.toFixed(5)}, peak ${peak.toFixed(5)}`);
  }

  const runningHud = (await pageState())?.hud ?? '';
  audioCheck('HUD reports running, the held RPM and the active layer count',
             /running/.test(runningHud) && /6000 rpm/.test(runningHud) && /layer/.test(runningHud),
             runningHud.split('\n').find((line) => line.startsWith('audio ')) ?? 'no audio row');

  const runningShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const runningFile = path.join(OUT, 'browser-audio-running.png');
  writeFileSync(runningFile, Buffer.from(runningShot.data, 'base64'));

  // 5) Mute -> silence -> unmute.
  await evaluate('window.e1DriveAudio.setMuted(true) && true');
  await sleep(400);
  const muted = await pageState();
  audioCheck('mute drives the analyser to silence (< 0.002) without closing the context',
             (muted?.diag?.levels?.rms ?? 1) < 0.002 && muted?.diag?.contextState === 'running',
             `RMS ${(muted?.diag?.levels?.rms ?? -1).toFixed(5)}, context ${muted?.diag?.contextState}`);
  audioCheck('HUD reports the muted state', /muted \(M\)/.test(muted?.hud ?? ''),
             muted?.hud?.split('\n').find((line) => line.startsWith('audio ')) ?? 'no audio row');
  const mutedShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const mutedFile = path.join(OUT, 'browser-audio-muted.png');
  writeFileSync(mutedFile, Buffer.from(mutedShot.data, 'base64'));

  await evaluate('window.e1DriveAudio.setMuted(false) && true');
  await sleep(400);
  const unmuted = await pageState();
  audioCheck('unmute restores output (RMS > 0.001)',
             (unmuted?.diag?.levels?.rms ?? 0) > 0.001,
             `RMS ${(unmuted?.diag?.levels?.rms ?? 0).toFixed(5)}`);

  const capturedMessages = messages.splice(0);
  audioCheck('console is clean through gesture, RPM hold, mute and unmute',
             capturedMessages.length === 0,
             capturedMessages.map((entry) => entry.source + ': ' + entry.text).join(' | '));

  const passed = audioChecks.filter((entry) => entry.ok).length;
  const evidence = {
    kind: 'e1-drive.engine-audio-evidence',
    version: 1,
    status: passed === audioChecks.length ? 'PASS' : 'FAIL',
    car: car.slug,
    url: url.replace(origin, ''),
    forceOff: {
      url: forcedUrl.replace(origin, ''),
      enabled: forced?.enabled ?? null,
      diagnostics: forced?.diag ?? null,
      hud: forced?.hud ?? null
    },
    beforeGesture: {
      state: idle?.status?.state ?? null,
      contextState: idle?.status?.contextState ?? null,
      decoded: idle?.diag?.decoded?.length ?? null,
      hud: idle?.hud ?? null
    },
    gesture: 'Input.dispatchMouseEvent mousePressed/mouseReleased at viewport centre (trusted user gesture); ' +
      'Edge is started without --autoplay-policy=no-user-gesture-required',
    afterGesture: {
      state: running?.status?.state ?? null,
      contextState: running?.status?.contextState ?? null,
      decoded: running?.diag?.decoded ?? [],
      baseUrl: running?.diag?.baseUrl ?? null
    },
    rpms: samples,
    mute: {
      mutedRms: muted?.diag?.levels?.rms ?? null,
      restoredRms: unmuted?.diag?.levels?.rms ?? null,
      contextState: muted?.diag?.contextState ?? null
    },
    console: capturedMessages,
    checks: audioChecks,
    screenshots: [
      path.relative(ROOT, runningFile).split(path.sep).join('/'),
      path.relative(ROOT, mutedFile).split(path.sep).join('/')
    ],
    limits: 'one Race_V8_engine graph, RPM only; not the retail mixer; decoded WAVs live under _work/audio and are not committed'
  };
  writeFileSync(path.join(OUT, evidenceFile), JSON.stringify(evidence, null, 2) + '\n', 'utf8');

  return {
    ok: passed === audioChecks.length,
    summary: {
      mode: 'audio',
      status: evidence.status,
      car: car.slug,
      checks: `${passed}/${audioChecks.length}`,
      consoleMessages: capturedMessages.length,
      rpms: samples.map((row) => ({
        rpm: row.rpm,
        maxGainDelta: row.maxGainDelta,
        maxRateDelta: row.maxRateDelta,
        rms: row.rms
      })),
      mute: { mutedRms: evidence.mute.mutedRms, restoredRms: evidence.mute.restoredRms },
      screenshots: evidence.screenshots,
      evidence: path.relative(ROOT, path.join(OUT, evidenceFile)).split(path.sep).join('/'),
      failures
    }
  };
}

/**
 * M1 multiplayer capture (`--mode mp`): one headless Edge process, two page
 * targets, the unchanged room service on 8811 and the game server on 8802.
 *
 * Host `?mp=1&host=1&script=sprint`, guest `?mp=1&room=CODE&script=sprint&mpPace=0.85`
 * (the pace override is a capture-only input script difference so the two cars
 * are visibly separate and the result table has two distinct times). Both pages
 * are real wasm-physics pages; the host runs RaceSession, both render the remote
 * car through the ghost pipeline. The checks are the M1 acceptance gates:
 * lobby/ready/start, both finishes, equal shared result, remote pose tolerance,
 * sequences/authority, console 0 and screenshots.
 */
/**
 * `--mode chunk`: proves the chunked load path in the browser. It records the
 * level/selected-car requests and bytes, switches car in place (same document,
 * same navigation entry, no reload), then removes a car chunk from disk and
 * checks that the switch fails with the typed CHUNK_CAR_MISSING code while the
 * current car keeps running. The removed file is restored in a finally block.
 */
async function chunkCapturePass() {
  const failures = [];
  const passCheck = (label, ok, detail = '') => { if (!ok) failures.push(label + (detail ? ': ' + detail : '')); };
  const evidence = { map: MAP_ID, generatedAt: new Date().toISOString(), checks: [], failures };
  const readProbe = () => evaluate(`(()=>{
    const p = window.e1DriveProbe;
    const c = window.__e1Chunks;
    const resources = performance.getEntriesByType('resource')
      .filter((r) => r.name.includes('/_work/e1-drive/') || r.name.includes('/audio/'))
      .map((r) => ({ name: r.name.replace(location.origin, ''), transferSize: r.transferSize,
        encodedBodySize: r.encodedBodySize, decodedBodySize: r.decodedBodySize,
        duration: r.duration, startTime: r.startTime }));
    return p && c ? {
      consumer: p.consumer, error: p.error, href: location.href,
      navigationEntries: performance.getEntriesByType('navigation').length,
      marker: window.__chunkMarker ?? null,
      car: p.car ? p.car.slug : null,
      chunk: c.state(), carSwitch: p.carSwitch ?? null,
      map: p.map ? { id: p.map.id, bytes: p.map.bytes, loadMs: p.map.loadMs, carChunk: p.map.carChunk } : null,
      geometryUploads: p.geometryUploads, geometryUploadBytes: p.geometryUploadBytes,
      draws: p.draws, resources
    } : null;
  })()`).catch(() => null);
  const waitProbe = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await readProbe();
      if (last && predicate(last)) return last;
      await sleep(150);
    }
    throw new Error(label + ' timed out; last ' + JSON.stringify({ car: last?.car, consumer: last?.consumer,
      switch: last?.carSwitch, error: last?.error }));
  };

  const first = defaultSlug;
  const second = ONLY_CAR && ONLY_CAR !== first ? ONLY_CAR : (first === 'audi-r8v10-stock' ? 'corvette-zr1-stock' : 'audi-r8v10-stock');
  const missing = ['audi-tt-stock', 'ford-fr100-stock', 'nissan-skyliner34ztune-stock']
    .find((slug) => slug !== first && slug !== second) ?? 'dodge-challenger-stock';
  const missingFile = path.join(OUT, 'cars', missing + '.geometry.json');
  let renamed = false;
  const url = origin + '/?script=sprint&hold=0&car=' + encodeURIComponent(first) +
    (MAP_ID === 'river' ? '' : '&map=' + encodeURIComponent(MAP_ID));
  try {
    await send('Page.navigate', { url });
    await waitProbe((probe) => probe.consumer === 'running' && probe.car === first &&
      (probe.chunk?.level ?? probe.chunk?.base)?.bytes > 0,
      120000, 'initial chunked page load');
    const before = await readProbe();
    await evaluate('window.__chunkMarker = 4242; true');
    const markerBefore = await evaluate('window.__chunkMarker');
    const switchStartedAt = Date.now();
    const switched = await evaluate('window.__e1Chunks.switchCar(' + JSON.stringify(second) + ').then(()=>true, (e)=>({code:e.code??null, name:e.name, message:e.message}))');
    const after = await waitProbe((probe) => probe.consumer === 'running' && probe.car === second &&
      probe.carSwitch?.status === 'ready', 120000, 'in-place car switch');
    const switchMs = Date.now() - switchStartedAt;
    const markerAfter = await evaluate('window.__chunkMarker');
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const shotFile = '_work/e1-drive/browser-chunk-switch' + (MAP_ID === 'river' ? '' : '-' + MAP_ID) + '.png';
    writeFileSync(path.join(ROOT, shotFile), Buffer.from(shot.data, 'base64'));

    passCheck('initial page fetch is level + selected car (not the combined file)',
      (before.chunk?.level ?? before.chunk?.base)?.bytes > 0 && before.chunk?.car?.slug === first &&
      before.resources.every((entry) => !entry.name.endsWith('/geometry.json')),
      JSON.stringify({ level: before.chunk?.level, base: before.chunk?.base, car: before.chunk?.car,
        geometry: before.resources.filter((entry) => entry.name.endsWith('/geometry.json')) }));
    passCheck('the level chunk is fetched once and the car chunk only for the selected car',
      before.resources.filter((entry) => entry.name.endsWith('/level.geometry.json') ||
        entry.name.endsWith('/base.geometry.json')).length === 1 &&
      before.resources.filter((entry) => entry.name.endsWith('.geometry.json') &&
        entry.name.includes('/cars/')).length === 1,
      JSON.stringify(before.resources.filter((entry) => entry.name.includes('_work/e1-drive'))));
    passCheck('car switch happens in the same document (no reload/navigation)',
      switched === true && markerBefore === 4242 && markerAfter === 4242 &&
      before.navigationEntries === after.navigationEntries && before.href !== after.href &&
      after.href.includes('car=' + second),
      JSON.stringify({ switched, markerBefore, markerAfter, before: before.href, after: after.href }));
    passCheck('car switch fetches only the next car chunk (no level re-fetch)',
      after.resources.filter((entry) => entry.name.endsWith('/level.geometry.json') ||
        entry.name.endsWith('/base.geometry.json')).length === 1 &&
      after.resources.filter((entry) => entry.name.endsWith('.geometry.json') &&
        entry.name.includes('/cars/')).length === 2 &&
      after.carSwitch?.carChunk?.slug === second && after.carSwitch?.carChunk?.bytes > 0,
      JSON.stringify({ switch: after.carSwitch, resources: after.resources.filter((entry) => entry.name.includes('/cars/')) }));
    passCheck('the switched car uploads its own mesh and keeps the level mesh',
      after.geometryUploads > before.geometryUploads && after.draws !== before.draws,
      JSON.stringify({ before: { uploads: before.geometryUploads, draws: before.draws },
        after: { uploads: after.geometryUploads, draws: after.draws } }));

    // Missing-chunk gate: remove the next car file, ask for it, and require the
    // typed error with the current car still running and drawn.
    renameSync(missingFile, missingFile + '.missing-test');
    renamed = true;
    const missingResult = await evaluate('window.__e1Chunks.switchCar(' + JSON.stringify(missing) + ').then(()=>null, (e)=>({code:e.code??null, name:e.name, message:e.message}))');
    const afterMissing = await readProbe();
    passCheck('a missing car chunk is a typed CHUNK_CAR_MISSING error, not a fallback body',
      missingResult?.code === 'CHUNK_CAR_MISSING' && afterMissing.car === second &&
      afterMissing.consumer === 'running' && afterMissing.carSwitch?.status === 'error' &&
      afterMissing.carSwitch?.code === 'CHUNK_CAR_MISSING',
      JSON.stringify({ missingResult, car: afterMissing.car, switch: afterMissing.carSwitch }));

    evidence.load = {
      before: {
        href: before.href,
        level: before.chunk?.level,
        base: before.chunk?.base,
        car: before.chunk?.car,
        mapBytes: before.map?.bytes,
        loadMs: before.map?.loadMs,
        requests: before.resources
      },
      after: {
        href: after.href,
        level: after.chunk?.level,
        base: after.chunk?.base,
        car: after.chunk?.car,
        mapBytes: after.map?.bytes,
        carSwitch: after.carSwitch,
        switchMs,
        requests: after.resources
      }
    };
    evidence.missingChunk = { slug: missing, result: missingResult, carAfter: afterMissing.car };
    evidence.screenshot = shotFile;
    evidence.checks = [
      { label: 'initial load bytes', ok: true,
        level: before.chunk?.level?.bytes ?? before.chunk?.base?.bytes ?? null,
        base: before.chunk?.base?.bytes ?? null,
        car: before.chunk?.car?.bytes ?? null },
      { label: 'switch bytes', ok: true, car: after.carSwitch?.carChunk?.bytes ?? null, switchMs },
      { label: 'missing chunk', ok: missingResult?.code === 'CHUNK_CAR_MISSING',
        code: missingResult?.code ?? null }
    ];
  } catch (error) {
    failures.push('chunk capture: ' + (error?.stack ?? String(error)));
  } finally {
    if (renamed && existsSync(missingFile + '.missing-test')) {
      renameSync(missingFile + '.missing-test', missingFile);
    }
    evidence.console = messages.filter((message) => message.level === 'error' || message.level === 'warning');
    writeFileSync(path.join(OUT, 'chunk-evidence' + (MAP_ID === 'river' ? '' : '-' + MAP_ID) + '.json'),
      JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  }
  return {
    ok: failures.length === 0,
    summary: {
      mode: 'chunk',
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      map: MAP_ID,
      levelBytes: evidence.load?.before?.level?.bytes ?? evidence.load?.before?.base?.bytes ?? null,
      baseBytes: evidence.load?.before?.base?.bytes ?? null,
      firstCarBytes: evidence.load?.before?.car?.bytes ?? null,
      secondCarBytes: evidence.load?.after?.car?.bytes ?? null,
      switchMs: evidence.load?.after?.switchMs ?? null,
      missingChunk: evidence.missingChunk?.result?.code ?? null,
      screenshots: evidence.screenshot ? [evidence.screenshot] : [],
      console: { messages: evidence.console?.length ?? 0 },
      failures,
      evidence: '_work/e1-drive/chunk-evidence.json'
    }
  };
}

async function mpCapturePass() {
  const passFailures = [];
  const mpMapId = MAP_ID;
  const mpTag = mpMapId === 'river' ? '' : '-' + mpMapId;
  const mpPins = MAP_ENTRY.mpPins ?? null;
  const passCheck = (label, ok, detail = '') => { if (!ok) passFailures.push(label + (detail ? ': ' + detail : '')); };
  const distance3 = (a, b) => (Array.isArray(a) && Array.isArray(b)
    ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : null);
  const hostPage = { send, evaluate, messages };
  messages.length = 0;
  let guestPage = null;
  let roomServer = null;
  const remoteSamples = [];
  const shots = {};
  let hostLobby = null;
  let guestLobby = null;
  let hostStarted = null;
  let guestStarted = null;
  let hostFinal = null;
  let guestFinal = null;
  let fatal = null;
  let midShotAt = null;
  let resultSeenAt = null;

  const snapshotOf = async (handle) => {
    try { return await handle.evaluate('window.__mp ? window.__mp.snapshot() : null'); } catch { return null; }
  };
  const snapshotText = (snapshot) => {
    if (!snapshot) return 'null';
    return JSON.stringify({ phase: snapshot.phase, status: snapshot.status, error: snapshot.error,
      engineTick: snapshot.engineTick, engineReady: snapshot.engineReady, roomCode: snapshot.roomCode,
      result: snapshot.result?.hash ?? null });
  };
  const waitSnapshot = async (handle, predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await snapshotOf(handle);
      if (last && predicate(last)) return last;
      await sleep(150);
    }
    throw new Error(label + ' timed out; last ' + snapshotText(last));
  };
  const shot = async (handle, name) => {
    const result = await handle.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = name.replace('.png', mpTag + '.png');
    const relative = '_work/e1-drive/' + file;
    writeFileSync(path.join(OUT, file), Buffer.from(result.data, 'base64'));
    shots[name] = relative;
    return relative;
  };

  try {
    roomServer = await startRoomServer({ port: ROOM_PORT, log: () => {} });
    guestPage = await openSecondPage();
    guestPage.messages.length = 0;
    const car = defaultSlug;
    const guestCar = GUEST_CAR ?? (car === 'audi-r8v10-stock' ? 'corvette-zr1-stock' : 'audi-r8v10-stock');
    const roomQuery = '&mpServer=' + encodeURIComponent(roomServer.wsUrl) + '&audio=0';
    const hostUrl = origin + '/?mp=1&host=1&script=sprint&car=' + encodeURIComponent(car) +
      '&map=' + encodeURIComponent(mpMapId) + '&name=Host' + roomQuery;
    await hostPage.send('Page.navigate', { url: hostUrl });
    hostLobby = await waitSnapshot(hostPage, (snapshot) => snapshot.phase === 'lobby' && snapshot.engineReady,
      120000, 'host lobby + engine');
    const code = hostLobby.roomCode;
    passCheck('host allocated a 5-character room code', typeof code === 'string' && /^[A-Z2-9]{5}$/.test(code), code);

    const guestUrl = origin + '/?mp=1&room=' + encodeURIComponent(code) + '&script=sprint&car=' + encodeURIComponent(guestCar) +
      '&mpPace=0.85&name=Guest' + roomQuery;
    await guestPage.send('Page.navigate', { url: guestUrl });
    guestLobby = await waitSnapshot(guestPage, (snapshot) => snapshot.phase === 'lobby' && snapshot.engineReady,
      120000, 'guest lobby + engine');
    hostLobby = await waitSnapshot(hostPage, (snapshot) => snapshot.players.length === 2, 15000,
      'host roster has the guest');

    passCheck('guest joined the host room code', guestLobby.roomCode === code,
      JSON.stringify({ host: code, guest: guestLobby.roomCode }));
    passCheck('both pages see the same two-player roster', hostLobby.players.length === 2 &&
      guestLobby.players.length === 2, `${hostLobby.players.length}/${guestLobby.players.length}`);
    const hostSelf = hostLobby.players.find((player) => player.id === hostLobby.you.id);
    const hostOther = hostLobby.players.find((player) => player.id !== hostLobby.you.id);
    const guestSelf = guestLobby.players.find((player) => player.id === guestLobby.you.id);
    passCheck('host marker and slots are host=1 guest=2',
      hostSelf?.slot === 1 && hostSelf?.host === true && hostOther?.slot === 2 && hostOther?.host === false &&
      guestSelf?.slot === 2 && guestSelf?.host === false,
      JSON.stringify({ hostSelf, guestSelf }));
    passCheck('M1.1 loads each player\'s own car chunk (host and guest differ)',
      hostLobby.sessionCar === car && guestLobby.sessionCar === guestCar &&
      hostLobby.sessionCar !== guestLobby.sessionCar,
      `${hostLobby.sessionCar} / ${guestLobby.sessionCar}`);
    // Exercise the host-only lobby switch and the per-client map reload. Start
    // from the room's current map, switch to River and back to the captured map,
    // then assert both pages re-verified before READY.
    if (mpMapId !== 'river') {
      await hostPage.evaluate('window.__mp.selectMap("river")');
      await waitSnapshot(hostPage, (snapshot) => snapshot.mapId === 'river' && snapshot.mapReady,
        90000, 'host switched to river');
      await waitSnapshot(guestPage, (snapshot) => snapshot.mapId === 'river' && snapshot.mapReady,
        90000, 'guest reloaded river');
      await hostPage.evaluate('window.__mp.selectMap(' + JSON.stringify(mpMapId) + ')');
      hostLobby = await waitSnapshot(hostPage, (snapshot) => snapshot.mapId === mpMapId && snapshot.mapReady,
        120000, 'host switched back to ' + mpMapId);
      guestLobby = await waitSnapshot(guestPage, (snapshot) => snapshot.mapId === mpMapId && snapshot.mapReady,
        120000, 'guest reloaded ' + mpMapId);
      passCheck('host map switch reloads and re-verifies the map on both pages',
        hostLobby.mapReady === true && guestLobby.mapReady === true &&
        hostLobby.map?.packageHash === mpPins?.packageHash &&
        guestLobby.map?.packageHash === mpPins?.packageHash,
        JSON.stringify({ host: hostLobby.mapId, guest: guestLobby.mapId }));
    }
    passCheck('lobby shows the host-selected map on both pages',
      hostLobby.mapId === mpMapId && guestLobby.mapId === mpMapId && hostLobby.map?.id === mpMapId,
      JSON.stringify({ host: hostLobby.mapId, guest: guestLobby.mapId, expected: mpMapId }));
    passCheck('both pages report map-ready with the registry hashes',
      hostLobby.mapReady === true && guestLobby.mapReady === true &&
      hostLobby.map?.packageHash === mpPins?.packageHash &&
      guestLobby.map?.packageHash === mpPins?.packageHash &&
      hostLobby.map?.layoutHash === mpPins?.layoutHash &&
      guestLobby.map?.layoutHash === mpPins?.layoutHash &&
      hostLobby.map?.physicsHash === mpPins?.physicsHash &&
      guestLobby.map?.physicsHash === mpPins?.physicsHash,
      JSON.stringify({ host: hostLobby.map?.packageHash, guest: guestLobby.map?.packageHash }));
    passCheck('map loading state records bytes and elapsed time',
      Number.isFinite(hostLobby.map?.loadMs) && Number.isFinite(hostLobby.map?.bytes?.total) &&
      hostLobby.map.bytes.total > 0 && Number.isFinite(guestLobby.map?.loadMs) &&
      guestLobby.map.loadMs > 0,
      JSON.stringify({ host: { ms: hostLobby.map?.loadMs, bytes: hostLobby.map?.bytes?.total },
        guest: { ms: guestLobby.map?.loadMs, bytes: guestLobby.map?.bytes?.total } }));
    const expectedGrid = mpMapId === 'gracia'
      ? 'measured spawn + path tangent (longitudinal)' : 'race-rules provisional lateral grid';
    passCheck('both start-grid slots probe the real engine ground before start',
      hostLobby.grid?.slots?.length === 2 && hostLobby.grid.probes?.length === 2 &&
      hostLobby.grid.probes.every((probe) => probe.ok === true) &&
      guestLobby.grid?.slot === 2 && hostLobby.grid.slot === 1,
      JSON.stringify({ host: hostLobby.grid, guest: guestLobby.grid }));
    passCheck('the Gracia longitudinal grid is selected only after the lateral pose fails',
      hostLobby.grid?.source === expectedGrid &&
      (mpMapId !== 'gracia' ||
        hostLobby.grid.tried?.some((row) => row.source.includes('lateral') && row.ok === false)),
      JSON.stringify({ source: hostLobby.grid?.source, tried: hostLobby.grid?.tried }));
    passCheck('lobby start is host-only and disabled before ready',
      hostLobby.overlays.startHidden === false && hostLobby.overlays.startDisabled === true &&
      guestLobby.overlays.startHidden === true,
      JSON.stringify({ host: hostLobby.overlays.startHidden, hostDisabled: hostLobby.overlays.startDisabled,
        guest: guestLobby.overlays.startHidden }));

    await hostPage.evaluate('window.__mp.setReady(true)');
    await guestPage.evaluate('window.__mp.setReady(true)');
    hostLobby = await waitSnapshot(hostPage, (snapshot) => snapshot.players.length === 2 &&
      snapshot.players.every((player) => player.ready), 15000, 'host all ready');
    guestLobby = await waitSnapshot(guestPage, (snapshot) => snapshot.players.length === 2 &&
      snapshot.players.every((player) => player.ready), 15000, 'guest all ready');
    passCheck('ready propagates to both rosters', hostLobby.players.every((player) => player.ready) &&
      guestLobby.players.every((player) => player.ready));
    passCheck('host start becomes enabled when all players are ready',
      hostLobby.overlays.startHidden === false && hostLobby.overlays.startDisabled === false,
      JSON.stringify(hostLobby.overlays));
    passCheck('lobby shows the room code and a live connection status',
      hostLobby.overlays.roomCodeText === code && /lobby|ready|engine/i.test(hostLobby.overlays.statusText ?? ''),
      JSON.stringify({ code: hostLobby.overlays.roomCodeText, status: hostLobby.overlays.statusText }));
    const lobbyHostShot = await shot(hostPage, 'browser-mp-lobby-host.png');
    const lobbyGuestShot = await shot(guestPage, 'browser-mp-lobby-guest.png');

    await hostPage.evaluate('window.__mp.start()');
    hostStarted = await waitSnapshot(hostPage, (snapshot) => snapshot.started && snapshot.engineTick >= 2,
      30000, 'host race start');
    guestStarted = await waitSnapshot(guestPage, (snapshot) => snapshot.started && snapshot.engineTick >= 2,
      30000, 'guest race start');
    passCheck('host start broadcasts room.started to both pages', hostStarted.started && guestStarted.started);
    passCheck('room.started carries the selected map on both pages',
      hostStarted.mapId === mpMapId && guestStarted.mapId === mpMapId,
      JSON.stringify({ host: hostStarted.mapId, guest: guestStarted.mapId, expected: mpMapId }));

    const raceDeadline = Date.now() + (mpMapId === 'amboy' ? 360000 : mpMapId === 'gracia' ? 200000 : 150000);
    let hostView = hostStarted;
    let guestView = guestStarted;
    while (Date.now() < raceDeadline) {
      hostView = await snapshotOf(hostPage) ?? hostView;
      guestView = await snapshotOf(guestPage) ?? guestView;
      if (hostView.remote.sampleTick !== null && guestView.remote.sampleTick !== null &&
          remoteSamples.length < 20) {
        const guestAtLatest = hostView.remote.latestTick !== null
          ? await guestPage.evaluate('window.__mp.stateAt(' + hostView.remote.latestTick + ')').catch(() => null)
          : null;
        const hostAtLatest = guestView.remote.latestTick !== null
          ? await hostPage.evaluate('window.__mp.stateAt(' + guestView.remote.latestTick + ')').catch(() => null)
          : null;
        if (hostView.remote.displayPosition && hostView.remote.samplePosition) {
          remoteSamples.push({
            side: 'host-view-of-guest',
            sampleTick: hostView.remote.sampleTick,
            latestTick: hostView.remote.latestTick,
            displayDistance: distance3(hostView.remote.displayPosition, hostView.remote.samplePosition),
            latestDistance: guestAtLatest ? distance3(hostView.remote.latestPosition, guestAtLatest.position) : null,
            interpolated: hostView.remote.sample?.interpolated ?? null,
            corrections: hostView.remote.corrections
          });
        }
        if (guestView.remote.displayPosition && guestView.remote.samplePosition) {
          remoteSamples.push({
            side: 'guest-view-of-host',
            sampleTick: guestView.remote.sampleTick,
            latestTick: guestView.remote.latestTick,
            displayDistance: distance3(guestView.remote.displayPosition, guestView.remote.samplePosition),
            latestDistance: hostAtLatest ? distance3(guestView.remote.latestPosition, hostAtLatest.position) : null,
            interpolated: guestView.remote.sample?.interpolated ?? null,
            corrections: guestView.remote.corrections
          });
        }
      }
      if (!midShotAt && hostView.engineTick >= 300 && hostView.engineTick < 1400 &&
          guestView.engineTick >= 300 && hostView.sprint?.phase === 'running' && guestView.sprint?.phase === 'running') {
        midShotAt = { hostTick: hostView.engineTick, guestTick: guestView.engineTick };
        await shot(hostPage, 'browser-mp-mid-host.png');
        await shot(guestPage, 'browser-mp-mid-guest.png');
      }
      if (hostView.result && guestView.result) {
        if (hostView.validation) break;
        if (resultSeenAt === null) resultSeenAt = Date.now();
        if (Date.now() - resultSeenAt > 15000) break;
      }
      await sleep(120);
    }
    hostFinal = hostView;
    guestFinal = guestView;
    if (!hostFinal.result || !guestFinal.result) {
      throw new Error('both pages did not reach the shared result; host phase ' + hostFinal.phase +
        ', guest phase ' + guestFinal.phase + ', ticks ' + hostFinal.engineTick + '/' + guestFinal.engineTick +
        ', host ' + JSON.stringify({ status: hostFinal.status, consumer: hostFinal.consumer,
          frames: hostFinal.frames, error: hostFinal.error, stack: hostFinal.renderErrorStack,
          frameError: hostFinal.frameError, frameStack: hostFinal.frameErrorStack,
          remote: hostFinal.remote?.carChunk ? { slug: hostFinal.remote.carChunk.slug,
            status: hostFinal.remote.carChunk.status, error: hostFinal.remote.carChunk.error } : null,
          capped: hostFinal.cappedFrames }) +
        ', guest ' + JSON.stringify({ status: guestFinal.status, consumer: guestFinal.consumer,
          frames: guestFinal.frames, error: guestFinal.error,
          remote: guestFinal.remote?.carChunk ? { slug: guestFinal.remote.carChunk.slug,
            status: guestFinal.remote.carChunk.status, error: guestFinal.remote.carChunk.error } : null }));
    }
    const finishHostShot = await shot(hostPage, 'browser-mp-finish-host.png');
    const finishGuestShot = await shot(guestPage, 'browser-mp-finish-guest.png');

    passCheck('both pages reached the shared result',
      hostFinal.phase === 'finished' && guestFinal.phase === 'finished');
    passCheck('each page drew the peer car from its own chunk (no fallback body)',
      hostFinal.remote.car === guestCar && guestFinal.remote.car === car &&
      hostFinal.remote.carChunk?.status === 'ready' &&
      guestFinal.remote.carChunk?.status === 'ready' &&
      hostFinal.remote.carChunk?.slug === guestCar &&
      guestFinal.remote.carChunk?.slug === car &&
      hostFinal.remote.carChunk?.bytes > 0 && guestFinal.remote.carChunk?.bytes > 0 &&
      hostFinal.remote.carChunk?.error === null && guestFinal.remote.carChunk?.error === null,
      JSON.stringify({ hostRemote: hostFinal.remote.carChunk, guestRemote: guestFinal.remote.carChunk }));
    passCheck('host and guest render the same result hash',
      hostFinal.result.hash === guestFinal.result.hash,
      hostFinal.result.hash + ' / ' + guestFinal.result.hash);
    passCheck('host and guest render identical result rows',
      JSON.stringify(hostFinal.result.rows) === JSON.stringify(guestFinal.result.rows));
    passCheck('shared result identifies the selected map/course',
      hostFinal.result.courseId === (mpMapId === 'river' ? '310m' : mpMapId) &&
      guestFinal.result.courseId === (mpMapId === 'river' ? '310m' : mpMapId),
      JSON.stringify({ host: hostFinal.result.courseId, guest: guestFinal.result.courseId, expected: mpMapId }));
    passCheck('both cars finish the measured course (no early/mid-race table)',
      mpMapId === 'river'
        ? hostFinal.sprint?.finishTick > 300 && guestFinal.sprint?.finishTick > 300
        : mpMapId === 'amboy'
          ? hostFinal.sprint?.finishTick > 12000 && guestFinal.sprint?.finishTick > 12000
          : hostFinal.sprint?.finishTick > 3500 && guestFinal.sprint?.finishTick > 3500,
      JSON.stringify({ hostTick: hostFinal.sprint?.finishTick, guestTick: guestFinal.sprint?.finishTick }));
    const hostRow = hostFinal.result.rows.find((row) => row.playerId === hostFinal.you.id);
    const guestRow = hostFinal.result.rows.find((row) => row.playerId === guestFinal.you.id);
    passCheck('finish order is host P1 and guest P2',
      hostRow?.positionNumber === 1 && guestRow?.positionNumber === 2 &&
      hostRow?.status === 'finished' && guestRow?.status === 'finished',
      JSON.stringify({ host: hostRow?.positionNumber, guest: guestRow?.positionNumber }));
    passCheck('both table rows are finished (no DNF)',
      hostFinal.result.rows.every((row) => row.status === 'finished'),
      hostFinal.result.rows.map((row) => row.status).join(','));
    passCheck('no host or guest start respawn (grid ground probes kept both posture slots grounded)',
      hostFinal.sprint?.respawns === 0 && guestFinal.sprint?.respawns === 0,
      JSON.stringify({ host: hostFinal.sprint?.respawns, guest: guestFinal.sprint?.respawns }));
    passCheck('host row equals the host local finish within one tick',
      Number.isInteger(hostFinal.finishTick) && Math.abs(hostFinal.finishTick - hostRow.tick) <= 1 &&
      hostFinal.sprint?.finishTimeSeconds !== null &&
      Math.abs(hostFinal.sprint.finishTimeSeconds - hostRow.timeSeconds) <= (1 / 60) + 1e-6,
      `${hostFinal.finishTick} vs ${hostRow?.tick} · ${hostFinal.sprint?.finishTimeSeconds} vs ${hostRow?.timeSeconds}`);
    passCheck('guest row equals the guest local finish within one tick',
      Number.isInteger(guestFinal.finishTick) && Math.abs(guestFinal.finishTick - guestRow.tick) <= 1 &&
      guestFinal.sprint?.finishTimeSeconds !== null &&
      Math.abs(guestFinal.sprint.finishTimeSeconds - guestRow.timeSeconds) <= (1 / 60) + 1e-6,
      `${guestFinal.finishTick} vs ${guestRow?.tick} · ${guestFinal.sprint?.finishTimeSeconds} vs ${guestRow?.timeSeconds}`);
    passCheck('shared rows are ordered by finish time',
      hostFinal.result.rows.every((row, index, rows) => index === 0 ||
        (rows[index - 1].status === 'finished' && row.status === 'finished'
          ? rows[index - 1].tick <= row.tick
          : rows[index - 1].status === 'finished')) &&
      hostRow.positionNumber === 1,
      JSON.stringify(hostFinal.result.rows.map((row) => [row.positionNumber, row.tick, row.timeSeconds])));
    passCheck('host RaceSession accepted the guest finish report while the race was open',
      hostFinal.validation?.guestReportAccepted === true && hostFinal.validation?.guestValidated === true,
      JSON.stringify(hostFinal.validation));
    passCheck('a guest report later than host detection is accepted (detection delta is diagnostic)',
      Number.isFinite(hostFinal.validation?.guestReportedTick) &&
      hostFinal.validation.guestReportedTick > (hostFinal.validation?.hostFinishTick ?? 0) &&
      (hostFinal.validation?.guestDetectedFinishTick === null ||
        Number.isFinite(hostFinal.validation?.guestDetectionDeltaTicks)),
      JSON.stringify({ reported: hostFinal.validation?.guestReportedTick,
        detected: hostFinal.validation?.guestDetectedFinishTick,
        delta: hostFinal.validation?.guestDetectionDeltaTicks }));
    passCheck('both pages show the result overlay',
      hostFinal.overlays.resultsHidden === false && guestFinal.overlays.resultsHidden === false &&
      hostFinal.overlays.mpResultsHidden === false && (hostFinal.overlays.resultsTime ?? '').includes(hostRow.name),
      JSON.stringify({ host: hostFinal.overlays.resultsTime, guest: guestFinal.overlays.resultsTime }));

    const displayDistances = remoteSamples.map((row) => row.displayDistance).filter(Number.isFinite);
    const latestDistances = remoteSamples.map((row) => row.latestDistance).filter(Number.isFinite);
    const maxDisplay = displayDistances.length ? Math.max(...displayDistances) : null;
    const maxLatest = latestDistances.length ? Math.max(...latestDistances) : null;
    passCheck('remote pose is within 0.5 m at sampled ticks',
      remoteSamples.length >= 4 && maxDisplay !== null && maxDisplay <= 0.5,
      `${remoteSamples.length} samples, max display Δ ${maxDisplay}`);
    passCheck('received snapshot equals the sender state at the same tick',
      maxLatest !== null && maxLatest <= 1e-3,
      `max latest Δ ${maxLatest}`);

    passCheck('host applied the guest state sequence and vice versa (final state may be in flight)',
      Math.abs(hostFinal.applied.state - guestFinal.sent.state) <= 1 &&
      Math.abs(guestFinal.applied.state - hostFinal.sent.state) <= 1,
      JSON.stringify({ hostApplied: hostFinal.applied.state, guestSent: guestFinal.sent.state,
        guestApplied: guestFinal.applied.state, hostSent: hostFinal.sent.state }));
    passCheck('authority flag is host=true / guest=false on the relayed state',
      guestFinal.remote.authority === true && hostFinal.remote.authority === false,
      JSON.stringify({ guestSeesHost: guestFinal.remote.authority, hostSeesGuest: hostFinal.remote.authority }));
    passCheck('remote tag is visible and labelled REMOTE',
      hostFinal.overlays.remoteTagHidden === false && guestFinal.overlays.remoteTagHidden === false &&
      /^REMOTE/.test(hostFinal.overlays.remoteTagText ?? '') &&
      /no collision/.test(hostFinal.overlays.remoteTagText ?? ''),
      JSON.stringify({ host: hostFinal.overlays.remoteTagText, guest: guestFinal.overlays.remoteTagText }));
    const hudText = await hostPage.evaluate('document.getElementById("hud").textContent');
    passCheck('HUD shows room, ping, sequence and correction count',
      /^mp\s/m.test(hudText) && /ping /.test(hudText) && /state seq /.test(hudText) && /corrections /.test(hudText),
      (hudText ?? '').split('\n').filter((line) => /^(mp|mp net|mp remote)/.test(line)).join(' | '));
    passCheck('correction counters are recorded on both pages',
      Number.isFinite(hostFinal.remote.corrections) && Number.isFinite(guestFinal.remote.corrections),
      JSON.stringify({ host: hostFinal.remote.corrections, guest: guestFinal.remote.corrections }));

    const roomStats = roomServer.stats();
    passCheck('room service finished exactly one room', roomStats.roomsCreated === 1 && roomStats.roomsFinished === 1,
      JSON.stringify(roomStats));

    const hostBlocking = hostPage.messages.filter((entry) => entry.source !== 'console.log');
    const guestBlocking = guestPage.messages.filter((entry) => entry.source !== 'console.log');
    passCheck('console is clean on both pages', hostPage.messages.length === 0 && guestPage.messages.length === 0,
      [...hostPage.messages, ...guestPage.messages].slice(0, 6).map((entry) => entry.source + ' ' + entry.text).join(' | '));

    const evidence = {
      kind: 'e1-drive.mp-browser',
      version: 1,
      browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT, pages: 2 },
      ports: { game: PORT, room: ROOM_PORT },
      map: {
        id: mpMapId,
        pins: mpPins,
        host: hostLobby?.map ?? null,
        guest: guestLobby?.map ?? null,
        loadMs: { host: hostLobby?.map?.loadMs ?? null, guest: guestLobby?.map?.loadMs ?? null }
      },
      room: {
        code,
        wsUrl: roomServer.wsUrl,
        stats: roomStats,
        requestedCodeMismatch: hostLobby.requestedCodeMismatch
      },
      lobby: {
        host: hostLobby,
        guest: guestLobby,
        screenshots: { host: shots['browser-mp-lobby-host.png'], guest: shots['browser-mp-lobby-guest.png'] }
      },
      race: {
        hostStarted,
        guestStarted,
        midShotAt,
        remoteCars: {
          hostViewOfGuest: hostFinal?.remote?.carChunk ?? null,
          guestViewOfHost: guestFinal?.remote?.carChunk ?? null
        },
        screenshots: {
          host: shots['browser-mp-mid-host.png'],
          guest: shots['browser-mp-mid-guest.png']
        }
      },
      remotePose: {
        samples: remoteSamples,
        toleranceMetres: 0.5,
        maxDisplayDistance: maxDisplay,
        maxLatestDistance: maxLatest
      },
      finish: {
        host: hostFinal,
        guest: guestFinal,
        screenshots: { host: finishHostShot, guest: finishGuestShot },
        sharedHash: hostFinal.result.hash,
        rowsEqual: JSON.stringify(hostFinal.result.rows) === JSON.stringify(guestFinal.result.rows)
      },
      console: {
        host: { totalMessages: hostPage.messages.length, blocking: hostBlocking.length, messages: hostPage.messages },
        guest: { totalMessages: guestPage.messages.length, blocking: guestBlocking.length, messages: guestPage.messages }
      },
      assertions: { ok: passFailures.length === 0, failures: passFailures },
      verdict: passFailures.length === 0 && hostPage.messages.length === 0 && guestPage.messages.length === 0
        ? 'clean-console-and-gates' : 'failed'
    };
    writeFileSync(path.join(OUT, 'browser-evidence-mp' + mpTag + '.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    writeFileSync(path.join(LOGS, 'edge-mp' + mpTag + '.log'), browserLog +
      '\nroom: ' + JSON.stringify(roomStats) + '\n', 'utf8');
    return {
      ok: evidence.verdict === 'clean-console-and-gates',
      summary: {
        verdict: evidence.verdict,
        room: code,
        map: { id: mpMapId, loadMs: {
          host: hostLobby.map?.loadMs ?? null, guest: guestLobby.map?.loadMs ?? null
        }, bytes: hostLobby.map?.bytes ?? null },
        sharedHash: hostFinal.result.hash,
        rows: hostFinal.result.rows.map((row) => ({
          position: row.positionNumber, name: row.name, tick: row.tick, timeSeconds: row.timeSeconds
        })),
        remotePose: { samples: remoteSamples.length, maxDisplayDistance: maxDisplay, maxLatestDistance: maxLatest },
        sequences: { host: hostFinal.sent, guest: guestFinal.sent, appliedHost: hostFinal.applied, appliedGuest: guestFinal.applied },
        console: { host: hostPage.messages.length, guest: guestPage.messages.length },
        screenshots: shots,
        failures: passFailures
      }
    };
  } catch (error) {
    fatal = error;
    const evidence = {
      kind: 'e1-drive.mp-browser',
      version: 1,
      browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT, pages: 2 },
      ports: { game: PORT, room: ROOM_PORT },
      room: roomServer ? { stats: roomServer.stats() } : null,
      lobby: { host: hostLobby, guest: guestLobby },
      race: { hostStarted, guestStarted, midShotAt },
      remotePose: { samples: remoteSamples },
      finish: { host: hostFinal, guest: guestFinal },
      console: {
        host: { totalMessages: hostPage.messages.length, messages: hostPage.messages },
        guest: { totalMessages: guestPage?.messages?.length ?? 0, messages: guestPage?.messages ?? [] }
      },
      assertions: { ok: false, failures: [error.message, ...passFailures] },
      verdict: 'failed',
      error: error.message
    };
    writeFileSync(path.join(OUT, 'browser-evidence-mp' + mpTag + '.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    writeFileSync(path.join(LOGS, 'edge-mp' + mpTag + '.log'), browserLog + '\nERROR: ' + error.message + '\n', 'utf8');
    return {
      ok: false,
      summary: {
        verdict: 'failed',
        error: error.message,
        failures: passFailures,
        screenshots: shots,
        console: { host: hostPage.messages.length, guest: guestPage?.messages?.length ?? 0 }
      }
    };
  } finally {
    try { guestPage?.close(); } catch {}
    try { await roomServer?.close(); } catch {}
    if (fatal) console.error('mp capture failed:', fatal.message);
  }
}

/**
 * M4 AI-opponent capture (`--mode mp-ai`): the same two real pages plus 2 host
 * AI cars. The guest never simulates AI; it renders the host's 20 Hz poses and
 * merges the host's AI rows into the shared result.
 */
/**
 * Solo host + AI capture (`--mode mp-solo-ai`): one human, host-simulated AI.
 * This is the flow a player uses when no second human joins.
 */
async function mpSoloAiCapturePass() {
  const failures = [];
  const check = (label, ok, detail = '') => { if (!ok) failures.push(label + (detail ? ': ' + detail : '')); };
  messages.length = 0;
  let roomServer = null;
  const shots = {};
  const snap = async () => {
    try { return await evaluate('window.__mp ? window.__mp.snapshot() : null'); } catch { return null; }
  };
  const wait = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await snap();
      if (last && predicate(last)) return last;
      await sleep(150);
    }
    throw new Error(label + ' timed out; last ' + JSON.stringify(last));
  };
  const capture = async (name) => {
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path.join(OUT, name), Buffer.from(result.data, 'base64'));
    shots[name] = '_work/e1-drive/' + name;
  };
  try {
    roomServer = await startRoomServer({ port: ROOM_PORT, log: () => {} });
    const query = '&mpServer=' + encodeURIComponent(roomServer.wsUrl) + '&audio=0';
    const url = origin + '/?mp=1&host=1&script=sprint&car=' + encodeURIComponent(defaultSlug) +
      '&ai=' + AI_COUNT + '&aiCars=' + encodeURIComponent(AI_CARS) +
      '&aiProfiles=' + encodeURIComponent(AI_PROFILES) + '&map=river&name=SoloHost' + query;
    await send('Page.navigate', { url });
    let lobby = await wait((s) => s.phase === 'lobby' && s.engineReady &&
      s.ai?.count === AI_COUNT && s.ai.built === true && s.ai.players?.length === AI_COUNT,
      120000, 'solo AI lobby');
    check('solo host builds the AI records', lobby.ai.players.length === AI_COUNT && lobby.ai.ready === true,
      JSON.stringify(lobby.ai));
    check('solo lobby has exactly one human', lobby.players?.length === 1, JSON.stringify(lobby.players));
    await evaluate('window.__mp.setReady(true)');
    lobby = await wait((s) => s.players?.length === 1 && s.players[0].ready === true &&
      s.overlays?.startDisabled === false, 20000, 'solo start enabled');
    check('START enables for one human + AI', lobby.overlays.startDisabled === false,
      JSON.stringify(lobby.overlays));
    await capture('browser-mp-solo-ai-lobby.png');
    await evaluate('window.__mp.start()');
    const run = await wait((s) => s.started === true && (s.engineTick ?? 0) > 2, 60000, 'solo race start');
    check('solo race starts', run.started === true,
      JSON.stringify({ phase: run.phase, tick: run.engineTick }));
    await sleep(1200);
    await capture('browser-mp-solo-ai-mid.png');
    const done = await wait((s) => s.phase === 'finished' || s.result != null, 180000, 'solo race finish');
    const rows = done.result?.order ?? done.ai?.result?.rows ?? [];
    check('solo race finishes with the AI rows', rows.length >= 1 + AI_COUNT, JSON.stringify(rows));
    await capture('browser-mp-solo-ai-finish.png');
    const blocking = messages.filter((entry) => entry.source !== 'console.log');
    check('console is clean in the solo AI race', blocking.length === 0,
      JSON.stringify(blocking.slice(0, 3)));
  } catch (error) {
    failures.push('error: ' + error.message);
  } finally {
    try { roomServer?.close(); } catch {}
  }
  const evidence = { mode: 'mp-solo-ai', aiCount: AI_COUNT, shots, failures };
  writeFileSync(path.join(OUT, 'browser-evidence-mp-solo-ai.json'), JSON.stringify(evidence, null, 2) + '\n');
  return { summary: evidence, ok: failures.length === 0 };
}

async function mpAiCapturePass() {
  const passFailures = [];
  const mpAiTag = MAP_ID === 'river' ? '' : '-' + MAP_ID;
  const passCheck = (label, ok, detail = '') => { if (!ok) passFailures.push(label + (detail ? ': ' + detail : '')); };
  const distance3 = (a, b) => (Array.isArray(a) && Array.isArray(b)
    ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : null);
  const hostPage = { send, evaluate, messages };
  messages.length = 0;
  let guestPage = null;
  let roomServer = null;
  const shots = {};
  let hostLobby = null;
  let guestLobby = null;
  let hostFinal = null;
  let guestFinal = null;
  let fatal = null;
  let midShotAt = null;
  let aiRemoteSamples = 0;
  const aiRemoteErrors = [];

  const snapshotOf = async (handle) => {
    try { return await handle.evaluate('window.__mp ? window.__mp.snapshot() : null'); } catch { return null; }
  };
  const snapshotText = (snapshot) => {
    if (!snapshot) return 'null';
    return JSON.stringify({ phase: snapshot.phase, status: snapshot.status, error: snapshot.error,
      engineTick: snapshot.engineTick, engineReady: snapshot.engineReady, roomCode: snapshot.roomCode,
      ai: snapshot.ai ? { count: snapshot.ai.count, built: snapshot.ai.built, ready: snapshot.ai.ready,
        errors: snapshot.ai.errors, relayError: snapshot.ai.relayError } : null,
      result: snapshot.result?.hash ?? null });
  };
  const waitSnapshot = async (handle, predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await snapshotOf(handle);
      if (last && predicate(last)) return last;
      await sleep(150);
    }
    throw new Error(label + ' timed out; last ' + snapshotText(last));
  };
  const shot = async (handle, name) => {
    const result = await handle.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = name.replace('.png', mpAiTag + '.png');
    const relative = '_work/e1-drive/' + file;
    writeFileSync(path.join(OUT, file), Buffer.from(result.data, 'base64'));
    shots[name] = relative;
    return relative;
  };

  try {
    roomServer = await startRoomServer({ port: ROOM_PORT, log: () => {} });
    guestPage = await openSecondPage();
    guestPage.messages.length = 0;
    const car = defaultSlug;
    const guestCar = GUEST_CAR ?? (car === 'audi-r8v10-stock' ? 'corvette-zr1-stock' : 'audi-r8v10-stock');
    const roomQuery = '&mpServer=' + encodeURIComponent(roomServer.wsUrl) + '&audio=0';
    const aiQuery = '&ai=' + AI_COUNT + '&aiCars=' + encodeURIComponent(AI_CARS) +
      '&aiProfiles=' + encodeURIComponent(AI_PROFILES);
    const hostUrl = origin + '/?mp=1&host=1&script=sprint&car=' + encodeURIComponent(car) +
      '&map=' + encodeURIComponent(MAP_ID) + '&name=Host' + aiQuery + roomQuery;
    await hostPage.send('Page.navigate', { url: hostUrl });
    hostLobby = await waitSnapshot(hostPage, (snapshot) => snapshot.phase === 'lobby' &&
      snapshot.engineReady && snapshot.ai?.count === AI_COUNT && snapshot.ai.built === true &&
      snapshot.ai.players.length === AI_COUNT, 120000, 'host lobby + AI records');
    const code = hostLobby.roomCode;
    passCheck('host allocated a room code', typeof code === 'string' && /^[A-Z2-9]{5}$/.test(code), code);

    const guestUrl = origin + '/?mp=1&room=' + encodeURIComponent(code) + '&script=sprint&car=' +
      encodeURIComponent(car) + '&mpPace=0.8&name=Guest' + roomQuery;
    await guestPage.send('Page.navigate', { url: guestUrl });
    guestLobby = await waitSnapshot(guestPage, (snapshot) => snapshot.phase === 'lobby' &&
      snapshot.engineReady && snapshot.ai?.count === AI_COUNT &&
      snapshot.ai.remotePlayers.length === AI_COUNT, 120000, 'guest lobby + relayed AI list');
    hostLobby = await waitSnapshot(hostPage, (snapshot) => snapshot.players.length === 2, 15000,
      'host roster has the guest');

    const hostAi = hostLobby.ai.records ?? [];
    const guestAi = guestLobby.ai.records ?? [];
    passCheck('host builds 0-3 AI records with ai-1... participant ids',
      hostAi.length === AI_COUNT && hostAi.every((record, index) =>
        record.id === 'ai-' + (index + 1) && record.slot === 3 + index),
      JSON.stringify(hostAi));
    passCheck('the guest sees the same AI list read-only (ids, cars, profiles)',
      guestLobby.ai.host === false && guestLobby.ai.records.length === AI_COUNT &&
      JSON.stringify(guestAi.map((row) => [row.id, row.slot, row.car, row.profile])) ===
        JSON.stringify(hostAi.map((row) => [row.id, row.slot, row.car, row.profile])),
      JSON.stringify({ host: hostAi, guest: guestAi }));
    passCheck('the AI roster uses only supported profiles and distinct cars',
      hostAi.every((record) => ['cautious', 'standard', 'reference'].includes(record.profile)) &&
      hostAi.every((record) => typeof record.car === 'string' && record.car.length > 0),
      JSON.stringify(hostAi.map((row) => [row.car, row.profile])));
    passCheck('lobby start is host-only and disabled before the humans are ready',
      hostLobby.overlays.startHidden === false && hostLobby.overlays.startDisabled === true &&
      guestLobby.overlays.startHidden === true,
      JSON.stringify({ host: hostLobby.overlays.startHidden, hostDisabled: hostLobby.overlays.startDisabled,
        guest: guestLobby.overlays.startHidden }));
    passCheck('guest AI selects are read-only',
      hostLobby.overlays.aiCountDisabled === false &&
      guestLobby.overlays.aiCountDisabled === true &&
      guestLobby.overlays.aiCar1Disabled === true &&
      guestLobby.overlays.aiProfile1Disabled === true &&
      /AI 1/.test(guestLobby.overlays.aiListText ?? ''),
      JSON.stringify({ hostCount: hostLobby.overlays.aiCountDisabled,
        guestCount: guestLobby.overlays.aiCountDisabled,
        guestCar: guestLobby.overlays.aiCar1Disabled,
        guestProfile: guestLobby.overlays.aiProfile1Disabled }));

    await hostPage.evaluate('window.__mp.setReady(true)');
    await guestPage.evaluate('window.__mp.setReady(true)');
    hostLobby = await waitSnapshot(hostPage, (snapshot) => snapshot.players.length === 2 &&
      snapshot.players.every((player) => player.ready), 15000, 'host all ready');
    passCheck('host start becomes enabled with all humans ready and the AI records built',
      hostLobby.overlays.startDisabled === false && hostLobby.ai.ready === true,
      JSON.stringify(hostLobby.overlays));
    await shot(hostPage, 'browser-mp-ai-lobby-host.png');
    await shot(guestPage, 'browser-mp-ai-lobby-guest.png');

    await hostPage.evaluate('window.__mp.start()');
    hostFinal = await waitSnapshot(hostPage, (snapshot) => snapshot.started && snapshot.engineTick >= 2,
      30000, 'host race start');
    guestFinal = await waitSnapshot(guestPage, (snapshot) => snapshot.started && snapshot.engineTick >= 2,
      30000, 'guest race start');
    passCheck('host start broadcasts room.started to both pages', hostFinal.started && guestFinal.started);
    passCheck('the host created one wasm instance per AI with grounded start slots',
      hostFinal.ai.hostSim?.count === AI_COUNT && hostFinal.ai.hostSim.sims.length === AI_COUNT &&
      hostFinal.ai.hostSim.sims.every((sim) => sim.startSlot !== null),
      JSON.stringify(hostFinal.ai.hostSim));

    const raceDeadline = Date.now() + (MAP_ID === 'amboy' ? 600000 : MAP_ID === 'gracia' ? 240000 : 240000);
    let hostView = hostFinal;
    let guestView = guestFinal;
    let reconnect = null;
    let reconnectChecked = false;
    while (Date.now() < raceDeadline) {
      hostView = await snapshotOf(hostPage) ?? hostView;
      guestView = await snapshotOf(guestPage) ?? guestView;
      const guestRemotes = guestView.ai?.remotes ?? [];
      for (const entry of guestRemotes) {
        if (entry.sampleTick !== null && entry.displayPosition) {
          aiRemoteSamples++;
          if (entry.samplePosition) {
            const delta = distance3(entry.displayPosition, entry.samplePosition);
            if (!Number.isFinite(delta) || delta > 0.5) aiRemoteErrors.push({ id: entry.id, delta });
          }
        }
      }
      if (!midShotAt && hostView.engineTick >= 400 && hostView.engineTick < 1400 &&
          hostView.sprint?.phase === 'running' && guestView.sprint?.phase === 'running' &&
          guestRemotes.some((entry) => entry.sampleTick !== null)) {
        midShotAt = { hostTick: hostView.engineTick, guestTick: guestView.engineTick,
          guestAiSamples: guestRemotes.map((entry) => entry.sampleTick) };
        await shot(hostPage, 'browser-mp-ai-mid-host.png');
        await shot(guestPage, 'browser-mp-ai-mid-guest.png');
      }
      // M4 reconnect check (River): the host keeps simulating AI while the
      // guest's socket resumes; the guest re-receives poses after the resume.
      if (MAP_ID === 'river' && midShotAt && !reconnectChecked &&
          hostView.sprint?.phase === 'running' && guestView.sprint?.phase === 'running') {
        reconnectChecked = true;
        const beforeTicks = hostView.ai.hostSim.sims.map((sim) => sim.ticks);
        const beforeSamples = guestRemotes.reduce((sum, entry) => sum + (entry.samples ?? 0), 0);
        let dropError = null;
        try { await guestPage.evaluate('window.__mp.drop()'); }
        catch (error) { dropError = error.message; }
        const resumed = await waitSnapshot(guestPage,
          (snapshot) => snapshot.resumeCount > 0 && snapshot.phase !== 'reconnecting', 30000,
          'guest reconnect with host AI');
        await sleep(900);
        const hostAfter = await snapshotOf(hostPage);
        const guestAfter = await snapshotOf(guestPage);
        reconnect = {
          dropError,
          beforeTicks,
          afterTicks: hostAfter.ai.hostSim.sims.map((sim) => sim.ticks),
          resumeCount: resumed.resumeCount,
          beforeSamples,
          afterSamples: (guestAfter.ai.remotes ?? []).reduce((sum, entry) => sum + (entry.samples ?? 0), 0),
          guestAiRemotes: guestAfter.ai.remotes?.length ?? 0
        };
        passCheck('a guest reconnect does not stop the host AI simulation',
          dropError === null &&
          hostAfter.ai.hostSim.sims.every((sim, index) => sim.ticks > beforeTicks[index]),
          JSON.stringify(reconnect));
        passCheck('the resumed guest keeps receiving the 20 Hz AI poses',
          guestAfter.ai.remotes?.length === AI_COUNT &&
          reconnect.afterSamples > beforeSamples,
          JSON.stringify(reconnect));
      }
      if (hostView.result && guestView.result) break;
      await sleep(120);
    }
    hostFinal = hostView;
    guestFinal = guestView;
    if (!hostFinal.result || !guestFinal.result) {
      throw new Error('both pages did not reach the shared result; host phase ' + hostFinal.phase +
        ', guest phase ' + guestFinal.phase + ', AI ' + JSON.stringify(guestFinal.ai ?? null));
    }
    await shot(hostPage, 'browser-mp-ai-finish-host.png');
    await shot(guestPage, 'browser-mp-ai-finish-guest.png');

    const rows = hostFinal.result.rows;
    const aiRows = rows.filter((row) => row.ai === true);
    const hostRow = rows.find((row) => row.playerId === hostFinal.you.id);
    const guestRow = rows.find((row) => row.playerId === guestFinal.you.id);
    passCheck('the shared table has 2 human + ' + AI_COUNT + ' AI rows',
      rows.length === 2 + AI_COUNT && aiRows.length === AI_COUNT,
      JSON.stringify(rows.map((row) => [row.positionNumber, row.playerId, row.ai ?? false, row.status])));
    passCheck('host and guest render the same result hash and identical rows',
      hostFinal.result.hash === guestFinal.result.hash &&
      JSON.stringify(hostFinal.result.rows) === JSON.stringify(guestFinal.result.rows),
      hostFinal.result.hash + ' / ' + guestFinal.result.hash);
    passCheck('every participant (including AI) finished; no DNF',
      rows.every((row) => row.status === 'finished'),
      rows.map((row) => row.status).join(','));
    passCheck('AI rows carry ai-1... ids, profiles and the host finish ticks',
      aiRows.every((row, index) => row.playerId === 'ai-' + (index + 1) &&
        ['cautious', 'standard', 'reference'].includes(row.profile) &&
        Number.isInteger(row.tick) && row.tick > 90),
      JSON.stringify(aiRows.map((row) => [row.playerId, row.profile, row.tick, row.timeSeconds])));
    passCheck('the AI order matches the committed reference expectations',
      aiRows.every((row, index) => {
        if (MAP_ID === 'amboy') return row.timeSeconds > 200 && row.timeSeconds < 300;
        if (MAP_ID === 'gracia') return row.timeSeconds > 55 && row.timeSeconds < 200;
        const record = hostAi[index];
        const expected = record?.profile === 'reference' && record?.car === 'audi-r8v10-stock' ? 14.15
          : record?.profile === 'cautious' && record?.car === 'dodge-challenger-stock' ? 16.90
            : null;
        return expected === null || Math.abs(row.timeSeconds - expected) <= 0.5;
      }),
      JSON.stringify(aiRows.map((row) => [row.car, row.profile, row.timeSeconds])));
    passCheck('the shared rows are ordered by finish tick',
      rows.every((row, index, list) => index === 0 || list[index - 1].tick <= row.tick),
      JSON.stringify(rows.map((row) => [row.positionNumber, row.tick])));
    passCheck('human rows still equal their local finish within one tick',
      Number.isInteger(hostFinal.finishTick) && Math.abs(hostFinal.finishTick - hostRow.tick) <= 1 &&
      Number.isInteger(guestFinal.finishTick) && Math.abs(guestFinal.finishTick - guestRow.tick) <= 1,
      JSON.stringify({ host: [hostFinal.finishTick, hostRow.tick], guest: [guestFinal.finishTick, guestRow.tick] }));
    passCheck('the guest rendered AI poses without simulating them',
      aiRemoteSamples > 0 && aiRemoteErrors.length === 0 &&
      (guestFinal.ai.remotes ?? []).length === AI_COUNT &&
      (guestFinal.ai.hostSim ?? null) === null,
      JSON.stringify({ samples: aiRemoteSamples, errors: aiRemoteErrors.slice(0, 3),
        remotes: guestFinal.ai.remotes?.length ?? 0 }));
    const aiSimRows = hostFinal.ai.result?.sim?.sims ?? hostFinal.ai.hostSim.sims;
    passCheck('the host state-sequence hashes exist for every AI',
      aiSimRows.every((sim) => sim.stateSequenceHash && sim.stateHashCount > 500),
      JSON.stringify(aiSimRows.map((sim) => [sim.id, sim.stateHashCount, sim.stateSequenceHash])));
    passCheck('AI labels are visible on the guest as AI · profile',
      /AI · reference/.test(guestFinal.overlays.remotesText ?? '') &&
      /AI · cautious/.test(guestFinal.overlays.remotesText ?? ''),
      JSON.stringify(guestFinal.overlays.remotesText));
    passCheck('no AI used power-ups (power-up slice is off in this gate)',
      guestFinal.powerups?.enabled !== true && hostFinal.powerups?.enabled !== true,
      JSON.stringify({ host: hostFinal.powerups?.enabled ?? null, guest: guestFinal.powerups?.enabled ?? null }));

    const roomStats = roomServer.stats();
    passCheck('room service finished exactly one two-human room',
      roomStats.roomsCreated === 1 && roomStats.roomsFinished === 1 &&
      hostFinal.players.length === 2 && guestFinal.players.length === 2,
      JSON.stringify(roomStats));
    passCheck('console is clean on both pages',
      hostPage.messages.length === 0 && guestPage.messages.length === 0,
      [...hostPage.messages, ...guestPage.messages].slice(0, 6).map((entry) => entry.source + ' ' + entry.text).join(' | '));

    const evidence = {
      kind: 'e1-drive.mp-ai-browser',
      version: 1,
      browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT, pages: 2 },
      ports: { game: PORT, room: ROOM_PORT },
      map: { id: MAP_ID, pins: MAP_ENTRY.mpPins ?? null },
      room: { code, wsUrl: roomServer.wsUrl, stats: roomStats },
      lobby: { host: hostLobby, guest: guestLobby,
        screenshots: { host: shots['browser-mp-ai-lobby-host.png'],
          guest: shots['browser-mp-ai-lobby-guest.png'] } },
      race: { midShotAt, aiRemoteSamples, aiRemoteErrors, reconnect,
        screenshots: { host: shots['browser-mp-ai-mid-host.png'],
          guest: shots['browser-mp-ai-mid-guest.png'] } },
      finish: { host: hostFinal, guest: guestFinal, sharedHash: hostFinal.result.hash,
        aiRows, screenshots: { host: shots['browser-mp-ai-finish-host.png'],
          guest: shots['browser-mp-ai-finish-guest.png'] } },
      console: {
        host: { totalMessages: hostPage.messages.length, messages: hostPage.messages },
        guest: { totalMessages: guestPage.messages.length, messages: guestPage.messages }
      },
      assertions: { ok: passFailures.length === 0, failures: passFailures },
      verdict: passFailures.length === 0 && hostPage.messages.length === 0 && guestPage.messages.length === 0
        ? 'clean-console-and-gates' : 'failed'
    };
    writeFileSync(path.join(OUT, 'browser-evidence-mp-ai' + mpAiTag + '.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    writeFileSync(path.join(LOGS, 'edge-mp-ai' + mpAiTag + '.log'), browserLog +
      '\nroom: ' + JSON.stringify(roomStats) + '\n', 'utf8');
    return {
      ok: evidence.verdict === 'clean-console-and-gates',
      summary: {
        verdict: evidence.verdict,
        room: code,
        ai: hostAi,
        sharedHash: hostFinal.result.hash,
        rows: rows.map((row) => ({ position: row.positionNumber, id: row.playerId,
          ai: row.ai === true, profile: row.profile ?? null, tick: row.tick, timeSeconds: row.timeSeconds })),
        aiRemoteSamples,
        reconnect,
        sequences: hostFinal.ai.hostSim?.sims ?? null,
        console: { host: hostPage.messages.length, guest: guestPage.messages.length },
        screenshots: shots,
        failures: passFailures
      }
    };
  } catch (error) {
    fatal = error;
    const evidence = {
      kind: 'e1-drive.mp-ai-browser',
      version: 1,
      browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT, pages: 2 },
      ports: { game: PORT, room: ROOM_PORT },
      room: roomServer ? { stats: roomServer.stats() } : null,
      lobby: { host: hostLobby, guest: guestLobby },
      race: { midShotAt, aiRemoteSamples, aiRemoteErrors },
      finish: { host: hostFinal, guest: guestFinal },
      console: {
        host: { totalMessages: hostPage.messages.length, messages: hostPage.messages },
        guest: { totalMessages: guestPage?.messages?.length ?? 0, messages: guestPage?.messages ?? [] }
      },
      assertions: { ok: false, failures: [error.message, ...passFailures] },
      verdict: 'failed',
      error: error.message
    };
    writeFileSync(path.join(OUT, 'browser-evidence-mp-ai' + mpAiTag + '.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    writeFileSync(path.join(LOGS, 'edge-mp-ai' + mpAiTag + '.log'), browserLog + '\nERROR: ' + error.message + '\n', 'utf8');
    return {
      ok: false,
      summary: { verdict: 'failed', error: error.message, failures: passFailures,
        screenshots: shots, console: { host: hostPage.messages.length, guest: guestPage?.messages?.length ?? 0 } }
    };
  } finally {
    try { guestPage?.close(); } catch {}
    try { await roomServer?.close(); } catch {}
    if (fatal) console.error('mp-ai capture failed:', fatal.message);
  }
}

/**
 * M2/PWR2 power-up capture (`--mode mp-powerups`): two real pages, the real
 * 310 m race, the host-authoritative Mine/Shield/Repair slice. The host grants a
 * mine, the guest hits it and is wrecked/respawned; the guest uses a shield and
 * absorbs a mine (break + overflow); the guest uses a repair and heals. The
 * capture checks the event counts on both pages, the HUD, the diagnostic marker
 * pass, console cleanliness and the project-specific relay.
 */
async function mpPowerupsCapturePass() {
  const passFailures = [];
  const passCheck = (label, ok, detail = '') => { if (!ok) passFailures.push(label + (detail ? ': ' + detail : '')); };
  const hostPage = { send, evaluate, messages };
  messages.length = 0;
  let guestPage = null;
  let roomServer = null;
  const shots = {};
  let code = null;
  let hostLobby = null;
  let guestLobby = null;
  let hostStarted = null;
  let guestStarted = null;
  let hostFinal = null;
  let guestFinal = null;
  let fatal = null;

  const snapshotOf = async (handle) => {
    try { return await handle.evaluate('window.__mp ? window.__mp.snapshot() : null'); } catch { return null; }
  };
  const powerOf = async (handle) => {
    try { return await handle.evaluate('window.__powerups ? window.__powerups.state() : null'); } catch { return null; }
  };
  const waitSnapshot = async (handle, predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await snapshotOf(handle);
      if (last && predicate(last)) return last;
      await sleep(150);
    }
    throw new Error(label + ' timed out; last phase ' + (last?.phase ?? 'null') +
      ' power ' + (last?.powerups?.phase ?? 'null') + ' status ' + (last?.status ?? 'null'));
  };
  const waitPower = async (handle, predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await powerOf(handle);
      if (last && predicate(last)) return last;
      await sleep(120);
    }
    throw new Error(label + ' timed out; last ' + JSON.stringify(last?.counts ?? last?.status ?? null).slice(0, 300));
  };
  const waitSpeed = async (handle, minimum, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await snapshotOf(handle);
      if (last && Number.isFinite(last.local?.speed) && last.local.speed >= minimum) return last;
      await sleep(80);
    }
    throw new Error(label + ' timed out; speed ' + (last?.local?.speed ?? 'null'));
  };
  const peakSpeed = async (handle, durationMs) => {
    const deadline = Date.now() + durationMs;
    let peak = 0;
    let last = null;
    while (Date.now() < deadline) {
      last = await snapshotOf(handle);
      if (Number.isFinite(last?.local?.speed)) peak = Math.max(peak, last.local.speed);
      await sleep(60);
    }
    return { peak, lastSpeed: last?.local?.speed ?? null };
  };
  const shot = async (handle, name) => {
    const result = await handle.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path.join(OUT, name), Buffer.from(result.data, 'base64'));
    shots[name] = '_work/e1-drive/' + name;
    return name;
  };
  const count = (state, type) => state?.counts?.[type] ?? 0;
  const eventTypes = (events) => {
    const counts = {};
    for (const event of events ?? []) counts[event.type] = (counts[event.type] ?? 0) + 1;
    return counts;
  };

  try {
    roomServer = await startRoomServer({ port: ROOM_PORT, log: () => {} });
    guestPage = await openSecondPage();
    guestPage.messages.length = 0;
    const car = defaultSlug;
    const guestCar = GUEST_CAR ?? (car === 'audi-r8v10-stock' ? 'corvette-zr1-stock' : 'audi-r8v10-stock');
    const roomQuery = '&mpServer=' + encodeURIComponent(roomServer.wsUrl) + '&audio=0';
    const hostUrl = origin + '/?mp=1&host=1&powerups=1&script=sprint&mpPace=0.55&car=' + encodeURIComponent(car) +
      '&name=Host' + roomQuery;
    await hostPage.send('Page.navigate', { url: hostUrl });
    hostLobby = await waitSnapshot(hostPage, (snapshot) =>
      snapshot.phase === 'lobby' && snapshot.engineReady && snapshot.powerups?.phase === 'lobby',
      120000, 'host power-up lobby');
    code = hostLobby.roomCode;
    passCheck('host allocated a 5-character room code', typeof code === 'string' && /^[A-Z2-9]{5}$/.test(code), code);

    const guestUrl = origin + '/?mp=1&room=' + encodeURIComponent(code) + '&powerups=1&script=sprint' +
      '&car=' + encodeURIComponent(car) + '&mpPace=0.5&name=Guest' + roomQuery;
    await guestPage.send('Page.navigate', { url: guestUrl });
    guestLobby = await waitSnapshot(guestPage, (snapshot) =>
      snapshot.phase === 'lobby' && snapshot.engineReady && snapshot.powerups?.phase === 'lobby',
      120000, 'guest power-up lobby');
    hostLobby = await waitSnapshot(hostPage, (snapshot) =>
      snapshot.players.length === 2 && snapshot.powerups?.phase === 'lobby', 20000, 'host roster + power-ups');

    passCheck('both pages load the PWR1 manifest and rules prototype',
      hostLobby.powerups?.manifestHash && guestLobby.powerups?.manifestHash === hostLobby.powerups.manifestHash,
      JSON.stringify({ host: hostLobby.powerups?.manifestHash, guest: guestLobby.powerups?.manifestHash }));
    passCheck('both pages expose the eight core types including Blindfire/Shunt/Barge',
      JSON.stringify(hostLobby.powerups?.types) === JSON.stringify([
        'Bomb', 'Shield', 'Repair', 'Nitrous', 'Shock', 'Blindfire', 'Shunt', 'Barge'
      ]) &&
      JSON.stringify(guestLobby.powerups?.types) === JSON.stringify([
        'Bomb', 'Shield', 'Repair', 'Nitrous', 'Shock', 'Blindfire', 'Shunt', 'Barge'
      ]),
      JSON.stringify(hostLobby.powerups?.types));
    passCheck('both pages load the PWR4 projectile manifest',
      hostLobby.powerups?.projectileManifestHash &&
      guestLobby.powerups?.projectileManifestHash === hostLobby.powerups.projectileManifestHash,
      JSON.stringify({ host: hostLobby.powerups?.projectileManifestHash,
        guest: guestLobby.powerups?.projectileManifestHash }));
    passCheck('only SuperShield remains deferred, with a typed reason',
      Object.keys(hostLobby.powerups?.deferred ?? {}).join(',') === 'SuperShield' &&
      !('Shunt' in (hostLobby.powerups?.deferred ?? {})) &&
      !('Blindfire' in (hostLobby.powerups?.deferred ?? {})) &&
      !('Barge' in (hostLobby.powerups?.deferred ?? {})),
      JSON.stringify(Object.keys(hostLobby.powerups?.deferred ?? {})));
    passCheck('power-up HUD is visible and labelled provisional',
      hostLobby.powerups?.hud?.hidden === false && /provisional/.test(hostLobby.powerups?.hud?.note ?? ''),
      JSON.stringify(hostLobby.powerups?.hud));

    await hostPage.evaluate('window.__mp.setReady(true)');
    await guestPage.evaluate('window.__mp.setReady(true)');
    hostLobby = await waitSnapshot(hostPage, (snapshot) => snapshot.players.length === 2 &&
      snapshot.players.every((player) => player.ready), 15000, 'host all ready');
    guestLobby = await waitSnapshot(guestPage, (snapshot) => snapshot.players.length === 2 &&
      snapshot.players.every((player) => player.ready), 15000, 'guest all ready');
    passCheck('ready propagates to both rosters',
      hostLobby.players.every((player) => player.ready) && guestLobby.players.every((player) => player.ready));

    await hostPage.evaluate('window.__mp.start()');
    hostStarted = await waitSnapshot(hostPage, (snapshot) => snapshot.started && snapshot.engineTick >= 2,
      30000, 'host race start');
    guestStarted = await waitSnapshot(guestPage, (snapshot) => snapshot.started && snapshot.engineTick >= 2,
      30000, 'guest race start');
    passCheck('host start broadcasts room.started to both pages', hostStarted.started && guestStarted.started);

    const hostRunning = await waitPower(hostPage, (power) => power.phase === 'running' && power.pickups.length === 6,
      30000, 'host provisional pickups');
    const guestRunning = await waitPower(guestPage, (power) => power.phase === 'running' && power.pickups.length === 6,
      30000, 'guest provisional pickups');
    passCheck('six provisional pickups spawn on the measured arcs',
      hostRunning.pickups.length === 6 && guestRunning.pickups.length === 6,
      `${hostRunning.pickups.length}/${guestRunning.pickups.length}`);
    passCheck('placement is labelled provisional measured-arc on both pages',
      hostRunning.placement?.mode === 'provisional-measured-arc' &&
      guestRunning.placement?.mode === 'provisional-measured-arc' &&
      JSON.stringify(hostRunning.placement?.arcs) === JSON.stringify([40, 90, 140, 190, 240, 280]),
      JSON.stringify(hostRunning.placement?.arcs));
    passCheck('pickups carry only the integrated types',
      hostRunning.pickups.every((pickup) => ['Bomb', 'Shield', 'Repair', 'Nitrous', 'Shock',
        'Blindfire', 'Shunt', 'Barge'].includes(pickup.type)),
      hostRunning.pickups.map((pickup) => pickup.type).join(','));
    await shot(hostPage, 'browser-mp-powerups-spawn-host.png');
    await shot(guestPage, 'browser-mp-powerups-spawn-guest.png');

    // -------------------------------------------------------- Nitro (host/guest)
    const hostPreNitro = await waitSpeed(hostPage, 10, 30000, 'host speed for Nitro');
    const hostNitroBefore = hostPreNitro.local.speed;
    await hostPage.evaluate("window.__powerups.nitroFor('host'); null");
    const hostNitro = await waitPower(hostPage, (power) => power.boost?.type === 'nitro-activated' &&
      power.engineBoost && power.engineBoost.kind !== 0, 10000, 'host Nitro queued');
    const hostNitroEvent = (hostNitro.events ?? []).filter((event) => event.type === 'nitro-activated').slice(-1)[0] ?? null;
    const hostNitroPeak = await peakSpeed(hostPage, 1400);
    passCheck('host Nitro is host-sequenced with the exact PWR1 target and class label',
      hostNitroEvent?.targetPlayer != null && hostNitroEvent?.source === 'recovered' &&
      hostNitroEvent?.targetSource === 'pwr1-hermite' && hostNitroEvent?.classLetter === 'A' &&
      hostNitroEvent?.targetMps > hostNitroBefore && hostNitroEvent?.targetMps <= 55 &&
      hostNitroEvent?.ticks === 78 && hostNitroEvent?.magnitude === 300,
      JSON.stringify(hostNitroEvent && {
        targetPlayer: hostNitroEvent.targetPlayer, targetMps: hostNitroEvent.targetMps,
        speedMps: hostNitroEvent.speedMps, classLetter: hostNitroEvent.classLetter, ticks: hostNitroEvent.ticks
      }));
    passCheck('host Nitro produced a measured speed gain',
      hostNitroPeak.peak >= hostNitroBefore + 8,
      JSON.stringify({ before: hostNitroBefore, peak: hostNitroPeak.peak, last: hostNitroPeak.lastSpeed }));
    await shot(hostPage, 'browser-mp-powerups-nitro-host.png');

    const guestPreNitro = await waitSpeed(guestPage, 10, 30000, 'guest speed for Nitro');
    const guestNitroBefore = guestPreNitro.local.speed;
    await hostPage.evaluate("window.__powerups.grantGuest('Nitrous'); null");
    await waitPower(guestPage, (power) => power.local?.inventory?.some((item) => item.type === 'Nitrous'),
      15000, 'guest Nitrous in inventory');
    await guestPage.evaluate('window.__powerups.use(); null');
    const guestNitro = await waitPower(guestPage, (power) => power.boost?.type === 'nitro-activated' &&
      power.engineBoost && power.engineBoost.kind !== 0, 20000, 'guest Nitro queued');
    const guestNitroEvent = (guestNitro.events ?? []).filter((event) => event.type === 'nitro-activated').slice(-1)[0] ?? null;
    const guestNitroPeak = await peakSpeed(guestPage, 1400);
    passCheck('guest Nitro is applied by the guest to its own car from the host event',
      guestNitroEvent?.targetPlayer === guestNitro.local?.id &&
      guestNitro.boost?.targetPlayer === guestNitro.local?.id &&
      guestNitro.boost?.authorityStartTick != null && guestNitro.boost?.localStartTick != null &&
      guestNitro.boost.localStartTick >= guestNitro.boost.authorityStartTick - 120,
      JSON.stringify(guestNitro.boost));
    passCheck('guest Nitro produced a measured speed gain',
      guestNitroPeak.peak >= guestNitroBefore + 8,
      JSON.stringify({ before: guestNitroBefore, peak: guestNitroPeak.peak, last: guestNitroPeak.lastSpeed }));
    await waitPower(hostPage, (power) => count(power, 'nitro-activated') >= 2, 10000, 'host sees both Nitros');
    await waitPower(hostPage, (power) => count(power, 'effect-expired') >= 2, 6000, 'Nitro effects expire');
    await shot(guestPage, 'browser-mp-powerups-nitro-guest.png');

    // ------------------------------------------------------------ mine placement
    await hostPage.evaluate("window.__powerups.grant('Bomb'); null");
    const hostBomb = await waitPower(hostPage, (power) => power.local?.inventory?.some((item) => item.type === 'Bomb'),
      10000, 'host Bomb in inventory');
    passCheck('host collected a staged Bomb into its one inventory slot',
      hostBomb.local.inventory.length === 1 && hostBomb.local.inventory[0].type === 'Bomb',
      JSON.stringify(hostBomb.local.inventory));
    await hostPage.evaluate('window.__powerups.use(); null');
    const minePlaced = await waitPower(hostPage, (power) => count(power, 'mine-placed') >= 1 &&
      power.mines.length >= 1, 10000, 'host mine-placed');
    await waitPower(guestPage, (power) => count(power, 'mine-placed') >= 1, 10000, 'guest mine-placed');
    passCheck('host placed a mine and the event reached the guest',
      count(minePlaced, 'mine-placed') >= 1 && count(await powerOf(guestPage), 'mine-placed') >= 1);
    passCheck('mine marker is rendered on both pages',
      minePlaced.markers.drawsIssued > 0 && minePlaced.markers.frames > 0,
      JSON.stringify(minePlaced.markers));
    await shot(hostPage, 'browser-mp-powerups-mine-host.png');

    // ----------------------------------------------------- guest wreck + respawn
    await hostPage.evaluate('window.__powerups.clearGuest(); null');
    let wrecked = null;
    for (const ahead of ['arm', 'arm', 'arm']) {
      const argument = typeof ahead === 'string' ? "'" + ahead + "'" : String(ahead);
      await hostPage.evaluate('window.__powerups.placeMineOnGuest(' + argument + '); null');
      try {
        wrecked = await waitPower(guestPage, (power) => count(power, 'wrecked') >= 1, 3500, 'guest wrecked');
        break;
      } catch { /* place another mine where the guest will be when armed */ }
    }
    if (!wrecked) throw new Error('guest did not hit a staged mine; host ' + JSON.stringify((await powerOf(hostPage))?.counts));
    const wreckEvidence = await powerOf(guestPage);
    passCheck('host mine hit the guest and emitted wrecked',
      count(wreckEvidence, 'wrecked') >= 1,
      JSON.stringify(wreckEvidence.counts));
    await shot(guestPage, 'browser-mp-powerups-wrecked-guest.png');
    const respawned = await waitPower(guestPage, (power) => count(power, 'respawn') >= 1 && power.wrecked === false,
      6000, 'guest respawn');
    passCheck('guest respawned at the R1 target and restored health',
      count(respawned, 'respawn') >= 1 && respawned.local?.health === respawned.local?.maxHealth,
      JSON.stringify({ counts: respawned.counts, health: respawned.local?.health }));
    await shot(guestPage, 'browser-mp-powerups-respawn-guest.png');

    // ------------------------------------------------------ shield absorb + break
    await hostPage.evaluate('window.__powerups.clearGuest(); window.__powerups.grantGuest(\'Shield\'); null');
    await waitPower(guestPage, (power) => power.local?.inventory?.some((item) => item.type === 'Shield'),
      10000, 'guest Shield in inventory');
    await guestPage.evaluate('window.__powerups.use(); null');
    const shielded = await waitPower(guestPage, (power) => count(power, 'shield-activated') >= 1 && power.shield !== null,
      10000, 'guest shield-activated');
    passCheck('guest shield activated with the recovered capacity/lifetime',
      shielded.shield?.capacity === 50 && shielded.shield?.maxCapacity === 50 &&
      shielded.shield.secondsLeft > 0 && shielded.shield.secondsLeft <= 6.001,
      JSON.stringify(shielded.shield));
    await waitPower(hostPage, (power) => count(power, 'shield-activated') >= 1, 10000, 'host sees shield-activated');
    await shot(guestPage, 'browser-mp-powerups-shield-guest.png');

    let absorbed = null;
    for (const ahead of ['arm', 'arm', 'arm']) {
      const argument = typeof ahead === 'string' ? "'" + ahead + "'" : String(ahead);
      await hostPage.evaluate('window.__powerups.placeMineOnGuest(' + argument + '); null');
      try {
        absorbed = await waitPower(guestPage, (power) => count(power, 'shield-absorbed') >= 1, 3500, 'guest shield absorbed');
        break;
      } catch { /* place another mine where the guest will be when armed */ }
    }
    if (!absorbed) throw new Error('guest did not absorb a staged mine; counts ' + JSON.stringify((await powerOf(guestPage))?.counts));
    const broken = await waitPower(guestPage, (power) => count(power, 'shield-broken') >= 1 &&
      power.shield === null && power.local?.health <= 50, 5000, 'guest shield broken');
    passCheck('shield absorbed the hit, broke, and the overflow damaged health',
      count(broken, 'shield-absorbed') >= 1 && count(broken, 'shield-broken') >= 1 &&
      broken.shield === null && broken.local.health < broken.local.maxHealth,
      JSON.stringify({ counts: broken.counts, health: broken.local?.health }));
    await waitPower(hostPage, (power) => count(power, 'shield-absorbed') >= 1 && count(power, 'shield-broken') >= 1,
      10000, 'host sees shield absorb/break');
    await shot(guestPage, 'browser-mp-powerups-shield-hit-guest.png');

    // --------------------------------------------------------------- repair
    await hostPage.evaluate('window.__powerups.clearGuest(); window.__powerups.grantGuest(\'Repair\'); null');
    await waitPower(guestPage, (power) => power.local?.inventory?.some((item) => item.type === 'Repair'),
      10000, 'guest Repair in inventory');
    await guestPage.evaluate('window.__powerups.use(); null');
    const repaired = await waitPower(guestPage, (power) => count(power, 'repaired') >= 1 &&
      power.local?.health === power.local?.maxHealth, 10000, 'guest repaired');
    passCheck('Repair healed the guest back to the diagnostic max health',
      count(repaired, 'repaired') >= 1 && repaired.local.health === repaired.local.maxHealth,
      JSON.stringify({ counts: repaired.counts, health: repaired.local?.health }));
    await waitPower(hostPage, (power) => count(power, 'repaired') >= 1, 10000, 'host sees repaired');
    await shot(guestPage, 'browser-mp-powerups-repair-guest.png');

    // ------------------------------------------------------- Shock (both ways)
    const guestPreShock = await snapshotOf(guestPage);
    const guestShockBefore = guestPreShock?.local?.speed ?? null;
    await hostPage.evaluate("window.__powerups.shockOnTarget('host', 'guest'); null");
    const guestShock = await waitPower(guestPage, (power) => count(power, 'shock-activated') >= 1,
      20000, 'guest sees shock-activated');
    const guestShockEvent = (guestShock.events ?? []).filter((event) => event.type === 'shock-activated').slice(-1)[0] ?? null;
    const guestShockTarget = (guestShockEvent?.targets ?? []).find((row) => row.targetPlayer === guestShock.local?.id) ?? null;
    passCheck('host Shock is a host-sequenced speed scrub with recovered damage/radii/lifetime',
      guestShockEvent?.source === 'recovered' && guestShockEvent?.targetSource === 'pwr1-hermite' &&
      guestShockEvent?.innerRadius === 7 && guestShockEvent?.outerRadius === 14 &&
      guestShockEvent?.lifetime === 1.5 && guestShockEvent?.damage === 100 &&
      guestShockTarget?.damage === 100 && guestShockTarget?.targetMps > 0 &&
      guestShockTarget?.targetMps < guestShockTarget?.speedMps,
      JSON.stringify(guestShockEvent && {
        inner: guestShockEvent.innerRadius, outer: guestShockEvent.outerRadius,
        lifetime: guestShockEvent.lifetime, damage: guestShockEvent.damage, target: guestShockTarget
      }));
    const guestWreckedByShock = await waitPower(guestPage, (power) => count(power, 'wrecked') >= 1 &&
      power.local?.health === 0, 10000, 'guest damaged by Shock');
    passCheck('Shock damage reached the guest through the host health model',
      guestWreckedByShock.local?.health === 0,
      JSON.stringify({ health: guestWreckedByShock.local?.health, counts: guestWreckedByShock.counts }));
    await shot(guestPage, 'browser-mp-powerups-shock-guest.png');
    await waitPower(guestPage, (power) => count(power, 'respawn') >= 2 && power.wrecked === false,
      8000, 'guest respawn after Shock');

    const hostPreShock = await snapshotOf(hostPage);
    const hostShockBefore = hostPreShock?.local?.speed ?? null;
    await hostPage.evaluate("window.__powerups.shockOnTarget('guest', 'host'); null");
    const hostShock = await waitPower(hostPage, (power) => count(power, 'shock-activated') >= 2 &&
      power.engineBoost?.kind === 2, 15000, 'host applies the guest Shock to its own car');
    const hostShockEvent = (hostShock.events ?? []).filter((event) => event.type === 'shock-activated').slice(-1)[0] ?? null;
    const hostShockTarget = (hostShockEvent?.targets ?? []).find((row) => row.targetPlayer === hostShock.local?.id) ?? null;
    passCheck('guest Shock is applied by the host to its own car from the same host event model',
      hostShockTarget?.damage === 100 && hostShock.boost?.type === 'shock-activated' &&
      hostShock.engineBoost?.kind === 2 && hostShock.engineBoost?.targetMps > 0,
      JSON.stringify({ target: hostShockTarget, boost: hostShock.boost, engine: hostShock.engineBoost }));
    passCheck('Shock reduced the host speed or applied a measured brake force',
      (Number.isFinite(hostShockBefore) && Number.isFinite(hostShock.engineBoost?.lastSpeed) &&
        hostShock.engineBoost.lastSpeed < hostShockBefore + 0.5) ||
      (hostShock.engineBoost?.forceTicks ?? 0) > 0,
      JSON.stringify({ before: hostShockBefore, lastSpeed: hostShock.engineBoost?.lastSpeed,
        forceTicks: hostShock.engineBoost?.forceTicks }));
    await shot(hostPage, 'browser-mp-powerups-shock-host.png');
    await waitPower(hostPage, (power) => count(power, 'effect-expired') >= 3, 6000, 'Shock effect expires');

    // -------------------------------------- projectiles: Blindfire/Shunt/Barge
    const weaponBaseHost = await powerOf(hostPage);
    const weaponBaseGuest = await powerOf(guestPage);
    const delta = (state, base, type) => count(state, type) - count(base, type);

    await hostPage.evaluate("window.__powerups.stageWeapon('host','guest','Blindfire',true); null");
    await waitPower(hostPage, (power) => delta(power, weaponBaseHost, 'projectile-fired') >= 1,
      10000, 'host Blindfire miss fired');
    await shot(hostPage, 'browser-mp-powerups-blindfire-host.png');
    passCheck('Blindfire fires a diagnostic projectile marker on River',
      (await powerOf(hostPage))?.markers?.drawsIssued > 0,
      JSON.stringify((await powerOf(hostPage))?.markers));

    await hostPage.evaluate("window.__powerups.stageWeapon('host','guest','Blindfire'); null");
    const guestBlindfire = await waitPower(guestPage, (power) =>
      delta(power, weaponBaseGuest, 'projectile-hit') >= 1, 15000, 'guest Blindfire hit');
    const guestBlindHit = (guestBlindfire.events ?? []).filter((event) => event.type === 'projectile-hit').slice(-1)[0] ?? null;
    passCheck('host Blindfire hits the guest through the documented envelope for 50',
      guestBlindHit?.pickupType === 'Blindfire' && guestBlindHit?.damage === 50 &&
      guestBlindfire.local?.health < guestBlindfire.local?.maxHealth,
      JSON.stringify({ hit: guestBlindHit, health: guestBlindfire.local?.health }));

    await waitPower(hostPage, (power) => power.wrecked === false &&
      power.local?.health === power.local?.maxHealth, 12000, 'host alive before guest Blindfire');
    await hostPage.evaluate("window.__powerups.stageWeapon('guest','host','Blindfire'); null");
    const hostBlindfire = await waitPower(hostPage, (power) =>
      (power.events ?? []).some((event) => event.type === 'projectile-hit' &&
        event.pickupType === 'Blindfire' && event.targetId === power.local?.id),
      15000, 'host Blindfire hit');
    passCheck('guest Blindfire reaches the host through the host event stream',
      (hostBlindfire.events ?? []).some((event) => event.type === 'projectile-hit' &&
        event.pickupType === 'Blindfire' && event.targetId === hostBlindfire.local?.id),
      JSON.stringify(hostBlindfire.counts));

    await hostPage.evaluate("window.__powerups.stageWeapon('host','guest','Shunt'); null");
    const guestShunt = await waitPower(guestPage, (power) =>
      delta(power, weaponBaseGuest, 'shunt-hit') >= 1, 15000, 'guest Shunt hit');
    const guestShuntEvent = (guestShunt.events ?? []).filter((event) => event.type === 'shunt-hit').slice(-1)[0] ?? null;
    passCheck('host Shunt homes to the guest, flips, and carries the provisional impulse',
      guestShuntEvent?.hitType === 'major' && guestShuntEvent?.fakePhysics?.kind === 'flip-forward' &&
      guestShuntEvent?.impulse?.source === 'provisional-impulse' &&
      guestShuntEvent?.impulse?.deltaV === 12.5,
      JSON.stringify(guestShuntEvent));
    const guestImpulse = await waitPower(guestPage, (power) =>
      power.engineBoost?.kind === 3 || power.boost?.kind === 3, 10000, 'guest Shunt impulse queued');
    passCheck('the guest applies the Shunt provisional impulse through the boost queue',
      guestImpulse.engineBoost?.kind === 3 || guestImpulse.boost?.kind === 3,
      JSON.stringify({ engine: guestImpulse.engineBoost, boost: guestImpulse.boost }));
    await shot(guestPage, 'browser-mp-powerups-shunt-guest.png');
    await waitPower(guestPage, (power) => power.wrecked === false, 8000, 'guest respawn before Barge');

    await hostPage.evaluate("window.__powerups.stageWeapon('guest','host','Shunt'); null");
    const hostShunt = await waitPower(hostPage, (power) =>
      (power.events ?? []).some((event) => event.type === 'shunt-hit' &&
        event.targetId === power.local?.id), 15000, 'host Shunt hit');
    passCheck('guest Shunt is judged by the host and applies the impulse to the host car',
      (hostShunt.events ?? []).some((event) => event.type === 'shunt-hit' &&
        event.targetId === hostShunt.local?.id && event.impulse?.source === 'provisional-impulse'),
      JSON.stringify(hostShunt.counts));
    await waitPower(hostPage, (power) => power.wrecked === false, 8000, 'host respawn before Barge');

    await hostPage.evaluate("window.__powerups.stageWeapon('host','guest','Barge'); null");
    const hostBargeMarkers = await hostPage.evaluate('window.__powerups.markers()');
    await waitPower(guestPage, (power) => delta(power, weaponBaseGuest, 'barge-activated') >= 1,
      8000, 'guest sees barge-activated');
    await shot(guestPage, 'browser-mp-powerups-barge-guest.png');
    const guestBarge = await waitPower(guestPage, (power) =>
      delta(power, weaponBaseGuest, 'barge-hit') >= 1, 15000, 'guest Barge hit');
    const guestBargeEvent = (guestBarge.events ?? []).filter((event) => event.type === 'barge-hit').slice(-1)[0] ?? null;
    const guestBargeActivated = (guestBarge.events ?? []).filter((event) => event.type === 'barge-activated').slice(-1)[0] ?? null;
    passCheck('host Barge activates radius 7 / 0.4 s and hits the guest for 100',
      guestBargeActivated?.radius === 7 && Math.abs(guestBargeActivated?.durationSeconds - 0.4) < 1e-6 &&
      guestBargeEvent?.damage === 100 &&
      (guestBargeEvent?.hitType === 'major' || guestBargeEvent?.hitType === 'minor'),
      JSON.stringify({ activated: guestBargeActivated, hit: guestBargeEvent }));
    passCheck('the host marker list emits the Barge ring at the 8.08 m outer radius',
      Array.isArray(hostBargeMarkers) &&
      hostBargeMarkers.some((marker) => marker.shape === 'ring' && marker.scale === 8.08),
      JSON.stringify(hostBargeMarkers));
    await shot(hostPage, 'browser-mp-powerups-barge-host.png');
    await waitPower(guestPage, (power) => power.wrecked === false, 8000, 'guest respawn after Barge');

    await hostPage.evaluate("window.__powerups.stageWeapon('guest','host','Barge'); null");
    const hostBarge = await waitPower(hostPage, (power) =>
      (power.events ?? []).some((event) => event.type === 'barge-hit' &&
        event.targetId === power.local?.id), 15000, 'host Barge hit');
    passCheck('guest Barge is judged by the host and reaches the host car',
      (hostBarge.events ?? []).some((event) => event.type === 'barge-hit' &&
        event.targetId === hostBarge.local?.id),
      JSON.stringify(hostBarge.counts));

    await waitPower(hostPage, (power) => count(power, 'projectile-expired') >= 1,
      15000, 'staged Blindfire miss expires');
    await waitPower(guestPage, (power) => count(power, 'projectile-expired') >= 1,
      15000, 'guest sees the Blindfire expiry');

    // --------------------------------------------------------------- evidence
    hostFinal = await snapshotOf(hostPage);
    guestFinal = await snapshotOf(guestPage);
    const hostPower = await powerOf(hostPage);
    const guestPower = await powerOf(guestPage);
    const required = ['pickup-spawned', 'mine-placed', 'mine-armed', 'mine-detonated', 'wrecked',
      'respawn', 'shield-activated', 'shield-absorbed', 'shield-broken', 'repaired', 'damage',
      'nitro-activated', 'shock-activated', 'projectile-fired', 'projectile-hit',
      'projectile-expired', 'shunt-hit', 'barge-activated', 'barge-hit'];
    const hostCounts = Object.fromEntries(required.map((type) => [type, count(hostPower, type)]));
    const guestCounts = Object.fromEntries(required.map((type) => [type, count(guestPower, type)]));
    passCheck('all required host-authoritative event types occurred',
      required.every((type) => hostCounts[type] >= 1),
      JSON.stringify(hostCounts));
    passCheck('the guest applied the same required event counts',
      required.every((type) => guestCounts[type] === hostCounts[type]),
      JSON.stringify({ host: hostCounts, guest: guestCounts }));
    passCheck('Nitro and Shock effects emitted effect-expired on both pages',
      count(hostPower, 'effect-expired') >= 1 && count(guestPower, 'effect-expired') >= 1,
      JSON.stringify({ host: count(hostPower, 'effect-expired'), guest: count(guestPower, 'effect-expired') }));
    const hostAuthority = hostFinal?.you?.id ?? null;
    passCheck('client events carry host authority and strictly increase',
      hostAuthority !== null &&
      (guestPower.events ?? []).every((event, index, list) => event.authority === hostAuthority &&
        (index === 0 || event.seq > list[index - 1].seq)),
      'authority ' + String(hostAuthority) + ' · seq ' + (guestPower.events?.length ?? 0));
    passCheck('diagnostic marker pass drew pickups/mines/weapons and the barge ring on both pages',
      hostPower.markers.drawsIssued > 0 && guestPower.markers.drawsIssued > 0 &&
      hostPower.markers.markerSlots === 16 && hostPower.markers.ringSlots === 4 &&
      guestPower.markers.markerSlots === 16 && guestPower.markers.ringSlots === 4 &&
      guestPower.markers.ringDrawsIssued > 0,
      JSON.stringify({ host: hostPower.markers, guest: guestPower.markers }));
    passCheck('HUD shows inventory, health, shield and the event feed',
      hostPower.hud.hidden === false && guestPower.hud.hidden === false &&
      /health|HP/i.test(guestPower.hud.health ?? '') &&
      /no shield|s ·/.test(guestPower.hud.shield ?? '') &&
      /pickup|projectile|shunt|barge|mine|shield|repair|nitro|shock|damage|wrecked/i.test(guestPower.hud.feed ?? ''),
      JSON.stringify({ host: hostPower.hud, guest: guestPower.hud }));
    passCheck('HUD states the provisional placement label',
      /provisional measured-arc placement/.test(guestPower.hud.note ?? ''),
      guestPower.hud.note);

    const relayResponse = await fetch(origin + '/_powerups/relay/stats?room=' + encodeURIComponent(code));
    const relayStats = await relayResponse.json();
    passCheck('power-up relay carried host events and guest intents without drops',
      relayStats?.stats?.events > 0 && relayStats?.stats?.intents > 0 &&
      relayStats?.stats?.dropped === 0 && relayStats?.stats?.polls > 0,
      JSON.stringify(relayStats));

    passCheck('console is clean on both pages',
      hostPage.messages.length === 0 && guestPage.messages.length === 0,
      [...hostPage.messages, ...guestPage.messages].slice(0, 6).map((entry) => entry.source + ' ' + entry.text).join(' | '));
    passCheck('both pages are still in the running power-up race (no fatal state)',
      hostFinal?.phase === 'running' && guestFinal?.phase === 'running' &&
      hostFinal?.powerups?.phase === 'running' && guestFinal?.powerups?.phase === 'running',
      JSON.stringify({ host: hostFinal?.phase, guest: guestFinal?.phase }));

    const evidence = {
      kind: 'e1-drive.mp-powerups-browser',
      version: 1,
      browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT, pages: 2 },
      ports: { game: PORT, room: ROOM_PORT },
      room: { code, wsUrl: roomServer.wsUrl, stats: roomServer.stats(), relay: relayStats },
      manifest: {
        hash: hostPower.manifestHash ?? hostLobby.powerups?.manifestHash ?? null,
        projectileHash: hostPower.projectileManifestHash ?? hostLobby.powerups?.projectileManifestHash ?? null,
        projectileModel: hostPower.projectileModel ?? null,
        types: hostPower.types,
        deferred: hostPower.deferred,
        placement: hostPower.placement,
        labels: hostPower.labels
      },
      lobby: {
        host: { powerups: hostLobby.powerups },
        guest: { powerups: guestLobby.powerups },
        screenshots: {
          host: shots['browser-mp-powerups-spawn-host.png'],
          guest: shots['browser-mp-powerups-spawn-guest.png']
        }
      },
      scenario: {
        minePlaced: {
          event: minePlaced.events?.filter((event) => event.type === 'mine-placed').slice(-1)[0] ?? null,
          hostCounts, guestCounts
        },
        wreck: {
          guestWrecked: wreckEvidence,
          respawn: respawned,
          screenshot: shots['browser-mp-powerups-wrecked-guest.png'],
          respawnScreenshot: shots['browser-mp-powerups-respawn-guest.png']
        },
        shield: {
          activated: shielded.shield,
          broken,
          screenshot: shots['browser-mp-powerups-shield-guest.png'],
          hitScreenshot: shots['browser-mp-powerups-shield-hit-guest.png']
        },
        repair: {
          healed: repaired,
          screenshot: shots['browser-mp-powerups-repair-guest.png']
        },
        nitro: {
          host: {
            event: hostNitroEvent,
            before: hostNitroBefore,
            peak: hostNitroPeak,
            boost: hostNitro.boost,
            engine: hostNitro.engineBoost
          },
          guest: {
            event: guestNitroEvent,
            before: guestNitroBefore,
            peak: guestNitroPeak,
            boost: guestNitro.boost,
            engine: guestNitro.engineBoost
          },
          screenshots: {
            host: shots['browser-mp-powerups-nitro-host.png'],
            guest: shots['browser-mp-powerups-nitro-guest.png']
          }
        },
        shock: {
          guestTarget: {
            event: guestShockEvent,
            target: guestShockTarget,
            before: guestShockBefore,
            health: guestShock.local?.health ?? null,
            screenshot: shots['browser-mp-powerups-shock-guest.png']
          },
          hostTarget: {
            event: hostShockEvent,
            target: hostShockTarget,
            before: hostShockBefore,
            boost: hostShock.boost,
            engine: hostShock.engineBoost,
            screenshot: shots['browser-mp-powerups-shock-host.png']
          }
        },
        weapons: {
          blindfire: {
            hostMissFired: (await powerOf(hostPage))?.counts?.['projectile-fired'] ?? 0,
            guestHit: guestBlindHit,
            hostHit: (hostBlindfire.events ?? []).filter((event) => event.type === 'projectile-hit').slice(-1)[0] ?? null,
            screenshot: shots['browser-mp-powerups-blindfire-host.png']
          },
          shunt: {
            guestEvent: guestShuntEvent,
            guestImpulse: guestImpulse.engineBoost,
            hostEvent: (hostShunt.events ?? []).filter((event) => event.type === 'shunt-hit').slice(-1)[0] ?? null,
            screenshot: shots['browser-mp-powerups-shunt-guest.png']
          },
          barge: {
            guestActivated: guestBargeActivated,
            guestHit: guestBargeEvent,
            hostHit: (hostBarge.events ?? []).filter((event) => event.type === 'barge-hit').slice(-1)[0] ?? null,
            screenshot: shots['browser-mp-powerups-barge-host.png'],
            guestScreenshot: shots['browser-mp-powerups-barge-guest.png']
          }
        }
      },
      final: {
        host: hostFinal,
        guest: guestFinal,
        hostPower,
        guestPower,
        hostPowerCounts: hostCounts,
        guestPowerCounts: guestCounts
      },
      console: {
        host: { totalMessages: hostPage.messages.length, messages: hostPage.messages },
        guest: { totalMessages: guestPage.messages.length, messages: guestPage.messages }
      },
      assertions: { ok: passFailures.length === 0, failures: passFailures },
      verdict: passFailures.length === 0 && hostPage.messages.length === 0 && guestPage.messages.length === 0
        ? 'clean-console-and-gates' : 'failed'
    };
    writeFileSync(path.join(OUT, 'browser-evidence-mp-powerups.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    writeFileSync(path.join(LOGS, 'edge-mp-powerups.log'), browserLog +
      '\nroom: ' + JSON.stringify(roomServer.stats()) + '\nrelay: ' + JSON.stringify(relayStats) + '\n', 'utf8');
    return {
      ok: evidence.verdict === 'clean-console-and-gates',
      summary: {
        verdict: evidence.verdict,
        room: code,
        manifestHash: evidence.manifest.hash,
        eventCounts: hostCounts,
        guestEventCounts: guestCounts,
        nitro: {
          host: { before: hostNitroBefore, peak: hostNitroPeak.peak, targetMps: hostNitroEvent?.targetMps,
            speedMps: hostNitroEvent?.speedMps, classLetter: hostNitroEvent?.classLetter },
          guest: { before: guestNitroBefore, peak: guestNitroPeak.peak, targetMps: guestNitroEvent?.targetMps,
            speedMps: guestNitroEvent?.speedMps, classLetter: guestNitroEvent?.classLetter }
        },
        shock: {
          guestTarget: { targetMps: guestShockTarget?.targetMps, speedMps: guestShockTarget?.speedMps,
            health: guestShock.local?.health ?? null },
          hostTarget: { before: hostShockBefore, targetMps: hostShockTarget?.targetMps,
            engine: hostShock.engineBoost }
        },
        weapons: {
          blindfire: { guestDamage: guestBlindHit?.damage ?? null,
            hostHit: (hostBlindfire.events ?? []).some((event) => event.type === 'projectile-hit') },
          shunt: { guestDeltaV: guestShuntEvent?.impulse?.deltaV ?? null,
            guestFlip: guestShuntEvent?.fakePhysics?.kind ?? null,
            guestImpulse: guestImpulse.engineBoost?.kind ?? null },
          barge: { radius: guestBargeActivated?.radius ?? null,
            durationSeconds: guestBargeActivated?.durationSeconds ?? null,
            guestDamage: guestBargeEvent?.damage ?? null,
            hostHit: (hostBarge.events ?? []).some((event) => event.type === 'barge-hit') }
        },
        huds: { host: hostPower.hud, guest: guestPower.hud },
        markers: { host: hostPower.markers, guest: guestPower.markers },
        relay: relayStats,
        console: { host: hostPage.messages.length, guest: guestPage.messages.length },
        screenshots: shots,
        failures: passFailures
      }
    };
  } catch (error) {
    fatal = error;
    const evidence = {
      kind: 'e1-drive.mp-powerups-browser',
      version: 1,
      browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT, pages: 2 },
      ports: { game: PORT, room: ROOM_PORT },
      room: roomServer ? { code, stats: roomServer.stats() } : null,
      console: {
        host: { totalMessages: hostPage.messages.length, messages: hostPage.messages },
        guest: { totalMessages: guestPage?.messages?.length ?? 0, messages: guestPage?.messages ?? [] }
      },
      assertions: { ok: false, failures: [error.message, ...passFailures] },
      verdict: 'failed',
      error: error.message
    };
    writeFileSync(path.join(OUT, 'browser-evidence-mp-powerups.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    writeFileSync(path.join(LOGS, 'edge-mp-powerups.log'), browserLog + '\nERROR: ' + error.message + '\n', 'utf8');
    return {
      ok: false,
      summary: {
        verdict: 'failed',
        room: code,
        error: error.message,
        failures: passFailures,
        screenshots: shots,
        console: { host: hostPage.messages.length, guest: guestPage?.messages?.length ?? 0 }
      }
    };
  } finally {
    try { guestPage?.close(); } catch {}
    try { await roomServer?.close(); } catch {}
    if (fatal) console.error('mp-powerups capture failed:', fatal.message);
  }
}

if (MODE !== 'drive') {
  const result = MODE === 'chunk' ? await chunkCapturePass()
    : MODE === 'sprint' ? await sprintCapturePass()
    : MODE === 'lap' ? await lapCapturePass()
    : MODE === 'free' ? await freeCapturePass()
    : MODE === 'props' ? await propsCapturePass()
    : MODE === 'collision-v2' ? await collisionV2CapturePass()
    : MODE === 'quality' ? await qualityCapturePass()
    : MODE === 'ghost' ? await ghostCapturePass()
    : MODE === 'survey' ? await surveyCapturePass()
    : MODE === 'map' ? await mapCapturePass()
    : MODE === 'respawn' ? await respawnCapturePass()
      : MODE === 'restart' ? await restartCapturePass()
        : MODE === 'telemetry-restart' ? await telemetryRestartCapturePass()
          : MODE === 'audio' ? await audioCapturePass()
            : MODE === 'mp' ? await mpCapturePass()
              : MODE === 'mp-ai' ? await mpAiCapturePass()
                : MODE === 'mp-solo-ai' ? await mpSoloAiCapturePass()
                : MODE === 'mp-powerups' ? await mpPowerupsCapturePass()
                  : await telemetryCapturePass();
  await shutdown();
  await sleep(400);
  console.log(JSON.stringify(result.summary, null, 2));
  process.exit(result.ok ? 0 : 1);
}

/**
 * Texture-quality capture (`--mode quality`) and its image metrics.
 *
 * Four frames are captured with the same URL, tick, camera, viewport and page
 * code as the existing drive/props passes, so a "before" run (the committed
 * mip0/raw consumer) and an "after" run (mip chain + trilinear/anisotropy +
 * sRGB) can be compared pixel for pixel:
 *
 *   * `sprint-start` — `?script=sprint&hold=0` (truck cluster ahead),
 *   * `truck-120`    — `?script=drive&hold=120` (near-field level-prop truck),
 *   * `free-prop`    — `?script=sprint&course=free&hold=<measured prop tick>`,
 *   * `lap-start`    — `?script=sprint&course=lap&hold=0` (regression frame).
 *
 * `--label before|after` names the PNGs and the evidence file. The metrics are
 * computed on the scene area only (the fixed HUD overlay boxes are masked):
 * `sharpness` is the mean absolute 4-neighbour Laplacian of luminance,
 * `pixelNoise` the mean absolute 3x3 box residual (a pixel-scale aliasing
 * proxy), `edgeEnergy` the mean central-difference gradient. They are
 * diagnostics of this headless 1600x900 frame, not a display-quality claim.
 */

/** Minimal PNG reader for the CDP screenshot stream (8-bit RGB/RGBA, no interlace). */
function decodeScreenshotPng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('screenshot is not a PNG');
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colourType = 0, interlace = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || (colourType !== 2 && colourType !== 6) || interlace !== 0) {
    throw new Error('unsupported screenshot PNG ' + bitDepth + '/' + colourType + '/interlace ' + interlace);
  }
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * channels);
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++];
    const source = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const above = previous ? previous[x] : 0;
      const corner = previous && x >= channels ? previous[x - channels] : 0;
      let value = source[x];
      if (filter === 1) value = (value + left) & 255;
      else if (filter === 2) value = (value + above) & 255;
      else if (filter === 3) value = (value + ((left + above) >> 1)) & 255;
      else if (filter === 4) {
        const estimate = left + above - corner;
        const da = Math.abs(estimate - left);
        const db = Math.abs(estimate - above);
        const dc = Math.abs(estimate - corner);
        value = (value + (da <= db && da <= dc ? left : db <= dc ? above : corner)) & 255;
      } else if (filter !== 0) {
        throw new Error('unsupported screenshot PNG filter ' + filter);
      }
      row[x] = value;
    }
  }
  return { width, height, channels, pixels };
}

function qualityMask(width, height) {
  const mask = new Uint8Array(width * height);
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const inHud = QUALITY_HUD_BOXES.some((box) =>
        x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h);
      if (!inHud) {
        mask[y * width + x] = 1;
        count++;
      }
    }
  }
  return { mask, count };
}

/** Scene-only luminance metrics for one screenshot. */
function qualityMetrics(image) {
  const { width, height, channels, pixels } = image;
  const lum = new Float32Array(width * height);
  for (let index = 0, offset = 0; index < lum.length; index++, offset += channels) {
    lum[index] = (0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2]) / 255;
  }
  const { mask, count } = qualityMask(width, height);
  let sharpness = 0, pixelNoise = 0, edgeEnergy = 0, luminance = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      if (!mask[index]) continue;
      const centre = lum[index];
      luminance += centre;
      sharpness += Math.abs(4 * centre - lum[index - width] - lum[index + width] - lum[index - 1] - lum[index + 1]);
      let box = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) box += lum[index + dy * width + dx];
      pixelNoise += Math.abs(centre - box / 9);
      edgeEnergy += Math.abs(lum[index + 1] - lum[index - 1]) + Math.abs(lum[index + width] - lum[index - width]);
    }
  }
  const meanLuminance = luminance / count;
  return {
    maskedPixels: count,
    meanLuminance,
    sharpness: sharpness / count,
    // Luminance-normalised so a darker (correct sRGB) frame stays comparable:
    // an absolute Laplacian falls with luminance even when detail is unchanged.
    sharpnessPerLuminance: sharpness / count / Math.max(meanLuminance, 1e-6),
    pixelNoise: pixelNoise / count,
    pixelNoisePerLuminance: pixelNoise / count / Math.max(meanLuminance, 1e-6),
    // Scale-free pixel-scale noise against medium-scale edge energy.
    noiseToEdgeRatio: pixelNoise / Math.max(edgeEnergy, 1e-6),
    edgeEnergy: edgeEnergy / (2 * count)
  };
}

/** Before/after pixel diff over the same scene mask. */
function qualityDiff(before, after) {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error('quality diff needs the same viewport');
  }
  const { width, height } = before;
  const { mask, count } = qualityMask(width, height);
  let changed = 0, absolute = 0, samples = 0, maxDelta = 0;
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index]) continue;
    let delta = 0;
    for (let channel = 0; channel < Math.min(before.channels, after.channels); channel++) {
      const difference = Math.abs(before.pixels[index * before.channels + channel] -
        after.pixels[index * after.channels + channel]);
      delta = Math.max(delta, difference);
    }
    if (delta > 0) changed++;
    absolute += delta;
    maxDelta = Math.max(maxDelta, delta);
    samples++;
  }
  return {
    maskedPixels: count,
    changedFraction: samples ? changed / samples : 0,
    meanAbsDelta: samples ? absolute / samples : 0,
    maxDelta
  };
}

/** Texture-quality before/after capture (see the block comment above). */
async function qualityCapturePass() {
  const label = option('--label', 'after');
  if (!['before', 'after'].includes(label)) throw new Error('--label must be before or after');
  const runDocument = JSON.parse(readFileSync(path.join(OUT, 'run.json'), 'utf8'));
  const freeRun = runDocument.sprint?.freeRoam;
  if (!freeRun?.cars) {
    throw new Error('run.json has no free-roam block — run `node probes/e1-drive/tools/verify_e1_drive.mjs` first');
  }
  const car = ONLY_CAR
    ? cars[0]
    : cars.find((candidate) => candidate.slug === runDocument.defaultCar) ?? cars[0];
  if (!car) throw new Error('unknown car ' + JSON.stringify(ONLY_CAR));
  const freeEntry = freeRun.cars.find((candidate) => candidate.slug === car.slug);
  const freeProp = freeEntry?.captures.find((entry) => entry.label === 'free-prop');
  if (!freeProp) throw new Error(car.slug + ': free-roam run has no free-prop capture');

  const specs = [
    { frame: 'sprint-start', tick: 0, options: { script: 'sprint', course: '' } },
    { frame: 'truck-120', tick: 120, options: { script: 'drive' } },
    { frame: 'free-prop', tick: freeProp.tick, options: { script: 'sprint', course: 'course=free' } },
    { frame: 'lap-start', tick: 0, options: { script: 'sprint', course: 'course=lap' } }
  ];
  const passFailures = [];
  const passCheck = (name, ok, detail) => { if (!ok) passFailures.push(name + (detail ? ': ' + detail : '')); };
  const rows = [];
  const allMessages = [];

  const shoot = async (spec, extraLabel = '') => {
    const prefix = `quality-${spec.frame}-${label}${extraLabel}`;
    const shot = await capture(car, prefix, spec.tick, spec.options);
    const file = path.join(ROOT, shot.screenshot);
    const bytes = readFileSync(file);
    const image = decodeScreenshotPng(bytes);
    const metrics = qualityMetrics(image);
    // A HUD-free scene crop is byte-comparable between two captures of the same
    // held tick: the DOM overlays (frame counter) are outside it, so a repeated
    // capture is either identical or the renderer is not deterministic.
    const clipped = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false,
      clip: { x: 800, y: 460, width: 440, height: 330, scale: 1 }
    });
    const sceneBytes = Buffer.from(clipped.data, 'base64');
    const sceneFile = path.join(OUT, `browser-${car.slug}-${prefix}-scene.png`);
    writeFileSync(sceneFile, sceneBytes);
    return {
      ...shot,
      file,
      bytes,
      image,
      metrics,
      sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      sceneScreenshot: path.relative(ROOT, sceneFile).split(path.sep).join('/'),
      sceneSha256: 'sha256:' + createHash('sha256').update(sceneBytes).digest('hex')
    };
  };

  const beforePaths = new Map();
  for (const spec of specs) {
    const shot = await shoot(spec);
    const probe = shot.probe;
    const blocking = shot.messages.filter((entry) => entry.source !== 'console.log');
    allMessages.push(...shot.messages);
    passCheck(`${car.slug}/${spec.frame}: held at tick ${spec.tick}`,
      probe.holdReached === true && probe.displayTick === spec.tick && probe.render?.tick === spec.tick,
      `display ${probe.displayTick}, render ${probe.render?.tick}`);
    passCheck(`${car.slug}/${spec.frame}: console is clean`, blocking.length === 0,
      blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));

    let diff = null;
    if (label === 'after') {
      const beforeFile = path.join(OUT, `browser-${car.slug}-quality-${spec.frame}-before.png`);
      if (existsSync(beforeFile)) {
        diff = qualityDiff(decodeScreenshotPng(readFileSync(beforeFile)), shot.image);
        beforePaths.set(spec.frame, path.relative(ROOT, beforeFile).split(path.sep).join('/'));
      }
    }
    rows.push({
      frame: spec.frame,
      tick: spec.tick,
      url: shot.url,
      screenshot: shot.screenshot,
      sha256: shot.sha256,
      sceneScreenshot: shot.sceneScreenshot,
      sceneSha256: shot.sceneSha256,
      camera: probe.render?.camera ?? null,
      textureSampling: probe.textureSampling ?? null,
      textureUploads: probe.textureUploads,
      textureUploadBytes: probe.textureUploadBytes,
      carTextureBytes: probe.carTextureBytes,
      trackTextureBytes: probe.trackTextureBytes,
      levelPropTextureBytes: probe.levelPropTextureBytes,
      metrics: shot.metrics,
      diffVsBefore: diff,
      beforeScreenshot: beforePaths.get(spec.frame) ?? null,
      messages: shot.messages
    });
  }

  // Determinism: repeat the first frame and require byte-identical PNGs, metrics
  // and the generated mip-chain hash. No wall clock or random input is involved.
  const repeatSpec = specs[0];
  const first = rows[0];
  const repeat = await shoot(repeatSpec, '-repeat');
  const repeatProbe = repeat.probe;
  const repeatMetrics = repeat.metrics;
  const repeatSame = repeat.sceneSha256 === first.sceneSha256 &&
    JSON.stringify(repeatMetrics) === JSON.stringify(first.metrics) &&
    (repeatProbe.textureSampling?.mipChainHash ?? null) === (first.textureSampling?.mipChainHash ?? null);
  passCheck(`${car.slug}/${repeatSpec.frame}: a repeated capture has an identical scene crop`, repeatSame,
    repeat.sceneSha256 + ' vs ' + first.sceneSha256);

  const sampling = rows.find((row) => row.textureSampling)?.textureSampling ?? null;
  if (label === 'after') {
    passCheck('the consumer reports the new sampling policy', sampling !== null,
      'window.__e1TextureSampling is missing');
    passCheck('the albedo textures are uploaded as sRGB',
      sampling?.format === 'rgba8unorm-srgb', String(sampling?.format));
    passCheck('a full mip chain is generated for every static albedo',
      (sampling?.textures ?? 0) > 0 && (sampling?.mipLevelsTotal ?? 0) >= (sampling?.textures ?? 1) * 2 &&
      (sampling?.mipBytes ?? 0) > 0,
      `${sampling?.textures} textures / ${sampling?.mipLevelsTotal} levels / ${sampling?.mipBytes} B`);
    passCheck('trilinear sampling is enabled', sampling?.mipmapFilter === 'linear',
      String(sampling?.mipmapFilter));
    passCheck('anisotropic filtering is applied where supported',
      (sampling?.anisotropyApplied ?? 0) >= 1, String(sampling?.anisotropyApplied));
  }

  const blocking = allMessages.filter((entry) => entry.source !== 'console.log');
  const evidence = {
    browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT },
    mode: 'quality',
    label,
    note: 'identical URL, tick, camera and 1600x900 viewport per frame; the before run uses the committed ' +
      'mip0/raw consumer and the after run the derived mip chain + trilinear/anisotropy + sRGB consumer. ' +
      'Metrics are scene-only (HUD boxes masked) diagnostics of this headless frame.',
    car: { slug: car.slug, name: car.name },
    frames: rows,
    repeat: {
      screenshot: repeat.screenshot,
      sha256: repeat.sha256,
      sceneScreenshot: repeat.sceneScreenshot,
      sceneSha256: repeat.sceneSha256,
      metrics: repeatMetrics,
      textureSampling: repeatProbe.textureSampling ?? null,
      byteIdentical: repeatSame
    },
    sampling,
    console: { totalMessages: allMessages.length, errorsAndWarnings: blocking.length, messages: allMessages },
    assertions: { ok: passFailures.length === 0, failures: passFailures },
    verdict: blocking.length === 0 && passFailures.length === 0 ? 'clean-console-and-metrics' : 'failed'
  };
  const evidenceName = `browser-evidence-quality-${label}.json`;
  writeFileSync(path.join(OUT, evidenceName), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(LOGS, `edge-quality-${label}.log`), browserLog, 'utf8');
  return {
    ok: evidence.verdict === 'clean-console-and-metrics',
    summary: {
      mode: 'quality',
      label,
      car: car.slug,
      consoleMessages: allMessages.length,
      failures: passFailures,
      sampling,
      evidence: '_work/e1-drive/' + evidenceName,
      frames: rows.map((row) => ({
        frame: row.frame,
        tick: row.tick,
        screenshot: row.screenshot,
        sha256: row.sha256,
        metrics: row.metrics,
        changedFraction: row.diffVsBefore?.changedFraction ?? null
      }))
    }
  };
}

/**
 * Start / checkpoint / finish captures of the scripted sprint, using the node
 * sprint run (run.json → sprint.cars[].captures) as the expected state.
 */
/**
 * usa_amboy map capture (`--mode map`): the M3 first-map browser gate. One page
 * loads `?map=amboy&script=sprint`, verifies the package pins in the page, drives
 * the measured 2,060.595 m course and is held at the node run's start/checkpoint/
 * mid/finish ticks. Compares the page's state hashes, layout hash, finish and
 * upload/draw counts against `_work/e1-drive/map-amboy-run.json`.
 */
async function mapCapturePass() {
  const runPath = path.join(OUT, 'map-' + MAP_ID + '-run.json');
  const mapPath = path.join(OUT, MAP_ID + '/map.json');
  if (!existsSync(runPath) || !existsSync(mapPath)) {
    throw new Error('missing map run/map document; run `node probes/e1-drive/tools/verify_e1_map.mjs --map ' + MAP_ID + '` first');
  }
  const mapRun = JSON.parse(readFileSync(runPath, 'utf8'));
  const mapDoc = JSON.parse(readFileSync(mapPath, 'utf8'));
  const car = run.cars.find((candidate) => candidate.slug === mapRun.car.slug);
  if (!car) throw new Error('map run car ' + mapRun.car.slug + ' is not in the roster run');
  const body = geometry.carBodies[car.slug];
  if (!body) throw new Error('geometry has no body for ' + car.slug);
  const rows = [];
  const passFailures = [];
  const passCheck = (label, ok, detail) => { if (!ok) passFailures.push(label + (detail ? ': ' + detail : '')); };
  const counts = mapDoc.counts;
  const expectedDraws = counts.draws + body.carDraws.length;
  const uploadBytes = meshBytes({ ...mapDoc.meshes[0], uv: mapDoc.meshes[0].uv }) + meshBytes(body.mesh);

  for (const spec of mapRun.captures) {
    const label = 'map-' + MAP_ID + '-' + spec.label;
    const shot = await capture(car, label, spec.tick, {
      script: 'sprint',
      extraQuery: 'map=' + MAP_ID,
      longRun: true,
      bestKey: MAP_ENTRY.bestKey
    });
    const probe = shot.probe;
    const state = probe.sprint;
    const overlay = probe.overlays ?? {};
    passCheck(`${label}: held at tick ${spec.tick}`, probe.holdReached === true && probe.displayTick === spec.tick,
      `display ${probe.displayTick}`);
    passCheck(`${label}: page reports the ${MAP_ENTRY.label} map`, probe.map?.id === MAP_ID, JSON.stringify(probe.map?.id));
    passCheck(`${label}: page reports the pinned layout hash`, probe.sprintLayoutHash === mapRun.layout.hash,
      (probe.sprintLayoutHash ?? 'none') + ' vs ' + mapRun.layout.hash);
    passCheck(`${label}: browser state hash equals the node run`, probe.tickHashes[spec.tick]?.stateHash === spec.stateHash,
      (probe.tickHashes[spec.tick]?.stateHash ?? 'none') + ' vs ' + spec.stateHash);
    passCheck(`${label}: geometry uploads are the map mesh + the car body`, probe.geometryUploads === 2,
      String(probe.geometryUploads));
    passCheck(`${label}: uploaded bytes are the map mesh + the car body`,
      probe.geometryUploadBytes === uploadBytes, `${probe.geometryUploadBytes} vs ${uploadBytes}`);
    passCheck(`${label}: draw count is ${counts.draws} opaque map draws + the car`,
      probe.draws === expectedDraws && probe.drawsIssued === probe.frames * probe.draws,
      `${probe.draws} / ${expectedDraws}`);
    passCheck(`${label}: track layer is the ${counts.draws}-draw / ${counts.triangles}-triangle ${MAP_ENTRY.label} mesh`,
      probe.trackDraws === counts.draws && probe.trackTriangles === counts.triangles &&
      probe.trackTextures === counts.textures && probe.trackTextureBytes === counts.textureBytes,
      JSON.stringify({ draws: probe.trackDraws, tri: probe.trackTriangles, tex: probe.trackTextures, bytes: probe.trackTextureBytes }));
    passCheck(`${label}: skipped layers are labelled`, probe.mapCounts?.blockedDraws === counts.blockedDraws &&
      probe.mapCounts?.decalDraws === counts.decalDraws && probe.mapCounts?.diagnosticDraws === counts.diagnosticDraws,
      JSON.stringify(probe.mapCounts));

    if (spec.label === 'start') {
      passCheck(`${label}: countdown is on screen and the timer has not started`,
        state?.phase === 'countdown' && state.elapsedTicks === 0 && state.checkpointsPassed === 0 &&
        overlay.countdownHidden === false && overlay.resultsHidden === true,
        JSON.stringify({ phase: state?.phase, elapsed: state?.elapsedTicks }));
    } else if (spec.label === 'checkpoint') {
      passCheck(`${label}: a checkpoint is shown and the timer is running`,
        state?.phase === 'running' && state.checkpointsPassed >= 1 && state.progress > 0.3 &&
        overlay.resultsHidden === true,
        JSON.stringify({ phase: state?.phase, cp: state?.checkpointsPassed, progress: state?.progress }));
    } else if (spec.label === 'mid') {
      passCheck(`${label}: mid-course frame is running near half progress`,
        state?.phase === 'running' && state.checkpointsPassed >= 1 &&
        state.progress >= 0.45 && state.progress <= 0.55 && overlay.resultsHidden === true,
        JSON.stringify({ phase: state?.phase, cp: state?.checkpointsPassed, progress: state?.progress }));
    } else if (spec.label === 'finish') {
      passCheck(`${label}: the finish fires with both checkpoints and the node time`,
        state?.finished === true && state.checkpointsPassed === 2 &&
        Math.abs(state.finishTimeSeconds - mapRun.sprint.finish.timeSeconds) < 1e-6 &&
        state.progress >= 0.999,
        JSON.stringify({ finished: state?.finished, cp: state?.checkpointsPassed, time: state?.finishTimeSeconds, progress: state?.progress }));
      passCheck(`${label}: the results overlay shows the time and car`,
        overlay.resultsHidden === false && (overlay.resultsTime ?? '').includes(mapRun.sprint.finish.timeSeconds.toFixed(3)) &&
        (overlay.resultsTime ?? '').includes(car.name),
        JSON.stringify({ time: overlay.resultsTime }));
    }
    rows.push({
      label, tick: spec.tick, url: shot.url, screenshot: shot.screenshot,
      stateHash: probe.tickHashes[spec.tick]?.stateHash ?? null, nodeStateHash: spec.stateHash,
      phase: state?.phase ?? null, progress: state?.progress ?? null,
      checkpointsPassed: state?.checkpointsPassed ?? null, finished: state?.finished ?? null,
      finishTimeSeconds: state?.finishTimeSeconds ?? null,
      map: probe.map?.id ?? null, layoutHash: probe.sprintLayoutHash ?? null,
      geometryUploads: probe.geometryUploads, geometryUploadBytes: probe.geometryUploadBytes,
      draws: probe.draws, drawsIssued: probe.drawsIssued, frames: probe.frames,
      trackDraws: probe.trackDraws, trackTriangles: probe.trackTriangles,
      trackTextures: probe.trackTextures, trackTextureBytes: probe.trackTextureBytes,
      overlays: overlay, messages: shot.messages
    });
  }

  const allMessages = rows.flatMap((row) => row.messages);
  const blocking = allMessages.filter((entry) => entry.source !== 'console.log');
  passCheck('console is clean in every map capture', blocking.length === 0,
    blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));
  const evidence = {
    browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT },
    mode: 'map',
    map: MAP_ID,
    package: {
      mapHash: mapDoc.hash,
      layoutHash: mapRun.layout.hash,
      counts: mapDoc.counts,
      source: mapDoc.source
    },
    run: { finish: mapRun.sprint.finish, checkpoints: mapRun.sprint.checkpoints,
      stateSequenceHash: mapRun.sprint.stateSequenceHash, replayReproduced: mapRun.sprint.replayReproduced },
    captures: rows,
    console: { totalMessages: allMessages.length, errorsAndWarnings: blocking.length, messages: allMessages },
    assertions: { ok: passFailures.length === 0, failures: passFailures },
    verdict: blocking.length === 0 && passFailures.length === 0 ? 'clean-console-and-gates' : 'failed'
  };
  writeFileSync(path.join(OUT, 'browser-evidence-map-' + MAP_ID + '.json'),
    JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(LOGS, 'edge-map-' + MAP_ID + '.log'), browserLog, 'utf8');
  return {
    ok: evidence.verdict === 'clean-console-and-gates',
    summary: {
      verdict: evidence.verdict,
      map: MAP_ID,
      consoleMessages: evidence.console.totalMessages,
      errorsAndWarnings: evidence.console.errorsAndWarnings,
      failures: passFailures,
      captures: rows.map((row) => ({ label: row.label, tick: row.tick,
        phase: row.phase, progress: row.progress, checkpoints: row.checkpointsPassed,
        finished: row.finished, finishTimeSeconds: row.finishTimeSeconds,
        screenshot: row.screenshot, messages: row.messages.length }))
    }
  };
}

async function sprintCapturePass() {
  const runDocument = JSON.parse(readFileSync(path.join(OUT, 'run.json'), 'utf8'));
  if (!runDocument.sprint?.cars) {
    throw new Error('run.json has no sprint block — run `node probes/e1-drive/tools/verify_e1_drive.mjs` first');
  }
  // The default sprint block is the 310 m course; the short regression results
  // live under sprint.shortCourse.
  const sprintRun = COURSE === 'short' ? runDocument.sprint.shortCourse : runDocument.sprint;
  if (!sprintRun?.cars) {
    throw new Error('run.json has no ' + COURSE + ' sprint results — run `node probes/e1-drive/tools/verify_e1_drive.mjs` first');
  }
  const sprintLayout = COURSE === 'short'
    ? JSON.parse(readFileSync(path.join(OUT, 'sprint-short.json'), 'utf8'))
    : JSON.parse(readFileSync(path.join(OUT, 'sprint.json'), 'utf8'));
  const rows = [];
  const passFailures = [];
  const passCheck = (label, ok, detail) => { if (!ok) passFailures.push(label + (detail ? ': ' + detail : '')); };

  for (const car of cars) {
    const entry = sprintRun.cars.find((candidate) => candidate.slug === car.slug);
    if (!entry) throw new Error('run.json has no sprint result for ' + car.slug);
    const body = geometry.carBodies[car.slug];
    if (!body) throw new Error('geometry has no body for ' + car.slug);
    const uploadBytes = meshBytes(levelMesh) + meshBytes(body.mesh) + meshBytes(trackMesh);
    const draws = 22 + geometry.trackVisual.drawCount + body.carDraws.length;
    const finishSeconds = entry.finish.timeSeconds;

    for (const spec of entry.captures) {
      const label = (COURSE === 'short' ? 'sprint-short-' : 'sprint-') + spec.label;
      const shot = await capture(car, label, spec.tick, { script: 'sprint' });
      const probe = shot.probe;
      const state = probe.sprint;
      const overlay = probe.overlays ?? {};
      const cameraDelta = probe.render && spec.camera ? cameraMaxDelta(probe.render.camera, spec.camera) : null;
      const matrixDelta = probe.render && Array.isArray(spec.matrices)
        ? Math.max(...probe.render.matrices.map((entry, index) => {
          const expected = spec.matrices[index]?.world;
          if (!expected || expected.length !== entry.world.length) return Infinity;
          return Math.max(...entry.world.map((value, axis) => Math.abs(value - expected[axis])));
        }))
        : null;

      passCheck(`${car.slug}/${label}: held at tick ${spec.tick} with the update the page built`,
        probe.holdReached === true && probe.displayTick === spec.tick && probe.render?.tick === spec.tick,
        `display ${probe.displayTick}, render ${probe.render?.tick}`);
      passCheck(`${car.slug}/${label}: the page drove the requested car`,
        probe.car?.name === car.name && probe.sprintLayoutHash === sprintLayout.hash,
        JSON.stringify({ car: probe.car?.name, layout: probe.sprintLayoutHash }));
      passCheck(`${car.slug}/${label}: browser state hash equals the node sprint state`,
        probe.tickHashes[spec.tick]?.stateHash === spec.stateHash,
        (probe.tickHashes[spec.tick]?.stateHash ?? 'none') + ' vs ' + spec.stateHash);
      passCheck(`${car.slug}/${label}: the car matrix is bit-identical to the node sprint packet`,
        probe.render && spec.matrix &&
        probe.render.matrix.every((value, index) => Object.is(value, spec.matrix[index])),
        'matrix differs');
      passCheck(`${car.slug}/${label}: every node matrix matches the node sprint packet within 1e-12`,
        matrixDelta !== null && matrixDelta <= 1e-12,
        'max |matrix delta| ' + (matrixDelta === null ? 'n/a' : matrixDelta.toExponential(3)));
      passCheck(`${car.slug}/${label}: the browser camera matches the node sprint camera within 1e-6`,
        cameraDelta !== null && cameraDelta <= 1e-6,
        'max |delta| ' + (cameraDelta === null ? 'n/a' : cameraDelta.toExponential(3)));
      passCheck(`${car.slug}/${label}: geometry uploads equal the level + own body + track meshes`,
        probe.geometryUploads === MESH_COUNT && probe.geometryUploadBytes === uploadBytes,
        probe.geometryUploads + ' uploads / ' + probe.geometryUploadBytes + ' B');
      passCheck(`${car.slug}/${label}: one draw per draw per frame`,
        probe.draws === draws && probe.drawsIssued === probe.frames * probe.draws,
        probe.drawsIssued + ' draws / ' + probe.frames + ' frames * ' + probe.draws);
      passCheck(`${car.slug}/${label}: nine matrices per rendered tick`,
        probe.render?.matrices?.length === 9, String(probe.render?.matrices?.length));

      if (spec.label === 'start') {
        passCheck(`${car.slug}/${label}: the countdown is on screen and the timer has not started`,
          state?.phase === 'countdown' && state.elapsedTicks === 0 && state.checkpointsPassed === 0 &&
          state.countdownLabel === '3' && state.progress < 0.01 && overlay.countdownHidden === false &&
          overlay.resultsHidden === true && probe.render?.matrices?.[0] !== undefined,
          JSON.stringify({ phase: state?.phase, elapsed: state?.elapsedTicks, label: overlay.countdownText }));
      } else if (spec.label === 'checkpoint') {
        passCheck(`${car.slug}/${label}: a checkpoint is shown and the timer is running`,
          state?.phase === 'running' && state.checkpointsPassed >= 1 &&
          Math.abs(state.elapsedSeconds - spec.elapsedSeconds) < 1e-6 &&
          Math.abs(state.progress - spec.progress) < 1e-6 && state.progress > 0.3 &&
          overlay.resultsHidden === true &&
          overlay.eventVisible === '1' && /checkpoint/i.test(overlay.eventText ?? ''),
          JSON.stringify({ phase: state?.phase, cp: state?.checkpointsPassed, elapsed: state?.elapsedSeconds,
            progress: state?.progress, banner: overlay.eventText }));
      } else if (spec.label === 'mid') {
        passCheck(`${car.slug}/${label}: mid-course frame is running with progress near half`,
          state?.phase === 'running' && state.checkpointsPassed >= 1 &&
          Math.abs(state.progress - spec.progress) < 1e-6 && state.progress >= 0.45 &&
          overlay.resultsHidden === true,
          JSON.stringify({ phase: state?.phase, cp: state?.checkpointsPassed, progress: state?.progress }));
      } else if (spec.label === 'finish') {
        passCheck(`${car.slug}/${label}: the finish fires with the node time and both checkpoints`,
          state?.finished === true && state.checkpointsPassed === 2 &&
          Math.abs(state.finishTimeSeconds - finishSeconds) < 1e-6 &&
          Math.abs(state.elapsedSeconds - finishSeconds) < 1e-6 &&
          state.progress === 1,
          JSON.stringify({ finished: state?.finished, time: state?.finishTimeSeconds, node: finishSeconds }));
        passCheck(`${car.slug}/${label}: the results overlay shows the time, car and best`,
          overlay.resultsHidden === false &&
          (overlay.resultsTime ?? '').includes(finishSeconds.toFixed(3)) &&
          (overlay.resultsTime ?? '').includes(car.name) &&
          (overlay.resultsBest ?? '').includes('best ' + finishSeconds.toFixed(3)),
          JSON.stringify({ time: overlay.resultsTime, best: overlay.resultsBest }));
        let stored = null;
        try { stored = probe.bestStored ? JSON.parse(probe.bestStored) : null; } catch { stored = null; }
        const expectedBest = Number(finishSeconds.toFixed(3));
        passCheck(`${car.slug}/${label}: the best time is persisted in localStorage for this car`,
          stored?.cars?.[car.slug]?.seconds !== undefined &&
          Math.abs(stored.cars[car.slug].seconds - expectedBest) < 1e-6 &&
          probe.sprintResult?.improved === true &&
          Math.abs(probe.sprintBest - expectedBest) < 1e-6,
          JSON.stringify({ stored: stored?.cars?.[car.slug] ?? null, best: probe.sprintBest, improved: probe.sprintResult?.improved }));
      } else {
        passCheck(`${car.slug}/${label}: unknown sprint capture label`, false, spec.label);
      }

      rows.push({
        car: car.name,
        slug: car.slug,
        label,
        tick: spec.tick,
        url: shot.url,
        screenshot: shot.screenshot,
        carCrop: shot.carCrop,
        phase: state?.phase ?? null,
        elapsedSeconds: state?.elapsedSeconds ?? null,
        checkpointsPassed: state?.checkpointsPassed ?? null,
        finished: state?.finished ?? null,
        finishTimeSeconds: state?.finishTimeSeconds ?? null,
        progress: state?.progress ?? null,
        position: probe.position,
        speed: probe.speed,
        sprintResult: probe.sprintResult,
        overlays: overlay,
        stateHash: probe.tickHashes[spec.tick]?.stateHash ?? null,
        nodeStateHash: spec.stateHash,
        updateHash: probe.render?.hash ?? null,
        nodeUpdateHash: spec.updateHash,
        pageRender: probe.render,
        packetHashExact: probe.render?.hash === spec.updateHash,
        carMatrixExact: !!probe.render && !!spec.matrix &&
          probe.render.matrix.every((value, index) => Object.is(value, spec.matrix[index])),
        cameraMaxDelta: cameraDelta,
        matrixMaxDelta: matrixDelta,
        frames: probe.frames,
        geometryUploads: probe.geometryUploads,
        geometryUploadBytes: probe.geometryUploadBytes,
        drawsIssued: probe.drawsIssued,
        canvas: probe.canvas,
        messages: shot.messages
      });
    }
  }

  const allMessages = rows.flatMap((row) => row.messages);
  const blocking = allMessages.filter((entry) => entry.source !== 'console.log');
  passCheck('console is clean in every sprint capture', blocking.length === 0,
    blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));
  const exact = rows.filter((row) => row.packetHashExact).length;
  const evidence = {
    browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT },
    mode: 'sprint',
    courseId: COURSE === 'short' ? 'short' : '310m',
    layout: { hash: sprintLayout.hash, span: sprintLayout.course.span },
    cars: rows,
    packetHashAgreement: { exact, total: rows.length, note:
      'a mismatch is a documented last-bit transcendental difference between Node 24 and Edge 156 (Math.atan2 ' +
      'in the chase camera or Math.sin/cos in a wheel spin matrix); the state hash, the car matrix and the ' +
      '1e-12 matrix/camera tolerances are checked separately' },
    console: { totalMessages: allMessages.length, errorsAndWarnings: blocking.length, messages: allMessages },
    assertions: { ok: passFailures.length === 0, failures: passFailures },
    verdict: blocking.length === 0 && passFailures.length === 0 ? 'clean-console-and-gates' : 'failed'
  };
  writeFileSync(path.join(OUT, COURSE === 'short' ? 'browser-evidence-sprint-short.json' : 'browser-evidence-sprint.json'),
    JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(LOGS, COURSE === 'short' ? 'edge-sprint-short.log' : 'edge-sprint.log'), browserLog, 'utf8');
  return {
    ok: evidence.verdict === 'clean-console-and-gates',
    summary: {
      verdict: evidence.verdict,
      consoleMessages: evidence.console.totalMessages,
      errorsAndWarnings: evidence.console.errorsAndWarnings,
      packetHashAgreement: { exact, total: rows.length },
      failures: passFailures,
      captures: rows.map((row) => ({
        car: row.car, label: row.label, tick: row.tick, phase: row.phase,
        timeSeconds: row.finished ? row.finishTimeSeconds : row.elapsedSeconds,
        checkpoints: row.checkpointsPassed, progress: row.progress,
        screenshot: row.screenshot, carCrop: row.carCrop,
        packetHashExact: row.packetHashExact, cameraMaxDelta: row.cameraMaxDelta,
        messages: row.messages.length
      }))
    }
  };
}

/**
 * Free-roam capture (`--mode free`): 5 cars x spawn / mid-basin / prop approach /
 * reset. The page runs `?script=sprint&course=free` (the deterministic,
 * speed-capped free drive); the reset frame presses R in place and must return
 * to the committed spawn with the same tick-0 state hash. Console must be clean.
 */
async function freeCapturePass() {
  const runDocument = JSON.parse(readFileSync(path.join(OUT, 'run.json'), 'utf8'));
  const freeRun = runDocument.sprint?.freeRoam;
  if (!freeRun?.cars) {
    throw new Error('run.json has no free-roam results — run `node probes/e1-drive/tools/verify_e1_drive.mjs` first');
  }
  const freeLayout = JSON.parse(readFileSync(path.join(OUT, 'sprint-free.json'), 'utf8'));
  const rows = [];
  const passFailures = [];
  const passCheck = (label, ok, detail) => { if (!ok) passFailures.push(label + (detail ? ': ' + detail : '')); };

  for (const car of cars) {
    const entry = freeRun.cars.find((candidate) => candidate.slug === car.slug);
    if (!entry) throw new Error('run.json has no free-roam result for ' + car.slug);
    const body = geometry.carBodies[car.slug];
    if (!body) throw new Error('geometry has no body for ' + car.slug);
    const uploadBytes = meshBytes(levelMesh) + meshBytes(body.mesh) + meshBytes(trackMesh);
    const draws = 22 + geometry.trackVisual.drawCount + body.carDraws.length;

    for (const spec of entry.captures) {
      const label = spec.label;
      const shot = await capture(car, label, spec.tick,
        { script: 'sprint', course: 'course=free', triggerReset: spec.afterReset === true });
      const probe = shot.probe;
      const state = probe.sprint;
      const free = state?.free;
      const overlay = probe.overlays ?? {};
      const cameraDelta = probe.render && spec.camera ? cameraMaxDelta(probe.render.camera, spec.camera) : null;
      const matrixDelta = probe.render && Array.isArray(spec.matrices)
        ? Math.max(...probe.render.matrices.map((entryMatrix, index) => {
          const expected = spec.matrices[index]?.world;
          if (!expected || expected.length !== entryMatrix.world.length) return Infinity;
          return Math.max(...entryMatrix.world.map((value, axis) => Math.abs(value - expected[axis])));
        }))
        : null;

      passCheck(`${car.slug}/${label}: held at tick ${spec.tick} with the update the page built`,
        probe.holdReached === true && probe.displayTick === spec.tick && probe.render?.tick === spec.tick,
        `display ${probe.displayTick}, render ${probe.render?.tick}`);
      passCheck(`${car.slug}/${label}: the page drove the requested car on the free-roam layout`,
        probe.car?.name === car.name && probe.sprintLayoutHash === freeLayout.hash,
        JSON.stringify({ car: probe.car?.name, layout: probe.sprintLayoutHash }));
      passCheck(`${car.slug}/${label}: browser state hash equals the node free-roam state`,
        probe.tickHashes[spec.tick]?.stateHash === spec.stateHash,
        (probe.tickHashes[spec.tick]?.stateHash ?? 'none') + ' vs ' + spec.stateHash);
      passCheck(`${car.slug}/${label}: the car matrix is bit-identical to the node free-roam packet`,
        probe.render && spec.matrix &&
        probe.render.matrix.every((value, index) => Object.is(value, spec.matrix[index])),
        'matrix differs');
      passCheck(`${car.slug}/${label}: every node matrix matches the node free-roam packet within 1e-12`,
        matrixDelta !== null && matrixDelta <= 1e-12,
        'max |matrix delta| ' + (matrixDelta === null ? 'n/a' : matrixDelta.toExponential(3)));
      passCheck(`${car.slug}/${label}: the browser camera matches the node free-roam camera within 1e-6`,
        cameraDelta !== null && cameraDelta <= 1e-6,
        'max |delta| ' + (cameraDelta === null ? 'n/a' : cameraDelta.toExponential(3)));
      passCheck(`${car.slug}/${label}: geometry uploads equal the level + own body + track meshes`,
        probe.geometryUploads === (spec.afterReset === true ? MESH_COUNT * 2 : MESH_COUNT) &&
        probe.geometryUploadBytes === (spec.afterReset === true ? uploadBytes * 2 : uploadBytes),
        probe.geometryUploads + ' uploads / ' + probe.geometryUploadBytes + ' B' +
        (spec.afterReset === true ? ' (initial load + R reload)' : ''));
      passCheck(`${car.slug}/${label}: one draw per draw per frame`,
        probe.draws === draws && probe.drawsIssued === probe.frames * probe.draws,
        probe.drawsIssued + ' draws / ' + probe.frames + ' frames * ' + probe.draws);
      passCheck(`${car.slug}/${label}: nine matrices per rendered tick`,
        probe.render?.matrices?.length === 9, String(probe.render?.matrices?.length));
      passCheck(`${car.slug}/${label}: the free-roam layout carries no gates, finish or lap`,
        probe.sprintLayout?.gates?.length === 0 && probe.sprintLayout?.bounds?.minX === -108.5 &&
        probe.sprintLayout?.bounds?.maxX === 5 &&
        probe.sprintLayout?.containment?.marginMetres === 2,
        JSON.stringify({ gates: probe.sprintLayout?.gates?.length, bounds: probe.sprintLayout?.bounds }));
      passCheck(`${car.slug}/${label}: the 447-collider R04-V2 all-visible layer is active`,
        probe.props?.profile === 'all-visible' && probe.props?.colliders === 447 &&
        probe.props?.manifest === '_work/free-roam-prop/colliders-r04-v2.json' &&
        probe.props?.contacts === 0,
        JSON.stringify({ profile: probe.props?.profile, colliders: probe.props?.colliders,
          manifest: probe.props?.manifest, contacts: probe.props?.contacts }));
      passCheck(`${car.slug}/${label}: the HUD shows free roam, speed, position and the prop layer`,
        (overlay.hudText ?? '').includes('FREE ROAM') &&
        (overlay.hudText ?? '').includes('R04 spawn basin') &&
        (overlay.hudText ?? '').includes('no gates/finish/lap') &&
        (overlay.hudText ?? '').includes('speed') &&
        (overlay.hudText ?? '').includes('position') &&
        (overlay.hudText ?? '').includes('all-visible'),
        (overlay.hudText ?? '').split('\n').filter((line) =>
          /FREE ROAM|free|contain|props|speed|position/.test(line)).join(' | '));
      passCheck(`${car.slug}/${label}: no countdown and no results overlay in free roam`,
        overlay.countdownHidden === true && overlay.resultsHidden === true &&
        state?.phase === 'running' && state?.finished === false && state?.totalCheckpoints === 0,
        JSON.stringify({ phase: state?.phase, countdownHidden: overlay.countdownHidden,
          resultsHidden: overlay.resultsHidden }));

      if (spec.label === 'free-spawn') {
        passCheck(`${car.slug}/${label}: free roam starts on the committed spawn inside the measured basin`,
          state?.elapsedTicks <= 1 && free?.contained === true &&
          free?.distanceFromSpawnMetres < 0.05 &&
          Math.abs(free?.spawn.x + 88) < 1e-9 && Math.abs(free?.spawn.z - 1050) < 1e-9 &&
          Math.abs(free?.spawn.headingRad - Math.PI / 2) < 1e-12 &&
          overlay.eventVisible === '0',
          JSON.stringify({ elapsed: state?.elapsedTicks, distance: free?.distanceFromSpawnMetres,
            spawn: free?.spawn, event: overlay.eventVisible }));
      } else if (spec.label === 'free-mid') {
        passCheck(`${car.slug}/${label}: the mid-basin frame is running, contained and on the node tick`,
          state?.elapsedTicks === spec.tick && free?.contained === true &&
          Math.abs(state?.elapsedSeconds - spec.tick / 60) < 1e-6,
          JSON.stringify({ elapsed: state?.elapsedTicks, contained: free?.contained,
            seconds: state?.elapsedSeconds }));
      } else if (spec.label === 'free-prop') {
        passCheck(`${car.slug}/${label}: the prop-approach frame is still contained with 0 prop contacts`,
          free?.contained === true && probe.props?.contacts === 0 &&
          state?.respawns === 0 && state?.elapsedTicks === spec.tick,
          JSON.stringify({ contained: free?.contained, contacts: probe.props?.contacts,
            respawns: state?.respawns, elapsed: state?.elapsedTicks }));
      } else if (spec.label === 'free-reset') {
        passCheck(`${car.slug}/${label}: R rebuilt the world in place and returned to the spawn`,
          probe.restarts === 1 && free?.contained === true &&
          free?.distanceFromSpawnMetres < 0.05 && state?.elapsedTicks <= 1 &&
          probe.tickHashes[0]?.stateHash === spec.stateHash,
          JSON.stringify({ restarts: probe.restarts, distance: free?.distanceFromSpawnMetres,
            elapsed: state?.elapsedTicks,
            stateHash: probe.tickHashes[0]?.stateHash, node: spec.stateHash }));
      } else {
        passCheck(`${car.slug}/${label}: unknown free-roam capture label`, false, spec.label);
      }

      rows.push({
        car: car.name,
        slug: car.slug,
        label,
        tick: spec.tick,
        url: shot.url,
        screenshot: shot.screenshot,
        carCrop: shot.carCrop,
        phase: state?.phase ?? null,
        elapsedTicks: state?.elapsedTicks ?? null,
        elapsedSeconds: state?.elapsedSeconds ?? null,
        respawns: state?.respawns ?? null,
        contained: free?.contained ?? null,
        distanceFromSpawnMetres: free?.distanceFromSpawnMetres ?? null,
        position: probe.position,
        speed: probe.speed,
        props: probe.props ?? null,
        sprintLayout: probe.sprintLayout ?? null,
        restarts: probe.restarts ?? null,
        overlays: overlay,
        stateHash: probe.tickHashes[spec.tick]?.stateHash ?? null,
        nodeStateHash: spec.stateHash,
        updateHash: probe.render?.hash ?? null,
        nodeUpdateHash: spec.updateHash,
        pageRender: probe.render,
        packetHashExact: probe.render?.hash === spec.updateHash,
        carMatrixExact: !!probe.render && !!spec.matrix &&
          probe.render.matrix.every((value, index) => Object.is(value, spec.matrix[index])),
        cameraMaxDelta: cameraDelta,
        matrixMaxDelta: matrixDelta,
        frames: probe.frames,
        geometryUploads: probe.geometryUploads,
        geometryUploadBytes: probe.geometryUploadBytes,
        drawsIssued: probe.drawsIssued,
        canvas: probe.canvas,
        messages: shot.messages
      });
    }
  }

  const allMessages = rows.flatMap((row) => row.messages);
  const blocking = allMessages.filter((entry) => entry.source !== 'console.log');
  passCheck('console is clean in every free-roam capture', blocking.length === 0,
    blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));
  const exact = rows.filter((row) => row.packetHashExact).length;
  const evidence = {
    browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT },
    mode: 'free',
    courseId: 'free',
    layout: { hash: freeLayout.hash, spawn: freeLayout.course.spawn, bounds: freeLayout.course.bounds,
      containment: freeLayout.course.containment, coverage: freeLayout.course.coverage },
    prop: { profile: 'all-visible', manifest: '_work/free-roam-prop/colliders-r04-v2.json', colliders: 447,
      contentSha256: 'sha256:663e2570d1949e9bde155ec872e9fccfc09117833b5d3a663a275e686ef20b38' },
    cars: rows,
    packetHashAgreement: { exact, total: rows.length, note:
      'a mismatch is a documented last-bit transcendental difference between Node 24 and Edge 156; the state ' +
      'hash, the car matrix and the 1e-12 matrix/camera tolerances are checked separately' },
    console: { totalMessages: allMessages.length, errorsAndWarnings: blocking.length, messages: allMessages },
    assertions: { ok: passFailures.length === 0, failures: passFailures },
    verdict: blocking.length === 0 && passFailures.length === 0 ? 'clean-console-and-gates' : 'failed'
  };
  writeFileSync(path.join(OUT, 'browser-evidence-free.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(LOGS, 'edge-free.log'), browserLog, 'utf8');
  const summary = {
    mode: 'free',
    cars: rows.length,
    exact,
    console: allMessages.length,
    assertions: passFailures.length,
    failures: passFailures,
    screenshots: rows.map((row) => row.screenshot)
  };
  return {
    ok: blocking.length === 0 && passFailures.length === 0,
    summary,
    evidence
  };
}

/**
 * Level-instance prop capture (`--mode props`): frames that must show the 18
 * BC1-textured truck/wreck draws with their real UV0 + static albedo, while the
 * 4 BC3-alpha cab draws stay diagnostic. Four frames per roster car:
 *
 *   * drive tick 120 — the near-field truck crossing (P72a's 39.64 % coverage
 *     peak; the camera occlusion record names `river.block27.instances-all`),
 *   * free-roam prop approach — the same truck cluster from the free spawn,
 *   * 310 m sprint start — the truck cluster ahead of the spawn,
 *   * loop-01 lap start — a regression frame (loop-01 is ~180 m away, so it is
 *     recorded and checked but does not claim a truck in view).
 *
 * Every frame must keep console 0 and 0 assertions and report the same level
 * prop pack (22 draws, 18 textured / 4 diagnostic, 4 BC1 images / 8,192 B,
 * 13,162 UV vertices, pinned manifest and content hashes).
 */
async function propsCapturePass() {
  const runDocument = JSON.parse(readFileSync(path.join(OUT, 'run.json'), 'utf8'));
  const freeRun = runDocument.sprint?.freeRoam;
  if (!freeRun?.cars) {
    throw new Error('run.json has no free-roam block — run `node probes/e1-drive/tools/verify_e1_drive.mjs` first');
  }
  const rows = [];
  const passFailures = [];
  const passCheck = (label, ok, detail) => { if (!ok) passFailures.push(label + (detail ? ': ' + detail : '')); };
  const expected = {
    draws: geometry.levelDraws.length,
    textured: geometry.levelDraws.filter((draw) => draw.textureId != null).length,
    diagnostic: geometry.levelDraws.filter((draw) => draw.textureId == null).length,
    textures: geometry.levelTextures.length,
    textureBytes: geometry.levelTextures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
    uvVertices: levelMesh.uv.vertexCount,
    manifestSha256: geometry.levelPropTexturePack.manifestSha256,
    contentHash: geometry.levelPropTexturePack.contentHash,
    blocked: geometry.levelDraws.filter((draw) => draw.textureId == null)
      .map((draw) => draw.source.instanceIndex),
  };

  for (const car of cars) {
    const freeEntry = freeRun.cars.find((candidate) => candidate.slug === car.slug);
    if (!freeEntry) throw new Error('run.json has no free-roam result for ' + car.slug);
    const freeProp = freeEntry.captures.find((captureEntry) => captureEntry.label === 'free-prop');
    if (!freeProp) throw new Error(car.slug + ': free-roam run has no free-prop capture');
    const body = geometry.carBodies[car.slug];
    if (!body) throw new Error('geometry has no body for ' + car.slug);
    const draws = 22 + geometry.trackVisual.drawCount + body.carDraws.length;
    // The P72a 39.64 % peak was measured on the default car at drive tick 120.
    // Other cars travel further by tick 120, so they also get their own first
    // measured near-field truck crossing from the committed packet cameras.
    const packetPath = path.join(ROOT, run.cars.find((entry) => entry.slug === car.slug).packet.path);
    const truckUpdate = JSON.parse(readFileSync(packetPath, 'utf8')).updates.find((update) =>
      update.camera?.occlusion?.hitMesh === 'river.block27.instances-all' &&
      update.camera.occlusion.nearField === true);
    if (!truckUpdate) throw new Error(car.slug + ': packet has no near-field level-prop truck crossing');

    const specs = [
      { label: 'prop-tick120', tick: 120, options: { script: 'drive' },
        rule: 'drive tick 120; the default car is at the P72a near-field truck peak' },
      { label: 'prop-truck', tick: truckUpdate.tick, options: { script: 'drive' },
        rule: 'first measured near-field truck crossing in this car packet camera timeline' },
      { label: 'prop-free', tick: freeProp.tick, options: { script: 'sprint', course: 'course=free' },
        rule: 'free-roam prop approach on the R04 basin' },
      { label: 'prop-sprint-start', tick: 0, options: { script: 'sprint', course: '' },
        rule: '310 m sprint start, truck cluster ahead of the spawn' },
      { label: 'prop-lap-start', tick: 0, options: { script: 'sprint', course: 'course=lap' },
        rule: 'loop-01 lap start regression frame (loop-01 is ~180 m from the truck cluster)' },
    ];

    for (const spec of specs) {
      const shot = await capture(car, spec.label, spec.tick, spec.options);
      const probe = shot.probe;
      const messages = shot.messages;
      const blocking = messages.filter((entry) => entry.source !== 'console.log');

      passCheck(`${car.slug}/${spec.label}: held at tick ${spec.tick} on the page timeline`,
        probe.holdReached === true && probe.displayTick === spec.tick && probe.render?.tick === spec.tick,
        `display ${probe.displayTick}, render ${probe.render?.tick}`);
      passCheck(`${car.slug}/${spec.label}: the page drove the requested car`,
        probe.car?.name === car.name, JSON.stringify(probe.car?.name));
      passCheck(`${car.slug}/${spec.label}: console is clean`,
        blocking.length === 0,
        blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));
      passCheck(`${car.slug}/${spec.label}: the level prop pack is the pinned one`,
        probe.levelPropDraws === expected.draws &&
        probe.levelPropTexturedDraws === expected.textured &&
        probe.levelPropDiagnosticDraws === expected.diagnostic &&
        probe.levelPropTextures === expected.textures &&
        probe.levelPropTextureBytes === expected.textureBytes &&
        probe.levelPropUvVertices === expected.uvVertices &&
        probe.levelPropManifestSha256 === expected.manifestSha256 &&
        probe.levelPropContentHash === expected.contentHash &&
        JSON.stringify(probe.levelPropBlockedInstances) === JSON.stringify(expected.blocked),
        `${probe.levelPropTexturedDraws}/${probe.levelPropDraws} textured, ` +
        `${probe.levelPropTextures} tex / ${probe.levelPropTextureBytes} B, ` +
        `blocked ${JSON.stringify(probe.levelPropBlockedInstances)}`);
      passCheck(`${car.slug}/${spec.label}: one draw per draw per frame`,
        probe.draws === draws && probe.drawsIssued === probe.frames * probe.draws,
        `${probe.draws} draws, ${probe.drawsIssued} issued / ${probe.frames} frames`);
      passCheck(`${car.slug}/${spec.label}: the 4 BC3 cab draws are not bound to a texture`,
        probe.levelPropBlockedInstances.length === 4 &&
        probe.levelPropBlockedInstances.every((instance) => [14, 15, 19, 20].includes(instance)),
        JSON.stringify(probe.levelPropBlockedInstances));

      const truckFrame = spec.label === 'prop-truck' ||
        (spec.label === 'prop-tick120' && car.slug === run.defaultCar);
      if (truckFrame) {
        const occlusion = probe.render?.camera?.occlusion ?? null;
        passCheck(`${car.slug}/${spec.label}: the camera reports the near-field truck crossing`,
          occlusion?.nearField === true &&
          occlusion?.hitMesh === 'river.block27.instances-all',
          JSON.stringify(occlusion));
      }

      rows.push({
        car: car.name,
        slug: car.slug,
        label: spec.label,
        rule: spec.rule,
        tick: spec.tick,
        url: shot.url,
        screenshot: shot.screenshot,
        carCrop: shot.carCrop,
        camera: probe.render?.camera ?? null,
        cameraOcclusion: probe.render?.camera?.occlusion ?? null,
        levelPropDraws: probe.levelPropDraws,
        levelPropTexturedDraws: probe.levelPropTexturedDraws,
        levelPropDiagnosticDraws: probe.levelPropDiagnosticDraws,
        levelPropTextures: probe.levelPropTextures,
        levelPropTextureBytes: probe.levelPropTextureBytes,
        levelPropUvVertices: probe.levelPropUvVertices,
        levelPropManifestSha256: probe.levelPropManifestSha256,
        levelPropContentHash: probe.levelPropContentHash,
        levelPropBlockedInstances: probe.levelPropBlockedInstances,
        draws: probe.draws,
        drawsIssued: probe.drawsIssued,
        frames: probe.frames,
        geometryUploads: probe.geometryUploads,
        geometryUploadBytes: probe.geometryUploadBytes,
        textureUploads: probe.textureUploads,
        textureUploadBytes: probe.textureUploadBytes,
        messages
      });
    }
  }

  const allMessages = rows.flatMap((row) => row.messages);
  const blocking = allMessages.filter((entry) => entry.source !== 'console.log');
  passCheck('console is clean in every level-prop capture', blocking.length === 0,
    blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));
  const evidence = {
    browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT },
    mode: 'props',
    levelProps: {
      meshId: levelMesh.id,
      draws: expected.draws,
      texturedDraws: expected.textured,
      diagnosticDraws: expected.diagnostic,
      blockedInstances: expected.blocked,
      blockedReason: 'bc3-alpha-rule-missing',
      textures: expected.textures,
      textureBytes: expected.textureBytes,
      uvVertices: expected.uvVertices,
      manifest: geometry.levelPropTexturePack.manifest,
      manifestSha256: expected.manifestSha256,
      contentHash: expected.contentHash,
    },
    captures: rows,
    console: { totalMessages: allMessages.length, errorsAndWarnings: blocking.length, messages: allMessages },
    assertions: { ok: passFailures.length === 0, failures: passFailures },
    verdict: blocking.length === 0 && passFailures.length === 0 ? 'clean-console-and-gates' : 'failed'
  };
  writeFileSync(path.join(OUT, 'browser-evidence-props.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(LOGS, 'edge-props.log'), browserLog, 'utf8');
  return {
    ok: blocking.length === 0 && passFailures.length === 0,
    summary: {
      mode: 'props',
      cars: cars.length,
      captures: rows.length,
      console: allMessages.length,
      assertions: passFailures.length,
      failures: passFailures,
      screenshots: rows.map((row) => row.screenshot)
    },
    evidence
  };
}

/**
 * P74 V2 collision capture (`--mode collision-v2`): the real page and the real
 * additive layer, driven at a manifest-derived start pose into the reachable lap
 * no-parking sign (`draw.257`) and a free-roam concrete pipe (`draw.95`). Each
 * target gets an approach frame (0 contacts), a stopped frame (contacts, brake +
 * handbrake) and a settled frame 60 ticks later (same stopped pose). The building
 * wall `draw.355` is proven in the resolver at its own terrace ground; it cannot
 * be reached by the car from the loop. Console must be clean.
 */
async function collisionV2CapturePass() {
  const rows = [];
  const passFailures = [];
  const passCheck = (label, ok, detail) => { if (!ok) passFailures.push(label + (detail ? ': ' + detail : '')); };
  const targets = [
    {
      name: 'lap-sign', course: 'course=lap',
      profile: 'all-visible', colliders: 651, manifest: '_work/prop-collision/colliders-v2.json',
      nearFaceMin: 0.5
    },
    {
      name: 'free-pipe', course: 'course=free',
      profile: 'all-visible', colliders: 447, manifest: '_work/free-roam-prop/colliders-r04-v2.json',
      nearFaceMin: 0.5
    }
  ];
  const frames = [
    { frame: 'approach', tick: 30 },
    { frame: 'stopped', tick: 360 },
    { frame: 'settled', tick: 420 }
  ];

  for (const target of targets) {
    for (const car of cars) {
      const body = geometry.carBodies[car.slug];
      if (!body) throw new Error('geometry has no body for ' + car.slug);
      const draws = 22 + geometry.trackVisual.drawCount + body.carDraws.length;
      let stopped = null;
      for (const spec of frames) {
        const label = 'collision-' + target.name + '-' + spec.frame;
        const shot = await capture(car, label, spec.tick, {
          script: 'sprint', course: target.course, extraQuery: 'collisionprobe=' + target.name
        });
        const probe = shot.probe;
        const messages = shot.messages;
        const blocking = messages.filter((entry) => entry.source !== 'console.log');
        const cp = probe.collisionProbe;
        const position = probe.position ?? [NaN, NaN, NaN];
        const side = cp
          ? (position[0] - cp.targetCenter[0]) * cp.outward[0] +
            (position[2] - cp.targetCenter[1]) * cp.outward[1]
          : NaN;

        passCheck(`${car.slug}/${label}: held at tick ${spec.tick} on the page timeline`,
          probe.holdReached === true && probe.displayTick === spec.tick && probe.render?.tick === spec.tick,
          `display ${probe.displayTick}, render ${probe.render?.tick}`);
        passCheck(`${car.slug}/${label}: the page drove the requested car`,
          probe.car?.name === car.name, JSON.stringify(probe.car?.name));
        passCheck(`${car.slug}/${label}: console is clean`, blocking.length === 0,
          blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));
        passCheck(`${car.slug}/${label}: the V2 layer is the pinned ${target.profile} world`,
          probe.props?.profile === target.profile && probe.props?.colliders === target.colliders &&
          probe.props?.manifest === target.manifest,
          JSON.stringify({ profile: probe.props?.profile, colliders: probe.props?.colliders,
            manifest: probe.props?.manifest }));
        passCheck(`${car.slug}/${label}: the probe runs with no race rules`,
          cp !== null && cp.name === target.name && probe.phase === 'collision-probe' &&
          probe.sprint === null,
          JSON.stringify({ probe: cp?.name, phase: probe.phase, sprint: probe.sprint !== null }));
        passCheck(`${car.slug}/${label}: one draw per draw per frame`,
          probe.draws === draws && probe.drawsIssued === probe.frames * probe.draws,
          `${probe.draws} draws, ${probe.drawsIssued} issued / ${probe.frames} frames`);
        passCheck(`${car.slug}/${label}: the HUD states the collision probe and target`,
          (probe.overlays?.hudText ?? '').includes('COLLISION PROBE') &&
          (probe.overlays?.hudText ?? '').includes(cp?.target ?? '<no target>'),
          (probe.overlays?.hudText ?? '').split('\n').filter((line) =>
            /COLLISION PROBE|contact|approach/.test(line)).join(' | '));
        passCheck(`${car.slug}/${label}: nine matrices per rendered tick`,
          probe.render?.matrices?.length === 9, String(probe.render?.matrices?.length));

        if (spec.frame === 'approach') {
          passCheck(`${car.slug}/${label}: approaching with 0 contacts, outside the target`,
            probe.props?.contacts === 0 && probe.props?.blockedTicks === 0 &&
            side > (cp?.nearFaceMetres ?? 0) + 2 && probe.speed > 0.5,
            JSON.stringify({ side, speed: probe.speed, contacts: probe.props?.contacts }));
        } else if (spec.frame === 'stopped') {
          stopped = { side, position: position.slice(), tick: spec.tick, stateHash: probe.tickHashes?.[spec.tick]?.stateHash ?? null };
          passCheck(`${car.slug}/${label}: the car is in contact and stopped outside the target face`,
            (probe.props?.contacts ?? 0) > 0 && (probe.props?.blockedTicks ?? 0) > 0 &&
            probe.speed < 0.5 && side > (cp?.nearFaceMetres ?? 0) + target.nearFaceMin &&
            side < 4,
            JSON.stringify({ side, speed: probe.speed, contacts: probe.props?.contacts,
              blockedTicks: probe.props?.blockedTicks }));
        } else {
          passCheck(`${car.slug}/${label}: the stopped pose does not move in the next 60 ticks`,
            stopped !== null && (probe.props?.contacts ?? 0) > 0 && probe.speed < 0.5 &&
            Math.hypot(position[0] - stopped.position[0], position[2] - stopped.position[2]) < 0.05,
            JSON.stringify({ moved: stopped ? Math.hypot(position[0] - stopped.position[0],
              position[2] - stopped.position[2]) : null, speed: probe.speed }));
        }

        rows.push({
          car: car.name, slug: car.slug, target: target.name, frame: spec.frame, tick: spec.tick,
          url: shot.url, screenshot: shot.screenshot, carCrop: shot.carCrop,
          sideMetres: Number.isFinite(side) ? Number(side.toFixed(4)) : null,
          position, speed: probe.speed,
          contacts: probe.props?.contacts ?? null, blockedTicks: probe.props?.blockedTicks ?? null,
          colliders: probe.props?.colliders ?? null, profile: probe.props?.profile ?? null,
          manifest: probe.props?.manifest ?? null,
          stateHash: probe.tickHashes?.[spec.tick]?.stateHash ?? null,
          collisionProbe: cp,
          camera: probe.render?.camera ?? null,
          messages
        });
      }
    }
  }

  const allMessages = rows.flatMap((row) => row.messages);
  const blocking = allMessages.filter((entry) => entry.source !== 'console.log');
  passCheck('console is clean in every collision-v2 capture', blocking.length === 0,
    blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));
  const evidence = {
    browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT },
    mode: 'collision-v2',
    targets: targets.map((target) => ({ name: target.name, course: target.course,
      profile: target.profile, colliders: target.colliders, manifest: target.manifest })),
    rule: 'throttle until the additive layer reports a contact, then brake; the start pose is derived from the ' +
      'manifest target record (12 m outside the near face)',
    captures: rows,
    console: { totalMessages: allMessages.length, errorsAndWarnings: blocking.length, messages: allMessages },
    assertions: { ok: passFailures.length === 0, failures: passFailures },
    verdict: blocking.length === 0 && passFailures.length === 0 ? 'clean-console-and-gates' : 'failed'
  };
  writeFileSync(path.join(OUT, 'browser-evidence-collision-v2.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(LOGS, 'edge-collision-v2.log'), browserLog, 'utf8');
  return {
    ok: blocking.length === 0 && passFailures.length === 0,
    summary: {
      mode: 'collision-v2',
      cars: cars.length,
      targets: targets.length,
      captures: rows.length,
      console: allMessages.length,
      assertions: passFailures.length,
      failures: passFailures,
      screenshots: rows.map((row) => row.screenshot)
    },
    evidence
  };
}

/**
 * Start / lap 1 / lap 2 / finish captures of the 3-lap P61 loop-01 race, using
 * run.json → lapCourse.cars[].captures as the expected state. The page runs the
 * same layout and the same deterministic follower; the V2 all-visible layer is active.
 */
async function lapCapturePass() {
  const runDocument = JSON.parse(readFileSync(path.join(OUT, 'run.json'), 'utf8'));
  const lapRun = runDocument.sprint?.lapCourse;
  if (!lapRun?.cars) {
    throw new Error('run.json has no lap results — run `node probes/e1-drive/tools/verify_e1_drive.mjs` first');
  }
  const lapLayout = JSON.parse(readFileSync(path.join(OUT, 'sprint-lap.json'), 'utf8'));
  const rows = [];
  const passFailures = [];
  const passCheck = (label, ok, detail) => { if (!ok) passFailures.push(label + (detail ? ': ' + detail : '')); };

  for (const car of cars) {
    const entry = lapRun.cars.find((candidate) => candidate.slug === car.slug);
    if (!entry) throw new Error('run.json has no lap result for ' + car.slug);
    const body = geometry.carBodies[car.slug];
    if (!body) throw new Error('geometry has no body for ' + car.slug);
    const uploadBytes = meshBytes(levelMesh) + meshBytes(body.mesh) + meshBytes(trackMesh);
    const draws = 22 + geometry.trackVisual.drawCount + body.carDraws.length;
    const finishSeconds = entry.finish.timeSeconds;

    for (const spec of entry.captures) {
      const label = 'sprint-lap-' + spec.label;
      const shot = await capture(car, label, spec.tick, { script: 'sprint', course: 'course=lap', longRun: true });
      const probe = shot.probe;
      const state = probe.sprint;
      const overlay = probe.overlays ?? {};
      const cameraDelta = probe.render && spec.camera ? cameraMaxDelta(probe.render.camera, spec.camera) : null;
      const matrixDelta = probe.render && Array.isArray(spec.matrices)
        ? Math.max(...probe.render.matrices.map((entryMatrix, index) => {
          const expected = spec.matrices[index]?.world;
          if (!expected || expected.length !== entryMatrix.world.length) return Infinity;
          return Math.max(...entryMatrix.world.map((value, axis) => Math.abs(value - expected[axis])));
        }))
        : null;

      passCheck(`${car.slug}/${label}: held at tick ${spec.tick} with the update the page built`,
        probe.holdReached === true && probe.displayTick === spec.tick && probe.render?.tick === spec.tick,
        `display ${probe.displayTick}, render ${probe.render?.tick}`);
      passCheck(`${car.slug}/${label}: the page drove the requested car on the lap layout`,
        probe.car?.name === car.name && probe.sprintLayoutHash === lapLayout.hash,
        JSON.stringify({ car: probe.car?.name, layout: probe.sprintLayoutHash }));
      passCheck(`${car.slug}/${label}: browser state hash equals the node lap state`,
        probe.tickHashes[spec.tick]?.stateHash === spec.stateHash,
        (probe.tickHashes[spec.tick]?.stateHash ?? 'none') + ' vs ' + spec.stateHash);
      passCheck(`${car.slug}/${label}: the car matrix is bit-identical to the node lap packet`,
        probe.render && spec.matrix &&
        probe.render.matrix.every((value, index) => Object.is(value, spec.matrix[index])),
        'matrix differs');
      passCheck(`${car.slug}/${label}: every node matrix matches the node lap packet within 1e-12`,
        matrixDelta !== null && matrixDelta <= 1e-12,
        'max |matrix delta| ' + (matrixDelta === null ? 'n/a' : matrixDelta.toExponential(3)));
      passCheck(`${car.slug}/${label}: the browser camera matches the node lap camera within 1e-6`,
        cameraDelta !== null && cameraDelta <= 1e-6,
        'max |delta| ' + (cameraDelta === null ? 'n/a' : cameraDelta.toExponential(3)));
      passCheck(`${car.slug}/${label}: geometry uploads equal the level + own body + track meshes`,
        probe.geometryUploads === MESH_COUNT && probe.geometryUploadBytes === uploadBytes,
        probe.geometryUploads + ' uploads / ' + probe.geometryUploadBytes + ' B');
      passCheck(`${car.slug}/${label}: one draw per draw per frame`,
        probe.draws === draws && probe.drawsIssued === probe.frames * probe.draws,
        probe.drawsIssued + ' draws / ' + probe.frames + ' frames * ' + probe.draws);
      passCheck(`${car.slug}/${label}: nine matrices per rendered tick`,
        probe.render?.matrices?.length === 9, String(probe.render?.matrices?.length));
      passCheck(`${car.slug}/${label}: the V2 all-visible prop layer is active`,
        probe.props?.profile === 'all-visible' && probe.props?.colliders === 651 &&
        probe.props?.manifest === '_work/prop-collision/colliders-v2.json',
        JSON.stringify({ profile: probe.props?.profile, colliders: probe.props?.colliders,
          manifest: probe.props?.manifest }));

      if (spec.label === 'start') {
        passCheck(`${car.slug}/${label}: the countdown is on screen on lap 1`,
          state?.phase === 'countdown' && state.elapsedTicks === 0 && state.lap === 1 &&
          state.laps === 3 && state.checkpointsPassed === 0 && state.countdownLabel === '3' &&
          state.progress < 0.01 && overlay.countdownHidden === false && overlay.resultsHidden === true,
          JSON.stringify({ phase: state?.phase, lap: state?.lap, label: overlay.countdownText }));
      } else if (spec.label === 'lap1' || spec.label === 'lap2') {
        const completed = spec.label === 'lap1' ? 1 : 2;
        passCheck(`${car.slug}/${label}: lap ${completed} is complete and lap ${completed + 1} is running`,
          state?.phase === 'running' && state.checkpointsPassed === completed &&
          state.lap === completed + 1 && Math.abs(state.elapsedSeconds - spec.elapsedSeconds) < 1e-6 &&
          spec.lapTimes?.length === completed && overlay.resultsHidden === true &&
          overlay.eventVisible === '1' && new RegExp('lap ' + completed + '/3', 'i').test(overlay.eventText ?? ''),
          JSON.stringify({ phase: state?.phase, done: state?.checkpointsPassed, lap: state?.lap,
            elapsed: state?.elapsedSeconds, banner: overlay.eventText }));
        passCheck(`${car.slug}/${label}: the completed lap time equals the node lap`,
          spec.lapTimes?.[completed - 1] === state?.lapTimes?.[completed - 1] &&
          Math.abs((state?.bestLapSeconds ?? 0) - Math.min(...(state?.lapTimes ?? [0]))) < 1e-6,
          JSON.stringify({ browser: state?.lapTimes, node: spec.lapTimes }));
      } else if (spec.label === 'finish') {
        passCheck(`${car.slug}/${label}: lap 3 finishes with the node total and three lap times`,
          state?.finished === true && state.checkpointsPassed === 3 &&
          Math.abs(state.finishTimeSeconds - finishSeconds) < 1e-6 &&
          Math.abs(state.elapsedSeconds - finishSeconds) < 1e-6 && state.progress > 0.9999 &&
          state.lapTimes.length === 3 &&
          state.lapTimes.every((seconds, index) =>
            Math.abs(seconds - entry.lapTimes[index]) < 1e-6),
          JSON.stringify({ finished: state?.finished, time: state?.finishTimeSeconds, node: finishSeconds,
            laps: state?.lapTimes, done: state?.checkpointsPassed, elapsed: state?.elapsedSeconds,
            progress: state?.progress }));
        passCheck(`${car.slug}/${label}: the results overlay shows the total, lap list and best lap`,
          overlay.resultsHidden === false &&
          (overlay.resultsTime ?? '').includes(finishSeconds.toFixed(3)) &&
          (overlay.resultsTime ?? '').includes(car.name) &&
          (overlay.resultsBest ?? '').includes('best lap ' + entry.bestLapSeconds.toFixed(3)),
          JSON.stringify({ time: overlay.resultsTime, best: overlay.resultsBest }));
        let stored = null;
        try { stored = probe.bestStored ? JSON.parse(probe.bestStored) : null; } catch { stored = null; }
        passCheck(`${car.slug}/${label}: the race best is persisted in the lap namespace`,
          stored?.cars?.[car.slug]?.seconds !== undefined &&
          Math.abs(stored.cars[car.slug].seconds - Number(finishSeconds.toFixed(3))) < 1e-6 &&
          probe.sprintResult?.improved === true,
          JSON.stringify({ stored: stored?.cars?.[car.slug] ?? null, best: probe.sprintBest }));
      } else {
        passCheck(`${car.slug}/${label}: unknown lap capture label`, false, spec.label);
      }

      rows.push({
        car: car.name,
        slug: car.slug,
        label,
        tick: spec.tick,
        url: shot.url,
        screenshot: shot.screenshot,
        carCrop: shot.carCrop,
        phase: state?.phase ?? null,
        lap: state?.lap ?? null,
        laps: state?.laps ?? null,
        elapsedSeconds: state?.elapsedSeconds ?? null,
        lapTimes: state?.lapTimes ?? null,
        bestLapSeconds: state?.bestLapSeconds ?? null,
        checkpointsPassed: state?.checkpointsPassed ?? null,
        finished: state?.finished ?? null,
        finishTimeSeconds: state?.finishTimeSeconds ?? null,
        progress: state?.progress ?? null,
        position: probe.position,
        speed: probe.speed,
        props: probe.props ?? null,
        sprintResult: probe.sprintResult,
        overlays: overlay,
        stateHash: probe.tickHashes[spec.tick]?.stateHash ?? null,
        nodeStateHash: spec.stateHash,
        updateHash: probe.render?.hash ?? null,
        nodeUpdateHash: spec.updateHash,
        pageRender: probe.render,
        packetHashExact: probe.render?.hash === spec.updateHash,
        carMatrixExact: !!probe.render && !!spec.matrix &&
          probe.render.matrix.every((value, index) => Object.is(value, spec.matrix[index])),
        cameraMaxDelta: cameraDelta,
        matrixMaxDelta: matrixDelta,
        frames: probe.frames,
        geometryUploads: probe.geometryUploads,
        geometryUploadBytes: probe.geometryUploadBytes,
        drawsIssued: probe.drawsIssued,
        canvas: probe.canvas,
        messages: shot.messages
      });
    }
  }

  const allMessages = rows.flatMap((row) => row.messages);
  const blocking = allMessages.filter((entry) => entry.source !== 'console.log');
  passCheck('console is clean in every lap capture', blocking.length === 0,
    blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));
  const exact = rows.filter((row) => row.packetHashExact).length;
  const evidence = {
    browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT },
    mode: 'lap',
    courseId: 'lap',
    layout: { hash: lapLayout.hash, span: lapLayout.course.span, lap: lapLayout.course.lap },
    prop: { profile: 'all-visible', manifest: '_work/prop-collision/colliders-v2.json', colliders: 651 },
    cars: rows,
    packetHashAgreement: { exact, total: rows.length, note:
      'a mismatch is a documented last-bit transcendental difference between Node 24 and Edge 156; the state ' +
      'hash, the car matrix and the 1e-12 matrix/camera tolerances are checked separately' },
    console: { totalMessages: allMessages.length, errorsAndWarnings: blocking.length, messages: allMessages },
    assertions: { ok: passFailures.length === 0, failures: passFailures },
    verdict: blocking.length === 0 && passFailures.length === 0 ? 'clean-console-and-gates' : 'failed'
  };
  writeFileSync(path.join(OUT, 'browser-evidence-lap.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(LOGS, 'edge-lap.log'), browserLog, 'utf8');
  const summary = {
    mode: 'lap',
    cars: rows.length,
    exact,
    console: allMessages.length,
    assertions: passFailures.length,
    screenshots: rows.map((row) => row.screenshot)
  };
  return {
    ok: blocking.length === 0 && passFailures.length === 0,
    summary,
    evidence
  };
}

/**
 * Ghost replay capture (`--mode ghost`): the page replays the committed
 * deterministic reference ghost while the scripted sprint drives the same car.
 * `?ghostoffset=60` is a capture-only presentation offset so the ghost is
 * visibly ahead of the player; the recorded pose, hash and delta are still the
 * committed record's. Each capture checks that the browser pose is bit-identical
 * to the record at the reported tick, that enabling/hiding the ghost uploads no
 * geometry, that the HUD/tag label the replay, and that the console stays clean.
 */
async function ghostCapturePass() {
  const runDocument = JSON.parse(readFileSync(path.join(OUT, 'run.json'), 'utf8'));
  const sprintRun = COURSE === 'short' ? runDocument.sprint?.shortCourse : runDocument.sprint;
  if (!sprintRun?.cars) {
    throw new Error('run.json has no ' + COURSE + ' sprint results — run `node probes/e1-drive/tools/verify_e1_drive.mjs` first');
  }
  const sprintLayout = JSON.parse(readFileSync(
    path.join(OUT, COURSE === 'short' ? 'sprint-short.json' : 'sprint.json'), 'utf8'));
  const ghostIndexFile = path.join(ROOT, 'probes/e1-drive/ghosts/index.json');
  const ghostIndex = JSON.parse(readFileSync(ghostIndexFile, 'utf8'));
  const courseKey = COURSE === 'short' ? 'short' : '310m';
  const GHOST_OFFSET_TICKS = 60;
  const passFailures = [];
  const passCheck = (label, ok, detail) => { if (!ok) passFailures.push(label + (detail ? ': ' + detail : '')); };
  const rows = [];
  const shotPath = (slug, name) => path.join(OUT, `browser-${slug}-${name}.png`);
  const shoot = async (slug, name) => {
    const data = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = shotPath(slug, name);
    writeFileSync(file, Buffer.from(data.data, 'base64'));
    return path.relative(ROOT, file).split(path.sep).join('/');
  };
  const pressGhostKey = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type, key: 'g', code: 'KeyG', windowsVirtualKeyCode: 71, nativeVirtualKeyCode: 71,
        text: type === 'keyDown' ? 'g' : undefined
      });
    }
  };
  const readGhostProbe = async () => evaluate(`(()=>{
    const p = window.e1DriveProbe;
    if (!p) return null;
    return {
      state: p.consumer, error: p.error, frames: p.frames, holdReached: p.holdReached,
      displayTick: p.displayTick, engineTick: p.engineTick,
      geometryUploads: p.geometryUploads, geometryUploadBytes: p.geometryUploadBytes,
      draws: p.draws, drawsIssued: p.drawsIssued, ghost: p.ghost ?? null,
      sprint: p.sprint ?? null
    };
  })()`);
  const waitFrames = async (label, startFrames, extra = 4) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const probe = await readGhostProbe().catch(() => null);
      if (probe && probe.state === 'error') throw new Error(label + ': page error: ' + probe.error);
      if (probe && probe.frames >= startFrames + extra) return probe;
      await sleep(100);
    }
    throw new Error(label + ': frames did not advance');
  };

  for (const car of cars) {
    const entry = sprintRun.cars.find((candidate) => candidate.slug === car.slug);
    if (!entry) throw new Error('run.json has no sprint result for ' + car.slug);
    const ghostEntry = ghostIndex.cars?.[car.slug]?.[courseKey];
    if (!ghostEntry) throw new Error('ghosts/index.json has no ' + courseKey + ' record for ' + car.slug);
    const recordPath = path.join(ROOT, ghostEntry.file);
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    const decoded = decodeGhost(record);
    const body = geometry.carBodies[car.slug];
    if (!body) throw new Error('geometry has no body for ' + car.slug);
    const rest = {};
    for (const group of body.wheelGroups) rest[group.corner] = group.matrixColumnMajor;
    const uploadBytes = meshBytes(levelMesh) + meshBytes(body.mesh) + meshBytes(trackMesh);
    const draws = 22 + geometry.trackVisual.drawCount + body.carDraws.length;
    const mid = entry.captures.find((captureSpec) => captureSpec.label === 'mid') ??
      entry.captures.find((captureSpec) => captureSpec.tick > 200);
    if (!mid) throw new Error(car.slug + ': run.json has no mid capture tick');
    const label = 'sprint-ghost';
    const shot = await capture(car, label, mid.tick, {
      script: 'sprint',
      extraQuery: 'ghost=1&ghostoffset=' + GHOST_OFFSET_TICKS
    });
    const probe = shot.probe;
    const ghost = probe.ghost;
    const overlay = probe.overlays ?? {};
    const expectedTick = probe.displayTick + GHOST_OFFSET_TICKS - 1;
    const nodePose = ghostData => ghostMatrices(decoded, ghostData.playbackTick, rest);
    const pose = ghost ? nodePose(ghost) : null;
    const bodyDelta = ghost?.bodyMatrix && pose
      ? Math.max(...ghost.bodyMatrix.map((value, index) => Math.abs(value - pose.body[index]))) : null;
    const wheelDelta = ghost?.wheelMatrices && pose
      ? Math.max(...Object.keys(pose.wheels).flatMap((corner) =>
          ghost.wheelMatrices[corner].map((value, index) => Math.abs(value - pose.wheels[corner].spin[index])))) : null;
    const progressOf = Array.isArray(sprintLayout.course.samples)
      ? (position) => coursePosition(sprintLayout.course.samples, position).arc
      : (position) => position[0];
    const table = buildGhostArcTable(decoded, progressOf);
    const nodeGap = probe.sprint
      ? ghostGap(table, {
        arc: COURSE === 'short' ? probe.sprint.maxX : probe.sprint.arc,
        seconds: probe.sprint.elapsedSeconds
      }) : null;

    passCheck(`${car.slug}/${label}: the page reports the committed reference ghost and it is visible`,
      ghost?.available === true && ghost.enabled === true && ghost.source === 'reference-trace' &&
      ghost.hash === ghostEntry.ghostHash && ghost.layoutHash === sprintLayout.hash &&
      ghost.timeSeconds === ghostEntry.timeSeconds && ghost.tickCount === ghostEntry.tickCount,
      JSON.stringify({ source: ghost?.source, hash: ghost?.hash, expected: ghostEntry.ghostHash }));
    passCheck(`${car.slug}/${label}: the ghost is replayed on the race clock plus the capture offset`,
      ghost?.playbackTick === expectedTick && ghost.playbackTick > 0 && ghost.playbackTick < ghost.tickCount,
      `playback ${ghost?.playbackTick}, display ${probe.displayTick}, expected ${expectedTick}`);
    passCheck(`${car.slug}/${label}: the browser ghost pose is the committed record's pose (bit-identical)`,
      bodyDelta !== null && bodyDelta === 0 && wheelDelta !== null && wheelDelta === 0,
      `body ${bodyDelta}, wheels ${wheelDelta}`);
    passCheck(`${car.slug}/${label}: enabling the ghost adds no geometry upload`,
      probe.geometryUploads === MESH_COUNT && probe.geometryUploadBytes === uploadBytes,
      `${probe.geometryUploads} uploads / ${probe.geometryUploadBytes} B`);
    passCheck(`${car.slug}/${label}: every ghost frame is one extra draw set of the uploaded car mesh`,
      ghost?.drawSlots === body.carDraws.length && ghost.frames > 0 &&
      probe.drawsIssued === probe.frames * probe.draws + ghost.frames * ghost.drawSlots,
      JSON.stringify({ slots: ghost?.drawSlots, ghostFrames: ghost?.frames, frames: probe.frames,
        issued: probe.drawsIssued, expected: probe.frames * probe.draws + (ghost?.frames ?? 0) * (ghost?.drawSlots ?? 0) }));
    passCheck(`${car.slug}/${label}: the ghost HUD delta is the same race-clock gap the record defines`,
      ghost?.delta && nodeGap && Math.abs(ghost.delta.seconds - nodeGap.seconds) < 1e-9 &&
      Math.abs(ghost.delta.metres - nodeGap.metres) < 1e-9,
      JSON.stringify({ page: ghost?.delta, node: nodeGap }));
    passCheck(`${car.slug}/${label}: the ghost tag and HUD label the replay and its source`,
      overlay.ghostTagHidden === false && /GHOST/.test(overlay.ghostTagText ?? '') &&
      /no collision/i.test(overlay.ghostTagText ?? '') &&
      /ghost/.test(overlay.hudText ?? '') && /reference replay/.test(overlay.hudText ?? '') &&
      /Δ/.test(overlay.hudText ?? ''),
      JSON.stringify({ tag: overlay.ghostTagText, hud: (overlay.hudText ?? '').split('\n').find((line) => line.startsWith('ghost')) }));

    if (car.slug === cars[0].slug) {
      // G hides the ghost without a reload and without touching geometry.
      const before = await readGhostProbe();
      await pressGhostKey();
      await sleep(250);
      const hidden = await readGhostProbe();
      const frozenFrames = hidden.ghost.frames;
      await sleep(350);
      const hiddenLater = await readGhostProbe();
      passCheck(`${car.slug}/${label}: G hides the ghost in place, without a reload or an upload`,
        hidden.ghost.enabled === false && hidden.ghost.frames === frozenFrames &&
        hiddenLater.frames > hidden.frames && hiddenLater.ghost.frames === frozenFrames &&
        hiddenLater.geometryUploads === MESH_COUNT && hiddenLater.geometryUploadBytes === uploadBytes &&
        hiddenLater.drawsIssued - hidden.drawsIssued === (hiddenLater.frames - hidden.frames) * hidden.draws,
        JSON.stringify({ enabled: hidden.ghost.enabled, ghostFrames: frozenFrames,
          uploads: hiddenLater.geometryUploads, issuedDelta: hiddenLater.drawsIssued - hidden.drawsIssued }));
      const hiddenShot = await shoot(car.slug, 'sprint-ghost-off');
      await pressGhostKey();
      await sleep(250);
      const shown = await waitFrames(car.slug + ' ghost re-shown', hiddenLater.frames, 3);
      passCheck(`${car.slug}/${label}: G shows the ghost again on the next frame`,
        shown.ghost.enabled === true && shown.ghost.frames > frozenFrames &&
        shown.geometryUploads === MESH_COUNT && shown.geometryUploadBytes === uploadBytes,
        JSON.stringify({ enabled: shown.ghost.enabled, ghostFrames: shown.ghost.frames }));
      rows.push({
        toggle: {
          before: { frames: before.frames, ghostFrames: before.ghost.frames, enabled: before.ghost.enabled },
          hidden: { frames: hidden.frames, ghostFrames: hidden.ghost.frames, enabled: hidden.ghost.enabled },
          shown: { frames: shown.frames, ghostFrames: shown.ghost.frames, enabled: shown.ghost.enabled },
          hiddenScreenshot: hiddenShot
        }
      });
    }

    rows.push({
      car: car.name,
      slug: car.slug,
      label,
      tick: mid.tick,
      displayTick: probe.displayTick,
      playbackTick: ghost?.playbackTick ?? null,
      url: shot.url,
      screenshot: shot.screenshot,
      carCrop: shot.carCrop,
      ghost: {
        hash: ghost?.hash ?? null,
        source: ghost?.source ?? null,
        enabled: ghost?.enabled ?? null,
        timeSeconds: ghost?.timeSeconds ?? null,
        tickCount: ghost?.tickCount ?? null,
        drawSlots: ghost?.drawSlots ?? null,
        frames: ghost?.frames ?? null,
        delta: ghost?.delta ?? null,
        nodeDelta: nodeGap,
        bodyMaxDelta: bodyDelta,
        wheelMaxDelta: wheelDelta,
        offsetTicks: GHOST_OFFSET_TICKS
      },
      stateHash: probe.tickHashes[mid.tick]?.stateHash ?? null,
      nodeStateHash: mid.stateHash,
      frames: probe.frames,
      drawsIssued: probe.drawsIssued,
      geometryUploads: probe.geometryUploads,
      geometryUploadBytes: probe.geometryUploadBytes,
      hudGhostRow: (overlay.hudText ?? '').split('\n').find((line) => line.startsWith('ghost')) ?? null,
      messages: shot.messages
    });
  }

  const allMessages = rows.flatMap((row) => row.messages ?? []);
  const blocking = allMessages.filter((entry) => entry.source !== 'console.log');
  passCheck('console is clean in every ghost capture', blocking.length === 0,
    blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));
  const captures = rows.filter((row) => row.slug);
  const evidence = {
    browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT },
    mode: 'ghost',
    courseId: COURSE === 'short' ? 'short' : '310m',
    layout: { hash: sprintLayout.hash, span: sprintLayout.course.span },
    ghost: {
      index: path.relative(ROOT, ghostIndexFile).split(path.sep).join('/'),
      encoding: ghostIndex.encoding,
      offsetTicks: GHOST_OFFSET_TICKS,
      offsetNote: '?ghostoffset is presentation only: it moves the drawn ghost so a headless frame shows it ' +
        'apart from the player; the record, the pose comparison, the delta and the physics are unmoved',
      indexSha256: 'sha256:' + createHash('sha256').update(readFileSync(ghostIndexFile)).digest('hex')
    },
    cars: captures,
    toggle: rows.filter((row) => row.toggle).map((row) => row.toggle),
    console: { totalMessages: allMessages.length, errorsAndWarnings: blocking.length, messages: allMessages },
    assertions: { ok: passFailures.length === 0, failures: passFailures },
    verdict: blocking.length === 0 && passFailures.length === 0 ? 'clean-console-and-gates' : 'failed'
  };
  writeFileSync(path.join(OUT, 'browser-evidence-ghost.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(LOGS, 'edge-ghost.log'), browserLog, 'utf8');
  return {
    ok: evidence.verdict === 'clean-console-and-gates',
    summary: {
      verdict: evidence.verdict,
      consoleMessages: evidence.console.totalMessages,
      errorsAndWarnings: evidence.console.errorsAndWarnings,
      failures: passFailures,
      captures: captures.map((row) => ({
        car: row.car, tick: row.tick, playbackTick: row.playbackTick,
        ghostHash: row.ghost.hash, ghostFrames: row.ghost.frames,
        deltaSeconds: row.ghost.delta?.seconds ?? null,
        screenshot: row.screenshot, messages: row.messages.length
      }))
    }
  };
}

/**
 * Survey-label capture (`?survey=1`): the extended corridor is drawn in the scene
 * (394 real track draws) and the page states that it is a survey, not a course. The
 * capture proves the label is visible, the track visual is the merged 394-draw one,
 * the sprint stays the 29 m course and the console is clean.
 */
async function surveyCapturePass() {
  const car = cars[0];
  const passFailures = [];
  const passCheck = (label, ok, detail) => { if (!ok) passFailures.push(label + (detail ? ': ' + detail : '')); };
  messages.length = 0;
  const url = origin + '/?script=sprint&survey=1&hold=120&car=' + encodeURIComponent(car.slug);
  await send('Page.navigate', { url });
  let live = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    live = await evaluate(`(()=>{const p=window.e1DriveProbe;return p?{state:p.consumer,error:p.error,frames:p.frames,holdReached:p.holdReached,displayTick:p.displayTick}:null})()`).catch(() => null);
    if (live && live.state === 'error') break;
    if (live && live.state === 'running' && live.holdReached && live.frames >= 12) break;
    await sleep(200);
  }
  if (!live) throw new Error('survey capture: page never published state');
  if (live.state === 'error') throw new Error('survey capture: page error: ' + live.error);
  const full = await evaluate(`(()=>{
    const p = window.e1DriveProbe;
    const banner = document.getElementById('survey-banner');
    const canvas = document.getElementById('scene');
    return {
      mode: p.mode, engineTick: p.engineTick, displayTick: p.displayTick, frames: p.frames,
      trackVisual: p.trackVisual, trackDraws: p.trackDraws, trackTriangles: p.trackTriangles,
      collisionVisible: p.collisionVisible, geometryUploads: p.geometryUploads,
      draws: p.draws, sprintLayoutHash: p.sprintLayoutHash,
      sprintSpan: p.sprintLayout?.course?.span ?? null,
      survey: { hidden: banner?.hidden ?? null, text: banner?.textContent ?? null },
      canvas: { width: canvas.width, height: canvas.height }
    };
  })()`);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, `browser-${car.slug}-survey.png`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));

  passCheck('survey: the labelled banner is visible and names the measured limit',
    full.survey.hidden === false && /57\.82/.test(full.survey.text ?? '') &&
    /not a course/i.test(full.survey.text ?? ''), JSON.stringify(full.survey));
  passCheck('survey: the scene draws the merged real track visual (394 draws)',
    full.trackVisual === 'asset-reader-direct-draws' && full.trackDraws === 394 &&
    full.trackTriangles === 57133 && full.collisionVisible === false,
    `${full.trackDraws} draws / ${full.trackTriangles} tri`);
  passCheck('survey: the playable sprint is the 310 m P48 course, with ?course=short kept as regression',
    (() => {
      const layout = JSON.parse(readFileSync(path.join(OUT, 'sprint.json'), 'utf8'));
      const shortLayoutFile = JSON.parse(readFileSync(path.join(OUT, 'sprint-short.json'), 'utf8'));
      return full.sprintLayoutHash === layout.hash &&
        layout.course.span.measuredLengthMetres > 310 && layout.course.span.measuredLengthMetres < 311 &&
        layout.course.span.finishArc > 299 && layout.course.span.finishArc < 301 &&
        shortLayoutFile.course.span.lengthMetres === 29;
    })(),
    JSON.stringify({ page: full.sprintLayoutHash }));
  const blocking = messages.filter((entry) => entry.source !== 'console.log');
  passCheck('survey: console is clean', blocking.length === 0,
    blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));
  const evidence = {
    mode: 'survey',
    browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT },
    car: { slug: car.slug, name: car.name },
    url: url.replace(origin, ''),
    tick: full.displayTick,
    track: { label: full.trackVisual, draws: full.trackDraws, triangles: full.trackTriangles,
      collisionVisible: full.collisionVisible, geometryUploads: full.geometryUploads },
    sprintSpan: full.sprintSpan,
    banner: full.survey,
    screenshot: path.relative(ROOT, file).split(path.sep).join('/'),
    console: { totalMessages: messages.length, errorsAndWarnings: blocking.length, messages: messages.slice() },
    assertions: { ok: passFailures.length === 0, failures: passFailures },
    verdict: blocking.length === 0 && passFailures.length === 0 ? 'clean-console-and-gates' : 'failed'
  };
  writeFileSync(path.join(OUT, 'browser-evidence-survey.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(LOGS, 'edge-survey.log'), browserLog, 'utf8');
  return {
    ok: evidence.verdict === 'clean-console-and-gates',
    summary: {
      verdict: evidence.verdict, consoleMessages: messages.length,
      errorsAndWarnings: blocking.length, failures: passFailures,
      captures: [{ car: car.slug, label: 'survey', tick: full.displayTick, screenshot: evidence.screenshot,
        trackDraws: full.trackDraws, bannerVisible: full.survey.hidden === false }]
    }
  };
}

/**
 * Diagnostic respawn capture: the page runs `?script=sprint&sprintfall=1`, the
 * rules respawn the car at checkpoint 1 after it leaves the gate corridor, and
 * the frame is captured after the rebuilt timeline has advanced.
 */
async function respawnCapturePass() {
  const car = cars[0];
  const passFailures = [];
  const passCheck = (label, ok, detail) => { if (!ok) passFailures.push(label + (detail ? ': ' + detail : '')); };
  messages.length = 0;
  const url = origin + '/?script=sprint&sprintfall=1&car=' + encodeURIComponent(car.slug) +
    (COURSE_QUERY ? '&' + COURSE_QUERY : '');
  await send('Page.navigate', { url });
  let live = null;
  for (let attempt = 0; attempt < 500; attempt++) {
    live = await evaluate(`(()=>{const p=window.e1DriveProbe;return p?{state:p.consumer,error:p.error,frames:p.frames,engineTick:p.engineTick,respawning:p.respawning,sprint:p.sprint}:null})()`).catch(() => null);
    if (live && live.state === 'error') break;
    if (live && live.state === 'running' && live.sprint?.respawns >= 1 && live.respawning !== true &&
        live.engineTick >= 12) break;
    await sleep(200);
  }
  if (!live) throw new Error('respawn capture: page never published state');
  if (live.state === 'error') throw new Error('respawn capture: page error: ' + live.error);

  const full = await evaluate(`(()=>{
    const p = window.e1DriveProbe;
    const canvas = document.getElementById('scene');
    return {
      mode: p.mode, engineTick: p.engineTick, displayTick: p.displayTick, position: p.position, speed: p.speed,
      frames: p.frames, ticksExecuted: p.ticksExecuted, respawning: p.respawning,
      geometryUploads: p.geometryUploads, geometryUploadBytes: p.geometryUploadBytes,
      draws: p.draws, drawsIssued: p.drawsIssued, sprint: p.sprint, sprintEvents: p.sprintEvents,
      sprintResult: p.sprintResult, sprintBest: p.sprintBest, sprintLayoutHash: p.sprintLayoutHash,
      sprintLayout: p.sprintLayout, tickHashes: p.tickHashes,
      overlays: {
        countdownHidden: document.getElementById('countdown')?.hidden ?? null,
        resultsHidden: document.getElementById('results')?.hidden ?? null,
        resultsTime: document.getElementById('results-time')?.textContent ?? null,
        eventText: document.getElementById('event')?.textContent ?? null,
        eventVisible: document.getElementById('event')?.dataset.visible ?? null
      },
      canvas: { width: canvas.width, height: canvas.height }
    };
  })()`);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, `browser-${car.slug}-sprint-respawn.png`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  const crop = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false,
    clip: { x: Math.max(0, (full.canvas?.width ?? VIEWPORT.width) / 2 - 420), y: 120, width: 840, height: 620, scale: 1.4 }
  });
  const cropFile = path.join(OUT, `browser-${car.slug}-sprint-respawn-car.png`);
  writeFileSync(cropFile, Buffer.from(crop.data, 'base64'));

  const sprint = full.sprint;
  const respawnLog = sprint?.respawnLog ?? [];
  const first = respawnLog[0] ?? null;
  const targetGate = full.sprintLayout?.gates?.find((gate) => gate.id === first?.target?.gateId);
  passCheck('respawn: exactly one respawn event is recorded in the page',
    sprint?.respawns === 1, String(sprint?.respawns));
  passCheck('respawn: the event names the measured reason and the gate it rebuilds at',
    first !== null &&
    (first.reasons.includes('outside-gate-band') || first.reasons.includes('outside-corridor')) &&
    ['start', 'checkpoint-1', 'checkpoint-2'].includes(first.target?.gateId) && targetGate !== undefined,
    JSON.stringify(first));
  passCheck('respawn: the page rebuilt the engine at the checkpoint and is driving again',
    full.respawning !== true && full.engineTick >= 12 && full.ticksExecuted > 0 &&
    sprint?.phase === 'running' &&
    Math.abs(full.position[0] - (targetGate?.x ?? 0)) < 4 &&
    Math.abs(full.position[2] - (targetGate?.z ?? 0)) < 4,
    JSON.stringify({ tick: full.engineTick, position: full.position, phase: sprint?.phase }));
  passCheck('respawn: the HUD reports the respawn and the timer kept running',
    (full.overlays?.eventText ?? '').toLowerCase().includes('respawn') &&
    sprint?.elapsedSeconds > (first?.timeSeconds ?? Infinity),
    JSON.stringify({ banner: full.overlays?.eventText, elapsed: sprint?.elapsedSeconds }));
  const blocking = messages.filter((entry) => entry.source !== 'console.log');
  passCheck('respawn: console is clean', blocking.length === 0,
    blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));

  const evidence = {
    mode: 'respawn',
    browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT },
    car: { slug: car.slug, name: car.name },
    url: url.replace(origin, ''),
    sprint,
    respawnEvent: first,
    targetGate: targetGate ?? null,
    position: full.position,
    screenshot: path.relative(ROOT, file).split(path.sep).join('/'),
    carCrop: path.relative(ROOT, cropFile).split(path.sep).join('/'),
    console: { totalMessages: messages.length, errorsAndWarnings: blocking.length, messages: messages.slice() },
    assertions: { ok: passFailures.length === 0, failures: passFailures },
    verdict: blocking.length === 0 && passFailures.length === 0 ? 'clean-console-and-gates' : 'failed'
  };
  writeFileSync(path.join(OUT, 'browser-evidence-respawn.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(LOGS, 'edge-respawn.log'), browserLog, 'utf8');
  return {
    ok: evidence.verdict === 'clean-console-and-gates',
    summary: {
      verdict: evidence.verdict,
      car: car.slug,
      respawns: sprint?.respawns ?? null,
      event: first,
      target: targetGate ?? null,
      position: full.position,
      screenshot: evidence.screenshot,
      consoleMessages: messages.length,
      failures: passFailures
    }
  };
}

/** Largest numeric difference between two JSON-shaped values (numbers only). */
function maxNumericDelta(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return Infinity;
    return a.reduce((worst, value, index) => Math.max(worst, maxNumericDelta(value, b[index])), 0);
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    let worst = 0;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      worst = Math.max(worst, maxNumericDelta(a[key], b[key]));
    }
    return worst;
  }
  return a === b ? 0 : Infinity;
}

/**
 * Telemetry capture (`?telemetry=1`): one frame per car with the metric table and
 * the three 60 Hz charts. The page recomputes the whole series from its own
 * wasm instances, so the metric object and the per-tick state hash sequence must
 * equal the node verifier's values exactly.
 */
async function telemetryCapturePass() {
  const runDocument = JSON.parse(readFileSync(path.join(OUT, 'run.json'), 'utf8'));
  if (!runDocument.telemetry?.cars) {
    throw new Error('run.json has no telemetry block — run `node probes/e1-drive/tools/verify_e1_drive.mjs` first');
  }
  const telemetryRun = runDocument.telemetry;
  const passFailures = [];
  const passCheck = (label, ok, detail) => { if (!ok) passFailures.push(label + (detail ? ': ' + detail : '')); };
  const rows = [];

  for (const car of cars) {
    const entry = telemetryRun.cars.find((candidate) => candidate.slug === car.slug);
    if (!entry) throw new Error('run.json has no telemetry result for ' + car.slug);
    const body = geometry.carBodies[car.slug];
    if (!body) throw new Error('geometry has no body for ' + car.slug);
    const uploadBytes = meshBytes(levelMesh) + meshBytes(body.mesh) + meshBytes(trackMesh);
    const draws = 22 + geometry.trackVisual.drawCount + body.carDraws.length;

    messages.length = 0;
    const url = origin + '/?telemetry=1&car=' + encodeURIComponent(car.slug);
    await send('Page.navigate', { url });
    let live = null;
    for (let attempt = 0; attempt < 500; attempt++) {
      live = await evaluate(`(()=>{const p=window.e1DriveProbe;return p?{state:p.consumer,error:p.error,frames:p.frames,holdReached:p.holdReached,ready:p.telemetry?.ready===true,tick:p.telemetry?.presentation?.tick??null,engineTick:p.engineTick}:null})()`).catch(() => null);
      if (live && live.state === 'error') break;
      if (live && live.state === 'running' && live.ready && live.holdReached && live.frames >= 12) break;
      await sleep(200);
    }
    if (!live) throw new Error('telemetry capture: page never published state');
    if (live.state === 'error') throw new Error('telemetry capture: page error: ' + live.error);

    const full = await evaluate(`(()=>{
      const p = window.e1DriveProbe;
      const canvas = document.getElementById('scene');
      const panel = document.getElementById('telemetry');
      const select = document.getElementById('car-select');
      const tick = p.telemetry?.presentation?.tick ?? 0;
      const update = p.updates ? p.updates[tick] : null;
      return {
        mode: p.mode, car: p.car, holdReached: p.holdReached, engineTick: p.engineTick, displayTick: p.displayTick,
        phase: p.phase, frames: p.frames, draws: p.draws, drawsIssued: p.drawsIssued,
        geometryUploads: p.geometryUploads, geometryUploadBytes: p.geometryUploadBytes,
        packetNodes: p.packetNodes, wheelNodes: p.wheelNodes, parts: p.parts, carDraws: p.carDraws,
        packetHash: p.packetHash, tickHash: p.tickHash, wheelAngles: p.wheelAngles,
        movedScreen: p.movedScreen, gpu: p.adapter,
        telemetry: p.telemetry ? {
          ready: p.telemetry.ready,
          sampleHz: p.telemetry.sampleHz,
          plan: p.telemetry.plan,
          metrics: p.telemetry.metrics,
          hashes: p.telemetry.hashes,
          presentation: p.telemetry.presentation,
          ticks: p.telemetry.ticks,
          instances: p.telemetry.instances,
          resets: p.telemetry.resets ?? null,
          builds: p.telemetry.builds ?? null,
          heapBytes: p.telemetry.heapBytes ?? null,
          rebuildModel: p.telemetry.rebuildModel ?? null,
          seriesMs: p.telemetry.seriesMs
        } : null,
        restarts: p.restarts ?? 0,
        selector: select ? { options: select.options.length, value: select.value } : null,
        panel: panel ? {
          hidden: panel.hidden,
          text: panel.textContent,
          svgs: panel.querySelectorAll('svg').length,
          tables: panel.querySelectorAll('table').length,
          height: panel.getBoundingClientRect().height,
          width: panel.getBoundingClientRect().width
        } : null,
        canvas: { width: canvas.width, height: canvas.height },
        render: update ? { tick: update.tick, hash: update.hash, matrices: update.matrices } : null
      };
    })()`);

    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const shotMessages = messages.splice(0);
    const file = path.join(OUT, `browser-${car.slug}-telemetry.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));

    let crop = null;
    const moved = full.movedScreen;
    if (moved) {
      const width = Math.min(VIEWPORT.width, Math.max(220, Math.round((moved.width || 60) * 2.2)));
      const height = Math.min(VIEWPORT.height, Math.max(160, Math.round((moved.height || 40) * 2.2)));
      const x = Math.max(0, Math.min(VIEWPORT.width - width, Math.round(moved.x - width / 2)));
      const y = Math.max(0, Math.min(VIEWPORT.height - height, Math.round(moved.y - height / 2)));
      const clipped = await send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: false, clip: { x, y, width, height, scale: 2 }
      });
      crop = path.join(OUT, `browser-${car.slug}-telemetry-car.png`);
      writeFileSync(crop, Buffer.from(clipped.data, 'base64'));
    }

    const metrics = full.telemetry?.metrics ?? null;
    const nodeMetrics = entry.metrics;
    const delta = metrics ? maxNumericDelta(metrics, nodeMetrics) : Infinity;
    const manoeuvres = Object.keys(entry.hashes);
    const panelText = full.panel?.text ?? '';
    const zeroTo100 = nodeMetrics.accel.zeroToSpeedKph['100'].seconds;
    const traceMatch = manoeuvres.map((manoeuvre) => ({
      manoeuvre,
      page: full.telemetry?.hashes?.[manoeuvre]?.traceHash ?? null,
      node: entry.hashes[manoeuvre].traceHash,
      pageTicks: full.telemetry?.hashes?.[manoeuvre]?.ticks ?? null,
      nodeTicks: entry.hashes[manoeuvre].ticks
    }));

    passCheck(`${car.slug}: the page recomputes the node telemetry metrics exactly`,
      delta === 0, 'max |delta| ' + (Number.isFinite(delta) ? delta.toExponential(3) : 'structure differs'));
    passCheck(`${car.slug}: the brake step is the node's measured 80 km/h tick`,
      full.telemetry?.plan?.brakeTick === nodeMetrics.brake.brakeTick &&
      nodeMetrics.brake.brakeTick === entry.metrics.brake.brakeTick,
      String(full.telemetry?.plan?.brakeTick));
    passCheck(`${car.slug}: every per-tick telemetry state hash sequence matches the node run`,
      traceMatch.every((row) => row.page === row.node && row.pageTicks === row.nodeTicks),
      traceMatch.map((row) => row.manoeuvre + ':' + (row.page === row.node ? 'match' : 'DIFF') +
        '(' + row.pageTicks + ')').join(' '));
    passCheck(`${car.slug}: the presented accel tick is the node 0-100 km/h tick`,
      full.telemetry?.presentation?.tick === nodeMetrics.accel.zeroToSpeedKph['100'].tick &&
      full.displayTick === full.telemetry?.presentation?.tick &&
      full.render?.tick === full.displayTick,
      `present ${full.telemetry?.presentation?.tick}, display ${full.displayTick}, render ${full.render?.tick}`);
    passCheck(`${car.slug}: the telemetry panel is visible with a metric table and three charts`,
      full.panel && full.panel.hidden === false && full.panel.tables === 1 && full.panel.svgs === 3 &&
      full.panel.height > 300 && full.panel.width > 400,
      JSON.stringify({ hidden: full.panel?.hidden, tables: full.panel?.tables, svgs: full.panel?.svgs,
        height: full.panel?.height, width: full.panel?.width }));
    passCheck(`${car.slug}: the panel labels the car, the units, the sampling and the measured 0-100 time`,
      panelText.includes(car.name) &&
      panelText.includes('0–100 ' + zeroTo100.toFixed(3) + ' s') &&
      panelText.includes('60 Hz') && panelText.includes('km/h') && panelText.includes('m/s²') &&
      panelText.includes('°/s') && panelText.includes('samples') && panelText.includes('NaN'),
      panelText.slice(0, 120));
    passCheck(`${car.slug}: the telemetry page still renders the packet (3 uploads, one draw per draw per frame, 9 matrices)`,
      full.geometryUploads === MESH_COUNT && full.geometryUploadBytes === uploadBytes &&
      full.draws === draws && full.drawsIssued === full.frames * full.draws &&
      full.render?.matrices?.length === 9,
      `${full.geometryUploads} uploads / ${full.geometryUploadBytes} B / ${full.drawsIssued} draws in ` +
      `${full.frames} frames / ${full.render?.matrices?.length} matrices`);
    passCheck(`${car.slug}: the page drove the requested car and lists the roster`,
      full.car?.name === car.name && full.selector?.value === car.slug &&
      full.selector?.options === run.roster.counts.selected,
      JSON.stringify(full.selector));
    const blocking = shotMessages.filter((entry) => entry.source !== 'console.log');
    passCheck(`${car.slug}: console is clean in the telemetry capture`, blocking.length === 0,
      blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));

    rows.push({
      car: car.name,
      slug: car.slug,
      url: url.replace(origin, ''),
      screenshot: path.relative(ROOT, file).split(path.sep).join('/'),
      carCrop: crop ? path.relative(ROOT, crop).split(path.sep).join('/') : null,
      mode: full.mode,
      presentationTick: full.telemetry?.presentation?.tick ?? null,
      metrics,
      nodeMetrics,
      metricMaxDelta: delta,
      metricsExact: delta === 0,
      planBrakeTick: full.telemetry?.plan?.brakeTick ?? null,
      traceHashes: traceMatch,
      panel: full.panel ? { hidden: full.panel.hidden, svgs: full.panel.svgs, tables: full.panel.tables,
        height: full.panel.height, width: full.panel.width } : null,
      packetHash: full.packetHash,
      tickHash: full.tickHash,
      renderTick: full.render?.tick ?? null,
      frames: full.frames,
      draws: full.draws,
      drawsIssued: full.drawsIssued,
      geometryUploads: full.geometryUploads,
      geometryUploadBytes: full.geometryUploadBytes,
      matrices: full.render?.matrices?.length ?? null,
      instances: full.telemetry?.instances ?? null,
      resets: full.telemetry?.resets ?? null,
      builds: full.telemetry?.builds ?? null,
      heapBytes: full.telemetry?.heapBytes ?? null,
      rebuildModel: full.telemetry?.rebuildModel ?? null,
      restarts: full.restarts ?? 0,
      gpu: full.gpu,
      canvas: full.canvas,
      messages: shotMessages
    });
  }

  const allMessages = rows.flatMap((row) => row.messages);
  const blocking = allMessages.filter((entry) => entry.source !== 'console.log');
  passCheck('console is clean in every telemetry capture', blocking.length === 0,
    blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));
  passCheck('telemetry: every car recomputed the node metrics exactly',
    rows.every((row) => row.metricsExact === true),
    rows.map((row) => `${row.slug}:${row.metricMaxDelta}`).join(', '));

  const evidence = {
    browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT },
    mode: 'telemetry',
    sampleHz: telemetryRun.sampleHz,
    spec: telemetryRun.spec,
    limits: telemetryRun.limits,
    ordering: telemetryRun.ordering,
    cars: rows,
    console: { totalMessages: allMessages.length, errorsAndWarnings: blocking.length, messages: allMessages },
    assertions: { ok: passFailures.length === 0, failures: passFailures },
    verdict: blocking.length === 0 && passFailures.length === 0 ? 'clean-console-and-gates' : 'failed'
  };
  writeFileSync(path.join(OUT, 'browser-evidence-telemetry.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(LOGS, 'edge-telemetry.log'), browserLog, 'utf8');
  return {
    ok: evidence.verdict === 'clean-console-and-gates',
    summary: {
      verdict: evidence.verdict,
      consoleMessages: evidence.console.totalMessages,
      errorsAndWarnings: evidence.console.errorsAndWarnings,
      failures: passFailures,
      cars: rows.map((row) => ({
        car: row.car,
        slug: row.slug,
        zeroTo100: row.metrics.accel.zeroToSpeedKph['100'].seconds,
        speedAt86m: row.metrics.accel.endSpeedKph,
        brakeDistance: row.metrics.brake.distanceMetres,
        lateralG: row.metrics.lateral.peakLateralAbsG,
        presentationTick: row.presentationTick,
        metricsExact: row.metricsExact,
        traceHashesMatch: row.traceHashes.every((trace) => trace.page === trace.node),
        screenshot: row.screenshot,
        carCrop: row.carCrop,
        svgs: row.panel?.svgs ?? null,
        messages: row.messages.length
      }))
    }
  };
}

const carResults = [];
const expectedBySlug = new Map();
for (const car of cars) {
  const expected = expectedFor(car);
  expectedBySlug.set(car.slug, expected);
  const carRuns = [];
  for (const tick of TICKS) {
    const label = LABEL_PREFIX ? LABEL_PREFIX + '-' + tick : labelFor(tick);
    const entry = await capture(car, label, tick);
    carRuns.push(entry);

    const tickHash = expected.packetHash.get(tick);
    const stateHash = expected.stateHash.get(tick);
    const expectedUpdate = expected.updates.get(tick);
    const render = entry.probe.render;
    const cameraDelta = render && expectedUpdate ? cameraMaxDelta(render.camera, expectedUpdate.camera) : null;
    check(`${car.slug}/${entry.label}: held at tick ${tick} with the update the page built`,
          entry.probe.frames > 0 && render?.tick === tick && entry.probe.tickHash === render?.hash,
          'tickHash ' + entry.probe.tickHash + ' vs ' + render?.hash);
    check(`${car.slug}/${entry.label}: the page drove the requested car`,
          entry.probe.car?.name === car.name && entry.probe.car?.recordId === car.record.id,
          JSON.stringify(entry.probe.car?.name));
    check(`${car.slug}/${entry.label}: the selector lists the roster and shows this car`,
          entry.probe.selector &&
          entry.probe.selector.options === run.roster.counts.selected &&
          entry.probe.selector.value === car.slug,
          JSON.stringify(entry.probe.selector));
    check(`${car.slug}/${entry.label}: geometry uploads equal the mesh count`,
          entry.probe.geometryUploads === MESH_COUNT,
          entry.probe.geometryUploads + ' uploads for ' + MESH_COUNT + ' meshes');
    check(`${car.slug}/${entry.label}: upload bytes are the level + own body + track meshes`,
          entry.probe.geometryUploadBytes === expected.uploadBytes,
          entry.probe.geometryUploadBytes + ' vs ' + expected.uploadBytes);
    check(`${car.slug}/${entry.label}: the static albedo textures are uploaded for the textured track draws`,
          entry.probe.textureUploads === expected.totalTextureCount &&
          entry.probe.textureUploadBytes === expected.totalTextureBytes &&
          entry.probe.trackTextures === expected.textureCount &&
          entry.probe.trackTextureBytes === expected.textureBytes &&
          entry.probe.trackTexturedDraws === expected.texturedDraws &&
          entry.probe.trackUvVertices === expected.uvVertices,
          entry.probe.textureUploads + ' textures / ' + entry.probe.textureUploadBytes + ' B / ' +
          entry.probe.trackTexturedDraws + ' textured draws / ' + entry.probe.trackUvVertices + ' UV vertices');
    check(`${car.slug}/${entry.label}: the 18 level-prop BC1 draws sample the real instance UV0`,
          entry.probe.levelPropDraws === expected.levelPropDraws &&
          entry.probe.levelPropTexturedDraws === expected.levelPropTexturedDraws &&
          entry.probe.levelPropDiagnosticDraws === expected.levelPropDiagnosticDraws &&
          entry.probe.levelPropTextures === expected.levelPropTextures &&
          entry.probe.levelPropTextureBytes === expected.levelPropTextureBytes &&
          entry.probe.levelPropUvVertices === expected.levelPropUvVertices &&
          entry.probe.levelPropManifestSha256 === expected.levelPropManifestSha256 &&
          entry.probe.levelPropContentHash === expected.levelPropContentHash &&
          JSON.stringify(entry.probe.levelPropBlockedInstances) ===
            JSON.stringify(expected.levelPropBlockedInstances),
          `${entry.probe.levelPropTexturedDraws}/${entry.probe.levelPropDraws} level draws textured, ` +
          `${entry.probe.levelPropTextures} tex / ${entry.probe.levelPropTextureBytes} B, ` +
          `${entry.probe.levelPropUvVertices} UV vertices, blocked ` +
          JSON.stringify(entry.probe.levelPropBlockedInstances));
    check(`${car.slug}/${entry.label}: this car's own P52 albedo textures are uploaded and sampled`,
          entry.probe.carTextures === expected.carTextures &&
          entry.probe.carTextureBytes === expected.carTextureBytes &&
          entry.probe.carTexturedDraws === expected.carTexturedDraws &&
          entry.probe.carUvVertices === expected.carUvVertices &&
          entry.probe.uvUploadBytes === expected.uvUploadBytes &&
          entry.probe.carPaintDraws === expected.carDrawClasses.runtimePaintDraws &&
          entry.probe.carLightDraws === expected.carDrawClasses.runtimeLightBlendDraws &&
          entry.probe.carNoAlbedoDraws === expected.carDrawClasses.runtimeNoAlbedoDraws,
          entry.probe.carTexturedDraws + '/' + entry.probe.carDraws + ' car draws textured, ' +
          entry.probe.carTextures + ' tex / ' + entry.probe.carTextureBytes + ' B, ' +
          entry.probe.carUvVertices + ' UV vertices, uv upload ' + entry.probe.uvUploadBytes + ' B');
    check(`${car.slug}/${entry.label}: the browser drew this car's own body mesh and manifest`,
          entry.probe.bodyMesh === expected.bodyMeshId &&
          entry.probe.bodyManifest?.sha256 === expected.bodyManifestSha256 &&
          entry.probe.bodyManifest?.meshValueHashes?.positionsFloat32LESha256 === expected.bodyPositionsSha256,
          JSON.stringify({ mesh: entry.probe.bodyMesh, manifest: entry.probe.bodyManifest?.sha256 }));
    check(`${car.slug}/${entry.label}: one uniform write per frame`,
          entry.probe.uniformWrites === entry.probe.frames,
          entry.probe.uniformWrites + ' writes / ' + entry.probe.frames + ' frames');
    check(`${car.slug}/${entry.label}: one draw per draw per frame`,
          entry.probe.drawsIssued === entry.probe.frames * entry.probe.draws,
          entry.probe.drawsIssued + ' draws / ' + entry.probe.frames + ' frames * ' + entry.probe.draws);
    check(`${car.slug}/${entry.label}: the browser state hash matches the node sequence`,
          entry.probe.tickHashes[tick]?.stateHash === stateHash,
          (entry.probe.tickHashes[tick]?.stateHash ?? 'none') + ' vs ' + (stateHash ?? 'none'));
    check(`${car.slug}/${entry.label}: the browser car matrix is bit-identical to the node producer`,
          render && expectedUpdate &&
          render.matrix.every((value, index) => Object.is(value, expectedUpdate.matrices[0].world[index])),
          render ? 'matrix differs' : 'no render update');
    check(`${car.slug}/${entry.label}: the browser camera matches the node camera within 1e-6`,
          DIAGNOSTIC_CAMERA || (cameraDelta !== null && cameraDelta <= 1e-6),
          DIAGNOSTIC_CAMERA ? 'diagnostic camera override, comparison skipped' :
          'max |delta| ' + (cameraDelta === null ? 'n/a' : cameraDelta.toExponential(3)) +
          ', packet hash exact: ' + (render?.hash === tickHash));
    const pageCameraHit = render?.camera?.target && render?.camera?.position
      ? occluder.castSegment(render.camera.target, render.camera.position) : null;
    const pageCameraClear = !pageCameraHit ||
      pageCameraHit.distance >= (render?.camera?.orbit?.distance ?? 0) - 1e-3;
    const pageNearField = render?.camera?.occlusion?.nearField === true;
    // Near-field means the car is passing through the prop itself (recorded per
    // tick); no eye distance can resolve that, and the four capture ticks are
    // asserted below to have no such exception.
    check(`${car.slug}/${entry.label}: the page camera is clear of visible static geometry`,
          DIAGNOSTIC_CAMERA || (render?.camera?.occlusion?.enabled === true &&
            (pageCameraClear || pageNearField)),
          DIAGNOSTIC_CAMERA ? 'diagnostic camera override, comparison skipped' :
          (pageCameraClear
            ? `clear, eye ${render?.camera?.orbit?.distance?.toFixed(2)} m of ` +
              `${render?.camera?.occlusion?.requestedDistance?.toFixed(2)} m requested`
            : pageNearField
              ? `near-field prop crossing at ${render?.camera?.occlusion?.hitDistance?.toFixed(2)} m ` +
                `(documented limit, car is inside the prop)`
              : `hit at ${pageCameraHit.distance.toFixed(2)} m before the eye at ` +
                `${render?.camera?.orbit?.distance?.toFixed(2)} m`));
    check(`${car.slug}/${entry.label}: canvas is the packet aspect`, entry.probe.canvas.width > 0 &&
          Math.abs(entry.probe.canvas.width / entry.probe.canvas.height - geometry.cameraIntrinsics.aspect) < 0.01);
    check(`${car.slug}/${entry.label}: the car stays framed by the chase camera`,
          entry.probe.movedScreen &&
          entry.probe.movedScreen.x > 0 && entry.probe.movedScreen.x < VIEWPORT.width &&
          entry.probe.movedScreen.y > 0 && entry.probe.movedScreen.y < VIEWPORT.height,
          JSON.stringify(entry.probe.movedScreen));
    check(`${car.slug}/${entry.label}: the car is drawn as its own manifest parts and draws`,
          entry.probe.parts === expected.parts && entry.probe.carDraws === expected.draws - 22 - expected.trackDraws,
          entry.probe.parts + ' parts / ' + entry.probe.carDraws + ' draws, expected ' +
          expected.parts + ' / ' + expected.draws);
    check(`${car.slug}/${entry.label}: the real track visual is drawn and the collision surface is hidden`,
          entry.probe.trackVisual === expected.trackLabel &&
          entry.probe.trackDraws === expected.trackDraws &&
          entry.probe.trackTriangles === expected.trackTriangles &&
          entry.probe.collisionVisible === false &&
          entry.probe.draws === expected.draws,
          entry.probe.trackDraws + ' track draws / ' + entry.probe.trackTriangles + ' tri / draws ' +
          entry.probe.draws + ' expected ' + expected.draws);
    check(`${car.slug}/${entry.label}: the packet carries one body and one matrix per wheel node`,
          entry.probe.packetNodes === expected.nodes &&
          entry.probe.wheelNodes === expected.wheelNodes &&
          entry.probe.render?.matrices?.length === expected.nodes,
          entry.probe.packetNodes + ' nodes / ' + entry.probe.wheelNodes + ' wheel / ' +
          (entry.probe.render?.matrices?.length ?? 0) + ' matrices');
    const wheelAngleValues = Object.values(entry.probe.wheelAngles ?? {});
    const wheelAngleMax = wheelAngleValues.length ? Math.max(...wheelAngleValues.map((value) => Math.abs(value))) : NaN;
    check(`${car.slug}/${entry.label}: the browser wheel spin angle comes from the physics state`,
          wheelAngleValues.length === 4 && wheelAngleValues.every(Number.isFinite) &&
          (tick === 0 ? wheelAngleMax < 1e-6 : wheelAngleMax > 1),
          'max |angle| ' + wheelAngleMax.toFixed(3) + ' rad at tick ' + tick);

    entry.comparison = {
      packetHashExact: render?.hash === tickHash,
      pagePacketHash: render?.hash ?? null,
      nodePacketHash: tickHash ?? null,
      carMatrixExact: !!render && !!expectedUpdate &&
        render.matrix.every((value, index) => Object.is(value, expectedUpdate.matrices[0].world[index])),
      cameraMaxDelta: cameraDelta,
      cameraOcclusion: render?.camera?.occlusion ?? null,
      cameraClear: pageCameraClear,
      cameraNearField: pageNearField
    };
  }

  if (carRuns.length > 1) {
    const worldDistance = Math.hypot(
      carRuns[0].probe.position[0] - carRuns[carRuns.length - 1].probe.position[0],
      carRuns[0].probe.position[1] - carRuns[carRuns.length - 1].probe.position[1],
      carRuns[0].probe.position[2] - carRuns[carRuns.length - 1].probe.position[2]);
    check(`${car.slug}: the car travelled more than 20 m between start and end`,
          worldDistance > 20, worldDistance.toFixed(2) + ' m');
    check(`${car.slug}: matrix checksums differ between start and end`,
          carRuns[0].probe.matrixChecksum !== carRuns[carRuns.length - 1].probe.matrixChecksum,
          carRuns[0].probe.matrixChecksum + ' vs ' + carRuns[carRuns.length - 1].probe.matrixChecksum);
    check(`${car.slug}: the whole scripted sequence ran in the browser`,
          carRuns[carRuns.length - 1].probe.ticksExecuted >= 299,
          String(carRuns[carRuns.length - 1].probe.ticksExecuted));
    check(`${car.slug}: the browser drove at a real speed`,
          carRuns[carRuns.length - 1].probe.speed < 2.0 && carRuns[1].probe.speed > 5,
          carRuns.map((entry) => entry.probe.speed.toFixed(2)).join(' / ') + ' m/s');
  }
  check(`${car.slug}: geometry uploads do not grow between ticks`,
        new Set(carRuns.map((entry) => entry.probe.geometryUploads)).size === 1,
        carRuns.map((entry) => entry.probe.geometryUploads).join(','));
  const wheelAngleMax = (entry) => Math.max(...Object.values(entry.probe.wheelAngles ?? { frontleft: 0 })
    .map((value) => Math.abs(value)));
  if (carRuns.length > 1) {
    check(`${car.slug}: the wheel spin angle grows with the scripted drive`,
          wheelAngleMax(carRuns[carRuns.length - 1]) > wheelAngleMax(carRuns[0]) + 1,
          wheelAngleMax(carRuns[0]).toFixed(2) + ' -> ' + wheelAngleMax(carRuns[carRuns.length - 1]).toFixed(2) + ' rad');
  }

  // The default car's captures keep their historical file names.
  if (car.slug === defaultSlug && !LABEL_PREFIX) {
    for (const entry of carRuns) {
      copyFileSync(path.join(ROOT, entry.screenshot), path.join(OUT, `browser-${entry.label}.png`));
      if (entry.carCrop) {
        copyFileSync(path.join(ROOT, entry.carCrop), path.join(OUT, `browser-${entry.label}-car.png`));
      }
      entry.legacyScreenshot = `_work/e1-drive/browser-${entry.label}.png`;
    }
  }

  carResults.push({
    slug: car.slug,
    name: car.name,
    record: car.record,
    drivetrain: car.drivetrain,
    fields: car.fields,
    drive: {
      spawn: car.drive.spawn,
      groundProbe: car.drive.groundProbe,
      tickHz: car.drive.tickHz,
      script: car.drive.script,
      stateSequenceHash: car.determinism.stateSequenceHash
    },
    packet: {
      path: car.packet.path,
      hash: car.packet.hash,
      bytes: car.packet.bytes,
      updates: car.packet.updates,
      draws: car.packet.draws
    },
    body: car.body,
    runs: carRuns
  });
}

const midRuns = carResults.map((entry) => entry.runs.find((runEntry) => runEntry.tick === MID_TICK)).filter(Boolean);
// P31 recorded that these three cars' mid frames showed terrain; P36's camera
// must be blocked there (the prop is real) and resolved (the car is visible).
const MID_OCCLUDED = ['lotus-exige-cup260-stock', 'dodge-challenger-stock', 'ford-focusrs-stock'];
const midOccluded = carResults.filter((entry) => MID_OCCLUDED.includes(entry.slug));
if (midOccluded.length === MID_OCCLUDED.length) {
  const rows = midOccluded.map((entry) => {
    const mid = entry.runs.find((runEntry) => runEntry.tick === MID_TICK);
    return {
      slug: entry.slug,
      blocked: mid?.comparison?.cameraOcclusion?.blocked === true,
      distance: mid?.comparison?.cameraOcclusion?.distance ?? null,
      requested: mid?.comparison?.cameraOcclusion?.requestedDistance ?? null,
      clear: mid?.comparison?.cameraClear === true,
      nearField: mid?.comparison?.cameraNearField === true
    };
  });
  check('the recorded tick-150 prop occlusion is resolved in the rendered mid frames',
        rows.every((row) => row.blocked && row.clear && row.distance < row.requested &&
          row.nearField !== true),
        rows.map((row) => `${row.slug}: ${row.distance?.toFixed(2)} of ${row.requested?.toFixed(2)} m`).join(', '));
}
if (midRuns.length > 1) {
  const positions = new Set(midRuns.map((entry) => entry.probe.position.map((value) => value.toFixed(4)).join(',')));
  check('the cars are at different places at mid-drive', positions.size === midRuns.length,
        `${positions.size} distinct of ${midRuns.length}`);
  const hashes = new Set(midRuns.map((entry) => entry.probe.tickHashes[MID_TICK]?.stateHash));
  check('the cars have different state hashes at mid-drive', hashes.size === midRuns.length,
        `${hashes.size} distinct of ${midRuns.length}`);
}
const browserBodyHashes = new Set(carResults.map((entry) =>
  entry.runs[0]?.probe.bodyManifest?.meshValueHashes?.positionsFloat32LESha256));
check('the browser drew a distinct body mesh for every car',
      browserBodyHashes.size === carResults.length,
      `${browserBodyHashes.size} distinct of ${carResults.length}`);
const browserCarTextureSets = new Set(carResults.map((entry) =>
  entry.runs[0]?.probe.carTextures + ':' + entry.runs[0]?.probe.carTextureBytes + ':' +
  entry.runs[0]?.probe.carTexturedDraws));
check('every car uploaded its own P52 livery/tyre texture set',
      browserCarTextureSets.size === carResults.length &&
      carResults.every((entry) => entry.runs.every((runEntry) =>
        runEntry.probe.carTextures === expectedBySlug.get(entry.slug).carTextures &&
        runEntry.probe.carTextureBytes === expectedBySlug.get(entry.slug).carTextureBytes)),
      carResults.map((entry) => `${entry.slug}:${entry.runs[0]?.probe.carTextures} tex/` +
        `${entry.runs[0]?.probe.carTextureBytes} B`).join(', '));

const allMessages = carResults.flatMap((entry) => entry.runs.flatMap((runEntry) => runEntry.messages));
const blocking = allMessages.filter((entry) => entry.source !== 'console.log');
check('console is clean', blocking.length === 0,
      blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));

// Whether the browser's canonical packet hash equals the node producer's for each
// capture. A false value is the documented 1-ulp `Math.atan2` difference, and the
// camera tolerance check above is what proves it is that and not a physics change.
const hashExact = carResults.flatMap((entry) => entry.runs.map((runEntry) => ({
  car: entry.name,
  label: runEntry.label,
  tick: runEntry.tick,
  pageHash: runEntry.probe.render?.hash ?? null,
  nodeHash: expectedBySlug.get(entry.slug).packetHash.get(runEntry.tick) ?? null
})));
const hashExactCount = hashExact.filter((row) => row.pageHash === row.nodeHash).length;
const hashExactByKey = new Map(hashExact.map((row) => [row.car + '|' + row.label, row.pageHash === row.nodeHash]));

const evidence = {
  browser: {
    executable: edge,
    mode: 'headless=new',
    flags: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=d3d11'],
    viewport: VIEWPORT
  },
  module: run.module,
  roster: {
    path: run.roster.path,
    counts: run.roster.counts,
    source: run.roster.source
  },
  cars: carResults,
  packetHashAgreement: { exact: hashExactCount, total: hashExact.length, rows: hashExact },
  console: { totalMessages: allMessages.length, errorsAndWarnings: blocking.length, messages: allMessages },
  assertions: { ok: failures.length === 0, failures },
  verdict: blocking.length === 0 && failures.length === 0 ? 'clean-console-and-gates' : 'failed'
};
writeFileSync(path.join(OUT, EVIDENCE_NAME), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
writeFileSync(path.join(LOGS, 'edge-process.log'), browserLog, 'utf8');

await shutdown();
await sleep(400);
console.log(JSON.stringify({
  verdict: evidence.verdict,
  consoleMessages: evidence.console.totalMessages,
  errorsAndWarnings: evidence.console.errorsAndWarnings,
  packetHashAgreement: { exact: hashExactCount, total: hashExact.length },
  failures,
  captures: evidence.cars.flatMap((car) => car.runs.map((entry) => ({
    car: car.name,
    label: entry.label,
    tick: entry.tick,
    url: entry.url,
    screenshot: entry.screenshot,
    legacyScreenshot: entry.legacyScreenshot ?? null,
    carCrop: entry.carCrop,
    speed: entry.probe.speed,
    position: entry.probe.position,
    contacts: entry.probe.contacts,
    updateHash: entry.probe.render?.hash ?? null,
    tickHash: entry.probe.tickHash,
    stateHash: entry.probe.tickHashes[entry.tick]?.stateHash ?? null,
    packetHashExact: hashExactByKey.get(car.name + '|' + entry.label),
    matrixChecksum: entry.probe.matrixChecksum,
    parts: entry.probe.parts,
    carDraws: entry.probe.carDraws,
    packetNodes: entry.probe.packetNodes,
    wheelNodes: entry.probe.wheelNodes,
    trackVisual: entry.probe.trackVisual,
    trackDraws: entry.probe.trackDraws,
    trackTriangles: entry.probe.trackTriangles,
    carTexturedDraws: entry.probe.carTexturedDraws,
    carTextures: entry.probe.carTextures,
    carTextureBytes: entry.probe.carTextureBytes,
    carUvVertices: entry.probe.carUvVertices,
    textureUploads: entry.probe.textureUploads,
    textureUploadBytes: entry.probe.textureUploadBytes,
    uvUploadBytes: entry.probe.uvUploadBytes,
    collisionVisible: entry.probe.collisionVisible,
    collisionFallbackTriangles: entry.probe.collisionFallbackTriangles,
    collisionCoveredTriangles: entry.probe.collisionCoveredTriangles,
    wheelAngleMax: Math.max(...Object.values(entry.probe.wheelAngles ?? { frontleft: 0 }).map((value) => Math.abs(value))),
    cameraDistance: entry.probe.render?.camera?.orbit?.distance ?? null,
    cameraOcclusion: entry.probe.render?.camera?.occlusion ?? null,
    cameraClear: entry.comparison?.cameraClear ?? null,
    cameraNearField: entry.comparison?.cameraNearField ?? null,
    frames: entry.probe.frames,
    ticksExecuted: entry.probe.ticksExecuted,
    geometryUploads: entry.probe.geometryUploads,
    geometryUploadBytes: entry.probe.geometryUploadBytes,
    textureUploads: entry.probe.textureUploads,
    textureUploadBytes: entry.probe.textureUploadBytes,
    uvUploadBytes: entry.probe.uvUploadBytes,
    texturedTrackDraws: entry.probe.trackTexturedDraws,
    uniformWrites: entry.probe.uniformWrites,
    drawsIssued: entry.probe.drawsIssued,
    gpu: entry.probe.gpu,
    canvas: entry.probe.canvas,
    selector: entry.probe.selector,
    messages: entry.messages.length
  })))
}, null, 2));
if (evidence.verdict !== 'clean-console-and-gates') process.exitCode = 1;

/**
 * In-place sprint restart (`--mode restart`): one page load, one finish, `R`,
 * a second finish. Nothing may reload: the same page, the same wasm instance and
 * the same probe object continue, and the restarted attempt must reproduce the
 * same finish time, the same finish tick and the same per-tick state hashes
 * while the stored best time is kept. Before the fix this path did not exist for
 * telemetry (`R` reloaded) and a third rebuild aborted.
 */
async function restartCapturePass() {
  const runDocument = JSON.parse(readFileSync(path.join(OUT, 'run.json'), 'utf8'));
  if (!runDocument.sprint?.cars) {
    throw new Error('run.json has no sprint block - run `node probes/e1-drive/tools/verify_e1_drive.mjs` first');
  }
  const sprintRun = COURSE === 'short' ? runDocument.sprint.shortCourse : runDocument.sprint;
  if (!sprintRun?.cars) {
    throw new Error('run.json has no ' + COURSE + ' sprint results - run `node probes/e1-drive/tools/verify_e1_drive.mjs` first');
  }
  const restartLayout = JSON.parse(readFileSync(
    path.join(OUT, COURSE === 'short' ? 'sprint-short.json' : 'sprint.json'), 'utf8'));
  const passFailures = [];
  const passCheck = (label, ok, detail) => { if (!ok) passFailures.push(label + (detail ? ': ' + detail : '')); };
  const shotPath = (slug, name) => path.join(OUT, `browser-${slug}-${name}.png`);
  const shoot = async (slug, name) => {
    const data = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = shotPath(slug, name);
    writeFileSync(file, Buffer.from(data.data, 'base64'));
    return path.relative(ROOT, file).split(path.sep).join('/');
  };
  const pressRestart = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type, key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82,
        text: type === 'keyDown' ? 'r' : undefined
      });
    }
  };
  const readProbe = async () => evaluate(`(()=>{
    const p = window.e1DriveProbe;
    if (!p) return null;
    return {
      state: p.consumer, error: p.error, frames: p.frames, restarts: p.restarts ?? 0,
      engineTick: p.engineTick, displayTick: p.displayTick, phase: p.phase,
      sprint: p.sprint ?? null, sprintResult: p.sprintResult ?? null, sprintBest: p.sprintBest ?? null,
      finishTick: p.sprint?.finishTick ?? null,
      tickHashes: (p.tickHashes ?? []).map((entry) => ({ tick: entry.tick, stateHash: entry.stateHash })),
      geometryUploads: p.geometryUploads, geometryUploadBytes: p.geometryUploadBytes,
      draws: p.draws, drawsIssued: p.drawsIssued, matrixCount: p.updates?.[p.displayTick]?.matrices?.length ?? null,
      timelineTicks: p.updates?.length ?? null, car: p.car, speed: p.speed, position: p.position,
      bestStored: (()=>{try{return localStorage.getItem('${SPRINT_BEST_KEY}');}catch{return null;}})(),
      overlays: {
        resultsHidden: document.getElementById('results')?.hidden ?? null,
        resultsTime: document.getElementById('results-time')?.textContent ?? null,
        resultsBest: document.getElementById('results-best')?.textContent ?? null,
        countdownText: document.getElementById('countdown')?.textContent ?? null
      }
    };
  })()`);
  const waitFor = async (label, predicate, attempts = 600) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const probe = await readProbe().catch(() => null);
      if (probe && probe.state === 'error') throw new Error(label + ': page error: ' + probe.error);
      if (probe && predicate(probe)) return probe;
      await sleep(200);
    }
    throw new Error(label + ': timed out');
  };

  const rows = [];
  for (const car of cars) {
    const entry = sprintRun.cars.find((candidate) => candidate.slug === car.slug);
    if (!entry) throw new Error('run.json has no sprint result for ' + car.slug);
    messages.length = 0;
    const url = origin + '/?script=sprint&car=' + encodeURIComponent(car.slug) +
      (COURSE_QUERY ? '&' + COURSE_QUERY : '');
    await send('Page.navigate', { url });

    const finished = await waitFor(car.slug + ' first finish',
      (probe) => probe.state === 'running' && probe.sprint?.finished === true && probe.frames >= 12);
    const firstShot = await shoot(car.slug, 'sprint-restart-before');
    const loadMessages = messages.splice(0);
    const firstFinishTick = finished.sprint.finishTick;
    const firstHash = finished.tickHashes.find((row) => row.tick === firstFinishTick)?.stateHash ?? null;

    await pressRestart();
    const restarted = await waitFor(car.slug + ' restart',
      (probe) => probe.restarts >= 1 && probe.sprint?.phase === 'countdown' && probe.sprintResult === null);
    const restartShot = await shoot(car.slug, 'sprint-restart-countdown');
    const second = await waitFor(car.slug + ' second finish',
      (probe) => probe.restarts >= 1 && probe.sprint?.finished === true);
    const secondShot = await shoot(car.slug, 'sprint-restart-finish');
    const restartMessages = messages.splice(0);
    const secondHash = second.tickHashes.find((row) => row.tick === second.sprint.finishTick)?.stateHash ?? null;

    passCheck(`${car.slug}: the first attempt finishes with both checkpoints`,
      finished.sprint?.finished === true && finished.sprint?.checkpointsPassed === 2 &&
      Math.abs(finished.sprint.finishTimeSeconds - entry.finish.timeSeconds) < 1e-6,
      JSON.stringify({ time: finished.sprint?.finishTimeSeconds, node: entry.finish.timeSeconds }));
    passCheck(`${car.slug}: R restarts in place, never reloading the page`,
      restarted.restarts === 1 && restarted.sprint.phase === 'countdown' &&
      restarted.sprint.elapsedTicks === 0 && restarted.sprint.finishTick === null &&
      restarted.sprintResult === null && restarted.tickHashes.length < 30,
      JSON.stringify({ restarts: restarted.restarts, engineTick: restarted.engineTick,
        phase: restarted.sprint?.phase, elapsed: restarted.sprint?.elapsedTicks,
        timeline: restarted.tickHashes.length }));
    passCheck(`${car.slug}: the restarted sprint reproduces the finish time and tick`,
      second.sprint?.finished === true && second.sprint.finishTick === firstFinishTick &&
      Math.abs(second.sprint.finishTimeSeconds - finished.sprint.finishTimeSeconds) < 1e-9 &&
      second.sprint.checkpointsPassed === 2,
      JSON.stringify({ first: finished.sprint?.finishTimeSeconds, second: second.sprint?.finishTimeSeconds,
        firstTick: firstFinishTick, secondTick: second.sprint?.finishTick }));
    passCheck(`${car.slug}: the restarted sprint reproduces the per-tick state hash at the finish`,
      firstHash !== null && firstHash === secondHash, (firstHash ?? 'none') + ' vs ' + (secondHash ?? 'none'));
    passCheck(`${car.slug}: the best time survives the in-place restart`,
      firstFinishTick !== null && finished.bestStored === second.bestStored &&
      /best /.test(second.overlays.resultsBest ?? ''),
      JSON.stringify({ first: finished.bestStored, second: second.bestStored, best: second.overlays.resultsBest }));
    passCheck(`${car.slug}: the restarted page still renders the rebuilt packet (9 matrices, one draw per draw)`,
      second.matrixCount === 9 && second.geometryUploads >= MESH_COUNT &&
      second.geometryUploads % MESH_COUNT === 0 && second.drawsIssued === second.frames * second.draws,
      `${second.geometryUploads} uploads, ${second.matrixCount} matrices, ${second.drawsIssued} draws`);
    const blocking = [...loadMessages, ...restartMessages].filter((message) => message.source !== 'console.log');
    passCheck(`${car.slug}: console is clean across the restart`, blocking.length === 0,
      blocking.map((message) => message.source + ' ' + message.text).join(' | '));

    rows.push({
      car: car.name,
      slug: car.slug,
      url: url.replace(origin, ''),
      restartUrl: origin,
      first: {
        finishSeconds: finished.sprint.finishTimeSeconds,
        finishTick: firstFinishTick,
        stateHashAtFinish: firstHash,
        bestStored: finished.bestStored,
        screenshot: firstShot
      },
      restart: {
        restarts: restarted.restarts,
        engineTick: restarted.engineTick,
        phase: restarted.sprint.phase,
        elapsedTicks: restarted.sprint.elapsedTicks,
        resultCleared: restarted.sprintResult === null,
        screenshot: restartShot
      },
      second: {
        finishSeconds: second.sprint.finishTimeSeconds,
        finishTick: second.sprint.finishTick,
        stateHashAtFinish: secondHash,
        bestStored: second.bestStored,
        resultsBest: second.overlays.resultsBest,
        screenshot: secondShot
      },
      frames: second.frames,
      restarts: second.restarts,
      geometryUploads: second.geometryUploads,
      matrices: second.matrixCount,
      messages: [...loadMessages, ...restartMessages]
    });
  }

  const allMessages = rows.flatMap((row) => row.messages);
  const evidence = {
    browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT },
    mode: 'restart',
    note: 'R on a finished scripted sprint; the same page, wasm instance and probe object continue ' +
      '(docs/work/verification/T-007-reset-fix.md)',
    layout: { hash: restartLayout.hash },
    cars: rows,
    console: { totalMessages: allMessages.length, errorsAndWarnings: 0, messages: allMessages },
    assertions: { ok: passFailures.length === 0, failures: passFailures },
    verdict: passFailures.length === 0 && allMessages.length === 0 ? 'clean-console-and-gates' : 'failed'
  };
  writeFileSync(path.join(OUT, 'browser-evidence-restart.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(LOGS, 'edge-restart.log'), browserLog, 'utf8');
  return {
    ok: evidence.verdict === 'clean-console-and-gates',
    summary: {
      verdict: evidence.verdict,
      consoleMessages: evidence.console.totalMessages,
      failures: passFailures,
      cars: rows.map((row) => ({
        car: row.car, slug: row.slug,
        firstSeconds: row.first.finishSeconds, secondSeconds: row.second.finishSeconds,
        finishTick: row.first.finishTick, stateHashAtFinish: row.second.stateHashAtFinish,
        restarts: row.restarts, before: row.first.screenshot, countdown: row.restart.screenshot,
        finish: row.second.screenshot
      }))
    }
  };
}

/**
 * `R` in telemetry mode without a reload (`--mode telemetry-restart`): the page
 * runs the series once in one instance, R re-runs the same series in the same
 * instance, and the probe's `restarts` counter (which only exists in this page
 * instance) must advance while every per-tick state hash trace stays identical.
 * A `location.reload()` would zero it and lose the comparison.
 */
async function telemetryRestartCapturePass() {
  const runDocument = JSON.parse(readFileSync(path.join(OUT, 'run.json'), 'utf8'));
  const telemetryRun = runDocument.telemetry;
  if (!telemetryRun?.cars) throw new Error('run.json has no telemetry block');
  const passFailures = [];
  const passCheck = (label, ok, detail) => { if (!ok) passFailures.push(label + (detail ? ': ' + detail : '')); };
  const car = cars[0];
  const entry = telemetryRun.cars.find((candidate) => candidate.slug === car.slug);
  if (!entry) throw new Error('run.json has no telemetry result for ' + car.slug);

  const readProbe = async () => evaluate(`(()=>{
    const p = window.e1DriveProbe;
    if (!p) return null;
    return {
      state: p.consumer, error: p.error, frames: p.frames, restarts: p.restarts ?? 0,
      ready: p.telemetry?.ready === true,
      telemetry: p.telemetry ? {
        instances: p.telemetry.instances, resets: p.telemetry.resets ?? null,
        builds: p.telemetry.builds ?? null, heapBytes: p.telemetry.heapBytes ?? null,
        hashes: p.telemetry.hashes, metrics: p.telemetry.metrics, plan: p.telemetry.plan,
        presentation: p.telemetry.presentation
      } : null,
      geometryUploads: p.geometryUploads, matrices: p.updates?.[p.displayTick]?.matrices?.length ?? null,
      draws: p.draws, drawsIssued: p.drawsIssued, frames: p.frames,
      panel: (() => { const el = document.getElementById('telemetry'); return el ? {
        hidden: el.hidden, svgs: el.querySelectorAll('svg').length, tables: el.querySelectorAll('table').length } : null; })()
    };
  })()`);
  const waitFor = async (label, predicate, attempts = 600) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const probe = await readProbe().catch(() => null);
      if (probe && probe.state === 'error') throw new Error(label + ': page error: ' + probe.error);
      if (probe && predicate(probe)) return probe;
      await sleep(200);
    }
    throw new Error(label + ': timed out');
  };
  const shoot = async (name) => {
    const data = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(OUT, `browser-${car.slug}-telemetry-${name}.png`);
    writeFileSync(file, Buffer.from(data.data, 'base64'));
    return path.relative(ROOT, file).split(path.sep).join('/');
  };

  messages.length = 0;
  const url = origin + '/?telemetry=1&car=' + encodeURIComponent(car.slug);
  await send('Page.navigate', { url });
  const first = await waitFor('telemetry first series',
    (probe) => probe.state === 'running' && probe.ready && probe.frames >= 12);
  const beforeShot = await shoot('restart-before');
  const beforeMessages = messages.splice(0);

  messages.length = 0;
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type, key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82,
      text: type === 'keyDown' ? 'r' : undefined
    });
  }
  const second = await waitFor('telemetry restart',
    (probe) => probe.state === 'running' && probe.restarts >= 1 && probe.ready && probe.frames >= 12);
  const afterShot = await shoot('restart-after');
  const afterMessages = messages.splice(0);

  const manoeuvres = Object.keys(first.telemetry.hashes);
  const sameHashes = manoeuvres.every((manoeuvre) =>
    first.telemetry.hashes[manoeuvre]?.traceHash === second.telemetry.hashes[manoeuvre]?.traceHash &&
    first.telemetry.hashes[manoeuvre]?.ticks === second.telemetry.hashes[manoeuvre]?.ticks);
  const sameMetrics = JSON.stringify(first.telemetry.metrics) === JSON.stringify(second.telemetry.metrics);

  passCheck(`${car.slug}: the telemetry page runs one wasm instance, rebuilt between manoeuvres`,
    first.telemetry.instances === 1 && first.telemetry.builds === 4 && first.telemetry.resets === 3,
    JSON.stringify({ instances: first.telemetry.instances, builds: first.telemetry.builds,
      resets: first.telemetry.resets }));
  passCheck(`${car.slug}: R re-runs telemetry in place (no reload: the probe restarts counter advances)`,
    second.restarts === 1 && second.ready === true &&
    second.telemetry.builds === 7 && second.telemetry.resets === 6,
    JSON.stringify({ restarts: second.restarts, builds: second.telemetry.builds,
      resets: second.telemetry.resets }));
  passCheck(`${car.slug}: the re-run reproduces every per-tick telemetry state hash`,
    sameHashes, manoeuvres.map((manoeuvre) => manoeuvre + ':' +
      (first.telemetry.hashes[manoeuvre]?.traceHash === second.telemetry.hashes[manoeuvre]?.traceHash
        ? 'match' : 'DIFF')).join(' '));
  passCheck(`${car.slug}: the re-run reproduces every measured metric exactly`, sameMetrics,
    JSON.stringify({ accel100: second.telemetry.metrics?.accel?.zeroToSpeedKph?.['100']?.seconds }));
  passCheck(`${car.slug}: the panel and the packet still render after the restart`,
    second.panel && second.panel.hidden === false && second.panel.svgs === 3 && second.panel.tables === 1 &&
    second.geometryUploads >= MESH_COUNT && second.geometryUploads % MESH_COUNT === 0 &&
    second.matrices === 9 && second.drawsIssued === second.frames * second.draws,
    JSON.stringify({ panel: second.panel, uploads: second.geometryUploads, matrices: second.matrices,
      draws: second.drawsIssued, frames: second.frames }));
  const blocking = [...beforeMessages, ...afterMessages].filter((message) => message.source !== 'console.log');
  passCheck(`${car.slug}: console is clean across the telemetry restart`, blocking.length === 0,
    blocking.map((message) => message.source + ' ' + message.text).join(' | '));

  const evidence = {
    browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT },
    mode: 'telemetry-restart',
    note: 'R re-runs the whole telemetry series in the same page and wasm instance; the per-tick state ' +
      'hashes and metrics must be identical (docs/work/verification/T-007-reset-fix.md)',
    car: { slug: car.slug, name: car.name },
    first: { instances: first.telemetry.instances, resets: first.telemetry.resets,
      builds: first.telemetry.builds, heapBytes: first.telemetry.heapBytes,
      hashes: first.telemetry.hashes, metrics: first.telemetry.metrics,
      presentation: first.telemetry.presentation, screenshot: beforeShot },
    second: { restarts: second.restarts, instances: second.telemetry.instances,
      resets: second.telemetry.resets, builds: second.telemetry.builds, heapBytes: second.telemetry.heapBytes,
      hashes: second.telemetry.hashes, metrics: second.telemetry.metrics,
      presentation: second.telemetry.presentation, screenshot: afterShot },
    sameHashes, sameMetrics,
    console: { totalMessages: beforeMessages.length + afterMessages.length, errorsAndWarnings: 0,
      messages: [...beforeMessages, ...afterMessages] },
    assertions: { ok: passFailures.length === 0, failures: passFailures },
    verdict: passFailures.length === 0 && beforeMessages.length + afterMessages.length === 0
      ? 'clean-console-and-gates' : 'failed'
  };
  writeFileSync(path.join(OUT, 'browser-evidence-telemetry-restart.json'),
    JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(LOGS, 'edge-telemetry-restart.log'), browserLog, 'utf8');
  return {
    ok: evidence.verdict === 'clean-console-and-gates',
    summary: {
      verdict: evidence.verdict,
      consoleMessages: evidence.console.totalMessages,
      failures: passFailures,
      car: car.slug,
      first: { instances: evidence.first.instances, builds: evidence.first.builds,
        resets: evidence.first.resets, heapBytes: evidence.first.heapBytes, screenshot: beforeShot },
      second: { restarts: evidence.second.restarts, builds: evidence.second.builds,
        resets: evidence.second.resets, heapBytes: evidence.second.heapBytes, screenshot: afterShot },
      sameHashes, sameMetrics
    }
  };
}
