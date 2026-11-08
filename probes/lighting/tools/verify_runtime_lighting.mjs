#!/usr/bin/env node
// Independent verifier for the committed browser lighting table.
//
//   node probes/lighting/tools/verify_runtime_lighting.mjs
//
// Re-derives every value from `_work/lighting/<map>.json` without importing the
// builder, then checks:
//   * all four maps against their manifest (exact equality, no rounding);
//   * every number in the table maps to a manifest field (no invented values);
//   * unit length of every direction the manifest declares as a direction;
//   * the +Y ambient basis and the SH * BakedColour product;
//   * the `missing` list: typed codes, absent field paths, no silent drop;
//   * the `lightingFor` contract and its typed errors;
//   * two builder runs are byte-identical to each other and to the committed
//     JSON/module.
//
// Exit code 0 only when every check passes.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const JSON_FILE = path.join(ROOT, 'probes/lighting/data/runtime-lighting.json');
const MODULE_FILE = path.join(ROOT, 'probes/lighting/runtime-lighting.mjs');
const TEMPLATE_FILE = path.join(HERE, 'runtime_lighting_module.template.mjs');
const BUILDER_FILE = path.join(HERE, 'build_runtime_lighting.mjs');
const DATA_PLACEHOLDER = '/*__RUNTIME_LIGHTING_DATA__*/';
const SCHEMA = 'blur.lighting-runtime/1';
const MANIFEST_SCHEMA = 'blur-lighting/1';
const INDEX_SCHEMA = 'blur-lighting-index/1';
const MAP_ORDER = ['river', 'amboy', 'gracia', 'longbeach'];
const MISSING_CODES = new Set(['not-serialized', 'not-decoded']);
const MISSING_FIELDS = [
  'sun.occlusion',
  'sun.intensityScale',
  'sky.occlusion',
  'ambient.perInstanceInterpolation',
  'ambient.lightmap',
  'sky.domePixels'
];

// Runtime numeric path -> manifest path. The verifier refuses a numeric field
// that has no entry here, so a value cannot be invented or scaled.
const VEC3_MAP = {
  'sun.direction': 'sun.direction',
  'sun.colour': 'lightingInfo.sunColour',
  'sun.lightObjectColour': 'sun.colour',
  'sky.colour': 'lightingInfo.skyColour',
  'sky.upAxis': 'skyLightObject.upAxis',
  'sky.lightObjectColour': 'skyLightObject.colour',
  'sky.dome.fogColour': 'skyDome.fogColour',
  'ambient.upNormalAmbient': 'ambientProbe.upNormalAmbient',
  'ambient.bakedColour': 'lightingInfo.bakedColour',
  'ambient.upNormalAmbientScaled': 'ambientProbe.upNormalAmbientScaled',
  'ambient.probe.pointPosition': 'ambientProbe.pointPosition',
  'ambient.probe.spawn': 'ambientProbe.spawn',
  'fog.colour': 'fog.colour'
};

const ARRAY_MAP = {
  'ambient.sh': 'ambientProbe.sh'
};

const SCALAR_MAP = {
  'sun.intensity': 'sun.intensityUsed',
  'sun.elevationDeg': 'sun.elevationDeg',
  'sun.azimuthDeg': 'sun.azimuthDeg',
  'sky.dome.rotation': 'skyDome.rotation',
  'sky.dome.intensity': 'skyDome.intensity',
  'sky.dome.fogCurve': 'skyDome.fogCurve',
  'sky.dome.blackHeight': 'skyDome.blackHeight',
  'sky.dome.blackSize': 'skyDome.blackSize',
  'ambient.probe.pointIndex': 'ambientProbe.pointIndex',
  'ambient.probe.sampleIndex': 'ambientProbe.sampleIndex',
  'ambient.probe.distance': 'ambientProbe.distance',
  'ambient.probe.searchRadius': 'ambientProbe.searchRadius',
  'fog.depth.density': 'fog.depthDensity',
  'fog.depth.nearDistance': 'fog.depthNearDistance',
  'fog.depth.scale': 'fog.depthScale',
  'fog.height.height': 'fog.height.height',
  'fog.height.density': 'fog.height.density',
  'fog.height.falloff': 'fog.height.falloff',
  'fog.height.scale': 'fog.height.scale'
};

const checks = [];
const failures = [];

function check(name, ok, detail = null) {
  const row = { name, ok: Boolean(ok), detail };
  checks.push(row);
  if (!row.ok) failures.push(row);
  return row.ok;
}

function equal(name, actual, expected) {
  return check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

function sameNumber(name, actual, expected) {
  return check(name, typeof actual === 'number' && typeof expected === 'number' &&
    Number.isFinite(actual) && Number.isFinite(expected) && actual === expected,
  { actual, expected });
}

function close(name, actual, expected, tolerance = 1e-9) {
  const ok = typeof actual === 'number' && typeof expected === 'number' &&
    Number.isFinite(actual) && Number.isFinite(expected) &&
    Math.abs(actual - expected) <= tolerance;
  return check(name, ok, { actual, expected, tolerance });
}

function throws(name, fn, expected) {
  try {
    fn();
    return check(name, false, 'expected a throw');
  } catch (error) {
    const ok = !expected ||
      (error.name === expected.name && error.code === expected.code);
    return check(name, ok, { name: error.name, code: error.code, message: error.message });
  }
}

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeNewlines(value) {
  return value.toString('utf8').replace(/\r\n/g, '\n');
}

function getPath(object, dotted) {
  let current = object;
  for (const part of dotted.split('.')) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function numericPaths(value, prefix = '') {
  if (typeof value === 'number') return [prefix];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      numericPaths(entry, prefix === '' ? String(index) : prefix + '.' + index));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) =>
      numericPaths(entry, prefix === '' ? key : prefix + '.' + key));
  }
  return [];
}

function resolveMapping(runtimePath) {
  if (VEC3_MAP[runtimePath]) {
    return { kind: 'vec3', manifestPath: VEC3_MAP[runtimePath] };
  }
  if (ARRAY_MAP[runtimePath]) {
    return { kind: 'array', manifestPath: ARRAY_MAP[runtimePath] };
  }
  if (SCALAR_MAP[runtimePath]) {
    return { kind: 'scalar', manifestPath: SCALAR_MAP[runtimePath] };
  }
  const match = /^(.*)\.(\d+)$/.exec(runtimePath);
  if (match) {
    const base = match[1];
    const index = Number(match[2]);
    if (VEC3_MAP[base]) {
      return { kind: 'vec3', manifestPath: VEC3_MAP[base], index };
    }
    if (ARRAY_MAP[base]) {
      return { kind: 'array', manifestPath: ARRAY_MAP[base], index };
    }
  }
  return null;
}

function expectedMappedPaths() {
  const paths = [];
  for (const base of Object.keys(VEC3_MAP)) {
    for (let index = 0; index < 3; index++) paths.push(base + '.' + index);
  }
  for (const base of Object.keys(ARRAY_MAP)) {
    for (let index = 0; index < 12; index++) paths.push(base + '.' + index);
  }
  for (const base of Object.keys(SCALAR_MAP)) paths.push(base);
  return paths;
}

function norm3(vector) {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function allFinite(value) {
  const paths = numericPaths(value);
  return paths.every((dotted) => Number.isFinite(getPath(value, dotted)));
}

function degrees(radians) {
  return radians * 180 / Math.PI;
}

// ---------------------------------------------------------------- load
function requireFile(file, hint) {
  try {
    return readFileSync(file);
  } catch {
    console.error('missing ' + path.relative(ROOT, file) + '; ' + hint);
    process.exit(1);
  }
}

requireFile(path.join(ROOT, '_work/lighting/index.json'),
  'run: python probes/lighting/tools/build_manifest.py');
requireFile(JSON_FILE, 'run: node probes/lighting/tools/build_runtime_lighting.mjs');
requireFile(MODULE_FILE, 'run: node probes/lighting/tools/build_runtime_lighting.mjs');

const index = readJson('_work/lighting/index.json');
const document = JSON.parse(readFileSync(JSON_FILE, 'utf8'));
const template = readFileSync(TEMPLATE_FILE, 'utf8');
const module = await import(pathToFileURL(MODULE_FILE).href);

// ---------------------------------------------------------------- document
equal('index schema', index.schema, INDEX_SCHEMA);
equal('index map set', Object.keys(index.levels).sort(), [...MAP_ORDER].sort());
equal('document schema', document.schema, SCHEMA);
equal('document kind', document.kind, 'blur.lighting-runtime');
equal('document version', document.version, 1);
equal('document generatedBy', document.generatedBy,
  'probes/lighting/tools/build_runtime_lighting.mjs');
equal('document map order', Object.keys(document.maps), MAP_ORDER);
equal('module schema export', module.LIGHTING_SCHEMA, SCHEMA);
equal('module map list', module.LIGHTING_MAPS, MAP_ORDER);
check('module map list is frozen', Object.isFrozen(module.LIGHTING_MAPS));
check('module has no data placeholder',
  !readFileSync(MODULE_FILE, 'utf8').includes(DATA_PLACEHOLDER));

const manifestDocuments = {};
for (const short of MAP_ORDER) {
  const record = index.levels[short];
  const buffer = requireFile(path.join(ROOT, record.path),
    'run: python probes/lighting/tools/build_manifest.py');
  manifestDocuments[short] = JSON.parse(buffer.toString('utf8'));
}

const firstUnits = manifestDocuments[MAP_ORDER[0]].units;
equal('document units equal the manifest units', document.units, firstUnits);
for (const short of MAP_ORDER) {
  equal(short + ' manifest units match', manifestDocuments[short].units, firstUnits);
}

// ---------------------------------------------------------------- per map
const perMap = {};

for (const short of MAP_ORDER) {
  const record = index.levels[short];
  const buffer = readFileSync(path.join(ROOT, record.path));
  const manifest = manifestDocuments[short];
  const entry = document.maps[short];
  const prefix = short + ' ';

  check(prefix + 'manifest exists', buffer.length > 0, record.path);
  equal(prefix + 'manifest schema', manifest.schema, MANIFEST_SCHEMA);
  equal(prefix + 'manifest short', manifest.short, short);
  equal(prefix + 'manifest sha256 matches the index', sha256(buffer), record.sha256);
  equal(prefix + 'manifest bytes match the index', buffer.length, record.bytes);

  check(prefix + 'entry present', Boolean(entry));
  if (!entry) continue;

  equal(prefix + 'entry schema', entry.schema, SCHEMA);
  equal(prefix + 'entry mapId', entry.mapId, short);
  equal(prefix + 'entry level', entry.level, manifest.level);
  equal(prefix + 'entry city', entry.city, manifest.city);
  equal(prefix + 'manifest block', entry.manifest, {
    path: record.path,
    schema: manifest.schema,
    bytes: record.bytes,
    sha256: record.sha256
  });
  sameNumber(prefix + 'manifest bytes is the index byte count', entry.manifest.bytes,
    record.bytes);

  // -- every number maps to a manifest field ------------------------------
  const numbers = numericPaths(entry);
  let unmapped = 0;
  for (const runtimePath of numbers) {
    if (runtimePath.startsWith('manifest.')) continue;
    const mapping = resolveMapping(runtimePath);
    if (!mapping) {
      unmapped++;
      check(prefix + 'number has a manifest source: ' + runtimePath, false);
      continue;
    }
    const source = getPath(manifest, mapping.manifestPath);
    const expected = mapping.index === undefined
      ? source
      : (source ?? [])[mapping.index];
    sameNumber(prefix + 'copied verbatim: ' + runtimePath + ' <- ' + mapping.manifestPath +
      (mapping.index === undefined ? '' : '.' + mapping.index),
    getPath(entry, runtimePath), expected);
  }
  equal(prefix + 'no unmapped numbers', unmapped, 0);

  // Reverse direction: every declared field must be present.
  for (const runtimePath of expectedMappedPaths()) {
    if (runtimePath.startsWith('fog.') && entry.fog === null) continue;
    check(prefix + 'field present: ' + runtimePath,
      getPath(entry, runtimePath) !== undefined);
  }
  check(prefix + 'all numbers finite', allFinite(entry));

  // -- sun ---------------------------------------------------------------
  const sun = entry.sun;
  check(prefix + 'sun present', Boolean(sun));
  if (sun) {
    check(prefix + 'sun direction is unit length', Math.abs(norm3(sun.direction) - 1) <= 1e-6,
      norm3(sun.direction));
    equal(prefix + 'sun direction is matrix row Z', sun.direction, manifest.sun.matrixRows[2]);
    check(prefix + 'sun is above the horizon', sun.direction[1] > 0, sun.direction[1]);
    check(prefix + 'sun colour rgb in 0..1', sun.colour.every((c) => c >= 0 && c <= 1),
      sun.colour);
    check(prefix + 'sun light object colour rgb in 0..1',
      sun.lightObjectColour.every((c) => c >= 0 && c <= 1), sun.lightObjectColour);
    sameNumber(prefix + 'sun intensity is the serialized colour alpha', sun.intensity,
      manifest.sun.colour[3]);
    sameNumber(prefix + 'sun intensity is intensityUsed', sun.intensity,
      manifest.sun.intensityUsed);
    close(prefix + 'sun elevation re-derived from the direction',
      sun.elevationDeg,
      degrees(Math.asin(Math.max(-1, Math.min(1, sun.direction[1])))), 1e-9);
    const azimuth = ((degrees(Math.atan2(-sun.direction[2], sun.direction[0])) % 360) + 360) % 360;
    close(prefix + 'sun azimuth re-derived from the direction', sun.azimuthDeg, azimuth, 1e-9);
  }

  // -- sky ---------------------------------------------------------------
  const sky = entry.sky;
  check(prefix + 'sky present', Boolean(sky));
  if (sky) {
    check(prefix + 'sky up axis is unit length', Math.abs(norm3(sky.upAxis) - 1) <= 1e-6,
      norm3(sky.upAxis));
    check(prefix + 'sky colour rgb in 0..1', sky.colour.every((c) => c >= 0 && c <= 1),
      sky.colour);
    equal(prefix + 'sky dome texture', sky.dome.texture, manifest.skyDome.texture);
    check(prefix + 'sky dome texture is a retail path',
      sky.dome.texture.startsWith('graphics/textures/skies/') &&
      sky.dome.texture.endsWith('.texture'), sky.dome.texture);
    check(prefix + 'sky dome intensity positive', sky.dome.intensity > 0, sky.dome.intensity);
    check(prefix + 'sky dome fog colour rgb in 0..1',
      sky.dome.fogColour.every((c) => c >= 0 && c <= 1), sky.dome.fogColour);
  }

  // -- ambient -----------------------------------------------------------
  const ambient = entry.ambient;
  check(prefix + 'ambient present', Boolean(ambient));
  if (ambient) {
    equal(prefix + 'ambient sh has 12 coefficients', ambient.sh.length, 12);
    for (let channel = 0; channel < 3; channel++) {
      close(prefix + 'up-normal ambient re-derived from SH channel ' + channel,
        ambient.upNormalAmbient[channel],
        ambient.sh[channel * 4 + 1] + ambient.sh[channel * 4 + 3], 1e-12);
      close(prefix + 'scaled ambient re-derived from BakedColour channel ' + channel,
        ambient.upNormalAmbientScaled[channel],
        ambient.upNormalAmbient[channel] * ambient.bakedColour[channel], 1e-12);
    }
    check(prefix + 'up-normal ambient positive',
      ambient.upNormalAmbient.every((c) => c > 0), ambient.upNormalAmbient);
    check(prefix + 'probe distance inside the search radius',
      ambient.probe.distance >= 0 && ambient.probe.distance <= ambient.probe.searchRadius,
      ambient.probe.distance);
    check(prefix + 'probe model is RGBSH', ambient.probe.model === 'RGBSH',
      ambient.probe.model);
    equal(prefix + 'probe model matches the manifest', ambient.probe.model,
      manifest.lightSamples.modelName);
    check(prefix + 'probe indices are non-negative integers',
      Number.isInteger(ambient.probe.pointIndex) && ambient.probe.pointIndex >= 0 &&
      Number.isInteger(ambient.probe.sampleIndex) && ambient.probe.sampleIndex >= 0,
      [ambient.probe.pointIndex, ambient.probe.sampleIndex]);
  }

  // -- fog ---------------------------------------------------------------
  if (entry.fog === null) {
    check(prefix + 'fog is null only when the manifest has no fog', !manifest.fog);
    check(prefix + 'missing lists fog',
      entry.missing.some((row) => row.field === 'fog'));
  } else {
    check(prefix + 'fog present because the manifest serializes it', Boolean(manifest.fog));
    check(prefix + 'fog colour rgb in 0..1',
      entry.fog.colour.every((c) => c >= 0 && c <= 1), entry.fog.colour);
    check(prefix + 'fog depth density non-negative', entry.fog.depth.density >= 0,
      entry.fog.depth.density);
    check(prefix + 'fog height density non-negative', entry.fog.height.density >= 0,
      entry.fog.height.density);
    check(prefix + 'fog height falloff non-negative', entry.fog.height.falloff >= 0,
      entry.fog.height.falloff);
  }

  // -- missing -----------------------------------------------------------
  check(prefix + 'missing is an array', Array.isArray(entry.missing));
  const missingFields = [];
  for (const row of entry.missing ?? []) {
    equal(prefix + 'missing keys ' + row.field, Object.keys(row).sort(),
      ['code', 'field', 'reason']);
    check(prefix + 'missing code is typed: ' + row.field, MISSING_CODES.has(row.code),
      row.code);
    const absent = getPath(entry, row.field);
    check(prefix + 'missing field is absent: ' + row.field,
      absent === undefined || absent === null);
    check(prefix + 'missing reason is non-empty: ' + row.field,
      typeof row.reason === 'string' && row.reason.trim().length > 0);
    missingFields.push(row.field);
  }
  equal(prefix + 'missing field list', missingFields, MISSING_FIELDS);

  // -- source ------------------------------------------------------------
  check(prefix + 'source names the manifest path',
    typeof entry.source === 'string' && entry.source.includes(record.path),
    entry.source);
  check(prefix + 'source names the manifest sha256',
    typeof entry.source === 'string' && entry.source.includes(record.sha256));
  check(prefix + 'source names the sun direction rule',
    typeof entry.source === 'string' && entry.source.includes('matrix row Z'));

  perMap[short] = {
    direction: entry.sun.direction,
    colour: entry.sun.colour,
    intensity: entry.sun.intensity,
    ambient: entry.ambient.upNormalAmbientScaled,
    fog: entry.fog !== null,
    missing: entry.missing.length
  };
}

// ---------------------------------------------------------------- module contract
for (const short of MAP_ORDER) {
  const returned = module.lightingFor(short);
  equal(short + ' lightingFor equals the committed entry', JSON.stringify(returned),
    JSON.stringify(document.maps[short]));
  equal(short + ' lightingFor schema', returned.schema, SCHEMA);
  equal(short + ' lightingFor mapId', returned.mapId, short);
  for (const key of ['schema', 'mapId', 'sun', 'sky', 'ambient', 'fog', 'source']) {
    check(short + ' lightingFor has ' + key, key in returned);
  }
  for (const key of ['direction', 'colour', 'intensity']) {
    check(short + ' sun has ' + key, key in returned.sun);
  }
  for (const key of ['upNormalAmbient', 'sh', 'bakedColour']) {
    check(short + ' ambient has ' + key, key in returned.ambient);
  }
  check(short + ' lightingFor is deep-frozen',
    Object.isFrozen(returned) && Object.isFrozen(returned.sun) &&
    Object.isFrozen(returned.sun.direction) && Object.isFrozen(returned.ambient.sh));
  throws(short + ' lightingFor result rejects mutation',
    () => { returned.sun.direction[0] = 0; }, null);
}

throws('unknown map throws a typed error', () => module.lightingFor('nope'),
  { name: 'LightingError', code: 'unknown-map' });
throws('retail level id is not a map id', () => module.lightingFor('usa_amboy'),
  { name: 'LightingError', code: 'unknown-map' });
throws('non-string map id throws a typed error', () => module.lightingFor(7),
  { name: 'LightingError', code: 'invalid-map-id' });
throws('undefined map id throws a typed error', () => module.lightingFor(),
  { name: 'LightingError', code: 'invalid-map-id' });

// ---------------------------------------------------------------- determinism
const temp = mkdtempSync(path.join(os.tmpdir(), 'lighting-runtime-'));
try {
  const runs = [];
  for (const suffix of ['a', 'b']) {
    const jsonOut = path.join(temp, 'runtime-lighting-' + suffix + '.json');
    const moduleOut = path.join(temp, 'runtime-lighting-' + suffix + '.mjs');
    const result = spawnSync(process.execPath, [
      BUILDER_FILE, '--out', jsonOut, '--module-out', moduleOut, '--quiet'
    ], { cwd: ROOT, encoding: 'utf8' });
    equal('builder run ' + suffix + ' exit 0', result.status, 0);
    check('builder run ' + suffix + ' no stderr', !result.stderr || result.stderr.trim() === '',
      result.stderr ?? '');
    runs.push({ json: readFileSync(jsonOut), module: readFileSync(moduleOut) });
  }
  check('two builds byte-identical JSON', runs[0].json.equals(runs[1].json));
  check('two builds byte-identical module', runs[0].module.equals(runs[1].module));
  check('committed JSON equals build',
    normalizeNewlines(runs[0].json) === normalizeNewlines(readFileSync(JSON_FILE)));
  check('committed module equals build',
    normalizeNewlines(runs[0].module) === normalizeNewlines(readFileSync(MODULE_FILE)));
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const generated = template.replace(DATA_PLACEHOLDER, JSON.stringify(document, null, 2));
check('committed module equals template + JSON',
  normalizeNewlines(generated) === normalizeNewlines(readFileSync(MODULE_FILE)));

// ---------------------------------------------------------------- summary
for (const short of MAP_ORDER) {
  const row = perMap[short];
  if (!row) continue;
  console.log('  ' + short + ': sun dir [' + row.direction.map((v) => v.toFixed(6)).join(', ') +
    '] colour [' + row.colour.map((v) => v.toFixed(3)).join(', ') + '] intensity ' +
    row.intensity + '; ambient [' + row.ambient.map((v) => v.toFixed(6)).join(', ') +
    ']; fog ' + (row.fog ? 'yes' : 'null') + '; missing ' + row.missing);
}
for (const failure of failures) {
  const detail = failure.detail === null ? '' : ' :: ' + JSON.stringify(failure.detail);
  console.log('FAIL ' + failure.name + (detail.length > 240 ? detail.slice(0, 240) + '…' : detail));
}
const passed = checks.length - failures.length;
console.log(passed + '/' + checks.length + ' checks passed');
if (failures.length > 0) process.exitCode = 1;
