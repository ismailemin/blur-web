/**
 * HUD UI unit suite. Pure Node, no browser, no dependencies.
 *
 *   node probes/hud-ui/tests/hud-dom.test.mjs
 *
 * Writes a machine-readable report to `_work/hud-ui/hud-dom-report.json`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDocument } from './dom-shim.mjs';
import {
  createHud,
  layoutFor,
  formatRaceTime,
  formatLapTime,
  formatDelta,
  contrastRatio,
  validateMinimap1,
  minimapBounds,
  PALETTE,
  POWERUP_LABELS,
  HUD_VERSION
} from '../hud.mjs';
import {
  syntheticMinimap,
  stateSolo,
  stateMp,
  stateCountdown,
  stateWrecked,
  stateFinish,
  stateMissing,
  stateWithNaN
} from '../fixtures.mjs';

let pass = 0;
const failures = [];

function check(condition, message) {
  if (condition) pass += 1;
  else failures.push(message);
}

function eq(actual, expected, message) {
  const ok = Object.is(actual, expected);
  check(ok, message + ' — got ' + String(actual) + ', expected ' + String(expected));
}

function includes(text, needle, message) {
  check(typeof text === 'string' && text.includes(needle), message + ' — got ' + String(text));
}

function group(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(name + ' threw: ' + (error && error.stack ? error.stack.split('\n')[0] : String(error)));
  }
}

function all(root) {
  return root.querySelectorAll();
}

function byClass(root, className) {
  return all(root).filter((node) => node.classList && node.classList.contains(className));
}

function byAttr(root, name, value) {
  return all(root).filter((node) => node.getAttribute && node.getAttribute(name) === value);
}

function makeHost(doc) {
  const host = doc.createElement('div');
  host.id = 'hud-host';
  doc.body.appendChild(host);
  return host;
}

// ---------------------------------------------------------------------------
group('module surface', () => {
  const doc = createDocument();
  const host = makeHost(doc);
  let threw = null;
  try { createHud(null); } catch (error) { threw = error; }
  check(threw instanceof TypeError, 'createHud(null) throws TypeError');

  const hud = createHud(host, { viewport: { width: 1920, height: 1080 }, dpr: 1, now: () => 0 });
  eq(hud.version, HUD_VERSION, 'version exported on the instance');
  eq(typeof hud.update, 'function', 'update is a function');
  eq(typeof hud.setEvent, 'function', 'setEvent is a function');
  eq(typeof hud.setMinimap, 'function', 'setMinimap is a function');
  eq(typeof hud.resize, 'function', 'resize is a function');
  eq(typeof hud.setScale, 'function', 'setScale is a function');
  eq(typeof hud.destroy, 'function', 'destroy is a function');
  eq(typeof hud.readFields, 'function', 'readFields is a function');
  check(host.__hudUi === hud, 'host exposes the active HUD');
  check(hud.element.parentNode === host, 'root element is mounted');
  eq(hud.element.getAttribute('data-hud'), 'hud-ui', 'root data-hud marker');
  eq(hud.element.getAttribute('data-art'), 'project', 'root is labelled as project art');

  let duplicate = null;
  try { createHud(host, {}); } catch (error) { duplicate = error; }
  check(duplicate instanceof Error, 'second createHud on the same host throws');
  hud.destroy();
  check(hud.element.parentNode === null, 'destroy removes the root');
  eq(host.__hudUi, undefined, 'destroy clears the host marker');
  eq(hud.update(stateSolo()), false, 'update is a no-op after destroy');
  eq(hud.destroy(), false, 'double destroy returns false');
});

// ---------------------------------------------------------------------------
group('element coverage and art labels', () => {
  const doc = createDocument();
  const host = makeHost(doc);
  const hud = createHud(host, { viewport: { width: 1920, height: 1080 }, dpr: 1, now: () => 0 });
  hud.update(stateMp());

  const required = [
    'countdown', 'banner', 'warning', 'position', 'position-total', 'lap', 'lap-total',
    'race-time', 'last-lap', 'best-lap', 'delta', 'connection', 'latency',
    'powerup-type', 'powerup-detail', 'health-text', 'shield-text', 'boost-text',
    'speed-kmh', 'speed-mph', 'gear', 'rpm', 'minimap-note'
  ];
  for (const name of required) {
    check(host.field(name) !== null, 'data-field exists: ' + name);
  }

  const elements = all(hud.element).filter((node) => node.getAttribute('data-element'));
  check(elements.length >= 15, 'at least 15 labelled elements');
  let unlabelled = 0;
  for (const node of elements) {
    if (node.getAttribute('data-element') === 'live') continue;
    if (node.getAttribute('data-art') !== 'project') unlabelled += 1;
  }
  eq(unlabelled, 0, 'every visible element carries data-art="project"');
  eq(byAttr(hud.element, 'data-element', 'art-note')[0].hidden, false, 'art note is visible');
  includes(byAttr(hud.element, 'data-element', 'art-note')[0].textContent, 'retail HUD art not applied', 'art note states the limit');
  hud.destroy();
});

// ---------------------------------------------------------------------------
group('speed, gear, rpm', () => {
  const doc = createDocument();
  const host = makeHost(doc);
  const hud = createHud(host, { viewport: { width: 1920, height: 1080 }, dpr: 1, now: () => 0 });
  const state = stateSolo();
  hud.update(state);

  eq(host.field('speed-kmh').textContent, '148', '41.2 m/s renders 148 km/h');
  eq(host.field('speed-mph').textContent, '92', '41.2 m/s renders 92 mph');
  eq(host.field('gear').textContent, '4', 'gear 4 renders 4');
  eq(host.field('rpm').textContent, '6100 rpm', 'rpm renders with unit');

  state.local.speedMps = 0;
  hud.update(state);
  eq(host.field('speed-kmh').textContent, '0', 'zero speed renders 0');
  eq(host.field('speed-mph').textContent, '0', 'zero speed renders 0 mph');

  state.local.speedMps = -5;
  hud.update(state);
  eq(host.field('speed-kmh').textContent, '0', 'negative speed is clamped');
  eq(host.field('speed-mph').textContent, '0', 'negative mph is clamped');

  state.local.speedMps = null;
  state.local.gear = null;
  state.local.rpm = null;
  hud.update(state);
  eq(host.field('speed-kmh').textContent, '—', 'missing speed is typed');
  eq(host.field('speed-kmh').getAttribute('data-missing'), '1', 'missing speed is marked');
  eq(host.field('speed-mph').textContent, '—', 'missing mph is typed');
  eq(host.field('gear').textContent, '—', 'missing gear is typed');
  eq(host.field('rpm').textContent, '— rpm', 'missing rpm is typed');

  state.local.gear = 0;
  hud.update(state);
  eq(host.field('gear').textContent, 'N', 'gear 0 is neutral');
  state.local.gear = -1;
  hud.update(state);
  eq(host.field('gear').textContent, 'R', 'negative gear is reverse');
  hud.destroy();
});

// ---------------------------------------------------------------------------
group('position, lap, timers, delta', () => {
  const doc = createDocument();
  const host = makeHost(doc);
  const hud = createHud(host, { viewport: { width: 1920, height: 1080 }, dpr: 1, now: () => 0 });
  const state = stateMp();
  hud.update(state);

  eq(host.field('position').textContent, 'P2', 'live position renders P2');
  eq(host.field('position-total').textContent, '/8', 'position total renders /8');
  eq(host.field('lap').textContent, '2', 'lap renders 2');
  eq(host.field('lap-total').textContent, '/3', 'lap total renders /3');
  eq(host.field('race-time').textContent, '1:26.412', 'race timer renders m:ss.mmm');
  eq(host.field('last-lap').textContent, '28.551', 'last lap renders ss.mmm');
  eq(host.field('best-lap').textContent, '28.400', 'best lap renders ss.mmm');
  eq(host.field('delta').textContent, '▼ 0.15 behind', 'positive delta reads behind');
  eq(host.field('delta').getAttribute('data-sign'), 'behind', 'delta sign attribute');

  state.local.deltaSeconds = -0.32;
  hud.update(state);
  eq(host.field('delta').textContent, '▲ 0.32 ahead', 'negative delta reads ahead');
  eq(host.field('delta').getAttribute('data-sign'), 'ahead', 'delta ahead attribute');

  state.local.deltaSeconds = 0;
  hud.update(state);
  eq(host.field('delta').textContent, 'level', 'zero delta is level');

  state.local.lastLapSeconds = null;
  state.local.bestLapSeconds = null;
  state.local.deltaSeconds = null;
  state.local.position = null;
  state.local.lap = null;
  hud.update(state);
  eq(host.field('last-lap').textContent, '—', 'missing last lap is typed');
  eq(host.field('best-lap').textContent, '—', 'missing best lap is typed');
  eq(host.field('delta').textContent, '—', 'missing delta is typed');
  eq(host.field('position').textContent, '—', 'missing position is typed');
  eq(host.field('lap').textContent, '—', 'missing lap is typed');

  state.timing.raceSeconds = 0;
  hud.update(state);
  eq(host.field('race-time').textContent, '0:00.000', 'zero race timer');
  state.timing.raceSeconds = 61.5;
  hud.update(state);
  eq(host.field('race-time').textContent, '1:01.500', 'over a minute race timer');
  hud.destroy();
});

// ---------------------------------------------------------------------------
group('connection and latency', () => {
  const doc = createDocument();
  const host = makeHost(doc);
  const hud = createHud(host, { viewport: { width: 1920, height: 1080 }, dpr: 1, now: () => 0 });
  const state = stateMp();
  hud.update(state);
  eq(host.field('connection').textContent, 'ONLINE', 'connected renders ONLINE');
  eq(host.field('latency').textContent, '34 ms', 'latency renders ms');
  eq(byAttr(hud.element, 'data-element', 'connection')[0].getAttribute('data-state'), 'connected', 'connection state attribute');

  state.session.status = 'reconnecting';
  state.session.latencyMs = null;
  hud.update(state);
  eq(host.field('connection').textContent, 'RECONNECTING', 'reconnecting label');
  eq(host.field('latency').textContent, '— ms', 'missing latency is typed');

  state.session.status = 'offline';
  hud.update(state);
  eq(host.field('connection').textContent, 'OFFLINE', 'offline label');
  eq(host.field('connection').getAttribute('data-missing'), null, 'known status is not marked missing');
  hud.destroy();
});

// ---------------------------------------------------------------------------
group('power-up slot and icon fallback', () => {
  const doc = createDocument();
  const host = makeHost(doc);
  const hud = createHud(host, { viewport: { width: 1920, height: 1080 }, dpr: 1, now: () => 0 });
  const state = stateMp();
  hud.update(state);

  eq(host.field('powerup-type').textContent, 'Bomb', 'power-up type label');
  eq(host.field('powerup-detail').textContent, '2 charges', 'charge count');
  eq(byAttr(hud.element, 'data-element', 'powerup')[0].getAttribute('data-kind'), 'mine', 'Bomb maps to mine kind');
  const glyph = byClass(hud.element, 'hud-powerup-glyph')[0];
  eq(glyph.textContent, 'M', 'Bomb fallback glyph is M');

  state.local.powerup = { type: 'Shield', charges: 1, secondsLeft: 6, iconUrl: null };
  hud.update(state);
  eq(host.field('powerup-type').textContent, 'Shield', 'Shield label');
  eq(host.field('powerup-detail').textContent, '1 charge · 6.00 s', 'single charge and timer');
  eq(glyph.textContent, 'S', 'Shield fallback glyph is S');
  eq(byAttr(hud.element, 'data-element', 'powerup')[0].getAttribute('data-kind'), 'shield', 'Shield kind');

  state.local.powerup = { type: 'Repair', charges: 2, secondsLeft: null, iconUrl: 'data:image/png;base64,AA' };
  hud.update(state);
  eq(host.field('powerup-type').textContent, 'Repair', 'Repair label');
  eq(glyph.textContent, 'R', 'Repair fallback glyph is R');
  const image = byClass(hud.element, 'hud-powerup-image')[0];
  eq(image.getAttribute('src'), 'data:image/png;base64,AA', 'caller icon URL applied');
  eq(image.hidden, false, 'caller icon image shown');
  const iconBox = byClass(hud.element, 'hud-powerup-icon')[0];
  eq(iconBox.getAttribute('data-icon'), 'image', 'icon box reports image mode');

  image.dispatch('error');
  eq(image.hidden, true, 'failed icon hides the image');
  eq(glyph.hidden, false, 'failed icon restores the glyph');
  eq(iconBox.getAttribute('data-icon'), 'fallback', 'failed icon reports fallback');
  eq(glyph.textContent, 'R', 'failed icon keeps the type glyph');

  state.local.powerup = { type: null, charges: null, secondsLeft: null };
  hud.update(state);
  eq(host.field('powerup-type').textContent, 'empty slot', 'empty slot label');
  eq(host.field('powerup-detail').textContent, 'no power-up', 'empty slot detail');
  eq(glyph.textContent, '·', 'empty slot glyph');
  eq(byAttr(hud.element, 'data-element', 'powerup')[0].getAttribute('data-kind'), 'empty', 'empty kind');
  hud.destroy();
});

// ---------------------------------------------------------------------------
group('health, shield and boost bars', () => {
  const doc = createDocument();
  const host = makeHost(doc);
  const hud = createHud(host, { viewport: { width: 1920, height: 1080 }, dpr: 1, now: () => 0 });
  const state = stateMp();
  hud.update(state);

  const healthBar = byAttr(hud.element, 'data-bar', 'health')[0];
  const shieldBar = byAttr(hud.element, 'data-bar', 'shield')[0];
  const boostBar = byAttr(hud.element, 'data-bar', 'boost')[0];

  eq(host.field('health-text').textContent, '78 / 100 HP', 'health text');
  eq(healthBar.style.width, '78%', 'health bar width');
  eq(healthBar.getAttribute('aria-valuenow'), '78', 'health aria value');
  eq(healthBar.getAttribute('role'), 'progressbar', 'health bar role');

  eq(host.field('shield-text').textContent, '50 / 50 · 4.25 s', 'shield text and timer');
  eq(shieldBar.style.width, '100%', 'shield bar full');
  eq(boostBar.style.width, '62%', 'boost bar percentage');
  eq(host.field('boost-text').textContent, 'NITRO · 0.80 s', 'boost text');

  state.local.health.current = 20;
  hud.update(state);
  eq(healthBar.style.width, '20%', 'low health width');
  eq(byAttr(hud.element, 'data-element', 'health')[0].getAttribute('data-flag'), 'low-health', 'low health flag');

  state.local.shield = { current: null, max: null, secondsLeft: null };
  state.local.boost = { kind: null, remainingSeconds: null, capacitySeconds: null };
  hud.update(state);
  eq(host.field('shield-text').textContent, 'no shield', 'missing shield text');
  eq(shieldBar.style.width, '0%', 'missing shield width');
  eq(host.field('boost-text').textContent, 'IDLE', 'idle boost text');
  eq(boostBar.style.width, '0%', 'idle boost width');

  state.local.health = { current: null, max: null };
  hud.update(state);
  eq(host.field('health-text').textContent, '— HP', 'missing health text');
  eq(host.field('health-text').getAttribute('data-missing'), '1', 'missing health marked');
  hud.destroy();
});

// ---------------------------------------------------------------------------
group('countdown, banner and warnings', () => {
  const doc = createDocument();
  const host = makeHost(doc);
  const hud = createHud(host, { viewport: { width: 1920, height: 1080 }, dpr: 1, now: () => 0 });

  hud.update(stateCountdown());
  eq(host.field('countdown').hidden, false, 'countdown visible');
  eq(host.field('countdown').textContent, '3', 'countdown label 3');
  eq(host.field('countdown').getAttribute('data-kind'), 'count', 'countdown kind');
  eq(host.field('countdown').getAttribute('aria-live'), 'assertive', 'countdown is assertive');

  const go = stateCountdown();
  go.timing.countdownLabel = 'GO';
  hud.update(go);
  eq(host.field('countdown').textContent, 'GO', 'GO label');
  eq(host.field('countdown').getAttribute('data-kind'), 'go', 'GO kind');

  const racing = stateCountdown();
  racing.timing.countdownLabel = null;
  hud.update(racing);
  eq(host.field('countdown').hidden, true, 'countdown hidden while racing');

  hud.update(stateWrecked());
  eq(host.field('banner').hidden, false, 'wreck banner visible');
  eq(host.field('banner').textContent, 'WRECKED · respawn in 1.0 s', 'wreck banner text');
  eq(host.field('banner').getAttribute('data-kind'), 'danger', 'wreck banner kind');
  eq(host.field('warning').hidden, false, 'warning visible');
  eq(host.field('warning').textContent, 'WRECKED', 'warning text');
  eq(host.field('warning').getAttribute('data-level'), 'danger', 'warning level');
  eq(host.field('warning').getAttribute('role'), 'alert', 'warning role');

  hud.update(stateSolo());
  eq(host.field('banner').hidden, true, 'banner hidden without a banner');
  eq(host.field('warning').hidden, true, 'warning hidden without a warning');
  hud.destroy();
});

// ---------------------------------------------------------------------------
group('results table', () => {
  const doc = createDocument();
  const host = makeHost(doc);
  const hud = createHud(host, { viewport: { width: 1920, height: 1080 }, dpr: 1, now: () => 0 });
  hud.update(stateFinish());

  const results = byAttr(hud.element, 'data-element', 'results')[0];
  eq(results.hidden, false, 'results visible at finish');
  eq(results.getAttribute('role'), 'table', 'results table role');
  const rows = all(hud.element).filter((node) => node.classList.contains('hud-results-row') && node.getAttribute('data-kind'));
  eq(rows.length, 8, 'eight result rows');
  eq(rows[0].children[0].textContent, '1', 'winner position');
  eq(rows[0].children[1].textContent, 'Guest', 'winner name');
  eq(rows[0].children[2].textContent, '1:25.902', 'winner time');
  eq(rows[0].children[3].textContent, '28.101', 'winner best lap');
  eq(rows[1].getAttribute('data-kind'), 'host', 'host row kind');
  includes(rows[1].children[1].textContent, 'HOST', 'host tag');
  eq(rows[1].getAttribute('data-self'), '1', 'own row marked');
  eq(rows[2].getAttribute('data-kind'), 'ai', 'AI row kind');
  includes(rows[2].children[1].textContent, 'AI', 'AI tag');
  eq(rows[7].children[2].textContent, 'DNF', 'DNF row time');
  eq(rows[7].children[2].getAttribute('data-status'), 'dnf', 'DNF row status');
  eq(rows[7].children[3].textContent, '31.200', 'DNF row keeps its best lap');

  const rowCount = rows.length;
  hud.update(stateFinish());
  const rowsAgain = all(hud.element).filter((node) => node.classList.contains('hud-results-row') && node.getAttribute('data-kind'));
  eq(rowsAgain.length, rowCount, 'results rows are reused, not rebuilt');
  hud.destroy();
});

// ---------------------------------------------------------------------------
group('minimap: MINIMAP1 handling', () => {
  const doc = createDocument();
  const host = makeHost(doc);
  const map = syntheticMinimap();
  const hud = createHud(host, { viewport: { width: 1920, height: 1080 }, dpr: 1, now: () => 0, minimap: map });
  hud.update(stateMp());

  includes(host.field('minimap-note').textContent, 'MINIMAP1', 'minimap note names the format');
  includes(host.field('minimap-note').textContent, 'preview-synthetic-loop', 'minimap note names the map');
  eq(host.field('minimap-note').getAttribute('data-status'), 'ok', 'minimap data accepted');
  check(hud.metrics().minimapDraws > 0, 'minimap drew at least once');
  const canvas = byAttr(hud.element, 'data-canvas', 'minimap')[0];
  check(canvas.width > 0 && canvas.height > 0, 'minimap canvas has a backing store');
  check(canvas.getContext('2d').count('drawImage') > 0, 'minimap blits its static layer');

  check(hud.setMinimap({ version: 'MINIMAP0', points: [[0, 0], [1, 1]] }) === false, 'wrong version rejected');
  eq(host.field('minimap-note').getAttribute('data-status'), 'unsupported', 'bad version marked unsupported');
  includes(host.field('minimap-note').textContent, 'version', 'bad version reason shown');

  check(hud.setMinimap({ version: 'MINIMAP1', points: [[0, 0]] }) === false, 'single point rejected');
  includes(host.field('minimap-note').textContent, 'points', 'short polyline reason shown');

  check(hud.setMinimap({ version: 'MINIMAP1', points: [[0, 0], [0, 0]] }) === false, 'degenerate bounds rejected');
  includes(host.field('minimap-note').textContent, 'degenerate', 'degenerate bounds reason shown');

  check(hud.setMinimap(null) === false, 'null minimap rejected');
  includes(host.field('minimap-note').textContent, 'missing', 'missing minimap reason shown');

  check(hud.setMinimap(map) === true, 'valid minimap restored');
  eq(host.field('minimap-note').getAttribute('data-status'), 'ok', 'restored status');

  eq(validateMinimap1(map).ok, true, 'validateMinimap1 accepts the fixture');
  eq(validateMinimap1(null).reason, 'missing', 'validateMinimap1 rejects null');
  eq(validateMinimap1({ version: 'X', points: [[0, 0], [1, 1]] }).reason, 'version', 'validateMinimap1 rejects version');
  const bounds = minimapBounds(map);
  check(bounds && bounds.maxX > bounds.minX && bounds.maxZ > bounds.minZ, 'minimapBounds derives bounds');
  eq(minimapBounds({ version: 'MINIMAP1', points: [[0, 0], [0, 0]] }), null, 'minimapBounds rejects degenerate geometry');
  hud.destroy();
});

// ---------------------------------------------------------------------------
group('layout, scaling and safe areas', () => {
  const hd = layoutFor(1280, 720);
  eq(hd.compact, true, '720p is compact');
  eq(hd.safeX, 28, '720p safe x');
  eq(hd.safeY, 14, '720p safe y');
  eq(hd.tacho, 96, '720p tacho clamps to its floor');
  eq(hd.minimap, 92, '720p minimap clamps to its floor');
  eq(hd.font, 12, '720p font clamps to its floor');
  eq(hd.resultsWidth, 589, '720p results width');

  const fhd = layoutFor(1920, 1080);
  eq(fhd.compact, false, '1080p is not compact');
  eq(fhd.safeX, 42, '1080p safe x');
  eq(fhd.safeY, 22, '1080p safe y');
  eq(fhd.tacho, 170, '1080p tacho');
  eq(fhd.minimap, 158, '1080p minimap');
  eq(fhd.font, 16, '1080p font');
  eq(fhd.resultsWidth, 880, '1080p results width');
  eq(fhd.ultrawide, false, '16:9 is not ultrawide');

  const qhd = layoutFor(2560, 1440);
  eq(qhd.safeX, 56, '1440p safe x');
  eq(qhd.safeY, 29, '1440p safe y');
  eq(qhd.tacho, 227, '1440p tacho');
  eq(qhd.font, 21, '1440p font');
  eq(qhd.compact, false, '1440p is not compact');

  const uw = layoutFor(3440, 1440);
  eq(uw.ultrawide, true, '21:9 is ultrawide');
  eq(uw.wideOffset, 40, 'ultrawide offset');
  eq(uw.safeX, 56, 'ultrawide safe x is capped');

  const scaled = layoutFor(1920, 1080, 1.5);
  eq(scaled.scale, 1.5, 'scale factor stored');
  eq(scaled.tacho, 255, 'scale factor grows the tacho');
  eq(scaled.font, 24, 'scale factor grows the font');
  check(scaled.tacho > fhd.tacho && scaled.font > fhd.font, 'scale is monotonic');
  eq(layoutFor(1920, 1080, 9).scale, 2, 'scale clamps high');
  eq(layoutFor(1920, 1080, 0.1).scale, 0.75, 'scale clamps low');
  eq(layoutFor(1920, 1080, 1, { dpr: 9 }).dpr, 3, 'dpr clamps high');
  eq(layoutFor(1920, 1080, 1, { dpr: 0.5 }).dpr, 1, 'dpr clamps low');

  const doc = createDocument();
  const host = makeHost(doc);
  const hud = createHud(host, { viewport: { width: 1920, height: 1080 }, dpr: 1, now: () => 0 });
  const resized = hud.resize(1280, 720);
  eq(resized.compact, true, 'resize recomputes the layout');
  eq(hud.element.getAttribute('data-compact'), '1', 'compact flag on the root');
  eq(hud.element.style.getPropertyValue('--hud-safe-x'), '28px', 'safe area CSS variable');
  eq(hud.element.style.getPropertyValue('--hud-safe-y'), '14px', 'safe y CSS variable');
  eq(byAttr(hud.element, 'data-canvas', 'tacho')[0].style.width, '96px', 'tacho canvas resized');
  eq(byAttr(hud.element, 'data-canvas', 'minimap')[0].style.width, '92px', 'minimap canvas resized');

  const scaledHud = hud.setScale(1.5);
  eq(scaledHud.scale, 1.5, 'setScale returns the layout');
  eq(hud.element.getAttribute('data-scale'), '1.5', 'scale attribute');
  eq(byAttr(hud.element, 'data-canvas', 'tacho')[0].style.width, '134px', 'scaled tacho canvas');

  const uwHud = createHud(makeHost(doc), { viewport: { width: 3440, height: 1440 }, dpr: 1, now: () => 0 });
  eq(uwHud.element.getAttribute('data-ultrawide'), '1', 'ultrawide flag');
  uwHud.destroy();
  hud.destroy();
});

// ---------------------------------------------------------------------------
group('units and reduced motion', () => {
  const doc = createDocument();
  const metric = createHud(makeHost(doc), { viewport: { width: 1920, height: 1080 }, units: 'metric', now: () => 0 });
  metric.update(stateSolo());
  eq(byAttr(metric.element, 'data-field', 'speed-mph')[0].hidden, true, 'metric mode hides mph');
  eq(byAttr(metric.element, 'data-field', 'speed-kmh')[0].hidden, false, 'metric mode shows km/h');
  metric.destroy();

  const imperial = createHud(makeHost(doc), { viewport: { width: 1920, height: 1080 }, units: 'imperial', now: () => 0 });
  imperial.update(stateSolo());
  eq(byAttr(imperial.element, 'data-field', 'speed-kmh')[0].hidden, true, 'imperial mode hides km/h');
  eq(byAttr(imperial.element, 'data-field', 'speed-mph')[0].hidden, false, 'imperial mode shows mph');
  imperial.destroy();

  const reduced = createHud(makeHost(doc), { viewport: { width: 1920, height: 1080 }, reducedMotion: true, now: () => 0 });
  eq(reduced.element.getAttribute('data-reduced-motion'), '1', 'reduced motion flag');
  reduced.destroy();

  const noBadge = createHud(makeHost(doc), { viewport: { width: 1920, height: 1080 }, artBadge: false, now: () => 0 });
  eq(byAttr(noBadge.element, 'data-element', 'art-note')[0].hidden, true, 'art badge can be hidden');
  noBadge.destroy();
});

// ---------------------------------------------------------------------------
group('accessibility', () => {
  const doc = createDocument();
  const host = makeHost(doc);
  const hud = createHud(host, { viewport: { width: 1920, height: 1080 }, dpr: 1, now: () => 0 });
  hud.update(stateMp());

  eq(hud.element.getAttribute('role'), 'group', 'root role');
  includes(hud.element.getAttribute('aria-label'), 'display only', 'root label states display only');
  eq(host.field('banner').getAttribute('role'), 'status', 'banner role');
  eq(host.field('warning').getAttribute('role'), 'alert', 'warning role');
  eq(host.field('live').getAttribute('aria-live'), 'polite', 'live region role');
  eq(host.field('countdown').getAttribute('aria-live'), 'assertive', 'countdown live role');
  eq(byAttr(hud.element, 'data-element', 'results')[0].getAttribute('aria-label'), 'race results', 'results label');

  const progressbars = byAttr(hud.element, 'role', 'progressbar');
  eq(progressbars.length, 3, 'three progress bars');
  for (const bar of progressbars) {
    eq(bar.getAttribute('aria-valuemin'), '0', 'bar aria min');
    eq(bar.getAttribute('aria-valuemax'), '100', 'bar aria max');
    check(bar.getAttribute('aria-valuenow') !== null, 'bar aria value present');
  }

  check(hud.element.getAttribute('tabindex') === null, 'root is not focusable');
  const interactive = all(hud.element).filter((node) => ['BUTTON', 'INPUT', 'SELECT', 'A'].includes(node.tagName));
  eq(interactive.length, 0, 'no interactive elements in the HUD');

  check(contrastRatio(PALETTE.ink, PALETTE.panel) >= 7, 'ink on panel contrast >= 7');
  check(contrastRatio(PALETTE.dim, PALETTE.panel) >= 4.5, 'dim on panel contrast >= 4.5');
  check(contrastRatio(PALETTE.cyan, PALETTE.panel) >= 4.5, 'cyan on panel contrast >= 4.5');
  check(contrastRatio(PALETTE.amber, PALETTE.panel) >= 4.5, 'amber on panel contrast >= 4.5');
  check(contrastRatio(PALETTE.danger, PALETTE.panel) >= 4.5, 'danger on panel contrast >= 4.5');
  check(contrastRatio(PALETTE.magenta, PALETTE.panel) >= 4.5, 'magenta on panel contrast >= 4.5');
  eq(contrastRatio('#ffffff', '#000000'), 21, 'white on black is 21:1');
  eq(contrastRatio('not-a-colour', '#000000'), null, 'invalid colour has no ratio');
  check(new Set([PALETTE.cyan, PALETTE.amber, PALETTE.magenta, PALETTE.danger]).size === 4, 'key colours are distinct');
  hud.destroy();
});

// ---------------------------------------------------------------------------
group('typed missing values and NaN guard', () => {
  const doc = createDocument();
  hostCheck: {
    const host = makeHost(doc);
    const hud = createHud(host, { viewport: { width: 1920, height: 1080 }, dpr: 1, now: () => 0 });
    hud.update(stateMissing());

    const numeric = ['speed-kmh', 'speed-mph', 'gear', 'rpm', 'position', 'lap', 'race-time', 'last-lap', 'best-lap', 'delta', 'health-text'];
    for (const name of numeric) {
      const text = host.field(name).textContent;
      check(!/NaN|Infinity|undefined|null/.test(text), 'missing ' + name + ' has no raw sentinel: ' + text);
    }
    eq(host.field('speed-kmh').textContent, '—', 'missing speed placeholder');
    eq(host.field('gear').textContent, '—', 'missing gear placeholder');
    eq(host.field('lap').textContent, '—', 'missing lap placeholder');
    eq(host.field('health-text').getAttribute('data-missing'), '1', 'missing health marked');
    eq(host.field('last-lap').getAttribute('data-missing'), '1', 'missing last lap marked');
    eq(host.field('shield-text').textContent, 'no shield', 'missing shield has a documented fallback');
    eq(host.field('boost-text').textContent, 'IDLE', 'missing boost has a documented fallback');
    eq(host.field('powerup-type').textContent, 'empty slot', 'missing power-up has a documented fallback');
    eq(host.field('minimap-note').getAttribute('data-status'), 'unsupported', 'missing minimap is labelled');
    hud.destroy();
  }

  const host = makeHost(doc);
  const hud = createHud(host, { viewport: { width: 1920, height: 1080 }, dpr: 1, now: () => 0 });
  hud.update(stateWithNaN());
  const fields = hud.readFields();
  let bad = 0;
  for (const key in fields) {
    const value = fields[key];
    if (value === null) continue;
    if (/NaN|Infinity|undefined/.test(value)) bad += 1;
  }
  eq(bad, 0, 'no NaN/Infinity text reaches the DOM');
  eq(host.field('speed-kmh').textContent, '—', 'NaN speed is typed missing');
  eq(host.field('latency').textContent, '— ms', 'NaN latency is typed missing');
  eq(host.field('shield-text').textContent, 'no shield', 'Infinity shield falls back');
  hud.destroy();
});

// ---------------------------------------------------------------------------
group('update diffing and batching', () => {
  const doc = createDocument();
  const host = makeHost(doc);
  const hud = createHud(host, { viewport: { width: 1920, height: 1080 }, dpr: 1, now: () => 0, minimap: syntheticMinimap() });
  const state = stateMp();
  eq(hud.update(state), true, 'update returns true');

  const snap = () => ({
    text: hud.metrics().textWrites,
    attr: hud.metrics().attrWrites,
    canvas: hud.metrics().canvasDraws,
    mini: hud.metrics().minimapDraws,
    tacho: hud.metrics().tachoDraws
  });

  hud.update(state);
  const quiet = snap();
  hud.update(state);
  const afterQuiet = snap();
  eq(afterQuiet.text, quiet.text, 'identical update writes no text');
  eq(afterQuiet.attr, quiet.attr, 'identical update writes no attributes');
  eq(afterQuiet.canvas, quiet.canvas, 'identical update draws no canvas');
  eq(afterQuiet.mini, quiet.mini, 'identical update skips the minimap');
  eq(afterQuiet.tacho, quiet.tacho, 'identical update skips the tacho');

  state.local.speedMps = 55;
  hud.update(state);
  eq(snap().text - afterQuiet.text, 2, 'speed change writes exactly two text nodes');
  eq(snap().canvas - afterQuiet.canvas, 0, 'speed change needs no canvas draw');

  const afterSpeed = snap();
  state.local.rpm = 7200;
  hud.update(state);
  eq(snap().text - afterSpeed.text, 1, 'rpm change writes one text node');
  eq(snap().tacho - afterSpeed.tacho, 1, 'rpm change draws the tacho once');

  const afterRpm = snap();
  for (let i = 0; i < state.cars.length; i += 1) state.cars[i].x += 4;
  hud.update(state);
  eq(snap().mini - afterRpm.mini, 1, 'eight moving cars draw the minimap once');
  eq(snap().canvas - afterRpm.canvas, 1, 'one canvas draw for eight cars');
  eq(snap().text - afterRpm.text, 0, 'car moves write no text');

  eq(hud.metrics().updates > 0, true, 'update counter advanced');
  check(hud.metrics().lastUpdateMs >= 0, 'last update time recorded');
  hud.destroy();
});

// ---------------------------------------------------------------------------
group('events', () => {
  let clock = 0;
  const doc = createDocument();
  const host = makeHost(doc);
  const hud = createHud(host, { viewport: { width: 1920, height: 1080 }, dpr: 1, now: () => clock });

  eq(hud.setEvent(null), false, 'null event rejected');
  eq(hud.setEvent({ type: 'nope' }), false, 'unknown event rejected');

  eq(hud.setEvent({ type: 'countdown', label: '2', durationMs: 900 }), true, 'countdown event accepted');
  hud.update(stateSolo());
  eq(host.field('countdown').textContent, '2', 'event countdown label');
  eq(host.field('countdown').hidden, false, 'event countdown visible');
  clock = 1000;
  hud.update(stateSolo());
  eq(host.field('countdown').hidden, true, 'countdown event expires');

  hud.setEvent({ type: 'go', durationMs: 900 });
  hud.update(stateSolo());
  eq(host.field('countdown').textContent, 'GO', 'GO event');
  eq(host.field('countdown').getAttribute('data-kind'), 'go', 'GO event kind');
  clock = 2200;
  hud.update(stateSolo());
  eq(host.field('countdown').hidden, true, 'GO event expires');

  hud.setEvent({ type: 'lap-complete', lap: 2, lapSeconds: 28.551, bestLapSeconds: 28.4, durationMs: 2200 });
  hud.update(stateSolo());
  eq(host.field('banner').textContent, 'LAP 2 · 28.551 · best 28.400', 'lap banner text');
  eq(host.field('banner').getAttribute('data-kind'), 'lap', 'lap banner kind');

  hud.setEvent({ type: 'warning', level: 'warn', text: 'OFF COURSE', durationMs: 3000 });
  hud.update(stateSolo());
  eq(host.field('warning').textContent, 'OFF COURSE', 'warning event text');
  eq(host.field('warning').getAttribute('data-level'), 'warn', 'warning event level');
  clock = 5400;
  hud.update(stateSolo());
  eq(host.field('warning').hidden, true, 'warning event expires');

  hud.setEvent({ type: 'powerup-pickup', powerupType: 'Shield', durationMs: 1600 });
  hud.update(stateSolo());
  eq(host.field('banner').textContent, 'PICKED UP · Shield', 'power-up pickup banner');

  hud.setEvent({ type: 'hit', amount: 50, durationMs: 1200 });
  hud.update(stateSolo());
  eq(host.field('banner').textContent, 'HIT −50', 'hit banner');

  hud.setEvent({ type: 'wrecked', respawnSeconds: 1, durationMs: 0 });
  hud.update(stateSolo());
  eq(host.field('banner').textContent, 'WRECKED · respawn in 1.0 s', 'wreck event banner');

  hud.setEvent({ type: 'respawn', durationMs: 1200 });
  hud.update(stateSolo());
  eq(host.field('banner').textContent, 'RESPAWNED', 'respawn banner');

  hud.setEvent({ type: 'finish', results: stateFinish().results });
  hud.update(stateSolo());
  eq(byAttr(hud.element, 'data-element', 'results')[0].hidden, false, 'finish event shows results');
  eq(host.field('banner').textContent, 'FINISH', 'finish event banner');

  eq(hud.setEvent({ type: 'reset' }), true, 'reset accepted');
  hud.update(stateSolo());
  eq(byAttr(hud.element, 'data-element', 'results')[0].hidden, true, 'reset hides results');
  eq(host.field('banner').hidden, true, 'reset clears the banner');
  hud.destroy();
});

// ---------------------------------------------------------------------------
group('formatters', () => {
  eq(formatRaceTime(0), '0:00.000', 'formatRaceTime(0)');
  eq(formatRaceTime(61.5), '1:01.500', 'formatRaceTime(61.5)');
  eq(formatRaceTime(3599.999), '59:59.999', 'formatRaceTime long');
  eq(formatRaceTime(null), '—', 'formatRaceTime(null)');
  eq(formatRaceTime(-1), '—', 'formatRaceTime(-1)');
  eq(formatRaceTime(NaN), '—', 'formatRaceTime(NaN)');
  eq(formatLapTime(28.551), '28.551', 'formatLapTime short');
  eq(formatLapTime(5.05), '05.050', 'formatLapTime pads seconds');
  eq(formatLapTime(65), '1:05.000', 'formatLapTime over a minute');
  eq(formatLapTime(undefined), '—', 'formatLapTime(undefined)');
  eq(formatDelta(0).text, 'level', 'formatDelta level');
  eq(formatDelta(-0.32).text, '▲ 0.32 ahead', 'formatDelta ahead');
  eq(formatDelta(0.32).text, '▼ 0.32 behind', 'formatDelta behind');
  eq(formatDelta(0.0001).text, 'level', 'formatDelta tolerance');
  eq(formatDelta(null).text, '—', 'formatDelta missing');
  eq(formatDelta(null).sign, 'none', 'formatDelta missing sign');
  eq(POWERUP_LABELS.Bomb.glyph, 'M', 'Bomb glyph table');
  eq(POWERUP_LABELS.Nitrous.label, 'Nitro', 'Nitro label table');
});

// ---------------------------------------------------------------------------
const report = {
  suite: 'hud-ui-dom',
  node: process.version,
  assertions: pass + failures.length,
  passed: pass,
  failed: failures.length,
  failures,
  ok: failures.length === 0
};

try {
  const outDir = fileURLToPath(new URL('../../../_work/hud-ui/', import.meta.url));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(new URL('../../../_work/hud-ui/hud-dom-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
} catch (error) {
  // The report is evidence, not a test dependency.
}

console.log('HUD-UI DOM suite: ' + report.passed + ' passed, ' + report.failed + ' failed, ' + report.assertions + ' assertions');
if (!report.ok) {
  for (const failure of failures) console.error('FAIL: ' + failure);
  process.exitCode = 1;
}
