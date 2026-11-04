// Headless Edge (WebGPU) visual + console check for the render packet consumer.
//
// One command: starts the loopback server, launches Edge with WebGPU enabled,
// drives the page over CDP, captures a screenshot and every console/log entry.
//
// Usage: node probes/render-packet/tools/capture_browser.mjs [--edge <msedge.exe>] [--port 8791]

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve_packet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, '_work/render-packet');
const LOG_DIR = path.join(ROOT, '_work/logs/render-packet');
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

const PORT = Number(option('--port', '8791'));
const DEBUG_PORT = Number(option('--debug-port', '9333'));
const PROFILE = path.join(OUT, 'edge-profile');
const VIEWPORT = { width: 1600, height: 900 };

mkdirSync(OUT, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });
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

const frames = (count) => evaluate(`new Promise(resolve=>{let left=${count};const step=()=>{if(--left<=0)resolve(true);else requestAnimationFrame(step)};requestAnimationFrame(step)})`);

/**
 * Drive one held tick. The page runs its own fixed-step loop until it reaches the
 * requested tick, then holds it, so the screenshot is a function of the packet and
 * the tick number, not of wall-clock timing.
 */
async function load(url, label, expectedTick) {
  messages.length = 0;
  await send('Page.navigate', { url });
  let state = null;
  for (let attempt = 0; attempt < 320; attempt++) {
    state = await evaluate(`(()=>{const p=window.renderPacketProbe;return p?{consumer:p.consumer,error:p.error,holdReached:p.holdReached,frames:p.frames,renderTick:p.renderTick}:null})()`).catch(() => null);
    if (state && state.consumer === 'error') break;
    if (state && state.consumer === 'running' && state.holdReached && state.frames >= 12) break;
    await sleep(250);
  }
  if (!state) throw new Error(label + ': consumer never published state');
  if (state.consumer === 'error') throw new Error(label + ': consumer error: ' + state.error);
  if (!state.holdReached) throw new Error(label + ': the fixed-step driver did not reach tick ' + expectedTick);
  // A few more frames so the uniform/upload counters are clearly past the first frame.
  await frames(10);
  const probe = await evaluate(`(()=>{
    const p=window.renderPacketProbe;
    const canvas=document.getElementById('scene');
    return {
      hash:p.packet.hash,
      version:p.packet.version,
      draws:p.packet.diagnostics.drawCount,
      meshes:p.packet.diagnostics.meshCount,
      vertices:p.packet.diagnostics.vertexTotal,
      triangles:p.packet.diagnostics.triangleTotal,
      materials:p.packet.diagnostics.materialsApplied,
      lighting:p.packet.diagnostics.lighting,
      sequence:p.sequence,
      hold:p.hold,
      holdReached:p.holdReached,
      renderTick:p.renderTick,
      alpha:p.alpha,
      tickHash:p.tickHash,
      matrixChecksum:p.matrixChecksum,
      movedScreen:p.movedScreen,
      ticksExecuted:p.ticksExecuted,
      frames:p.frames,
      cappedFrames:p.cappedFrames,
      pauseDrops:p.pauseDrops,
      zeroTickFrames:p.zeroTickFrames,
      geometryUploads:p.geometryUploads,
      geometryUploadBytes:p.geometryUploadBytes,
      uniformWrites:p.uniformWrites,
      uniformBytes:p.uniformBytes,
      drawsIssued:p.drawsIssued,
      camera:p.camera,
      gpu:p.adapter,
      canvas:{width:canvas.width,height:canvas.height}
    };
  })()`);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const png = path.join(OUT, 'browser-' + label + '.png');
  writeFileSync(png, Buffer.from(shot.data, 'base64'));

  // A second, cropped capture centred on the moving body. The clip rectangle is
  // derived from the projected position the page reports, so the crop follows the
  // packet rather than a hand-tuned rectangle.
  let cropPath = null;
  const moved = probe.movedScreen;
  if (moved) {
    // Roughly three times the object's projected size, so the body fills a third of
    // the crop at both ticks instead of shrinking to a dot at distance.
    const width = Math.min(VIEWPORT.width, Math.max(140, Math.round((moved.width || 40) * 3)));
    const height = Math.min(VIEWPORT.height, Math.max(120, Math.round((moved.height || 30) * 3)));
    const x = Math.max(0, Math.min(VIEWPORT.width - width, Math.round(moved.x - width / 2)));
    const y = Math.max(0, Math.min(VIEWPORT.height - height, Math.round(moved.y - height / 2)));
    const clip = { x, y, width, height, scale: 3 };
    const crop = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip });
    cropPath = path.join(OUT, 'browser-' + label + '-car.png');
    writeFileSync(cropPath, Buffer.from(crop.data, 'base64'));
    cropPath = path.relative(ROOT, cropPath).split(path.sep).join('/');
  }
  const screenshot = path.relative(ROOT, png).split(path.sep).join('/');
  return { url, probe, screenshot, carCrop: cropPath, messages: messages.splice(0) };
}

const packetPath = path.join(OUT, 'packet.json');
const packet = JSON.parse(readFileSync(packetPath, 'utf8'));
const TICK_A = 0;
const TICK_B = 90;
if (!packet.updates || TICK_B > packet.updates[packet.updates.length - 1].tick) throw new Error('packet has no timeline to capture');

const runA = await load(origin + '/?hold=' + TICK_A + '&pinCamera=1', 'tick-' + TICK_A, TICK_A);
const runB = await load(origin + '/?hold=' + TICK_B + '&pinCamera=1', 'tick-' + TICK_B, TICK_B);

const allMessages = [...runA.messages, ...runB.messages];
const blocking = allMessages.filter((entry) => entry.source !== 'console.log');
const expectedA = packet.updates[TICK_A];
const expectedB = packet.updates[TICK_B];

// Assertions. Each one is a claim the README and the analysis document repeat.
const failures = [];
const check = (label, condition, detail) => { if (!condition) failures.push(label + (detail ? ': ' + detail : '')); };
for (const [label, run, tick, expected] of [['tick ' + TICK_A, runA, TICK_A, expectedA], ['tick ' + TICK_B, runB, TICK_B, expectedB]]) {
  check(label + ' rendered the requested tick', run.probe.renderTick === tick && run.probe.alpha === 0,
    'renderTick ' + run.probe.renderTick + ' alpha ' + run.probe.alpha);
  check(label + ' reports the packet tick hash', run.probe.tickHash === expected.hash, run.probe.tickHash + ' vs ' + expected.hash);
  check(label + ' geometry uploads equal the mesh count', run.probe.geometryUploads === run.probe.meshes,
    run.probe.geometryUploads + ' uploads for ' + run.probe.meshes + ' meshes');
  check(label + ' issued every draw every frame', run.probe.drawsIssued === run.probe.frames * run.probe.draws,
    run.probe.drawsIssued + ' draws over ' + run.probe.frames + ' frames');
  check(label + ' wrote one uniform buffer per frame', run.probe.uniformWrites === run.probe.frames,
    run.probe.uniformWrites + ' uniform writes over ' + run.probe.frames + ' frames');
}
// The point of a dynamic packet: transforms change, uploads do not.
check('geometry uploads did not grow between ticks', runA.probe.geometryUploads === runB.probe.geometryUploads,
  runA.probe.geometryUploads + ' vs ' + runB.probe.geometryUploads);
check('uploaded bytes are identical', runA.probe.geometryUploadBytes === runB.probe.geometryUploadBytes,
  runA.probe.geometryUploadBytes + ' vs ' + runB.probe.geometryUploadBytes);
check('transforms differ between the two ticks', runA.probe.matrixChecksum !== runB.probe.matrixChecksum,
  runA.probe.matrixChecksum + ' vs ' + runB.probe.matrixChecksum);
check('tick hashes differ between the two ticks', runA.probe.tickHash !== runB.probe.tickHash);
check('the second run really ran frames', runB.probe.frames >= 12, String(runB.probe.frames));
check('the second run advanced the driver', runB.probe.ticksExecuted >= TICK_B, String(runB.probe.ticksExecuted));
check('both runs located the moving body on screen', Boolean(runA.probe.movedScreen && runB.probe.movedScreen));
if (runA.probe.movedScreen && runB.probe.movedScreen) {
  const dx = runB.probe.movedScreen.x - runA.probe.movedScreen.x;
  const dy = runB.probe.movedScreen.y - runA.probe.movedScreen.y;
  const pixels = Math.hypot(dx, dy);
  check('the body moved on screen between the two ticks', pixels > 40,
    'projected displacement ' + pixels.toFixed(1) + ' px at ' + VIEWPORT.width + 'x' + VIEWPORT.height);
  runA.probe.movedScreenPixels = 0;
  runB.probe.movedScreenPixels = Number(pixels.toFixed(2));
}
check('console is clean', blocking.length === 0, blocking.map((entry) => entry.source + ' ' + entry.text).join(' | '));

const evidence = {
  browser: { executable: edge, mode: 'headless=new', flags: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=d3d11'], viewport: VIEWPORT },
  packet: { path: path.relative(ROOT, packetPath).split(path.sep).join('/'), version: packet.version, hash: packet.hash, tickCount: packet.updates.length, tickHz: packet.diagnostics.sequence.tickHz, motion: packet.diagnostics.sequence.motion },
  runs: [runA, runB],
  console: {
    totalMessages: allMessages.length,
    errorsAndWarnings: blocking.length,
    messages: allMessages
  },
  assertions: { ok: failures.length === 0, failures },
  verdict: blocking.length === 0 && failures.length === 0 ? 'clean-console-and-gates' : 'failed'
};
writeFileSync(path.join(OUT, 'browser-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
writeFileSync(path.join(LOG_DIR, 'edge-process.log'), browserLog, 'utf8');

await shutdown();
await sleep(400);
console.log(JSON.stringify({
  verdict: evidence.verdict,
  consoleMessages: evidence.console.totalMessages,
  errorsAndWarnings: evidence.console.errorsAndWarnings,
  failures,
  runs: evidence.runs.map((run) => ({
    url: run.url.replace(origin, ''),
    screenshot: run.screenshot,
    carCrop: run.carCrop,
    movedScreen: run.probe.movedScreen,
    renderTick: run.probe.renderTick,
    alpha: run.probe.alpha,
    tickHash: run.probe.tickHash,
    matrixChecksum: run.probe.matrixChecksum,
    frames: run.probe.frames,
    ticksExecuted: run.probe.ticksExecuted,
    geometryUploads: run.probe.geometryUploads,
    geometryUploadBytes: run.probe.geometryUploadBytes,
    uniformWrites: run.probe.uniformWrites,
    drawsIssued: run.probe.drawsIssued,
    cappedFrames: run.probe.cappedFrames,
    pauseDrops: run.probe.pauseDrops,
    canvas: run.probe.canvas,
    messages: run.messages.length
  })),
  messages: evidence.console.messages
}, null, 2));
if (evidence.verdict !== 'clean-console-and-gates') process.exitCode = 1;
