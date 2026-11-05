// Headless Edge/WebGPU screenshot + console gate for the car-part manifest.
//
//   node probes/car-parts/tools/capture_browser.mjs [--edge <msedge.exe>]
//        [--port 8806] [--debug-port 9351]
//
// Captures three fixed-angle views (wheels at +0.9 rad, 0 rad and a rear view),
// plus a repeat of the first view in a fresh page load for determinism. Every
// capture asserts:
//   * the page published a running probe with 29 parts / 80 draws
//   * four wheel groups are present and 20 wheel draws are rendered
//   * exactly two geometry uploads, never more
//   * drawsIssued == frame * 80
//   * the requested fixed angle is the rendered angle (spin is off)
//   * console/log output is empty
//
// Output: _work/car-parts/browser-<label>.png, browser-evidence.json
// Logs:   _work/logs/car-parts/edge.log

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, '_work/car-parts');
const LOGS = path.join(ROOT, '_work/logs/car-parts');
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

const PORT = Number(option('--port', '8806'));
const DEBUG_PORT = Number(option('--debug-port', '9351'));
const PROFILE = path.join(OUT, 'edge-profile');
const VIEWPORT = { width: 1600, height: 900 };

mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buffer) => 'sha256:' + createHash('sha256').update(buffer).digest('hex');

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
  throw new Error('Edge devtools endpoint unreachable. Log tail:\n' + browserLog.slice(-1600));
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
    messages.push({
      source: 'console.' + message.params.type,
      text: message.params.args.map((argument) => argument.value ?? argument.description).join(' ')
    });
  } else if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    messages.push({ source: 'exception', text: details.exception?.description ?? details.text });
  } else if (message.method === 'Log.entryAdded') {
    messages.push({ source: 'log.' + message.params.entry.level, text: message.params.entry.text,
                    url: message.params.entry.url });
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
await send('Emulation.setDeviceMetricsOverride', {
  width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false
});

const EXPECTED = { parts: 29, draws: 80, proven: 76, unclassified: 4, wheelGroups: 4, wheelDraws: 20 };

async function capture(label, query, options = {}) {
  messages.length = 0;
  const url = origin + '/' + query;
  await send('Page.navigate', { url });
  let probe = null;
  for (let attempt = 0; attempt < 500; attempt++) {
    probe = await evaluate(`(()=>{
      const p = window.carPartsProbe;
      if (!p) return null;
      return {
        state: p.state, error: p.error, frame: p.frame, angle: p.angle, spin: p.spin,
        parts: p.parts, draws: p.draws, diagnostics: p.diagnostics,
        wheelGroups: p.wheelGroups, adapter: p.adapter,
        geometryUploads: p.geometryUploads, geometryUploadBytes: p.geometryUploadBytes,
        drawsIssued: p.drawsIssued, uniformWrites: p.uniformWrites
      };
    })()`).catch(() => null);
    if (probe && probe.state === 'error') break;
    if (probe && probe.state === 'running' && probe.frame >= 20) break;
    await sleep(150);
  }
  if (!probe) throw new Error(label + ': page never published a probe');
  if (probe.state === 'error') throw new Error(label + ': page error: ' + probe.error);
  if (probe.frame < 20) throw new Error(label + ': only ' + probe.frame + ' frames rendered');
  if (probe.parts !== EXPECTED.parts) throw new Error(label + ': parts ' + probe.parts);
  if (probe.draws !== EXPECTED.draws) throw new Error(label + ': draws ' + probe.draws);
  if (probe.diagnostics.provenDrawCount !== EXPECTED.proven) throw new Error(label + ': proven draws ' + probe.diagnostics.provenDrawCount);
  if (probe.diagnostics.unclassifiedDrawCount !== EXPECTED.unclassified) throw new Error(label + ': unclassified draws ' + probe.diagnostics.unclassifiedDrawCount);
  if (probe.diagnostics.wheelDrawCount !== EXPECTED.wheelDraws) throw new Error(label + ': wheel draws ' + probe.diagnostics.wheelDrawCount);
  if (probe.wheelGroups.length !== EXPECTED.wheelGroups) throw new Error(label + ': wheel groups ' + probe.wheelGroups.length);
  if (probe.geometryUploads !== 2) throw new Error(label + ': geometry uploads ' + probe.geometryUploads);
  if (probe.drawsIssued !== probe.frame * EXPECTED.draws) {
    throw new Error(label + ': drawsIssued ' + probe.drawsIssued + ' != ' + probe.frame + ' * ' + EXPECTED.draws);
  }
  if (probe.spin !== false) throw new Error(label + ': spin was not disabled');
  if (Math.abs(probe.angle - options.angle) > 1e-6) {
    throw new Error(label + ': angle ' + probe.angle + ' != requested ' + options.angle);
  }
  if (!probe.adapter) throw new Error(label + ': no adapter info');

  await sleep(200);
  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const png = Buffer.from(screenshot.data, 'base64');
  const file = path.join(OUT, `browser-${label}.png`);
  writeFileSync(file, png);

  // Let any late console message arrive before closing the gate.
  await sleep(250);
  const consoleMessages = messages.map((message) => ({ ...message }));
  if (consoleMessages.length) {
    throw new Error(label + ': console is not clean:\n' + JSON.stringify(consoleMessages, null, 2));
  }

  return {
    label,
    url,
    probe,
    screenshot: path.relative(ROOT, file).split(path.sep).join('/'),
    screenshotBytes: png.length,
    screenshotSha256: sha256(png),
    console: consoleMessages
  };
}

try {
  const frontAngle = 0.9;
  const first = await capture('parts-angle090', `?angle=${frontAngle}&spin=0&yaw=0.95&pitch=0.27&dist=7.6`,
    { angle: frontAngle });
  const zero = await capture('parts-angle000', '?angle=0&spin=0&yaw=0.95&pitch=0.27&dist=7.6',
    { angle: 0 });
  const side = await capture('parts-side', '?angle=0&spin=0&yaw=1.5708&pitch=0.02&dist=8.6',
    { angle: 0 });
  const rear = await capture('parts-rear', '?angle=0.55&spin=0&yaw=-2.25&pitch=0.33&dist=7.4',
    { angle: 0.55 });
  const repeat = await capture('parts-angle090-repeat', `?angle=${frontAngle}&spin=0&yaw=0.95&pitch=0.27&dist=7.6`,
    { angle: frontAngle });

  const manifestPath = path.join(OUT, 'manifest.json');
  const meshPath = path.join(OUT, 'mesh.json');
  const stableProbe = (probe) => ({
    parts: probe.parts,
    draws: probe.draws,
    diagnostics: probe.diagnostics,
    wheelGroups: probe.wheelGroups,
    adapter: probe.adapter,
    geometryUploads: probe.geometryUploads,
    geometryUploadBytes: probe.geometryUploadBytes,
    angle: probe.angle,
    spin: probe.spin
  });
  const evidence = {
    kind: 'blur.car-part-manifest-browser-evidence',
    version: 1,
    viewport: VIEWPORT,
    edge,
    origin,
    manifest: {
      path: path.relative(ROOT, manifestPath).split(path.sep).join('/'),
      bytes: readFileSync(manifestPath).length,
      sha256: sha256(readFileSync(manifestPath))
    },
    mesh: {
      path: path.relative(ROOT, meshPath).split(path.sep).join('/'),
      bytes: readFileSync(meshPath).length,
      sha256: sha256(readFileSync(meshPath))
    },
    captures: [first, zero, side, rear, repeat],
    determinism: {
      sameUrl: first.url === repeat.url,
      screenshotBytesEqual: first.screenshotSha256 === repeat.screenshotSha256,
      probeEqual: JSON.stringify(stableProbe(first.probe)) === JSON.stringify(stableProbe(repeat.probe))
    },
    consoleClean: true
  };
  writeFileSync(path.join(OUT, 'browser-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(LOGS, 'edge.log'), browserLog, 'utf8');
  console.log(JSON.stringify({
    captures: evidence.captures.map((entry) => ({
      label: entry.label,
      angle: entry.probe.angle,
      frames: entry.probe.frame,
      drawsIssued: entry.probe.drawsIssued,
      screenshot: entry.screenshot,
      bytes: entry.screenshotBytes,
      sha256: entry.screenshotSha256,
      console: entry.console.length
    })),
    determinism: evidence.determinism,
    consoleClean: evidence.consoleClean
  }, null, 2));
} finally {
  await shutdown();
}
