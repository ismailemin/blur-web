// Headless Edge capture for the real-browser WebRTC loopback.
//
//   node probes/net-webrtc/capture.mjs [--port 8851] [--room-port 8852]
//                                      [--debug-port 9355] [--edge <path>]
//                                      [--snapshots 1000] [--events 500]
//
// Serves the probe page and shared modules on its own port, runs the committed
// net-mvp room service on the room port, opens the page with two iframes and
// lets them negotiate a real RTCPeerConnection over a same-origin
// BroadcastChannel signaling loopback. Fails on any console message, exception,
// hash mismatch, sequence violation or missing fallback/reconnect.
//
// Evidence:
//   _work/net-webrtc/browser-evidence.json
//   _work/net-webrtc/browser-mid.png
//   _work/net-webrtc/browser-finish.png
//   _work/net-webrtc/browser-host.png
//   _work/net-webrtc/browser-guest.png
//   _work/logs/net-webrtc/browser.log

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRoomServer } from '../net-mvp/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROBE = path.join(ROOT, 'probes/net-webrtc');
const NET_MVP = path.join(ROOT, 'probes/net-mvp');
const OUT = path.join(ROOT, '_work/net-webrtc');
const LOGS = path.join(ROOT, '_work/logs/net-webrtc');
mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const PORT = Number(option('--port', '8851'));
const ROOM_PORT = Number(option('--room-port', '8852'));
const DEBUG_PORT = Number(option('--debug-port', '9355'));
const SNAPSHOTS = Number(option('--snapshots', '1000'));
const EVENTS = Number(option('--events', '500'));
const DROP_AT = Number(option('--drop', '300'));
const FAIL_AT = Number(option('--failure', '600'));
if (PORT < 8850 || ROOM_PORT < 8850) {
  throw new Error('capture ports must be >= 8850 (the probe-owned range)');
}

const EDGE = [
  option('--edge', ''),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean).find((candidate) => existsSync(candidate));
if (!EDGE) throw new Error('msedge.exe not found; pass --edge <path>');

const PROFILE = path.join(OUT, 'edge-profile-' + PORT);
rmSync(PROFILE, { recursive: true, force: true });
const VIEWPORT = { width: 1600, height: 900 };
const LOG_FILE = path.join(LOGS, 'browser.log');
const EVIDENCE_FILE = path.join(OUT, 'browser-evidence.json');
writeFileSync(LOG_FILE, '');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function sendFile(response, file) {
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  createReadStream(file).pipe(response);
}

const staticServer = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405); response.end(); return;
  }
  if (pathname === '/' || pathname === '/index.html') return sendFile(response, path.join(PROBE, 'web/index.html'));
  if (pathname.startsWith('/web/')) {
    const name = pathname.slice('/web/'.length);
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) { response.writeHead(400); response.end(); return; }
    return sendFile(response, path.join(PROBE, 'web', name));
  }
  const shared = { '/transport.mjs': 'transport.mjs', '/protocol.mjs': 'protocol.mjs' };
  if (shared[pathname]) return sendFile(response, path.join(PROBE, shared[pathname]));
  const net = {
    '/net-mvp/client.mjs': 'client.mjs',
    '/net-mvp/protocol.mjs': 'protocol.mjs',
    '/net-mvp/hash.mjs': 'hash.mjs',
    '/net-mvp/race.mjs': 'race.mjs'
  };
  if (net[pathname]) return sendFile(response, path.join(NET_MVP, net[pathname]));
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
});
await new Promise((resolve, reject) => {
  staticServer.once('error', reject);
  staticServer.listen(PORT, '127.0.0.1', resolve);
});

const roomServer = await startRoomServer({ port: ROOM_PORT, host: '127.0.0.1' });
const wsUrl = 'ws://127.0.0.1:' + ROOM_PORT + '/ws';
const origin = 'http://127.0.0.1:' + PORT;

const browser = spawn(EDGE, [
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
  'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });

let browserLog = '';
browser.stderr.on('data', (chunk) => { browserLog += chunk.toString(); });
browser.stdout.on('data', (chunk) => { browserLog += chunk.toString(); });

async function shutdown() {
  try { browser.kill(); } catch { /* ignore */ }
  await roomServer.close().catch(() => {});
  await new Promise((resolve) => staticServer.close(resolve));
  writeFileSync(LOG_FILE, browserLog);
}
process.on('exit', () => { try { browser.kill(); } catch { /* ignore */ } });

async function target() {
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
      if (response.ok) {
        const list = await response.json();
        const page = list.find((entry) => entry.type === 'page');
        if (page) return page;
      }
    } catch { /* not up yet */ }
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
    messages.push({
      source: 'console.' + message.params.type,
      text: message.params.args.map((arg) => arg.value ?? arg.description).join(' ')
    });
  } else if (message.method === 'Runtime.exceptionThrown') {
    messages.push({ source: 'exception', text: message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text });
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
const screenshot = async (file) => {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return relative(file);
};
const clip = async (selector, file) => {
  const rect = await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;const r=element.getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)};})()`);
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { ...rect, scale: 1 } });
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return relative(file);
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false
});

const url = origin + '/?' + new URLSearchParams({
  ws: wsUrl,
  snapshots: String(SNAPSHOTS),
  events: String(EVENTS),
  drop: String(DROP_AT),
  failure: String(FAIL_AT)
}).toString();
await send('Page.navigate', { url });
const userAgent = await evaluate('navigator.userAgent').catch(() => null);
const platform = await evaluate('navigator.platform').catch(() => null);

const evidence = {
  schema: 'blur.net-webrtc.browser/1',
  command: 'node probes/net-webrtc/capture.mjs ' + args.join(' '),
  server: { httpPort: PORT, roomPort: ROOM_PORT, origin, wsUrl },
  signaling: 'BroadcastChannel loopback (real DataChannels; production uses the room service relay)',
  browser: { executable: EDGE, userAgent, platform },
  viewport: VIEWPORT,
  snapshots: SNAPSHOTS,
  events: EVENTS,
  dropAt: DROP_AT,
  failAt: FAIL_AT,
  console: [],
  probe: null,
  checks: null,
  screenshots: {},
  passed: false,
  error: null
};

let probe = null;
let midShot = null;
const deadline = Date.now() + 90_000;
try {
  while (Date.now() < deadline) {
    probe = await evaluate(`(()=>{const p=window.__webrtcProbe;return p?JSON.parse(JSON.stringify(p)):null})()`).catch(() => null);
    if (!probe) { await sleep(200); continue; }
    if (!midShot && probe.hostStatus?.tick >= Math.floor(SNAPSHOTS * 0.35)) {
      midShot = await screenshot(path.join(OUT, 'browser-mid.png'));
      evidence.screenshots.mid = midShot;
    }
    if (probe.state === 'finished' || probe.state === 'failed') break;
    await sleep(200);
  }
  if (!probe) throw new Error('probe never appeared');
  if (probe.state === 'failed') throw new Error(probe.error || 'browser probe failed');
  if (probe.state !== 'finished') throw new Error('browser probe did not finish');

  await sleep(300);
  evidence.probe = probe;
  evidence.checks = probe.checks;
  evidence.console = messages;
  evidence.screenshots.finish = await screenshot(path.join(OUT, 'browser-finish.png'));
  evidence.screenshots.host = await clip('#host', path.join(OUT, 'browser-host.png'));
  evidence.screenshots.guest = await clip('#guest', path.join(OUT, 'browser-guest.png'));
  evidence.checks.consoleClean = messages.length === 0;
  evidence.passed = Object.values(evidence.checks).every(Boolean);
  if (!evidence.checks.consoleClean) throw new Error('console is not clean: ' + JSON.stringify(messages));
  if (!evidence.passed) throw new Error('one or more checks failed: ' + JSON.stringify(evidence.checks));
} catch (error) {
  evidence.error = String(error?.stack || error);
  evidence.probe = probe;
  evidence.console = messages;
  try { evidence.screenshots.failure = await screenshot(path.join(OUT, 'browser-failure.png')); } catch { /* ignore */ }
} finally {
  try { socket.close(); } catch { /* ignore */ }
  await shutdown();
}

writeFileSync(EVIDENCE_FILE, JSON.stringify(evidence, null, 2) + '\n');
if (evidence.error) {
  console.error('FAIL browser loopback: ' + evidence.error);
  console.error('  evidence: ' + relative(EVIDENCE_FILE));
  process.exit(1);
}
console.log('PASS browser loopback');
console.log('  host hash:  ' + evidence.probe.host.hash);
console.log('  guest hash: ' + evidence.probe.guest.hash);
console.log('  transport:  ' + evidence.probe.host.transportAtReady + ' -> ' + evidence.probe.host.transportFinal);
console.log('  fallback:   ' + evidence.probe.host.fallbackReason);
console.log('  reconnects: ' + evidence.probe.host.reconnects);
console.log('  rtt before: ' + JSON.stringify(evidence.probe.host.rttBeforeFailure));
console.log('  screenshots:' + evidence.screenshots.mid + ', ' + evidence.screenshots.finish);
console.log('  console:    0 messages');
console.log('  evidence:   ' + relative(EVIDENCE_FILE));
process.exit(0);
