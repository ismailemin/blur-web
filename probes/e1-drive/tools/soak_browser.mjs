// Deterministic long-session soak for the E1 drive slice (headless Edge/WebGPU).
//
//   node probes/e1-drive/tools/soak_browser.mjs [--minutes 5] [--runs 2]
//        [--ticks-per-frame 4] [--car <slug>] [--port 8841] [--debug-port 9347]
//
// Loads `/?soak=1&soakSeconds=<minutes*60>&soakTicksPerFrame=<n>&car=<slug>` and
// waits for the page's deterministic soak plan:
//
//   drive      300 ticks, then e1_reset + new packet timeline
//   sprint     countdown + both checkpoints + finish + 120-tick brake tail
//   telemetry  the three diagnostic manoeuvres (three e1_reset builds)
//   ...repeat until `minutes` of simulated ticks (60 Hz) are complete
//
// Every segment rebuilds the wasm world and reloads the packet (three meshes).
// The page records per-frame wall-clock time and work time, one heap/pool/upload
// sample per simulated second, and a checkpoint after every segment. This tool:
//
//   * runs the whole plan twice in two fresh page/module instances,
//   * captures start, mid-session and end screenshots,
//   * records every console message (gate: 0 messages of any kind),
//   * checks the deterministic checkpoints against each other and against
//     `_work/e1-drive/run.json` (drive/sprint state sequence + packet hashes, and
//     every telemetry metric/trace hash),
//   * reports frame-time p50/p95/p99/max, heap, scheduler pool, buffer counts,
//     geometry/uniform uploads and the segment/transition log.
//
// Headless Edge is a proxy. Frame times measure this headless WebGPU loop at the
// chosen ticks-per-frame; they are not a claim about the user's GPU, display or
// retail frame rate. The simulation hash comparison is exact because the tick
// sequence never depends on wall-clock time.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const MINUTES = Number(option('--minutes', '5'));
const RUNS = Number(option('--runs', '2'));
const TICKS_PER_FRAME = Number(option('--ticks-per-frame', '4'));
const PORT = Number(option('--port', '8841'));
const DEBUG_PORT = Number(option('--debug-port', '9347'));
const ONLY_CAR = option('--car', null);
const VIEWPORT = { width: 1600, height: 900 };
if (!Number.isInteger(MINUTES) || MINUTES < 1 || MINUTES > 60) throw new Error('--minutes must be an integer in [1, 60]');
if (!Number.isInteger(RUNS) || RUNS < 1 || RUNS > 4) throw new Error('--runs must be an integer in [1, 4]');
if (!Number.isInteger(TICKS_PER_FRAME) || TICKS_PER_FRAME < 1 || TICKS_PER_FRAME > 8) {
  throw new Error('--ticks-per-frame must be an integer in [1, 8]');
}
const SECONDS = MINUTES * 60;
const TARGET_TICKS = SECONDS * 60;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const runDocument = JSON.parse(readFileSync(path.join(OUT, 'run.json'), 'utf8'));
const roster = JSON.parse(readFileSync(path.join(OUT, 'cars.json'), 'utf8'));
const cars = roster.roster.cars.filter((car) => !ONLY_CAR || car.slug === ONLY_CAR || car.name === ONLY_CAR);
if (cars.length === 0) {
  throw new Error('unknown car ' + JSON.stringify(ONLY_CAR) + '; roster: ' +
    roster.roster.cars.map((car) => car.slug).join(', '));
}
const car = cars[0];
const nodeCar = runDocument.cars.find((entry) => entry.slug === car.slug);
const nodeSprint = runDocument.sprint?.cars?.find((entry) => entry.slug === car.slug);
const nodeTelemetry = runDocument.telemetry?.cars?.find((entry) => entry.slug === car.slug);
if (!nodeCar || !nodeSprint || !nodeTelemetry) {
  throw new Error('run.json is missing the drive/sprint/telemetry anchors for ' + car.slug +
    ' — run `node probes/e1-drive/tools/verify_e1_drive.mjs` first');
}

const { server, origin } = await startServer({ port: PORT });

function launchEdge(profile) {
  const browser = spawn(edge, [
    '--headless=new',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--use-angle=d3d11',
    '--remote-debugging-port=' + DEBUG_PORT,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-component-update',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--enable-precise-memory-info',
    '--js-flags=--expose-gc',
    '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  browser.stderr.on('data', (chunk) => { log += chunk.toString(); });
  browser.stdout.on('data', (chunk) => { log += chunk.toString(); });
  return { browser, log: () => log };
}

async function waitForTarget() {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      if (response.ok) {
        const list = await response.json();
        const page = list.find((entry) => entry.type === 'page');
        if (page) return page;
      }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Edge devtools endpoint unreachable');
}

async function connect(page) {
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
      messages.push({ source: 'log.' + message.params.entry.level, text: message.params.entry.text,
        url: message.params.entry.url });
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
  await send('HeapProfiler.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
  return { socket, send, evaluate, messages, close: () => socket.close() };
}

async function screenshot(cdp, file) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return path.relative(ROOT, file).split(path.sep).join('/');
}

async function readProbe(cdp) {
  return cdp.evaluate(`(()=>{
    const p = window.e1DriveProbe;
    if (!p) return null;
    return {
      state: p.consumer, error: p.error, mode: p.mode,
      soak: p.soak ?? null,
      report: p.soakReport ?? null,
      adapter: p.adapter ?? null, frames: p.frames ?? 0,
      geometryUploads: p.geometryUploads ?? 0,
      status: document.documentElement.dataset.soak ?? null
    };
  })()`);
}

const PROFILE = path.join(OUT, 'edge-soak-profile');
rmSync(PROFILE, { recursive: true, force: true });

const edgeProcess = launchEdge(PROFILE);
const page = await waitForTarget();
const cdp = await connect(page);
const shutdown = async () => {
  try { cdp.close(); } catch {}
  try { edgeProcess.browser.kill(); } catch {}
  await new Promise((resolve) => server.close(resolve));
};
process.on('exit', () => { try { edgeProcess.browser.kill(); } catch {} });

const runResults = [];
const failures = [];
const recordFailure = (label, detail) => failures.push(label + (detail ? ': ' + detail : ''));

try {
  for (let runIndex = 0; runIndex < RUNS; runIndex++) {
    const runNumber = runIndex + 1;
    cdp.messages.length = 0;
    const url = origin + '/?soak=1&soakSeconds=' + SECONDS + '&soakTicksPerFrame=' + TICKS_PER_FRAME +
      '&car=' + encodeURIComponent(car.slug);
    await cdp.send('Page.navigate', { url });
    const startedAt = Date.now();
    let probe = null;
    let startShot = null;
    let midShot = null;
    let framesSeen = 0;

    for (let attempt = 0; attempt < 24000; attempt++) {
      probe = await readProbe(cdp).catch(() => null);
      if (probe?.state === 'error') break;
      if (probe?.report?.status) break;
      if (probe?.soak && !startShot && probe.frames >= 12 && probe.soak.totalTicks > 0) {
        startShot = await screenshot(cdp, path.join(OUT, `browser-soak-run${runNumber}-start.png`));
      }
      if (probe?.soak && !midShot && probe.soak.totalTicks >= Math.floor(TARGET_TICKS / 2)) {
        midShot = await screenshot(cdp, path.join(OUT, `browser-soak-run${runNumber}-mid.png`));
      }
      if (probe?.soak) framesSeen = Math.max(framesSeen, probe.frames ?? 0);
      await sleep(250);
    }
    if (!probe) throw new Error('run ' + runNumber + ': page never published a probe');
    if (probe.state === 'error' && !probe.report) {
      throw new Error('run ' + runNumber + ': page error: ' + probe.error);
    }
    if (!probe.report) throw new Error('run ' + runNumber + ': soak never finished');
    const wallSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(2));
    const endShot = await screenshot(cdp, path.join(OUT, `browser-soak-run${runNumber}-end.png`));
    const messages = cdp.messages.splice(0);
    let heapUsage = null;
    try {
      await cdp.send('HeapProfiler.collectGarbage');
      heapUsage = await cdp.send('Runtime.getHeapUsage');
    } catch { heapUsage = null; }

    const report = probe.report;
    const consoleErrors = messages.filter((message) => message.source !== 'console.log');
    const result = {
      run: runNumber,
      url: url.replace(origin, ''),
      car: { slug: car.slug, name: car.name },
      wallSeconds,
      framesSeen,
      status: report.status,
      report,
      console: { totalMessages: messages.length, errorsAndWarnings: consoleErrors.length, messages },
      heapUsage,
      screenshots: { start: startShot, mid: midShot, end: endShot },
      adapter: probe.adapter
    };
    runResults.push(result);
    writeFileSync(path.join(OUT, `soak-run-${runNumber}.json`), JSON.stringify(result, null, 2) + '\n', 'utf8');

    if (report.status !== 'PASS') recordFailure(`run ${runNumber}: page soak status`, report.status);
    if (messages.length !== 0) {
      recordFailure(`run ${runNumber}: console is clean`, messages.map((m) => m.source + ' ' + m.text).join(' | '));
    }
    if (report.totalTicks < TARGET_TICKS) {
      recordFailure(`run ${runNumber}: simulated budget reached`, `${report.totalTicks}/${TARGET_TICKS}`);
    }
    if (!report.checks.every((check) => check.ok)) {
      recordFailure(`run ${runNumber}: page checks`, report.failures.join(' | '));
    }
    if (!Array.isArray(report.checkpoints)) {
      throw new Error('run ' + runNumber + ': soak report has no checkpoints: ' +
        JSON.stringify({ status: report.status, failures: report.failures, error: report.error }));
    }
    // Node anchors, every cycle of this run (all drive segments are identical).
    const driveCheckpoints = report.checkpoints.filter((row) => row.label === 'drive-complete');
    const sprintCheckpoints = report.checkpoints.filter((row) => row.label === 'sprint-complete');
    const telemetryCheckpoints = report.checkpoints.filter((row) => row.label === 'telemetry-complete');
    const completeDrive = driveCheckpoints.filter((row) => !row.truncated);
    const completeSprint = sprintCheckpoints.filter((row) => !row.truncated);
    if (completeDrive.length === 0 ||
        completeDrive.some((row) => row.stateSequenceHash !== nodeCar.determinism.stateSequenceHash)) {
      recordFailure(`run ${runNumber}: every complete drive segment reproduces the node drive state sequence`,
        completeDrive[0] ? `${completeDrive[0].stateSequenceHash}` : 'missing');
    }
    if (completeSprint.length === 0 ||
        completeSprint.some((row) => row.stateSequenceHash !== nodeSprint.stateSequenceHash ||
          row.finishTick !== nodeSprint.finish.tick ||
          Math.abs(row.finishSeconds - nodeSprint.finish.timeSeconds) > 1e-9 ||
          row.checkpointsPassed !== 2 || row.respawns !== 0)) {
      recordFailure(`run ${runNumber}: every complete sprint segment reproduces the node state sequence, finish tick and time`,
        completeSprint[0] ? `${completeSprint[0].stateSequenceHash} / ${completeSprint[0].finishSeconds} s` : 'missing');
    }
    if (telemetryCheckpoints.some((row) => row.truncated) ||
        telemetryCheckpoints.length !== report.segments.telemetry ||
        telemetryCheckpoints.some((row) => {
          const expected = nodeTelemetry.hashes;
          return !row.telemetry ||
            JSON.stringify(row.telemetry.metrics) !== JSON.stringify(nodeTelemetry.metrics) ||
            Object.keys(expected).some((manoeuvre) =>
              row.telemetry.manoeuvres[manoeuvre]?.aggregate !== expected[manoeuvre].aggregate ||
              row.telemetry.manoeuvres[manoeuvre]?.traceHash !== expected[manoeuvre].traceHash ||
              row.telemetry.manoeuvres[manoeuvre]?.ticks !== expected[manoeuvre].ticks);
        })) {
      recordFailure(`run ${runNumber}: every telemetry segment matches the node metrics and trace hashes`);
    }
    // Informational only: the browser's canonical packet hash can differ from the
    // Node producer's by the documented last-bit Math.atan2 / Math.sin difference
    // in the chase camera or wheel spin matrix. The deterministic gate is the
    // state sequence above and the two Edge runs compared below.
    result.nodePacketAgreement = {
      driveExact: driveCheckpoints.length > 0 &&
        driveCheckpoints.every((row) => row.packetHash === nodeCar.packet.hash),
      sprintExact: sprintCheckpoints.length > 0 &&
        sprintCheckpoints.every((row) => row.packetHash === nodeSprint.packet.hash),
      note: 'informational: Edge vs Node transcendental last-bit difference; state sequence, finish and ' +
        'telemetry hashes are gated exactly'
    };
    writeFileSync(path.join(OUT, `soak-run-${runNumber}.json`), JSON.stringify(result, null, 2) + '\n', 'utf8');
  }
} finally {
  writeFileSync(path.join(LOGS, 'edge-soak.log'), edgeProcess.log(), 'utf8');
  await shutdown();
}

// ---------------------------------------------------------------- cross-run
const comparisons = [];
const silhouette = (report) => report.checkpoints.map((row) => ({
  label: row.label,
  cycle: row.cycle,
  totalTicks: row.totalTicks,
  engineTick: row.engineTick,
  stateHash: row.stateHash,
  lastUpdateHash: row.lastUpdateHash,
  packetHash: row.packetHash ?? null,
  stateSequenceHash: row.stateSequenceHash ?? null,
  finishTick: row.finishTick ?? null,
  finishSeconds: row.finishSeconds ?? null,
  checkpointsPassed: row.checkpointsPassed ?? null,
  telemetry: row.telemetry ? {
    manoeuvres: row.telemetry.manoeuvres,
    metrics: row.telemetry.metrics
  } : null
}));
if (runResults.length === 2) {
  const a = silhouette(runResults[0].report);
  const b = silhouette(runResults[1].report);
  const same = JSON.stringify(a) === JSON.stringify(b);
  comparisons.push({ label: 'two soak runs produce identical checkpoint hashes', ok: same,
    detail: same ? `${a.length} checkpoints` : 'checkpoint sequence differs' });
  const sameGeo = runResults[0].report.buffers.geometryUploads === runResults[1].report.buffers.geometryUploads &&
    runResults[0].report.buffers.packetLoads === runResults[1].report.buffers.packetLoads;
  comparisons.push({ label: 'two soak runs load the same packet/geometry count', ok: sameGeo,
    detail: `${runResults[0].report.buffers.packetLoads} vs ${runResults[1].report.buffers.packetLoads} loads` });
  for (const comparison of comparisons.filter((entry) => !entry.ok)) {
    recordFailure(comparison.label, comparison.detail);
  }
} else {
  comparisons.push({ label: 'determinism needs two runs', ok: false, detail: `${runResults.length} run(s)` });
  recordFailure('determinism: --runs 2 required', String(runResults.length));
}

const verdict = failures.length === 0 ? 'PASS' : 'FAIL';
const evidence = {
  kind: 'e1-drive.soak-evidence',
  version: 1,
  date: new Date().toISOString(),
  browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT,
    flags: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=d3d11',
      '--enable-precise-memory-info', '--js-flags=--expose-gc'] },
  car: { slug: car.slug, name: car.name },
  spec: {
    minutes: MINUTES,
    seconds: SECONDS,
    targetTicks: TARGET_TICKS,
    tickHz: 60,
    ticksPerFrame: TICKS_PER_FRAME,
    runs: RUNS,
    mode: 'deterministic fixed-step (1/60 s per tick), driven one or more ticks per requestAnimationFrame'
  },
  anchors: {
    drive: { stateSequenceHash: nodeCar.determinism.stateSequenceHash, packetHash: nodeCar.packet.hash },
    sprint: { stateSequenceHash: nodeSprint.stateSequenceHash, packetHash: nodeSprint.packet.hash,
      finishTick: nodeSprint.finish.tick, finishSeconds: nodeSprint.finish.timeSeconds },
    telemetry: nodeTelemetry.hashes
  },
  runs: runResults.map((result) => ({
    run: result.run,
    wallSeconds: result.wallSeconds,
    status: result.status,
    totalTicks: result.report.totalTicks,
    cycles: result.report.cycles,
    segments: result.report.segments,
    frames: result.report.frames,
    memory: result.report.memory,
    scheduler: result.report.scheduler,
    buffers: result.report.buffers,
    transitions: result.report.transitions,
    console: result.console,
    heapUsage: result.heapUsage,
    screenshots: result.screenshots,
    adapter: result.adapter,
    nodePacketAgreement: result.nodePacketAgreement ?? null
  })),
  comparisons,
  failures,
  verdict
};
writeFileSync(path.join(OUT, 'browser-evidence-soak.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({
  verdict,
  car: car.slug,
  minutes: MINUTES,
  ticksPerFrame: TICKS_PER_FRAME,
  runs: evidence.runs.map((run) => ({
    run: run.run,
    wallSeconds: run.wallSeconds,
    totalTicks: run.totalTicks,
    cycles: run.cycles,
    segments: run.segments,
    frames: run.frames,
    memory: { wasmHeapBytes: run.memory.wasmHeapBytes,
      jsHeapGrowthBytes: run.memory.jsHeap.growthBytes, gcAvailable: run.memory.jsHeap.gcAvailable },
    scheduler: run.scheduler,
    buffers: run.buffers,
    console: { total: run.console.totalMessages, errorsAndWarnings: run.console.errorsAndWarnings },
    screenshots: run.screenshots
  })),
  comparisons,
  failures
}, null, 2));
if (verdict !== 'PASS') process.exitCode = 1;
