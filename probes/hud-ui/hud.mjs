/**
 * Blur Web — HUD UI module (HUD2)
 *
 * Framework-free, display-only HUD for the browser Blur remake. It owns no
 * simulation state and no input handling: the caller feeds one `state` object
 * per frame (or per display tick) and fires one-shot events.
 *
 * Hard rules honoured here:
 *  - No guessed values. Every numeric field is optional; a missing / non-finite
 *    value renders as the typed placeholder `—` and the node carries
 *    `data-missing="1"`. `NaN` / `Infinity` never reach the screen.
 *  - Every visual element whose art is not a recovered retail asset is marked
 *    `data-art="project"` and the root carries a visible art note. A caller can
 *    supply a recovered power-up icon; it is marked `data-art="caller-supplied"`
 *    and only replaces the glyph after it loads.
 *  - The minimap consumes MINIMAP1 JSON if present and otherwise draws a
 *    labelled frame; it never invents track geometry.
 *  - The hot path creates no arrays, objects or closures. Only a displayed
 *    string is allocated, and only when its value actually changes.
 *
 * API (see docs/work/analysis/hud-ui.md):
 *   const hud = createHud(el, options)
 *   hud.update(state)
 *   hud.setEvent(event)
 *   hud.setMinimap(minimap1)
 *   hud.resize(width, height)
 *   hud.setScale(scale)
 *   hud.destroy()
 */

export const HUD_VERSION = 'HUD-UI/1';

/** Colour-blind-safe palette. Contrast pairs are tested in the unit suite. */
export const PALETTE = Object.freeze({
  ink: '#f5f8fb',
  dim: '#b9c6d2',
  panel: '#070b0f',
  cyan: '#5fd3ff',
  amber: '#ffc352',
  magenta: '#ff8ade',
  danger: '#ff7a66',
  ok: '#9af0c4'
});

/** Default glyph + label for each recovered power-up type. */
export const POWERUP_LABELS = Object.freeze({
  Bomb: { glyph: 'M', label: 'Bomb' },
  Shield: { glyph: 'S', label: 'Shield' },
  Repair: { glyph: 'R', label: 'Repair' },
  Nitrous: { glyph: 'N', label: 'Nitro' },
  Shock: { glyph: 'K', label: 'Shock' },
  Blindfire: { glyph: 'B', label: 'Blindfire' },
  Shunt: { glyph: 'T', label: 'Shunt' },
  Barge: { glyph: 'G', label: 'Barge' },
  SuperShield: { glyph: 'X', label: 'SuperShield' }
});

export const CONNECTION_LABELS = Object.freeze({
  connected: 'ONLINE',
  connecting: 'CONNECTING…',
  reconnecting: 'RECONNECTING',
  offline: 'OFFLINE',
  error: 'ERROR',
  solo: 'SOLO'
});

export const EVENT_TYPES = Object.freeze([
  'countdown',
  'go',
  'lap-complete',
  'finish',
  'warning',
  'powerup-pickup',
  'powerup-use',
  'hit',
  'wrecked',
  'respawn',
  'connection',
  'results',
  'reset'
]);

const INT_TEXT = new Array(1000);
for (let i = 0; i < INT_TEXT.length; i += 1) INT_TEXT[i] = String(i);

const EMPTY = Object.freeze({});
const PRIORITY = Object.freeze({ info: true, warn: true, danger: true });

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function num(value) {
  return isFiniteNumber(value) ? value : null;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function intText(value) {
  return value >= 0 && value < INT_TEXT.length && value === (value | 0)
    ? INT_TEXT[value]
    : String(value);
}

function pad3(value) {
  return value < 10 ? '00' + value : value < 100 ? '0' + value : String(value);
}

function hashText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash;
}

/** True when the value is usable MINIMAP1 track geometry. */
export function validateMinimap1(data) {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'missing' };
  if (data.version !== 'MINIMAP1') return { ok: false, reason: 'version' };
  const points = data.points;
  if (!Array.isArray(points) || points.length < 2) return { ok: false, reason: 'points' };
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (!point || !isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) {
      return { ok: false, reason: 'point-value', index: i };
    }
  }
  return { ok: true };
}

/**
 * Defensive minimap bounds. Explicit `bounds` / `transform` wins; otherwise the
 * track polyline bounds are measured. Returns null for degenerate geometry.
 */
export function minimapBounds(data) {
  if (!data || typeof data !== 'object') return null;
  const explicit = data.bounds || data.transform;
  if (explicit) {
    const minX = num(explicit.minX);
    const maxX = num(explicit.maxX);
    const minZ = num(explicit.minZ);
    const maxZ = num(explicit.maxZ);
    if (minX !== null && maxX !== null && minZ !== null && maxZ !== null && maxX > minX && maxZ > minZ) {
      return { minX, maxX, minZ, maxZ };
    }
  }
  const points = data.points;
  if (!Array.isArray(points) || points.length < 2) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (!point) continue;
    const x = point[0];
    const z = point[1];
    if (!isFiniteNumber(x) || !isFiniteNumber(z)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!(maxX > minX) || !(maxZ > minZ)) return null;
  return { minX, maxX, minZ, maxZ };
}

/** `m:ss.mmm` for a race clock; `—` for anything not a finite non-negative number. */
export function formatRaceTime(seconds) {
  const value = num(seconds);
  if (value === null || value < 0) return '—';
  const ms = Math.round(value * 1000);
  const minutes = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return minutes + ':' + (secs < 10 ? '0' : '') + secs + '.' + pad3(ms % 1000);
}

/** `ss.mmm` for a lap under a minute, `m:ss.mmm` above it. */
export function formatLapTime(seconds) {
  const value = num(seconds);
  if (value === null || value < 0) return '—';
  if (value >= 60) return formatRaceTime(value);
  const ms = Math.round(value * 1000);
  const secs = Math.floor(ms / 1000);
  return (secs < 10 ? '0' : '') + secs + '.' + pad3(ms % 1000);
}

/**
 * Signed delta. Negative seconds = the last lap was faster than the best lap
 * (ahead); positive = slower (behind). The sign is also spelled out in words so
 * colour is never the only carrier of meaning.
 */
export function formatDelta(seconds) {
  const value = num(seconds);
  if (value === null) return { text: '—', sign: 'none' };
  if (Math.abs(value) < 0.0005) return { text: 'level', sign: 'level' };
  const magnitude = Math.abs(value).toFixed(2);
  return value < 0
    ? { text: '▲ ' + magnitude + ' ahead', sign: 'ahead' }
    : { text: '▼ ' + magnitude + ' behind', sign: 'behind' };
}

/** WCAG relative-luminance contrast ratio for two `#rgb` / `#rrggbb` colours. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

function relativeLuminance(colour) {
  if (typeof colour !== 'string') return null;
  let hex = colour.trim();
  if (hex.charAt(0) !== '#') return null;
  hex = hex.slice(1);
  if (hex.length === 3) hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  const channels = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * Layout tokens for a viewport. Pure and allocation-light; callers use it for
 * tests and for the DOM variables set on resize. `scale` is a user factor on
 * top of the 1920x1080 base; safe areas are independent of it.
 */
export function layoutFor(width, height, scale = 1, options = EMPTY) {
  const w = isFiniteNumber(width) && width > 0 ? width : 1920;
  const h = isFiniteNumber(height) && height > 0 ? height : 1080;
  const userScale = clamp(isFiniteNumber(scale) ? scale : 1, 0.75, 2);
  const aspect = w / h;
  const base = Math.min(w / 1920, h / 1080);
  const effective = clamp(base * userScale, 0.62, 2.4);
  const compact = h < 800;
  const ultrawide = aspect >= 21 / 9;
  const safeX = Math.round(clamp(Math.max(16, w * 0.022), 16, 56));
  const safeY = Math.round(clamp(Math.max(12, h * 0.02), 12, 48));
  const tacho = Math.round(clamp((compact ? 134 : 170) * effective, 96, 280));
  const minimap = Math.round(clamp((compact ? 124 : 158) * effective, 92, 260));
  const font = Math.round(clamp(16 * effective, 12, 30));
  const wideOffset = ultrawide ? Math.round(Math.min(160, (w - (h * 21) / 9) * 0.5)) : 0;
  const resultsWidth = Math.round(clamp(w * 0.46, 420, 880));
  const dprOption = num(options.dpr);
  const dpr = clamp(dprOption === null ? 1 : dprOption, 1, 3);
  return {
    width: w,
    height: h,
    scale: userScale,
    aspect,
    base,
    effectiveScale: effective,
    compact,
    ultrawide,
    safeX,
    safeY,
    tacho,
    minimap,
    font,
    wideOffset,
    resultsWidth,
    dpr
  };
}

/**
 * Create a HUD inside `host`.
 *
 * @param {object} host  an element that accepts `appendChild`.
 * @param {object} [options]
 * @param {number} [options.scale=1]             0.75..2
 * @param {boolean} [options.reducedMotion]      auto-detected via matchMedia
 * @param {string} [options.units='both']        'metric' | 'imperial' | 'both'
 * @param {boolean} [options.artBadge=true]      show the non-retail art note
 * @param {number} [options.resultsLimit=8]      result rows kept in the pool
 * @param {object} [options.minimap=null]        MINIMAP1 document
 * @param {object} [options.viewport]            {width,height} initial layout
 * @param {number} [options.dpr]                 canvas device-pixel ratio
 * @param {Function} [options.now]               clock for event expiry (ms)
 */
export function createHud(host, options = EMPTY) {
  if (!host || typeof host.appendChild !== 'function') {
    throw new TypeError('createHud(host, options): host must be a DOM element');
  }
  if (host.__hudUi) {
    throw new Error('createHud: host already owns a HUD; call destroy() first');
  }
  const doc = host.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) throw new Error('createHud: no document available');

  const opt = {
    scale: clamp(isFiniteNumber(options.scale) ? options.scale : 1, 0.75, 2),
    units: options.units === 'metric' || options.units === 'imperial' ? options.units : 'both',
    artBadge: options.artBadge !== false,
    resultsLimit: clamp(isFiniteNumber(options.resultsLimit) ? Math.round(options.resultsLimit) : 8, 1, 16),
    reducedMotion: options.reducedMotion === true,
    autoDraw: options.autoDraw !== false,
    dpr: num(options.dpr),
    now: typeof options.now === 'function' ? options.now : defaultNow
  };
  if (options.reducedMotion !== true && typeof host.ownerDocument?.defaultView?.matchMedia === 'function') {
    try {
      opt.reducedMotion = host.ownerDocument.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
    } catch (error) {
      opt.reducedMotion = false;
    }
  }

  const viewport = {
    width: num(options.viewport?.width) ?? 1920,
    height: num(options.viewport?.height) ?? 1080
  };
  if (typeof host.clientWidth === 'number' && host.clientWidth > 0 &&
      (!options.viewport || !isFiniteNumber(options.viewport.width))) {
    viewport.width = host.clientWidth;
    viewport.height = host.clientHeight > 0 ? host.clientHeight : viewport.height;
  }

  const fields = Object.create(null);
  const bars = Object.create(null);
  const metrics = {
    updates: 0,
    textWrites: 0,
    attrWrites: 0,
    canvasDraws: 0,
    tachoDraws: 0,
    minimapDraws: 0,
    skippedFrames: 0,
    lastUpdateMs: 0,
    maxUpdateMs: 0
  };

  const root = element(doc, 'div', 'hud-root');
  root.setAttribute('data-hud', 'hud-ui');
  root.setAttribute('data-version', HUD_VERSION);
  root.setAttribute('data-art', 'project');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'race HUD, display only');
  host.appendChild(root);

  const frame = element(doc, 'div', 'hud-frame');
  root.appendChild(frame);

  // ---------------------------------------------------------------- top left
  const tl = layer(doc, 'top-left');
  frame.appendChild(tl);

  const positionCard = card(doc, tl, 'position', 'POSITION');
  const positionValue = value(doc, 'position');
  const positionOf = value(doc, 'position-total');
  positionCard.body.appendChild(positionValue.node);
  positionCard.body.appendChild(positionOf.node);

  const lapCard = card(doc, tl, 'lap', 'LAP');
  const lapValue = value(doc, 'lap');
  const lapOf = value(doc, 'lap-total');
  lapCard.body.appendChild(lapValue.node);
  lapCard.body.appendChild(lapOf.node);

  const raceCard = card(doc, tl, 'race-time', 'RACE');
  const raceValue = value(doc, 'race-time');
  raceCard.body.appendChild(raceValue.node);

  const splitCard = card(doc, tl, 'lap-splits', 'LAPS');
  const lastLap = value(doc, 'last-lap');
  const bestLap = value(doc, 'best-lap');
  const delta = value(doc, 'delta');
  splitCard.body.appendChild(tagged(doc, 'LAST', lastLap.node));
  splitCard.body.appendChild(tagged(doc, 'BEST', bestLap.node));
  splitCard.body.appendChild(delta.node);

  // --------------------------------------------------------------- top right
  const tr = layer(doc, 'top-right');
  frame.appendChild(tr);

  const minimapCard = element(doc, 'div', 'hud-card hud-minimap');
  minimapCard.setAttribute('data-art', 'project');
  minimapCard.setAttribute('data-element', 'minimap');
  minimapCard.setAttribute('aria-label', 'minimap frame');
  const minimapCanvas = element(doc, 'canvas', 'hud-canvas hud-canvas-minimap');
  minimapCanvas.setAttribute('data-canvas', 'minimap');
  minimapCanvas.setAttribute('aria-hidden', 'true');
  const minimapNote = minitext(doc, 'minimap-note');
  minimapCard.appendChild(minimapCanvas);
  minimapCard.appendChild(minimapNote.node);
  tr.appendChild(minimapCard);

  const connectionCard = element(doc, 'div', 'hud-card hud-connection');
  connectionCard.setAttribute('data-art', 'project');
  connectionCard.setAttribute('data-element', 'connection');
  connectionCard.setAttribute('role', 'status');
  const connectionValue = value(doc, 'connection');
  const latencyValue = minitext(doc, 'latency');
  connectionCard.appendChild(connectionValue.node);
  connectionCard.appendChild(latencyValue.node);
  tr.appendChild(connectionCard);

  // ------------------------------------------------------------- bottom left
  const bl = layer(doc, 'bottom-left');
  frame.appendChild(bl);

  const powerupCard = element(doc, 'div', 'hud-card hud-powerup');
  powerupCard.setAttribute('data-art', 'project');
  powerupCard.setAttribute('data-element', 'powerup');
  powerupCard.setAttribute('data-kind', 'empty');
  const powerupIcon = element(doc, 'div', 'hud-powerup-icon');
  powerupIcon.setAttribute('data-icon', 'fallback');
  const powerupGlyph = element(doc, 'span', 'hud-powerup-glyph');
  powerupGlyph.textContent = '·';
  powerupIcon.appendChild(powerupGlyph);
  const powerupImage = element(doc, 'img', 'hud-powerup-image');
  powerupImage.setAttribute('alt', 'power-up icon');
  powerupImage.hidden = true;
  powerupIcon.appendChild(powerupImage);
  const powerupText = element(doc, 'div', 'hud-powerup-text');
  const powerupType = value(doc, 'powerup-type');
  const powerupDetail = minitext(doc, 'powerup-detail');
  powerupText.appendChild(powerupType.node);
  powerupText.appendChild(powerupDetail.node);
  powerupCard.appendChild(powerupIcon);
  powerupCard.appendChild(powerupText);
  bl.appendChild(powerupCard);

  const healthCard = meterCard(doc, 'health', 'HEALTH', 'health');
  const shieldCard = meterCard(doc, 'shield', 'SHIELD', 'shield');
  const boostCard = meterCard(doc, 'boost', 'BOOST', 'boost');
  bl.appendChild(healthCard.shell);
  bl.appendChild(shieldCard.shell);
  bl.appendChild(boostCard.shell);

  // ------------------------------------------------------------ bottom right
  const br = layer(doc, 'bottom-right');
  frame.appendChild(br);

  const speedCard = element(doc, 'div', 'hud-card hud-speed');
  speedCard.setAttribute('data-art', 'project');
  speedCard.setAttribute('data-element', 'speed');
  const speedKmh = value(doc, 'speed-kmh');
  speedKmh.node.classList.add('hud-speed-number');
  const speedKmhUnit = unit(doc, 'km/h');
  const speedMph = value(doc, 'speed-mph');
  speedMph.node.classList.add('hud-speed-number', 'hud-speed-number-small');
  const speedMphUnit = unit(doc, 'mph');
  speedCard.appendChild(speedKmh.node);
  speedCard.appendChild(speedKmhUnit);
  speedCard.appendChild(speedMph.node);
  speedCard.appendChild(speedMphUnit);
  br.appendChild(speedCard);

  const gearCard = card(doc, br, 'gear', 'GEAR');
  const gearValue = value(doc, 'gear');
  gearValue.node.classList.add('hud-gear-number');
  gearCard.body.appendChild(gearValue.node);

  const tachoCard = element(doc, 'div', 'hud-card hud-tacho');
  tachoCard.setAttribute('data-art', 'project');
  tachoCard.setAttribute('data-element', 'tacho');
  const tachoCanvas = element(doc, 'canvas', 'hud-canvas hud-canvas-tacho');
  tachoCanvas.setAttribute('data-canvas', 'tacho');
  tachoCanvas.setAttribute('aria-hidden', 'true');
  const rpmText = minitext(doc, 'rpm');
  tachoCard.appendChild(tachoCanvas);
  tachoCard.appendChild(rpmText.node);
  br.appendChild(tachoCard);

  // ------------------------------------------------------------------ centre
  const centre = layer(doc, 'center');
  frame.appendChild(centre);

  const countdown = element(doc, 'div', 'hud-countdown');
  countdown.setAttribute('data-element', 'countdown');
  countdown.setAttribute('data-field', 'countdown');
  countdown.setAttribute('data-art', 'project');
  countdown.setAttribute('aria-live', 'assertive');
  countdown.hidden = true;
  centre.appendChild(countdown);

  const banner = element(doc, 'div', 'hud-banner');
  banner.setAttribute('data-element', 'banner');
  banner.setAttribute('data-field', 'banner');
  banner.setAttribute('data-art', 'project');
  banner.setAttribute('role', 'status');
  banner.hidden = true;
  centre.appendChild(banner);

  const warning = element(doc, 'div', 'hud-warning');
  warning.setAttribute('data-element', 'warning');
  warning.setAttribute('data-field', 'warning');
  warning.setAttribute('data-art', 'project');
  warning.setAttribute('role', 'alert');
  warning.hidden = true;
  centre.appendChild(warning);

  // ----------------------------------------------------------------- results
  const results = element(doc, 'div', 'hud-results');
  results.setAttribute('data-element', 'results');
  results.setAttribute('data-art', 'project');
  results.setAttribute('role', 'table');
  results.setAttribute('aria-label', 'race results');
  results.hidden = true;
  const resultsTitle = element(doc, 'div', 'hud-results-title');
  resultsTitle.textContent = 'RACE RESULTS';
  const resultsHead = element(doc, 'div', 'hud-results-row hud-results-head');
  resultsHead.setAttribute('role', 'row');
  resultsHead.appendChild(headCell(doc, 'POS', 'hud-col-pos'));
  resultsHead.appendChild(headCell(doc, 'DRIVER', 'hud-col-name'));
  resultsHead.appendChild(headCell(doc, 'TIME', 'hud-col-time'));
  resultsHead.appendChild(headCell(doc, 'BEST LAP', 'hud-col-best'));
  const resultsBody = element(doc, 'div', 'hud-results-body');
  resultsBody.setAttribute('role', 'rowgroup');
  results.appendChild(resultsTitle);
  results.appendChild(resultsHead);
  results.appendChild(resultsBody);
  centre.appendChild(results);

  const artNote = element(doc, 'div', 'hud-artnote');
  artNote.setAttribute('data-element', 'art-note');
  artNote.setAttribute('data-art', 'project');
  artNote.textContent = 'HUD-UI · project layout · retail HUD art not applied';
  artNote.hidden = !opt.artBadge;
  frame.appendChild(artNote);

  const live = element(doc, 'div', 'hud-sr');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('data-element', 'live');
  live.setAttribute('data-field', 'live');
  live.setAttribute('data-art', 'project');
  frame.appendChild(live);

  // Register every text field once; update() only touches these nodes.
  register(fields, 'countdown', countdown);
  register(fields, 'banner', banner);
  register(fields, 'warning', warning);
  register(fields, 'position', positionValue.node);
  register(fields, 'position-total', positionOf.node);
  register(fields, 'lap', lapValue.node);
  register(fields, 'lap-total', lapOf.node);
  register(fields, 'race-time', raceValue.node);
  register(fields, 'last-lap', lastLap.node);
  register(fields, 'best-lap', bestLap.node);
  register(fields, 'delta', delta.node);
  register(fields, 'connection', connectionValue.node);
  register(fields, 'latency', latencyValue.node);
  register(fields, 'powerup-type', powerupType.node);
  register(fields, 'powerup-detail', powerupDetail.node);
  register(fields, 'health-text', healthCard.text.node);
  register(fields, 'shield-text', shieldCard.text.node);
  register(fields, 'boost-text', boostCard.text.node);
  register(fields, 'speed-kmh', speedKmh.node);
  register(fields, 'speed-mph', speedMph.node);
  register(fields, 'gear', gearValue.node);
  register(fields, 'rpm', rpmText.node);
  register(fields, 'minimap-note', minimapNote.node);
  register(fields, 'live', live);

  registerBar(bars, 'health', healthCard.fill);
  registerBar(bars, 'shield', shieldCard.fill);
  registerBar(bars, 'boost', boostCard.fill);

  const self = {
    host,
    root,
    document: doc,
    layout: null,
    fields,
    bars,
    metrics,
    options: opt,
    destroyed: false,
    minimap: null,
    nodes: {
      positionCard: positionCard.shell,
      healthCard: healthCard.shell,
      boostCard: boostCard.shell,
      powerupCard,
      powerupGlyph,
      powerupImage,
      powerupIcon,
      minimapCanvas,
      minimapNote: minimapNote.node,
      tachoCanvas,
      connectionCard,
      results,
      resultsBody,
      artNote,
      speedKmh: speedKmh.node,
      speedKmhUnit,
      speedMph: speedMph.node,
      speedMphUnit
    },
    _viewport: viewport,
    _ctxTacho: null,
    _ctxMinimap: null,
    _tacho: { staticCanvas: null, staticCtx: null, key: '', w: 0, h: 0, rpm: null, max: null, redline: null },
    _tachoDirty: true,
    _mm: null,
    _mmKey: '',
    _mmSig: null,
    _mmStatic: null,
    _projectScratch: [0, 0],
    _banner: null,
    _bannerUntil: 0,
    _warning: null,
    _warningUntil: 0,
    _countdownOverride: null,
    _countdownUntil: 0,
    _eventResults: null,
    _resultSignature: null,
    _resultRows: [],
    _resultLimit: opt.resultsLimit,
    _iconUrl: null,
    _iconLoaded: false,
    _puSrc: { type: undefined, charges: undefined, seconds: undefined },
    _healthSrc: { current: undefined, max: undefined },
    _lastLapSrc: undefined,
    _bestLapSrc: undefined,
    _deltaSrc: undefined,
    _raceSrc: undefined,
    _rpmSrc: undefined,
    _positionSrc: undefined,
    _positionTotalSrc: undefined,
    _lapSrc: undefined,
    _lapTotalSrc: undefined,
    _connectionSrc: undefined,
    _latencySrc: undefined,
    _countdownSrc: undefined,
    _attrCache: Object.create(null),
    _flags: Object.create(null),
    _windowResize: null,
    _lastCars: null
  };

  powerupImage.addEventListener?.('load', () => {
    if (self.destroyed) return;
    self._iconLoaded = true;
    powerupImage.hidden = false;
    powerupGlyph.hidden = true;
    powerupIcon.setAttribute('data-icon', 'image');
    powerupIcon.setAttribute('data-art', 'caller-supplied');
  });
  powerupImage.addEventListener?.('error', () => {
    self._iconLoaded = false;
    powerupImage.hidden = true;
    powerupImage.removeAttribute('src');
    powerupGlyph.hidden = false;
    powerupIcon.setAttribute('data-icon', 'fallback');
    powerupIcon.removeAttribute('data-art');
  });

  applyLayout(self);
  setMinimap(self, options.minimap ?? null);

  const api = {
    element: root,
    version: HUD_VERSION,
    update: (state) => updateHud(self, state),
    setEvent: (event) => setEvent(self, event),
    setMinimap: (data) => setMinimap(self, data),
    resize: (width, height) => resizeHud(self, width, height),
    setScale: (scale) => setScale(self, scale),
    setOptions: (next) => setOptions(self, next),
    metrics: () => metrics,
    readFields: () => readFields(self),
    destroy: () => destroy(self),
    layout: () => self.layout
  };
  host.__hudUi = api;

  if (typeof host.ownerDocument?.defaultView?.addEventListener === 'function') {
    try {
      const onResize = () => {
        if (self.destroyed) return;
        const w = host.clientWidth;
        const h = host.clientHeight;
        if (w > 0 && h > 0) resizeHud(self, w, h);
      };
      host.ownerDocument.defaultView.addEventListener('resize', onResize);
      self._windowResize = onResize;
    } catch (error) {
      self._windowResize = null;
    }
  }

  return api;
}

// ---------------------------------------------------------------- internals

function defaultNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function defaultDpr() {
  if (typeof window !== 'undefined' && isFiniteNumber(window.devicePixelRatio)) return window.devicePixelRatio;
  return 1;
}

function element(doc, tag, className) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

function layer(doc, name) {
  const node = element(doc, 'div', 'hud-layer hud-layer-' + name);
  node.setAttribute('data-layer', name);
  return node;
}

function card(doc, parent, name, title) {
  const shell = element(doc, 'div', 'hud-card hud-card-' + name);
  shell.setAttribute('data-art', 'project');
  shell.setAttribute('data-element', name);
  const labelNode = element(doc, 'span', 'hud-label');
  labelNode.textContent = title;
  const body = element(doc, 'div', 'hud-card-body');
  shell.appendChild(labelNode);
  shell.appendChild(body);
  parent.appendChild(shell);
  return { shell, body };
}

function value(doc, name) {
  const node = element(doc, 'span', 'hud-value');
  node.setAttribute('data-field', name);
  return { node };
}

function minitext(doc, name) {
  const node = element(doc, 'span', 'hud-mini');
  node.setAttribute('data-field', name);
  return { node };
}

function unit(doc, text) {
  const node = element(doc, 'span', 'hud-unit');
  node.textContent = text;
  return node;
}

function tagged(doc, title, valueNode) {
  const wrap = element(doc, 'span', 'hud-tagged');
  const labelNode = element(doc, 'span', 'hud-tag');
  labelNode.textContent = title;
  wrap.appendChild(labelNode);
  wrap.appendChild(valueNode);
  return wrap;
}

function meterCard(doc, name, title, barName) {
  const shell = element(doc, 'div', 'hud-card hud-meter hud-meter-' + name);
  shell.setAttribute('data-art', 'project');
  shell.setAttribute('data-element', name);
  const head = element(doc, 'div', 'hud-meter-head');
  const labelNode = element(doc, 'span', 'hud-label');
  labelNode.textContent = title;
  head.appendChild(labelNode);
  const text = minitext(doc, name + '-text');
  head.appendChild(text.node);
  const track = element(doc, 'div', 'hud-bar-track');
  const fill = element(doc, 'i', 'hud-bar-fill hud-bar-' + barName);
  fill.setAttribute('data-bar', barName);
  fill.setAttribute('role', 'progressbar');
  fill.setAttribute('aria-label', title.toLowerCase());
  fill.setAttribute('aria-valuemin', '0');
  fill.setAttribute('aria-valuemax', '100');
  track.appendChild(fill);
  shell.appendChild(head);
  shell.appendChild(track);
  return { shell, text, fill, track };
}

function headCell(doc, text, className) {
  const cell = element(doc, 'span', 'hud-cell ' + className);
  cell.setAttribute('role', 'columnheader');
  cell.textContent = text;
  return cell;
}

function register(fields, name, node) {
  fields[name] = { node, text: null, missing: false };
}

function registerBar(bars, name, node) {
  bars[name] = { node, pct: -1 };
}

function setupCanvas(canvas, cssWidth, cssHeight, dpr) {
  if (!canvas) return null;
  const ratio = clamp(isFiniteNumber(dpr) ? dpr : 1, 1, 3);
  canvas.width = Math.max(1, Math.round(cssWidth * ratio));
  canvas.height = Math.max(1, Math.round(cssHeight * ratio));
  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (ctx && typeof ctx.setTransform === 'function') ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

function write(self, name, text, missing) {
  const record = self.fields[name];
  if (!record) return false;
  let wrote = false;
  if (record.text !== text) {
    record.node.textContent = text;
    record.text = text;
    self.metrics.textWrites += 1;
    wrote = true;
  }
  const flag = missing === true;
  if (record.missing !== flag) {
    if (flag) record.node.setAttribute('data-missing', '1');
    else record.node.removeAttribute('data-missing');
    record.missing = flag;
    self.metrics.attrWrites += 1;
    wrote = true;
  }
  return wrote;
}

function show(self, name, visible) {
  const record = self.fields[name];
  if (!record) return;
  if (record.node.hidden !== !visible) record.node.hidden = !visible;
}

function setFlag(self, key, node, on) {
  if (!node) return;
  if (self._flags[key] === on) return;
  self._flags[key] = on;
  if (on) node.setAttribute('data-flag', key);
  else node.removeAttribute('data-flag');
}

function setAttr(self, key, node, name, value) {
  if (self._attrCache[key] === value) return;
  self._attrCache[key] = value;
  node.setAttribute(name, value);
  self.metrics.attrWrites += 1;
}

function bar(self, name, percent) {
  const record = self.bars[name];
  if (!record) return;
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  if (record.pct === pct) return;
  record.pct = pct;
  record.node.style.width = pct + '%';
  record.node.setAttribute('aria-valuenow', String(pct));
  self.metrics.attrWrites += 1;
}

function applyLayout(self) {
  const layout = layoutFor(self._viewport.width, self._viewport.height, self.options.scale, { dpr: self.options.dpr ?? defaultDpr() });
  self.layout = layout;
  const style = self.root.style;
  style.setProperty('--hud-scale', String(Math.round(layout.scale * 100) / 100));
  style.setProperty('--hud-safe-x', layout.safeX + 'px');
  style.setProperty('--hud-safe-y', layout.safeY + 'px');
  style.setProperty('--hud-font', layout.font + 'px');
  style.setProperty('--hud-tacho', layout.tacho + 'px');
  style.setProperty('--hud-minimap', layout.minimap + 'px');
  style.setProperty('--hud-results-width', layout.resultsWidth + 'px');
  style.setProperty('--hud-wide-offset', layout.wideOffset + 'px');
  self.root.setAttribute('data-compact', layout.compact ? '1' : '0');
  self.root.setAttribute('data-ultrawide', layout.ultrawide ? '1' : '0');
  self.root.setAttribute('data-reduced-motion', self.options.reducedMotion ? '1' : '0');
  self.root.setAttribute('data-scale', String(layout.scale));

  const tacho = self._tacho;
  tacho.w = layout.tacho;
  tacho.h = layout.tacho;
  self._ctxTacho = setupCanvas(self.nodes.tachoCanvas, layout.tacho, layout.tacho, layout.dpr);
  tacho.key = '';
  tacho.staticCanvas = null;
  tacho.staticCtx = null;

  self._ctxMinimap = setupCanvas(self.nodes.minimapCanvas, layout.minimap, layout.minimap, layout.dpr);
  self._mmKey = '';
  self._mmStatic = null;
  self._mmSig = null;
  self._tachoDirty = true;

  const metric = self.options.units !== 'imperial';
  const imperial = self.options.units !== 'metric';
  self.nodes.speedKmh.hidden = !metric;
  self.nodes.speedKmhUnit.hidden = !metric;
  self.nodes.speedMph.hidden = !imperial;
  self.nodes.speedMphUnit.hidden = !imperial;
}

function resizeHud(self, width, height) {
  if (self.destroyed) return self.layout;
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) return self.layout;
  self._viewport.width = width;
  self._viewport.height = height;
  applyLayout(self);
  return self.layout;
}

function setScale(self, scale) {
  if (self.destroyed) return self.layout;
  if (!isFiniteNumber(scale)) return self.layout;
  self.options.scale = clamp(scale, 0.75, 2);
  applyLayout(self);
  return self.layout;
}

function setOptions(self, next) {
  if (self.destroyed || !next) return;
  if (isFiniteNumber(next.scale)) self.options.scale = clamp(next.scale, 0.75, 2);
  if (next.units === 'metric' || next.units === 'imperial' || next.units === 'both') self.options.units = next.units;
  if (next.reducedMotion === true || next.reducedMotion === false) self.options.reducedMotion = next.reducedMotion;
  if (next.artBadge === true || next.artBadge === false) {
    self.options.artBadge = next.artBadge;
    self.nodes.artNote.hidden = !next.artBadge;
  }
  applyLayout(self);
}

function setMinimap(self, data) {
  if (self.destroyed) return false;
  const check = validateMinimap1(data);
  const bounds = check.ok ? minimapBounds(data) : null;
  if (!check.ok || !bounds) {
    self._mm = null;
    self._mmKey = '';
    self._mmSig = null;
    self._mmStatic = null;
    const detail = check.ok ? 'degenerate-bounds' : check.reason + (check.index === undefined ? '' : ':' + check.index);
    write(self, 'minimap-note', 'MINIMAP1 unavailable · ' + detail, true);
    self.nodes.minimapNote.setAttribute('data-status', 'unsupported');
    self.nodes.minimapNote.setAttribute('data-reason', detail);
    drawMinimap(self, true);
    return false;
  }
  self._mm = {
    data,
    bounds,
    label: typeof data.map === 'string' ? data.map : (typeof data.label === 'string' ? data.label : 'track'),
    source: typeof data.source === 'string' ? data.source : null,
    closed: data.closed === true
  };
  self._mmKey = '';
  self._mmSig = null;
  self._mmStatic = null;
  self.nodes.minimapNote.setAttribute('data-status', 'ok');
  self.nodes.minimapNote.removeAttribute('data-reason');
  write(self, 'minimap-note', 'MINIMAP1 · ' + self._mm.label + (self._mm.source ? ' · ' + self._mm.source : ''), false);
  drawMinimap(self, true);
  return true;
}

function updateHud(self, state) {
  if (self.destroyed) return false;
  const started = self.options.now();
  const s = state && typeof state === 'object' ? state : EMPTY;
  const local = s.local && typeof s.local === 'object' ? s.local : EMPTY;
  const course = s.course && typeof s.course === 'object' ? s.course : EMPTY;
  const timing = s.timing && typeof s.timing === 'object' ? s.timing : EMPTY;
  const session = s.session && typeof s.session === 'object' ? s.session : EMPTY;

  self.metrics.updates += 1;

  // Event banners expire independently of the state feed.
  if (self._bannerUntil !== 0 && started >= self._bannerUntil) {
    self._banner = null;
    self._bannerUntil = 0;
  }
  if (self._warningUntil !== 0 && started >= self._warningUntil) {
    self._warning = null;
    self._warningUntil = 0;
  }
  if (self._countdownUntil !== 0 && started >= self._countdownUntil) {
    self._countdownOverride = null;
    self._countdownUntil = 0;
  }

  // --- speed / gear / rpm ------------------------------------------------
  const speed = num(local.speedMps);
  const kmh = speed === null ? null : Math.round(Math.max(0, speed) * 3.6);
  const mph = speed === null ? null : Math.round(Math.max(0, speed) * 2.2369362920544);
  write(self, 'speed-kmh', kmh === null ? '—' : intText(kmh), kmh === null);
  write(self, 'speed-mph', mph === null ? '—' : intText(mph), mph === null);

  const gear = num(local.gear);
  write(self, 'gear', gear === null ? '—' : gear === 0 ? 'N' : gear < 0 ? 'R' : intText(gear), gear === null);

  const rpm = num(local.rpm);
  const rpmMax = num(local.rpmMax);
  const redline = num(local.redline);
  if (rpm !== self._rpmSrc) {
    self._rpmSrc = rpm;
    write(self, 'rpm', rpm === null ? '— rpm' : Math.round(rpm) + ' rpm', rpm === null);
  }

  // --- position / lap ----------------------------------------------------
  const position = num(local.position);
  const positionTotal = num(local.totalPositions) ?? (Array.isArray(s.cars) ? s.cars.length : null);
  if (position !== self._positionSrc) {
    self._positionSrc = position;
    write(self, 'position', position === null ? '—' : 'P' + intText(position), position === null);
  }
  if (positionTotal !== self._positionTotalSrc) {
    self._positionTotalSrc = positionTotal;
    write(self, 'position-total', positionTotal === null || positionTotal <= 0 ? '' : '/' + intText(positionTotal), positionTotal === null);
  }

  const lap = num(local.lap);
  const lapTotal = num(course.laps);
  if (lap !== self._lapSrc) {
    self._lapSrc = lap;
    write(self, 'lap', lap === null ? '—' : intText(lap), lap === null);
  }
  if (lapTotal !== self._lapTotalSrc) {
    self._lapTotalSrc = lapTotal;
    write(self, 'lap-total', lapTotal === null || lapTotal <= 0 ? '' : '/' + intText(lapTotal), lapTotal === null);
  }

  // --- timers ------------------------------------------------------------
  const raceSeconds = num(timing.raceSeconds) ?? num(local.raceTimeSeconds);
  if (raceSeconds !== self._raceSrc) {
    self._raceSrc = raceSeconds;
    write(self, 'race-time', formatRaceTime(raceSeconds), raceSeconds === null);
  }

  const lastLapSeconds = num(local.lastLapSeconds);
  const bestLapSeconds = num(local.bestLapSeconds);
  if (lastLapSeconds !== self._lastLapSrc) {
    self._lastLapSrc = lastLapSeconds;
    write(self, 'last-lap', formatLapTime(lastLapSeconds), lastLapSeconds === null);
  }
  if (bestLapSeconds !== self._bestLapSrc) {
    self._bestLapSrc = bestLapSeconds;
    write(self, 'best-lap', formatLapTime(bestLapSeconds), bestLapSeconds === null);
  }
  const deltaSeconds = num(local.deltaSeconds) ?? (
    lastLapSeconds !== null && bestLapSeconds !== null ? lastLapSeconds - bestLapSeconds : null
  );
  if (deltaSeconds !== self._deltaSrc) {
    self._deltaSrc = deltaSeconds;
    const deltaInfo = formatDelta(deltaSeconds);
    write(self, 'delta', deltaInfo.text, deltaSeconds === null);
    setAttr(self, 'delta-sign', self.fields['delta'].node, 'data-sign', deltaInfo.sign);
  }

  // --- connection --------------------------------------------------------
  const status = typeof session.status === 'string' ? session.status : (s.mode === 'solo' ? 'solo' : null);
  if (status !== self._connectionSrc) {
    self._connectionSrc = status;
    const statusLabel = status === null ? '—' : (CONNECTION_LABELS[status] || status.toUpperCase());
    write(self, 'connection', statusLabel, status === null);
    setAttr(self, 'connection-state', self.nodes.connectionCard, 'data-state', status === null ? 'unknown' : status);
  }
  const latency = num(session.latencyMs);
  if (latency !== self._latencySrc) {
    self._latencySrc = latency;
    write(self, 'latency', latency === null ? '— ms' : Math.round(latency) + ' ms', latency === null);
  }
  setFlag(self, 'connected', self.nodes.connectionCard, status === 'connected');
  // --- power-up ----------------------------------------------------------
  const powerup = local.powerup && typeof local.powerup === 'object' ? local.powerup : EMPTY;
  const powerupType = typeof powerup.type === 'string' && powerup.type.length > 0 ? powerup.type : null;
  const meta = powerupType ? POWERUP_LABELS[powerupType] : null;
  const powerupLabel = powerupType === null
    ? 'empty slot'
    : (meta ? meta.label : (typeof powerup.label === 'string' && powerup.label.length > 0 ? powerup.label : powerupType));
  write(self, 'powerup-type', powerupLabel, powerupType === null);
  setAttr(self, 'powerup-kind', self.nodes.powerupCard, 'data-kind', powerupType === null ? 'empty' : powerupKind(powerupType));
  const powerupCharges = num(powerup.charges);
  const powerupSeconds = num(powerup.secondsLeft);
  const pu = self._puSrc;
  if (powerupType !== pu.type || powerupCharges !== pu.charges || powerupSeconds !== pu.seconds) {
    pu.type = powerupType;
    pu.charges = powerupCharges;
    pu.seconds = powerupSeconds;
    let detail = 'no power-up';
    if (powerupType !== null) {
      if (powerupCharges !== null && powerupSeconds !== null) {
        detail = powerupCharges + (powerupCharges === 1 ? ' charge' : ' charges') +
          ' · ' + powerupSeconds.toFixed(2) + ' s';
      } else if (powerupCharges !== null) {
        detail = powerupCharges + (powerupCharges === 1 ? ' charge' : ' charges');
      } else if (powerupSeconds !== null) {
        detail = powerupSeconds.toFixed(2) + ' s';
      } else {
        detail = 'ready';
      }
    }
    write(self, 'powerup-detail', detail, false);
  }

  // Glyph / icon fallback. The glyph is always present; a caller-supplied icon
  // replaces it only after it loads.
  const glyph = meta ? meta.glyph : (powerupType ? '?' : '·');
  if (self.nodes.powerupGlyph.textContent !== glyph) self.nodes.powerupGlyph.textContent = glyph;
  const iconUrl = powerupType && typeof powerup.iconUrl === 'string' && powerup.iconUrl.length > 0
    ? powerup.iconUrl
    : null;
  if (self._iconUrl !== iconUrl) {
    self._iconUrl = iconUrl;
    if (iconUrl) {
      self._iconLoaded = false;
      self.nodes.powerupImage.src = iconUrl;
      self.nodes.powerupImage.hidden = false;
      self.nodes.powerupIcon.setAttribute('data-icon', 'image');
    } else {
      self._iconLoaded = false;
      self.nodes.powerupImage.hidden = true;
      self.nodes.powerupImage.removeAttribute('src');
      self.nodes.powerupGlyph.hidden = false;
      self.nodes.powerupIcon.setAttribute('data-icon', 'fallback');
      self.nodes.powerupIcon.removeAttribute('data-art');
    }
  }

  // --- bars --------------------------------------------------------------
  const health = local.health && typeof local.health === 'object' ? local.health : EMPTY;
  const healthCurrent = num(health.current);
  const healthMax = num(health.max);
  const healthPct = healthCurrent !== null && healthMax !== null && healthMax > 0
    ? (healthCurrent / healthMax) * 100
    : 0;
  bar(self, 'health', healthPct);
  const healthSrc = self._healthSrc;
  if (healthCurrent !== healthSrc.current || healthMax !== healthSrc.max) {
    healthSrc.current = healthCurrent;
    healthSrc.max = healthMax;
    write(self, 'health-text', healthCurrent === null || healthMax === null
      ? '— HP'
      : Math.max(0, Math.round(healthCurrent)) + ' / ' + Math.round(healthMax) + ' HP', healthCurrent === null || healthMax === null);
  }
  setFlag(self, 'low-health', self.nodes.healthCard,
    healthCurrent !== null && healthMax !== null && healthMax > 0 && healthCurrent / healthMax <= 0.25);

  const shield = local.shield && typeof local.shield === 'object' ? local.shield : EMPTY;
  const shieldCurrent = num(shield.current);
  const shieldMax = num(shield.max);
  const shieldSeconds = num(shield.secondsLeft);
  const shieldPct = shieldCurrent === null || shieldMax === null || shieldMax <= 0
    ? 0
    : (shieldCurrent / shieldMax) * 100;
  bar(self, 'shield', shieldPct);
  write(self, 'shield-text', shieldCurrent === null || shieldMax === null || shieldMax <= 0
    ? 'no shield'
    : Math.max(0, Math.round(shieldCurrent)) + ' / ' + Math.round(shieldMax) +
      (shieldSeconds === null ? '' : ' · ' + shieldSeconds.toFixed(2) + ' s'), shieldCurrent === null || shieldMax === null || shieldMax <= 0);

  const boost = local.boost && typeof local.boost === 'object' ? local.boost : EMPTY;
  const boostKind = typeof boost.kind === 'string' ? boost.kind : null;
  const boostCurrent = num(boost.remainingSeconds);
  const boostCapacity = num(boost.capacitySeconds) ?? num(boost.capacity);
  const boostPct = boostCurrent === null || boostCapacity === null || boostCapacity <= 0
    ? 0
    : (boostCurrent / boostCapacity) * 100;
  bar(self, 'boost', boostPct);
  write(self, 'boost-text', boostKind === null
    ? 'IDLE'
    : boostKind.toUpperCase() + (boostCurrent === null ? '' : ' · ' + boostCurrent.toFixed(2) + ' s'),
  boostKind === null);
  setFlag(self, 'boost-active', self.nodes.boostCard, boostKind !== null);

  // --- countdown / banner / warning -------------------------------------
  const countdownLabel = self._countdownOverride ?? (timing.countdownLabel ?? null);
  if (countdownLabel === null || countdownLabel === undefined || countdownLabel === '') {
    show(self, 'countdown', false);
  } else {
    if (countdownLabel !== self._countdownSrc) {
      self._countdownSrc = countdownLabel;
      const text = String(countdownLabel);
      write(self, 'countdown', text, false);
      setAttr(self, 'countdown-kind', self.fields['countdown'].node, 'data-kind', text === 'GO' ? 'go' : 'count');
    }
    show(self, 'countdown', true);
  }

  const banner = self._banner ?? (s.banner && typeof s.banner === 'object' ? s.banner : null);
  if (banner && typeof banner.text === 'string' && banner.text.length > 0) {
    write(self, 'banner', banner.text, false);
    setAttr(self, 'banner-kind', self.fields['banner'].node, 'data-kind', typeof banner.kind === 'string' ? banner.kind : 'info');
    show(self, 'banner', true);
  } else {
    show(self, 'banner', false);
  }

  const warning = self._warning ?? (s.warning && typeof s.warning === 'object' ? s.warning : null);
  if (warning && typeof warning.text === 'string' && warning.text.length > 0) {
    write(self, 'warning', warning.text, false);
    setAttr(self, 'warning-level', self.fields['warning'].node, 'data-level', PRIORITY[warning.level] ? warning.level : 'warn');
    show(self, 'warning', true);
  } else {
    show(self, 'warning', false);
  }

  // --- results -----------------------------------------------------------
  updateResults(self, self._eventResults ?? (Array.isArray(s.results) ? s.results : null));

  // --- canvases (batched: at most one draw per canvas per update) --------
  if (self.options.autoDraw) {
    const tacho = self._tacho;
    if (self._tachoDirty || rpm !== tacho.rpm || rpmMax !== tacho.max || redline !== tacho.redline) {
      self._tachoDirty = false;
      tacho.rpm = rpm;
      tacho.max = rpmMax;
      tacho.redline = redline;
      drawTacho(self);
    }
    if (self._mm) {
      self._lastCars = Array.isArray(s.cars) ? s.cars : null;
      const sig = carSignature(self._lastCars);
      if (sig !== self._mmSig) {
        self._mmSig = sig;
        drawMinimap(self, false);
      }
    } else if (self._mmSig !== 'none') {
      self._mmSig = 'none';
      self._lastCars = null;
      drawMinimap(self, true);
    }
  }

  const elapsed = self.options.now() - started;
  self.metrics.lastUpdateMs = elapsed;
  if (elapsed > self.metrics.maxUpdateMs) self.metrics.maxUpdateMs = elapsed;
  return true;
}

function powerupKind(type) {
  return type === 'Bomb' ? 'mine'
    : type === 'Nitrous' ? 'nitro'
      : type === 'Shock' ? 'shock'
        : type.toLowerCase();
}

function carSignature(cars) {
  if (!Array.isArray(cars) || cars.length === 0) return 0;
  let hash = 2166136261 ^ cars.length;
  for (let i = 0; i < cars.length; i += 1) {
    const car = cars[i];
    if (!car) continue;
    const x = num(car.x);
    const z = num(car.z);
    const heading = num(car.headingRad);
    hash = Math.imul(hash ^ (x === null ? 7 : Math.round(x * 20)), 16777619);
    hash = Math.imul(hash ^ (z === null ? 11 : Math.round(z * 20)), 16777619);
    hash = Math.imul(hash ^ (heading === null ? 13 : Math.round(heading * 50)), 16777619);
  }
  return hash | 0;
}

function updateResults(self, resultsData) {
  const node = self.nodes.results;
  if (!Array.isArray(resultsData) || resultsData.length === 0) {
    node.hidden = true;
    self._resultSignature = null;
    self._eventResults = null;
    return;
  }
  let signature = 2166136261 ^ resultsData.length;
  for (let i = 0; i < resultsData.length; i += 1) {
    const row = resultsData[i];
    if (!row) continue;
    const position = num(row.positionNumber) ?? num(row.position) ?? i + 1;
    const time = num(row.timeSeconds);
    const best = num(row.bestLapSeconds);
    const status = row.status === 'dnf' ? 1 : 0;
    const name = typeof row.name === 'string' ? hashText(row.name) : 0;
    signature = Math.imul(signature ^ (position * 1000003), 16777619);
    signature = Math.imul(signature ^ (time === null ? 17 : Math.round(time * 1000)), 16777619);
    signature = Math.imul(signature ^ (best === null ? 19 : Math.round(best * 1000)), 16777619);
    signature = Math.imul(signature ^ status ^ name, 16777619);
  }
  signature |= 0;
  if (signature === self._resultSignature) {
    node.hidden = false;
    return;
  }
  self._resultSignature = signature;
  node.hidden = false;

  const limit = self._resultLimit;
  const rows = self._resultRows;
  for (let i = 0; i < limit; i += 1) {
    let row = rows[i];
    if (!row) {
      row = buildResultRow(self.document);
      rows[i] = row;
      self.nodes.resultsBody.appendChild(row.shell);
    }
    const data = i < resultsData.length ? resultsData[i] : null;
    if (!data) {
      row.shell.hidden = true;
      continue;
    }
    row.shell.hidden = false;
    const position = num(data.positionNumber) ?? num(data.position) ?? i + 1;
    row.pos.textContent = intText(Math.max(0, Math.round(position)));
    const name = typeof data.name === 'string' && data.name.length > 0 ? data.name : '—';
    let nameText = name;
    if (data.host === true) nameText += '  HOST';
    if (data.ai === true) nameText += '  AI';
    row.name.textContent = nameText;
    const time = num(data.timeSeconds);
    const dnf = data.status === 'dnf' || time === null;
    row.time.textContent = dnf ? 'DNF' : formatRaceTime(time);
    row.time.setAttribute('data-status', dnf ? 'dnf' : 'finished');
    const best = num(data.bestLapSeconds);
    row.best.textContent = best === null ? '—' : formatLapTime(best);
    row.shell.setAttribute('data-self', data.self === true ? '1' : '0');
    row.shell.setAttribute('data-kind',
      data.ai === true ? 'ai' : data.host === true ? 'host' : data.kind === 'remote' ? 'remote' : 'driver');
    self.metrics.attrWrites += 1;
  }
}

function buildResultRow(doc) {
  const shell = element(doc, 'div', 'hud-results-row');
  shell.setAttribute('role', 'row');
  const pos = element(doc, 'span', 'hud-cell hud-col-pos');
  pos.setAttribute('role', 'cell');
  const name = element(doc, 'span', 'hud-cell hud-col-name');
  name.setAttribute('role', 'cell');
  const time = element(doc, 'span', 'hud-cell hud-col-time');
  time.setAttribute('role', 'cell');
  const best = element(doc, 'span', 'hud-cell hud-col-best');
  best.setAttribute('role', 'cell');
  shell.appendChild(pos);
  shell.appendChild(name);
  shell.appendChild(time);
  shell.appendChild(best);
  return { shell, pos, name, time, best };
}

// ------------------------------------------------------------------ drawing

function tachoRadius(size) {
  return Math.max(8, size * 0.42);
}

function tachoAngle(ratio) {
  return Math.PI * 0.75 + ratio * Math.PI * 1.5;
}

function drawTacho(self) {
  const ctx = self._ctxTacho;
  const size = self.layout.tacho;
  if (!ctx) return;
  const tacho = self._tacho;
  const key = size + ':' + (tacho.max === null ? 'n' : tacho.max) + ':' + (tacho.redline === null ? 'n' : tacho.redline);
  if (key !== tacho.key) {
    rebuildTachoStatic(self, size, tacho.max, tacho.redline);
    tacho.key = key;
  }
  ctx.clearRect(0, 0, size, size);
  if (tacho.staticCanvas) ctx.drawImage(tacho.staticCanvas, 0, 0, size, size);

  if (tacho.rpm !== null && tacho.max !== null && tacho.max > 0) {
    const centre = size / 2;
    const radius = tachoRadius(size);
    const ratio = clamp(tacho.rpm / tacho.max, 0, 1);
    const angle = tachoAngle(ratio);
    ctx.save();
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = Math.max(2, size * 0.012);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(centre, centre);
    ctx.lineTo(centre + Math.cos(angle) * radius * 0.82, centre + Math.sin(angle) * radius * 0.82);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.fillStyle = PALETTE.ink;
    ctx.beginPath();
    ctx.arc(centre, centre, Math.max(2, size * 0.018), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  self.metrics.canvasDraws += 1;
  self.metrics.tachoDraws += 1;
}

function rebuildTachoStatic(self, size, max, redline) {
  const doc = self.document;
  const canvas = element(doc, 'canvas', 'hud-canvas-static');
  const ctx = setupCanvas(canvas, size, size, self.layout.dpr);
  self._tacho.staticCanvas = canvas;
  self._tacho.staticCtx = ctx;
  if (!ctx) return;

  const centre = size / 2;
  const radius = tachoRadius(size);
  const inner = radius * 0.72;

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.strokeStyle = 'rgba(245,248,251,0.28)';
  ctx.lineWidth = Math.max(1, size * 0.006);
  ctx.beginPath();
  ctx.arc(centre, centre, radius, tachoAngle(0), tachoAngle(1));
  ctx.stroke();
  ctx.restore();

  if (max === null || max <= 0) {
    ctx.save();
    ctx.fillStyle = PALETTE.dim;
    ctx.font = Math.max(8, Math.round(size * 0.09)) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('RPM —', centre, centre);
    ctx.restore();
    return;
  }

  const ticks = 8;
  ctx.save();
  ctx.strokeStyle = 'rgba(245,248,251,0.45)';
  ctx.lineWidth = Math.max(1, size * 0.006);
  ctx.beginPath();
  for (let i = 0; i <= ticks; i += 1) {
    const angle = tachoAngle(i / ticks);
    const major = i % 2 === 0;
    ctx.moveTo(centre + Math.cos(angle) * inner, centre + Math.sin(angle) * inner);
    ctx.lineTo(centre + Math.cos(angle) * (inner + (major ? radius * 0.12 : radius * 0.06)), centre + Math.sin(angle) * (inner + (major ? radius * 0.12 : radius * 0.06)));
  }
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.fillStyle = PALETTE.dim;
  ctx.font = Math.max(8, Math.round(size * 0.08)) + 'px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i += 1) {
    const angle = tachoAngle(i / 4);
    const label = String(Math.round((max * i) / 4 / 1000)) + 'k';
    ctx.fillText(label, centre + Math.cos(angle) * radius * 0.86, centre + Math.sin(angle) * radius * 0.86);
  }
  ctx.restore();

  if (redline !== null && redline > 0 && redline < max) {
    ctx.save();
    ctx.strokeStyle = PALETTE.danger;
    ctx.lineWidth = Math.max(2, size * 0.02);
    ctx.beginPath();
    ctx.arc(centre, centre, radius, tachoAngle(redline / max), tachoAngle(1));
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.fillStyle = PALETTE.danger;
    ctx.font = Math.max(7, Math.round(size * 0.062)) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('REDLINE', centre, centre + radius * 0.42);
    ctx.restore();
  }
}

function drawMinimap(self, force) {
  const ctx = self._ctxMinimap;
  const size = self.layout.minimap;
  if (!ctx) return;
  const key = size + ':' + (self._mm ? self._mm.label + ':' + self._mm.bounds.minX + ':' + self._mm.bounds.maxX : 'none');
  if (force || key !== self._mmKey) {
    rebuildMinimapStatic(self, size);
    self._mmKey = key;
  }
  ctx.clearRect(0, 0, size, size);
  if (self._mmStatic) ctx.drawImage(self._mmStatic, 0, 0, size, size);

  if (self._mm) {
    const cars = self._lastCars;
    if (Array.isArray(cars) && cars.length > 0) {
      const pad = Math.max(6, size * 0.06);
      const bounds = self._mm.bounds;
      const spanX = bounds.maxX - bounds.minX || 1;
      const spanZ = bounds.maxZ - bounds.minZ || 1;
      const inner = size - pad * 2;
      const project = (x, z, out) => {
        out[0] = pad + ((x - bounds.minX) / spanX) * inner;
        out[1] = size - pad - ((z - bounds.minZ) / spanZ) * inner;
        return out;
      };
      const scratch = self._projectScratch || (self._projectScratch = [0, 0]);

      // One path for every remote human car.
      let any = false;
      ctx.save();
      ctx.fillStyle = PALETTE.cyan;
      ctx.beginPath();
      for (let i = 0; i < cars.length; i += 1) {
        const car = cars[i];
        if (!car || car.kind !== 'remote') continue;
        const x = num(car.x);
        const z = num(car.z);
        if (x === null || z === null) continue;
        project(x, z, scratch);
        ctx.moveTo(scratch[0] + 2.5, scratch[1]);
        ctx.arc(scratch[0], scratch[1], 2.5, 0, Math.PI * 2);
        any = true;
      }
      if (any) ctx.fill();
      ctx.restore();

      // One path for every AI car.
      any = false;
      ctx.save();
      ctx.fillStyle = PALETTE.amber;
      ctx.beginPath();
      for (let i = 0; i < cars.length; i += 1) {
        const car = cars[i];
        if (!car || car.kind !== 'ai') continue;
        const x = num(car.x);
        const z = num(car.z);
        if (x === null || z === null) continue;
        project(x, z, scratch);
        ctx.moveTo(scratch[0] - 2.4, scratch[1] - 2.4);
        ctx.lineTo(scratch[0] + 2.4, scratch[1] - 2.4);
        ctx.lineTo(scratch[0] + 2.4, scratch[1] + 2.4);
        ctx.lineTo(scratch[0] - 2.4, scratch[1] + 2.4);
        ctx.closePath();
        any = true;
      }
      if (any) ctx.fill();
      ctx.restore();

      // The local car is an arrow so its heading is readable.
      const localCar = findLocalCar(cars);
      if (localCar) {
        const x = num(localCar.x);
        const z = num(localCar.z);
        if (x !== null && z !== null) {
          project(x, z, scratch);
          const heading = num(localCar.headingRad) ?? 0;
          const fx = Math.sin(heading);
          const fz = Math.cos(heading);
          const px = -fz;
          const pz = fx;
          ctx.save();
          ctx.fillStyle = PALETTE.ink;
          ctx.strokeStyle = PALETTE.panel;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(scratch[0] + fx * 6, scratch[1] - fz * 6);
          ctx.lineTo(scratch[0] - fx * 3 + px * 3.4, scratch[1] + fz * 3 - pz * 3.4);
          ctx.lineTo(scratch[0] - fx * 3 - px * 3.4, scratch[1] + fz * 3 + pz * 3.4);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      }
    }
  }

  self.metrics.canvasDraws += 1;
  self.metrics.minimapDraws += 1;
}

function findLocalCar(cars) {
  for (let i = 0; i < cars.length; i += 1) {
    const car = cars[i];
    if (car && (car.kind === 'local' || car.local === true)) return car;
  }
  return null;
}

function rebuildMinimapStatic(self, size) {
  const doc = self.document;
  const canvas = element(doc, 'canvas', 'hud-canvas-static');
  const ctx = setupCanvas(canvas, size, size, self.layout.dpr);
  self._mmStatic = canvas;
  if (!ctx) return;

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.strokeStyle = 'rgba(245,248,251,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
  ctx.restore();

  if (!self._mm) {
    ctx.save();
    ctx.strokeStyle = 'rgba(245,248,251,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(size * 0.5, size * 0.3);
    ctx.lineTo(size * 0.5, size * 0.7);
    ctx.moveTo(size * 0.3, size * 0.5);
    ctx.lineTo(size * 0.7, size * 0.5);
    ctx.stroke();
    ctx.fillStyle = PALETTE.dim;
    ctx.font = Math.max(7, Math.round(size * 0.072)) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NO MINIMAP1', size * 0.5, size * 0.8);
    ctx.restore();
    return;
  }

  const data = self._mm.data;
  const bounds = self._mm.bounds;
  const pad = Math.max(6, size * 0.06);
  const inner = size - pad * 2;
  const spanX = bounds.maxX - bounds.minX || 1;
  const spanZ = bounds.maxZ - bounds.minZ || 1;
  const px = (x) => pad + ((x - bounds.minX) / spanX) * inner;
  const py = (z) => size - pad - ((z - bounds.minZ) / spanZ) * inner;

  const points = data.points;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(7,11,15,0.85)';
  ctx.lineWidth = Math.max(3, size * 0.045);
  ctx.beginPath();
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (i === 0) ctx.moveTo(px(point[0]), py(point[1]));
    else ctx.lineTo(px(point[0]), py(point[1]));
  }
  if (self._mm.closed) ctx.closePath();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(95,211,255,0.85)';
  ctx.lineWidth = Math.max(1, size * 0.016);
  ctx.stroke();
  ctx.restore();

  // Start / finish markers.
  const start = data.start && isFiniteNumber(data.start.x) && isFiniteNumber(data.start.z) ? data.start : points[0];
  ctx.save();
  ctx.strokeStyle = PALETTE.ok;
  ctx.lineWidth = Math.max(2, size * 0.014);
  ctx.beginPath();
  ctx.arc(px(start[0] ?? start.x), py(start[1] ?? start.z), Math.max(3, size * 0.03), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  if (data.finish && isFiniteNumber(data.finish.x) && isFiniteNumber(data.finish.z)) {
    ctx.save();
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = 1;
    const fx = px(data.finish.x);
    const fy = py(data.finish.z);
    const r = Math.max(3, size * 0.026);
    ctx.strokeRect(fx - r, fy - r, r * 2, r * 2);
    ctx.restore();
  }

  if (Array.isArray(data.checkpoints)) {
    ctx.save();
    ctx.fillStyle = 'rgba(245,248,251,0.6)';
    for (let i = 0; i < data.checkpoints.length; i += 1) {
      const checkpoint = data.checkpoints[i];
      if (!checkpoint || !isFiniteNumber(checkpoint.x) || !isFiniteNumber(checkpoint.z)) continue;
      ctx.beginPath();
      ctx.arc(px(checkpoint.x), py(checkpoint.z), Math.max(1.5, size * 0.012), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  if (Array.isArray(data.pickups)) {
    ctx.save();
    ctx.fillStyle = PALETTE.magenta;
    for (let i = 0; i < data.pickups.length; i += 1) {
      const pickup = data.pickups[i];
      if (!pickup || !isFiniteNumber(pickup.x) || !isFiniteNumber(pickup.z)) continue;
      const x = px(pickup.x);
      const y = py(pickup.z);
      const r = Math.max(1.8, size * 0.014);
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
}

function readFields(self) {
  const out = {};
  for (const key in self.fields) out[key] = self.fields[key].text;
  return out;
}

// ------------------------------------------------------------------- events

function announce(self, text) {
  if (!text) return;
  const live = self.fields['live'];
  if (live.node.textContent !== text) live.node.textContent = text;
}

function setBanner(self, banner, durationMs) {
  self._banner = banner;
  self._bannerUntil = durationMs === 0 ? 0 : self.options.now() + durationMs;
}

function setEvent(self, event) {
  if (self.destroyed) return false;
  if (!event || typeof event.type !== 'string') return false;
  const now = self.options.now();
  const duration = num(event.durationMs);

  switch (event.type) {
    case 'countdown': {
      const label = event.label === undefined || event.label === null ? '3' : String(event.label);
      self._countdownOverride = label;
      self._countdownUntil = now + (duration ?? 900);
      return true;
    }
    case 'go': {
      self._countdownOverride = 'GO';
      self._countdownUntil = now + (duration ?? 900);
      announce(self, 'GO');
      return true;
    }
    case 'lap-complete': {
      const lap = num(event.lap);
      const lapSeconds = num(event.lapSeconds);
      const best = num(event.bestLapSeconds);
      let text = 'LAP';
      if (lap !== null) text += ' ' + lap;
      if (lapSeconds !== null) text += ' · ' + formatLapTime(lapSeconds);
      if (best !== null) text += ' · best ' + formatLapTime(best);
      setBanner(self, { text, kind: 'lap' }, duration ?? 2200);
      announce(self, text);
      return true;
    }
    case 'finish': {
      if (Array.isArray(event.results)) self._eventResults = event.results;
      setBanner(self, {
        text: typeof event.text === 'string' && event.text.length > 0 ? event.text : 'FINISH',
        kind: 'finish'
      }, duration ?? 0);
      announce(self, 'finish');
      return true;
    }
    case 'results': {
      if (Array.isArray(event.results)) {
        self._eventResults = event.results;
        self._resultSignature = null;
      }
      return true;
    }
    case 'warning': {
      self._warning = {
        text: typeof event.text === 'string' && event.text.length > 0
          ? event.text
          : (typeof event.message === 'string' ? event.message : 'warning'),
        level: PRIORITY[event.level] ? event.level : 'warn'
      };
      self._warningUntil = now + (duration ?? 3000);
      announce(self, self._warning.text);
      return true;
    }
    case 'powerup-pickup':
    case 'powerup-use': {
      const type = typeof event.type === 'string' ? event.powerupType : null;
      const meta = type ? POWERUP_LABELS[type] : null;
      const name = meta ? meta.label : (type ?? 'power-up');
      const text = (event.type === 'powerup-use' ? 'USED · ' : 'PICKED UP · ') + name;
      setBanner(self, { text, kind: 'powerup' }, duration ?? 1600);
      announce(self, text);
      return true;
    }
    case 'hit': {
      const amount = num(event.amount);
      const text = amount === null ? 'HIT' : 'HIT −' + Math.round(amount);
      setBanner(self, { text, kind: 'danger' }, duration ?? 1200);
      return true;
    }
    case 'wrecked': {
      const respawn = num(event.respawnSeconds);
      setBanner(self, {
        text: respawn === null ? 'WRECKED' : 'WRECKED · respawn in ' + respawn.toFixed(1) + ' s',
        kind: 'danger'
      }, duration ?? 0);
      announce(self, 'wrecked');
      return true;
    }
    case 'respawn': {
      setBanner(self, { text: 'RESPAWNED', kind: 'info' }, duration ?? 1200);
      return true;
    }
    case 'connection': {
      const status = typeof event.status === 'string' ? event.status : null;
      if (status !== null) write(self, 'connection', CONNECTION_LABELS[status] || status.toUpperCase(), false);
      if (event.latencyMs !== undefined) {
        const latency = num(event.latencyMs);
        write(self, 'latency', latency === null ? '— ms' : Math.round(latency) + ' ms', latency === null);
      }
      self._connectionSrc = undefined;
      self._latencySrc = undefined;
      return true;
    }
    case 'reset': {
      self._banner = null;
      self._bannerUntil = 0;
      self._warning = null;
      self._warningUntil = 0;
      self._countdownOverride = null;
      self._countdownUntil = 0;
      self._eventResults = null;
      self._resultSignature = null;
      self.nodes.results.hidden = true;
      announce(self, '');
      return true;
    }
    default:
      return false;
  }
}

function destroy(self) {
  if (self.destroyed) return false;
  self.destroyed = true;
  if (self._windowResize) {
    try {
      self.host.ownerDocument?.defaultView?.removeEventListener?.('resize', self._windowResize);
    } catch (error) {
      /* ignore */
    }
    self._windowResize = null;
  }
  if (self.root.parentNode) self.root.parentNode.removeChild(self.root);
  if (self.host.__hudUi) delete self.host.__hudUi;
  self._resultRows.length = 0;
  self._mm = null;
  self._mmStatic = null;
  self._tacho.staticCanvas = null;
  self._tacho.staticCtx = null;
  self._ctxTacho = null;
  self._ctxMinimap = null;
  return true;
}
