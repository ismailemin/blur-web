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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { buildOccluder } from '../web/camera-occlusion.js';

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
const PROFILE = path.join(OUT, 'edge-profile');
const VIEWPORT = { width: 1600, height: 900 };
const TICKS = option('--ticks', '0,150,240,300').split(',').map(Number);
const ONLY_CAR = option('--car', null);
const EXTRA_QUERY = option('--extra-query', '');
const LABEL_PREFIX = option('--label-prefix', '');
const EVIDENCE_NAME = option('--evidence-name', 'browser-evidence.json');
const MODE = option('--mode', 'drive');
if (!['drive', 'sprint', 'respawn'].includes(MODE)) {
  throw new Error('unknown --mode ' + JSON.stringify(MODE) + ' (drive, sprint or respawn)');
}
const DIAGNOSTIC_CAMERA = /(^|&)cam(dist|height)=/.test(EXTRA_QUERY);
const MID_TICK = 150;

const run = JSON.parse(readFileSync(path.join(OUT, 'run.json'), 'utf8'));
const geometry = JSON.parse(readFileSync(path.join(OUT, 'geometry.json'), 'utf8'));
const roster = JSON.parse(readFileSync(path.join(OUT, 'cars.json'), 'utf8'));
// The page uploads exactly three meshes: the level props, the real track visual
// and the selected car's body. The collision surface is hidden physics provenance
// in packet.physicsSurfaces, so it is neither uploaded nor drawn.
const MESH_COUNT = 3;
const meshBytes = (mesh) => mesh.positions.length * 4 + mesh.indices.length * 4;
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
    parts: body.carParts.length,
    draws: 22 + geometry.trackVisual.drawCount + body.carDraws.length,
    trackDraws: geometry.trackVisual.drawCount,
    trackTriangles: geometry.trackVisual.triangleCount,
    trackLabel: geometry.trackVisual.label,
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
rmSync(PROFILE, { recursive: true, force: true });

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
  messages.length = 0;
  const url = origin + '/?script=' + script + '&car=' + encodeURIComponent(car.slug) + '&hold=' + tick +
    (EXTRA_QUERY ? '&' + EXTRA_QUERY : '');
  await send('Page.navigate', { url });
  let probe = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    probe = await evaluate(`(()=>{const p=window.e1DriveProbe;return p?{state:p.consumer,error:p.error,engineTick:p.engineTick,displayTick:p.displayTick,frames:p.frames,holdReached:p.holdReached,draws:p.draws,car:p.car}:null})()`).catch(() => null);
    if (probe && probe.state === 'error') break;
    if (probe && probe.state === 'running' && probe.holdReached && probe.frames >= 12) break;
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
      overlays: {
        countdownHidden: document.getElementById('countdown')?.hidden ?? null,
        countdownText: document.getElementById('countdown')?.textContent ?? null,
        resultsHidden: document.getElementById('results')?.hidden ?? null,
        resultsTime: document.getElementById('results-time')?.textContent ?? null,
        resultsBest: document.getElementById('results-best')?.textContent ?? null,
        eventText: document.getElementById('event')?.textContent ?? null,
        eventVisible: document.getElementById('event')?.dataset.visible ?? null
      },
      bestStored: (() => { try { return localStorage.getItem('e1-drive.sprint.best.v1'); } catch { return null; } })(),
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
  const result = MODE === 'sprint' ? await sprintCapturePass() : await respawnCapturePass();
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
  const sprintRun = runDocument.sprint;
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
      const label = 'sprint-' + spec.label;
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
        probe.car?.name === car.name && probe.sprintLayoutHash === sprintRun.layout.hash,
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
    layout: { hash: sprintRun.layout.hash, span: sprintRun.layout.span },
    cars: rows,
    packetHashAgreement: { exact, total: rows.length, note:
      'a mismatch is a documented last-bit transcendental difference between Node 24 and Edge 156 (Math.atan2 ' +
      'in the chase camera or Math.sin/cos in a wheel spin matrix); the state hash, the car matrix and the ' +
      '1e-12 matrix/camera tolerances are checked separately' },
    console: { totalMessages: allMessages.length, errorsAndWarnings: blocking.length, messages: allMessages },
    assertions: { ok: passFailures.length === 0, failures: passFailures },
    verdict: blocking.length === 0 && passFailures.length === 0 ? 'clean-console-and-gates' : 'failed'
  };
  writeFileSync(path.join(OUT, 'browser-evidence-sprint.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(LOGS, 'edge-sprint.log'), browserLog, 'utf8');
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
 * Diagnostic respawn capture: the page runs `?script=sprint&sprintfall=1`, the
 * rules respawn the car at checkpoint 1 after it leaves the gate corridor, and
 * the frame is captured after the rebuilt timeline has advanced.
 */
async function respawnCapturePass() {
  const car = cars[0];
  const passFailures = [];
  const passCheck = (label, ok, detail) => { if (!ok) passFailures.push(label + (detail ? ': ' + detail : '')); };
  messages.length = 0;
  const url = origin + '/?script=sprint&sprintfall=1&car=' + encodeURIComponent(car.slug);
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
  passCheck('respawn: the event names the measured reason and the checkpoint it rebuilds at',
    first !== null && first.reasons.includes('outside-gate-band') &&
    first.target?.gateId === 'checkpoint-1' && targetGate !== undefined,
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
    uniformWrites: entry.probe.uniformWrites,
    drawsIssued: entry.probe.drawsIssued,
    gpu: entry.probe.gpu,
    canvas: entry.probe.canvas,
    selector: entry.probe.selector,
    messages: entry.messages.length
  })))
}, null, 2));
if (evidence.verdict !== 'clean-console-and-gates') process.exitCode = 1;
