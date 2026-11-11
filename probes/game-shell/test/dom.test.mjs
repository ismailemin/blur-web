import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from '../shell.js';
import { createHost } from './dom-shim.mjs';
import { dataset } from './fixtures.mjs';

const data = dataset();

function mountShell(initial, extra = {}) {
  const { document, host } = createHost();
  const shell = mount(host, {
    cars: data.roster,
    maps: data.maps,
    classes: data.classes.classes,
    measurements: data.measurements.maps,
    initial,
    demo: true,
    loadingTimer: false,
    syncUrl: false,
    reducedMotion: true,
    now: () => 1000,
    ...extra
  });
  return { shell, host, document };
}

test('car grid renders every roster car with real fields and an explicit icon placeholder', () => {
  const { shell, host } = mountShell({ screen: 'car-select', mode: 'sprint', carSlug: 'corvette-zr1-stock' });
  const tiles = host.querySelectorAll('[data-car-slug]');
  assert.equal(tiles.length, 61);
  assert.equal(host.querySelectorAll('.gs-car-art-label').length, 61);
  assert.equal(host.querySelector('[data-grid="cars"]').dataset.gridColumns, '7');
  for (const car of data.roster.cars) {
    const tile = host.querySelector('[data-car-slug="' + car.slug + '"]');
    assert.ok(tile, car.slug + ' tile');
    const text = tile.textContent;
    assert.ok(text.includes(car.name), car.slug + ' name');
    assert.ok(text.includes(car.slug), car.slug + ' slug');
    assert.ok(text.includes('icon not decoded'), car.slug + ' placeholder');
    assert.ok(text.includes(data.classes.classes[car.slug]), car.slug + ' class');
    const mass = /(\d+(?:\.\d+)?)\s*kg/.exec(car.layout)[1];
    assert.ok(text.includes(mass + ' kg'), car.slug + ' mass');
    assert.ok(text.includes('6-speed') || text.includes('7-speed'), car.slug + ' gearbox');
  }
  assert.equal(host.querySelector('[data-focus="car-search"]').value, '');
  assert.match(host.querySelector('.gs-screen-head').textContent, /All 61 committed roster cars/);
  assert.match(host.querySelector('.gs-footer-meta').textContent, /61 cars\s+\/\s+17 maps/);
  shell.destroy();
});

test('search and filters update the tile count and restore input focus', () => {
  const { shell, host, document } = mountShell({ screen: 'car-select', mode: 'sprint', carSlug: 'corvette-zr1-stock' });
  const input = host.querySelector('[data-focus="car-search"]');
  input.focus();
  input.value = 'corvette';
  input.dispatchEvent({ type: 'input' });
  assert.equal(shell.getState().filters.query, 'corvette');
  assert.equal(host.querySelectorAll('[data-car-slug]').length, 4);
  assert.equal(document.activeElement?.dataset?.focus, 'car-search');
  shell.setCarFilter({ query: '', carClass: 'C' });
  assert.equal(host.querySelectorAll('[data-car-slug]').length, 14);
  shell.setCarFilter({ carClass: 'all', drivetrain: 'AWD' });
  assert.equal(host.querySelectorAll('[data-car-slug]').length, 15);
  shell.setCarFilter({ drivetrain: 'all', carClass: 'unclassified' });
  assert.equal(host.querySelectorAll('[data-car-slug]').length, 0);
  assert.match(host.querySelector('.gs-empty').textContent, /still has 61 cars/);
  shell.destroy();
});

test('mode and car navigation reaches map select and all fourteen maps are enabled for sprint', () => {
  const { shell, host } = mountShell({ screen: 'main-menu' });
  assert.equal(host.querySelectorAll('.gs-mode-card').length, 0);
  host.querySelector('[data-focus="play"]').click();
  assert.equal(shell.getState().screen, 'mode-select');
  assert.equal(host.querySelectorAll('.gs-mode-card').length, 5);
  host.querySelector('[data-focus="mode-sprint"]').click();
  assert.equal(shell.getState().screen, 'car-select');
  host.querySelector('[data-car-slug="audi-r8v10-stock"]').click();
  assert.equal(shell.getState().carSlug, 'audi-r8v10-stock');
  host.querySelector('[data-focus="car-next"]').click();
  assert.equal(shell.getState().screen, 'map-select');
  assert.equal(host.querySelectorAll('.gs-map-card').length, 17);
  assert.equal(host.querySelector('[data-grid="maps"]').dataset.gridColumns, '3');
  for (const id of ['river', 'amboy', 'gracia', 'longbeach', 'observatory', 'downtown', 'mharuna',
    'highrise', 'shutoko', 'oval', 'amboy-mp', 'dumbo', 'downtown-mp', 'sausalito', 'hackney',
    'russianhill', 'brighton']) {
    assert.equal(host.querySelector('[data-focus="map-' + id + '"]').disabled, false, id);
  }
  host.querySelector('[data-focus="map-amboy"]').click();
  assert.equal(shell.getState().mapId, 'amboy');
  assert.equal(host.querySelectorAll('.gs-disabled-reason').length, 0);
  shell.destroy();
});

test('lap mode enables River and Amboy and disables the twelve sprint-only maps with reasons', () => {
  const { shell, host } = mountShell({ screen: 'map-select', mode: 'lap', carSlug: 'corvette-zr1-stock', mapId: 'river' });
  assert.equal(host.querySelectorAll('.gs-map-card').length, 17);
  assert.equal(host.querySelector('[data-focus="map-river"]').disabled, false);
  assert.equal(host.querySelector('[data-focus="map-amboy"]').disabled, false);
  for (const id of ['gracia', 'longbeach', 'observatory', 'downtown', 'mharuna', 'highrise', 'shutoko', 'oval',
    'hackney', 'russianhill', 'brighton',
    'amboy-mp', 'dumbo', 'downtown-mp', 'sausalito']) {
    assert.equal(host.querySelector('[data-focus="map-' + id + '"]').disabled, true, id);
  }
  const reasons = host.querySelectorAll('.gs-disabled-reason');
  assert.equal(reasons.length, 15);
  assert.match(reasons[0].textContent, /Unavailable:/);
  assert.match(reasons[0].textContent, /lists courses \[310\]/);
  assert.match(reasons[0].textContent, /no 3-lap loop layout/);
  const action = host.querySelector('[data-focus="map-action"]');
  assert.equal(action.disabled, false);
  assert.match(action.textContent, /START RACE/);
  shell.destroy();
});

test('multiplayer lobby starts disabled with the exact participant reason', () => {
  const { shell, host } = mountShell({
    screen: 'lobby',
    mode: 'multiplayer',
    carSlug: 'corvette-zr1-stock',
    mapId: 'river',
    mp: { role: 'host', roomCode: 'KRP3Q', verified: true }
  });
  assert.equal(host.querySelector('[data-focus="start"]').disabled, true);
  assert.equal(host.querySelector('#gs-start-reason').textContent,
    'start needs a second player or at least one AI (host simulates the AI)');
  shell.setAi({ count: 1 });
  assert.equal(host.querySelector('#gs-start-reason').textContent,
    'start needs every connected player ready');
  assert.equal(host.querySelectorAll('[data-ai-row]').length, 1);
  shell.setReady(true);
  assert.equal(host.querySelector('[data-focus="start"]').disabled, false);
  assert.match(host.querySelector('#gs-start-reason').textContent, /All start conditions pass/);
  shell.destroy();
});

test('start fires once per accepted start, results render and rematch reuses the config', () => {
  let starts = 0;
  let results = 0;
  const { shell, host } = mountShell({
    screen: 'lobby',
    mode: 'multiplayer',
    carSlug: 'corvette-zr1-stock',
    mapId: 'river',
    mp: { role: 'host', roomCode: 'KRP3Q', verified: true }
  });
  shell.on('start', () => { starts += 1; });
  shell.on('results', () => { results += 1; });
  shell.setAi({ count: 1 });
  shell.setReady(true);
  host.querySelector('[data-focus="start"]').click();
  assert.equal(starts, 1);
  assert.equal(shell.getState().screen, 'loading');
  // A second start call is out of order and must not emit again.
  const again = shell.start();
  assert.equal(again.ok, false);
  assert.equal(starts, 1);
  assert.equal(shell.raceReady(), true);
  assert.equal(shell.getState().screen, 'race');
  assert.equal(shell.finish({
    positions: [
      { position: 1, name: 'You', car: 'corvette-zr1-stock', timeSeconds: 14.92, laps: 1 },
      { position: 2, name: 'AI 1', car: 'lotus-exige-cup260-stock', timeSeconds: 15.19, laps: 1, ai: true }
    ],
    mode: 'multiplayer',
    mapId: 'river',
    course: '310'
  }), true);
  assert.equal(results, 1);
  assert.equal(shell.getState().screen, 'results');
  assert.equal(host.querySelectorAll('[data-position]').length, 2);
  assert.match(host.querySelector('.gs-results').textContent, /AI/);
  host.querySelector('[data-focus="rematch"]').click();
  assert.equal(shell.getState().screen, 'lobby');
  assert.equal(starts, 1);
  shell.destroy();
});

test('guest lobby disables host-only map selection and start with reasons', () => {
  const { shell, host } = mountShell({
    screen: 'lobby',
    mode: 'multiplayer',
    carSlug: 'corvette-zr1-stock',
    mapId: 'river',
    mp: { role: 'guest', roomCode: 'KRP3Q', verified: true }
  });
  assert.equal(host.querySelector('[data-focus="lobby-map-river"]').disabled, true);
  assert.match(host.querySelector('.gs-lobby-maps').textContent, /only the host selects the map/);
  assert.equal(host.querySelector('[data-focus="start"]').disabled, true);
  assert.equal(host.querySelector('#gs-start-reason').textContent, 'only the host starts the race');
  shell.destroy();
});

test('unverified map disables READY with the existing reason', () => {
  const { shell, host } = mountShell({
    screen: 'lobby',
    mode: 'multiplayer',
    carSlug: 'corvette-zr1-stock',
    mapId: 'river',
    mp: { role: 'host', roomCode: 'KRP3Q', verified: false }
  });
  assert.equal(host.querySelector('[data-focus="ready"]').disabled, true);
  assert.match(host.querySelector('.gs-ready-row').textContent, /READY needs a verified room map/);
  shell.setMpVerified(true);
  assert.equal(host.querySelector('[data-focus="ready"]').disabled, false);
  shell.destroy();
});

test('Gracia Dodge AI row shows ai-spawn-unsupported before start', () => {
  const { shell, host } = mountShell({
    screen: 'lobby',
    mode: 'multiplayer',
    carSlug: 'corvette-zr1-stock',
    mapId: 'gracia',
    mp: { role: 'host', roomCode: 'KRP3Q', verified: true }
  });
  shell.setAi({ count: 1 });
  shell.setAiCar(0, 'dodge-challenger-stock');
  const panel = host.querySelector('.gs-ai');
  assert.match(panel.textContent, /ai-spawn-unsupported/);
  shell.setReady(true);
  assert.equal(host.querySelector('[data-focus="start"]').disabled, true);
  assert.match(host.querySelector('#gs-start-reason').textContent, /ai-spawn-unsupported/);
  assert.match(host.querySelector('#gs-start-reason').textContent, /front axle is unloaded/);
  shell.destroy();
});

test('focus is trapped, arrow keys rove the grid, Escape goes back', () => {
  const { shell, host, document } = mountShell({ screen: 'mode-select' });
  const cards = host.querySelectorAll('.gs-mode-card');
  assert.equal(cards.length, 5);
  cards[cards.length - 1].focus();
  host.querySelector('.gs-app') ?? null;
  const root = host.querySelector('.gs-app') ?? host.firstChild;
  root.dispatchEvent({ type: 'keydown', key: 'Tab' });
  assert.equal(document.activeElement, cards[0]);
  cards[0].focus();
  root.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: true });
  assert.equal(document.activeElement, cards[cards.length - 1]);
  root.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(shell.getState().screen, 'main-menu');
  shell.destroy();
});

test('arrow keys move focus between car tiles', () => {
  const { shell, host, document } = mountShell({ screen: 'car-select', mode: 'sprint', carSlug: 'corvette-zr1-stock' });
  const tiles = host.querySelectorAll('[data-car-slug]');
  assert.equal(tiles.length, 61);
  assert.equal(tiles[0].dataset.gridColumns, '7');
  const root = host.querySelector('.gs-app') ?? host.firstChild;
  tiles[0].focus();
  root.dispatchEvent({ type: 'keydown', key: 'ArrowRight' });
  assert.equal(document.activeElement, tiles[1]);
  root.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
  assert.equal(document.activeElement, tiles[8]);
  root.dispatchEvent({ type: 'keydown', key: 'End' });
  assert.equal(document.activeElement, tiles[60]);
  shell.destroy();
});

test('reduced motion is an explicit root flag and destroy removes the shell', () => {
  const { shell, host } = mountShell({ screen: 'main-menu' });
  const root = host.querySelector('.gs-app');
  assert.equal(root.dataset.reducedMotion, 'true');
  shell.destroy();
  assert.equal(host.childNodes.length, 0);
  assert.doesNotThrow(() => shell.destroy());
});

test('mounting and the full path produce no console errors or warnings', () => {
  const errors = [];
  const warns = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args) => errors.push(args.join(' '));
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    const { shell, host } = mountShell({ screen: 'main-menu' });
    host.querySelector('[data-focus="play"]').click();
    host.querySelector('[data-focus="mode-free"]').click();
    host.querySelector('[data-focus="car-next"]').click();
    host.querySelector('[data-focus="map-river"]').click();
    host.querySelector('[data-focus="map-action"]').click();
    shell.raceReady();
    shell.finish({
      positions: [{ position: 1, name: 'You', timeSeconds: null, laps: null }],
      mode: 'free',
      mapId: 'river',
      course: 'free'
    });
    shell.exit();
    shell.destroy();
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(warns, []);
});

test('standalone demo result is labelled synthetic and deterministic', async () => {
  const { demoResult } = await import('../shell.js');
  const { shell } = mountShell({ screen: 'race', mode: 'lap', carSlug: 'corvette-zr1-stock', mapId: 'river' });
  const state = shell.getState();
  const first = demoResult(state);
  const second = demoResult(state);
  assert.equal(first.synthetic, true);
  assert.equal(first.source, 'game-shell.demo');
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.positions[0].laps, 3);
  assert.ok(first.positions[0].bestLapSeconds > 0);
  shell.destroy();
});
