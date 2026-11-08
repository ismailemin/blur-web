/**
 * Runtime HUD unit suite (`blur.hud-runtime/1`).
 *
 *   node --test probes/hud-ui/test/
 *
 * Uses the existing game-shell DOM shim pattern; no browser, no dependencies.
 * Every assertion reads the live DOM or `snapshot()`, never an internal copy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDocument } from '../../game-shell/test/dom-shim.mjs';
import { createHud, HUD_SCHEMA } from '../runtime-hud.mjs';
import { HUD_DOCUMENT } from '../hud-document.mjs';

function makeDocument() {
  const document = createDocument();
  const listeners = new Map();
  document.defaultView = {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    }
  };
  return { document, listeners };
}

function mount(options = {}) {
  const { document } = makeDocument();
  const host = document.createElement('div');
  host.id = 'host';
  document.documentElement.appendChild(host);
  const hud = createHud({
    doc: options.doc ?? HUD_DOCUMENT,
    host,
    now: options.now ?? (() => 1000)
  });
  return { document, host, hud, listeners: document.defaultView };
}

function fullState() {
  return {
    speedMps: 41.2,
    maxSpeedMps: 60,
    gear: 4,
    position: 2,
    fieldSize: 8,
    lap: 2,
    laps: 3,
    timeSeconds: 86.412,
    bestLapSeconds: 28.4,
    powerup: { type: 'Bomb', charges: 2, secondsLeft: 4.25, cooldownSeconds: 5 },
    shield: { current: 50, max: 50, secondsLeft: 4.25 },
    health: { current: 78, max: 100 },
    countdown: { label: '2', secondsLeft: 2.4 },
    wrongWay: false,
    feed: [
      'picked up Bomb',
      { type: 'bombed', text: 'Mined' },
      { type: 'shielded' }
    ]
  };
}

function field(host, name) {
  return host.querySelector('[data-field="' + name + '"]');
}

test('module surface and mount contract', () => {
  assert.equal(HUD_SCHEMA, 'blur.hud-runtime/1');

  assert.throws(() => createHud({ doc: HUD_DOCUMENT }), TypeError);
  assert.throws(() => createHud({ host: {} }), TypeError);

  const { document, host, hud, listeners } = mount();
  const badHost = document.createElement('div');
  assert.throws(() => createHud({ doc: { labels: {} }, host: badHost }), TypeError);
  assert.equal(hud.schema, HUD_SCHEMA);
  assert.equal(typeof hud.update, 'function');
  assert.equal(typeof hud.snapshot, 'function');
  assert.equal(typeof hud.destroy, 'function');
  assert.equal(hud.element.parentNode, host);
  assert.equal(hud.element.id, 'blur-hud');
  assert.equal(hud.element.getAttribute('data-hud'), HUD_SCHEMA);
  assert.equal(hud.element.getAttribute('data-doc'), 'blur.hud-doc/1');
  assert.equal(hud.element.getAttribute('data-art'), 'project');
  assert.equal(hud.element.getAttribute('role'), 'group');
  assert.equal(hud.element.getAttribute('aria-label'), 'race HUD, display only');
  assert.equal(host.__blurHud, hud);
  assert.equal(listeners.listenerCount('resize'), 1);
  assert.throws(() => createHud({ doc: HUD_DOCUMENT, host }), /already owns/);
  assert.equal(document.defaultView.listenerCount('resize'), 1);
});

test('renders every field from update(state)', () => {
  const { host, hud } = mount();
  assert.equal(hud.update(fullState()), true);

  assert.equal(field(host, 'speed').textContent, '92');
  assert.equal(field(host, 'speed-unit').textContent, 'MPH');
  assert.equal(field(host, 'gear').textContent, '4');
  assert.equal(field(host, 'position').textContent, '2');
  assert.equal(field(host, 'position-total').textContent, '/ 8');
  assert.equal(field(host, 'lap').textContent, '2');
  assert.equal(field(host, 'lap-total').textContent, '/ 3');
  assert.equal(field(host, 'time').textContent, '1:26.412');
  assert.equal(field(host, 'best-lap').textContent, '28.400');
  assert.equal(field(host, 'powerup').textContent, 'MINE');
  assert.equal(field(host, 'powerup-glyph').textContent, 'M');
  assert.equal(field(host, 'powerup-charges').textContent, '×2');
  assert.equal(field(host, 'powerup-detail').textContent, '4.25 s');
  assert.equal(field(host, 'powerup-detail').getAttribute('data-missing'), null);
  assert.equal(field(host, 'health').textContent, '78 / 100');
  assert.equal(field(host, 'shield').textContent, '50 / 50');

  const powerupCard = host.querySelector('[data-element="powerup"]');
  assert.equal(powerupCard.getAttribute('data-kind'), 'bomb');

  const speedGauge = host.querySelector('[data-gauge="speed"]');
  assert.equal(speedGauge.getAttribute('data-percent'), '68.7');
  assert.equal(speedGauge.getAttribute('aria-valuenow'), '68.7');
  assert.equal(speedGauge.getAttribute('data-missing'), null);

  const cooldownRing = host.querySelector('[data-gauge="cooldown"]');
  assert.equal(cooldownRing.getAttribute('data-percent'), '85');
  assert.equal(cooldownRing.getAttribute('aria-valuenow'), '85');
  assert.equal(cooldownRing.getAttribute('data-missing'), null);

  const countdown = host.querySelector('[data-element="countdown"]');
  assert.equal(countdown.getAttribute('hidden'), null);
  assert.equal(field(host, 'countdown-label').textContent, '2');
  assert.equal(field(host, 'countdown-seconds').textContent, '2.4 s');
  assert.equal(field(host, 'countdown-label').getAttribute('data-missing'), null);

  const wrongWay = host.querySelector('[data-element="wrongway"]');
  assert.equal(wrongWay.getAttribute('hidden'), '');
  assert.equal(wrongWay.textContent, 'WRONG WAY');

  const healthBar = host.querySelector('[data-bar="health"]');
  assert.equal(healthBar.getAttribute('aria-valuenow'), '78');
  assert.equal(healthBar.style.width, '78%');
  assert.equal(healthBar.getAttribute('data-missing'), null);
  assert.equal(healthBar.getAttribute('data-level'), 'ok');

  const shieldBar = host.querySelector('[data-bar="shield"]');
  assert.equal(shieldBar.getAttribute('aria-valuenow'), '100');
  assert.equal(shieldBar.style.width, '100%');
  assert.equal(shieldBar.getAttribute('data-level'), 'ok');

  const feed = host.querySelector('[data-element="feed"]');
  assert.equal(feed.getAttribute('aria-live'), 'polite');
  assert.equal(feed.children.length, 3);
  assert.equal(feed.children[0].textContent, 'picked up Bomb');
  assert.equal(feed.children[1].textContent, 'Mined');
  assert.equal(feed.children[2].textContent, 'Shielded');
  assert.equal(feed.children[1].getAttribute('data-kind'), 'bombed');
});

test('snapshot equals the rendered DOM', () => {
  const { host, hud } = mount();
  hud.update(fullState());
  const snap = hud.snapshot();

  assert.equal(snap.schema, HUD_SCHEMA);
  assert.equal(snap.labels.root, 'race HUD, display only');
  assert.equal(snap.labels.position, 'Position');
  assert.equal(snap.labels.lap, 'Laps');
  assert.equal(snap.labels.time, 'TIME');
  assert.equal(snap.labels.best, 'Best');
  assert.equal(snap.labels.speedUnit, 'MPH');
  assert.equal(snap.labels.gear, 'GEAR');
  assert.equal(snap.labels.health, 'HEALTH');
  assert.equal(snap.labels.shield, 'SHIELD');
  assert.equal(snap.labels.feed, 'Events');
  assert.equal(snap.labels.wrongWay, 'WRONG WAY');
  assert.equal(snap.fields.powerup.kind, 'bomb');
  for (const name of [
    'speed', 'speedUnit', 'gear', 'position', 'positionTotal', 'lap', 'lapTotal',
    'time', 'bestLap', 'powerup', 'powerupGlyph', 'powerupCharges', 'powerupDetail',
    'health', 'shield', 'countdownLabel', 'countdownSeconds'
  ]) {
    const selector = name
      .replace('speedUnit', 'speed-unit')
      .replace('positionTotal', 'position-total')
      .replace('lapTotal', 'lap-total')
      .replace('bestLap', 'best-lap')
      .replace('powerupGlyph', 'powerup-glyph')
      .replace('powerupCharges', 'powerup-charges')
      .replace('powerupDetail', 'powerup-detail')
      .replace('countdownLabel', 'countdown-label')
      .replace('countdownSeconds', 'countdown-seconds');
    const node = field(host, selector);
    assert.equal(snap.fields[name].text, node.textContent, name + ' text');
    assert.equal(snap.fields[name].missing, node.getAttribute('data-missing') === '1', name + ' missing');
  }

  const healthBar = host.querySelector('[data-bar="health"]');
  assert.equal(snap.bars.health.percent, Number(healthBar.getAttribute('aria-valuenow')));
  assert.equal(snap.bars.health.missing, false);
  assert.equal(snap.bars.health.level, healthBar.getAttribute('data-level'));
  assert.equal(snap.bars.shield.percent, 100);
  assert.equal(snap.bars.shield.level, 'ok');

  const speedGauge = host.querySelector('[data-gauge="speed"]');
  assert.equal(snap.gauges.speed.percent, Number(speedGauge.getAttribute('data-percent')));
  assert.equal(snap.gauges.speed.percent, 68.7);
  assert.equal(snap.gauges.speed.missing, false);
  assert.equal(snap.gauges.cooldown.percent, 85);
  assert.equal(snap.gauges.cooldown.missing, false);

  assert.equal(snap.countdown.visible, true);
  assert.equal(snap.countdown.missing, false);
  assert.equal(snap.wrongWay.visible, false);

  const feed = host.querySelector('[data-element="feed"]');
  assert.equal(snap.feed.items.length, feed.children.length);
  for (let index = 0; index < feed.children.length; index += 1) {
    assert.equal(snap.feed.items[index].text, feed.children[index].textContent);
    assert.equal(snap.feed.items[index].kind, feed.children[index].getAttribute('data-kind'));
  }
  assert.equal(snap.feed.missing, false);
  assert.equal(snap.layout.compact, false);
});

test('update is idempotent', () => {
  const { host, hud } = mount();
  hud.update(fullState());
  const first = hud.snapshot();
  const before = hud.metrics();

  hud.update(fullState());
  const after = hud.metrics();
  const second = hud.snapshot();

  assert.equal(after.textWrites, before.textWrites);
  assert.equal(after.attrWrites, before.attrWrites);
  assert.equal(after.feedRebuilds, before.feedRebuilds);
  assert.deepEqual(second, first);
  assert.equal(field(host, 'speed').textContent, '92');
});

test('missing values render — and set data-missing', () => {
  const { host, hud } = mount();
  hud.update({});

  for (const name of [
    'speed', 'gear', 'position', 'position-total', 'lap', 'lap-total',
    'time', 'best-lap', 'powerup', 'powerup-charges', 'powerup-detail',
    'health', 'shield', 'countdown-label', 'countdown-seconds'
  ]) {
    const node = field(host, name);
    assert.equal(node.textContent, '—', name + ' placeholder');
    assert.equal(node.getAttribute('data-missing'), '1', name + ' data-missing');
  }

  assert.equal(field(host, 'speed-unit').textContent, 'MPH');
  assert.equal(field(host, 'speed-unit').getAttribute('data-missing'), null);
  assert.equal(field(host, 'powerup-glyph').textContent, '·');
  assert.equal(host.querySelector('[data-element="powerup"]').getAttribute('data-kind'), 'missing');

  const speedGauge = host.querySelector('[data-gauge="speed"]');
  assert.equal(speedGauge.getAttribute('data-percent'), null);
  assert.equal(speedGauge.getAttribute('aria-valuenow'), null);
  assert.equal(speedGauge.getAttribute('data-missing'), '1');

  const cooldownRing = host.querySelector('[data-gauge="cooldown"]');
  assert.equal(cooldownRing.getAttribute('data-percent'), null);
  assert.equal(cooldownRing.getAttribute('data-missing'), '1');

  assert.equal(host.querySelector('[data-element="countdown"]').getAttribute('hidden'), '');
  assert.equal(host.querySelector('[data-element="wrongway"]').getAttribute('hidden'), '');

  const healthBar = host.querySelector('[data-bar="health"]');
  assert.equal(healthBar.getAttribute('aria-valuenow'), null);
  assert.equal(healthBar.getAttribute('data-missing'), '1');
  assert.equal(healthBar.style.width, '0%');

  const shieldBar = host.querySelector('[data-bar="shield"]');
  assert.equal(shieldBar.getAttribute('aria-valuenow'), null);
  assert.equal(shieldBar.getAttribute('data-missing'), '1');

  const feed = host.querySelector('[data-element="feed"]');
  assert.equal(feed.getAttribute('data-missing'), '1');
  assert.equal(feed.children.length, 1);
  assert.equal(feed.children[0].textContent, '—');
  assert.equal(feed.children[0].getAttribute('data-missing'), '1');

  const snap = hud.snapshot();
  assert.equal(snap.fields.speed.missing, true);
  assert.equal(snap.bars.health.percent, null);
  assert.equal(snap.feed.missing, true);
});

test('zero is a value, not a missing value', () => {
  const { host, hud } = mount();
  hud.update({
    speedMps: 0,
    maxSpeedMps: 100,
    gear: 0,
    position: 1,
    fieldSize: 1,
    lap: 1,
    laps: 1,
    timeSeconds: 0,
    bestLapSeconds: 0,
    powerup: null,
    shield: 0,
    health: 0,
    feed: []
  });

  assert.equal(field(host, 'speed').textContent, '0');
  assert.equal(field(host, 'speed').getAttribute('data-missing'), null);
  assert.equal(field(host, 'gear').textContent, 'N');
  assert.equal(field(host, 'position').textContent, '1');
  assert.equal(field(host, 'position-total').textContent, '/ 1');
  assert.equal(field(host, 'lap').textContent, '1');
  assert.equal(field(host, 'lap-total').textContent, '/ 1');
  assert.equal(field(host, 'time').textContent, '0:00.000');
  assert.equal(field(host, 'best-lap').textContent, '00.000');
  assert.equal(field(host, 'health').textContent, '0%');
  assert.equal(field(host, 'shield').textContent, '0%');
  assert.equal(field(host, 'health').getAttribute('data-missing'), null);

  const healthBar = host.querySelector('[data-bar="health"]');
  assert.equal(healthBar.getAttribute('aria-valuenow'), '0');
  assert.equal(healthBar.getAttribute('data-missing'), null);
  assert.equal(healthBar.getAttribute('data-level'), 'critical');

  const speedGauge = host.querySelector('[data-gauge="speed"]');
  assert.equal(speedGauge.getAttribute('data-percent'), '0');
  assert.equal(speedGauge.getAttribute('data-missing'), null);
  assert.equal(speedGauge.getAttribute('aria-valuenow'), '0');

  const feed = host.querySelector('[data-element="feed"]');
  assert.equal(feed.getAttribute('data-empty'), '1');
  assert.equal(feed.getAttribute('data-missing'), null);
  assert.equal(feed.children.length, 0);

  const snap = hud.snapshot();
  assert.equal(snap.fields.speed.missing, false);
  assert.equal(snap.bars.health.percent, 0);
  assert.equal(snap.feed.items.length, 0);
  assert.equal(snap.feed.missing, false);
  assert.equal(snap.feed.empty, true);
});

test('NaN and Infinity are missing', () => {
  const { host, hud } = mount();
  hud.update({
    speedMps: NaN,
    maxSpeedMps: NaN,
    gear: Infinity,
    position: NaN,
    fieldSize: NaN,
    lap: NaN,
    laps: NaN,
    timeSeconds: NaN,
    bestLapSeconds: Infinity,
    powerup: { type: '', charges: NaN },
    shield: { current: NaN, max: 100 },
    health: { current: 10, max: 0 },
    countdown: { label: '', secondsLeft: NaN },
    feed: null
  });

  assert.equal(field(host, 'speed').textContent, '—');
  assert.equal(field(host, 'gear').textContent, '—');
  assert.equal(field(host, 'position').textContent, '—');
  assert.equal(field(host, 'position-total').textContent, '—');
  assert.equal(field(host, 'lap').textContent, '—');
  assert.equal(field(host, 'time').textContent, '—');
  assert.equal(field(host, 'best-lap').textContent, '—');
  assert.equal(field(host, 'powerup').textContent, '—');
  assert.equal(field(host, 'health').textContent, '—');
  assert.equal(field(host, 'shield').textContent, '—');
  assert.equal(host.querySelector('[data-element="feed"]').getAttribute('data-missing'), '1');
  assert.equal(host.querySelector('[data-gauge="speed"]').getAttribute('data-missing'), '1');
  assert.equal(host.querySelector('[data-element="countdown"]').getAttribute('hidden'), '');
});

test('power-up variants', () => {
  const { host, hud } = mount();

  hud.update({ powerup: 'Shield' });
  assert.equal(field(host, 'powerup').textContent, 'SHIELD');
  assert.equal(field(host, 'powerup-glyph').textContent, 'S');
  assert.equal(field(host, 'powerup-charges').textContent, '—');
  assert.equal(field(host, 'powerup-charges').getAttribute('data-missing'), '1');
  assert.equal(field(host, 'powerup-detail').textContent, '—');
  assert.equal(field(host, 'powerup-detail').getAttribute('data-missing'), '1');
  assert.equal(host.querySelector('[data-element="powerup"]').getAttribute('data-kind'), 'shield');

  hud.update({ powerup: 'Turbo' });
  assert.equal(field(host, 'powerup').textContent, 'Turbo');
  assert.equal(field(host, 'powerup-glyph').textContent, '?');
  assert.equal(host.querySelector('[data-element="powerup"]').getAttribute('data-kind'), 'unknown');
  assert.equal(field(host, 'powerup').getAttribute('data-missing'), null);

  hud.update({ powerup: { type: 'Nitrous', charges: 1 } });
  assert.equal(field(host, 'powerup').textContent, 'NITRO');
  assert.equal(field(host, 'powerup-charges').textContent, '×1');
  assert.equal(field(host, 'powerup-detail').textContent, '—');

  hud.update({ powerup: { type: 'Bomb', secondsLeft: 1.5 } });
  assert.equal(field(host, 'powerup-detail').textContent, '1.50 s');
  assert.equal(field(host, 'powerup-detail').getAttribute('data-missing'), null);

  hud.update({ powerup: { type: 'Bomb', charges: 2, secondsLeft: 4.25 } });
  assert.equal(field(host, 'powerup-charges').textContent, '×2');
  assert.equal(field(host, 'powerup-detail').textContent, '4.25 s');
});

test('feed mapping, limit, expiry and empty state', () => {
  const { host, hud } = mount();

  hud.update({ feed: Array.from({ length: 10 }, (_, index) => 'event-' + index) });
  const feed = host.querySelector('[data-element="feed"]');
  assert.equal(feed.children.length, 8);
  assert.equal(feed.children[0].textContent, 'event-2');
  assert.equal(feed.children[7].textContent, 'event-9');

  hud.update({ feed: [{ type: 'custom' }] });
  assert.equal(feed.children[0].textContent, 'custom');
  assert.equal(feed.children[0].getAttribute('data-kind'), 'unknown');
  assert.equal(feed.children[0].getAttribute('data-missing'), null);

  hud.update({ feed: [{}] });
  assert.equal(feed.children[0].textContent, '—');
  assert.equal(feed.children[0].getAttribute('data-missing'), '1');

  hud.update({ feed: [] });
  assert.equal(feed.children.length, 0);
  assert.equal(feed.getAttribute('data-empty'), '1');
  assert.equal(feed.getAttribute('data-missing'), null);
});

test('feed expiry uses the injected clock', () => {
  const live = mount({ now: () => 999 });
  live.hud.update({
    feed: [
      { text: 'live', expiresAt: 1001 },
      { text: 'gone', expiresAt: 1000 }
    ]
  });
  assert.equal(live.host.querySelector('[data-element="feed"]').children.length, 2);

  const expired = mount({ now: () => 1000 });
  expired.hud.update({
    feed: [
      { text: 'live', expiresAt: 1001 },
      { text: 'gone', expiresAt: 1000 }
    ]
  });
  const feed = expired.host.querySelector('[data-element="feed"]');
  assert.equal(feed.children.length, 1);
  assert.equal(feed.children[0].textContent, 'live');
});

test('destroy removes the root and listeners', () => {
  const { host, hud, listeners } = mount();
  hud.update(fullState());

  assert.equal(listeners.listenerCount('resize'), 1);
  assert.equal(hud.destroy(), true);
  assert.equal(hud.element.parentNode, null);
  assert.equal(host.__blurHud, undefined);
  assert.equal(listeners.listenerCount('resize'), 0);
  assert.equal(hud.destroy(), false);
  assert.equal(hud.update(fullState()), false);
  assert.equal(hud.snapshot(), null);

  const again = createHud({ doc: HUD_DOCUMENT, host, now: () => 1000 });
  assert.equal(again.element.parentNode, host);
  again.destroy();
});

test('two mounts with the same state are deterministic', () => {
  const first = mount();
  const second = mount();
  first.hud.update(fullState());
  second.hud.update(fullState());
  assert.deepEqual(first.hud.snapshot(), second.hud.snapshot());
  first.hud.destroy();
  second.hud.destroy();
});

test('speed gauge follows speedMps / maxSpeedMps without guessing a max', () => {
  const { host, hud } = mount();
  const gauge = host.querySelector('[data-gauge="speed"]');

  hud.update({ speedMps: 30, maxSpeedMps: 60 });
  assert.equal(gauge.getAttribute('data-percent'), '50');
  assert.equal(gauge.getAttribute('aria-valuenow'), '50');
  assert.equal(gauge.getAttribute('data-missing'), null);
  assert.equal(gauge.style['--gauge'], '50');

  hud.update({ speedMps: -60, maxSpeedMps: 60 });
  assert.equal(gauge.getAttribute('data-percent'), '100');

  hud.update({ speedMps: 90, maxSpeedMps: 60 });
  assert.equal(gauge.getAttribute('data-percent'), '100');

  hud.update({ speedMps: 30 });
  assert.equal(gauge.getAttribute('data-percent'), null);
  assert.equal(gauge.getAttribute('aria-valuenow'), null);
  assert.equal(gauge.getAttribute('data-missing'), '1');

  hud.update({ speedMps: 30, maxSpeedMps: 0 });
  assert.equal(gauge.getAttribute('data-missing'), '1');

  hud.update({ speedMps: 30, maxSpeedMps: 60 });
  assert.equal(hud.snapshot().gauges.speed.percent, 50);
  assert.equal(hud.snapshot().gauges.speed.missing, false);
});

test('gear maps to R / N / 1..6 and rejects unsupported values', () => {
  const { host, hud } = mount();
  const gear = field(host, 'gear');
  const card = host.querySelector('[data-element="gear"]');

  hud.update({ gear: -1 });
  assert.equal(gear.textContent, 'R');
  assert.equal(card.getAttribute('data-gear'), 'reverse');

  hud.update({ gear: -4 });
  assert.equal(gear.textContent, 'R');

  hud.update({ gear: 0 });
  assert.equal(gear.textContent, 'N');
  assert.equal(card.getAttribute('data-gear'), 'neutral');

  hud.update({ gear: 3 });
  assert.equal(gear.textContent, '3');
  assert.equal(card.getAttribute('data-gear'), 'forward');

  hud.update({ gear: 6 });
  assert.equal(gear.textContent, '6');

  hud.update({ gear: 7 });
  assert.equal(gear.textContent, '—');
  assert.equal(gear.getAttribute('data-missing'), '1');
  assert.equal(card.getAttribute('data-gear'), 'out-of-range');

  hud.update({ gear: 2.5 });
  assert.equal(gear.textContent, '—');
  assert.equal(card.getAttribute('data-gear'), 'missing');
});

test('power-up charges and cooldown ring', () => {
  const { host, hud } = mount();
  const ring = host.querySelector('[data-gauge="cooldown"]');

  hud.update({ powerup: { type: 'Bomb', charges: 2, secondsLeft: 3, cooldownSeconds: 6 } });
  assert.equal(field(host, 'powerup-charges').textContent, '×2');
  assert.equal(field(host, 'powerup-charges').getAttribute('data-missing'), null);
  assert.equal(field(host, 'powerup-detail').textContent, '3.00 s');
  assert.equal(ring.getAttribute('data-percent'), '50');
  assert.equal(ring.getAttribute('aria-valuenow'), '50');
  assert.equal(ring.getAttribute('data-missing'), null);

  hud.update({ powerup: { type: 'Bomb', charges: 2 } });
  assert.equal(ring.getAttribute('data-percent'), null);
  assert.equal(ring.getAttribute('data-missing'), '1');

  hud.update({ powerup: { type: 'Bomb', secondsLeft: 2, cooldownSeconds: 0 } });
  assert.equal(ring.getAttribute('data-missing'), '1');

  hud.update({ powerup: { type: 'Bomb', secondsLeft: 10, cooldownSeconds: 4 } });
  assert.equal(ring.getAttribute('data-percent'), '100');

  hud.update({ powerup: null });
  assert.equal(field(host, 'powerup-charges').textContent, '—');
  assert.equal(field(host, 'powerup-charges').getAttribute('data-missing'), '1');
  assert.equal(ring.getAttribute('data-missing'), '1');
});

test('health and shield bars use a colour-ramp level', () => {
  const { host, hud } = mount();
  const healthBar = host.querySelector('[data-bar="health"]');
  const shieldBar = host.querySelector('[data-bar="shield"]');

  hud.update({ health: 80, shield: 50 });
  assert.equal(healthBar.getAttribute('data-level'), 'ok');
  assert.equal(shieldBar.getAttribute('data-level'), 'warn');

  hud.update({ health: 10, shield: 29 });
  assert.equal(healthBar.getAttribute('data-level'), 'critical');
  assert.equal(shieldBar.getAttribute('data-level'), 'critical');

  hud.update({ health: 30, shield: 60 });
  assert.equal(healthBar.getAttribute('data-level'), 'warn');
  assert.equal(shieldBar.getAttribute('data-level'), 'ok');

  hud.update({ health: null, shield: 60 });
  assert.equal(healthBar.getAttribute('data-level'), 'missing');
  assert.equal(healthBar.getAttribute('data-missing'), '1');
  assert.equal(hud.snapshot().bars.health.level, 'missing');
  assert.equal(hud.snapshot().bars.shield.level, 'ok');
});

test('countdown overlay shows label and seconds, hides when absent', () => {
  const { host, hud } = mount();
  const overlay = host.querySelector('[data-element="countdown"]');

  hud.update({ countdown: { label: '3', secondsLeft: 3.2 } });
  assert.equal(overlay.getAttribute('hidden'), null);
  assert.equal(field(host, 'countdown-label').textContent, '3');
  assert.equal(field(host, 'countdown-label').getAttribute('data-missing'), null);
  assert.equal(field(host, 'countdown-seconds').textContent, '3.2 s');
  assert.equal(hud.snapshot().countdown.visible, true);

  hud.update({ countdown: { secondsLeft: 1 } });
  assert.equal(overlay.getAttribute('hidden'), null);
  assert.equal(field(host, 'countdown-label').textContent, '—');
  assert.equal(field(host, 'countdown-label').getAttribute('data-missing'), '1');
  assert.equal(field(host, 'countdown-seconds').textContent, '1.0 s');

  hud.update({ countdown: { label: 'GO' } });
  assert.equal(field(host, 'countdown-label').textContent, 'GO');
  assert.equal(field(host, 'countdown-seconds').textContent, '—');
  assert.equal(field(host, 'countdown-seconds').getAttribute('data-missing'), '1');

  hud.update({ countdown: null });
  assert.equal(overlay.getAttribute('hidden'), '');
  assert.equal(field(host, 'countdown-label').textContent, '—');
  assert.equal(hud.snapshot().countdown.visible, false);
});

test('wrong-way banner only shows for a strict true', () => {
  const { host, hud } = mount();
  const banner = host.querySelector('[data-element="wrongway"]');

  assert.equal(banner.textContent, 'WRONG WAY');

  hud.update({ wrongWay: true });
  assert.equal(banner.getAttribute('hidden'), null);
  assert.equal(hud.snapshot().wrongWay.visible, true);

  hud.update({ wrongWay: false });
  assert.equal(banner.getAttribute('hidden'), '');
  assert.equal(hud.snapshot().wrongWay.visible, false);

  hud.update({ wrongWay: 'yes' });
  assert.equal(banner.getAttribute('hidden'), '');
});

test('new fields are idempotent and survive destroy', () => {
  const { hud } = mount();
  hud.update(fullState());
  const before = hud.metrics();
  hud.update(fullState());
  const after = hud.metrics();
  assert.equal(after.textWrites, before.textWrites);
  assert.equal(after.attrWrites, before.attrWrites);
  assert.equal(after.feedRebuilds, before.feedRebuilds);

  hud.destroy();
  assert.equal(hud.snapshot(), null);
});
