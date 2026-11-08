// Runtime audio catalog — every Blur game event from decoded retail waves.
//
// The page imports this module and calls `createAudio({ ctx, baseUrl })`. The
// catalog (`probes/audio/data/runtime-audio.json`) is fetched from this module's
// own directory, so no build step or bundler is required. Every source is a
// decoded retail BAF wave; the catalog records the PAK asset, wave index/data
// range, decoded file path and SHA-256. A missing source is a typed
// `unsupported` entry — this module never synthesises a beep or invents a gain.
//
// Event vocabulary (`EVENT_IDS`):
//   engine, tyre-squeal, impact,
//   pickup-<type>, weapon-<type> for bolt/shunt/barge/mine/shock/nitro/shield/repair,
//   ui-click, countdown, finish, wreck.
//
// Non-claims: this is a runtime event player over decoded retail waves. It is
// not the retail mixer, not the Ovis graph runtime, and it does not model
// occlusion, cone/rolloff, ducking or the retail bus/limiter.

export const AUDIO_SCHEMA = 'blur.audio-runtime/1';
export const DEFAULT_BASE_URL = '/_work/audio/';
export const MIN_PLAYBACK_RATE = 0.00390625;

export const EVENT_IDS = Object.freeze([
  'engine',
  'tyre-squeal',
  'impact',
  'pickup-bolt',
  'pickup-shunt',
  'pickup-barge',
  'pickup-mine',
  'pickup-shock',
  'pickup-nitro',
  'pickup-shield',
  'pickup-repair',
  'weapon-bolt',
  'weapon-shunt',
  'weapon-barge',
  'weapon-mine',
  'weapon-shock',
  'weapon-nitro',
  'weapon-shield',
  'weapon-repair',
  'ui-click',
  'countdown',
  'finish',
  'wreck',
]);

/** Catalog URL relative to this module; served next to `data/runtime-audio.json`. */
export const DEFAULT_CATALOG_URL = new URL('./data/runtime-audio.json', import.meta.url).href;

/**
 * Piecewise-linear evaluation with endpoint clamping. Same function as
 * `probes/audio/web/engine-audio.js` (`evalPlf`), kept local so this module has
 * no import-time dependency on a `.js` file (Node treats bare `.js` as CJS).
 *
 * @param {ReadonlyArray<readonly [number, number]>} points
 * @param {number} x
 * @returns {number}
 */
export function evalPlf(points, x) {
  if (!points || points.length === 0) return 0;
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) {
      if (x1 === x0) return y1;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

/** `x = RPM * 0.0001` (BaseMessageHandler.cpp:1940). */
export function rpmToX(rpm) {
  return rpm * 0.0001;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampRate(rate, pitch) {
  if (!isFiniteNumber(rate)) {
    throw new TypeError(`runtime-audio: playbackRate must be finite, got ${String(rate)}`);
  }
  let value = Math.max(MIN_PLAYBACK_RATE, rate);
  if (pitch && isFiniteNumber(pitch.min) && isFiniteNumber(pitch.max)) {
    value = Math.min(Math.max(value, pitch.min), pitch.max);
  }
  return value;
}

function normalizeBaseUrl(value) {
  const base = String(value ?? DEFAULT_BASE_URL);
  return base.endsWith('/') ? base : `${base}/`;
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validateCatalog(json) {
  if (!json || typeof json !== 'object') {
    throw new TypeError('runtime-audio: catalog must be an object');
  }
  if (json.schema !== AUDIO_SCHEMA) {
    throw new TypeError(`runtime-audio: catalog schema is "${json.schema}", expected "${AUDIO_SCHEMA}"`);
  }
  if (!json.events || typeof json.events !== 'object' || Array.isArray(json.events)) {
    throw new TypeError('runtime-audio: catalog.events must be an object keyed by event id');
  }
  const keys = Object.keys(json.events);
  for (const id of EVENT_IDS) {
    if (!hasOwn(json.events, id)) {
      throw new TypeError(`runtime-audio: catalog is missing event "${id}"`);
    }
  }
  for (const key of keys) {
    if (!EVENT_IDS.includes(key)) {
      throw new TypeError(`runtime-audio: catalog has undocumented event "${key}"`);
    }
    const event = json.events[key];
    if (!event || event.id !== key) {
      throw new TypeError(`runtime-audio: catalog event "${key}" has a mismatched id`);
    }
    if (event.status !== 'ok' && event.status !== 'unsupported') {
      throw new TypeError(`runtime-audio: catalog event "${key}" has invalid status "${event.status}"`);
    }
    if (event.status === 'unsupported' && !event.reason) {
      throw new TypeError(`runtime-audio: unsupported event "${key}" has no typed reason`);
    }
    if (event.status === 'ok') {
      const sourceCount = (event.variants?.length ?? 0)
        + (event.layers?.length ?? 0)
        + (event.routes ? Object.keys(event.routes).length : 0);
      if (sourceCount === 0) {
        throw new TypeError(`runtime-audio: event "${key}" is ok but has no sources`);
      }
    }
  }
  return json;
}

/**
 * Create the runtime audio player.
 *
 * @param {{
 *   ctx: AudioContext,
 *   baseUrl?: string,
 *   catalog?: object,
 *   catalogUrl?: string,
 *   fetchImpl?: typeof fetch,
 *   masterGain?: number,
 *   limiter?: boolean,
 *   analyser?: boolean,
 *   verifyHashes?: boolean,
 *   smoothing?: number,
 *   fadeIn?: number,
 *   fadeOut?: number,
 * }} options
 */
export function createAudio(options = {}) {
  const ctx = options.ctx;
  if (!ctx || typeof ctx.createGain !== 'function' || typeof ctx.createBufferSource !== 'function') {
    throw new TypeError('runtime-audio: `ctx` must be an AudioContext-like object');
  }
  if (!isFiniteNumber(ctx.currentTime) || !isFiniteNumber(ctx.sampleRate)) {
    throw new TypeError('runtime-audio: `ctx` must expose finite currentTime and sampleRate');
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  const catalogUrl = options.catalogUrl ?? DEFAULT_CATALOG_URL;
  const masterGainValue = options.masterGain ?? 1;
  if (!isFiniteNumber(masterGainValue) || masterGainValue < 0) {
    throw new RangeError('runtime-audio: `masterGain` must be a finite number >= 0');
  }
  const smoothing = options.smoothing ?? 0.02;
  if (!isFiniteNumber(smoothing) || smoothing <= 0) {
    throw new RangeError('runtime-audio: `smoothing` must be a finite number > 0');
  }
  const fadeIn = options.fadeIn ?? 0.005;
  const fadeOut = options.fadeOut ?? 0.02;
  const useLimiter = options.limiter !== false;
  const useAnalyser = options.analyser !== false;
  const verifyHashes = options.verifyHashes !== false;

  let state = 'idle'; // idle | loading | ready | blocked | disposed
  let catalogState = 'idle'; // idle | loading | ready | error
  let catalog = null;
  let catalogError = null;
  let catalogPromise = null;
  let master = null;
  let limiterNode = null;
  let analyserNode = null;
  let muted = false;

  const decoded = new Map(); // url -> { buffer, info }
  const decodedPromises = new Map(); // url -> Promise
  const voices = new Set();
  const selectionCounters = new Map();
  let engine = { started: false, rpm: 0, x: 0, layers: [], excluded: [], nodes: [] };
  let pendingEngine = { rpm: 0 };
  let playCount = 0;
  let unsupportedCount = 0;
  let failedCount = 0;
  let lastError = null;

  function setState(next) {
    state = next;
    return state;
  }

  function recordError(event, reason, detail) {
    lastError = { event, reason, detail: detail === undefined ? null : String(detail), at: ctx.currentTime };
    return lastError;
  }

  function ensureGraph() {
    if (master) return;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : masterGainValue;
    let tail = master;
    if (useLimiter && typeof ctx.createDynamicsCompressor === 'function') {
      limiterNode = ctx.createDynamicsCompressor();
      limiterNode.threshold.value = -3;
      limiterNode.knee.value = 6;
      limiterNode.ratio.value = 12;
      limiterNode.attack.value = 0.003;
      limiterNode.release.value = 0.12;
      tail = tail.connect(limiterNode);
    }
    if (useAnalyser && typeof ctx.createAnalyser === 'function') {
      analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 2048;
      tail = tail.connect(analyserNode);
    }
    tail.connect(ctx.destination);
  }

  async function loadCatalog() {
    if (catalog) return catalog;
    if (catalogPromise) return catalogPromise;
    catalogState = 'loading';
    setState('loading');
    catalogPromise = (async () => {
      if (options.catalog) {
        catalog = validateCatalog(options.catalog);
        catalogState = 'ready';
        setState('ready');
        return catalog;
      }
      if (typeof fetchImpl !== 'function') {
        throw new Error('no fetch implementation available; pass `fetchImpl` or `catalog`');
      }
      let response;
      try {
        response = await fetchImpl(catalogUrl, { cache: 'no-store' });
      } catch (error) {
        const failure = new Error(`catalog fetch failed: ${catalogUrl}: ${error.message ?? error}`);
        failure.code = 'catalog-fetch-failed';
        throw failure;
      }
      if (!response || !response.ok) {
        const failure = new Error(`catalog ${catalogUrl}: HTTP ${response ? response.status : 'no response'}`);
        failure.code = 'catalog-fetch-failed';
        throw failure;
      }
      const json = await response.json();
      catalog = validateCatalog(json);
      catalogState = 'ready';
      setState('ready');
      return catalog;
    })().catch((error) => {
      catalogError = error;
      catalogState = 'error';
      setState('blocked');
      throw error;
    });
    return catalogPromise;
  }

  async function ensureRunning() {
    if (ctx.state === 'running') return true;
    if (typeof ctx.resume === 'function') {
      try {
        await ctx.resume();
      } catch (error) {
        recordError('context', 'resume-failed', error.message ?? error);
        return false;
      }
    }
    return ctx.state === 'running';
  }

  async function digest(bytes) {
    if (!verifyHashes) return null;
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle || typeof subtle.digest !== 'function') return null;
    const hash = await subtle.digest('SHA-256', bytes);
    return hex(hash);
  }

  async function loadBuffer(variant) {
    const key = variant.url;
    if (decoded.has(key)) return decoded.get(key);
    if (decodedPromises.has(key)) return decodedPromises.get(key);
    const promise = (async () => {
      if (typeof fetchImpl !== 'function') {
        const failure = new Error('no fetch implementation available; pass `fetchImpl`');
        failure.code = 'fetch-failed';
        throw failure;
      }
      const url = baseUrl + key;
      let response;
      try {
        response = await fetchImpl(url, { cache: 'no-store' });
      } catch (error) {
        const failure = new Error(`fetch failed: ${url}: ${error.message ?? error}`);
        failure.code = 'fetch-failed';
        throw failure;
      }
      if (!response || !response.ok) {
        const failure = new Error(`${url}: HTTP ${response ? response.status : 'no response'}`);
        failure.code = 'fetch-failed';
        throw failure;
      }
      const bytes = await response.arrayBuffer();
      const actual = await digest(bytes);
      if (actual !== null && actual !== variant.sha256) {
        const failure = new Error(
          `${url}: SHA-256 ${actual} does not match catalog ${variant.sha256}`,
        );
        failure.code = 'hash-mismatch';
        throw failure;
      }
      let buffer;
      try {
        buffer = await ctx.decodeAudioData(bytes.slice(0));
      } catch (error) {
        const failure = new Error(`${url}: decodeAudioData failed: ${error.message ?? error}`);
        failure.code = 'decode-failed';
        throw failure;
      }
      if (!buffer || !isFiniteNumber(buffer.duration) || buffer.duration <= 0) {
        const failure = new Error(`${url}: decoded buffer has no duration`);
        failure.code = 'decode-failed';
        throw failure;
      }
      const entry = {
        buffer,
        info: {
          event: variant.provenance ? variant.provenance.contractEvent : null,
          wave: variant.wave,
          file: variant.file,
          url,
          bytes: bytes.byteLength,
          duration: buffer.duration,
          sampleRate: buffer.sampleRate,
          channels: buffer.numberOfChannels,
          hashVerified: actual === null ? null : actual === variant.sha256,
          sha256: variant.sha256,
        },
      };
      decoded.set(key, entry);
      return entry;
    })();
    decodedPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      decodedPromises.delete(key);
    }
  }

  function voiceCleanup(voice) {
    voices.delete(voice);
    if (voice.handle) voice.handle._voices.delete(voice);
    try {
      voice.source.disconnect();
      voice.gainNode.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  async function createVoice(handle, variant, settings) {
    const loaded = await loadBuffer(variant);
    const source = ctx.createBufferSource();
    source.buffer = loaded.buffer;
    source.loop = Boolean(settings.loop);
    if (settings.loop) {
      source.loopStart = variant.loopStart ? variant.loopStart / variant.sampleRate : 0;
      source.loopEnd = variant.loopEnd ? variant.loopEnd / variant.sampleRate : loaded.buffer.duration;
    }
    source.playbackRate.value = clampRate(settings.rate, settings.pitch);
    const gainNode = ctx.createGain();
    gainNode.gain.value = 0;
    source.connect(gainNode).connect(master);
    const startAt = Math.max(ctx.currentTime, settings.when ?? ctx.currentTime);
    if (settings.fadeIn > 0) {
      gainNode.gain.setTargetAtTime(settings.gain, startAt, settings.fadeIn);
    } else {
      gainNode.gain.setValueAtTime(settings.gain, startAt);
    }
    source.start(startAt);
    const voice = {
      event: handle.event,
      handle,
      variant,
      source,
      gainNode,
      gain: settings.gain,
      rate: source.playbackRate.value,
      loop: Boolean(settings.loop),
      startedAt: startAt,
      stopped: false,
    };
    source.onended = () => voiceCleanup(voice);
    voices.add(voice);
    handle._voices.add(voice);
    return voice;
  }

  function stopVoice(voice, fade = fadeOut) {
    if (!voice || voice.stopped) return;
    voice.stopped = true;
    const now = ctx.currentTime;
    try {
      voice.gainNode.gain.setTargetAtTime(0, now, Math.max(0.001, fade));
      voice.source.stop(now + Math.max(0.01, fade * 4));
    } catch {
      // Already stopped.
    }
    voices.delete(voice);
  }

  function sampleEngine(rpm) {
    if (!catalog) return { rpm, x: rpmToX(rpm), layers: [], excluded: [], pending: true };
    const entry = catalog.events.engine;
    const x = rpmToX(rpm);
    const layers = entry.layers.map((layer) => ({
      slot: layer.slot,
      wave: layer.wave,
      rpmLabel: layer.rpmLabel,
      gain: evalPlf(layer.volumeCurve, x),
      rate: clampRate(evalPlf(layer.pitchCurve, x), entry.pitch),
    }));
    return { rpm, x, layers, excluded: entry.excluded ?? [] };
  }

  function applyEngine(sample) {
    if (!engine.started) return;
    const now = ctx.currentTime;
    for (const node of engine.nodes) {
      const layer = sample.layers.find((item) => item.slot === node.layer.slot);
      if (!layer) continue;
      node.gainNode.gain.setTargetAtTime(layer.gain, now, smoothing);
      node.source.playbackRate.setTargetAtTime(layer.rate, now, smoothing);
      node.gain = layer.gain;
      node.rate = layer.rate;
    }
    engine.rpm = sample.rpm;
    engine.x = sample.x;
    engine.layers = sample.layers;
    engine.excluded = sample.excluded;
  }

  function setEngine(input) {
    const value = input && typeof input === 'object' ? input.rpm : input;
    const rpm = Number(value);
    if (!Number.isFinite(rpm) || rpm < 0) {
      throw new RangeError(`runtime-audio: engine RPM must be a finite number >= 0, got ${String(value)}`);
    }
    pendingEngine = { rpm };
    const sample = sampleEngine(rpm);
    applyEngine(sample);
    return sample;
  }

  async function startEngine(handle, entry) {
    if (!engine.started) {
      const loaded = await Promise.all(entry.layers.map((layer) => loadBuffer(layer)));
      const sample = sampleEngine(pendingEngine.rpm);
      const startAt = ctx.currentTime + 0.05;
      engine.nodes = entry.layers.map((layer, index) => {
        const source = ctx.createBufferSource();
        source.buffer = loaded[index].buffer;
        source.loop = true;
        source.loopStart = 0;
        source.loopEnd = loaded[index].buffer.duration;
        const gainNode = ctx.createGain();
        gainNode.gain.value = 0;
        source.connect(gainNode).connect(master);
        const layerSample = sample.layers.find((item) => item.slot === layer.slot);
        source.playbackRate.value = layerSample.rate;
        gainNode.gain.setTargetAtTime(layerSample.gain, startAt, smoothing);
        source.start(startAt);
        return { layer, source, gainNode, gain: layerSample.gain, rate: layerSample.rate };
      });
      engine.started = true;
      engine.rpm = sample.rpm;
      engine.x = sample.x;
      engine.layers = sample.layers;
      engine.excluded = sample.excluded;
    }
    handle._engine = true;
    handle.loop = true;
    handle.gain = entry.gain.value;
    handle.rate = 1;
    handle.variants = entry.layers.map((layer) => layer.wave);
    handle.startedAt = ctx.currentTime;
    handle.status = 'playing';
    return handle;
  }

  function stopEngine() {
    for (const node of engine.nodes) {
      try {
        node.gainNode.gain.setTargetAtTime(0, ctx.currentTime, fadeOut);
        node.source.stop(ctx.currentTime + Math.max(0.01, fadeOut * 4));
      } catch {
        // Already stopped.
      }
      try {
        node.source.disconnect();
        node.gainNode.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    engine = { started: false, rpm: 0, x: 0, layers: [], excluded: [], nodes: [] };
  }

  function selectVariant(entry, opts) {
    const variants = entry.variants ?? [];
    if (variants.length === 0) return null;
    if (opts.variant !== undefined && opts.variant !== null) {
      if (Number.isInteger(opts.variant)) {
        return variants[opts.variant] ?? null;
      }
      const wanted = String(opts.variant);
      return variants.find((item) => item.variantId === wanted
        || item.id === wanted
        || item.wave === wanted) ?? null;
    }
    if (entry.defaultVariant) {
      return variants.find((item) => item.variantId === entry.defaultVariant) ?? variants[0];
    }
    return variants[0];
  }

  function resolveMaterial(entry, material) {
    if (material === undefined || material === null) return null;
    if (typeof material === 'string') {
      if (entry.surfaces && hasOwn(entry.surfaces, material)) return entry.surfaces[material];
      if (entry.routes && hasOwn(entry.routes, material)) return material;
      const lower = material.toLowerCase();
      const found = (entry.materials ?? []).find((item) => item.name.toLowerCase() === lower);
      return found ? found.route : null;
    }
    if (Number.isInteger(material)) {
      const found = (entry.materials ?? []).find((item) => item.index === material);
      return found ? found.route : null;
    }
    return null;
  }

  async function startVariant(handle, entry, variant, opts) {
    const gain = (opts.gain ?? 1) * variant.gain.value;
    const rate = clampRate(opts.rate ?? variant.rate.value, entry.pitch);
    const loop = opts.loop ?? (entry.loop || variant.loop);
    const voice = await createVoice(handle, variant, {
      gain,
      rate,
      loop,
      pitch: entry.pitch,
      when: opts.when,
      fadeIn: opts.fadeIn ?? fadeIn,
    });
    handle.variants = [variant.wave];
    handle.gain = gain;
    handle.rate = voice.rate;
    handle.loop = loop;
    handle.startedAt = voice.startedAt;
    handle.status = 'playing';
    return handle;
  }

  async function startLayers(handle, entry, opts) {
    const layers = entry.layers ?? [];
    const started = [];
    for (const layer of layers) {
      const layerGain = opts.layerGain && hasOwn(opts.layerGain, layer.id)
        ? opts.layerGain[layer.id]
        : 1;
      const gain = (opts.gain ?? 1) * layer.gain.value * layerGain;
      const rate = clampRate(opts.rate ?? layer.rate.value, entry.pitch);
      const loop = opts.loop ?? (entry.loop || layer.loop);
      const voice = await createVoice(handle, layer, {
        gain,
        rate,
        loop,
        pitch: entry.pitch,
        when: opts.when,
        fadeIn: opts.fadeIn ?? fadeIn,
      });
      started.push(voice);
    }
    handle.variants = layers.map((layer) => layer.wave);
    handle.gain = entry.gain.value;
    handle.rate = 1;
    handle.loop = entry.loop;
    handle.startedAt = started.length ? started[0].startedAt : ctx.currentTime;
    handle.status = 'playing';
    return handle;
  }

  function tyreSample(entry, slip, speed) {
    const speedGain = evalPlf(entry.curves.skidSpeedVolume.points, speed);
    const speedPitch = evalPlf(entry.curves.skidSpeedPitch.points, speed);
    const slipPitch = evalPlf(entry.curves.skidSlidePitchModifier.points, slip);
    const layers = entry.layers.map((layer) => {
      const curve = entry.curves.skidVolume[layer.curveIndex];
      const slipGain = evalPlf(curve.points, slip);
      return {
        wave: layer.wave,
        gain: speedGain * slipGain,
        rate: clampRate(speedPitch * slipPitch, entry.pitch),
      };
    });
    return { slip, speed, speedGain, rate: speedPitch * slipPitch, layers };
  }

  function applyTyre(handle, slip, speed) {
    const entry = handle._entry;
    const sample = tyreSample(entry, slip, speed);
    const now = ctx.currentTime;
    for (const voice of handle._voices) {
      const layer = sample.layers.find((item) => item.wave === voice.variant.wave);
      if (!layer) continue;
      voice.gain = layer.gain;
      voice.rate = layer.rate;
      voice.gainNode.gain.setTargetAtTime(layer.gain, now, smoothing);
      voice.source.playbackRate.setTargetAtTime(layer.rate, now, smoothing);
    }
    handle._tyre = { slip, speed };
    handle.gain = sample.speedGain;
    handle.rate = sample.rate;
    return sample;
  }

  async function startTyre(handle, entry, opts) {
    const slip = isFiniteNumber(opts.slip) ? opts.slip : 0;
    const speed = isFiniteNumber(opts.speed) ? opts.speed : 0;
    const sample = tyreSample(entry, slip, speed);
    const started = [];
    for (const layer of entry.layers) {
      const layerSample = sample.layers.find((item) => item.wave === layer.wave);
      const voice = await createVoice(handle, layer, {
        gain: (opts.gain ?? 1) * layerSample.gain,
        rate: layerSample.rate,
        loop: opts.loop ?? true,
        pitch: entry.pitch,
        when: opts.when,
        fadeIn: opts.fadeIn ?? fadeIn,
      });
      started.push(voice);
    }
    handle._tyre = { slip, speed };
    handle.variants = entry.layers.map((layer) => layer.wave);
    handle.gain = sample.speedGain;
    handle.rate = sample.rate;
    handle.loop = true;
    handle.startedAt = started.length ? started[0].startedAt : ctx.currentTime;
    handle.status = 'playing';
    return handle;
  }

  async function startImpact(handle, entry, opts) {
    let route = null;
    if (opts.route !== undefined && opts.route !== null) {
      if (!entry.routes || !hasOwn(entry.routes, opts.route)) {
        return unsupported(handle, 'unknown-impact-route', `route "${opts.route}" is not in the catalog`);
      }
      route = opts.route;
    } else if (opts.material !== undefined) {
      route = resolveMaterial(entry, opts.material);
      if (!route) {
        return unsupported(handle, 'unsupported-material', `material "${String(opts.material)}" has no retail collision table`);
      }
    } else if (opts.size !== undefined) {
      route = `car-${opts.size}`;
      if (!hasOwn(entry.routes, route)) {
        return unsupported(handle, 'unknown-impact-size', `size "${opts.size}" has no retail car collision table`);
      }
    } else {
      route = entry.defaultRoute;
    }
    const routeInfo = entry.routes[route];
    if (!routeInfo || routeInfo.variantIds.length === 0) {
      return unsupported(handle, 'empty-impact-route', `route "${route}" has no decoded variants`);
    }
    const counter = selectionCounters.get(route) ?? 0;
    selectionCounters.set(route, counter + 1);
    const variantIndex = routeInfo.variantIds[counter % routeInfo.variantIds.length];
    const variant = entry.variants[variantIndex];
    let dynamicDb = null;
    let dynamicGain = 1;
    if (isFiniteNumber(opts.strength)) {
      const curve = entry.volumeCurves[routeInfo.volumeCurve];
      dynamicDb = evalPlf(curve.points, opts.strength);
      dynamicGain = 10 ** (dynamicDb / 20);
    }
    const gain = (opts.gain ?? 1) * routeInfo.gain.value * dynamicGain;
    const rate = clampRate(opts.rate ?? variant.rate.value, entry.pitch);
    const voice = await createVoice(handle, variant, {
      gain,
      rate,
      loop: opts.loop ?? false,
      pitch: entry.pitch,
      when: opts.when,
      fadeIn: opts.fadeIn ?? fadeIn,
    });
    handle.route = route;
    handle.material = opts.material ?? null;
    handle.strength = isFiniteNumber(opts.strength) ? opts.strength : null;
    handle.dynamicGainDb = dynamicDb;
    handle.dynamicGainApplied = dynamicDb !== null;
    handle.variants = [variant.wave];
    handle.gain = gain;
    handle.rate = voice.rate;
    handle.loop = Boolean(opts.loop ?? false);
    handle.startedAt = voice.startedAt;
    handle.status = 'playing';
    return handle;
  }

  function unsupported(handle, reason, detail) {
    unsupportedCount += 1;
    handle.status = 'unsupported';
    handle.reason = reason;
    handle.detail = detail === undefined ? null : String(detail);
    recordError(handle.event, reason, handle.detail);
    return handle;
  }

  function failed(handle, reason, detail) {
    failedCount += 1;
    handle.status = 'failed';
    handle.reason = reason;
    handle.detail = detail === undefined ? null : String(detail);
    recordError(handle.event, reason, handle.detail);
    return handle;
  }

  function createHandle(event, opts) {
    const handle = {
      event,
      status: 'queued',
      reason: null,
      detail: null,
      loop: false,
      gain: null,
      rate: null,
      variants: [],
      startedAt: null,
      ready: null,
      route: null,
      material: null,
      strength: null,
      dynamicGainDb: null,
      dynamicGainApplied: false,
      _entry: null,
      _voices: new Set(),
      _engine: false,
      _tyre: null,
      set(next = {}) {
        if (event === 'engine') {
          return setEngine(next);
        }
        if (handle._tyre) {
          const slip = isFiniteNumber(next.slip) ? next.slip : handle._tyre.slip;
          const speed = isFiniteNumber(next.speed) ? next.speed : handle._tyre.speed;
          return applyTyre(handle, slip, speed);
        }
        if (handle._voices.size > 0) {
          const now = ctx.currentTime;
          for (const voice of handle._voices) {
            if (isFiniteNumber(next.gain)) {
              voice.gain = next.gain;
              voice.gainNode.gain.setTargetAtTime(next.gain, now, smoothing);
            }
            if (isFiniteNumber(next.rate)) {
              voice.rate = clampRate(next.rate, handle._entry.pitch);
              voice.source.playbackRate.setTargetAtTime(voice.rate, now, smoothing);
            }
          }
          if (isFiniteNumber(next.gain)) handle.gain = next.gain;
          if (isFiniteNumber(next.rate)) handle.rate = next.rate;
        }
        return handle;
      },
      stop(fade = fadeOut) {
        if (handle._engine) stopEngine();
        for (const voice of [...handle._voices]) stopVoice(voice, fade);
        handle._voices.clear();
        if (handle.status === 'playing') handle.status = 'stopped';
        return handle;
      },
    };
    handle.ready = (async () => {
      playCount += 1;
      try {
        if (!catalog) {
          try {
            await loadCatalog();
          } catch (error) {
            return unsupported(handle, 'catalog-unavailable', error.message ?? error);
          }
        }
        const entry = catalog.events[event];
        if (!entry) {
          return unsupported(handle, 'unknown-event', `event "${event}" is not in ${AUDIO_SCHEMA}`);
        }
        handle._entry = entry;
        if (entry.status === 'unsupported') {
          return unsupported(handle, entry.reason ?? 'unsupported', entry.detail ?? null);
        }
        if (!(await ensureRunning())) {
          return unsupported(handle, 'context-not-running', `AudioContext.state is "${ctx.state}"`);
        }
        ensureGraph();
        if (entry.kind === 'engine') return await startEngine(handle, entry);
        if (entry.id === 'impact') return await startImpact(handle, entry, opts);
        if (entry.id === 'tyre-squeal') return await startTyre(handle, entry, opts);
        if (entry.layers) return await startLayers(handle, entry, opts);
        const variant = selectVariant(entry, opts);
        if (!variant) {
          return unsupported(handle, 'unknown-variant', `event "${event}" has no matching variant`);
        }
        return await startVariant(handle, entry, variant, opts);
      } catch (error) {
        return failed(handle, error.code ?? 'play-failed', error.message ?? error);
      }
    })();
    return handle;
  }

  function play(event, opts = {}) {
    if (typeof event !== 'string' || event.length === 0) {
      throw new TypeError('runtime-audio: play(event) expects a non-empty event id');
    }
    return createHandle(event, opts);
  }

  function stop(fade = fadeOut) {
    stopEngine();
    for (const voice of [...voices]) stopVoice(voice, fade);
    voices.clear();
    selectionCounters.clear();
    return snapshot();
  }

  function setMuted(value) {
    muted = Boolean(value);
    if (master && ctx) {
      master.gain.setTargetAtTime(muted ? 0 : masterGainValue, ctx.currentTime, 0.01);
    }
    return muted;
  }

  function snapshot() {
    return {
      schema: AUDIO_SCHEMA,
      state,
      contextState: ctx.state,
      baseUrl,
      catalog: {
        state: catalogState,
        url: catalogUrl,
        error: catalogError ? (catalogError.message ?? String(catalogError)) : null,
        events: catalog ? Object.keys(catalog.events).length : 0,
        unsupported: catalog ? Object.keys(catalog.unsupported ?? {}).length : 0,
        schema: catalog ? catalog.schema : null,
      },
      engine: {
        started: engine.started,
        rpm: engine.rpm,
        x: engine.x,
        layers: engine.layers,
        excluded: engine.excluded,
        pendingRpm: pendingEngine.rpm,
      },
      voices: [...voices].map((voice) => ({
        event: voice.event,
        wave: voice.variant.wave,
        loop: voice.loop,
        gain: voice.gain,
        rate: voice.rate,
        startedAt: voice.startedAt,
        stopped: voice.stopped,
      })),
      decoded: [...decoded.values()].map((entry) => ({ ...entry.info })),
      stats: { plays: playCount, unsupported: unsupportedCount, failed: failedCount },
      lastError,
      masterGain: masterGainValue,
      masterGainProvisional: true,
      limiter: limiterNode !== null,
      muted,
    };
  }

  return {
    play,
    setEngine,
    stop,
    snapshot,
    setMuted,
    get state() {
      return state;
    },
    get catalog() {
      return catalog;
    },
  };
}
