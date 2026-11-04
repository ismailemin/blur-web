// Headless Edge (WebGPU) capture + console gate for the E1 drive slice.
//
//   node probes/e1-drive/tools/capture_browser.mjs [--edge <msedge.exe>] [--port 8801]
//
// Loads `/?script=drive&hold=<tick>` three times (start / mid / end of the
// scripted drive), waits for the fixed-step driver to reach the requested engine
// tick, captures a 1600x900 screenshot, and records every console message.
//
// The assertions are the ones the analysis document quotes:
//   * the requested tick was reached and held with alpha 0
//   * geometry uploads equal the mesh count (2) and never grow with frames
//   * one uniform buffer write and one draw per draw per frame
//   * the per-tick packet hash equals the hash the node producer recorded for
//     that tick, and the per-tick *state* hash equals the node state sequence
//   * the car moved on screen between the captures
//   * console is clean (no errors, no warnings, no logs)
//
// Artifacts: _work/e1-drive/browser-*.png, browser-evidence.json,
//            _work/logs/e1-drive/edge-process.log

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

const PORT = Number(option('--port', '8801'));
const DEBUG_PORT = Number(option('--debug-port', '9341'));
const PROFILE = path.join(OUT, 'edge-profile');
const VIEWPORT = { width: 1600, height: 900 };
const TICKS = option('--ticks', '0,150,300').split(',').map(Number);
const LABELS = TICKS.map((tick) => (tick === 0 ? 'start' : tick >= 300 ? 'end' : 'mid'));

const packet = JSON.parse(readFileSync(path.join(OUT, 'packet.json'), 'utf8'));
const GEOMETRY_BYTES_TARGET = packet.meshes.reduce(
  (sum, mesh) => sum + mesh.positions.length * 4 + mesh.indices.length * 4, 0);
const run = JSON.parse(readFileSync(path.join(OUT, 'run.json'), 'utf8'));
const stateDoc = JSON.parse(readFileSync(path.join(OUT, 'state_a.json'), 'utf8'));
const expectedState = new Map(stateDoc.ticks.map((row) => [row.tick, row]));

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

async function capture(label, tick) {
  messages.length = 0;
  const url = origin + '/?script=drive&hold=' + tick;
  await send('Page.navigate', { url });
  let probe = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    probe = await evaluate(`(()=>{const p=window.e1DriveProbe;return p?{state:p.consumer,error:p.error,engineTick:p.engineTick,displayTick:p.displayTick,frames:p.frames,holdReached:p.holdReached,draws:p.draws}:null})()`).catch(() => null);
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
    return {
      mode: p.mode, engineTick: p.engineTick, displayTick: p.displayTick, phase: p.phase, speed: p.speed, position: p.position,
      contacts: p.contacts, input: p.input,
      frames: p.frames, ticksExecuted: p.ticksExecuted, cappedFrames: p.cappedFrames,
      pauseDrops: p.pauseDrops, zeroTickFrames: p.zeroTickFrames,
      geometryUploads: p.geometryUploads, geometryUploadBytes: p.geometryUploadBytes,
      uniformWrites: p.uniformWrites, uniformBytes: p.uniformBytes, drawsIssued: p.drawsIssued,
      draws: p.draws, tickHash: p.tickHash, tick0Hash: p.tick0Hash, packetHash: p.packetHash,
      matrixChecksum: p.matrixChecksum, movedScreen: p.movedScreen, camera: p.camera,
      gpu: p.adapter, spawn: p.spawn, info: p.engineInfo,
      tickHashes: p.tickHashes,
      canvas: { width: canvas.width, height: canvas.height }
    };
  })()`);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, 'browser-' + label + '.png');
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
    crop = path.join(OUT, 'browser-' + label + '-car.png');
    writeFileSync(crop, Buffer.from(clipped.data, 'base64'));
  }
  return {
    label,
    url,
    screenshot: path.relative(ROOT, file).split(path.sep).join('/'),
    carCrop: crop ? path.relative(ROOT, crop).split(path.sep).join('/') : null,
    probe: full,
    messages: messages.splice(0)
  };
}

const runs = [];
for (let index = 0; index < TICKS.length; index++) {
  runs.push(await capture(LABELS[index], TICKS[index]));
}

const allMessages = runs.flatMap((entry) => entry.messages);
const blocking = allMessages.filter((entry) => entry.source !== 'console.log');

const failures = [];
const check = (label, ok, detail) => { if (!ok) failures.push(label + (detail ? ': ' + detail : '')); };
const meshes = packet.meshes.length;

for (const entry of runs) {
  const tick = entry.probe.displayTick;
  const expectedUpdate = packet.updates[tick];
  const expectedRow = expectedState.get(tick);
  check(entry.label + ': held at tick ' + tick + ' with the packet tick hash',
        entry.probe.frames > 0 && entry.probe.tickHash === expectedUpdate.hash,
        'tickHash ' + entry.probe.tickHash + ' vs ' + expectedUpdate.hash);
  check(entry.label + ': geometry uploads equal the mesh count',
        entry.probe.geometryUploads === meshes,
        entry.probe.geometryUploads + ' uploads for ' + meshes + ' meshes');
  check(entry.label + ': upload bytes are the mesh bytes',
        entry.probe.geometryUploadBytes === GEOMETRY_BYTES_TARGET,
        String(entry.probe.geometryUploadBytes));
  check(entry.label + ': one uniform write per frame',
        entry.probe.uniformWrites === entry.probe.frames,
        entry.probe.uniformWrites + ' writes / ' + entry.probe.frames + ' frames');
  check(entry.label + ': one draw per draw per frame',
        entry.probe.drawsIssued === entry.probe.frames * entry.probe.draws,
        entry.probe.drawsIssued + ' draws / ' + entry.probe.frames + ' frames * ' + entry.probe.draws);
  check(entry.label + ': the browser state hash matches the node sequence',
        expectedRow && entry.probe.tickHashes[tick]?.stateHash === expectedRow.stateHash,
        (entry.probe.tickHashes[tick]?.stateHash ?? 'none') + ' vs ' + (expectedRow?.stateHash ?? 'none'));
  check(entry.label + ': the browser packet hash matches the node packet tick hash',
        expectedRow && entry.probe.tickHashes[tick]?.packetHash === expectedUpdate.hash);
  check(entry.label + ': the tick hash the consumer rendered is the packet tick hash',
        entry.probe.tickHash === expectedUpdate.hash);
  check(entry.label + ': canvas is the packet aspect', entry.probe.canvas.width > 0 &&
        Math.abs(entry.probe.canvas.width / entry.probe.canvas.height - packet.camera.aspect) < 0.01);
}

check('geometry uploads do not grow between ticks',
      new Set(runs.map((entry) => entry.probe.geometryUploads)).size === 1,
      runs.map((entry) => entry.probe.geometryUploads).join(','));
const worldDistance = (a, b) => Math.hypot(
  a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]);
if (runs.length === 3) {
  check('the car travelled more than 20 m between start and end',
        worldDistance(runs[0].probe, runs[2].probe) > 20,
        worldDistance(runs[0].probe, runs[2].probe).toFixed(2) + ' m');
}
check('the car stays framed by the chase camera at every capture',
      runs.every((entry) => entry.probe.movedScreen &&
        entry.probe.movedScreen.x > 0 && entry.probe.movedScreen.x < VIEWPORT.width &&
        entry.probe.movedScreen.y > 0 && entry.probe.movedScreen.y < VIEWPORT.height),
      JSON.stringify(runs.map((entry) => entry.probe.movedScreen)));
if (runs.length === 3) {
  check('matrix checksums differ between start and end',
        runs[0].probe.matrixChecksum !== runs[2].probe.matrixChecksum,
        runs[0].probe.matrixChecksum + ' vs ' + runs[2].probe.matrixChecksum);
}
check('the whole scripted sequence ran in the browser',
      runs[runs.length - 1].probe.ticksExecuted >= 299, String(runs[runs.length - 1].probe.ticksExecuted));
check('the browser drove at a real speed',
      runs[runs.length - 1].probe.speed < 1.5 && (runs.length < 3 || runs[1].probe.speed > 5),
      `${runs.map((entry) => entry.probe.speed.toFixed(2)).join(' / ')} m/s`);
check('console is clean', blocking.length === 0,
      blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));

const evidence = {
  browser: {
    executable: edge,
    mode: 'headless=new',
    flags: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=d3d11'],
    viewport: VIEWPORT
  },
  module: run.module,
  drive: {
    spawn: run.drive.spawn,
    groundProbe: run.drive.groundProbe,
    tickHz: run.drive.tickHz,
    script: run.drive.script,
    stateSequenceHash: run.determinism.stateSequenceHash
  },
  packet: {
    path: run.packet.path,
    hash: run.packet.hash,
    bytes: run.packet.bytes,
    updates: run.packet.updates,
    draws: run.packet.draws
  },
  runs,
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
  failures,
  runs: runs.map((entry) => ({
    label: entry.label,
    url: entry.url.replace(origin, ''),
    screenshot: entry.screenshot,
    carCrop: entry.carCrop,
    engineTick: entry.probe.engineTick,
    displayTick: entry.probe.displayTick,
    phase: entry.probe.phase,
    speed: entry.probe.speed,
    position: entry.probe.position,
    contacts: entry.probe.contacts,
    tickHash: entry.probe.tickHash,
    stateHash: entry.probe.tickHashes[entry.probe.displayTick]?.stateHash ?? null,
    matrixChecksum: entry.probe.matrixChecksum,
    frames: entry.probe.frames,
    ticksExecuted: entry.probe.ticksExecuted,
    geometryUploads: entry.probe.geometryUploads,
    geometryUploadBytes: entry.probe.geometryUploadBytes,
    uniformWrites: entry.probe.uniformWrites,
    drawsIssued: entry.probe.drawsIssued,
    gpu: entry.probe.gpu,
    canvas: entry.probe.canvas,
    messages: entry.messages.length
  }))
}, null, 2));
if (evidence.verdict !== 'clean-console-and-gates') process.exitCode = 1;
