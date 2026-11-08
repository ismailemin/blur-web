// Minimal Chrome DevTools Protocol driver for the E2E harness.
//
// Starts one headless Edge/Chrome process per scenario and exposes page targets
// with console/exception/log capture, evaluation, navigation and screenshots.
// No npm dependencies: `fetch`, `WebSocket` and `node:child_process` are enough
// (Node 24). See probes/e2e/README.md for the browser flags and limits.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];

/** First existing browser executable, or throw with the list that was tried. */
export function findBrowser(explicit = null) {
  const candidates = [explicit, ...EDGE_CANDIDATES].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error('no Edge/Chrome executable found; pass --edge <path>. Tried:\n  ' + candidates.join('\n  '));
  }
  return found;
}

/**
 * Remove a browser profile directory, retrying the transient EPERM/EBUSY a
 * just-killed headless browser holds on Windows. A stale profile is never
 * reused: that would silently keep localStorage / best times between runs.
 */
export function resetProfileDir(dir) {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 39 || (error.code !== 'EPERM' && error.code !== 'EBUSY')) throw error;
      // Synchronous wait so this stays usable before the async event loop starts.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

async function waitForFile(file, timeoutMs, interval = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await sleep(interval);
  }
  return false;
}

/** Read the PNG IHDR so a screenshot is proven to be a real, sized image. */
export function pngInfo(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== signature) {
    return { ok: false, reason: 'not a PNG signature', bytes: buffer.length };
  }
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    return { ok: false, reason: 'missing IHDR', bytes: buffer.length };
  }
  return {
    ok: true,
    bytes: buffer.length,
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function wsClose(socket) {
  try { socket.close(); } catch { /* already closed */ }
}

async function openSocket(url, timeoutMs = 15000) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP websocket did not open: ' + url)), timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', (event) => {
      clearTimeout(timer);
      reject(new Error('CDP websocket error: ' + (event?.message ?? 'unknown')));
    }, { once: true });
  });
  return socket;
}

/**
 * A CDP page target. `messages` records every console message, page exception
 * and browser log entry, in arrival order, with a monotonically increasing `n`
 * so a caller can slice per navigation step.
 */
export class CdpPage {
  constructor({ target, httpPort, label, viewport }) {
    this.target = target;
    this.httpPort = httpPort;
    this.label = label;
    this.viewport = viewport;
    this.messages = [];
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.socket = null;
  }

  static async attach({ target, httpPort, label, viewport }) {
    if (!target?.webSocketDebuggerUrl) {
      throw new Error('CDP target has no webSocketDebuggerUrl: ' + JSON.stringify(target));
    }
    const page = new CdpPage({ target, httpPort, label, viewport });
    page.socket = await openSocket(target.webSocketDebuggerUrl);
    page.socket.addEventListener('message', (event) => page.#onMessage(event));
    page.socket.addEventListener('close', () => { page.closed = true; });
    await page.init();
    return page;
  }

  #onMessage(event) {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return;
    }
    const n = this.messages.length;
    if (message.method === 'Runtime.consoleAPICalled') {
      this.messages.push({
        n,
        source: 'console.' + message.params.type,
        type: message.params.type,
        text: (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ')
      });
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails ?? {};
      this.messages.push({
        n,
        source: 'exception',
        type: 'error',
        text: details.exception?.description ?? details.text ?? 'uncaught exception',
        url: details.url ?? null,
        line: details.lineNumber ?? null
      });
    } else if (message.method === 'Log.entryAdded') {
      const entry = message.params.entry ?? {};
      this.messages.push({
        n,
        source: 'log.' + (entry.source ?? 'unknown'),
        type: entry.level ?? 'info',
        text: entry.text ?? '',
        url: entry.url ?? null
      });
    }
  }

  async send(method, params = {}) {
    if (this.closed) throw new Error(this.label + ': CDP socket is closed');
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(this.label + ': CDP ' + method + ' timed out'));
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async init() {
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Page.enable');
    if (this.viewport) {
      await this.send('Emulation.setDeviceMetricsOverride', {
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScaleFactor: 1,
        mobile: false
      });
    }
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await this.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(this.label + ': evaluate failed: ' +
        (details.exception?.description ?? details.text ?? JSON.stringify(details)));
    }
    return result.result?.value;
  }

  async navigate(url) {
    const result = await this.send('Page.navigate', { url });
    if (result.errorText) throw new Error(this.label + ': navigate failed: ' + result.errorText);
    return result.frameId ?? null;
  }

  /** Capture a PNG and write it; returns the verified image record. */
  async screenshot(file) {
    const shot = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    });
    const buffer = Buffer.from(shot.data, 'base64');
    writeFileSync(file, buffer);
    const info = pngInfo(buffer);
    if (!info.ok) throw new Error(this.label + ': screenshot is not a valid PNG: ' + info.reason);
    if (this.viewport && (info.width !== this.viewport.width || info.height !== this.viewport.height)) {
      throw new Error(this.label + ': screenshot is ' + info.width + 'x' + info.height +
        ', expected ' + this.viewport.width + 'x' + this.viewport.height);
    }
    return { path: file, bytes: info.bytes, width: info.width, height: info.height };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    wsClose(this.socket);
  }
}

/** One headless browser process; owns a fresh profile dir and page targets. */
export class CdpBrowser {
  constructor({ child, httpPort, executable, profileDir, viewport }) {
    this.child = child;
    this.httpPort = httpPort;
    this.executable = executable;
    this.profileDir = profileDir;
    this.viewport = viewport;
    this.log = '';
    this.pages = [];
    this.closed = false;
  }

  static async launch({ executable, profileDir, viewport, debugPort = 0, extraArgs = [] }) {
    resetProfileDir(profileDir);
    const args = [
      '--headless=new',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-angle=d3d11',
      '--remote-debugging-port=' + debugPort,
      '--user-data-dir=' + profileDir,
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
      '--window-size=' + viewport.width + ',' + viewport.height,
      ...extraArgs,
      'about:blank'
    ];
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const browser = new CdpBrowser({ child, httpPort: debugPort, executable, profileDir, viewport });
    child.stdout.on('data', (chunk) => { browser.log += chunk.toString(); });
    child.stderr.on('data', (chunk) => { browser.log += chunk.toString(); });

    let httpPort = debugPort;
    if (!httpPort) {
      const file = path.join(profileDir, 'DevToolsActivePort');
      const appeared = await waitForFile(file, 30000);
      if (appeared) {
        httpPort = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]);
      }
    }
    if (!Number.isInteger(httpPort) || httpPort <= 0) {
      await browser.close();
      throw new Error('browser did not publish a DevTools port. Log tail:\n' + browser.log.slice(-1500));
    }
    browser.httpPort = httpPort;

    const deadline = Date.now() + 30000;
    let version = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${httpPort}/json/version`);
        if (response.ok) { version = await response.json(); break; }
      } catch { /* not up yet */ }
      await sleep(100);
    }
    if (!version) {
      await browser.close();
      throw new Error('browser DevTools endpoint unreachable. Log tail:\n' + browser.log.slice(-1500));
    }
    browser.version = version;
    return browser;
  }

  async newPage({ label = 'page', url = 'about:blank' } = {}) {
    let response = await fetch(
      `http://127.0.0.1:${this.httpPort}/json/new?${encodeURIComponent(url)}`,
      { method: 'PUT' }
    );
    if (!response.ok) {
      response = await fetch(`http://127.0.0.1:${this.httpPort}/json/new?${encodeURIComponent(url)}`);
    }
    if (!response.ok) throw new Error('could not create the page target: HTTP ' + response.status);
    const target = await response.json();
    const page = await CdpPage.attach({
      target,
      httpPort: this.httpPort,
      label,
      viewport: this.viewport
    });
    this.pages.push(page);
    return page;
  }

  /** Close gracefully, then kill the process tree; never leave a headless Edge. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const page of this.pages) page.close();
    let graceful = false;
    try {
      const response = await fetch(`http://127.0.0.1:${this.httpPort}/json/version`);
      if (response.ok) {
        const info = await response.json();
        if (info.webSocketDebuggerUrl) {
          const socket = await openSocket(info.webSocketDebuggerUrl, 5000);
          socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
          graceful = true;
          await sleep(250);
          wsClose(socket);
        }
      }
    } catch { /* fall through to the kill */ }
    const exited = await new Promise((resolve) => {
      if (this.child.exitCode !== null) return resolve(true);
      const timer = setTimeout(() => resolve(false), graceful ? 5000 : 500);
      this.child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          this.child.kill('SIGKILL');
        }
      } catch {
        try { this.child.kill(); } catch { /* already gone */ }
      }
      await sleep(250);
    }
    // Profile removal is best-effort here; the next run resets its own dir.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(this.profileDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code !== 'EPERM' && error.code !== 'EBUSY') break;
        await sleep(250);
      }
    }
  }
}
