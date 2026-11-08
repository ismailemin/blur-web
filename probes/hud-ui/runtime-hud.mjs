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
  if (seconds >= 60) return formatRaceTime(seconds);
  const ms = Math.round(seconds * 1000);
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
  if (typeof value === 'string') {
    type = value.length > 0 ? value : null;
  } else if (value && typeof value === 'object') {
    type = typeof value.type === 'string' && value.type.length > 0 ? value.type : null;
    charges = finite(value.charges) ? value.charges : null;
    secondsLeft = finite(value.secondsLeft) ? value.secondsLeft : null;
  }
  if (type === null) {
    return {
      type: null,
      label: missingText,
      glyph: hudDoc.labels.emptyGlyph.text,
      detail: '',
      kind: 'missing',
      missing: true
    };
  }
  const known = hudDoc.powerups[type] ?? null;
  const parts = [];
  if (charges !== null) parts.push(hudDoc.format.chargesPrefix + charges);
  if (secondsLeft !== null) parts.push(secondsLeft.toFixed(2) + ' ' + hudDoc.format.secondsSuffix);
  return {
    type,
    label: known ? known.label : type,
    glyph: known ? known.glyph : hudDoc.labels.unknownGlyph.text,
    detail: parts.join(' ' + hudDoc.format.detailSeparator + ' '),
    kind: known ? type.toLowerCase() : 'unknown',
    missing: false
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
    'health', 'shield', 'feed', 'missing', 'emptyGlyph', 'unknownGlyph'
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
  const speedNode = textField('span', 'blur-hud__value blur-hud__value--speed',
    'blur-hud-speed', 'speed');
  const speedUnitNode = staticLabel('span', 'blur-hud__unit', 'blur-hud-speed-unit', hudDoc.labels.speedUnit);
  speedUnitNode.setAttribute('data-field', 'speed-unit');
  speedCard.appendChild(speedNode);
  speedCard.appendChild(speedUnitNode);

  const gearCard = element('div', 'blur-hud__card blur-hud__card--gear');
  gearCard.setAttribute('data-element', 'gear');
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
  const powerupGlyphNode = element('span', 'blur-hud__glyph', 'blur-hud-powerup-glyph');
  powerupGlyphNode.setAttribute('data-field', 'powerup-glyph');
  powerupGlyphNode.textContent = hudDoc.labels.emptyGlyph.text;
  const powerupNode = textField('span', 'blur-hud__value', 'blur-hud-powerup', 'powerup');
  const powerupDetailNode = element('span', 'blur-hud__detail', 'blur-hud-powerup-detail');
  powerupDetailNode.setAttribute('data-field', 'powerup-detail');
  powerupCard.appendChild(powerupLabel);
  powerupCard.appendChild(powerupGlyphNode);
  powerupCard.appendChild(powerupNode);
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
    powerupDetail: powerupDetailNode,
    health: healthNode,
    shield: shieldNode
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

    let gearText = null;
    if (finite(s.gear)) {
      if (s.gear === 0) gearText = hudDoc.format.gearNeutral;
      else if (s.gear < 0) gearText = hudDoc.format.gearReverse;
      else gearText = String(s.gear);
    }
    writeText('gear', gearNode, gearText === null ? missingText : gearText, gearText === null);

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
    writeText('powerupDetail', powerupDetailNode, powerup.detail, false);
    writeAttr('powerupKind', powerupCard, 'data-kind', powerup.kind);

    const health = parseMeter(s.health, hudDoc);
    writeText('health', healthNode, health.text, health.missing);
    writeBar('healthBar', healthBar.fill, health.percent, health.missing);

    const shield = parseMeter(s.shield, hudDoc);
    writeText('shield', shieldNode, shield.text, shield.missing);
    writeBar('shieldBar', shieldBar.fill, shield.percent, shield.missing);

    const feedState = parseFeed(s.feed, hudDoc, nowValue);
    renderFeed(feedState.items, feedState.missing);

    return true;
  }

  // -------------------------------------------------------------- snapshot
  function readBar(node) {
    const aria = node.getAttribute('aria-valuenow');
    const missing = node.getAttribute('data-missing') === '1';
    const percent = aria === null ? null : Number(aria);
    return { percent: Number.isFinite(percent) ? percent : null, missing };
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
        feed: feedLabel.textContent
      },
      fields,
      bars: {
        health: readBar(healthBar.fill),
        shield: readBar(shieldBar.fill)
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
