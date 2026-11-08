// Small CDP driver for headless Edge/Chrome, shared by the capture and verify
// tools. It is intentionally narrow: launch one headless browser, one page
// target, evaluate expressions, take screenshots, collect console/log events.
//
// The flags mirror the committed capture tools (probes/e1-drive/tools/
// capture_browser.mjs, probes/retail-parity/tools/capture_parity.mjs) so the
// frames are produced by the same WebGPU path: `--headless=new`,
// `--enable-unsafe-webgpu`, `--use-angle=d3d11`, fixed device scale factor 1,
// 1600x900 window, background throttling disabled.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];

export function findBrowser(explicit) {
  const candidates = [explicit, ...EDGE_CANDIDATES].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('no headless browser found; pass --edge <msedge.exe|chrome.exe>');
  return found;
}

/** Remove a profile directory, retrying while a killed browser still holds it. */
export function resetProfile(directory) {
  const sleeper = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 19 || (error.code !== 'EPERM' && error.code !== 'EBUSY')) throw error;
      sleeper(250);
    }
  }
}

function severityOf(entry) {
  const source = entry.source ?? '';
  if (source === 'exception' || source === 'console.error' || source === 'log.error') return 'error';
  if (source === 'console.warn' || source === 'log.warning' || source === 'log.warn') return 'warn';
  return 'log';
}

/**
 * Launch a headless browser and return a session:
 *   { send, evaluate, navigate, screenshot, messages, browserLog, call, close }
 * `call(method, params)` is the raw CDP send. Throws with the browser log tail
 * if the DevTools endpoint never appears.
 */
export async function launchBrowser({ executable, debugPort, profile, viewport, extraArgs = [] }) {
  resetProfile(profile);
  mkdirSync(profile, { recursive: true });
  const browser = spawn(executable, [
    '--headless=new',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--use-angle=d3d11',
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profile,
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
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let browserLog = '';
  browser.stderr.on('data', (chunk) => { browserLog += chunk.toString(); });
  browser.stdout.on('data', (chunk) => { browserLog += chunk.toString(); });

  const kill = () => {
    try { browser.kill(); } catch {}
  };
  process.on('exit', kill);

  let target = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (response.ok) {
        const list = await response.json();
        target = list.find((entry) => entry.type === 'page') ?? null;
        if (target) break;
      }
    } catch {}
    await delay(250);
  }
  if (!target) {
    kill();
    throw new Error('Edge DevTools endpoint unreachable on ' + debugPort + '. Log tail:\n' + browserLog.slice(-1200));
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
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
      if (message.error) entry.reject(new Error('CDP ' + message.error.message + ' (' + JSON.stringify(message.error.data ?? null) + ')'));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const entry = {
        source: 'console.' + message.params.type,
        text: message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '),
        at: Date.now()
      };
      entry.severity = severityOf(entry);
      messages.push(entry);
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      const entry = {
        source: 'exception',
        text: details.exception?.description ?? details.text,
        url: details.url ?? null,
        at: Date.now()
      };
      entry.severity = severityOf(entry);
      messages.push(entry);
    } else if (message.method === 'Log.entryAdded') {
      const raw = message.params.entry;
      const entry = {
        source: 'log.' + raw.level,
        text: raw.text,
        url: raw.url ?? null,
        at: Date.now()
      };
      entry.severity = severityOf(entry);
      messages.push(entry);
    }
  });

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error('page evaluate failed: ' + (details.exception?.description ?? details.text ?? JSON.stringify(details)));
    }
    return result.result.value;
  };

  await call('Runtime.enable');
  await call('Log.enable');
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false
  });
  await call('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await call('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});

  const navigate = async (url) => {
    await call('Page.navigate', { url });
    for (let attempt = 0; attempt < 240; attempt++) {
      try {
        const ready = await evaluate('document.readyState');
        if (ready === 'complete' || ready === 'interactive') return;
      } catch {}
      await delay(100);
    }
  };

  const screenshot = async () => {
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return Buffer.from(shot.data, 'base64');
  };

  const close = async () => {
    try { socket.close(); } catch {}
    kill();
  };

  return { browser, socket, call, evaluate, navigate, screenshot, messages, browserLog: () => browserLog, close };
}

/**
 * Install a document-start stylesheet. `css` is applied to every navigation.
 * Used for the "disable animations" and "hide live overlays" policies; it never
 * touches the page source.
 */
export async function installStyles(session, css) {
  const source = `(() => {
    const apply = () => {
      if (!document.documentElement) return;
      const style = document.createElement('style');
      style.setAttribute('data-visual-diff', '1');
      style.textContent = ${JSON.stringify(css)};
      document.documentElement.appendChild(style);
    };
    if (document.documentElement) apply();
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  })();`;
  await session.call('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true });
}

export const ANIMATION_CSS = `
*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}
`;

/** Overlay policy: hide every DOM overlay so the full canvas is under test. */
export const HIDDEN_OVERLAY_CSS = `
#hud, #legend, #keys, #cars, #countdown, #event, #results, #survey-banner,
#ghost-tag, #remote-tag, #mp-lobby, #mp-remotes, #telemetry, #powerup-hud, #error {
  display: none !important;
}
`;
