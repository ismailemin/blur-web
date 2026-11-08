/**
 * Blur Web — mountable runtime HUD (`blur.hud-runtime/1`).
 *
 * Dependency-free, deterministic, DOM-only. No canvas, no WebGPU, no timers.
 * The caller owns simulation state and passes one plain object to `update()`.
 * Every static string comes from `hud-document.mjs` (the committed HUD
 * document); every dynamic value comes from the caller.
 *
 * Hard rules:
 *  - A missing / non-finite value renders `—` and the node carries
 *    `data-missing="1"`. No field is ever defaulted to a guessed zero.
 *  - `snapshot()` reads the live DOM, so it is exactly what is rendered.
 *  - `update()` is idempotent: the same state writes no text and no attributes.
 *  - `destroy()` removes the resize listener and the mounted root.
 *
 * Presentation additions (`blur.hud-runtime/1`, project art):
 *  - speed gauge: CSS conic-gradient driven by `speedMps / maxSpeedMps`
 *  - gear mapping: `0` -> N, negative -> R, `1..6` -> digit
 *  - power-up charges node and a cooldown ring from `secondsLeft / cooldownSeconds`
 *  - health/shield colour ramp via `data-level="ok|warn|critical|missing"`
 *  - countdown overlay (`countdown: { label, secondsLeft }`)
 *  - wrong-way banner (`wrongWay: true`)
 *
 * Import contract:
 *   import { createHud, HUD_SCHEMA } from './runtime-hud.mjs';
 *   import { HUD_DOCUMENT } from './hud-document.mjs';
 *   const hud = createHud({ doc: HUD_DOCUMENT, host, now: () => performance.now() });
 *   hud.update(state);
 *   const rendered = hud.snapshot();
 *   hud.destroy();
 */

import { HUD_DOCUMENT } from './hud-document.mjs';

export { HUD_DOCUMENT };
export const HUD_SCHEMA = 'blur.hud-runtime/1';

const EMPTY = Object.freeze({});

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveInt(value) {
  return finite(value) && value >= 1 && Number.isInteger(value);
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function pad3(value) {
  return value < 10 ? '00' + value : value < 100 ? '0' + value : String(value);
}

/** `m:ss.mmm`, matching probes/hud-ui/hud.mjs formatRaceTime. */
function formatRaceTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const minutes = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return minutes + ':' + (secs < 10 ? '0' : '') + secs + '.' + pad3(ms % 1000);
}

/** `ss.mmm` below a minute, `m:ss.mmm` above it. */
function formatLapTime(seconds) {
  const ms = Math.round(seconds * 1000);
  if (ms >= 60000) return formatRaceTime(seconds);
  const secs = Math.floor(ms / 1000);
  return (secs < 10 ? '0' : '') + secs + '.' + pad3(ms % 1000);
}

function labelText(entry, fallback) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry.text === 'string') return entry.text;
  return fallback;
}

function parsePowerup(value, hudDoc) {
  const missingText = hudDoc.labels.missing.text;
  let type = null;
  let charges = null;
  let secondsLeft = null;
  let cooldownSeconds = null;
  if (typeof value === 'string') {
    type = value.length > 0 ? value : null;
  } else if (value && typeof value === 'object') {
    type = typeof value.type === 'string' && value.type.length > 0 ? value.type : null;
    charges = finite(value.charges) && value.charges >= 0 ? value.charges : null;
    secondsLeft = finite(value.secondsLeft) && value.secondsLeft >= 0 ? value.secondsLeft : null;
    cooldownSeconds = finite(value.cooldownSeconds) && value.cooldownSeconds > 0
      ? value.cooldownSeconds
      : null;
  }
  if (type === null) {
    return {
      type: null,
      label: missingText,
      glyph: hudDoc.labels.emptyGlyph.text,
      chargesText: missingText,
      chargesMissing: true,
      detail: missingText,
      detailMissing: true,
      cooldownPercent: null,
      kind: 'missing',
      missing: true
    };
  }
  const known = hudDoc.powerups[type] ?? null;
  const cooldownPercent = secondsLeft !== null && cooldownSeconds !== null
    ? clamp((secondsLeft / cooldownSeconds) * 100, 0, 100)
    : null;
  return {
    type,
    label: known ? known.label : type,
    glyph: known ? known.glyph : hudDoc.labels.unknownGlyph.text,
    chargesText: charges === null ? missingText : hudDoc.format.chargesPrefix + charges,
    chargesMissing: charges === null,
    detail: secondsLeft === null
      ? missingText
      : secondsLeft.toFixed(2) + ' ' + hudDoc.format.secondsSuffix,
    detailMissing: secondsLeft === null,
    cooldownPercent,
    kind: known ? type.toLowerCase() : 'unknown',
    missing: false
  };
}

/**
 * Gear display mapping: `0` -> `N`, any negative integer -> `R`, `1..gearMax`
 * -> the digit. A non-integer or an out-of-range integer is unsupported and
 * renders the missing placeholder with an explicit `data-gear` state.
 */
function parseGear(value, hudDoc) {
  if (!finite(value) || !Number.isInteger(value)) {
    return { text: null, state: 'missing' };
  }
  if (value === 0) return { text: hudDoc.format.gearNeutral, state: 'neutral' };
  if (value < 0) return { text: hudDoc.format.gearReverse, state: 'reverse' };
  const max = Number.isInteger(hudDoc.format.gearMax) ? hudDoc.format.gearMax : 6;
  if (value <= max) return { text: String(value), state: 'forward' };
  return { text: null, state: 'out-of-range' };
}

/** Colour-ramp bucket for a meter. Thresholds are project choices, not retail. */
function meterLevel(percent) {
  if (percent === null) return 'missing';
  if (percent >= 60) return 'ok';
  if (percent >= 30) return 'warn';
  return 'critical';
}

/**
 * Countdown overlay hook. Visible when `label` or `secondsLeft` is present;
 * a missing half renders `—` with `data-missing="1"` instead of a guess.
 */
function parseCountdown(value, hudDoc) {
  const missingText = hudDoc.labels.missing.text;
  const source = value && typeof value === 'object' ? value : null;
  const label = source && typeof source.label === 'string' && source.label.length > 0
    ? source.label
    : null;
  const seconds = source && finite(source.secondsLeft) && source.secondsLeft >= 0
    ? source.secondsLeft
    : null;
  return {
    visible: label !== null || seconds !== null,
    label: label === null ? missingText : label,
    labelMissing: label === null,
    secondsText: seconds === null
      ? missingText
      : seconds.toFixed(1) + ' ' + hudDoc.format.secondsSuffix,
    secondsMissing: seconds === null
  };
}

function parseMeter(value, hudDoc) {
  const missingText = hudDoc.labels.missing.text;
  if (finite(value)) {
    const percent = round1(clamp(value, 0, 100));
    return { text: percent + hudDoc.format.percentSuffix, percent, missing: false };
  }
  if (value && typeof value === 'object') {
    const current = finite(value.current) ? value.current : null;
    const max = finite(value.max) ? value.max : null;
    if (current === null || max === null || max <= 0) {
      return { text: missingText, percent: null, missing: true };
    }
    const percent = round1(clamp((current / max) * 100, 0, 100));
    const text = Math.max(0, Math.round(current)) + ' ' +
      hudDoc.format.valueSeparator + ' ' + Math.round(max);
    return { text, percent, missing: false };
  }
  return { text: missingText, percent: null, missing: true };
}

function parseFeed(value, hudDoc, nowValue) {
  const missingText = hudDoc.labels.missing.text;
  if (!Array.isArray(value)) {
    return {
      items: [{ text: missingText, kind: 'missing', missing: true }],
      missing: true
    };
  }
  const items = [];
  for (const entry of value) {
    if (entry === null || entry === undefined) {
      items.push({ text: missingText, kind: 'missing', missing: true });
      continue;
    }
    if (typeof entry === 'string') {
      items.push({ text: entry, kind: 'info', missing: false });
      continue;
    }
    if (typeof entry !== 'object') {
      items.push({ text: String(entry), kind: 'info', missing: false });
      continue;
    }
    if (finite(entry.expiresAt) && nowValue >= entry.expiresAt) continue;
    let text = typeof entry.text === 'string' && entry.text.length > 0 ? entry.text : null;
    let kind = typeof entry.kind === 'string' && entry.kind.length > 0
      ? entry.kind
      : (typeof entry.type === 'string' && entry.type.length > 0 ? entry.type : 'info');
    if (text === null && typeof entry.type === 'string' && entry.type.length > 0) {
      const mapped = hudDoc.feed.events[entry.type] ?? null;
      if (mapped) {
        text = labelText(mapped, entry.type);
      } else {
        text = entry.type;
        kind = 'unknown';
      }
    }
    if (text === null) {
      items.push({ text: missingText, kind: 'missing', missing: true });
      continue;
    }
    items.push({ text, kind, missing: false });
  }
  const limit = Number.isInteger(hudDoc.feed.limit) && hudDoc.feed.limit > 0 ? hudDoc.feed.limit : 8;
  return { items: items.slice(-limit), missing: false };
}

/**
 * Mount a runtime HUD inside `host`.
 *
 * @param {object} options
 * @param {object} [options.doc]  committed HUD document (`hud-document.mjs`)
 * @param {object} options.host   DOM element that accepts `appendChild`
 * @param {Function} [options.now] clock in milliseconds for feed `expiresAt`
 * @returns {{schema:string, element:object, update:Function, snapshot:Function, destroy:Function, metrics:Function}}
 */
export function createHud(options = EMPTY) {
  const hudDoc = options.doc ?? HUD_DOCUMENT;
  const host = options.host;
  if (!host || typeof host.appendChild !== 'function') {
    throw new TypeError('createHud({ doc, host, now }): host must be a DOM element');
  }
  if (!hudDoc || typeof hudDoc !== 'object' || !hudDoc.labels || !hudDoc.format || !hudDoc.feed || !hudDoc.powerups) {
    throw new TypeError('createHud({ doc, host, now }): doc must be the committed HUD document');
  }
  for (const key of [
    'rootAria', 'position', 'lap', 'time', 'best', 'speedUnit', 'gear', 'powerup',
    'health', 'shield', 'feed', 'wrongWay', 'countdown', 'speedGauge', 'cooldown',
    'charges', 'missing', 'emptyGlyph', 'unknownGlyph'
  ]) {
    if (labelText(hudDoc.labels[key], null) === null) {
      throw new TypeError('createHud({ doc, host, now }): doc.labels.' + key + ' is missing');
    }
  }
  const document = host.ownerDocument;
  if (!document || typeof document.createElement !== 'function') {
    throw new Error('createHud: host.ownerDocument must provide createElement');
  }
  if (host.__blurHud) {
    throw new Error('createHud: host already owns a runtime HUD; call destroy() first');
  }

  const clock = typeof options.now === 'function' ? options.now : () => 0;
  const missingText = hudDoc.labels.missing.text;
  const metrics = { updates: 0, textWrites: 0, attrWrites: 0, feedRebuilds: 0 };
  const cache = Object.create(null);
  let destroyed = false;
  let onResize = null;
  let api = null;

  function element(tag, className, id) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (id) node.id = id;
    return node;
  }

  function textField(tag, className, id, name) {
    const node = element(tag, className, id);
    node.setAttribute('data-field', name);
    node.textContent = missingText;
    node.setAttribute('data-missing', '1');
    return node;
  }

  function staticLabel(tag, className, id, entry) {
    const node = element(tag, className, id);
    node.textContent = labelText(entry, missingText);
    return node;
  }

  function meterBar(name, id) {
    const track = element('div', 'blur-hud__bar-track');
    const fill = element('i', 'blur-hud__bar-fill blur-hud__bar-fill--' + name, id);
    fill.setAttribute('data-bar', name);
    fill.setAttribute('role', 'progressbar');
    fill.setAttribute('aria-label', labelText(hudDoc.labels[name], missingText));
    fill.setAttribute('aria-valuemin', '0');
    fill.setAttribute('aria-valuemax', '100');
    fill.setAttribute('data-missing', '1');
    fill.style.width = '0%';
    track.appendChild(fill);
    return { track, fill };
  }

  // ------------------------------------------------------------------ root
  const root = element('div', 'blur-hud', 'blur-hud');
  root.setAttribute('data-hud', HUD_SCHEMA);
  root.setAttribute('data-doc', hudDoc.schema ?? 'blur.hud-doc/1');
  root.setAttribute('data-art', 'project');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', labelText(hudDoc.labels.rootAria, missingText));
  host.appendChild(root);

  // --------------------------------------------------------------- status
  const statusCluster = element('div', 'blur-hud__cluster blur-hud__cluster--status');
  statusCluster.setAttribute('data-cluster', 'status');

  const positionCard = element('div', 'blur-hud__card blur-hud__card--position');
  positionCard.setAttribute('data-element', 'position');
  const positionLabel = staticLabel('span', 'blur-hud__label', null, hudDoc.labels.position);
  const positionNode = textField('span', 'blur-hud__value', 'blur-hud-position', 'position');
  const positionTotalNode = textField('span', 'blur-hud__value blur-hud__value--total',
    'blur-hud-position-total', 'position-total');
  positionCard.appendChild(positionLabel);
  positionCard.appendChild(positionNode);
  positionCard.appendChild(positionTotalNode);

  const lapCard = element('div', 'blur-hud__card blur-hud__card--lap');
  lapCard.setAttribute('data-element', 'lap');
  const lapLabel = staticLabel('span', 'blur-hud__label', null, hudDoc.labels.lap);
  const lapNode = textField('span', 'blur-hud__value', 'blur-hud-lap', 'lap');
  const lapTotalNode = textField('span', 'blur-hud__value blur-hud__value--total',
    'blur-hud-lap-total', 'lap-total');
  lapCard.appendChild(lapLabel);
  lapCard.appendChild(lapNode);
  lapCard.appendChild(lapTotalNode);

  const timeCard = element('div', 'blur-hud__card blur-hud__card--time');
  timeCard.setAttribute('data-element', 'time');
  const timeLabel = staticLabel('span', 'blur-hud__label', null, hudDoc.labels.time);
  const timeNode = textField('span', 'blur-hud__value', 'blur-hud-time', 'time');
  const bestLabel = staticLabel('span', 'blur-hud__label blur-hud__label--inline', null, hudDoc.labels.best);
  const bestLapNode = textField('span', 'blur-hud__value blur-hud__value--best',
    'blur-hud-best-lap', 'best-lap');
  timeCard.appendChild(timeLabel);
  timeCard.appendChild(timeNode);
  timeCard.appendChild(bestLabel);
  timeCard.appendChild(bestLapNode);

  statusCluster.appendChild(positionCard);
  statusCluster.appendChild(lapCard);
  statusCluster.appendChild(timeCard);
  root.appendChild(statusCluster);

  // ---------------------------------------------------------------- speed
  const speedCluster = element('div', 'blur-hud__cluster blur-hud__cluster--speed');
  speedCluster.setAttribute('data-cluster', 'speed');

  const speedCard = element('div', 'blur-hud__card blur-hud__card--speed');
  speedCard.setAttribute('data-element', 'speed');
  const speedGauge = element('div', 'blur-hud__gauge', 'blur-hud-speed-gauge');
  speedGauge.setAttribute('data-gauge', 'speed');
  speedGauge.setAttribute('role', 'progressbar');
  speedGauge.setAttribute('aria-label', labelText(hudDoc.labels.speedGauge, missingText));
  speedGauge.setAttribute('aria-valuemin', '0');
  speedGauge.setAttribute('aria-valuemax', '100');
  speedGauge.setAttribute('data-missing', '1');
  const speedGaugeTrack = element('div', 'blur-hud__gauge-track');
  speedGaugeTrack.setAttribute('aria-hidden', 'true');
  const speedGaugeTicks = element('div', 'blur-hud__gauge-ticks');
  speedGaugeTicks.setAttribute('aria-hidden', 'true');
  const speedGaugeFill = element('div', 'blur-hud__gauge-fill');
  speedGaugeFill.setAttribute('aria-hidden', 'true');
  const speedGaugeDial = element('div', 'blur-hud__gauge-dial');
  const speedNode = textField('span', 'blur-hud__value blur-hud__value--speed',
    'blur-hud-speed', 'speed');
  const speedUnitNode = staticLabel('span', 'blur-hud__unit', 'blur-hud-speed-unit', hudDoc.labels.speedUnit);
  speedUnitNode.setAttribute('data-field', 'speed-unit');
  speedGaugeDial.appendChild(speedNode);
  speedGaugeDial.appendChild(speedUnitNode);
  speedGauge.appendChild(speedGaugeTrack);
  speedGauge.appendChild(speedGaugeTicks);
  speedGauge.appendChild(speedGaugeFill);
  speedGauge.appendChild(speedGaugeDial);
  speedCard.appendChild(speedGauge);

  const gearCard = element('div', 'blur-hud__card blur-hud__card--gear');
  gearCard.setAttribute('data-element', 'gear');
  gearCard.setAttribute('data-gear', 'missing');
  const gearLabel = staticLabel('span', 'blur-hud__label', null, hudDoc.labels.gear);
  const gearNode = textField('span', 'blur-hud__value', 'blur-hud-gear', 'gear');
  gearCard.appendChild(gearLabel);
  gearCard.appendChild(gearNode);

  speedCluster.appendChild(speedCard);
  speedCluster.appendChild(gearCard);
  root.appendChild(speedCluster);

  // -------------------------------------------------------------- power-up
  const powerupCluster = element('div', 'blur-hud__cluster blur-hud__cluster--powerup');
  powerupCluster.setAttribute('data-cluster', 'powerup');
  const powerupCard = element('div', 'blur-hud__card blur-hud__card--powerup');
  powerupCard.setAttribute('data-element', 'powerup');
  powerupCard.setAttribute('data-kind', 'missing');
  powerupCard.setAttribute('aria-label', labelText(hudDoc.labels.powerup, missingText));
  const powerupLabel = staticLabel('span', 'blur-hud__label', null, hudDoc.labels.powerup);
  const powerupRow = element('div', 'blur-hud__powerup-row');
  const cooldownRing = element('div', 'blur-hud__ring', 'blur-hud-powerup-cooldown');
  cooldownRing.setAttribute('data-gauge', 'cooldown');
  cooldownRing.setAttribute('role', 'progressbar');
  cooldownRing.setAttribute('aria-label', labelText(hudDoc.labels.cooldown, missingText));
  cooldownRing.setAttribute('aria-valuemin', '0');
  cooldownRing.setAttribute('aria-valuemax', '100');
  cooldownRing.setAttribute('data-missing', '1');
  const cooldownTrack = element('div', 'blur-hud__ring-track');
  cooldownTrack.setAttribute('aria-hidden', 'true');
  const cooldownFill = element('div', 'blur-hud__ring-fill');
  cooldownFill.setAttribute('aria-hidden', 'true');
  cooldownRing.appendChild(cooldownTrack);
  cooldownRing.appendChild(cooldownFill);
  const powerupGlyphNode = element('span', 'blur-hud__glyph', 'blur-hud-powerup-glyph');
  powerupGlyphNode.setAttribute('data-field', 'powerup-glyph');
  powerupGlyphNode.textContent = hudDoc.labels.emptyGlyph.text;
  powerupRow.appendChild(cooldownRing);
  powerupRow.appendChild(powerupGlyphNode);
  const powerupNode = textField('span', 'blur-hud__value', 'blur-hud-powerup', 'powerup');
  const powerupChargesNode = textField('span', 'blur-hud__charges',
    'blur-hud-powerup-charges', 'powerup-charges');
  powerupChargesNode.setAttribute('aria-label', labelText(hudDoc.labels.charges, missingText));
  const powerupDetailNode = element('span', 'blur-hud__detail', 'blur-hud-powerup-detail');
  powerupDetailNode.setAttribute('data-field', 'powerup-detail');
  powerupCard.appendChild(powerupLabel);
  powerupCard.appendChild(powerupRow);
  powerupCard.appendChild(powerupNode);
  powerupCard.appendChild(powerupChargesNode);
  powerupCard.appendChild(powerupDetailNode);
  powerupCluster.appendChild(powerupCard);
  root.appendChild(powerupCluster);

  // ---------------------------------------------------------------- meters
  const meterCluster = element('div', 'blur-hud__cluster blur-hud__cluster--meters');
  meterCluster.setAttribute('data-cluster', 'meters');

  const healthCard = element('div', 'blur-hud__meter blur-hud__meter--health');
  healthCard.setAttribute('data-element', 'health');
  const healthLabel = staticLabel('span', 'blur-hud__label', null, hudDoc.labels.health);
  const healthNode = textField('span', 'blur-hud__meter-text', 'blur-hud-health', 'health');
  const healthBar = meterBar('health', 'blur-hud-health-bar');
  healthCard.appendChild(healthLabel);
  healthCard.appendChild(healthNode);
  healthCard.appendChild(healthBar.track);

  const shieldCard = element('div', 'blur-hud__meter blur-hud__meter--shield');
  shieldCard.setAttribute('data-element', 'shield');
  const shieldLabel = staticLabel('span', 'blur-hud__label', null, hudDoc.labels.shield);
  const shieldNode = textField('span', 'blur-hud__meter-text', 'blur-hud-shield', 'shield');
  const shieldBar = meterBar('shield', 'blur-hud-shield-bar');
  shieldCard.appendChild(shieldLabel);
  shieldCard.appendChild(shieldNode);
  shieldCard.appendChild(shieldBar.track);

  meterCluster.appendChild(healthCard);
  meterCluster.appendChild(shieldCard);
  root.appendChild(meterCluster);

  // ------------------------------------------------------------------ feed
  const feedWrap = element('div', 'blur-hud__feed-wrap');
  feedWrap.setAttribute('data-element', 'feed-wrap');
  const feedLabel = staticLabel('span', 'blur-hud__label', null, hudDoc.labels.feed);
  const feed = element('ol', 'blur-hud__feed', 'blur-hud-feed');
  feed.setAttribute('data-field', 'feed');
  feed.setAttribute('data-element', 'feed');
  feed.setAttribute('aria-live', 'polite');
  feed.setAttribute('aria-label', labelText(hudDoc.labels.feed, missingText));
  feedWrap.appendChild(feedLabel);
  feedWrap.appendChild(feed);
  root.appendChild(feedWrap);

  // ------------------------------------------------------- overlays (hooks)
  const countdown = element('div', 'blur-hud__countdown', 'blur-hud-countdown');
  countdown.setAttribute('data-element', 'countdown');
  countdown.setAttribute('role', 'status');
  countdown.setAttribute('aria-live', 'assertive');
  countdown.setAttribute('aria-label', labelText(hudDoc.labels.countdown, missingText));
  countdown.setAttribute('hidden', '');
  const countdownLabelNode = textField('span', 'blur-hud__countdown-label',
    'blur-hud-countdown-label', 'countdown-label');
  const countdownSecondsNode = textField('span', 'blur-hud__countdown-seconds',
    'blur-hud-countdown-seconds', 'countdown-seconds');
  countdown.appendChild(countdownLabelNode);
  countdown.appendChild(countdownSecondsNode);
  root.appendChild(countdown);

  const wrongWayNode = element('div', 'blur-hud__wrongway', 'blur-hud-wrongway');
  wrongWayNode.setAttribute('data-element', 'wrongway');
  wrongWayNode.setAttribute('role', 'status');
  wrongWayNode.setAttribute('aria-live', 'assertive');
  wrongWayNode.setAttribute('hidden', '');
  wrongWayNode.textContent = labelText(hudDoc.labels.wrongWay, missingText);
  root.appendChild(wrongWayNode);

  const fieldNodes = {
    speed: speedNode,
    speedUnit: speedUnitNode,
    gear: gearNode,
    position: positionNode,
    positionTotal: positionTotalNode,
    lap: lapNode,
    lapTotal: lapTotalNode,
    time: timeNode,
    bestLap: bestLapNode,
    powerup: powerupNode,
    powerupGlyph: powerupGlyphNode,
    powerupCharges: powerupChargesNode,
    powerupDetail: powerupDetailNode,
    health: healthNode,
    shield: shieldNode,
    countdownLabel: countdownLabelNode,
    countdownSeconds: countdownSecondsNode
  };

  // --------------------------------------------------------------- writers
  function writeText(key, node, text, missing) {
    if (cache[key] !== text) {
      node.textContent = text;
      cache[key] = text;
      metrics.textWrites += 1;
    }
    const flag = missing === true;
    if (cache[key + '!'] !== flag) {
      if (flag) node.setAttribute('data-missing', '1');
      else node.removeAttribute('data-missing');
      cache[key + '!'] = flag;
      metrics.attrWrites += 1;
    }
  }

  function writeAttr(key, node, name, value) {
    if (cache[key] === value) return;
    node.setAttribute(name, value);
    cache[key] = value;
    metrics.attrWrites += 1;
  }

  function writeBar(key, node, percent, missing) {
    const pct = percent === null ? null : round1(clamp(percent, 0, 100));
    const width = pct === null ? '0%' : pct + '%';
    if (cache[key + ':width'] !== width) {
      node.style.width = width;
      cache[key + ':width'] = width;
      metrics.attrWrites += 1;
    }
    const aria = pct === null ? null : String(pct);
    if (cache[key + ':aria'] !== aria) {
      if (aria === null) node.removeAttribute('aria-valuenow');
      else node.setAttribute('aria-valuenow', aria);
      cache[key + ':aria'] = aria;
      metrics.attrWrites += 1;
    }
    const flag = missing === true;
    if (cache[key + ':missing'] !== flag) {
      if (flag) node.setAttribute('data-missing', '1');
      else node.removeAttribute('data-missing');
      cache[key + ':missing'] = flag;
      metrics.attrWrites += 1;
    }
  }

  /** Set a CSS custom property on both a real `CSSStyleDeclaration` and the shim. */
  function setVar(node, name, value) {
    if (node.style && typeof node.style.setProperty === 'function') {
      node.style.setProperty(name, value);
    } else if (node.style) {
      node.style[name] = value;
    }
  }

  /**
   * CSS-only gauge/ring. `data-percent` is the snapshot source of truth; the
   * `--gauge` custom property drives the conic-gradient fill.
   */
  function writeGauge(key, node, percent, missing) {
    const pct = percent === null ? null : round1(clamp(percent, 0, 100));
    const data = pct === null ? null : String(pct);
    if (cache[key + ':pct'] !== data) {
      if (data === null) node.removeAttribute('data-percent');
      else node.setAttribute('data-percent', data);
      cache[key + ':pct'] = data;
      metrics.attrWrites += 1;
    }
    const css = pct === null ? '0' : String(pct);
    if (cache[key + ':css'] !== css) {
      setVar(node, '--gauge', css);
      cache[key + ':css'] = css;
      metrics.attrWrites += 1;
    }
    const aria = pct === null ? null : String(pct);
    if (cache[key + ':aria'] !== aria) {
      if (aria === null) node.removeAttribute('aria-valuenow');
      else node.setAttribute('aria-valuenow', aria);
      cache[key + ':aria'] = aria;
      metrics.attrWrites += 1;
    }
    const flag = missing === true;
    if (cache[key + ':missing'] !== flag) {
      if (flag) node.setAttribute('data-missing', '1');
      else node.removeAttribute('data-missing');
      cache[key + ':missing'] = flag;
      metrics.attrWrites += 1;
    }
  }

  /** Toggle a boolean attribute (`hidden`) without touching it when unchanged. */
  function writeFlag(key, node, name, flag) {
    if (cache[key] === flag) return;
    if (flag) node.setAttribute(name, '');
    else node.removeAttribute(name);
    cache[key] = flag;
    metrics.attrWrites += 1;
  }

  function renderFeed(items, missing) {
    const signature = missing
      ? 'missing'
      : items.map((item) => item.kind + '\u0000' + item.text + '\u0000' + (item.missing ? '1' : '0')).join('\u0001');
    if (cache.feed === signature) return;
    cache.feed = signature;
    metrics.feedRebuilds += 1;
    feed.textContent = '';
    for (const item of items) {
      const row = element('li', 'blur-hud__feed-item');
      row.setAttribute('data-kind', item.kind);
      if (item.missing) row.setAttribute('data-missing', '1');
      row.textContent = item.text;
      feed.appendChild(row);
    }
    if (cache.feedMissing !== missing) {
      if (missing) feed.setAttribute('data-missing', '1');
      else feed.removeAttribute('data-missing');
      cache.feedMissing = missing;
      metrics.attrWrites += 1;
    }
    const empty = !missing && items.length === 0;
    if (cache.feedEmpty !== empty) {
      if (empty) feed.setAttribute('data-empty', '1');
      else feed.removeAttribute('data-empty');
      cache.feedEmpty = empty;
      metrics.attrWrites += 1;
    }
  }

  function applyViewport() {
    const width = typeof host.clientWidth === 'number' ? host.clientWidth : 0;
    const compact = width > 0 && width < 800;
    const value = compact ? '1' : '0';
    if (root.getAttribute('data-compact') !== value) {
      root.setAttribute('data-compact', value);
      metrics.attrWrites += 1;
    }
  }

  // ---------------------------------------------------------------- update
  function update(state) {
    if (destroyed) return false;
    metrics.updates += 1;
    const s = state && typeof state === 'object' ? state : EMPTY;
    const stamp = clock();
    const nowValue = finite(stamp) ? stamp : 0;

    const speed = finite(s.speedMps) ? Math.abs(s.speedMps) : null;
    const mph = speed === null ? null : Math.round(speed * hudDoc.format.speedFactor);
    writeText('speed', speedNode, mph === null ? missingText : String(mph), mph === null);

    const maxSpeed = finite(s.maxSpeedMps) && s.maxSpeedMps > 0 ? s.maxSpeedMps : null;
    const speedGaugePercent = speed === null || maxSpeed === null ? null : (speed / maxSpeed) * 100;
    writeGauge('speedGauge', speedGauge, speedGaugePercent, speedGaugePercent === null);

    const gear = parseGear(s.gear, hudDoc);
    writeText('gear', gearNode, gear.text === null ? missingText : gear.text, gear.text === null);
    writeAttr('gearState', gearCard, 'data-gear', gear.state);

    const position = positiveInt(s.position) ? s.position : null;
    const fieldSize = positiveInt(s.fieldSize) ? s.fieldSize : null;
    writeText('position', positionNode, position === null ? missingText : String(position), position === null);
    writeText('positionTotal', positionTotalNode, fieldSize === null
      ? missingText
      : hudDoc.format.valueSeparator + hudDoc.format.valueSeparatorSpace + fieldSize, fieldSize === null);

    const lap = positiveInt(s.lap) ? s.lap : null;
    const laps = positiveInt(s.laps) ? s.laps : null;
    writeText('lap', lapNode, lap === null ? missingText : String(lap), lap === null);
    writeText('lapTotal', lapTotalNode, laps === null
      ? missingText
      : hudDoc.format.valueSeparator + hudDoc.format.valueSeparatorSpace + laps, laps === null);

    const time = finite(s.timeSeconds) && s.timeSeconds >= 0 ? s.timeSeconds : null;
    writeText('time', timeNode, time === null ? missingText : formatRaceTime(time), time === null);
    const best = finite(s.bestLapSeconds) && s.bestLapSeconds >= 0 ? s.bestLapSeconds : null;
    writeText('bestLap', bestLapNode, best === null ? missingText : formatLapTime(best), best === null);

    const powerup = parsePowerup(s.powerup, hudDoc);
    writeText('powerup', powerupNode, powerup.label, powerup.missing);
    writeText('powerupGlyph', powerupGlyphNode, powerup.glyph, false);
    writeText('powerupCharges', powerupChargesNode, powerup.chargesText, powerup.chargesMissing);
    writeText('powerupDetail', powerupDetailNode, powerup.detail, powerup.detailMissing);
    writeAttr('powerupKind', powerupCard, 'data-kind', powerup.kind);
    writeGauge('cooldown', cooldownRing, powerup.cooldownPercent, powerup.cooldownPercent === null);

    const health = parseMeter(s.health, hudDoc);
    writeText('health', healthNode, health.text, health.missing);
    writeBar('healthBar', healthBar.fill, health.percent, health.missing);
    writeAttr('healthLevel', healthBar.fill, 'data-level', meterLevel(health.percent));

    const shield = parseMeter(s.shield, hudDoc);
    writeText('shield', shieldNode, shield.text, shield.missing);
    writeBar('shieldBar', shieldBar.fill, shield.percent, shield.missing);
    writeAttr('shieldLevel', shieldBar.fill, 'data-level', meterLevel(shield.percent));

    const feedState = parseFeed(s.feed, hudDoc, nowValue);
    renderFeed(feedState.items, feedState.missing);

    const countdownState = parseCountdown(s.countdown, hudDoc);
    writeText('countdownLabel', countdownLabelNode, countdownState.label, countdownState.labelMissing);
    writeText('countdownSeconds', countdownSecondsNode, countdownState.secondsText,
      countdownState.secondsMissing);
    writeFlag('countdownVisible', countdown, 'hidden', !countdownState.visible);

    writeFlag('wrongWayVisible', wrongWayNode, 'hidden', s.wrongWay !== true);

    return true;
  }

  // -------------------------------------------------------------- snapshot
  function readBar(node) {
    const aria = node.getAttribute('aria-valuenow');
    const missing = node.getAttribute('data-missing') === '1';
    const percent = aria === null ? null : Number(aria);
    return {
      percent: Number.isFinite(percent) ? percent : null,
      missing,
      level: node.getAttribute('data-level') ?? 'missing'
    };
  }

  function readGauge(node) {
    const raw = node.getAttribute('data-percent');
    const percent = raw === null ? null : Number(raw);
    return {
      percent: Number.isFinite(percent) ? percent : null,
      missing: node.getAttribute('data-missing') === '1'
    };
  }

  function snapshot() {
    if (destroyed) return null;
    const fields = {};
    for (const name of Object.keys(fieldNodes)) {
      const node = fieldNodes[name];
      fields[name] = {
        text: node.textContent,
        missing: node.getAttribute('data-missing') === '1'
      };
    }
    fields.powerup.kind = powerupCard.getAttribute('data-kind');
    const items = [];
    const rows = feed.children ? Array.from(feed.children) : [];
    for (const row of rows) {
      items.push({
        text: row.textContent,
        kind: row.getAttribute('data-kind') ?? 'info',
        missing: row.getAttribute('data-missing') === '1'
      });
    }
    return {
      schema: HUD_SCHEMA,
      labels: {
        root: root.getAttribute('aria-label'),
        position: positionLabel.textContent,
        lap: lapLabel.textContent,
        time: timeLabel.textContent,
        best: bestLabel.textContent,
        speedUnit: speedUnitNode.textContent,
        gear: gearLabel.textContent,
        powerup: powerupLabel.textContent,
        health: healthLabel.textContent,
        shield: shieldLabel.textContent,
        feed: feedLabel.textContent,
        wrongWay: wrongWayNode.textContent
      },
      fields,
      bars: {
        health: readBar(healthBar.fill),
        shield: readBar(shieldBar.fill)
      },
      gauges: {
        speed: readGauge(speedGauge),
        cooldown: readGauge(cooldownRing)
      },
      countdown: {
        visible: countdown.getAttribute('hidden') === null,
        missing: countdownLabelNode.getAttribute('data-missing') === '1'
          && countdownSecondsNode.getAttribute('data-missing') === '1'
      },
      wrongWay: {
        visible: wrongWayNode.getAttribute('hidden') === null
      },
      feed: {
        items,
        missing: feed.getAttribute('data-missing') === '1',
        empty: feed.getAttribute('data-empty') === '1'
      },
      layout: {
        compact: root.getAttribute('data-compact') === '1'
      }
    };
  }

  // --------------------------------------------------------------- destroy
  function destroy() {
    if (destroyed) return false;
    destroyed = true;
    const view = document.defaultView;
    if (onResize && view && typeof view.removeEventListener === 'function') {
      view.removeEventListener('resize', onResize);
      onResize = null;
    }
    if (root.parentNode) root.parentNode.removeChild(root);
    if (host.__blurHud === api) delete host.__blurHud;
    return true;
  }

  applyViewport();
  const view = document.defaultView;
  if (view && typeof view.addEventListener === 'function') {
    onResize = () => {
      if (!destroyed) applyViewport();
    };
    view.addEventListener('resize', onResize);
  }

  api = {
    schema: HUD_SCHEMA,
    element: root,
    update,
    snapshot,
    destroy,
    metrics: () => ({ ...metrics })
  };
  host.__blurHud = api;
  return api;
}
