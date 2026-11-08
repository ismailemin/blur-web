// Measure the E1 page in the browsers installed on this machine.
//
// For every installed Chromium browser it runs the capability page and (where
// WebGPU is present) boots the real game page on the unmodified server, then
// records the same measurements on the machine's LAN origin, which is not a
// secure context. Nothing in probes/e1-drive/ or tools/ is modified: the page is
// served by its own server, and this harness only reads it through a proxy.
//
// Outputs (not committed):
//   _work/compat/capabilities/<run>.json
//   _work/compat/boot/<run>.json
//   _work/compat/browsers.json          (installed executables + versions)
//   _work/compat/screens/<run>.png
//   _work/logs/compat/probe.log
//
// Usage: node probes/compat/tools/probe_capabilities.mjs [--skip-headed] [--only edge|brave]

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { release as osRelease } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../e1-drive/tools/serve.mjs';
import { lanAddresses, startCompatServer } from './compat_server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(ROOT, '_work/compat');
const LOGS = path.join(ROOT, '_work/logs/compat');
const SCREENS = path.join(OUT, 'screens');
const PROFILES = path.join(OUT, 'profiles');
const GAME_PORT = 8810;
const COMPAT_PORT = 8812;

const BROWSER_CANDIDATES = {
  edge: [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ],
  chrome: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : ''
  ],
  brave: [
    'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    'C:/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe'
  ],
  firefox: [
    'C:/Program Files/Mozilla Firefox/firefox.exe',
    'C:/Program Files (x86)/Mozilla Firefox/firefox.exe'
  ],
  opera: [
    'C:/Program Files/Opera/opera.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs/Opera/opera.exe') : ''
  ],
  vivaldi: [
    'C:/Program Files/Vivaldi/Application/vivaldi.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Vivaldi/Application/vivaldi.exe') : ''
  ]
};

const CAPTURE_FLAGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=d3d11'];
const BASE_FLAGS = [
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
  '--force-device-scale-factor=1'
];

const VIEWPORT = { width: 1280, height: 720 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });
mkdirSync(SCREENS, { recursive: true });
mkdirSync(PROFILES, { recursive: true });
mkdirSync(path.join(OUT, 'capabilities'), { recursive: true });
mkdirSync(path.join(OUT, 'boot'), { recursive: true });

const logLines = [];
function log(line) {
  const text = '[' + new Date().toISOString() + '] ' + line;
  logLines.push(text);
  writeFileSync(path.join(LOGS, 'probe.log'), logLines.join('\n') + '\n', 'utf8');
  console.log(line);
}

function executableVersion(exe) {
  const result = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 20000 });
  const text = ((result.stdout || '') + (result.stderr || '')).trim();
  return text || null;
}

const installed = {};
for (const [id, candidates] of Object.entries(BROWSER_CANDIDATES)) {
  const exe = candidates.find((candidate) => candidate && existsSync(candidate)) || null;
  installed[id] = exe ? { id, executable: exe, versionText: executableVersion(exe) } : { id, executable: null, versionText: null };
}
writeFileSync(path.join(OUT, 'browsers.json'), JSON.stringify({
  schema: 'blur.compat.browsers',
  version: 1,
  os: {
    platform: process.platform,
    release: osRelease(),
    arch: process.arch,
    node: process.version
  },
  browsers: installed
}, null, 2) + '\n', 'utf8');

// ---------------------------------------------------------------- CDP client

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.messages = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        this.messages.push({
          source: 'console.' + message.params.type,
          text: message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')
        });
      } else if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        this.messages.push({ source: 'exception', text: details.exception?.description ?? details.text });
      } else if (message.method === 'Log.entryAdded') {
        this.messages.push({ source: 'log.' + message.params.entry.level, text: message.params.entry.text, url: message.params.entry.url ?? null });
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error('evaluate failed: ' + (details.exception?.description ?? details.text ?? JSON.stringify(details)));
    }
    return result.result.value;
  }
}

async function connectCdp(debugPort, timeoutMs = 30000) {
  const started = Date.now();
  let target = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (response.ok) {
        const list = await response.json();
        target = list.find((entry) => entry.type === 'page') ?? null;
        if (target) break;
      }
    } catch {}
    await sleep(250);
  }
  if (!target) throw new Error('devtools endpoint on ' + debugPort + ' did not answer');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
  });
  const cdp = new Cdp(socket);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false
  });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  return { cdp, socket };
}

async function waitFor(cdp, expression, { timeoutMs = 60000, intervalMs = 200 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await cdp.evaluate(expression).catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

function killTree(child) {
  if (!child || child.killed) return;
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  try { child.kill(); } catch {}
}

// ---------------------------------------------------------------- one run

async function runOne(spec, context) {
  const { id, browserId, headless, flags, mode } = spec;
  const exe = installed[browserId]?.executable;
  if (!exe) return { id, status: 'not-installed', browser: browserId };
  const profile = path.join(PROFILES, id);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  mkdirSync(profile, { recursive: true });

  const debugPort = spec.debugPort;
  const browser = spawn(exe, [
    ...(headless ? ['--headless=new'] : []),
    ...BASE_FLAGS,
    ...flags,
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profile,
    '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let browserLog = '';
  browser.stderr.on('data', (chunk) => { browserLog += chunk.toString(); });
  browser.stdout.on('data', (chunk) => { browserLog += chunk.toString(); });

  const result = {
    schema: 'blur.compat.run',
    version: 1,
    id,
    browser: browserId,
    browserExecutable: exe,
    browserVersionText: installed[browserId].versionText,
    headless,
    flags,
    mode,
    startedAt: new Date().toISOString()
  };

  let socket = null;
  try {
    const connection = await connectCdp(debugPort);
    socket = connection.socket;
    const { cdp } = connection;

    // --- capability page ---------------------------------------------------
    const capabilityUrl = context.origin + '/compat/capability.html';
    cdp.messages.length = 0;
    await cdp.send('Page.navigate', { url: capabilityUrl });
    const done = await waitFor(cdp, 'window.__compatDone === true', { timeoutMs: 45000 });
    if (!done) throw new Error('capability page did not finish');
    const capability = await cdp.evaluate('window.__compatResult');
    result.capabilityUrl = capabilityUrl;
    result.capability = capability;

    // --- real page boot ----------------------------------------------------
    if (mode === 'loopback' && !capability.fatal) {
      const bootUrl = context.origin + '/?script=drive&car=corvette-zr1-stock&hold=120';
      cdp.messages.length = 0;
      await cdp.send('Page.navigate', { url: bootUrl });
      const probe = await waitFor(cdp,
        '(()=>{const p=window.e1DriveProbe;return p&&p.holdReached&&p.frames>=12?p:null})()', { timeoutMs: 180000 });
      const final = await cdp.evaluate('window.e1DriveProbe ? {state:window.e1DriveProbe.consumer,error:window.e1DriveProbe.error,engineTick:window.e1DriveProbe.engineTick,displayTick:window.e1DriveProbe.displayTick,frames:window.e1DriveProbe.frames,draws:window.e1DriveProbe.draws,adapter:window.e1DriveProbe.adapter,holdReached:window.e1DriveProbe.holdReached} : null').catch(() => null);
      result.boot = {
        url: bootUrl,
        reached: !!probe,
        probe: final,
        messages: cdp.messages.slice(),
        consoleErrors: cdp.messages.filter((message) => /console\.(error|assert)|exception|log\.error/.test(message.source)).length,
        consoleWarnings: cdp.messages.filter((message) => /console\.warn|log\.warning/.test(message.source)).length
      };
      if (probe) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        const screenshot = path.join(SCREENS, id + '-boot.png');
        writeFileSync(screenshot, Buffer.from(shot.data, 'base64'));
        result.boot.screenshot = path.relative(ROOT, screenshot).split(path.sep).join('/');
        result.boot.screenshotBytes = readFileSync(screenshot).length;
      } else {
        result.boot.failure = 'page never reached hold=120 with 12 frames';
      }
    }

    // --- LAN / insecure origin --------------------------------------------
    if (mode === 'lan') {
      const lanOrigin = spec.lanOrigin;
      const lanCapabilityUrl = lanOrigin + '/compat/capability.html';
      cdp.messages.length = 0;
      await cdp.send('Page.navigate', { url: lanCapabilityUrl });
      const lanDone = await waitFor(cdp, 'window.__compatDone === true', { timeoutMs: 45000 });
      result.lanCapabilityUrl = lanCapabilityUrl;
      result.lanCapability = lanDone ? await cdp.evaluate('window.__compatResult') : { fatal: true, error: 'capability page did not finish' };

      const bootUrl = lanOrigin + '/?script=drive&car=corvette-zr1-stock&hold=120';
      cdp.messages.length = 0;
      await cdp.send('Page.navigate', { url: bootUrl });
      const failed = await waitFor(cdp,
        '(()=>{const p=window.e1DriveProbe;return p&&p.consumer==="error"?p:null})()', { timeoutMs: 90000 });
      const final = await cdp.evaluate('window.e1DriveProbe ? {state:window.e1DriveProbe.consumer,error:window.e1DriveProbe.error,draws:window.e1DriveProbe.draws,adapter:window.e1DriveProbe.adapter} : null').catch(() => null);
      const errorText = await cdp.evaluate('(()=>{const e=document.getElementById("error");return e&&!e.hidden?e.textContent:null})()').catch(() => null);
      result.lanBoot = {
        url: bootUrl,
        reachedError: !!failed,
        probe: final,
        errorText,
        messages: cdp.messages.slice(),
        consoleErrors: cdp.messages.filter((message) => /console\.(error|assert)|exception|log\.error/.test(message.source)).length
      };
    }

    result.status = 'ok';
  } catch (error) {
    result.status = 'harness-error';
    result.error = error.message;
    result.browserLogTail = browserLog.slice(-2000);
  } finally {
    if (socket) { try { socket.close(); } catch {} }
    killTree(browser);
    await sleep(600);
    result.finishedAt = new Date().toISOString();
    writeFileSync(path.join(OUT, 'capabilities', id + '.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
    if (result.boot) writeFileSync(path.join(OUT, 'boot', id + '.json'), JSON.stringify(result.boot, null, 2) + '\n', 'utf8');
    log(spec.id + ': ' + result.status + (result.error ? ' — ' + result.error : '') +
      (result.boot ? ' | boot ' + (result.boot.reached ? 'ok' : 'failed') + ', console ' + result.boot.consoleErrors + '/' + result.boot.consoleWarnings : '') +
      (result.lanBoot ? ' | lan error ' + (result.lanBoot.reachedError ? 'reached' : 'missing') : ''));
  }
  return result;
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2);
const skipHeaded = args.includes('--skip-headed');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;

const game = await startServer({ port: GAME_PORT });
log('game server: ' + game.origin);
const compat = await startCompatServer({ port: COMPAT_PORT, upstream: game.origin });
log('compat server: ' + compat.origin + ' | lan ' + (compat.lanOrigins.join(', ') || 'none'));
const lanIp = lanAddresses()[0]?.address ?? null;
const lanOrigin = lanIp ? 'http://' + lanIp + ':' + COMPAT_PORT : null;

const targets = Object.entries(installed)
  .filter(([, info]) => info.executable)
  .map(([id]) => id)
  .filter((id) => !only || id === only);

const runs = [];
let debugPort = 8831;
for (const browserId of targets) {
  runs.push({ id: browserId + '-headless-capture', browserId, headless: true, flags: CAPTURE_FLAGS, mode: 'loopback', debugPort: debugPort++ });
  runs.push({ id: browserId + '-headless-default', browserId, headless: true, flags: [], mode: 'loopback', debugPort: debugPort++ });
  if (!skipHeaded) {
    runs.push({ id: browserId + '-headed-default', browserId, headless: false, flags: [], mode: 'loopback', debugPort: debugPort++ });
  }
  if (lanOrigin) {
    runs.push({ id: browserId + '-headless-lan', browserId, headless: true, flags: [], mode: 'lan', debugPort: debugPort++, lanOrigin });
  }
}

const results = [];
for (const spec of runs) {
  log('run ' + spec.id + ' (' + (spec.headless ? 'headless' : 'headed') + ', flags ' + (spec.flags.length || 'none') + ', ' + spec.mode + ')');
  results.push(await runOne(spec, { origin: compat.origin }));
}

writeFileSync(path.join(OUT, 'runs.json'), JSON.stringify({
  schema: 'blur.compat.runs',
  version: 1,
  os: { platform: process.platform, release: osRelease() },
  lanOrigin,
  gameOrigin: game.origin,
  compatOrigin: compat.origin,
  runs: results.map((run) => ({
    id: run.id, browser: run.browser, status: run.status, headless: run.headless,
    flags: run.flags, mode: run.mode, error: run.error ?? null
  }))
}, null, 2) + '\n', 'utf8');

await compat.close();
try { game.server.closeAllConnections?.(); } catch {}
await new Promise((resolve) => game.server.close(resolve));
log('done: ' + results.filter((run) => run.status === 'ok').length + '/' + results.length + ' runs recorded');
process.exit(results.some((run) => run.status === 'harness-error') ? 1 : 0);
