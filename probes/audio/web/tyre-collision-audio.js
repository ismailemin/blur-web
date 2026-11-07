// Tyre + collision audio module — retail Blur wheel and impact layers for Web Audio.
//
// Standalone ES module (no framework, no build step). It packages the data and
// the mix decoded by `probes/audio/extract_baf.py`, `extract_dat.py`,
// `inspect_dat.py` and `dump_tyre_collision.py`:
//
//   tyre       Wheel_Dry / Wheel_OffRoad loops, driven by the retail
//              GroundSpeed / WheelXSlide curves in wheel_dry.dat and
//              wheel_offroad.dat.
//   collision  CollisionWorld one-shot tables, material routing recovered from
//              the CollisionScript bytecode in collisionworld.dat, and the
//              retail CollisionVolume force->dB curve.
//
// Provenance (do not edit without re-decoding):
//   wheel_dry.dat       8,900 B  sha256 783dd4844c602d483b2be4ae0e89a35af253c47930f8c380c4ed23aae535397a
//   wheel_offroad.dat  20,895 B  sha256 0bfeef0d74e241156301a946aaa31936b3c1b78e5f7a6179d90beefa55e00fdb
//   collisionworld.dat  5,891 B  sha256 1cbd19fe2e604721b7cbe45496510573ae6ee0784b2d0a1bae8cb95d03d62549
//   reference                   _work/audio/tyre-collision-model.json
//
// Non-claims: this is one continuous two-state tyre model (dry/offroad), one
// material-routed world-impact path, and one active impact voice. It is not
// the retail mixer, not the Ovis runtime, and not full-game audio.

import { evalPlf, MIN_PLAYBACK_RATE } from './engine-audio.js';

export { evalPlf, MIN_PLAYBACK_RATE };

export const DEFAULT_BASE_URL = '/_work/audio/';

const freezePoints = (points) => Object.freeze(points.map(([x, y]) => Object.freeze([x, y])));

/** E_EffectMaterial order, from upstream Materials.h:15-57. */
export const EFFECT_MATERIALS = Object.freeze([
  'Default', 'Tarmac', 'Concrete', 'Rock', 'Dirt', 'Mud', 'Grass', 'Gravel', 'Sand',
  'WetSand', 'Water', 'Brick', 'Vegetation', 'Wood', 'Metal', 'Plastic', 'Glass',
  'Rubber', 'Upholstery', 'Cardboard', 'Flesh', 'TrainTracks', 'WaterDeep',
  'ConcreteFenceChain', 'ConcreteFencePlastic', 'MetalHollow', 'MetalArmco',
  'MetalSheet', 'MetalFenceChain', 'MetalFenceSolid', 'MetalFenceSlatted',
  'MetalSolidPost', 'DirtLightRough', 'DirtHeavyRough', 'WackyMagic', 'PavingStone',
  'Vehicle',
]);

/**
 * CollisionWorld.cpp CollisionScript (155 words) routes these
 * E_EffectMaterial values to one of the 14 surface sound tables. Values not
 * listed here fall through the retail script without playing an impact sound.
 */
export const MATERIAL_TO_SURFACE = Object.freeze({
  2: 'concrete_large',
  3: 'concrete_large',
  11: 'concrete_large',
  12: 'vegetation_hedge',
  13: 'wood_fence',
  14: 'metal_sheet',
  15: 'metal_sheet',
  16: 'glass_hit',
  17: 'rubber_tyre',
  23: 'concrete_fence_chain',
  24: 'concrete_fence_plastic',
  25: 'metal_hollow_large',
  26: 'metal_armco',
  27: 'metal_sheet',
  28: 'metal_fence_chainlink',
  29: 'metal_solid_medium',
  30: 'metal_railing',
  31: 'metal_post_tall',
});

const collisionSurface = (bank, waves) => Object.freeze({
  bank,
  waves: Object.freeze(waves),
});

/** 14 MonoOneShotSoundTable components in CollisionWorld, verbatim. */
export const COLLISION_SURFACES = Object.freeze({
  concrete_fence_chain: collisionSurface('DO_concrete_fence_chain',
    ['imp_conchain01', 'imp_conchain02', 'imp_conchain03']),
  concrete_fence_plastic: collisionSurface('DO_concrete_fence_plastic',
    ['imp_conplast01', 'imp_conplast02', 'imp_conplast03']),
  concrete_large: collisionSurface('DO_concrete_large',
    ['imp_concl01', 'imp_concl02', 'imp_concl03']),
  glass_hit: collisionSurface('DO_glass_hit',
    ['imp_glasshit01', 'imp_glasshit02', 'imp_glasshit03']),
  metal_armco: collisionSurface('DO_metal_armco',
    ['imp_armco01', 'imp_armco02', 'imp_armco03']),
  metal_fence_chainlink: collisionSurface('DO_metal_fence_chainlink',
    ['imp_metal_fence_chainlink01', 'imp_metal_fence_chainlink02', 'imp_metal_fence_chainlink03']),
  metal_hollow_large: collisionSurface('DO_metal_hollow_large',
    ['imp_metholol01', 'imp_metholol02', 'imp_metholol03']),
  metal_post_tall: collisionSurface('DO_metal_post_tall',
    ['imp_metpostt01', 'imp_metpostt02', 'imp_metpostt03']),
  metal_railing: collisionSurface('DO_metal_railing',
    ['imp_metrailng01', 'imp_metrailng02', 'imp_metrailng03']),
  metal_sheet: collisionSurface('DO_metal_sheet',
    ['imp_metsheet01', 'imp_metsheet02', 'imp_metsheet03']),
  metal_solid_medium: collisionSurface('DO_metal_solid_medium',
    ['imp_metalsolidm01', 'imp_metalsolidm02', 'imp_metalsolidm03']),
  rubber_tyre: collisionSurface('DO_rubber_tyre',
    ['imp_tyre01', 'imp_tyre02', 'imp_tyre03']),
  vegetation_hedge: collisionSurface('DO_vegetation_hedge',
    ['imp_veghedge01', 'imp_veghedge02', 'imp_veghedge03']),
  wood_fence: collisionSurface('DO_wood_fence',
    ['imp_wood_fence01', 'imp_wood_fence02', 'imp_wood_fence03']),
});

/** Retail CollisionVolume PLF, stored in dB relative to 1.0. */
export const COLLISION_VOLUME_DB = freezePoints([[0.800000011920929, -5.0], [50.0, 3.0]]);

/**
 * Wheel_Dry curves, verbatim from wheel_dry.dat. Every `control` is the retail
 * component index documented in `_work/audio/tyre-collision-model.json`.
 *   roadGain        DryRoadSpeedVolumeTrue, control 8 (GroundSpeedInput)
 *   skidSpeed       SkidSpeedVolume,           control 8 (GroundSpeedInput)
 *   skidSlip[n]     Asphalt_SkidNVolumePLF,    control 1 (WheelXSlideInput)
 *   skidPitchSpeed  SkidSpeedPitch,            control 8
 *   skidPitchSlip   Asphalt_SkidSlidePitchModifier, control 1
 */
export const DRY_TYRE = Object.freeze({
  road: Object.freeze({ wave: 'Asphalt_Road' }),
  skid: Object.freeze([
    Object.freeze({ id: 'skid0', wave: 'Asphalt_Lateral_1', slip: 0 }),
    Object.freeze({ id: 'skid1', wave: 'Asphalt_Lateral_2', slip: 1 }),
    Object.freeze({ id: 'skid2', wave: 'Asphalt_Lateral_3', slip: 2 }),
  ]),
  roadGain: freezePoints([[-100.0, 1.0], [0.0, 0.0], [100.0, 1.0]]),
  skidSpeed: freezePoints([[-50.0, 1.0], [-5.0, 0.25], [-1.0, 0.0], [1.0, 0.0], [5.0, 0.25], [50.0, 1.0]]),
  skidSlip: Object.freeze([
    freezePoints([[-0.3499999940395355, 0.0], [-0.20000000298023224, 1.0], [-0.03999999910593033, 0.0], [0.03999999910593033, 0.0], [0.20000000298023224, 1.0], [0.3499999940395355, 0.0]]),
    freezePoints([[-0.8500000238418579, 0.0], [-0.3499999940395355, 1.0], [-0.15000000596046448, 0.0], [0.15000000596046448, 0.0], [0.3499999940395355, 1.0], [0.8500000238418579, 0.0]]),
    freezePoints([[-0.8999999761581421, 1.0], [-0.3499999940395355, 0.0], [0.3499999940395355, 0.0], [0.8999999761581421, 1.0]]),
  ]),
  skidPitchSpeed: freezePoints([[-10.0, 1.0], [-1.0, 1.2999999523162842], [1.0, 1.2999999523162842], [10.0, 1.0]]),
  skidPitchSlip: freezePoints([[-0.8500000238418579, 0.8500000238418579], [-0.05000000074505806, 1.2999999523162842], [0.05000000074505806, 1.2999999523162842], [0.8500000238418579, 0.8500000238418579]]),
});

/**
 * Wheel_OffRoad curves, verbatim from wheel_offroad.dat. Grass uses the
 * Dirt_road / Dirt_skid waves because that is what Grass_Road_Sound and
 * Grass_Skid_Sound reference in the graph; this is a retail mapping, not a
 * naming assumption.
 */
export const OFFROAD_TYRE = Object.freeze({
  substrates: Object.freeze({
    gravel: Object.freeze({ road: 'Gravel_road', skid: 'Gravel_skid' }),
    grass: Object.freeze({ road: 'Dirt_road', skid: 'Dirt_skid' }),
    sand: Object.freeze({ road: 'Sand_road', skid: 'Sand_skid' }),
    foliage: Object.freeze({ road: 'Foliage_road', skid: null }),
  }),
  roadGain: freezePoints([[-60.0, 1.0], [0.0, 0.0], [60.0, 1.0]]),
  skidSpeed: freezePoints([[-35.0, 1.0], [-5.0, 0.25], [-2.0, 0.0], [2.0, 0.0], [5.0, 0.25], [35.0, 1.0]]),
  skidSlip: freezePoints([[-1.0, 1.0], [-0.15000000596046448, 0.699999988079071], [-0.05000000074505806, 0.0], [0.05000000074505806, 0.0], [0.15000000596046448, 0.699999988079071], [1.0, 1.0]]),
  skidPitchSpeed: freezePoints([[-10.0, 0.8500000238418579], [-1.0, 1.0], [1.0, 1.0], [10.0, 0.8500000238418579]]),
  skidPitchSlip: freezePoints([[-0.699999988079071, 1.0], [-0.25, 0.8500000238418579], [0.25, 0.8500000238418579], [0.699999988079071, 1.0]]),
});

export const RETAIL_TYRE_COLLISION = Object.freeze({
  wheelController: Object.freeze({
    dat: 'root.pak:\\audio\\dat\\wheel_controller.dat',
    bytes: 4386,
    sha256: 'cfa5ed18deb50f4d2b625350d81d4742a4cb0e5aa204509bb1933bddfa500852',
  }),
  wheelDry: Object.freeze({
    dat: 'root.pak:\\audio\\dat\\wheel_dry.dat',
    bytes: 8900,
    sha256: '783dd4844c602d483b2be4ae0e89a35af253c47930f8c380c4ed23aae535397a',
    bank: 'root.pak:\\audio\\wheel_dry.baf',
    bankSha256: '8d451333a13923607c23e6093df085207deb74264a012e55bec2b2c9a6b7d90d',
  }),
  wheelOffroad: Object.freeze({
    dat: 'root.pak:\\audio\\dat\\wheel_offroad.dat',
    bytes: 20895,
    sha256: '0bfeef0d74e241156301a946aaa31936b3c1b78e5f7a6179d90beefa55e00fdb',
    bank: 'root.pak:\\audio\\wheel_offroad.baf',
    bankSha256: 'cb0dfc118957d70aa83e2d5123cb0cf43f50ed00552cb43286a1b5e282a8216a',
  }),
  collisionWorld: Object.freeze({
    dat: 'root.pak:\\audio\\dat\\collisionworld.dat',
    bytes: 5891,
    sha256: '1cbd19fe2e604721b7cbe45496510573ae6ee0784b2d0a1bae8cb95d03d62549',
  }),
  carCollisionsBank: Object.freeze({
    bank: 'root.pak:\\audio\\car_collisions.baf',
    logicalBytes: 2121181,
    bankSha256: '9663d8210f5d21dc9bdcc965c5d35045c08464455ec673fca35ce49cb2fc2339',
    note: 'decoded for the collision slice; the wheel/impact module wires the DO_* surface tables, not this car-to-car bank',
  }),
  modelReference: '_work/audio/tyre-collision-model.json',
  materialSource: 'upstream/BlurRebuilt/code/amax/game/Game/GameDef/Materials.h:15-57',
  scriptSource: 'upstream/BlurRebuilt/code/mercury/library/audio/source/components/Script.cpp:34-451',
});

function assertSurface(surface) {
  if (surface !== 'dry' && surface !== 'offroad') {
    throw new RangeError(`tyre-collision-audio: surface must be 'dry' or 'offroad', got ${String(surface)}`);
  }
  return surface;
}

function assertSubstrate(substrate) {
  if (!Object.prototype.hasOwnProperty.call(OFFROAD_TYRE.substrates, substrate)) {
    throw new RangeError(`tyre-collision-audio: unknown offroad substrate ${String(substrate)}`);
  }
  return substrate;
}

function assertFinite(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`tyre-collision-audio: ${name} must be a finite number, got ${String(value)}`);
  }
  return number;
}

function clampRate(rate) {
  return Math.max(MIN_PLAYBACK_RATE, rate);
}

/** 10^(dB/20); the collision graph stores CollisionVolume in dB. */
export function dbToGain(db) {
  return 10 ** (db / 20);
}

function sampleDry(slip, speed) {
  const speedGain = evalPlf(DRY_TYRE.skidSpeed, speed);
  const speedPitch = evalPlf(DRY_TYRE.skidPitchSpeed, speed);
  const slipPitch = evalPlf(DRY_TYRE.skidPitchSlip, slip);
  return {
    surface: 'dry',
    substrate: null,
    layers: [
      { id: 'road', wave: DRY_TYRE.road.wave, gain: evalPlf(DRY_TYRE.roadGain, speed), rate: 1 },
      ...DRY_TYRE.skid.map((layer, index) => ({
        id: layer.id,
        wave: layer.wave,
        gain: speedGain * evalPlf(DRY_TYRE.skidSlip[index], slip),
        rate: clampRate(speedPitch * slipPitch),
      })),
    ],
  };
}

function sampleOffroad(substrate, slip, speed) {
  const waves = OFFROAD_TYRE.substrates[substrate];
  const speedGain = evalPlf(OFFROAD_TYRE.skidSpeed, speed);
  const speedPitch = evalPlf(OFFROAD_TYRE.skidPitchSpeed, speed);
  const slipPitch = evalPlf(OFFROAD_TYRE.skidPitchSlip, slip);
  const layers = [
    { id: 'road', wave: waves.road, gain: evalPlf(OFFROAD_TYRE.roadGain, speed), rate: 1 },
  ];
  if (waves.skid) {
    layers.push({
      id: 'skid',
      wave: waves.skid,
      gain: speedGain * evalPlf(OFFROAD_TYRE.skidSlip, slip),
      rate: clampRate(speedPitch * slipPitch),
    });
  }
  return { surface: 'offroad', substrate, layers };
}

/** Pure tyre curve evaluation. No AudioContext, no side effects. */
export function sampleTyreCurves({ surface = 'dry', substrate = 'gravel', slip = 0, speed = 0 } = {}) {
  const validSurface = assertSurface(surface);
  const validSubstrate = validSurface === 'offroad' ? assertSubstrate(substrate) : null;
  const slipValue = assertFinite('slip', slip);
  const speedValue = assertFinite('speed', speed);
  if (speedValue < 0) {
    throw new RangeError(`tyre-collision-audio: speed must be >= 0, got ${speedValue}`);
  }
  return validSurface === 'dry'
    ? sampleDry(slipValue, speedValue)
    : sampleOffroad(validSubstrate, slipValue, speedValue);
}

/** Resolve a material (name or index) to a decoded surface key, or null. */
export function resolveCollisionMaterial(material) {
  if (material === undefined || material === null) {
    return { index: 14, name: 'Metal', surface: 'metal_sheet' };
  }
  if (typeof material === 'string') {
    if (Object.prototype.hasOwnProperty.call(COLLISION_SURFACES, material)) {
      return { index: null, name: material, surface: material };
    }
    const index = EFFECT_MATERIALS.findIndex((name) => name.toLowerCase() === material.toLowerCase());
    if (index < 0) return { index: null, name: material, surface: null };
    return { index, name: EFFECT_MATERIALS[index], surface: MATERIAL_TO_SURFACE[index] ?? null };
  }
  if (Number.isInteger(material) && material >= 0 && material < EFFECT_MATERIALS.length) {
    return { index: material, name: EFFECT_MATERIALS[material], surface: MATERIAL_TO_SURFACE[material] ?? null };
  }
  return { index: null, name: String(material), surface: null };
}

/** Pure collision evaluation: force -> surface + linear gain. */
export function sampleCollision(strength, material) {
  const force = assertFinite('strength', strength);
  if (force < 0) {
    throw new RangeError(`tyre-collision-audio: strength must be >= 0, got ${force}`);
  }
  const resolved = resolveCollisionMaterial(material);
  if (!resolved.surface) {
    return { ...resolved, strength: force, gainDb: null, gain: null, supported: false };
  }
  const gainDb = evalPlf(COLLISION_VOLUME_DB, force);
  return { ...resolved, strength: force, gainDb, gain: dbToGain(gainDb), supported: true };
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
 * Create a tyre + collision audio instance. Like the engine module this is
 * synchronous and creates no AudioContext until `ensureStarted()` is called
 * from a user gesture.
 */
export function createTyreCollisionAudio(options = {}) {
  const fetchImpl = options.fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('tyre-collision-audio: no fetch implementation available; pass `fetchImpl`');
  }
  const audioContextFactory = options.audioContextFactory ?? defaultAudioContextFactory;
  if (typeof audioContextFactory !== 'function') {
    throw new TypeError('tyre-collision-audio: `audioContextFactory` must be a function');
  }
  const baseUrl = String(options.baseUrl ?? DEFAULT_BASE_URL).endsWith('/')
    ? String(options.baseUrl ?? DEFAULT_BASE_URL)
    : `${String(options.baseUrl ?? DEFAULT_BASE_URL)}/`;
  const masterLevel = options.masterGain ?? 0.5;
  if (!Number.isFinite(masterLevel) || masterLevel < 0) {
    throw new RangeError('tyre-collision-audio: `masterGain` must be a finite number >= 0');
  }
  const smoothing = options.smoothing ?? 0.02;
  if (!Number.isFinite(smoothing) || smoothing <= 0) {
    throw new RangeError('tyre-collision-audio: `smoothing` must be a finite number > 0');
  }
  const muteSmoothing = options.muteSmoothing ?? 0.01;
  const useLimiter = options.limiter !== false;
  const resolveUrl = typeof options.resolveUrl === 'function'
    ? options.resolveUrl
    : (wave, base) => base + `${encodeURIComponent(wave)}.wav`;

  let state = 'idle';
  let reason = null;
  let detail = null;
  let ctx = null;
  let master = null;
  let analyserNode = null;
  let limiterNode = null;
  let tyreSources = [];
  let tyreByWave = new Map();
  let decoded = new Map();
  let impactVoice = null;
  let impactActive = false;
  let impactTimer = null;
  let impactCount = 0;
  let lastImpact = null;
  let surface = 'dry';
  let substrate = 'gravel';
  let slip = 0;
  let speed = 0;
  let muted = false;
  let startPromise = null;
  let startedAt = null;
  const listeners = new Set();
  const impactListeners = new Set();

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

  function emitImpact(event) {
    for (const listener of impactListeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener failures.
      }
    }
  }

  function tyreWaveNames() {
    const waves = new Set();
    for (const layer of sampleDry(0, 0).layers) waves.add(layer.wave);
    for (const name of Object.keys(OFFROAD_TYRE.substrates)) {
      for (const layer of sampleOffroad(name, 0, 0).layers) waves.add(layer.wave);
    }
    return [...waves];
  }

  function allWaveNames() {
    const waves = new Set(tyreWaveNames());
    for (const entry of Object.values(COLLISION_SURFACES)) {
      for (const wave of entry.waves) waves.add(wave);
    }
    return [...waves];
  }

  function fail(nextReason, message, error) {
    teardownNodes();
    return setState('unavailable', nextReason, error ? `${message}: ${error.message ?? error}` : message);
  }

  function buildGraph() {
    master = ctx.createGain();
    master.gain.value = muted ? 0 : masterLevel;
    analyserNode = ctx.createAnalyser();
    analyserNode.fftSize = 2048;
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

  async function loadWave(wave) {
    const url = resolveUrl(wave, baseUrl);
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
        wave,
        url,
        bytes: bytes.byteLength,
        duration: buffer.duration,
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        peak: bufferPeak(buffer),
      },
    };
  }

  async function loadAll() {
    for (const wave of allWaveNames()) {
      decoded.set(wave, await loadWave(wave));
    }
  }

  function applyTyreTargets(sample, now) {
    const active = new Map(sample.layers.map((layer) => [layer.wave, layer]));
    for (const entry of tyreSources) {
      const layer = active.get(entry.wave);
      const gain = layer ? layer.gain : 0;
      const rate = layer ? layer.rate : 1;
      entry.gain.gain.setTargetAtTime(gain, now, smoothing);
      entry.source.playbackRate.setTargetAtTime(rate, now, smoothing);
      entry.targetGain = gain;
      entry.targetRate = rate;
    }
  }

  function startTyreSources(sample) {
    const now = ctx.currentTime + 0.05;
    tyreSources = tyreWaveNames().map((wave) => {
      const entry = decoded.get(wave);
      if (!entry) {
        const failure = new Error(`no decoded buffer for ${wave}`);
        failure.code = 'decode-failed';
        throw failure;
      }
      const source = ctx.createBufferSource();
      source.buffer = entry.buffer;
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = entry.buffer.duration;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(master);
      source.playbackRate.value = 1;
      source.start(now);
      return { wave, source, gain, targetGain: 0, targetRate: 1 };
    });
    tyreByWave = new Map(tyreSources.map((entry) => [entry.wave, entry]));
    applyTyreTargets(sample, now);
    startedAt = now;
  }

  function stopImpact() {
    if (impactTimer !== null) {
      clearTimeout(impactTimer);
      impactTimer = null;
    }
    if (!impactVoice) {
      impactActive = false;
      return;
    }
    const voice = impactVoice;
    impactVoice = null;
    impactActive = false;
    try {
      voice.source.stop();
    } catch {
      // Already stopped.
    }
    try {
      voice.source.disconnect();
      voice.gain.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  function teardownNodes(keepContext = false) {
    stopImpact();
    for (const entry of tyreSources) {
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
    tyreSources = [];
    tyreByWave = new Map();
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
  }

  async function start() {
    setState('loading');
    if (ctx) {
      teardownNodes();
      decoded = new Map();
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
    try {
      await loadAll();
    } catch (error) {
      decoded = new Map();
      return fail(error.code ?? 'load-failed', 'tyre/collision audio unavailable', error);
    }
    try {
      startTyreSources(currentSample());
    } catch (error) {
      return fail(error.code ?? 'start-failed', 'tyre/collision audio could not start', error);
    }
    return setState('running');
  }

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

  function currentSample() {
    return sampleTyreCurves({ surface, substrate, slip, speed });
  }

  function setSurface(nextSurface, nextSubstrate = substrate) {
    const validSurface = assertSurface(nextSurface);
    const validSubstrate = validSurface === 'offroad' ? assertSubstrate(nextSubstrate) : 'gravel';
    surface = validSurface;
    substrate = validSubstrate;
    const sample = currentSample();
    if (state === 'running' && ctx) {
      applyTyreTargets(sample, ctx.currentTime);
    }
    return sample;
  }

  function setSlip(nextSlip, nextSpeed) {
    slip = assertFinite('slip', nextSlip);
    speed = assertFinite('speed', nextSpeed);
    if (speed < 0) {
      throw new RangeError(`tyre-collision-audio: speed must be >= 0, got ${speed}`);
    }
    const sample = currentSample();
    if (state === 'running' && ctx) {
      applyTyreTargets(sample, ctx.currentTime);
    }
    return sample;
  }

  function setMuted(value) {
    muted = Boolean(value);
    if (master && ctx) {
      master.gain.setTargetAtTime(muted ? 0 : masterLevel, ctx.currentTime, muteSmoothing);
    }
    return muted;
  }

  function triggerImpact(strength, material) {
    const sample = sampleCollision(strength, material);
    if (!sample.supported) {
      lastImpact = { ...sample, triggered: false, reason: 'unsupported-material', at: null };
      emitImpact(lastImpact);
      return lastImpact;
    }
    const gain = sample.gain;
    if (!Number.isFinite(gain) || gain <= 0) {
      lastImpact = { ...sample, triggered: false, reason: 'below-threshold', at: null };
      emitImpact(lastImpact);
      return lastImpact;
    }
    if (state !== 'running' || !ctx) {
      lastImpact = { ...sample, triggered: false, reason: 'not-running', at: null };
      emitImpact(lastImpact);
      return lastImpact;
    }
    if (impactActive) {
      lastImpact = { ...sample, triggered: false, reason: 'in-progress', at: ctx.currentTime };
      emitImpact(lastImpact);
      return lastImpact;
    }
    const table = COLLISION_SURFACES[sample.surface];
    const round = impactCount % table.waves.length;
    const wave = table.waves[round];
    const entry = decoded.get(wave);
    if (!entry) {
      lastImpact = { ...sample, triggered: false, reason: 'decode-failed', at: ctx.currentTime };
      emitImpact(lastImpact);
      return lastImpact;
    }
    const now = ctx.currentTime + 0.005;
    const source = ctx.createBufferSource();
    source.buffer = entry.buffer;
    source.loop = false;
    source.playbackRate.value = 1;
    const gate = ctx.createGain();
    gate.gain.setValueAtTime(gain, now);
    source.connect(gate).connect(master);
    const voice = { source, gain: gate, wave, startedAt: now };
    impactVoice = voice;
    impactActive = true;
    impactCount += 1;
    const event = {
      ...sample,
      triggered: true,
      reason: null,
      wave,
      waveIndex: round,
      bank: table.bank,
      at: now,
      duration: entry.info.duration,
    };
    lastImpact = event;
    source.onended = () => {
      if (impactVoice === voice) {
        impactVoice = null;
        impactActive = false;
      }
      try {
        source.disconnect();
        gate.disconnect();
      } catch {
        // Already disconnected.
      }
      if (impactTimer !== null) {
        clearTimeout(impactTimer);
        impactTimer = null;
      }
      emitImpact({ ...event, ended: true });
    };
    impactTimer = setTimeout(() => {
      if (impactVoice === voice) {
        impactActive = false;
        impactVoice = null;
        try {
          source.stop();
          source.disconnect();
          gate.disconnect();
        } catch {
          // Already stopped/disconnected.
        }
      }
      impactTimer = null;
    }, Math.ceil(entry.info.duration * 1000) + 100);
    source.start(now);
    emitImpact(event);
    return event;
  }

  function dispose() {
    teardownNodes(true);
    decoded = new Map();
    startedAt = null;
    return setState('disposed');
  }

  function getDiagnostics() {
    const sample = currentSample();
    return {
      state,
      reason,
      detail,
      contextState: ctx ? ctx.state : 'none',
      sampleRate: ctx ? ctx.sampleRate : null,
      baseUrl,
      surface,
      substrate,
      slip,
      speed,
      muted,
      masterGain: masterLevel,
      smoothing,
      startedAt,
      provenance: RETAIL_TYRE_COLLISION,
      decoded: [...decoded.values()].map((entry) => ({ ...entry.info })),
      tyreTargets: sample.layers,
      tyreLayers: tyreSources.map((entry) => ({
        wave: entry.wave,
        targetGain: entry.targetGain,
        targetRate: entry.targetRate,
        gain: entry.gain.gain.value,
        rate: entry.source.playbackRate.value,
      })),
      collision: {
        surfaces: Object.keys(COLLISION_SURFACES).length,
        materialRoutes: Object.keys(MATERIAL_TO_SURFACE).length,
        volumeDb: COLLISION_VOLUME_DB,
        active: impactActive,
        activeWave: impactVoice ? impactVoice.wave : null,
        played: impactCount,
        last: lastImpact,
      },
      levels: readLevels(analyserNode),
    };
  }

  return {
    ensureStarted,
    setSurface,
    setSlip,
    triggerImpact,
    setMuted,
    dispose,
    getDiagnostics,
    sampleAt: () => currentSample(),
    sampleCollision,
    get state() {
      return state;
    },
    get status() {
      return snapshotStatus();
    },
    onStatusChange(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('tyre-collision-audio: onStatusChange expects a function');
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onImpact(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('tyre-collision-audio: onImpact expects a function');
      }
      impactListeners.add(listener);
      return () => impactListeners.delete(listener);
    },
    get surface() {
      return surface;
    },
    get substrate() {
      return substrate;
    },
    get provenance() {
      return RETAIL_TYRE_COLLISION;
    },
  };
}
