// Deterministic screenshot capture for the visual-diff harness.
//
//   node probes/visual-diff/capture.mjs [--scene sprint-start,free] [--repeat 2]
//                                       [--port 8870] [--parity-port 8871]
//                                       [--room-port 8899] [--debug-port 9420]
//                                       [--build] [--list]
//
// Writes, under `_work/visual-diff/runs/<runId>/`:
//   repeat-<n>/<scene>.png     1600x900 PNG per scene per repeat
//   manifest.json              per-scene hashes, masks, evidence, timings
//   console.json               every console/exception/log message
//   determinism.json           byte equality (or measured delta) across repeats
//
// `_work/visual-diff/latest.json` points at the newest run. `--update-baseline`
// copies repeat 1 into the baseline store (`_work/visual-diff/baselines` by
// default) and rewrites its manifest; it refuses to run when the repeats are
// not deterministic.
//
// Exit codes: 0 captured, 2 usage error, 4 capture failure, 5 determinism
// failure. `compare.mjs` owns the visual gate (0/1/2/3).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { computeBuildHash, shortHash } from './build-hash.mjs';
import { ANIMATION_CSS, HIDDEN_OVERLAY_CSS, findBrowser, installStyles, launchBrowser } from './cdp.mjs';
import { DEFAULT_ABS_THRESHOLD, DEFAULT_REL_THRESHOLD, compareImages, maskRectsFromCapture } from './diff.mjs';
import { decodePngRgba } from './png.mjs';
import { SCENE_IDS, SCENES, selectScenes } from './scenes.mjs';
import { loadManifest, saveManifest, sha256, writeBaselineScene } from './store.mjs';
import { startServer as startAppServer } from '../e1-drive/tools/serve.mjs';
import { startServer as startAssetServer } from '../retail-parity/tools/serve_parity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = path.join(ROOT, '_work', 'visual-diff');
const LOGS = path.join(ROOT, '_work', 'logs', 'visual-diff');

function parseArgs(argv) {
  const values = {};
  const scenes = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new UsageError('unexpected argument ' + JSON.stringify(token));
    const name = token.slice(2);
    const next = argv[index + 1];
    if (name === 'scene') {
      if (!next || next.startsWith('--')) throw new UsageError('--scene needs a value');
      scenes.push(next);
      index++;
      continue;
    }
    if (name === 'update-baseline' || name === 'list' || name === 'allow-console-errors' || name === 'allow-warnings') {
      values[name] = true;
      continue;
    }
    if (!next || next.startsWith('--')) throw new UsageError('--' + name + ' needs a value');
    values[name] = next;
    index++;
  }
  return { values, scenes };
}

class UsageError extends Error {}

const { values, scenes: sceneArgs } = parseArgs(process.argv.slice(2));
const option = (name, fallback) => (values[name] === undefined ? fallback : values[name]);

if (values.list) {
  for (const scene of SCENES) {
    console.log(scene.id.padEnd(16) + (scene.kind === 'parity' ? 'pose ' + scene.pose : scene.url) + '  — ' + scene.label);
  }
  process.exit(0);
}

const PORT = Number(option('port', 8870));
const PARITY_PORT = Number(option('parity-port', 8871));
const ROOM_PORT = Number(option('room-port', 8899));
const DEBUG_PORT = Number(option('debug-port', 9420));
if (![PORT, PARITY_PORT, ROOM_PORT, DEBUG_PORT].every((value) => Number.isInteger(value) && value > 0)) {
  throw new UsageError('ports must be positive integers');
}
if (PORT < 8870 || PARITY_PORT < 8870 || ROOM_PORT < 8870) {
  throw new UsageError('this harness owns ports 8870+ only (never 8801/8802 or another agent\'s port)');
}
if (PORT === PARITY_PORT || PORT === ROOM_PORT || PARITY_PORT === ROOM_PORT) {
  throw new UsageError('the app, parity and room servers need distinct ports');
}
const REPEATS = Math.max(1, Number(option('repeat', 1)));
if (!Number.isInteger(REPEATS) || REPEATS > 5) throw new UsageError('--repeat must be an integer in 1..5');
const DETERMINISM_PIXELS = Number(option('determinism-pixels', 0));
const ABS = Number(option('abs', DEFAULT_ABS_THRESHOLD));
const REL = Number(option('rel', DEFAULT_REL_THRESHOLD));
const BASELINE_ROOT = path.resolve(ROOT, option('baseline-root', path.join('_work', 'visual-diff', 'baselines')));
const RUN_ID = option('run-id', new Date().toISOString().replace(/[:.]/g, '-'));
const RUN_DIR = path.resolve(ROOT, option('out', path.join('_work', 'visual-diff', 'runs', RUN_ID)));
const EDGE = findBrowser(option('edge', ''));
const browserViewport = { width: 1600, height: 900 };

const selected = selectScenes(sceneArgs);
if (!selected.length) throw new UsageError('no scenes selected');
const needsPowerups = selected.some((scene) => scene.kind === 'powerups');

mkdirSync(RUN_DIR, { recursive: true });
mkdirSync(LOGS, { recursive: true });

/** Format an absolute path as a repo-relative POSIX path. */
const rel = (absolute) => path.relative(ROOT, absolute).split(path.sep).join('/');

const build = computeBuildHash(ROOT);
writeFileSync(path.join(RUN_DIR, 'build.json'), JSON.stringify(build, null, 1) + '\n', 'utf8');
console.log('build hash ' + build.hash.slice(0, 12) + ' (' + build.inputs + ' inputs, ' + build.bytes + ' B, ' +
  build.missing.length + ' missing)');

const app = await startAppServer({ port: PORT });
const assets = await startAssetServer({ port: PARITY_PORT });
let room = null;
if (needsPowerups) {
  const { startRoomServer } = await import('../net-mvp/server.mjs');
  room = await startRoomServer({ port: ROOM_PORT, log: () => {} });
}

const PROFILE = path.join(WORK, 'edge-profile-' + PORT);
const session = await launchBrowser({
  executable: EDGE,
  debugPort: DEBUG_PORT,
  profile: PROFILE,
  viewport: browserViewport
});
await installStyles(session, ANIMATION_CSS);
let overlayScriptId = null;
async function setOverlayPolicy(mode) {
  if (overlayScriptId) {
    await session.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: overlayScriptId }).catch(() => {});
    overlayScriptId = null;
  }
  if (mode === 'hidden') {
    const result = await session.call('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const apply = () => {
          if (!document.documentElement) return;
          const style = document.createElement('style');
          style.setAttribute('data-visual-diff-overlays', '1');
          style.textContent = ${JSON.stringify(HIDDEN_OVERLAY_CSS)};
          document.documentElement.appendChild(style);
        };
        if (document.documentElement) apply();
        document.addEventListener('DOMContentLoaded', apply, { once: true });
      })();`
    });
    overlayScriptId = result.identifier;
  }
}

const sleep = (ms) => delay(ms);

/** Read the mask rectangles of the scene's selectors from the live DOM. */
async function readMasks(selectors) {
  if (!selectors || !selectors.length) return [];
  return session.evaluate(`(() => {
    const selectors = ${JSON.stringify(selectors)};
    return selectors.map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return { selector, rect: null, reason: 'missing' };
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return { selector, rect: null, reason: 'hidden' };
      }
      const box = element.getBoundingClientRect();
      if (!(box.width > 0 && box.height > 0)) return { selector, rect: null, reason: 'empty' };
      return { selector, rect: { x: box.x, y: box.y, w: box.width, h: box.height }, reason: null };
    });
  })()`);
}

/** Two animation frames plus a short settle, so the screenshot is a drawn frame. */
async function settle() {
  await session.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
    .catch(() => {});
  await sleep(80);
}

async function captureAppScene(scene, repeat) {
  const url = app.origin + scene.url;
  const started = Date.now();
  const before = session.messages.length;
  await setOverlayPolicy(scene.overlays);
  await session.navigate(url);
  const tick = scene.tick;
  let probe = null;
  let ready = false;
  for (let attempt = 0; attempt < Math.ceil((scene.timeoutMs ?? 150000) / 150); attempt++) {
    probe = await session.evaluate(`(() => {
      const p = window.e1DriveProbe;
      if (!p) return null;
      return {
        state: p.consumer, error: p.error, holdReached: p.holdReached,
        displayTick: p.displayTick, frames: p.frames, engineTick: p.engineTick,
        phase: p.phase, car: p.car ? p.car.slug : null
      };
    })()`).catch(() => null);
    if (probe && probe.state === 'error') throw new Error(scene.id + ': page error: ' + probe.error);
    if (probe && probe.state === 'running' && probe.holdReached === true &&
        probe.displayTick === tick && probe.frames >= 12) {
      ready = true;
      break;
    }
    await sleep(150);
  }
  if (!ready) {
    throw new Error(scene.id + ': page did not reach tick ' + tick +
      ' (state ' + JSON.stringify({ state: probe?.state, displayTick: probe?.displayTick,
        hold: probe?.holdReached, frames: probe?.frames }) + ')');
  }
  await settle();
  const evidence = await session.evaluate(`(() => {
    const p = window.e1DriveProbe;
    return {
      tick: p.displayTick, engineTick: p.engineTick, phase: p.phase,
      car: p.car ? p.car.slug : null,
      position: p.position ?? null, speed: p.speed ?? null,
      frames: p.frames, draws: p.draws, drawsIssued: p.drawsIssued,
      geometryUploads: p.geometryUploads, geometryUploadBytes: p.geometryUploadBytes,
      textureUploads: p.textureUploads, textureUploadBytes: p.textureUploadBytes,
      canvas: p.canvas ?? null,
      camera: p.render?.camera ?? p.camera ?? null,
      sprint: p.sprint ? { phase: p.sprint.phase, progress: p.sprint.progress,
        lap: p.sprint.lap ?? null, elapsedSeconds: p.sprint.elapsedSeconds ?? null } : null,
      map: p.map ? { id: p.map.id, draws: p.mapCounts?.draws ?? null } : null,
      textureSampling: window.__e1TextureSampling ?? null
    };
  })()`).catch(() => null);
  const masks = await readMasks(scene.masks);
  const png = await session.screenshot();
  const ms = Date.now() - started;
  return { url, png, masks, evidence, ms, messages: session.messages.slice(before) };
}

async function captureParityScene(scene, repeat) {
  if (repeat === 1) {
    const before = session.messages.length;
    await setOverlayPolicy('hidden');
    await session.navigate(assets.origin + '/probes/retail-parity/web/index.html?tag=0');
    let ready = false;
    for (let attempt = 0; attempt < 240; attempt++) {
      const state = await session.evaluate('Boolean(window.__parityReady) || Boolean(window.__parityError)').catch(() => false);
      if (state) { ready = true; break; }
      await sleep(250);
    }
    if (!ready) throw new Error('parity page never became ready');
    const error = await session.evaluate('window.__parityError ?? null');
    if (error) throw new Error('parity page failed: ' + error);
    parityMessages = session.messages.slice(before);
  } else if (!parityMessages) {
    throw new Error('parity page was not loaded in repeat 1');
  }
  const started = Date.now();
  const before = session.messages.length;
  const record = await session.evaluate(`window.__parityPose(${JSON.stringify(scene.pose)})`);
  await settle();
  const png = await session.screenshot();
  const ms = Date.now() - started;
  return {
    url: '/probes/retail-parity/web/index.html?tag=0#' + scene.pose,
    png,
    masks: [],
    evidence: {
      pose: scene.pose,
      mode: record.mode,
      tick: record.tick,
      carPosition: record.carPosition,
      camera: record.camera,
      draws: record.stats?.draws ?? null,
      texturedDraws: record.stats?.texturedDraws ?? null,
      mipChainHash: record.stats?.mipChainHash ?? null,
      lighting: record.lighting ?? null
    },
    ms,
    messages: session.messages.slice(before)
  };
}

async function capturePowerupScene(scene, repeat) {
  const url = app.origin + scene.url + '&audio=0&mpServer=' + encodeURIComponent(room.wsUrl);
  const started = Date.now();
  const before = session.messages.length;
  await setOverlayPolicy(scene.overlays);
  await session.navigate(url);
  let state = null;
  let ready = false;
  for (let attempt = 0; attempt < Math.ceil((scene.timeoutMs ?? 180000) / 200); attempt++) {
    state = await session.evaluate(`(() => {
      const mp = window.__mp && window.__mp.snapshot ? window.__mp.snapshot() : null;
      const power = window.__powerups && window.__powerups.state ? window.__powerups.state() : null;
      return {
        mp: mp ? { phase: mp.phase, engineReady: mp.engineReady, roomCode: mp.roomCode,
          status: mp.status ?? null, players: mp.players?.length ?? null,
          hud: mp.powerups?.hud ?? null } : null,
        power: power ? { phase: power.phase, pickups: power.pickups?.length ?? null } : null,
        room: document.getElementById('mp-room-code')?.textContent ?? null,
        connection: document.getElementById('mp-connection')?.textContent ?? null
      };
    })()`).catch(() => null);
    if (state?.mp?.phase === 'error') throw new Error(scene.id + ': lobby error');
    if (state?.mp?.phase === 'lobby' && state.mp.engineReady === true &&
        state?.power?.phase === 'lobby' && state.mp.hud?.hidden === false &&
        state.room && state.room !== '—' && /lobby/i.test(state.connection ?? '')) {
      ready = true;
      break;
    }
    await sleep(200);
  }
  if (!ready) throw new Error(scene.id + ': power-up lobby did not settle: ' + JSON.stringify(state));
  await sleep(500);
  await settle();
  const evidence = await session.evaluate(`(() => {
    const mp = window.__mp.snapshot();
    const power = window.__powerups.state();
    return {
      mpPhase: mp.phase, roomCodeLength: String(mp.roomCode ?? '').length,
      players: mp.players?.length ?? null, engineReady: mp.engineReady,
      powerPhase: power.phase, pickups: power.pickups?.length ?? null,
      manifestHash: power.manifestHash ?? null, types: power.types ?? null,
      hud: power.hud ?? null, placement: power.placement ?? null
    };
  })()`).catch(() => null);
  const masks = await readMasks(scene.masks);
  const png = await session.screenshot();
  const ms = Date.now() - started;
  return { url, png, masks, evidence, ms, messages: session.messages.slice(before) };
}

let parityMessages = null;
const repeats = [];
const failures = [];
const timings = [];
try {
  for (let repeat = 1; repeat <= REPEATS; repeat++) {
    const directory = path.join(RUN_DIR, 'repeat-' + repeat);
    mkdirSync(directory, { recursive: true });
    console.log('--- repeat ' + repeat + '/' + REPEATS + ' ---');
    const records = [];
    for (const scene of selected) {
      let result;
      try {
        if (scene.kind === 'parity') result = await captureParityScene(scene, repeat);
        else if (scene.kind === 'powerups') result = await capturePowerupScene(scene, repeat);
        else result = await captureAppScene(scene, repeat);
      } catch (error) {
        const entry = { id: scene.id, error: String(error?.message ?? error) };
        records.push(entry);
        failures.push(entry);
        console.log('  FAIL ' + scene.id + ': ' + entry.error.split('\n')[0]);
        continue;
      }
      const file = path.join(directory, scene.id + '.png');
      writeFileSync(file, result.png);
      const entry = {
        id: scene.id,
        file: rel(file),
        sha256: sha256(result.png),
        bytes: result.png.length,
        capturedAt: new Date().toISOString(),
        ms: result.ms,
        scene: {
          kind: scene.kind,
          label: scene.label ?? null,
          url: result.url,
          tick: scene.tick ?? null,
          pose: scene.pose ?? null,
          mechanism: scene.mechanism ?? null,
          overlays: scene.overlays,
          viewport: scene.viewport,
          maxChangedPercent: scene.maxChangedPercent ?? 0
        },
        masks: result.masks,
        evidence: result.evidence,
        console: {
          total: result.messages.length,
          errors: result.messages.filter((message) => message.severity === 'error').length,
          warnings: result.messages.filter((message) => message.severity === 'warn').length,
          messages: result.messages
        }
      };
      records.push(entry);
      const errors = entry.console.errors;
      const warnings = entry.console.warnings;
      console.log('  ' + scene.id.padEnd(16) + String(result.ms).padStart(6) + ' ms  ' +
        (entry.sha256 ?? '').slice(0, 12) + (errors ? '  CONSOLE ERRORS ' + errors : '') +
        (!errors && warnings ? '  warnings ' + warnings : ''));
      if (errors) {
        const failure = { id: scene.id, error: 'console errors: ' + entry.console.messages.filter((m) => m.severity === 'error').map((m) => m.source + ': ' + m.text).join(' | ') };
        if (!values['allow-console-errors']) failures.push(failure);
      }
      timings.push({ id: scene.id, ms: result.ms, repeat });
    }
    repeats.push({ repeat, records, directory: rel(directory) });
    console.log('');
  }

  // Determinism: compare each scene between repeat 1 and every later repeat.
  let determinism = { repeats: REPEATS, ok: true, scenes: [], tolerance: { maxChangedPixels: DETERMINISM_PIXELS } };
  if (REPEATS > 1) {
    for (const scene of selected) {
      const first = repeats[0].records.find((record) => record.id === scene.id);
      const rows = [];
      let ok = true;
      for (let repeat = 2; repeat <= REPEATS; repeat++) {
        const later = repeats[repeat - 1].records.find((record) => record.id === scene.id);
        if (!first || !later || first.error || later.error) { ok = false; rows.push({ repeat, status: 'missing' }); continue; }
        const byteIdentical = first.sha256 === later.sha256;
        let row = { repeat, byteIdentical, status: byteIdentical ? 'identical' : 'differs' };
        if (!byteIdentical) {
          const current = decodePngRgba(readFileSync(path.join(ROOT, later.file)));
          const baseline = decodePngRgba(readFileSync(path.join(ROOT, first.file)));
          const maskRects = [
            ...maskRectsFromCapture(first.masks ?? [], scene.id).rects,
            ...maskRectsFromCapture(later.masks ?? [], scene.id).rects
          ];
          const diff = compareImages(current, baseline, { absThreshold: ABS, relThreshold: REL, maskRects });
          const allowed = Math.max(DETERMINISM_PIXELS, Math.round((scene.determinism?.maxChangedPixels ?? 0)));
          row = { ...row, ...diff, masks: undefined, allowedChangedPixels: allowed,
            status: diff.status === 'size-mismatch' || diff.changedPixels > allowed ? 'differs' : 'within-tolerance' };
          if (row.status === 'differs') ok = false;
        }
        rows.push(row);
      }
      if (!ok) determinism.ok = false;
      determinism.scenes.push({ id: scene.id, ok, rows });
    }
    writeFileSync(path.join(RUN_DIR, 'determinism.json'), JSON.stringify(determinism, null, 1) + '\n', 'utf8');
    const bad = determinism.scenes.filter((scene) => !scene.ok);
    if (bad.length) {
      for (const scene of bad) failures.push({ id: scene.id, error: 'repeats are not deterministic' });
    }
  }

  const manifest = {
    kind: 'blur-web.visual-diff.capture',
    version: 1,
    runId: RUN_ID,
    createdAt: new Date().toISOString(),
    root: rel(RUN_DIR),
    build,
    browser: { executable: EDGE, headless: true, viewport: browserViewport, deviceScaleFactor: 1 },
    determinism: { repeats: REPEATS, tolerance: { maxChangedPixels: DETERMINISM_PIXELS, abs: ABS, rel: REL },
      ok: repeats.length > 1 ? determinism.ok : null },
    scenes: repeats[0]?.records ?? [],
    repeats: repeats.map((entry) => ({ repeat: entry.repeat, directory: entry.directory,
      scenes: entry.records.map((record) => ({ id: record.id, sha256: record.sha256 ?? null, error: record.error ?? null })) })),
    timings: { perSceneMs: timings, totalMs: timings.reduce((sum, row) => sum + row.ms, 0) },
    console: {
      total: repeats[0]?.records.reduce((sum, record) => sum + (record.console?.total ?? 0), 0) ?? 0,
      errors: repeats[0]?.records.reduce((sum, record) => sum + (record.console?.errors ?? 0), 0) ?? 0,
      warnings: repeats[0]?.records.reduce((sum, record) => sum + (record.console?.warnings ?? 0), 0) ?? 0
    },
    failures
  };
  writeFileSync(path.join(RUN_DIR, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n', 'utf8');
  const consoleLog = {
    runId: RUN_ID,
    scenes: repeats[0]?.records.map((record) => ({ id: record.id, console: record.console ?? null })) ?? []
  };
  writeFileSync(path.join(RUN_DIR, 'console.json'), JSON.stringify(consoleLog, null, 1) + '\n', 'utf8');

  writeFileSync(path.join(WORK, 'latest.json'), JSON.stringify({
    runId: RUN_ID, dir: rel(RUN_DIR), createdAt: new Date().toISOString(),
    build: build.hash, repeats: REPEATS, failures: failures.length
  }, null, 1) + '\n', 'utf8');
  writeFileSync(path.join(LOGS, 'edge-' + RUN_ID + '.log'), session.browserLog(), 'utf8');

  // Baseline update happens after determinism so a non-deterministic frame can
  // never become the reference.
  if (values['update-baseline']) {
    if (REPEATS > 1 && !determinism.ok) {
      failures.push({ id: '*', error: 'refusing to update baselines: repeats are not deterministic' });
    } else if (failures.length) {
      failures.push({ id: '*', error: 'refusing to update baselines: capture reported failures' });
    } else {
      const loaded = loadManifest(BASELINE_ROOT);
      if (loaded.error) throw new Error(loaded.error);
      const baselineManifest = loaded.manifest;
      baselineManifest.build = build;
      if (!loaded.exists) baselineManifest.createdAt = new Date().toISOString();
      let updated = 0;
      for (const record of repeats[0].records) {
        const scene = SCENES.find((candidate) => candidate.id === record.id);
        if (!scene || record.error) continue;
        writeBaselineScene({
          root: BASELINE_ROOT,
          manifest: baselineManifest,
          scene,
          capture: record,
          pngBuffer: readFileSync(path.join(ROOT, record.file)),
          build
        });
        updated++;
      }
      saveManifest(BASELINE_ROOT, baselineManifest);
      manifest.baseline = { root: rel(BASELINE_ROOT), updated, updatedAt: new Date().toISOString() };
      writeFileSync(path.join(RUN_DIR, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n', 'utf8');
      console.log('baselines updated: ' + updated + ' scene(s) in ' + rel(BASELINE_ROOT));
    }
  }

  const totalMs = timings.reduce((sum, row) => sum + row.ms, 0);
  const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 5);
  const result = {
    runId: RUN_ID,
    dir: rel(RUN_DIR),
    buildHash: build.hash,
    buildShort: shortHash(build.hash),
    scenes: repeats[0]?.records.map((record) => ({ id: record.id, sha256: record.sha256 ?? null,
      ms: record.ms ?? null, file: record.file ?? null, error: record.error ?? null })),
    determinism: manifest.determinism,
    runtime: {
      perSceneMs: Object.fromEntries(timings.filter((row) => row.repeat === 1).map((row) => [row.id, row.ms])),
      totalSceneMs: totalMs,
      slowest: slowest.map((row) => ({ id: row.id, ms: row.ms }))
    },
    console: manifest.console,
    failures
  };
  console.log(JSON.stringify(result, null, 1));
  if (failures.length) process.exitCode = failures.some((failure) => /deterministic/.test(failure.error)) ? 5 : 4;
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exitCode = error instanceof UsageError ? 2 : 4;
} finally {
  await session.close();
  if (room) { try { await room.close(); } catch {} }
  await new Promise((resolve) => app.server.close(resolve));
  await new Promise((resolve) => assets.server.close(resolve));
}
