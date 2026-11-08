#!/usr/bin/env node
// Deterministic builder for `probes/audio/data/runtime-audio.json`.
//
// Inputs are the canonical, already-verified retail audio artifacts:
//   _work/audio/audio-manifest.json        decoded UI/race/powerup/tyre/engine waves
//   _work/audio/tyre-collision-model.json  decoded car-collision + world-impact waves
//   _work/audio/audio-catalog.json         bank/graph inventory + sound components
//   _work/audio/integration-contract.json  retail event -> component mapping
//   _work/audio/engine-model.json          Race_V8 RPM layer curves
//
// Output is committed; the decoded WAVs themselves stay under `_work/` (game
// data, never committed). Every entry records the retail PAK asset, the wave
// index/data range, the decoded file path and its SHA-256. No sound, gain or
// pitch range is synthesised: a value is either read from the retail graph or
// marked `neutral` / `provisional`.
//
// Run:
//   node probes/audio/tools/build_runtime_audio.mjs
//   node probes/audio/tools/build_runtime_audio.mjs --out <path>

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUDIO_SCHEMA = 'blur.audio-runtime/1';
export const SOURCE_ROOT = '_work/audio/';
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

const POWERUP_TYPES = Object.freeze([
  'bolt', 'shunt', 'barge', 'mine', 'shock', 'nitro', 'shield', 'repair',
]);

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const AUDIO = join(ROOT, '_work', 'audio');
const DEFAULT_OUT = join(ROOT, 'probes', 'audio', 'data', 'runtime-audio.json');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Python's json.dumps emits bare -Infinity/Infinity for non-finite floats.
// `audio-catalog.json` contains such values in unused/bad-string graph curves;
// they are not read by this builder, but JSON.parse rejects the whole file.
// Replace the bare tokens (never inside strings) with null before parsing.
function readJsonTolerant(path) {
  const text = readFileSync(path, 'utf8')
    .replace(/(?<![\w"])-?Infinity(?![\w"])/g, 'null')
    .replace(/(?<![\w"])NaN(?![\w"])/g, 'null');
  return JSON.parse(text);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fail(message) {
  throw new Error(`build_runtime_audio: ${message}`);
}

function rel(path) {
  return relative(ROOT, path).replaceAll('\\', '/');
}

function sourceUrl(file) {
  if (!file.startsWith(SOURCE_ROOT)) {
    fail(`decoded file must live under ${SOURCE_ROOT}: ${file}`);
  }
  return file.slice(SOURCE_ROOT.length);
}

function neutralGain(basis) {
  return {
    value: 1,
    db: null,
    source: 'neutral',
    provisional: true,
    basis,
  };
}

function retailGain(value, db, basis) {
  return {
    value,
    db: db === undefined ? null : db,
    source: 'retail',
    provisional: false,
    basis,
  };
}

function neutralPitch(basis) {
  return {
    min: 1,
    max: 1,
    source: 'neutral',
    provisional: true,
    basis,
  };
}

function literalPitch(rate, basis) {
  return {
    min: rate,
    max: rate,
    source: 'retail-literal',
    provisional: false,
    basis,
  };
}

function curvePitch(min, max, basis) {
  return {
    min,
    max,
    source: 'retail-curve',
    provisional: false,
    basis,
  };
}

function neutralRate(basis) {
  return { value: 1, source: 'neutral', provisional: true, basis };
}

function retailRate(value, basis) {
  return { value, source: 'retail-literal', provisional: false, basis };
}

function pitchFromRate(rate, basis) {
  if (rate.source === 'retail-literal') return literalPitch(rate.value, basis);
  return neutralPitch(basis);
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outPath = outIndex >= 0 ? args[outIndex + 1] : DEFAULT_OUT;
  if (!outPath) fail('--out needs a path');

  const manifest = readJson(join(AUDIO, 'audio-manifest.json'));
  const model = readJson(join(AUDIO, 'tyre-collision-model.json'));
  const catalog = readJsonTolerant(join(AUDIO, 'audio-catalog.json'));
  const contract = readJson(join(AUDIO, 'integration-contract.json'));
  const engineModel = readJson(join(AUDIO, 'engine-model.json'));

  const manifestByKey = new Map();
  const manifestByWave = new Map();
  for (const entry of manifest.entries) {
    manifestByKey.set(`${entry.bank.toLowerCase()}\u0000${entry.wave.toLowerCase()}`, entry);
    if (!manifestByWave.has(entry.wave.toLowerCase())) {
      manifestByWave.set(entry.wave.toLowerCase(), entry);
    }
  }

  const modelBankByAsset = new Map();
  for (const [key, bank] of Object.entries(model.banks)) {
    modelBankByAsset.set(bank.asset.toLowerCase(), { key, bank });
  }

  function bankLogicalBytes(asset) {
    const bank = catalog.banks[asset.toLowerCase()];
    if (bank && Number.isFinite(bank.logicalBytes)) return bank.logicalBytes;
    const found = modelBankByAsset.get(asset.toLowerCase());
    if (found && Number.isFinite(found.bank.logicalBytes)) return found.bank.logicalBytes;
    return null;
  }

  function normalizeManifest(entry) {
    const file = entry.file;
    if (!existsSync(join(ROOT, file))) fail(`decoded file missing: ${file}`);
    const actual = sha256File(join(ROOT, file));
    if (actual !== entry.sha256) fail(`hash mismatch for ${file}: ${actual} != ${entry.sha256}`);
    const bytes = statSync(join(ROOT, file)).size;
    if (bytes !== entry.bytes) fail(`size mismatch for ${file}: ${bytes} != ${entry.bytes}`);
    return {
      wave: entry.wave,
      bank: entry.bank,
      waveUid: entry.waveUid,
      file,
      url: sourceUrl(file),
      sha256: entry.sha256,
      bytes,
      loop: Boolean(entry.loop),
      loopStart: 0,
      loopEnd: entry.loop ? entry.samples : null,
      sampleRate: entry.sampleRate,
      channels: entry.channels,
      samples: entry.samples,
      durationSeconds: entry.durationSeconds,
      pak: entry.pak,
      asset: entry.asset,
      bankSha256: entry.bankSha256,
      waveIndex: entry.waveIndex,
      dataStart: entry.dataStart,
      dataLength: entry.dataLength,
      codec: entry.codec,
      bankLogicalBytes: bankLogicalBytes(entry.asset),
    };
  }

  function normalizeModel(bankKey, waveName) {
    const bank = model.banks[bankKey];
    if (!bank) fail(`model bank missing: ${bankKey}`);
    const wave = bank.waves.find((item) => item.name.toLowerCase() === waveName.toLowerCase());
    if (!wave) fail(`wave ${waveName} not found in model bank ${bankKey}`);
    if (!wave.wavSha256) fail(`wave ${waveName} in ${bankKey} has no decoded hash`);
    const file = `${SOURCE_ROOT}${wave.wav}`;
    if (!existsSync(join(ROOT, file))) fail(`decoded file missing: ${file}`);
    const actual = sha256File(join(ROOT, file));
    if (actual !== wave.wavSha256) fail(`hash mismatch for ${file}: ${actual} != ${wave.wavSha256}`);
    const bytes = statSync(join(ROOT, file)).size;
    if (bytes !== wave.wavBytes) fail(`size mismatch for ${file}: ${bytes} != ${wave.wavBytes}`);
    return {
      wave: wave.name,
      bank: bank.bankName,
      waveUid: `${bank.bankName}:${wave.index}:${wave.name}`,
      file,
      url: wave.wav,
      sha256: wave.wavSha256,
      bytes,
      loop: Boolean(wave.loop),
      loopStart: 0,
      loopEnd: wave.loop ? wave.samples : null,
      sampleRate: wave.sampleRate,
      channels: wave.channels,
      samples: wave.samples,
      durationSeconds: wave.durationSeconds,
      pak: bank.pak,
      asset: bank.asset,
      bankSha256: bank.bankSha256,
      waveIndex: wave.index,
      dataStart: wave.dataStart,
      dataLength: wave.dataLength,
      codec: 'uADPCM4Bit',
      bankLogicalBytes: bank.logicalBytes,
    };
  }

  function sourceFor(bank, wave) {
    const key = `${bank.toLowerCase()}\u0000${wave.toLowerCase()}`;
    if (manifestByKey.has(key)) return normalizeManifest(manifestByKey.get(key));
    const found = modelBankByAsset.get(`\\audio\\${bank.toLowerCase()}.baf`);
    if (found) return normalizeModel(found.key, wave);
    const byWave = manifestByWave.get(wave.toLowerCase());
    if (byWave) return normalizeManifest(byWave);
    fail(`no decoded retail source for ${bank}:${wave}`);
  }

  function graphInfo(file) {
    const graph = catalog.graphs[file.toLowerCase()];
    if (!graph) fail(`graph not in catalog: ${file}`);
    if (!graph.sha256 || graph.sha256.length !== 64) fail(`graph ${file} has no sha256`);
    return {
      graph: `root.pak:\\audio\\dat\\${file}`,
      graphFile: file,
      graphSha256: graph.sha256,
      graphBytes: graph.byteLength,
      object: graph.object,
    };
  }

  function soundInGraph(file, component) {
    const graph = catalog.graphs[file.toLowerCase()];
    if (!graph) fail(`graph not in catalog: ${file}`);
    const sound = graph.sounds.find((item) => item.name === component);
    if (!sound) fail(`component ${component} not found in ${file}`);
    return sound;
  }

  function gainFromSound(sound, basis) {
    if (sound.literalGain === null || sound.literalGain === undefined) {
      return neutralGain(`${basis}: ${sound.name} gain is control-linked (literalGain null in the retail graph)`);
    }
    return retailGain(
      sound.literalGain,
      sound.literalGainDb,
      `${basis}: ${sound.name} optGain(linear) * 10^(optGain_dB/20)`,
    );
  }

  function rateFromSound(sound, basis) {
    if (sound.literalRate === null || sound.literalRate === undefined) {
      return neutralRate(`${basis}: ${sound.name} frequency/pitch is control-linked (literalRate null)`);
    }
    return retailRate(
      sound.literalRate,
      `${basis}: ${sound.name} optFrequency * 2^optPitch`,
    );
  }

  function contractEvent(id) {
    const event = contract.events[id];
    if (!event) fail(`contract event missing: ${id}`);
    return event;
  }

  function variantFrom(source, options) {
    const {
      component,
      graphFile,
      trigger,
      entity,
      contractEventId,
      route,
      gain,
      rate,
      pitch,
    } = options;
    const graph = graphInfo(graphFile);
    return {
      id: source.wave,
      wave: source.wave,
      bank: source.bank,
      waveUid: source.waveUid,
      file: source.file,
      url: source.url,
      sha256: source.sha256,
      bytes: source.bytes,
      loop: source.loop,
      loopStart: source.loopStart,
      loopEnd: source.loopEnd,
      sampleRate: source.sampleRate,
      channels: source.channels,
      samples: source.samples,
      durationSeconds: source.durationSeconds,
      gain,
      rate,
      pitch,
      ...(route ? { route } : {}),
      provenance: {
        pak: source.pak,
        asset: source.asset,
        bank: source.bank,
        bankSha256: source.bankSha256,
        bankLogicalBytes: source.bankLogicalBytes,
        waveIndex: source.waveIndex,
        dataStart: source.dataStart,
        dataLength: source.dataLength,
        codec: source.codec,
        graph: graph.graph,
        graphFile: graph.graphFile,
        graphSha256: graph.graphSha256,
        graphBytes: graph.graphBytes,
        object: graph.object,
        component,
        trigger,
        entity,
        contractEvent: contractEventId ?? null,
      },
    };
  }

  function eventProvenance(options) {
    const graph = graphInfo(options.graphFile);
    return {
      basis: 'retail graph component + decoded BAF wave (uADPCM4Bit)',
      contractEvent: options.contractEventId ?? null,
      entity: options.entity,
      graph: graph.graph,
      graphFile: graph.graphFile,
      graphSha256: graph.graphSha256,
      object: graph.object,
      trigger: options.trigger,
    };
  }

  function contractVariant(id, waveUid) {
    const event = contractEvent(id);
    const variant = event.variants.find((item) => item.waveUid === waveUid);
    if (!variant) fail(`contract ${id} has no variant ${waveUid}`);
    return variant;
  }

  // ---------------------------------------------------------------- engine
  function buildEngine() {
    const graphFile = 'race_v8_engine.dat';
    const graph = graphInfo(graphFile);
    const layers = [];
    for (const loop of engineModel.loops) {
      if (loop.rpmLabel === null || loop.rpmLabel === undefined) continue;
      const source = sourceFor(loop.bank, loop.wave);
      const gain = neutralGain(
        `engine-audio.js layer ${loop.slot} is driven by the retail Engine${loop.slot}Volume PLF, not a literal gain`,
      );
      const rate = neutralRate(
        `engine-audio.js layer ${loop.slot} is driven by the retail Engine${loop.slot}Pitch PLF`,
      );
      layers.push({
        slot: loop.slot,
        wave: loop.wave,
        bank: source.bank,
        waveUid: source.waveUid,
        rpmLabel: loop.rpmLabel,
        volumeCurve: loop.volume,
        pitchCurve: loop.pitch,
        pitch: curvePitch(
          MIN_PLAYBACK_RATE,
          2,
          `retail Engine${loop.slot}Pitch PLF, clamped to MIN_PLAYBACK_RATE`,
        ),
        file: source.file,
        url: source.url,
        sha256: source.sha256,
        bytes: source.bytes,
        loop: source.loop,
        loopStart: source.loopStart,
        loopEnd: source.loopEnd,
        sampleRate: source.sampleRate,
        channels: source.channels,
        samples: source.samples,
        durationSeconds: source.durationSeconds,
        gain,
        rate,
        provenance: {
          pak: source.pak,
          asset: source.asset,
          bank: source.bank,
          bankSha256: source.bankSha256,
          bankLogicalBytes: source.bankLogicalBytes,
          waveIndex: source.waveIndex,
          dataStart: source.dataStart,
          dataLength: source.dataLength,
          codec: source.codec,
          graph: graph.graph,
          graphFile: graph.graphFile,
          graphSha256: graph.graphSha256,
          graphBytes: graph.graphBytes,
          object: graph.object,
          component: loop.sound,
          trigger: `RPM layer ${loop.rpmLabel}`,
          entity: 'Race_V8_Race',
          contractEvent: `engine.rpm.${loop.rpmLabel}`,
        },
      });
    }
    if (layers.length !== 6) fail(`expected 6 engine RPM layers, got ${layers.length}`);

    const decel = engineModel.loops.find((loop) => loop.rpmLabel === null);
    const excluded = [];
    if (decel) {
      excluded.push({
        slot: decel.slot,
        wave: decel.wave,
        reason: 'EngineDecelVolume/EngineDecelThrottleVolume are flat zero in race_v8_engine.dat; ' +
          'audible playback needs clutch/throttle state that is not modelled',
      });
    }
    for (const [wave, reason] of Object.entries(engineModel.unusedBankWaves)) {
      excluded.push({ wave, reason });
    }

    return {
      id: 'engine',
      category: 'engine',
      kind: 'engine',
      status: 'ok',
      loop: true,
      gain: neutralGain('engine layer gains come from the retail EngineNVolume PLF, not a literal gain'),
      pitch: curvePitch(
        MIN_PLAYBACK_RATE,
        2,
        'retail EngineNPitch PLF, clamped to decoderadpcm4bit.cpp MIN_PLAYBACK_RATE',
      ),
      rpmParameter: engineModel.rpmParameter.domain,
      rpmParameterName: engineModel.rpmParameter.name,
      layers,
      excluded,
      provenance: eventProvenance({
        graphFile,
        entity: 'Race_V8_Race',
        trigger: 'Engine1..6Sound RPM layers',
        contractEventId: null,
      }),
    };
  }

  // ------------------------------------------------------------ tyre-squeal
  function curveFromModel(graphKey, name, controlNames) {
    const graph = model.graphs[graphKey];
    if (!graph) fail(`model graph missing: ${graphKey}`);
    const curve = graph.curves.find((item) => item.name === name);
    if (!curve) fail(`curve ${name} not found in ${graphKey}`);
    const controlName = controlNames && Number.isInteger(curve.control.sCom)
      ? controlNames[curve.control.sCom] ?? null
      : null;
    return {
      name,
      points: curve.points,
      unit: 'linear',
      control: curve.control,
      controlName,
      source: `${graphKey}.dat ${name}`,
    };
  }

  function buildTyreSqueal() {
    const graphFile = 'wheel_dry.dat';
    const graph = graphInfo(graphFile);
    const controls = model.graphs.wheel_dry.controls.map((item) => item.name);
    const skidVolume = [
      curveFromModel('wheel_dry', 'Asphalt_Skid0VolumePLF', controls),
      curveFromModel('wheel_dry', 'Asphalt_Skid1VolumePLF', controls),
      curveFromModel('wheel_dry', 'Asphalt_Skid2VolumePLF', controls),
    ];
    const skidSpeedVolume = curveFromModel('wheel_dry', 'SkidSpeedVolume', controls);
    const skidSpeedPitch = curveFromModel('wheel_dry', 'SkidSpeedPitch', controls);
    const skidSlidePitchModifier = curveFromModel('wheel_dry', 'Asphalt_SkidSlidePitchModifier', controls);
    const waves = [
      ['Asphalt_Skid0_Sound', 'Asphalt_Lateral_1'],
      ['Asphalt_Skid1_Sound', 'Asphalt_Lateral_2'],
      ['Asphalt_Skid2_Sound', 'Asphalt_Lateral_3'],
    ];
    const pitchMin = Math.min(...skidSpeedPitch.points.map((p) => p[1]))
      * Math.min(...skidSlidePitchModifier.points.map((p) => p[1]));
    const pitchMax = Math.max(...skidSpeedPitch.points.map((p) => p[1]))
      * Math.max(...skidSlidePitchModifier.points.map((p) => p[1]));
    const layerPitch = curvePitch(
      Number(pitchMin.toFixed(9)),
      Number(pitchMax.toFixed(9)),
      'retail SkidSpeedPitch * Asphalt_SkidSlidePitchModifier',
    );
    const layers = waves.map(([component, wave], index) => {
      const sound = soundInGraph(graphFile, component);
      const source = sourceFor(sound.bank, wave);
      return {
        id: wave,
        wave,
        bank: source.bank,
        waveUid: source.waveUid,
        file: source.file,
        url: source.url,
        sha256: source.sha256,
        bytes: source.bytes,
        loop: source.loop,
        loopStart: source.loopStart,
        loopEnd: source.loopEnd,
        sampleRate: source.sampleRate,
        channels: source.channels,
        samples: source.samples,
        durationSeconds: source.durationSeconds,
        curveIndex: index,
        gain: neutralGain(
          `${component} gain is the retail Asphalt_Skid${index}VolumePLF * SkidSpeedVolume, not a literal gain`,
        ),
        rate: neutralRate(
          `${component} rate is the retail SkidSpeedPitch * Asphalt_SkidSlidePitchModifier`,
        ),
        pitch: layerPitch,
        provenance: {
          pak: source.pak,
          asset: source.asset,
          bank: source.bank,
          bankSha256: source.bankSha256,
          bankLogicalBytes: source.bankLogicalBytes,
          waveIndex: source.waveIndex,
          dataStart: source.dataStart,
          dataLength: source.dataLength,
          codec: source.codec,
          graph: graph.graph,
          graphFile: graph.graphFile,
          graphSha256: graph.graphSha256,
          graphBytes: graph.graphBytes,
          object: graph.object,
          component,
          trigger: 'tyre skid loop',
          entity: 'Wheel_dry',
          contractEvent: `tyre.dry.skid${index}`,
        },
      };
    });
    return {
      id: 'tyre-squeal',
      category: 'tyre',
      kind: 'loop',
      status: 'ok',
      loop: true,
      gain: neutralGain('tyre layer gains are the retail SkidSpeedVolume * Asphalt_SkidNVolumePLF curves'),
      pitch: layerPitch,
      control: {
        slip: 'WheelXSlideInput',
        speed: 'GroundSpeedInput',
      },
      curves: {
        skidSpeedVolume,
        skidSpeedPitch,
        skidSlidePitchModifier,
        skidVolume,
      },
      layers,
      provenance: eventProvenance({
        graphFile,
        entity: 'Wheel_dry',
        trigger: 'Asphalt_Skid0/1/2_Sound loops',
        contractEventId: null,
      }),
    };
  }

  // ----------------------------------------------------------------- impact
  function buildImpact() {
    const carGraphFile = 'collisioncar.dat';
    const worldGraphFile = 'collisionworld.dat';
    const carGraph = graphInfo(carGraphFile);
    const worldGraph = graphInfo(worldGraphFile);
    const variants = [];
    const routes = {};
    const materials = [];
    const surfaces = {};

    const carTables = [
      ['car-large', 'LargeCarCollisionSound', 'large'],
      ['car-medium', 'MediumCarCollisionSound', 'medium'],
      ['car-small', 'SmallCarCollisionSound', 'small'],
    ];
    for (const [route, component, size] of carTables) {
      const sound = soundInGraph(carGraphFile, component);
      const gain = gainFromSound(sound, 'collisioncar.dat');
      const rate = rateFromSound(sound, 'collisioncar.dat');
      const variantIds = [];
      for (const wave of sound.waves) {
        const source = sourceFor(sound.bank, wave);
        variantIds.push(variants.length);
        variants.push(variantFrom(source, {
          component,
          graphFile: carGraphFile,
          trigger: `car collision ${size}`,
          entity: 'CollisionCar',
          contractEventId: null,
          route,
          gain,
          rate,
          pitch: pitchFromRate(rate, 'collisioncar.dat car collision table rate'),
        }));
      }
      routes[route] = {
        table: component,
        size,
        gain,
        volumeCurve: 'car',
        variantIds,
      };
    }

    // CollisionWorld CollisionScript: surface value -> material table.
    const routing = model.graphs.collisionworld.collisionRouting;
    if (!routing || routing.length === 0) fail('collisionworld.dat has no decoded CollisionScript routing');
    const materialByIndex = new Map(model.effectMaterials.map((item) => [item.index, item.name]));
    const routeByTarget = new Map();
    for (const entry of routing) {
      const target = entry.targetName;
      if (!target) fail(`collision routing ${entry.surfaceValue} has no target component`);
      const surface = target.replace(/CollisionSound$/, '').toLowerCase();
      const route = `world-${surface}`;
      if (!routeByTarget.has(route)) {
        routeByTarget.set(route, {
          table: target,
          surface,
          gain: null,
          volumeCurve: 'world',
          variantIds: [],
          materialIndices: [],
        });
      }
      const record = routeByTarget.get(route);
      const materialName = materialByIndex.get(Math.trunc(entry.surfaceValue));
      if (!materialName) fail(`no E_EffectMaterial name for surface ${entry.surfaceValue}`);
      const name = materialName.replace(/^E_EffectMaterial_/, '');
      record.materialIndices.push({ index: Math.trunc(entry.surfaceValue), name });
      materials.push({ name, index: Math.trunc(entry.surfaceValue), route });
      surfaces[surface] = route;
    }

    for (const [route, record] of routeByTarget) {
      const sound = soundInGraph(worldGraphFile, record.table);
      const gain = gainFromSound(sound, 'collisionworld.dat');
      const rate = rateFromSound(sound, 'collisionworld.dat');
      record.gain = gain;
      for (const wave of sound.waves) {
        const source = sourceFor(sound.bank, wave);
        record.variantIds.push(variants.length);
        variants.push(variantFrom(source, {
          component: record.table,
          graphFile: worldGraphFile,
          trigger: `world impact ${record.surface}`,
          entity: 'CollisionWorld',
          contractEventId: null,
          route,
          gain,
          rate,
          pitch: pitchFromRate(rate, 'collisionworld.dat material table rate'),
        }));
      }
      routes[route] = {
        table: record.table,
        surface: record.surface,
        materials: record.materialIndices,
        gain,
        volumeCurve: record.volumeCurve,
        variantIds: record.variantIds,
      };
    }

    const carVolume = curveFromModel('collisioncar', 'CollisionVolume', null);
    const worldVolume = curveFromModel('collisionworld', 'CollisionVolume', null);
    carVolume.unit = 'dB';
    carVolume.source = 'collisioncar.dat CollisionVolume';
    carVolume.graph = carGraph.graph;
    carVolume.graphSha256 = carGraph.graphSha256;
    worldVolume.unit = 'dB';
    worldVolume.source = 'collisionworld.dat CollisionVolume';
    worldVolume.graph = worldGraph.graph;
    worldVolume.graphSha256 = worldGraph.graphSha256;

    return {
      id: 'impact',
      category: 'collision',
      kind: 'one-shot',
      status: 'ok',
      loop: false,
      gain: neutralGain('impact gain is the retail CollisionVolume PLF applied to the collision force'),
      pitch: neutralPitch(
        'car collision tables have a control-linked rate; world tables are literal 1.0; ' +
        'the runtime applies no pitch variation and each variant records its own rate',
      ),
      defaultRoute: 'car-medium',
      selectionProvisional: true,
      selectionBasis: 'retail selects the car table by car size and the world table by E_EffectMaterial; ' +
        'the runtime defaults to car-medium when no size/material is supplied',
      volumeCurves: {
        car: carVolume,
        world: worldVolume,
      },
      materials,
      surfaces,
      routes,
      variants,
      provenance: {
        basis: 'retail CollisionCar / CollisionWorld sound tables + decoded BAF waves',
        contractEvent: null,
        entity: 'CollisionCar + CollisionWorld',
        graphs: [carGraph.graph, worldGraph.graph],
        graphSha256: [carGraph.graphSha256, worldGraph.graphSha256],
        trigger: 'car collision size table or CollisionWorld material table',
      },
    };
  }

  // ---------------------------------------------------------------- pickups
  function buildPickup(type) {
    const contractId = 'powerup.pickup';
    const event = contractEvent(contractId);
    const sound = soundInGraph('pickups.dat', 'PerkPickupSound');
    const source = sourceFor(sound.bank, 'PerkPickup');
    const gain = gainFromSound(sound, 'pickups.dat');
    const rate = rateFromSound(sound, 'pickups.dat');
    const variant = variantFrom(source, {
      component: 'PerkPickupSound',
      graphFile: 'pickups.dat',
      trigger: event.trigger,
      entity: event.entity,
      contractEventId: contractId,
      gain,
      rate,
      pitch: pitchFromRate(rate, 'pickups.dat PerkPickupSound rate'),
    });
    return {
      id: `pickup-${type}`,
      category: 'pickup',
      kind: 'one-shot',
      status: 'ok',
      loop: false,
      gain,
      pitch: pitchFromRate(rate, 'pickups.dat PerkPickupSound rate'),
      sharedSource: true,
      typeSpecific: false,
      typeSpecificStatus: 'unsupported',
      typeSpecificReason: 'no-type-specific-pickup-wave',
      typeSpecificDetail:
        'Pickups.dat ships one PerkPickupSound for every perk; the retail bank has no ' +
        `${type} pickup wave. The shared retail PerkPickup wave is used instead.`,
      variants: [variant],
      provenance: eventProvenance({
        graphFile: 'pickups.dat',
        entity: event.entity,
        trigger: event.trigger,
        contractEventId: contractId,
      }),
    };
  }

  // ---------------------------------------------------------------- weapons
  const WEAPON_SPECS = Object.freeze({
    bolt: {
      contractId: 'powerup.bolt.activate',
      graphFile: 'blindfirefire.dat',
      components: [['BlindFireFireSound', 'BlindFireFire']],
    },
    shunt: {
      contractId: 'powerup.shunt.activate',
      graphFile: 'shuntfire.dat',
      components: [['ShuntFireSound', 'ShuntFire']],
    },
    barge: {
      contractId: 'powerup.barge.activate',
      graphFile: 'bargefire.dat',
      components: [['BargeFireSound', 'BargeFire']],
    },
    mine: {
      contractId: 'powerup.mine.throw.forward',
      graphFile: 'bombfire.dat',
      components: [['BombForwardsFireSound', 'MineForwardsFire']],
    },
    shock: {
      contractId: 'powerup.shock.activate',
      graphFile: 'shockfire.dat',
      components: [
        ['PickupFireSound', 'ShockFire'],
        ['PickupFireLFESound', 'ShockFireLFE'],
      ],
    },
    nitro: {
      contractId: 'powerup.nitro.activate',
      graphFile: 'nitrohit.dat',
      components: [
        ['NitroFireSound', 'NitroFire'],
        ['NitroFireSweetenerSound', 'NitroFireSweetener'],
        ['NitroBackwardFireSound', 'NitroBackwardFire'],
      ],
    },
    shield: {
      contractId: 'powerup.shield.loop',
      graphFile: 'shieldhit.dat',
      components: [['ShieldActiveSound', 'ShieldActivate']],
    },
    repair: {
      contractId: 'powerup.repair.activate',
      graphFile: 'repairhit.dat',
      components: [['RepairActivateSound', 'RepairActivate']],
    },
  });

  function buildWeapon(type) {
    const spec = WEAPON_SPECS[type];
    if (!spec) fail(`unknown weapon type ${type}`);
    const event = contractEvent(spec.contractId);
    const layers = spec.components.map(([component, wave]) => {
      const sound = soundInGraph(spec.graphFile, component);
      const source = sourceFor(sound.bank, wave);
      const gain = gainFromSound(sound, `${spec.graphFile} ${spec.contractId}`);
      const rate = rateFromSound(sound, `${spec.graphFile} ${spec.contractId}`);
      return variantFrom(source, {
        component,
        graphFile: spec.graphFile,
        trigger: event.trigger,
        entity: event.entity,
        contractEventId: spec.contractId,
        gain,
        rate,
        pitch: pitchFromRate(rate, `${spec.graphFile} ${component} rate`),
      });
    });
    const loop = layers.some((layer) => layer.loop);
    const first = layers[0];
    return {
      id: `weapon-${type}`,
      category: 'weapon',
      kind: loop ? 'loop' : 'one-shot',
      status: 'ok',
      loop,
      gain: first.gain,
      pitch: first.pitch,
      layers,
      provenance: eventProvenance({
        graphFile: spec.graphFile,
        entity: event.entity,
        trigger: event.trigger,
        contractEventId: spec.contractId,
      }),
    };
  }

  // ------------------------------------------------------- simple one-shots
  function buildSimple(id, options) {
    const event = contractEvent(options.contractId);
    const sound = soundInGraph(options.graphFile, options.component);
    const source = sourceFor(sound.bank, options.wave);
    const gain = gainFromSound(sound, `${options.graphFile} ${options.contractId}`);
    const rate = rateFromSound(sound, `${options.graphFile} ${options.contractId}`);
    const variant = variantFrom(source, {
      component: options.component,
      graphFile: options.graphFile,
      trigger: event.trigger,
      entity: event.entity,
      contractEventId: options.contractId,
      gain,
      rate,
      pitch: pitchFromRate(rate, `${options.graphFile} ${options.component} rate`),
    });
    return {
      id,
      category: options.category,
      kind: 'one-shot',
      status: 'ok',
      loop: false,
      gain,
      pitch: pitchFromRate(rate, `${options.graphFile} ${options.component} rate`),
      variants: [variant],
      provenance: eventProvenance({
        graphFile: options.graphFile,
        entity: event.entity,
        trigger: event.trigger,
        contractEventId: options.contractId,
      }),
    };
  }

  function buildCountdown() {
    const short = buildSimple('countdown', {
      contractId: 'race.countdown.short',
      graphFile: 'ingameui.dat',
      component: 'HUD_CountDown03Sound',
      wave: 'HUD_CountDown03',
      category: 'race',
    });
    const longEvent = contractEvent('race.countdown.long');
    const longSound = soundInGraph('ingameui.dat', 'HUD_CountDownSound');
    const longSource = sourceFor(longSound.bank, 'HUD_RaceEndCountDown10');
    const longGain = gainFromSound(longSound, 'ingameui.dat race.countdown.long');
    const longRate = rateFromSound(longSound, 'ingameui.dat race.countdown.long');
    const longVariant = variantFrom(longSource, {
      component: 'HUD_CountDownSound',
      graphFile: 'ingameui.dat',
      trigger: longEvent.trigger,
      entity: longEvent.entity,
      contractEventId: 'race.countdown.long',
      gain: longGain,
      rate: longRate,
      pitch: pitchFromRate(longRate, 'ingameui.dat HUD_CountDownSound rate'),
    });
    short.variants.push(longVariant);
    short.variants[0].variantId = 'short';
    short.variants[1].variantId = 'long';
    short.defaultVariant = 'short';
    short.variantBasis = 'retail HUD_CountDown03Sound (3-2-1) and HUD_CountDownSound (10 s countdown)';
    return short;
  }

  // ------------------------------------------------------------------- main
  const events = {};
  events.engine = buildEngine();
  events['tyre-squeal'] = buildTyreSqueal();
  events.impact = buildImpact();
  for (const type of POWERUP_TYPES) events[`pickup-${type}`] = buildPickup(type);
  for (const type of POWERUP_TYPES) events[`weapon-${type}`] = buildWeapon(type);
  events['ui-click'] = buildSimple('ui-click', {
    contractId: 'ui.navigate.forward',
    graphFile: 'frontendui.dat',
    component: 'FE_ForwardSound',
    wave: 'FE_Forward',
    category: 'ui',
  });
  events.countdown = buildCountdown();
  events.finish = buildSimple('finish', {
    contractId: 'race.finish.in',
    graphFile: 'ingameuistereo.dat',
    component: 'HUD_MPFinishInSound',
    wave: 'HUD_MPFinishIn',
    category: 'race',
  });
  events.wreck = buildSimple('wreck', {
    contractId: 'race.wreck',
    graphFile: 'ingameuistereo.dat',
    component: 'HUD_WreckedSound',
    wave: 'HUD_Wrecked',
    category: 'race',
  });

  // Deterministic order, exactly the documented event vocabulary.
  const ordered = {};
  for (const id of EVENT_IDS) {
    if (!events[id]) fail(`event builder did not produce ${id}`);
    ordered[id] = events[id];
  }
  const extra = Object.keys(events).filter((id) => !EVENT_IDS.includes(id));
  if (extra.length) fail(`unexpected events: ${extra.join(', ')}`);

  const unsupported = {};
  for (const id of EVENT_IDS) {
    if (ordered[id].status === 'unsupported') {
      unsupported[id] = {
        status: 'unsupported',
        reason: ordered[id].reason,
        detail: ordered[id].detail ?? null,
      };
    }
  }

  const uniqueFiles = new Set();
  let variantCount = 0;
  let layerCount = 0;
  const byCategory = {};
  for (const id of EVENT_IDS) {
    const event = ordered[id];
    byCategory[event.category] = (byCategory[event.category] ?? 0) + 1;
    for (const variant of event.variants ?? []) {
      uniqueFiles.add(variant.file);
      variantCount += 1;
    }
    for (const layer of event.layers ?? []) {
      uniqueFiles.add(layer.file);
      layerCount += 1;
    }
  }

  const output = {
    schema: AUDIO_SCHEMA,
    generatedBy: 'probes/audio/tools/build_runtime_audio.mjs',
    note:
      'Runtime event catalog. Every source is a decoded retail BAF wave with a recorded PAK asset, ' +
      'wave index/data range, decoded file path and SHA-256. Gains and pitch ranges are retail-derived ' +
      'or marked neutral/provisional; nothing is synthesised.',
    sourceRoot: SOURCE_ROOT,
    baseUrl: '/_work/audio/',
    eventIds: [...EVENT_IDS],
    summary: {
      events: EVENT_IDS.length,
      supported: EVENT_IDS.filter((id) => ordered[id].status === 'ok').length,
      unsupported: Object.keys(unsupported).length,
      uniqueSources: uniqueFiles.size,
      variants: variantCount,
      layers: layerCount,
      byCategory,
    },
    events: ordered,
    unsupported,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  const text = `${JSON.stringify(output, null, 2)}\n`;
  writeFileSync(outPath, text, 'utf8');
  console.log(`wrote ${rel(outPath)} (${text.length} bytes)`);
  console.log(JSON.stringify(output.summary, null, 1));
}

main();
