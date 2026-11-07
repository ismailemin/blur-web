// Headless Edge capture for the two-client browser harness.
//
//   node probes/net-mvp/capture.mjs [--port 8810] [--debug-port 9345]
//                                    [--seconds 30] [--edge <msedge.exe>]
//
// Serves the probe on its own port/profile, opens index.html, waits for two
// iframes to join and run the 30 s synthetic race, captures a mid-race and a
// finish screenshot, and fails on any console message, exception, log entry,
// hash mismatch or incomplete final tick.
//
// Evidence:
//   _work/net-mvp/browser-evidence.json
//   _work/net-mvp/browser-two-clients-mid.png
//   _work/net-mvp/browser-two-clients-finish.png
//   _work/net-mvp/browser-host-finish.png
//   _work/net-mvp/browser-guest-finish.png
//   _work/logs/net-mvp/browser.log

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRoomServer } from './server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/net-mvp');
const LOGS = path.join(ROOT, '_work/logs/net-mvp');
mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const PORT = Number(option('--port', '8810'));
const DEBUG_PORT = Number(option('--debug-port', '9345'));
const SECONDS = Number(option('--seconds', '30'));
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

const roomServer = await startRoomServer({ port: PORT });
const { origin, port } = roomServer;
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
  try { browser.kill(); } catch {}
  await roomServer.close().catch(() => {});
  writeFileSync(LOG_FILE, browserLog);
}
process.on('exit', () => { try { browser.kill(); } catch {} });

async function target() {
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
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
await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });

const url = origin + '/?seconds=' + encodeURIComponent(SECONDS);
await send('Page.navigate', { url });
const userAgent = await evaluate('navigator.userAgent').catch(() => null);
const platform = await evaluate('navigator.platform').catch(() => null);

const evidence = {
  schema: 'blur.net-mvp.browser/1',
  command: 'node probes/net-mvp/capture.mjs ' + args.join(' '),
  server: { port, origin },
  browser: { executable: EDGE, userAgent, platform },
  viewport: VIEWPORT,
  seconds: SECONDS,
  finalTick: Math.round(SECONDS * 60),
  console: [],
  probe: null,
  screenshots: {},
  passed: false,
  error: null
};

let probe = null;
let midShot = null;
let finishShot = null;
const deadline = Date.now() + (SECONDS + 60) * 1000;
try {
  while (Date.now() < deadline) {
    probe = await evaluate(`(()=>{const p=window.__netMvpProbe;return p?JSON.parse(JSON.stringify(p)):null})()`).catch(() => null);
    if (!probe) { await sleep(200); continue; }
    if (!midShot && probe.mid && probe.state === 'racing') {
      await sleep(80);
      midShot = await screenshot(path.join(OUT, 'browser-two-clients-mid.png'));
      evidence.screenshots.mid = midShot;
    }
    if (probe.state === 'finished' || probe.state === 'failed') break;
    await sleep(150);
  }
  if (!probe) throw new Error('probe never appeared');
  if (probe.state === 'failed') throw new Error(probe.error || 'browser probe failed');

  await sleep(300);
  finishShot = await screenshot(path.join(OUT, 'browser-two-clients-finish.png'));
  evidence.screenshots.finish = finishShot;
  evidence.screenshots.host = await clip('#host', path.join(OUT, 'browser-host-finish.png'));
  evidence.screenshots.guest = await clip('#guest', path.join(OUT, 'browser-guest-finish.png'));

  const checks = probe.checks ?? {};
  evidence.probe = probe;
  evidence.console = messages;
  evidence.checks = {
    stateFinished: probe.state === 'finished',
    hashMatch: checks.hashMatch === true,
    tickMatch: checks.tickMatch === true,
    appliedMatch: checks.appliedMatch === true,
    sequenceMatch: checks.sequenceMatch === true,
    consoleClean: messages.length === 0,
    pageMessagesClean: (probe.messages?.length ?? 0) === 0,
    hostHash: checks.hostHash ?? null,
    guestHash: checks.guestHash ?? null
  };
  evidence.passed = Object.values(evidence.checks).every((value) => value === true || typeof value === 'string' || value === null);
  if (!evidence.checks.stateFinished) throw new Error('page did not reach finished');
  if (!evidence.checks.hashMatch) throw new Error('host/guest hash mismatch');
  if (!evidence.checks.tickMatch) throw new Error('final tick mismatch');
  if (!evidence.checks.appliedMatch || !evidence.checks.sequenceMatch) throw new Error('applied/sequence check failed');
  if (!evidence.checks.consoleClean) throw new Error('console is not clean: ' + JSON.stringify(messages));
  if (!evidence.checks.pageMessagesClean) throw new Error('page recorded errors: ' + JSON.stringify(probe.messages));
} catch (error) {
  evidence.error = String(error?.stack || error);
  evidence.probe = probe;
  evidence.console = messages;
  try {
    evidence.screenshots.failure = await screenshot(path.join(OUT, 'browser-failure.png'));
  } catch {}
} finally {
  try { socket.close(); } catch {}
  await shutdown();
}

writeFileSync(EVIDENCE_FILE, JSON.stringify(evidence, null, 2) + '\n');
if (evidence.error) {
  console.error('FAIL browser harness: ' + evidence.error);
  console.error('  evidence: ' + relative(EVIDENCE_FILE));
  process.exit(1);
}
console.log('PASS browser harness');
console.log('  url:        ' + url);
console.log('  final hash: ' + evidence.checks.hostHash);
console.log('  screenshots:' + evidence.screenshots.mid + ', ' + evidence.screenshots.finish);
console.log('  console:    0 messages');
console.log('  evidence:   ' + relative(EVIDENCE_FILE));
process.exit(0);
