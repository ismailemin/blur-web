// Headless Edge (WebGPU) visual + console check for the render packet consumer.
//
// One command: starts the loopback server, launches Edge with WebGPU enabled,
// drives the page over CDP, captures a screenshot and every console/log entry.
//
// Usage: node probes/render-packet/tools/capture_browser.mjs [--edge <msedge.exe>] [--port 8791]

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

async function load(url, label) {
  messages.length = 0;
  await send('Page.navigate', { url });
  let state = null;
  for (let attempt = 0; attempt < 240; attempt++) {
    state = await evaluate('(()=>{const p=window.renderPacketProbe;return p?{consumer:p.consumer,error:p.error,hash:p.packet?p.packet.hash:null,frames:p.frames}:null})()').catch(() => null);
    if (state && (state.consumer === 'ready' || state.consumer === 'error')) break;
    await sleep(250);
  }
  if (!state) throw new Error(label + ': consumer never published state');
  if (state.consumer === 'error') throw new Error(label + ': consumer error: ' + state.error);
  await frames(4);
  const probe = await evaluate(`(()=>{
    const p=window.renderPacketProbe;
    const canvas=document.getElementById('scene');
    return {
      hash:p.packet.hash,
      draws:p.packet.diagnostics.drawCount,
      meshes:p.packet.diagnostics.meshCount,
      vertices:p.packet.diagnostics.vertexTotal,
      triangles:p.packet.diagnostics.triangleTotal,
      materials:p.packet.diagnostics.materialsApplied,
      lighting:p.packet.diagnostics.lighting,
      frames:p.frames,
      camera:p.camera,
      gpu:p.gpu,
      canvas:{width:canvas.width,height:canvas.height},
      cameraState:p.packet.camera
    };
  })()`);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const png = path.join(OUT, 'browser-' + label + '.png');
  writeFileSync(png, Buffer.from(shot.data, 'base64'));
  return { url, probe, screenshot: path.relative(ROOT, png).split(path.sep).join('/'), messages: messages.splice(0) };
}

const packetCamera = await load(origin + '/', 'packet-camera');
const levelFocus = await load(origin + '/?focus=river.block27.instances-all', 'level-focus');
const carFocus = await load(origin + '/?focus=corvette.c3.race.body', 'car-focus');

const allMessages = [...packetCamera.messages, ...levelFocus.messages, ...carFocus.messages];
const blocking = allMessages.filter((entry) => entry.source !== 'console.log');
const evidence = {
  browser: { executable: edge, mode: 'headless=new', flags: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=d3d11'], viewport: VIEWPORT },
  runs: [packetCamera, levelFocus, carFocus],
  console: {
    totalMessages: allMessages.length,
    errorsAndWarnings: blocking.length,
    messages: allMessages
  },
  verdict: blocking.length === 0 ? 'clean-console' : 'console-not-clean'
};
writeFileSync(path.join(OUT, 'browser-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
writeFileSync(path.join(LOG_DIR, 'edge-process.log'), browserLog, 'utf8');

await shutdown();
await sleep(400);
console.log(JSON.stringify({
  verdict: evidence.verdict,
  consoleMessages: evidence.console.totalMessages,
  errorsAndWarnings: evidence.console.errorsAndWarnings,
  runs: evidence.runs.map((run) => ({ url: run.url.replace(origin, ''), screenshot: run.screenshot, hash: run.probe.hash, draws: run.probe.draws, vertices: run.probe.vertices, triangles: run.probe.triangles, frames: run.probe.frames, canvas: run.probe.canvas, messages: run.messages.length })),
  messages: evidence.console.messages
}, null, 2));
if (evidence.verdict !== 'clean-console') process.exitCode = 1;
