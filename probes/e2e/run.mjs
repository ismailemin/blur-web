#!/usr/bin/env node
// Automated end-to-end harness for the Blur Web E1 drive slice.
//
// Boots the PoC static server (or attaches to one with --base), launches a
// headless Edge/Chrome process per scenario through CDP, drives the real page
// (solo sprint/lap/free, multiplayer, AI, reconnect, map mode matrix), asserts
// the committed anchors, captures screenshots per step and writes a JSON report
// with console gates, timings and screenshot/payload hashes.
//
//   node probes/e2e/run.mjs                       # default fast set
//   node probes/e2e/run.mjs --all                 # every scenario (incl. Amboy)
//   node probes/e2e/run.mjs --scenarios solo-sprint,mp-two
//   node probes/e2e/run.mjs --base http://127.0.0.1:8820
//
// Exit codes: 0 all selected scenarios passed, 1 any scenario failed,
// 2 prerequisites/artifacts missing, 3 harness could not start (ports/browser).
//
// This file owns probes/e2e/** and writes only _work/e2e/** and
// _work/logs/e2e/**. It never modifies the page, the server, probes/net-mvp or
// any game/upstream artifact.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CdpBrowser, findBrowser, sleep } from './cdp.mjs';
import {
  assertSilent,
  modeMatrix,
  menuModes,
  mpAi,
  mpAmboy,
  mpCoveredMap,
  mpEight,
  mpGracia,
  mpBossBattle,
  mpDestruction,
  mpElimination,
  mpPoints,
  mpPowerups,
  mpTwo,
  reconnect,
  soloCheckpoint,
  soloFree,
  soloLap,
  soloSprint
} from './scenarios.mjs';
import { soloDowntown, soloLongbeach, soloMapScenario, soloMharuna, soloObservatory } from './longbeach.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/e2e');
const LOGS = path.join(ROOT, '_work/logs/e2e');
const PROFILES = path.join(OUT, 'profiles');
const SCREENS = path.join(OUT, 'screens');
const VIEWPORT = { width: 1600, height: 900 };

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);

const PORT = Number(option('--port', '8820'));
const ROOM_PORT = Number(option('--room-port', '8821'));
const BASE = option('--base', null);
const ROOM_URL = option('--room-url', null);
const EDGE = findBrowser(option('--edge', null));
const RETRIES = Math.max(0, Number(option('--retries', '1')));
const SPRINT_RUNS = Math.max(1, Number(option('--sprint-runs', '2')));
const VERBOSE = flag('--verbose');
// `--ignore-cert` lets the harness drive a local TLS proxy with a development
// certificate; it is never used for a production origin.
const IGNORE_CERT = flag('--ignore-cert');

const SCENARIOS = {
  'solo-sprint': { group: 'default', timeout: 180000, run: soloSprint },
  'solo-lap': { group: 'default', timeout: 240000, run: soloLap },
  'solo-free': { group: 'default', timeout: 180000, run: soloFree },
  'mp-two': { group: 'default', timeout: 210000, run: mpTwo },
  'mp-ai': { group: 'fast', timeout: 300000, run: mpAi },
  reconnect: { group: 'fast', timeout: 300000, run: reconnect },
  'mode-matrix': { group: 'fast', timeout: 360000, run: modeMatrix },
  'mp-gracia': { group: 'slow', timeout: 300000, run: mpGracia },
  'mp-powerups': { group: 'slow', timeout: 420000, run: mpPowerups },
  'solo-checkpoint': { group: 'slow', timeout: 300000, run: soloCheckpoint },
  'mp-destruction': { group: 'slow', timeout: 420000, run: mpDestruction },
  'menu-modes': { group: 'fast', timeout: 180000, run: menuModes },
  'mp-points': { group: 'slow', timeout: 420000, run: mpPoints },
  'mp-elimination': { group: 'slow', timeout: 420000, run: mpElimination },
  'mp-boss-battle': { group: 'slow', timeout: 420000, run: mpBossBattle },
  'mp-amboy': { group: 'slow', timeout: 600000, run: mpAmboy },
  'mp-eight': { group: 'slow', timeout: 600000, run: mpEight },
  'solo-longbeach': { group: 'slow', timeout: 300000, run: soloLongbeach },
  'solo-observatory': { group: 'slow', timeout: 300000, run: soloObservatory },
  'solo-downtown': { group: 'slow', timeout: 300000, run: soloDowntown },
  'solo-mharuna': { group: 'slow', timeout: 300000, run: soloMharuna },
  'solo-highrise': { group: 'slow', timeout: 300000, run: soloMapScenario('highrise') },
  'solo-shutoko': { group: 'slow', timeout: 300000, run: soloMapScenario('shutoko') },
  'solo-oval': { group: 'slow', timeout: 300000, run: soloMapScenario('oval') },
  'solo-amboy-mp': { group: 'slow', timeout: 300000, run: soloMapScenario('amboy-mp') },
  'solo-dumbo': { group: 'slow', timeout: 300000, run: soloMapScenario('dumbo') },
  'solo-downtown-mp': { group: 'slow', timeout: 300000, run: soloMapScenario('downtown-mp') },
  'solo-sausalito': { group: 'slow', timeout: 300000, run: soloMapScenario('sausalito') },
  'solo-hackney': { group: 'slow', timeout: 420000, run: soloMapScenario('hackney') },
  'solo-russianhill': { group: 'slow', timeout: 300000, run: soloMapScenario('russianhill') },
  // Two-player rooms on the three covered-path maps.
  'mp-hackney': { group: 'slow', timeout: 600000, run: mpCoveredMap('hackney') },
  'mp-russianhill': { group: 'slow', timeout: 900000, run: mpCoveredMap('russianhill') },
  'mp-brighton': { group: 'slow', timeout: 300000, run: mpCoveredMap('brighton') },
  'solo-brighton': { group: 'slow', timeout: 300000, run: soloMapScenario('brighton') }
};
const DEFAULT_SCENARIOS = ['solo-sprint', 'solo-lap', 'solo-free', 'mp-two'];
const FAST_SCENARIOS = ['solo-sprint', 'solo-free', 'mp-two', 'mp-ai', 'reconnect', 'mode-matrix', 'mp-eight'];
const MP_SCENARIOS = new Set(['mp-two', 'mp-ai', 'reconnect', 'mp-gracia', 'mp-amboy', 'mp-hackney', 'mp-russianhill', 'mp-brighton', 'mp-eight', 'mp-powerups', 'mp-destruction', 'mp-points', 'mp-elimination', 'mp-boss-battle']);
const MAP_SCENARIOS = new Set(['mp-amboy', 'mp-gracia', 'mp-hackney', 'mp-russianhill', 'mp-brighton', 'mode-matrix']);

const runId = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
mkdirSync(OUT, { recursive: true });
mkdirSync(PROFILES, { recursive: true });
mkdirSync(SCREENS, { recursive: true });
mkdirSync(LOGS, { recursive: true });
const logFile = path.join(LOGS, runId + '.log');

function log(message) {
  const line = typeof message === 'string' ? message : JSON.stringify(message);
  console.log(line);
  try { appendFileSync(logFile, line + '\n'); } catch { /* logging must not fail the run */ }
}

function die(message, code) {
  log('ERROR: ' + message);
  process.exit(code);
}

// ------------------------------------------------------------ selection

function selectScenarios() {
  const explicit = option('--scenarios', null);
  let ids;
  if (explicit) ids = explicit.split(',').map((value) => value.trim()).filter(Boolean);
  else if (flag('--all')) ids = Object.keys(SCENARIOS);
  else if (flag('--fast')) ids = FAST_SCENARIOS;
  else ids = DEFAULT_SCENARIOS;
  const unknown = ids.filter((id) => !SCENARIOS[id]);
  if (unknown.length) {
    die('unknown scenario(s) ' + JSON.stringify(unknown) + '; known: ' + Object.keys(SCENARIOS).join(', '), 3);
  }
  return [...new Set(ids)];
}

// ------------------------------------------------------------ assertions

class Assertions {
  constructor() {
    this.items = [];
  }

  check(name, ok, detail = null) {
    const entry = {
      name,
      ok: ok === true,
      detail: detail === null || detail === undefined
        ? null
        : (typeof detail === 'string' ? detail : JSON.stringify(detail))
    };
    if (entry.detail && entry.detail.length > 1200) entry.detail = entry.detail.slice(0, 1200) + '…';
    this.items.push(entry);
    return entry.ok;
  }

  get total() { return this.items.length; }
  get passed() { return this.items.filter((item) => item.ok).length; }
  get failed() { return this.items.filter((item) => !item.ok).length; }
  get failures() { return this.items.filter((item) => !item.ok); }
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// ------------------------------------------------------------ prerequisites

const REQUIRED = [
  '_work/e1-drive/module/e1_drive.mjs',
  '_work/e1-drive/module/e1_drive.wasm',
  '_work/e1-drive/level.geometry.json',
  '_work/e1-drive/base.geometry.json',
  '_work/e1-drive/car-bodies.index.json',
  '_work/e1-drive/cars.json',
  '_work/e1-drive/sprint.json',
  '_work/e1-drive/sprint-short.json',
  '_work/e1-drive/sprint-lap.json',
  '_work/e1-drive/sprint-free.json',
  '_work/e1-drive/Level.levelphysics',
  'probes/e1-drive/web/index.html',
  'probes/e1-drive/web/app.js'
];

function checkPrerequisites(selected) {
  const required = [...REQUIRED];
  const expected = JSON.parse(readFileSync(path.join(ROOT, 'probes/e2e/expected.json'), 'utf8'));
  const cars = [expected.cars.default, expected.cars.mpGuest];
  for (const slug of cars) {
    required.push('_work/e1-drive/cars/' + slug + '.geometry.json');
    required.push('_work/e1-drive/cars/' + slug + '.fields');
  }
  if (selected.some((id) => MAP_SCENARIOS.has(id))) {
    required.push('_work/e1-drive/amboy/map.json', '_work/e1-drive/amboy/layout.json');
    required.push('_work/e1-drive/gracia/map.json', '_work/e1-drive/gracia/layout.json');
    required.push('game-data/Blur/levels/usa_amboy/Level.levelphysics');
    required.push('game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics');
    for (const [map, level] of [['hackney', 'uk_london_hackney'],
      ['russianhill', 'usa_sanfran_russianhill'], ['brighton', 'uk_brighton']]) {
      required.push('_work/e1-drive/' + map + '/map.json', '_work/e1-drive/' + map + '/layout.json');
      required.push('game-data/Blur/levels/' + level + '/Level.levelphysics');
    }
  }
  const missing = required.filter((rel) => !existsSync(path.join(ROOT, rel)));
  if (missing.length === 0) return;
  log('E2E prerequisites are missing:');
  for (const rel of missing) log('  ' + rel);
  log('');
  log('Build them with:');
  log('  node probes/render-packet/tools/build_packet.mjs');
  log('  python engine/verify_vehicle.py --skip-build');
  log('  node probes/e1-drive/tools/build_module.mjs --force-objects');
  log('  node probes/e1-drive/tools/build_geometry.mjs');
  log('  python probes/e1-drive/tools/car_roster.py');
  log('  node probes/e1-drive/tools/build_sprint.mjs');
  log('  node probes/e1-drive/tools/build_map_amboy.mjs');
  log('  node probes/e1-drive/tools/build_map_gracia.mjs');
  process.exit(2);
}

// ------------------------------------------------------------ anchors

/**
 * Committed expected values (probes/e2e/expected.json) plus the layout hashes
 * read from the built layout documents. When `_work/e1-drive/run.json` exists,
 * its measured sprint/lap values are compared; if they differ the current
 * artifact wins (the browser must match the physics that actually shipped) and
 * the drift is recorded in the report instead of being hidden.
 */
function loadAnchors() {
  const expected = JSON.parse(readFileSync(path.join(ROOT, 'probes/e2e/expected.json'), 'utf8'));
  const layouts = {};
  for (const [id, rel] of Object.entries(expected.layouts)) {
    const file = path.join(ROOT, rel);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof doc.hash !== 'string' || !doc.hash.startsWith('sha256:')) {
      throw new Error('layout ' + rel + ' has no canonical hash');
    }
    layouts[id] = doc.hash;
  }
  const anchors = {
    cars: expected.cars,
    layouts,
    sprint: { ...expected.solo.sprint, layoutHash: layouts['310m'] },
    lap: { ...expected.solo.lap, layoutHash: layouts.lap },
    free: { ...expected.solo.free, layoutHash: layouts.free },
    longbeach: { ...expected.solo.longbeach },
    observatory: { ...expected.solo.observatory },
    downtown: { ...expected.solo.downtown },
    mharuna: { ...expected.solo.mharuna },
    highrise: { ...expected.solo.highrise },
    shutoko: { ...expected.solo.shutoko },
    oval: { ...expected.solo.oval },
    'amboy-mp': { ...expected.solo['amboy-mp'] },
    dumbo: { ...expected.solo.dumbo },
    'downtown-mp': { ...expected.solo['downtown-mp'] },
    sausalito: { ...expected.solo.sausalito },
    hackney: { ...expected.solo.hackney },
    russianhill: { ...expected.solo.russianhill },
    brighton: { ...expected.solo.brighton },
    mp: expected.mp,
    mpAi: expected.mpAi
  };
  const drift = [];
  const runPath = path.join(ROOT, '_work/e1-drive/run.json');
  if (existsSync(runPath)) {
    const run = JSON.parse(readFileSync(runPath, 'utf8'));
    const sprintCar = run.sprint?.cars?.find((car) => car.slug === anchors.sprint.slug);
    // `run.json` is a local measurement artifact. A row measured on a different
    // layout must not override the committed anchor: the course changed, so the
    // old time describes a road that no longer ships. The skip is recorded in
    // the report instead of being silent.
    const sprintStale = Boolean(sprintCar?.layoutHash) &&
      sprintCar.layoutHash !== layouts['310m'];
    if (sprintStale) {
      drift.push({ anchor: 'sprint', chosen: 'expected.json',
        reason: 'run.json row was measured on a different layout',
        runJsonLayout: sprintCar.layoutHash, currentLayout: layouts['310m'] });
    }
    if (sprintCar?.finish && !sprintStale) {
      if (sprintCar.finish.timeSeconds !== anchors.sprint.timeSeconds) {
        drift.push({ anchor: 'sprint.timeSeconds', expectedJson: anchors.sprint.timeSeconds,
          runJson: sprintCar.finish.timeSeconds, chosen: 'run.json' });
        anchors.sprint.timeSeconds = sprintCar.finish.timeSeconds;
      }
      if (sprintCar.finish.tick !== anchors.sprint.tick) {
        drift.push({ anchor: 'sprint.tick', expectedJson: anchors.sprint.tick,
          runJson: sprintCar.finish.tick, chosen: 'run.json' });
        anchors.sprint.tick = sprintCar.finish.tick;
      }
      if (sprintCar.finish.checkpoints !== anchors.sprint.checkpoints) {
        drift.push({ anchor: 'sprint.checkpoints', expectedJson: anchors.sprint.checkpoints,
          runJson: sprintCar.finish.checkpoints, chosen: 'run.json' });
        anchors.sprint.checkpoints = sprintCar.finish.checkpoints;
      }
    }
    const lapCar = run.sprint?.lapCourse?.cars?.find((car) => car.slug === anchors.lap.slug);
    const lapStale = Boolean(lapCar?.layoutHash) && lapCar.layoutHash !== layouts.lap;
    if (lapStale) {
      drift.push({ anchor: 'lap', chosen: 'expected.json',
        reason: 'run.json row was measured on a different layout',
        runJsonLayout: lapCar.layoutHash, currentLayout: layouts.lap });
    }
    if (lapCar?.finish && !lapStale) {
      if (lapCar.finish.timeSeconds !== anchors.lap.timeSeconds) {
        drift.push({ anchor: 'lap.timeSeconds', expectedJson: anchors.lap.timeSeconds,
          runJson: lapCar.finish.timeSeconds, chosen: 'run.json' });
        anchors.lap.timeSeconds = lapCar.finish.timeSeconds;
      }
      if (lapCar.finish.tick !== anchors.lap.tick) {
        drift.push({ anchor: 'lap.tick', expectedJson: anchors.lap.tick,
          runJson: lapCar.finish.tick, chosen: 'run.json' });
        anchors.lap.tick = lapCar.finish.tick;
      }
      if (Array.isArray(lapCar.lapTimes) &&
          JSON.stringify(lapCar.lapTimes) !== JSON.stringify(anchors.lap.lapTimesSeconds)) {
        drift.push({ anchor: 'lap.lapTimesSeconds', expectedJson: anchors.lap.lapTimesSeconds,
          runJson: lapCar.lapTimes, chosen: 'run.json' });
        anchors.lap.lapTimesSeconds = lapCar.lapTimes;
      }
    }
    const free = run.sprint?.freeRoam?.cars?.find((car) => car.slug === anchors.free.slug);
    if (free && Number.isFinite(free.respawns)) {
      anchors.free.referenceRespawns = free.respawns;
    }
  }
  return { expected, anchors, drift };
}

// ------------------------------------------------------------ servers

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function startServers(selected) {
  const needsRoom = selected.some((id) => MP_SCENARIOS.has(id));
  let origin = BASE;
  let server = null;
  if (BASE) {
    const parsed = new URL(BASE);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('--base must be an http(s) URL');
    // A local TLS proxy uses a development certificate; `--ignore-cert` also
    // relaxes this one reachability fetch (never a production origin).
    if (IGNORE_CERT) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const response = await fetch(new URL('/', BASE)).catch((error) => {
      throw new Error('--base is not reachable: ' + error.message);
    });
    if (!response.ok) throw new Error('--base returned HTTP ' + response.status);
    origin = BASE.replace(/\/$/, '');
    log('attached to ' + origin);
  } else {
    const { startServer } = await import(pathToFileURL(
      path.join(ROOT, 'probes/e1-drive/tools/serve.mjs')).href);
    const started = await startServer({ port: PORT });
    server = started.server;
    origin = started.origin;
    log('started PoC server on ' + origin + ' (port ' + started.port + ')');
  }

  let roomServer = null;
  let roomUrl = ROOM_URL;
  if (needsRoom && !roomUrl) {
    if (await isPortOpen(ROOM_PORT)) {
      roomUrl = 'ws://127.0.0.1:' + ROOM_PORT + '/ws';
      log('room service already listening on ' + ROOM_PORT + '; attaching');
    } else {
      const { startRoomServer } = await import(pathToFileURL(
        path.join(ROOT, 'probes/net-mvp/server.mjs')).href);
      roomServer = await startRoomServer({ port: ROOM_PORT, log: () => {} });
      roomUrl = roomServer.wsUrl;
      log('started unchanged net-mvp room service on ' + roomUrl);
    }
  }
  return { origin, server, roomServer, roomUrl };
}

// ------------------------------------------------------------ runner

class ScenarioTimeout extends Error {}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ScenarioTimeout(label + ' after ' + ms + ' ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function summarize(value) {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 1200 ? text.slice(0, 1200) + '…' : text;
  } catch {
    return String(value);
  }
}

async function runAttempt(id, attempt, definition, shared) {
  const dir = path.join(SCREENS, id, 'attempt-' + attempt);
  mkdirSync(dir, { recursive: true });
  const A = new Assertions();
  const ctx = {
    scenarioId: id,
    attempt,
    options: { sprintRuns: SPRINT_RUNS, retries: RETRIES },
    anchors: shared.anchors,
    expected: shared.expected,
    base: shared.servers.origin,
    roomUrl: shared.servers.roomUrl,
    roomServer: shared.servers.roomServer,
    A,
    browser: null,
    pages: [],
    steps: [],
    screenshots: [],
    evidence: {},
    lastScreenshot: null,
    fmt: summarize
  };

  ctx.shot = async (page, name, options = {}) => {
    if (!page) throw new Error(id + ': screenshot ' + name + ' has no page');
    const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-');
    const file = path.join(dir, safe + '.png');
    const info = await page.screenshot(file, options);
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const record = { path: rel, name, bytes: info.bytes, width: info.width, height: info.height,
      sha256: sha256File(file) };
    ctx.steps.push({ name, atMs: Date.now() - shared.runStartedAt, screenshot: rel });
    ctx.screenshots.push(record);
    ctx.lastScreenshot = record;
    if (VERBOSE) log('  shot ' + rel + ' (' + info.width + 'x' + info.height + ', ' + info.bytes + ' B)');
    return record;
  };
  ctx.openPage = async (label, options = {}) => {
    const page = await ctx.browser.newPage({ label, ...options });
    ctx.pages.push(page);
    return page;
  };
  ctx.closePage = async (page) => {
    page.close();
    try {
      await fetch(`http://127.0.0.1:${page.httpPort}/json/close/${page.target.id}`);
    } catch { /* target may already be gone */ }
  };

  const attemptStarted = Date.now();
  let error = null;
  let pageError = null;
  try {
    ctx.browser = await CdpBrowser.launch({
      executable: EDGE,
      profileDir: path.join(PROFILES, id + '-attempt' + attempt + '-' + runId),
      viewport: VIEWPORT,
      debugPort: 0,
      extraArgs: IGNORE_CERT ? ['--ignore-certificate-errors'] : []
    });
    await withTimeout(Promise.resolve().then(() => definition.run(ctx)),
      definition.timeout, id + ' scenario timeout');
  } catch (caught) {
    error = caught;
  }

  // Console gate runs even when the scenario body threw: a failing scenario
  // must still report the messages that were captured before the failure.
  try {
    for (const page of ctx.browser?.pages ?? []) {
      if (!Number.isInteger(page.consumed)) page.consumed = 0;
      assertSilent(ctx, page, page.consumed, page.label + ' console after the last step');
    }
  } catch (gateError) {
    pageError = gateError;
    A.check('console gate executed', false, gateError.message);
  }

  const browserInfo = ctx.browser ? {
    executable: ctx.browser.executable,
    version: ctx.browser.version?.Browser ?? ctx.browser.version?.['User-Agent'] ?? null,
    pages: ctx.browser.pages.length
  } : null;
  const console = (ctx.browser?.pages ?? []).map((page) => ({
    label: page.label,
    total: page.messages.length,
    errors: page.messages.filter((message) => message.type === 'error').length,
    warnings: page.messages.filter((message) => message.type === 'warning' || message.type === 'warn').length,
    messages: page.messages
  }));
  if (error) {
    A.check('scenario completed without throwing', false, error.message);
  }
  if (pageError) {
    A.check('console gate read every page', false, pageError.message);
  }

  const result = {
    id,
    status: error || A.failed > 0 ? 'failed' : 'passed',
    group: definition.group,
    timeoutMs: definition.timeout,
    attempt,
    durationMs: Date.now() - attemptStarted,
    browser: browserInfo,
    assertions: {
      total: A.total,
      passed: A.passed,
      failed: A.failed,
      failures: A.failures
    },
    console,
    steps: ctx.steps,
    screenshots: ctx.screenshots,
    evidence: ctx.evidence,
    error: error?.message ?? null
  };
  try {
    await ctx.browser?.close();
  } catch (closeError) {
    result.closeError = closeError.message;
  }
  if (result.status === 'failed' && result.error === null && A.failures.length > 0) {
    result.error = A.failures.map((item) => item.name + (item.detail ? ': ' + item.detail : '')).join('; ');
  }
  return result;
}

async function runScenario(id, shared) {
  const definition = SCENARIOS[id];
  const attempts = [];
  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    log('');
    log('▶ ' + id + (attempt > 1 ? ' (retry ' + attempt + ')' : '') + '  [timeout ' + definition.timeout + ' ms]');
    const result = await runAttempt(id, attempt, definition, shared);
    attempts.push(result);
    log((result.status === 'passed' ? '  PASS ' : '  FAIL ') + id +
      ' · ' + result.assertions.passed + '/' + result.assertions.total + ' assertions · ' +
      (result.durationMs / 1000).toFixed(1) + ' s · ' + result.screenshots.length + ' screenshots');
    if (result.status === 'passed') break;
    for (const failure of result.assertions.failures.slice(0, 8)) {
      log('    ✗ ' + failure.name + (failure.detail ? ' — ' + failure.detail : ''));
    }
    if (result.assertions.failures.length > 8) {
      log('    … ' + (result.assertions.failures.length - 8) + ' more failures');
    }
    if (result.error) log('    error: ' + result.error);
    if (attempt <= RETRIES) {
      log('  retrying once with a fresh browser profile');
      await sleep(500);
    }
  }
  const final = attempts[attempts.length - 1];
  const record = {
    ...final,
    attempts: attempts.map((attempt) => ({
      attempt: attempt.attempt,
      status: attempt.status,
      durationMs: attempt.durationMs,
      assertions: attempt.assertions,
      error: attempt.error
    })),
    retried: attempts.length > 1
  };
  const file = path.join(OUT, id + '.json');
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
  record.reportPath = path.relative(ROOT, file).split(path.sep).join('/');
  record.reportSha256 = sha256File(file);
  return record;
}

// ------------------------------------------------------------ main

async function main() {
  const selected = selectScenarios();
  log('Blur Web E2E harness  ' + runId);
  log('browser:  ' + EDGE);
  log('scenarios: ' + selected.join(', '));
  checkPrerequisites(selected);

  const { expected, anchors, drift } = loadAnchors();
  if (drift.length) {
    log('anchor drift vs probes/e2e/expected.json (current built artifacts win):');
    for (const item of drift) log('  ' + JSON.stringify(item));
  }

  const ports = [PORT, ROOM_PORT];
  if (!BASE) {
    for (const port of ports) {
      if (port < 8820 || port > 8829) {
        die('harness ports must stay inside 8820-8829 (got ' + port + '); the user 8801/8811 servers are never touched', 3);
      }
    }
    if (await isPortOpen(PORT)) die('port ' + PORT + ' is already in use', 3);
    if (selected.some((id) => MP_SCENARIOS.has(id)) && !ROOM_URL && await isPortOpen(ROOM_PORT)) {
      log('room port ' + ROOM_PORT + ' is already in use; attaching to it (no stats)');
    }
  }

  let servers;
  try {
    servers = await startServers(selected);
  } catch (error) {
    die(error.message, 3);
  }
  const shared = { anchors, expected, servers, runStartedAt: Date.now() };

  const cleanup = async () => {
    try { await servers.server?.close(); } catch { /* already closed */ }
    try { await servers.roomServer?.close(); } catch { /* already closed */ }
  };
  process.once('SIGINT', () => { log('interrupted'); cleanup().finally(() => process.exit(130)); });

  const results = [];
  let fatal = null;
  try {
    for (const id of selected) {
      results.push(await runScenario(id, shared));
    }
  } catch (error) {
    fatal = error;
    log('FATAL: ' + error.message);
  } finally {
    await cleanup();
  }

  const passed = results.filter((result) => result.status === 'passed');
  const failed = results.filter((result) => result.status !== 'passed');
  const assertions = results.reduce((total, result) => total + result.assertions.total, 0);
  const assertionPasses = results.reduce((total, result) => total + result.assertions.passed, 0);
  const durationMs = Date.now() - shared.runStartedAt;
  let gitHead = null;
  try {
    gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch { /* not a git checkout */ }

  const report = {
    kind: 'blur-web.e2e',
    version: 1,
    runId,
    generatedAt: new Date().toISOString(),
    durationMs,
    branch: gitHead,
    node: process.version,
    browser: { executable: EDGE },
    ports: BASE ? { base: BASE, roomUrl: servers.roomUrl } : { game: PORT, room: ROOM_PORT },
    scenarios: results.map((result) => ({
      id: result.id,
      status: result.status,
      group: result.group,
      durationMs: result.durationMs,
      retried: result.retried,
      attempts: result.attempts,
      assertions: result.assertions,
      console: result.console.map((page) => ({
        label: page.label,
        total: page.total,
        errors: page.errors,
        warnings: page.warnings
      })),
      screenshots: result.screenshots,
      steps: result.steps,
      evidence: result.evidence,
      error: result.error,
      reportPath: result.reportPath,
      reportSha256: result.reportSha256
    })),
    totals: {
      scenarios: results.length,
      passed: passed.length,
      failed: failed.length,
      assertions,
      assertionPasses,
      assertionFailures: assertions - assertionPasses,
      screenshots: results.reduce((total, result) => total + result.screenshots.length, 0),
      durationMs
    },
    anchors: {
      source: 'probes/e2e/expected.json + built layout hashes',
      drift,
      sprint: { slug: anchors.sprint.slug, timeSeconds: anchors.sprint.timeSeconds, tick: anchors.sprint.tick },
      lap: { slug: anchors.lap.slug, timeSeconds: anchors.lap.timeSeconds, tick: anchors.lap.tick },
      layouts: anchors.layouts
    },
    prerequisitesOk: true,
    exitCode: fatal ? 3 : failed.length ? 1 : 0,
    fatal: fatal?.message ?? null,
    log: path.relative(ROOT, logFile).split(path.sep).join('/')
  };
  const reportFile = path.join(OUT, 'report.json');
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8');

  log('');
  log('────────────────────────────────────────────────────────────');
  for (const result of results) {
    log((result.status === 'passed' ? 'PASS ' : 'FAIL ') + result.id.padEnd(14) +
      String(result.assertions.passed + '/' + result.assertions.total).padStart(9) + ' assertions  ' +
      (result.durationMs / 1000).toFixed(1).padStart(7) + ' s  ' +
      String(result.screenshots.length).padStart(2) + ' shots' +
      (result.retried ? '  (retry used)' : ''));
  }
  log('────────────────────────────────────────────────────────────');
  log('total: ' + passed.length + '/' + results.length + ' scenarios · ' +
    assertionPasses + '/' + assertions + ' assertions · ' +
    (durationMs / 1000).toFixed(1) + ' s');
  log('report: ' + path.relative(ROOT, reportFile).split(path.sep).join('/'));
  log('log:    ' + path.relative(ROOT, logFile).split(path.sep).join('/'));
  log('screens: ' + path.relative(ROOT, SCREENS).split(path.sep).join('/'));
  if (fatal) process.exit(3);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  log('FATAL: ' + (error?.stack ?? error?.message ?? String(error)));
  process.exit(3);
});



