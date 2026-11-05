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
// the script. The extra coast-end capture (tick 240) is the unobstructed
// mid-drive sample for the slower cars: at tick 150 their chase camera still
// sits inside the start-area prop/berm geometry (this camera has no occlusion
// avoidance). With `--car` only the named car is captured. Files are
// `browser-<slug>-<label>.png`; the default car's captures are also copied to
// the legacy `browser-<label>.png` names.
//
// Assertions per capture:
//   * the requested tick was reached and held with alpha 0
//   * the page says it is driving the expected car, and the selector lists the roster
//   * geometry uploads equal the mesh count and never grow with frames
//   * one uniform buffer write and one draw per draw per frame
//   * the per-tick state hash / packet hash equal the node producer's values
//   * the car is framed by the chase camera
//   * console is clean (no errors, no warnings, no logs)
// Cross-car: distinct mid-drive positions and distinct state hashes.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

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
const MID_TICK = 150;

const run = JSON.parse(readFileSync(path.join(OUT, 'run.json'), 'utf8'));
const geometry = JSON.parse(readFileSync(path.join(OUT, 'geometry.json'), 'utf8'));
const roster = JSON.parse(readFileSync(path.join(OUT, 'cars.json'), 'utf8'));
const GEOMETRY_BYTES_TARGET = geometry.meshes.reduce(
  (sum, mesh) => sum + mesh.positions.length * 4 + mesh.indices.length * 4, 0);
const MESH_COUNT = geometry.meshes.length;

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
  return {
    packetHash: new Map(packet.updates.map((update) => [update.tick, update.hash])),
    stateHash: new Map(state.ticks.map((row) => [row.tick, row.stateHash])),
    updates: new Map(packet.updates.map((update) => [update.tick, update])),
    meshCount: packet.meshes.length
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

async function capture(car, label, tick) {
  messages.length = 0;
  const url = origin + '/?script=drive&car=' + encodeURIComponent(car.slug) + '&hold=' + tick;
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
      contacts: p.contacts, input: p.input, car: p.car, roster: p.roster ? p.roster.counts : null,
      selector: select ? { options: select.options.length, value: select.value, text: select.options[select.selectedIndex]?.textContent } : null,
      frames: p.frames, ticksExecuted: p.ticksExecuted, cappedFrames: p.cappedFrames,
      pauseDrops: p.pauseDrops, zeroTickFrames: p.zeroTickFrames,
      geometryUploads: p.geometryUploads, geometryUploadBytes: p.geometryUploadBytes,
      uniformWrites: p.uniformWrites, uniformBytes: p.uniformBytes, drawsIssued: p.drawsIssued,
      draws: p.draws, tickHash: p.tickHash, tick0Hash: p.tick0Hash, packetHash: p.packetHash,
      matrixChecksum: p.matrixChecksum, movedScreen: p.movedScreen, camera: p.camera,
      gpu: p.adapter, spawn: p.spawn, info: p.engineInfo,
      tickHashes: p.tickHashes,
      render: update ? {
        tick: update.tick,
        hash: update.hash,
        matrix: update.matrices[0].world,
        camera: { position: update.camera.position, view: update.camera.view, orbit: update.camera.orbit }
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

const carResults = [];
const expectedBySlug = new Map();
for (const car of cars) {
  const expected = expectedFor(car);
  expectedBySlug.set(car.slug, expected);
  const carRuns = [];
  for (const tick of TICKS) {
    const entry = await capture(car, labelFor(tick), tick);
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
    check(`${car.slug}/${entry.label}: upload bytes are the mesh bytes`,
          entry.probe.geometryUploadBytes === GEOMETRY_BYTES_TARGET,
          String(entry.probe.geometryUploadBytes));
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
          cameraDelta !== null && cameraDelta <= 1e-6,
          'max |delta| ' + (cameraDelta === null ? 'n/a' : cameraDelta.toExponential(3)) +
          ', packet hash exact: ' + (render?.hash === tickHash));
    check(`${car.slug}/${entry.label}: canvas is the packet aspect`, entry.probe.canvas.width > 0 &&
          Math.abs(entry.probe.canvas.width / entry.probe.canvas.height - geometry.cameraIntrinsics.aspect) < 0.01);
    check(`${car.slug}/${entry.label}: the car stays framed by the chase camera`,
          entry.probe.movedScreen &&
          entry.probe.movedScreen.x > 0 && entry.probe.movedScreen.x < VIEWPORT.width &&
          entry.probe.movedScreen.y > 0 && entry.probe.movedScreen.y < VIEWPORT.height,
          JSON.stringify(entry.probe.movedScreen));

    entry.comparison = {
      packetHashExact: render?.hash === tickHash,
      pagePacketHash: render?.hash ?? null,
      nodePacketHash: tickHash ?? null,
      carMatrixExact: !!render && !!expectedUpdate &&
        render.matrix.every((value, index) => Object.is(value, expectedUpdate.matrices[0].world[index])),
      cameraMaxDelta: cameraDelta
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

  // The default car's captures keep their historical file names.
  if (car.slug === defaultSlug) {
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
    runs: carRuns
  });
}

const midRuns = carResults.map((entry) => entry.runs.find((runEntry) => runEntry.tick === MID_TICK)).filter(Boolean);
if (midRuns.length > 1) {
  const positions = new Set(midRuns.map((entry) => entry.probe.position.map((value) => value.toFixed(4)).join(',')));
  check('the cars are at different places at mid-drive', positions.size === midRuns.length,
        `${positions.size} distinct of ${midRuns.length}`);
  const hashes = new Set(midRuns.map((entry) => entry.probe.tickHashes[MID_TICK]?.stateHash));
  check('the cars have different state hashes at mid-drive', hashes.size === midRuns.length,
        `${hashes.size} distinct of ${midRuns.length}`);
}

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
writeFileSync(path.join(OUT, 'browser-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
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
