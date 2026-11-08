#!/usr/bin/env node
// Deterministic builder for the committed browser lighting table.
//
//   node probes/lighting/tools/build_runtime_lighting.mjs
//   node probes/lighting/tools/build_runtime_lighting.mjs --out <json> --module-out <mjs>
//
// Inputs (read-only, from `_work/`, gitignored build artifacts):
//   _work/lighting/index.json       blur-lighting-index/1 (four built maps)
//   _work/lighting/<short>.json     blur-lighting/1 per-map manifest
//
// Outputs (committed):
//   probes/lighting/data/runtime-lighting.json
//   probes/lighting/runtime-lighting.mjs
//
// The builder copies values verbatim and never rounds, scales, interpolates or
// synthesises a lighting value. A value the manifest does not serialize is
// omitted from the map entry and recorded in `missing` with a typed code and
// the absent dotted field path. A missing sun or sky light object is an error,
// not a fallback: the code-only fallback direction in LightList.cpp:97 is not
// substituted here.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DEFAULT_JSON = path.join(ROOT, 'probes/lighting/data/runtime-lighting.json');
const DEFAULT_MODULE = path.join(ROOT, 'probes/lighting/runtime-lighting.mjs');
const TEMPLATE = path.join(HERE, 'runtime_lighting_module.template.mjs');
const DATA_PLACEHOLDER = '/*__RUNTIME_LIGHTING_DATA__*/';

const SCHEMA = 'blur.lighting-runtime/1';
const MANIFEST_SCHEMA = 'blur-lighting/1';
const INDEX_SCHEMA = 'blur-lighting-index/1';

// Manifest build order (lighting_data.py SPAWN_TABLE). The index is sorted by
// key, so the order is pinned here and checked against the index key set.
const MAP_ORDER = ['river', 'amboy', 'gracia', 'longbeach'];

// Fields the retail data does not serialize. `field` must be absent from the
// emitted map entry; verify_runtime_lighting.mjs enforces that.
const NOT_SERIALIZED = [
  {
    code: 'not-serialized',
    field: 'sun.occlusion',
    reason: 'm_fSunOcclusion is per-vertex/per-material from the LS sample and the baked ' +
      'lightmaps; no per-level scalar exists (shader/common/Lighting.h:159)'
  },
  {
    code: 'not-serialized',
    field: 'sun.intensityScale',
    reason: 'the retail shader multiplies SunColour directly; no serialized sun intensity ' +
      'multiplier exists (shader/common/Lighting.h:159). sun.intensity is the C_Light colour ' +
      'alpha and is reported, not applied'
  },
  {
    code: 'not-serialized',
    field: 'sky.occlusion',
    reason: 'm_fSkyOcclusion is per-vertex/per-material; no per-level scalar exists ' +
      '(shader/common/Lighting.h:158)'
  },
  {
    code: 'not-serialized',
    field: 'ambient.perInstanceInterpolation',
    reason: 'one ambient probe at the measured spawn; the engine interpolates the nearest ' +
      'light sample per model instance (0.2 lerp per frame), which is not serialized'
  },
  {
    code: 'not-decoded',
    field: 'ambient.lightmap',
    reason: 'static world lighting is baked into SunSkyLightmap/RGBLightmap textures, which ' +
      'are not decoded by this probe'
  },
  {
    code: 'not-decoded',
    field: 'sky.domePixels',
    reason: 'the sky dome texture path is serialized; its pixels are not decoded by this probe'
  }
];

function parseArgs(argv) {
  const options = { json: DEFAULT_JSON, module: DEFAULT_MODULE, quiet: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--out') {
      options.json = path.resolve(argv[++index]);
    } else if (arg === '--module-out') {
      options.module = path.resolve(argv[++index]);
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else {
      throw new Error('unknown argument ' + JSON.stringify(arg));
    }
  }
  return options;
}

function readRelative(relative) {
  const file = path.join(ROOT, relative);
  if (!existsSync(file)) {
    throw new Error('missing ' + relative +
      '; run: python probes/lighting/tools/build_manifest.py');
  }
  return readFileSync(file);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function number(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(label + ' is not a finite number: ' + JSON.stringify(value));
  }
  return value;
}

function vec3(value, label) {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(label + ' is not a 3-vector: ' + JSON.stringify(value));
  }
  return [0, 1, 2].map((index) => number(value[index], label + '[' + index + ']'));
}

function rgb(value, label) {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(label + ' is not an RGBA colour: ' + JSON.stringify(value));
  }
  return [0, 1, 2].map((index) => number(value[index], label + '[' + index + ']'));
}

function array12(value, label) {
  if (!Array.isArray(value) || value.length !== 12) {
    throw new Error(label + ' is not 12 SH coefficients: ' + JSON.stringify(value));
  }
  return value.map((entry, index) => number(entry, label + '[' + index + ']'));
}

function text(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(label + ' is not a non-empty string: ' + JSON.stringify(value));
  }
  return value;
}

function buildSun(manifest, short) {
  const sun = manifest.sun;
  const info = manifest.lightingInfo;
  if (!sun || sun.type !== 3) {
    throw new Error(short + ': manifest has no directional sun light; refusing to substitute ' +
      'the code-only fallback direction (LightList.cpp:97)');
  }
  const intensity = number(sun.intensityUsed, 'sun.intensityUsed');
  if (intensity !== sun.colour[3]) {
    throw new Error(short + ': sun.intensityUsed does not equal the serialized colour alpha');
  }
  return {
    direction: vec3(sun.direction, 'sun.direction'),
    colour: rgb(info.sunColour, 'lightingInfo.sunColour'),
    intensity,
    lightObjectColour: rgb(sun.colour, 'sun.colour'),
    elevationDeg: number(sun.elevationDeg, 'sun.elevationDeg'),
    azimuthDeg: number(sun.azimuthDeg, 'sun.azimuthDeg')
  };
}

function buildSky(manifest, short) {
  const light = manifest.skyLightObject;
  const info = manifest.lightingInfo;
  const dome = manifest.skyDome;
  if (!light || light.type !== 1) {
    throw new Error(short + ': manifest has no sky hemisphere light object; unsupported');
  }
  return {
    colour: rgb(info.skyColour, 'lightingInfo.skyColour'),
    upAxis: vec3(light.upAxis, 'skyLightObject.upAxis'),
    lightObjectColour: rgb(light.colour, 'skyLightObject.colour'),
    dome: {
      texture: text(dome.texture, 'skyDome.texture'),
      rotation: number(dome.rotation, 'skyDome.rotation'),
      intensity: number(dome.intensity, 'skyDome.intensity'),
      fogColour: rgb(dome.fogColour, 'skyDome.fogColour'),
      fogCurve: number(dome.fogCurve, 'skyDome.fogCurve'),
      blackHeight: number(dome.blackHeight, 'skyDome.blackHeight'),
      blackSize: number(dome.blackSize, 'skyDome.blackSize')
    }
  };
}

function buildAmbient(manifest) {
  const probe = manifest.ambientProbe;
  const info = manifest.lightingInfo;
  return {
    upNormalAmbient: vec3(probe.upNormalAmbient, 'ambientProbe.upNormalAmbient'),
    sh: array12(probe.sh, 'ambientProbe.sh'),
    bakedColour: rgb(info.bakedColour, 'lightingInfo.bakedColour'),
    upNormalAmbientScaled: vec3(probe.upNormalAmbientScaled,
      'ambientProbe.upNormalAmbientScaled'),
    probe: {
      model: text(manifest.lightSamples.modelName, 'lightSamples.modelName'),
      pointIndex: number(probe.pointIndex, 'ambientProbe.pointIndex'),
      sampleIndex: number(probe.sampleIndex, 'ambientProbe.sampleIndex'),
      pointPosition: vec3(probe.pointPosition, 'ambientProbe.pointPosition'),
      spawn: vec3(probe.spawn, 'ambientProbe.spawn'),
      distance: number(probe.distance, 'ambientProbe.distance'),
      searchRadius: number(probe.searchRadius, 'ambientProbe.searchRadius')
    }
  };
}

function buildFog(manifest, missing) {
  const fog = manifest.fog;
  if (!fog) {
    missing.push({
      code: 'not-serialized',
      field: 'fog',
      reason: 'no fogSettings record is serialized for this level'
    });
    return null;
  }
  return {
    colour: rgb(fog.colour, 'fog.colour'),
    depth: {
      density: number(fog.depthDensity, 'fog.depthDensity'),
      nearDistance: number(fog.depthNearDistance, 'fog.depthNearDistance'),
      scale: number(fog.depthScale, 'fog.depthScale')
    },
    height: {
      height: number(fog.height.height, 'fog.height.height'),
      density: number(fog.height.density, 'fog.height.density'),
      falloff: number(fog.height.falloff, 'fog.height.falloff'),
      scale: number(fog.height.scale, 'fog.height.scale')
    }
  };
}

function buildMap(short, record) {
  const buffer = readRelative(record.path);
  const digest = sha256(buffer);
  if (digest !== record.sha256) {
    throw new Error(short + ': manifest sha256 ' + digest + ' does not match the index record ' +
      record.sha256 + '; rebuild with python probes/lighting/tools/build_manifest.py');
  }
  if (buffer.length !== record.bytes) {
    throw new Error(short + ': manifest byte count does not match the index record');
  }
  const manifest = JSON.parse(buffer.toString('utf8'));
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw new Error(short + ': unexpected manifest schema ' + JSON.stringify(manifest.schema));
  }
  if (manifest.short !== short) {
    throw new Error(short + ': manifest short name is ' + JSON.stringify(manifest.short));
  }

  const missing = NOT_SERIALIZED.map((entry) => ({ ...entry }));
  const sun = buildSun(manifest, short);
  const sky = buildSky(manifest, short);
  const ambient = buildAmbient(manifest);
  const fog = buildFog(manifest, missing);

  const source = 'manifest ' + record.path + ' (blur-lighting/1, ' + record.bytes +
    ' B, sha256 ' + record.sha256 + ') built by ' +
    'probes/lighting/tools/build_manifest.py; ' +
    'sun.direction = Level.levelrender Lights C_Light matrix row Z (LightList.cpp:90-98); ' +
    'sun.colour = gamedata.pak amax.bin ' + manifest.city +
    ' LightingInfo.SunColour.rgb; sky.colour = LightingInfo.SkyColour.rgb; ' +
    'ambient.sh = RGBSH sample ' + manifest.ambientProbe.sampleIndex + ' of LS point ' +
    manifest.ambientProbe.pointIndex + ' (LightSamplePoints.cpp:139-258); ' +
    'fog = amax.bin fogSettings; sky.dome = amax.bin skySettings';

  return {
    schema: SCHEMA,
    mapId: short,
    level: text(manifest.level, 'level'),
    city: text(manifest.city, 'city'),
    manifest: {
      path: record.path,
      schema: manifest.schema,
      bytes: record.bytes,
      sha256: record.sha256
    },
    sun,
    sky,
    ambient,
    fog,
    missing,
    source
  };
}

function buildDocument() {
  const indexBuffer = readRelative('_work/lighting/index.json');
  const index = JSON.parse(indexBuffer.toString('utf8'));
  if (index.schema !== INDEX_SCHEMA) {
    throw new Error('unexpected lighting index schema ' + JSON.stringify(index.schema));
  }
  const indexed = Object.keys(index.levels).sort();
  const expected = [...MAP_ORDER].sort();
  if (JSON.stringify(indexed) !== JSON.stringify(expected)) {
    throw new Error('lighting index maps ' + JSON.stringify(indexed) +
      ' do not match the four expected maps ' + JSON.stringify(expected));
  }

  const maps = {};
  let units = null;
  for (const short of MAP_ORDER) {
    const record = index.levels[short];
    const map = buildMap(short, record);
    const manifest = JSON.parse(readRelative(record.path).toString('utf8'));
    if (units === null) {
      units = manifest.units;
    } else if (JSON.stringify(units) !== JSON.stringify(manifest.units)) {
      throw new Error(short + ': manifest units differ from the first map');
    }
    maps[short] = map;
  }

  return {
    schema: SCHEMA,
    kind: 'blur.lighting-runtime',
    version: 1,
    generatedBy: 'probes/lighting/tools/build_runtime_lighting.mjs',
    scope: 'Retail per-level lighting for the four built maps, copied verbatim from the ' +
      'committed lighting manifests. Nothing is scaled, rounded or interpolated; values the ' +
      'retail data does not serialize are absent and listed in `missing`.',
    retailRule: 'diffuse = ((baked * BakedColour) + SkyColour*skyOcc*saturate(n.y*0.5+0.5) + ' +
      'SunColour*saturate(dot(n,sunDir))*sunOcc) * albedo * diffuseIntensity ' +
      '(shader/common/Lighting.h:153-165)',
    units,
    maps
  };
}

function generateModule(document, template) {
  if (!template.includes(DATA_PLACEHOLDER)) {
    throw new Error('module template is missing ' + DATA_PLACEHOLDER);
  }
  return template.replace(DATA_PLACEHOLDER, JSON.stringify(document, null, 2));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const document = buildDocument();
  const template = readFileSync(TEMPLATE, 'utf8');
  const jsonText = JSON.stringify(document, null, 2) + '\n';
  const moduleText = generateModule(document, template);

  mkdirSync(path.dirname(options.json), { recursive: true });
  mkdirSync(path.dirname(options.module), { recursive: true });
  writeFileSync(options.json, jsonText);
  writeFileSync(options.module, moduleText);

  if (!options.quiet) {
    for (const short of MAP_ORDER) {
      const map = document.maps[short];
      console.log('runtime-lighting: ' + short + ' sun dir [' +
        map.sun.direction.map((v) => v.toFixed(6)).join(', ') + '] colour [' +
        map.sun.colour.map((v) => v.toFixed(3)).join(', ') + '] ambient [' +
        map.ambient.upNormalAmbientScaled.map((v) => v.toFixed(6)).join(', ') + ']');
    }
    console.log('wrote ' + path.relative(ROOT, options.json) + ' sha256 ' +
      sha256(Buffer.from(jsonText, 'utf8')));
    console.log('wrote ' + path.relative(ROOT, options.module) + ' sha256 ' +
      sha256(Buffer.from(moduleText, 'utf8')));
  }
}

main();
