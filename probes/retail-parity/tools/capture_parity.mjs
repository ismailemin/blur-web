// Headless Edge/WebGPU capture of four fixed camera poses for the retail-parity
// audit. Read-only: it loads the committed geometry chunks and the committed
// packet consumer/adapter, renders the current slice, and writes screenshots +
// an evidence JSON. It does not modify probes/e1-drive or the renderer.
//
//   node probes/retail-parity/tools/capture_parity.mjs [--edge <path>] [--port 8844]

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve_parity.mjs';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const OUT = join(ROOT, '_work', 'retail-parity');
const SHOTS = join(OUT, 'screenshots');
const LOGS = join(ROOT, '_work', 'logs', 'retail-parity');
const VIEWPORT = { width: 1600, height: 900 };

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const PORT = Number(option('--port', 8844));
const DEBUG_PORT = Number(option('--debug-port', 9411));
const EDGE_CANDIDATES = [
  option('--edge', ''),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
const edge = EDGE_CANDIDATES.find((candidate) => candidate && existsSync(candidate));
if (!edge) throw new Error('msedge.exe not found; pass --edge <path>');

const PROFILES = join(OUT, 'edge-profile-' + PORT);
mkdirSync(SHOTS, { recursive: true });
mkdirSync(LOGS, { recursive: true });
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let attempt = 0; ; attempt++) {
  try { rmSync(PROFILES, { recursive: true, force: true }); break; }
  catch (error) {
    if (attempt >= 19 || (error.code !== 'EPERM' && error.code !== 'EBUSY')) throw error;
    sleepSync(250);
  }
}
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const { server, origin } = await startServer({ port: PORT });
const browser = spawn(edge, [
  '--headless=new',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=d3d11',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + PROFILES,
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
await new Promise((resolvePromise, reject) => {
  socket.addEventListener('open', resolvePromise, { once: true });
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
const send = (method, params = {}) => new Promise((resolvePromise, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve: resolvePromise, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error('evaluate failed: ' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
  }
  return result.result.value;
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});

const pageUrl = `${origin}/probes/retail-parity/web/index.html?tag=0`;
await send('Page.navigate', { url: pageUrl });
let ready = false;
for (let attempt = 0; attempt < 240; attempt++) {
  try {
    ready = await evaluate('Boolean(window.__parityReady) || Boolean(window.__parityError)');
    if (ready) break;
  } catch {}
  await sleep(250);
}
if (!ready) throw new Error('parity page never became ready');
const initError = await evaluate('window.__parityError ?? null');
if (initError) throw new Error('parity page failed: ' + initError);

const POSES = [
  ['A', 'pose-A-start-chase'],
  ['B', 'pose-B-start-map'],
  ['C', 'pose-C-exit100-chase'],
  ['D', 'pose-D-exit100-map']
];
const records = [];
for (const [key, file] of POSES) {
  const record = await evaluate(`window.__parityPose(${JSON.stringify(key)})`);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(SHOTS, file + '.png'), Buffer.from(shot.data, 'base64'));
  records.push({ ...record, screenshot: relative(ROOT, join(SHOTS, file + '.png')).split('\\').join('/') });
  console.log('captured ' + key + ' -> ' + file + '.png');
}

// Stable pose document: everything a retail capture needs to reproduce a view.
const poses = {};
for (const record of records) {
  const camera = record.camera;
  poses[record.key] = {
    tick: record.tick,
    mode: record.mode,
    carPosition: record.carPosition,
    cameraPosition: camera.position,
    target: camera.target,
    near: camera.near,
    far: camera.far,
    verticalFovRadians: camera.verticalFovRadians,
    verticalFovDegrees: +(camera.verticalFovRadians * 180 / Math.PI).toFixed(6),
    aspect: camera.aspect,
    orbit: record.poses ?? camera.orbit,
    view: camera.view,
    projection: camera.projection,
    screenshot: record.screenshot
  };
}
writeFileSync(join(OUT, 'camera-poses.json'), JSON.stringify({
  kind: 'retail-parity.camera-poses',
  version: 1,
  target: { car: 'corvette-zr1-stock', map: 'usa_la_river', section: '0..100 m' },
  viewport: VIEWPORT,
  notes: [
    'FOV 45 deg is the committed cameraIntrinsics (FOV_Y = Math.PI/4 from probes/render-packet/tools/build_packet.mjs); it is not a recovered retail FOV.',
    'Chase poses use the committed ChaseCamera (distance 9.0 m, height 2.4 m, lookHeight 1.0 m) from the recorded sprint pose; the sprint camera history/smoothing is not replayed.',
    'Orbit poses are fixed world cameras derived from the measured P48 path, with the same 45 deg FOV; see the inventory poses.'
  ],
  poses
}, null, 1) + '\n');

const consoleIssues = messages.filter((entry) => !entry.source.endsWith('.log'));
const evidence = {
  kind: 'retail-parity.capture',
  version: 1,
  page: pageUrl,
  browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT },
  console: { total: messages.length, issues: consoleIssues.length, messages },
  poses,
  captures: records,
  limits: [
    'The car pose is reconstructed from the committed sprint run (position + axisZ); axisX/axisY are a world-up orthonormalisation and the wheel records are the manifest rest translations, so this is a reference pose, not a new physics run.',
    'The packet is built by the committed adapter from the committed geometry chunks; the page does not step the engine.',
    'FOV is the committed 45 deg PoC camera, not a retail value.'
  ]
};
writeFileSync(join(OUT, 'capture.json'), JSON.stringify(evidence, null, 1) + '\n');
writeFileSync(join(LOGS, 'edge-capture.log'), browserLog, 'utf8');

console.log(JSON.stringify({
  poses: Object.keys(poses),
  console: { total: messages.length, issues: consoleIssues.length },
  draws: records.map((record) => ({ key: record.key, draws: record.stats.draws, textured: record.stats.texturedDraws }))
}, null, 1));

try { browser.kill(); } catch {}
await new Promise((resolvePromise) => server.close(resolvePromise));
if (consoleIssues.length) process.exitCode = 1;
