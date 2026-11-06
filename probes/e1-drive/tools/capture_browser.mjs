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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
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

const PORT = Number(option('--port', '8801'));
const DEBUG_PORT = Number(option('--debug-port', '9341'));
const PROFILE = path.join(OUT, 'edge-profile-' + PORT);
const VIEWPORT = { width: 1600, height: 900 };
const TICKS = option('--ticks', '0,150,240,300').split(',').map(Number);
const ONLY_CAR = option('--car', null);
const EXTRA_QUERY = option('--extra-query', '');
const LABEL_PREFIX = option('--label-prefix', '');
const EVIDENCE_NAME = option('--evidence-name', 'browser-evidence.json');
const MODE = option('--mode', 'drive');
if (!['drive', 'sprint', 'lap', 'respawn', 'telemetry', 'restart', 'telemetry-restart', 'survey', 'ghost'].includes(MODE)) {
  throw new Error('unknown --mode ' + JSON.stringify(MODE) +
    ' (drive, sprint, lap, respawn, telemetry, restart, telemetry-restart, survey or ghost)');
}
// Course selection: 310 (default, `_work/e1-drive/sprint.json`), short
// (`?course=short`, `_work/e1-drive/sprint-short.json`) or lap (`?course=lap`,
// `_work/e1-drive/sprint-lap.json`). `--mode lap` always selects the lap.
let COURSE = option('--course', '310');
if (!['310', 'short', 'lap'].includes(COURSE)) {
  throw new Error('unknown --course ' + JSON.stringify(COURSE) + ' (use 310, short or lap)');
}
if (MODE === 'lap') COURSE = 'lap';
const COURSE_QUERY = COURSE === 'short' ? 'course=short' : COURSE === 'lap' ? 'course=lap' : '';
const SPRINT_BEST_KEY = 'e1-drive.sprint.best.v2.' +
  (COURSE === 'short' ? 'short' : COURSE === 'lap' ? 'lap' : '310m');
const DIAGNOSTIC_CAMERA = /(^|&)cam(dist|height)=/.test(EXTRA_QUERY);
const MID_TICK = 150;

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
const defaultSlug = run.defaultCar;
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
    carTexturedDraws: body.carDraws.filter((draw) => draw.textureId != null).length,
    carTextures: body.textures.length,
    carTextureBytes: body.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
    carUvVertices: body.mesh.uv.vertexCount,
    totalTextureCount: geometry.textures.length + body.textures.length,
    totalTextureBytes: geometry.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0) +
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
  // window is too short; long runs get a proportionally longer window.
  const pollAttempts = options.longRun ? 1200 : 400;
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

  const full = await evaluate(`(()=>{
    const p = window.e1DriveProbe;
    const canvas = document.getElementById('scene');
    const select = document.getElementById('car-select');
    const update = p.updates ? p.updates[${tick}] : null;
    return {
      mode: p.mode, engineTick: p.engineTick, displayTick: p.displayTick, phase: p.phase, speed: p.speed, position: p.position,
      holdReached: p.holdReached,
      contacts: p.contacts, input: p.input, car: p.car, roster: p.roster ? p.roster.counts : null,
      selector: select ? { options: select.options.length, value: select.value, text: select.options[select.selectedIndex]?.textContent } : null,
      frames: p.frames, ticksExecuted: p.ticksExecuted, cappedFrames: p.cappedFrames,
      pauseDrops: p.pauseDrops, zeroTickFrames: p.zeroTickFrames,
      geometryUploads: p.geometryUploads, geometryUploadBytes: p.geometryUploadBytes,
      textureUploads: p.textureUploads, textureUploadBytes: p.textureUploadBytes, uvUploadBytes: p.uvUploadBytes,
      trackTexturedDraws: p.trackTexturedDraws, trackTextures: p.trackTextures,
      trackTextureBytes: p.trackTextureBytes, trackUvVertices: p.trackUvVertices,
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
      bestStored: (() => { try { return localStorage.getItem('${SPRINT_BEST_KEY}'); } catch { return null; } })(),
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

if (MODE !== 'drive') {
  const result = MODE === 'sprint' ? await sprintCapturePass()
    : MODE === 'lap' ? await lapCapturePass()
    : MODE === 'ghost' ? await ghostCapturePass()
    : MODE === 'survey' ? await surveyCapturePass()
    : MODE === 'respawn' ? await respawnCapturePass()
      : MODE === 'restart' ? await restartCapturePass()
        : MODE === 'telemetry-restart' ? await telemetryRestartCapturePass()
          : await telemetryCapturePass();
  await shutdown();
  await sleep(400);
  console.log(JSON.stringify(result.summary, null, 2));
  process.exit(result.ok ? 0 : 1);
}

/**
 * Start / checkpoint / finish captures of the scripted sprint, using the node
 * sprint run (run.json → sprint.cars[].captures) as the expected state.
 */
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
 * Start / lap 1 / lap 2 / finish captures of the 3-lap P61 loop-01 race, using
 * run.json → lapCourse.cars[].captures as the expected state. The page runs the
 * same layout and the same deterministic follower; the prop layer is active.
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
      passCheck(`${car.slug}/${label}: the all-visible prop layer is active`,
        probe.props?.profile === 'all-visible' && probe.props?.colliders === 468,
        JSON.stringify({ profile: probe.props?.profile, colliders: probe.props?.colliders }));

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
    prop: { profile: 'all-visible', colliders: 468 },
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
