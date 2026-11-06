// Engine audio module — retail Blur `Race_V8_engine` RPM layers for Web Audio.
//
// This is a standalone ES module with no framework and no build step. It
// packages the data and the mix that `probes/audio/capture_harness.mjs` proved:
// six decoded `RaceV8_Engine_*` loops, each a looping AudioBufferSourceNode,
// modulated by the exact retail `EngineNVolume` / `EngineNPitch` piecewise
// linear curves.
//
// Provenance of the curve table below (do not edit without re-decoding):
//   object      Race_V8_engine
//   graph       root.pak:\audio\race_v8_engine.dat
//               8,715 bytes, SHA-256 40993340fa508dffc18b79ab93f8c001faa176e418b2187ee19030789b246089
//   bank        root.pak:\audio\race_v8.baf
//               961,744 bytes decoded, SHA-256 f9d25fd4762d1fcf81fdad8419c41a19ec8de8cae945331886b11a18365ff2fe
//   parameter   x = Engine().RPM() * 0.0001
//               (BaseMessageHandler.cpp:1940 and :1970: DynamicsRPM = RPM * .0001)
//   reference   _work/audio/engine-model.json (probes/audio/dump_engine_curves.py)
//
// The numbers are the stored FLT points read from the graph, not a fitted or
// guessed mapping. Layer 7 (`RaceV8_Engine_decel`) is intentionally absent: in
// this graph its volume chain is flat zero and it needs clutch/throttle gating
// that is not modelled. See docs/work/analysis/audio-feasibility.md §4.3/§7.
//
// Non-claims: this is one engine graph for one vehicle class, driven by one
// continuous parameter. It is not the retail mixer, not the Ovis runtime, and
// not full-game audio.

/** Playback-rate floor ported from decoderadpcm4bit.cpp:277-290. */
export const MIN_PLAYBACK_RATE = 0.00390625;

/** Default asset base used by the probe harness; consumers should pass their own. */
export const DEFAULT_BASE_URL = '/_work/audio/';

/**
 * Retail graph identity. Kept in diagnostics so a page can prove which data it
 * is playing.
 */
export const RETAIL_RACE_V8_ENGINE = Object.freeze({
  object: 'Race_V8_engine',
  graph: 'root.pak:\\audio\\race_v8_engine.dat',
  graphBytes: 8715,
  graphSha256: '40993340fa508dffc18b79ab93f8c001faa176e418b2187ee19030789b246089',
  bank: 'root.pak:\\audio\\race_v8.baf',
  bankBytesDecoded: 961744,
  bankSha256: 'f9d25fd4762d1fcf81fdad8419c41a19ec8de8cae945331886b11a18365ff2fe',
  rpmParameter: 'RPMInput',
  rpmDomain: 'x = Engine().RPM() * 0.0001',
  modelReference: '_work/audio/engine-model.json',
  excludedLayers: [
    {
      slot: 7,
      wave: 'RaceV8_Engine_decel',
      reason: 'EngineDecelVolume/EngineDecelThrottleVolume are flat zero in this graph; ' +
        'audible playback needs clutch/throttle state that is not modelled',
    },
  ],
});

function freezePoints(points) {
  return Object.freeze(points.map(([x, y]) => Object.freeze([x, y])));
}

function freezeLayer(layer) {
  return Object.freeze({
    ...layer,
    volume: freezePoints(layer.volume),
    pitch: freezePoints(layer.pitch),
  });
}

/**
 * The six retail RPM layers, verbatim from `_work/audio/engine-model.json`.
 * `volume` is EngineNVolume (RPM x -> gain); `pitch` is EngineNPitch
 * (RPM x -> playbackRate).
 */
export const RETAIL_RACE_V8_ENGINE_CURVES = Object.freeze([
  freezeLayer({
    slot: 1, sound: 'Engine1Sound', bank: 'Race_V8',
    wave: 'RaceV8_Engine_1500', rpmLabel: 1500,
    volume: [[0.08500000089406967, 0], [0.11999999731779099, 1], [0.15000000596046448, 1], [0.22499999403953552, 0]],
    pitch: [[0, 0], [0.2999280095100403, 2]],
  }),
  freezeLayer({
    slot: 2, sound: 'Engine2Sound', bank: 'Race_V8',
    wave: 'RaceV8_Engine_1995', rpmLabel: 1995,
    volume: [[0.125, 0], [0.19300000369548798, 1], [0.22499999403953552, 1], [0.30000001192092896, 0]],
    pitch: [[0, 0], [0.39989998936653137, 2]],
  }),
  freezeLayer({
    slot: 3, sound: 'Engine3Sound', bank: 'Race_V8',
    wave: 'RaceV8_Engine_3015', rpmLabel: 3015,
    volume: [[0.20000000298023224, 0], [0.2680000066757202, 1], [0.32499998807907104, 1], [0.4000000059604645, 0]],
    pitch: [[0, 0], [0.6003900170326233, 2]],
  }),
  freezeLayer({
    slot: 4, sound: 'Engine4Sound', bank: 'Race_V8',
    wave: 'RaceV8_Engine_4005', rpmLabel: 4005,
    volume: [[0.30000001192092896, 0], [0.36800000071525574, 1], [0.42500001192092896, 1], [0.5, 0]],
    pitch: [[0, 0], [0.7978799939155579, 2]],
  }),
  freezeLayer({
    slot: 5, sound: 'Engine5Sound', bank: 'Race_V8',
    wave: 'RaceV8_Engine_4995', rpmLabel: 4995,
    volume: [[0.4000000059604645, 0], [0.46799999475479126, 1], [0.5249999761581421, 1], [0.6000000238418579, 0]],
    pitch: [[0, 0], [1.0000200271606445, 2]],
  }),
  freezeLayer({
    slot: 6, sound: 'Engine6Sound', bank: 'Race_V8',
    wave: 'RaceV8_Engine_6000', rpmLabel: 6000,
    volume: [[0.5, 0], [0.5680000185966492, 1]],
    pitch: [[0, 0], [1.2002700567245483, 2]],
  }),
]);

/**
 * Piecewise-linear evaluation with endpoint clamping.
 *
 * The retail PLF holds the first and last stored value outside the stored
 * range, linearly interpolates between stored points, and returns the latter y
 * for a zero-width segment. This is the same function the P62 harness used
 * (`probes/audio/harness/harness.js`, `evalPlf`), so gains and rates are the
 * ones already verified.
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

/** Retail pitch clamp used for playbackRate. */
export function clampPlaybackRate(rate) {
  if (!Number.isFinite(rate)) {
    throw new TypeError(`engine-audio: playbackRate must be finite, got ${rate}`);
  }
  return Math.max(MIN_PLAYBACK_RATE, rate);
}

function assertRpm(value) {
  const rpm = Number(value);
  if (!Number.isFinite(rpm)) {
    throw new TypeError(`engine-audio: RPM must be a finite number, got ${String(value)}`);
  }
  if (rpm < 0) {
    throw new RangeError(`engine-audio: RPM must be >= 0, got ${rpm}`);
  }
  return rpm;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validateCurves(curves) {
  if (!Array.isArray(curves) || curves.length === 0) {
    throw new TypeError('engine-audio: `curves` must be a non-empty array of layer descriptors');
  }
  curves.forEach((layer, index) => {
    if (!layer || typeof layer !== 'object') {
      throw new TypeError(`engine-audio: curves[${index}] must be an object`);
    }
    if (!Number.isInteger(layer.slot)) {
      throw new TypeError(`engine-audio: curves[${index}].slot must be an integer`);
    }
    if (typeof layer.wave !== 'string' || layer.wave.length === 0) {
      throw new TypeError(`engine-audio: curves[${index}].wave must be a non-empty string`);
    }
    for (const field of ['volume', 'pitch']) {
      const points = layer[field];
      if (!Array.isArray(points) || points.length < 2) {
        throw new TypeError(`engine-audio: curves[${index}].${field} needs at least 2 points`);
      }
      for (const point of points) {
        if (!Array.isArray(point) || point.length !== 2
          || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
          throw new TypeError(`engine-audio: curves[${index}].${field} has a malformed point`);
        }
      }
    }
  });
  return curves;
}

function readRpmLabel(source, layer, index) {
  if (source === null || source === undefined) {
    return layer.rpmLabel === undefined ? null : layer.rpmLabel;
  }
  if (typeof source === 'function') {
    const value = source(layer, index);
    return value === undefined ? null : value;
  }
  if (typeof source === 'object' && !Array.isArray(source)) {
    if (hasOwn(source, layer.wave)) {
      const value = source[layer.wave];
      return value === undefined ? null : value;
    }
    return layer.rpmLabel === undefined ? null : layer.rpmLabel;
  }
  throw new TypeError('engine-audio: `rpmLabel` must be null, a function or a wave->label map');
}

/**
 * Pure curve evaluation. No AudioContext, no buffers, no side effects. Useful
 * for a HUD, a test, or to trim the layer list before creating an engine.
 *
 * @param {number} rpm
 * @param {{ curves?: ReadonlyArray<object>, rpmLabel?: null|Function|Record<string, number|null> }} [options]
 * @returns {{ rpm: number, x: number, layers: Array<object>, excluded: Array<object> }}
 */
export function sampleEngineCurves(rpm, options = {}) {
  const value = assertRpm(rpm);
  const curves = validateCurves(options.curves ?? RETAIL_RACE_V8_ENGINE_CURVES);
  return evaluateLayerCurves(value, curves, options.rpmLabel ?? null);
}

// Hot path: curves and labels are already validated, so this does no checking.
// Called from setRpm(), which must stay cheap at 60 Hz.
function evaluateLayerCurves(rpm, curves, rpmLabel) {
  const x = rpmToX(rpm);
  const layers = [];
  const excluded = [];
  curves.forEach((layer, index) => {
    const label = readRpmLabel(rpmLabel, layer, index);
    if (label === null || !Number.isFinite(label)) {
      excluded.push({ slot: layer.slot, wave: layer.wave, reason: 'no-rpm-label' });
      return;
    }
    layers.push({
      slot: layer.slot,
      wave: layer.wave,
      rpmLabel: label,
      gain: evalPlf(layer.volume, x),
      rate: clampPlaybackRate(evalPlf(layer.pitch, x)),
    });
  });
  return { rpm, x, layers, excluded };
}

function defaultAudioContextFactory() {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (typeof Ctor !== 'function') {
    throw new Error('Web Audio API is not available in this environment');
  }
  return new Ctor({ latencyHint: 'interactive' });
}

function readLevels(analyser) {
  if (!analyser) return null;
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < data.length; i += 1) {
    const value = data[i];
    sum += value * value;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }
  return { rms: Math.sqrt(sum / data.length), peak };
}

function bufferPeak(buffer) {
  const step = Math.max(1, Math.floor(buffer.length / 20000));
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += step) {
      const magnitude = Math.abs(data[i]);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return peak;
}

/**
 * Create an engine-audio instance. This does not touch the Web Audio API: no
 * AudioContext is created until `ensureStarted()` is called from a user
 * gesture, so a page can construct it at load time.
 *
 * @param {{
 *   baseUrl?: string,
 *   fetchImpl?: typeof fetch,
 *   audioContextFactory?: () => AudioContext,
 *   rpmLabel?: null|Function|Record<string, number|null>,
 *   curves?: ReadonlyArray<object>,
 *   initialRpm?: number,
 *   masterGain?: number,
 *   smoothing?: number,
 *   muteSmoothing?: number,
 *   limiter?: boolean,
 *   resolveUrl?: (layer: object, baseUrl: string) => string,
 * }} [options]
 */
export function createEngineAudio(options = {}) {
  const curves = validateCurves(options.curves ?? RETAIL_RACE_V8_ENGINE_CURVES);
  const fetchImpl = options.fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('engine-audio: no fetch implementation available; pass `fetchImpl`');
  }
  const audioContextFactory = options.audioContextFactory ?? defaultAudioContextFactory;
  if (typeof audioContextFactory !== 'function') {
    throw new TypeError('engine-audio: `audioContextFactory` must be a function');
  }

  const baseUrl = String(options.baseUrl ?? DEFAULT_BASE_URL).endsWith('/')
    ? String(options.baseUrl ?? DEFAULT_BASE_URL)
    : `${String(options.baseUrl ?? DEFAULT_BASE_URL)}/`;
  const rpmLabel = options.rpmLabel ?? null;
  const masterLevel = options.masterGain ?? 0.5;
  if (!Number.isFinite(masterLevel) || masterLevel < 0) {
    throw new RangeError('engine-audio: `masterGain` must be a finite number >= 0');
  }
  const smoothing = options.smoothing ?? 0.02;
  if (!Number.isFinite(smoothing) || smoothing <= 0) {
    throw new RangeError('engine-audio: `smoothing` must be a finite number > 0');
  }
  const muteSmoothing = options.muteSmoothing ?? 0.01;
  const useLimiter = options.limiter !== false;
  const resolveUrl = typeof options.resolveUrl === 'function'
    ? options.resolveUrl
    : (layer, base) => base + (layer.file ?? `${encodeURIComponent(layer.wave)}.wav`);

  let state = 'idle';
  let reason = null;
  let detail = null;
  let ctx = null;
  let master = null;
  let analyserNode = null;
  let limiterNode = null;
  let sources = [];
  let sourceBySlot = new Map();
  let decoded = new Map();
  let allDecoded = false;
  let pendingRpm = assertRpm(options.initialRpm ?? 0);
  let appliedRpm = null;
  let muted = false;
  let startPromise = null;
  let startedAt = null;
  const listeners = new Set();

  function snapshotStatus() {
    return { state, reason, detail, contextState: ctx ? ctx.state : 'none' };
  }

  function setState(next, nextReason = null, nextDetail = null) {
    state = next;
    reason = nextReason;
    detail = nextDetail === null || nextDetail === undefined ? null : String(nextDetail);
    const status = snapshotStatus();
    for (const listener of listeners) {
      try {
        listener(status);
      } catch {
        // A broken UI listener must not break the audio state machine.
      }
    }
    return status;
  }

  function fail(nextReason, message, error) {
    // An unavailable engine must not keep an open AudioContext (or a partially
    // started graph) alive.
    teardownNodes();
    return setState('unavailable', nextReason, error ? `${message}: ${error.message ?? error}` : message);
  }

  function computeLayers(rpm) {
    return evaluateLayerCurves(rpm, curves, rpmLabel);
  }

  function buildGraph() {
    master = ctx.createGain();
    master.gain.value = muted ? 0 : masterLevel;
    analyserNode = ctx.createAnalyser();
    analyserNode.fftSize = 2048;
    // Keep the analyser in the signal path: a branch with no output is not
    // pulled in every implementation.
    master.connect(analyserNode);
    let tail = analyserNode;
    if (useLimiter) {
      limiterNode = ctx.createDynamicsCompressor();
      limiterNode.threshold.value = -3;
      limiterNode.knee.value = 6;
      limiterNode.ratio.value = 12;
      limiterNode.attack.value = 0.003;
      limiterNode.release.value = 0.12;
      tail = tail.connect(limiterNode);
    }
    tail.connect(ctx.destination);
  }

  async function loadLayer(layer) {
    const url = resolveUrl(layer, baseUrl);
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
    let bytes;
    try {
      bytes = await response.arrayBuffer();
    } catch (error) {
      const failure = new Error(`${url}: body read failed: ${error.message ?? error}`);
      failure.code = 'fetch-failed';
      throw failure;
    }
    let buffer;
    try {
      buffer = await ctx.decodeAudioData(bytes);
    } catch (error) {
      const failure = new Error(`${url}: decodeAudioData failed: ${error.message ?? error}`);
      failure.code = 'decode-failed';
      throw failure;
    }
    if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0) {
      const failure = new Error(`${url}: decoded buffer has no duration`);
      failure.code = 'decode-failed';
      throw failure;
    }
    return {
      buffer,
      info: {
        slot: layer.slot,
        wave: layer.wave,
        url,
        bytes: bytes.byteLength,
        duration: buffer.duration,
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        peak: bufferPeak(buffer),
      },
    };
  }

  async function loadAll(layers) {
    // Sequential on purpose: six small files, and it keeps failure attribution
    // unambiguous (first failing wave names itself).
    for (const layer of layers) {
      const loaded = await loadLayer(layer);
      decoded.set(layer.slot, loaded);
    }
  }

  function startSources(sample) {
    const now = ctx.currentTime + 0.05;
    sources = sample.layers.map((layer) => {
      const entry = decoded.get(layer.slot);
      if (!entry) {
        const failure = new Error(`no decoded buffer for slot ${layer.slot} (${layer.wave})`);
        failure.code = 'decode-failed';
        throw failure;
      }
      const source = ctx.createBufferSource();
      source.buffer = entry.buffer;
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = entry.buffer.duration;
      const gain = ctx.createGain();
      gain.gain.value = 0; // fade in through setTargetAtTime, like the P62 harness
      source.connect(gain).connect(master);
      source.playbackRate.value = layer.rate;
      gain.gain.setTargetAtTime(layer.gain, now, smoothing);
      source.start(now);
      return {
        slot: layer.slot,
        wave: layer.wave,
        rpmLabel: layer.rpmLabel,
        source,
        gain,
        targetGain: layer.gain,
        targetRate: layer.rate,
      };
    });
    sourceBySlot = new Map(sources.map((entry) => [entry.slot, entry]));
    appliedRpm = sample.rpm;
    startedAt = now;
  }

  function teardownNodes(keepContext = false) {
    for (const entry of sources) {
      try {
        entry.source.stop();
      } catch {
        // Already stopped.
      }
      try {
        entry.source.disconnect();
        entry.gain.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    sources = [];
    sourceBySlot = new Map();
    try {
      if (analyserNode) analyserNode.disconnect();
      if (limiterNode) limiterNode.disconnect();
      if (master) master.disconnect();
    } catch {
      // Already disconnected.
    }
    analyserNode = null;
    limiterNode = null;
    master = null;
    const previous = ctx;
    if (!keepContext) ctx = null;
    if (previous && previous.state !== 'closed') {
      try {
        const closing = previous.close();
        if (closing && typeof closing.catch === 'function') closing.catch(() => {});
      } catch {
        // Already closing.
      }
    }
    appliedRpm = null;
  }

  async function start() {
    setState('loading');
    if (ctx) {
      // Retry after a failure: drop the previous context instead of leaking it.
      teardownNodes();
      decoded = new Map();
      allDecoded = false;
    }
    try {
      ctx = audioContextFactory();
    } catch (error) {
      return fail('no-audio-context', 'AudioContext could not be created', error);
    }
    if (!ctx) {
      return fail('no-audio-context', 'audioContextFactory returned nothing');
    }
    try {
      buildGraph();
    } catch (error) {
      return fail('graph-failed', 'Web Audio graph could not be built', error);
    }
    try {
      await ctx.resume();
    } catch (error) {
      return fail('resume-failed', 'AudioContext.resume() rejected (user gesture missing?)', error);
    }
    if (ctx.state !== 'running') {
      return fail('not-running', `AudioContext.state is "${ctx.state}" after resume()`);
    }
    if (!allDecoded) {
      decoded = new Map();
      try {
        await loadAll(computeLayers(pendingRpm).layers);
        allDecoded = true;
      } catch (error) {
        decoded = new Map();
        return fail(error.code ?? 'load-failed', 'engine audio unavailable', error);
      }
    }
    try {
      startSources(computeLayers(pendingRpm));
    } catch (error) {
      return fail(error.code ?? 'start-failed', 'engine audio could not start', error);
    }
    return setState('running');
  }

  /**
   * Create the AudioContext, resume it, load and decode the six WAVs, and start
   * one looping source per layer. Must be called from a user gesture.
   *
   * Never rejects: failures resolve to a typed status
   * (`state: 'unavailable'`, `reason: 'fetch-failed' | 'decode-failed' | ...`).
   * Calling it again after a failure retries.
   */
  async function ensureStarted() {
    if (state === 'disposed') return snapshotStatus();
    if (state === 'running') {
      if (ctx && ctx.state !== 'running') {
        try {
          await ctx.resume();
        } catch (error) {
          return fail('resume-failed', 'AudioContext.resume() rejected', error);
        }
      }
      return snapshotStatus();
    }
    if (startPromise) return startPromise;
    startPromise = start();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  /**
   * Set the engine RPM. Stores the value when audio is not running yet and
   * otherwise applies gain/playbackRate with `setTargetAtTime(smoothing)`.
   * @returns {{ rpm: number, x: number, layers: Array<object>, excluded: Array<object> }}
   */
  function setRpm(value) {
    const rpm = assertRpm(value);
    pendingRpm = rpm;
    const sample = computeLayers(rpm);
    if (state !== 'running' || !ctx) return sample;
    const now = ctx.currentTime;
    for (const layer of sample.layers) {
      const entry = sourceBySlot.get(layer.slot);
      if (!entry) continue;
      entry.gain.gain.setTargetAtTime(layer.gain, now, smoothing);
      entry.source.playbackRate.setTargetAtTime(layer.rate, now, smoothing);
      entry.targetGain = layer.gain;
      entry.targetRate = layer.rate;
    }
    appliedRpm = rpm;
    return sample;
  }

  /** Mute/unmute through the master gain. Returns the new muted flag. */
  function setMuted(value) {
    muted = Boolean(value);
    if (master && ctx) {
      master.gain.setTargetAtTime(muted ? 0 : masterLevel, ctx.currentTime, muteSmoothing);
    }
    return muted;
  }

  /** Stop sources, close the context and drop decoded buffers. Idempotent. */
  function dispose() {
    // Keep the (now closed) context object so diagnostics can report its real
    // state instead of guessing.
    teardownNodes(true);
    decoded = new Map();
    allDecoded = false;
    startedAt = null;
    return setState('disposed');
  }

  function getDiagnostics() {
    const sample = computeLayers(pendingRpm);
    return {
      state,
      reason,
      detail,
      contextState: ctx ? ctx.state : 'none',
      sampleRate: ctx ? ctx.sampleRate : null,
      baseUrl,
      rpm: sample.rpm,
      x: sample.x,
      appliedRpm,
      muted,
      masterGain: masterLevel,
      smoothing,
      startedAt,
      curves: {
        source: 'retail Race_V8_engine.dat EngineNVolume/EngineNPitch PLF',
        layers: curves.length,
        provenance: RETAIL_RACE_V8_ENGINE,
      },
      decoded: [...decoded.values()].map((entry) => ({ ...entry.info })),
      targets: sample.layers,
      layers: sources.map((entry) => ({
        slot: entry.slot,
        wave: entry.wave,
        rpmLabel: entry.rpmLabel,
        targetGain: entry.targetGain,
        targetRate: entry.targetRate,
        gain: entry.gain.gain.value,
        rate: entry.source.playbackRate.value,
      })),
      excluded: sample.excluded,
      levels: readLevels(analyserNode),
    };
  }

  return {
    ensureStarted,
    setRpm,
    setMuted,
    dispose,
    getDiagnostics,
    sampleAt: computeLayers,
    get state() {
      return state;
    },
    get status() {
      return snapshotStatus();
    },
    onStatusChange(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('engine-audio: onStatusChange expects a function');
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get curves() {
      return curves;
    },
    get provenance() {
      return RETAIL_RACE_V8_ENGINE;
    },
  };
}
