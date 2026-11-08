// Headless Edge capture + console gate for the standalone game-shell demo.
//
//   node probes/game-shell/tools/capture-shell.mjs [--port 8815] [--debug-port 9345]
//                                                  [--edge <msedge.exe>]
//
// Loads `/probes/game-shell/demo.html`, waits for the committed data to mount,
// then captures the main menu, the 57-car grid and the 7-map grid at 1600x900.
// It records every console message and fails when the page logs an error or a
// warning, when the car/map counts are wrong, or when a screenshot is missing.
//
// Evidence lands in `_work/game-shell/` (not committed): three PNGs and a JSON
// report. This tool never imports the driving page and never binds 8801.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(ROOT, '_work/game-shell');
const VIEWPORT = { width: 1600, height: 900 };

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const PORT = Number(option('--port', '8815'));
const DEBUG_PORT = Number(option('--debug-port', '9345'));
const EDGE_CANDIDATES = [
  option('--edge', ''),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean);
const edge = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
if (!edge) throw new Error('msedge.exe not found; pass --edge <path>');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROFILE = path.join(OUT, 'edge-profile-' + DEBUG_PORT);

mkdirSync(OUT, { recursive: true });
try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* held profile */ }

const server = spawn(process.execPath, [path.join(HERE, 'serve-demo.mjs'), '--port', String(PORT)], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

const browser = spawn(edge, [
  '--headless=new',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + PROFILE,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
  'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });
let browserLog = '';
browser.stdout.on('data', (chunk) => { browserLog += chunk; });
browser.stderr.on('data', (chunk) => { browserLog += chunk; });

async function pageTarget() {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
      if (response.ok) {
        const list = await response.json();
        const page = list.find((entry) => entry.type === 'page');
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch { /* browser still starting */ }
    await sleep(100);
  }
  throw new Error('Edge devtools endpoint unreachable. Log tail:\n' + browserLog.slice(-1200));
}

const target = await pageTarget();
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
  if (message.id !== undefined) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    messages.push({
      source: 'console.' + message.params.type,
      text: message.params.args.map((arg) => arg.value ?? arg.description).join(' ')
    });
  } else if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    messages.push({ source: 'exception', text: details.exception?.description ?? details.text });
  } else if (message.method === 'Log.entryAdded') {
    messages.push({
      source: 'log.' + message.params.entry.level,
      text: message.params.entry.text,
      url: message.params.entry.url ?? null
    });
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitFor(expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true;
    } catch { /* page still loading */ }
    await sleep(100);
  }
  return false;
}

async function shot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, name);
  writeFileSync(file, Buffer.from(result.data, 'base64'));
  return path.relative(ROOT, file).split(path.sep).join('/');
}

const failures = [];
const check = (name, ok, detail = null) => {
  if (!ok) failures.push({ name, detail });
};

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false
  });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/probes/game-shell/demo.html' });

  const booted = await waitFor(
    "window.__gameShell && window.__gameShell.getState().screen === 'main-menu' && " +
    'window.__gameShell.getState().cars.length === 57 && window.__gameShell.getState().maps.length === 7'
  );
  check('boot reaches main-menu with 57 cars and 7 maps', booted);
  if (!booted) throw new Error('shell did not boot: ' + JSON.stringify(messages.slice(-5)));

  const counts = await evaluate(`(() => {
    const state = window.__gameShell.getState();
    return {
      screen: state.screen,
      cars: state.cars.length,
      maps: state.maps.length,
      classes: state.cars.reduce((acc, car) => { acc[car.carClass] = (acc[car.carClass] || 0) + 1; return acc; }, {}),
      footer: document.querySelector('.gs-footer-meta')?.textContent ?? null
    };
  })()`);
  check('footer names 57 cars and 7 maps', /57 cars\s+\/\s+7 maps/.test(counts.footer ?? ''), counts.footer);
  const mainMenu = await shot('shell-main-menu.png');

  await evaluate("document.querySelector('[data-focus=\"play\"]').click()");
  await waitFor("window.__gameShell.getState().screen === 'mode-select'");
  await evaluate("document.querySelector('[data-focus=\"mode-sprint\"]').click()");
  await waitFor("window.__gameShell.getState().screen === 'car-select'");
  const carGrid = await evaluate(`(() => {
    const tiles = [...document.querySelectorAll('[data-car-slug]')];
    const rects = tiles.map((tile) => tile.getBoundingClientRect());
    const main = document.querySelector('.gs-main');
    return {
      tiles: tiles.length,
      columns: document.querySelector('[data-grid="cars"]')?.dataset.gridColumns ?? null,
      firstRow: rects.filter((rect) => Math.abs(rect.top - rects[0].top) < 1).length,
      tileWidth: Math.round(rects[0].width),
      minTileWidth: Math.round(Math.min(...rects.map((rect) => rect.width))),
      scrollHeight: main.scrollHeight,
      clientHeight: main.clientHeight,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      heading: document.querySelector('.gs-screen-head')?.textContent ?? null
    };
  })()`);
  check('car grid renders 57 tiles', carGrid.tiles === 57, carGrid.tiles);
  check('car grid advertises 7 columns', carGrid.columns === '7', carGrid.columns);
  check('car grid lays out 7 tiles per row', carGrid.firstRow === 7, carGrid.firstRow);
  check('car tiles keep a readable width', carGrid.minTileWidth >= 100, carGrid.minTileWidth);
  check('car screen has no horizontal overflow', carGrid.scrollWidth <= carGrid.innerWidth + 1,
    carGrid.scrollWidth + ' > ' + carGrid.innerWidth);
  check('car heading names 57 cars', /All 57 committed roster cars/.test(carGrid.heading ?? ''), carGrid.heading);
  const carSelect = await shot('shell-car-select.png');

  await evaluate("document.querySelector('[data-focus=\"car-next\"]').click()");
  await waitFor("window.__gameShell.getState().screen === 'map-select'");
  const mapGrid = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.gs-map-card')];
    const rects = cards.map((card) => card.getBoundingClientRect());
    return {
      cards: cards.length,
      ids: cards.map((card) => card.dataset.focus.replace('map-', '')),
      lengths: cards.map((card) => card.querySelector('.gs-map-length')?.textContent ?? null),
      disabled: cards.filter((card) => card.disabled).length,
      firstRow: rects.filter((rect) => Math.abs(rect.top - rects[0].top) < 1).length,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    };
  })()`);
  check('map grid renders 7 cards', mapGrid.cards === 7, mapGrid.cards);
  check('map grid lays out 3 cards per row', mapGrid.firstRow === 3, mapGrid.firstRow);
  check('map screen has no horizontal overflow', mapGrid.scrollWidth <= mapGrid.innerWidth + 1,
    mapGrid.scrollWidth + ' > ' + mapGrid.innerWidth);
  check('sprint enables every map', mapGrid.disabled === 0, mapGrid.disabled);
  const mapSelect = await shot('shell-map-select.png');

  const consoleErrors = messages.filter((message) =>
    message.source === 'exception' || message.source === 'log.error' ||
    message.source === 'console.error' || message.source === 'console.warn' ||
    message.source === 'log.warning');
  check('console has no errors or warnings', consoleErrors.length === 0, consoleErrors);

  const evidence = {
    kind: 'game-shell.capture',
    version: 1,
    browser: { executable: edge, mode: 'headless=new', viewport: VIEWPORT },
    url: 'http://127.0.0.1:' + PORT + '/probes/game-shell/demo.html',
    counts,
    carGrid,
    mapGrid,
    screenshots: { mainMenu, carSelect, mapSelect },
    console: messages,
    failures,
    verdict: failures.length === 0 ? 'clean-console-and-counts' : 'failed'
  };
  writeFileSync(path.join(OUT, 'capture-report.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify({
    verdict: evidence.verdict,
    cars: carGrid.tiles,
    maps: mapGrid.cards,
    console: messages.length,
    failures
  }, null, 2) + '\n');
  if (failures.length) process.exitCode = 1;
} catch (error) {
  writeFileSync(path.join(OUT, 'capture-report.json'), JSON.stringify({
    kind: 'game-shell.capture',
    version: 1,
    verdict: 'failed',
    error: error.message,
    console: messages,
    failures
  }, null, 2) + '\n', 'utf8');
  process.stderr.write('capture failed: ' + error.message + '\n');
  process.exitCode = 1;
} finally {
  socket.close();
  browser.kill();
  server.kill();
}
