#!/usr/bin/env node
// Independent verifier for the committed browser car-material table.
//
//   node probes/car-materials/tools/verify_runtime_materials.mjs
//
// Re-derives every runtime value from
// `probes/car-materials/data/runtime-materials.json` without importing the
// builder, then checks:
//   * the manifest roster is the committed 25-car roster, byte for byte;
//   * all 25 slugs are present in the manifest and the module, in roster order;
//   * every value is re-derived from the manifest's raw retail fields
//     (paint ramp texel -> baseColour, glass/light/alloy verbatim copies);
//   * every number in the module maps to a manifest field (no invented value);
//   * every value is inside its physical range;
//   * `missing` entries name an absent `Record.field` and the fields searched;
//   * the `materialsFor` contract and its typed errors;
//   * two builder runs are byte-identical to each other and to the committed
//     module, and two in-process derivations are identical.
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
const MANIFEST_FILE = path.join(ROOT, 'probes/car-materials/data/runtime-materials.json');
const MODULE_FILE = path.join(ROOT, 'probes/car-materials/runtime-materials.mjs');
const TEMPLATE_FILE = path.join(HERE, 'runtime_materials_module.template.mjs');
const BUILDER_FILE = path.join(HERE, 'build_runtime_materials.mjs');
const ROSTER_FILE = path.join(ROOT, 'probes/e1-drive/cars/roster.json');
const DATA_PLACEHOLDER = '/*__RUNTIME_MATERIALS_DATA__*/';

const MANIFEST_SCHEMA = 'blur.car-materials-runtime-manifest/1';
const RUNTIME_SCHEMA = 'blur.car-materials-runtime/1';
const CAR_COUNT = 57;
const RAMP_WIDTH = 512;
const RAMP_HEIGHT = 1;
const BASE_COLOUR_TEXEL = RAMP_WIDTH - 1;
const MISSING_FIELDS = ['metallic', 'roughness'];

// Runtime numeric path -> manifest path. The verifier refuses a numeric field
// that has no entry here, so a value cannot be invented or scaled.
const VEC_MAP = {
  'baseColour': 'paint.derived.baseColour',
  'glass.tint': 'glass.derived.tint',
  'emissive': 'light.derived.emissive',
  'alloy.colour': 'alloy.derived.colour'
};

const SCALAR_MAP = {
  'glass.minAlpha': 'glass.derived.minAlpha',
  'glass.maxAlpha': 'glass.derived.maxAlpha',
  'glass.minReflectivity': 'glass.derived.minReflectivity',
  'glass.maxReflectivity': 'glass.derived.maxReflectivity',
  'emissiveStrength': 'light.derived.emissiveStrength',
  'alloy.specPow': 'alloy.derived.specPow',
  'alloy.specInt': 'alloy.derived.specInt'
};

const checks = [];
const failures = [];

function check(name, ok, detail = null) {
  const row = { name, ok: Boolean(ok), detail };
  checks.push(row);
  if (!row.ok) failures.push(row);
  return row.ok;
}

function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function equal(name, actual, expected) {
  return check(name, canonical(actual) === canonical(expected), { actual, expected });
}

function sameNumber(name, actual, expected) {
  return check(name, typeof actual === 'number' && typeof expected === 'number' &&
    Number.isFinite(actual) && Number.isFinite(expected) && actual === expected,
  { actual, expected });
}

function close(name, actual, expected, tolerance = 1e-12) {
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
  if (VEC_MAP[runtimePath]) return { manifestPath: VEC_MAP[runtimePath] };
  if (SCALAR_MAP[runtimePath]) return { manifestPath: SCALAR_MAP[runtimePath] };
  const match = /^(.*)\.(\d+)$/.exec(runtimePath);
  if (match && VEC_MAP[match[1]]) {
    return { manifestPath: VEC_MAP[match[1]], index: Number(match[2]) };
  }
  return null;
}

function srgbToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function inUnit(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function unitVector(name, vector, length) {
  return check(name, Array.isArray(vector) && vector.length === length &&
    vector.every(inUnit), vector);
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

const manifestBuffer = requireFile(MANIFEST_FILE,
  'run: python probes/car-materials/tools/build_runtime_materials_table.py');
requireFile(MODULE_FILE, 'run: node probes/car-materials/tools/build_runtime_materials.mjs');
const rosterBuffer = requireFile(ROSTER_FILE, 'the committed roster is required');

const manifest = JSON.parse(manifestBuffer.toString('utf8'));
const roster = JSON.parse(rosterBuffer.toString('utf8'));
const template = readFileSync(TEMPLATE_FILE, 'utf8');
const module = await import(pathToFileURL(MODULE_FILE).href);

const rosterSlugs = roster.cars.map((car) => car.slug);

// ---------------------------------------------------------------- manifest
equal('manifest schema', manifest.schema, MANIFEST_SCHEMA);
equal('manifest kind', manifest.kind, 'blur.car-materials-runtime');
equal('manifest version', manifest.version, 1);
equal('manifest generatedBy', manifest.generatedBy,
  'probes/car-materials/tools/build_runtime_materials_table.py');
equal('roster path', manifest.roster.path, 'probes/e1-drive/cars/roster.json');
equal('roster sha256 matches the committed roster', manifest.roster.sha256,
  sha256(rosterBuffer));
equal('roster carCount', manifest.roster.carCount, CAR_COUNT);
equal('roster order is the committed roster order', manifest.roster.order, rosterSlugs);
check('roster slugs are unique', new Set(rosterSlugs).size === CAR_COUNT, rosterSlugs.length);
equal('manifest car set is the roster', Object.keys(manifest.cars).sort(),
  [...rosterSlugs].sort());
equal('manifest car count', Object.keys(manifest.cars).length, CAR_COUNT);

// ---------------------------------------------------------------- module header
equal('module schema export', module.MATERIAL_SCHEMA, RUNTIME_SCHEMA);
equal('module manifest sha256', module.MATERIAL_MANIFEST_SHA256, sha256(manifestBuffer));
equal('module slug list', module.MATERIAL_SLUGS, rosterSlugs);
check('module slug list is frozen', Object.isFrozen(module.MATERIAL_SLUGS));
equal('module override keys', Object.keys(module.MATERIAL_OVERRIDES), rosterSlugs);
check('module override table is frozen', Object.isFrozen(module.MATERIAL_OVERRIDES));
check('module has no data placeholder',
  !readFileSync(MODULE_FILE, 'utf8').includes(DATA_PLACEHOLDER));

// ---------------------------------------------------------------- per car
const perCar = {};

for (const slug of rosterSlugs) {
  const car = manifest.cars[slug];
  const prefix = slug + ' ';
  check(prefix + 'manifest entry present', Boolean(car));
  if (!car) continue;

  equal(prefix + 'manifest slug', car.slug, slug);
  equal(prefix + 'roster name', car.name, roster.cars.find((row) => row.slug === slug).name);
  check(prefix + 'amax tag is a non-empty string',
    typeof car.amaxTag === 'string' && car.amaxTag.length > 0, car.amaxTag);
  check(prefix + 'amax record id is a positive integer',
    Number.isInteger(car.amaxRecordId) && car.amaxRecordId > 0, car.amaxRecordId);

  // -- paint -------------------------------------------------------------
  const paint = car.paint;
  check(prefix + 'paint block present', Boolean(paint && paint.raw && paint.derived));
  if (!paint || !paint.raw || !paint.derived) continue;
  const ramp = paint.raw.ramp;
  check(prefix + 'paint ramp width', ramp.width === RAMP_WIDTH, ramp.width);
  check(prefix + 'paint ramp height', ramp.height === RAMP_HEIGHT, ramp.height);
  equal(prefix + 'paint ramp format', ramp.format, 'RGBA8');
  const rampBytes = Buffer.from(ramp.base64, 'base64');
  equal(prefix + 'paint ramp byte length', rampBytes.length, RAMP_WIDTH * RAMP_HEIGHT * 4);
  equal(prefix + 'paint ramp sha256', sha256(rampBytes), ramp.sha256);
  equal(prefix + 'paint ramp sha256 is 64 hex', /^[0-9a-f]{64}$/.test(ramp.sha256), true);

  const texelIndex = paint.derived.sample.rampIndex;
  check(prefix + 'base colour samples the last texel', texelIndex === BASE_COLOUR_TEXEL,
    texelIndex);
  const texel = rampBytes.subarray(texelIndex * 4, texelIndex * 4 + 4);
  const expectedBase = [0, 1, 2].map((channel) => srgbToLinear(texel[channel] / 255));
  const baseColour = paint.derived.baseColour;
  check(prefix + 'baseColour has 4 channels', Array.isArray(baseColour) &&
    baseColour.length === 4, baseColour);
  for (let channel = 0; channel < 3; channel++) {
    close(prefix + 'baseColour re-derived from ramp channel ' + channel,
      baseColour[channel], expectedBase[channel]);
  }
  sameNumber(prefix + 'baseColour alpha is the opaque paint alpha', baseColour[3], 1);
  unitVector(prefix + 'baseColour in 0..1', baseColour, 4);

  check(prefix + 'paint job name is non-empty',
    typeof paint.raw.paintJob.name === 'string' && paint.raw.paintJob.name.length > 0,
    paint.raw.paintJob.name);
  check(prefix + 'paint job has at least one colour',
    Array.isArray(paint.raw.colours) && paint.raw.colours.length >= 1,
    paint.raw.colours && paint.raw.colours.length);
  check(prefix + 'paint job fallback flag is boolean',
    typeof paint.raw.paintJob.fallbackUsed === 'boolean', paint.raw.paintJob.fallbackUsed);
  equal(prefix + 'paint job selection matches the fallback flag',
    paint.raw.paintJob.selection,
    paint.raw.paintJob.fallbackUsed ? 'material-default-paint-job' : 'first-paint-job');

  // -- glass -------------------------------------------------------------
  const glass = car.glass;
  check(prefix + 'glass block present', Boolean(glass && glass.raw && glass.derived));
  if (!glass || !glass.raw || !glass.derived) continue;
  equal(prefix + 'glass part code', glass.raw.partCode, 23);
  equal(prefix + 'glass part name', glass.raw.partName, 'window');
  equal(prefix + 'glass tint copied verbatim', glass.derived.tint, glass.raw.tint);
  for (const field of ['minAlpha', 'maxAlpha', 'minReflectivity', 'maxReflectivity']) {
    sameNumber(prefix + 'glass ' + field + ' copied verbatim',
      glass.derived[field], glass.raw[field]);
  }
  equal(prefix + 'glass blend', glass.derived.blend,
    { src: 'One', dest: 'InvSrcAlpha', alphaTest: true });
  unitVector(prefix + 'glass tint in 0..1', glass.derived.tint, 3);
  for (const field of ['minAlpha', 'maxAlpha', 'minReflectivity', 'maxReflectivity']) {
    check(prefix + 'glass ' + field + ' in 0..1', inUnit(glass.derived[field]),
      glass.derived[field]);
  }
  check(prefix + 'glass minAlpha <= maxAlpha',
    glass.derived.minAlpha <= glass.derived.maxAlpha,
    [glass.derived.minAlpha, glass.derived.maxAlpha]);
  check(prefix + 'glass minReflectivity <= maxReflectivity',
    glass.derived.minReflectivity <= glass.derived.maxReflectivity,
    [glass.derived.minReflectivity, glass.derived.maxReflectivity]);

  // -- light -------------------------------------------------------------
  const light = car.light;
  check(prefix + 'light block present', Boolean(light && light.raw && light.derived));
  if (!light || !light.raw || !light.derived) continue;
  equal(prefix + 'light part code', light.raw.partCode, 27);
  equal(prefix + 'light part name', light.raw.partName, 'headlight');
  equal(prefix + 'emissive copied verbatim from the light tint',
    light.derived.emissive, light.raw.tint);
  sameNumber(prefix + 'emissiveStrength copied verbatim from the light intensity',
    light.derived.emissiveStrength, light.raw.intensity);
  unitVector(prefix + 'emissive in 0..1', light.derived.emissive, 3);
  check(prefix + 'emissiveStrength non-negative',
    Number.isFinite(light.derived.emissiveStrength) &&
    light.derived.emissiveStrength >= 0, light.derived.emissiveStrength);

  // -- alloy -------------------------------------------------------------
  const alloy = car.alloy;
  check(prefix + 'alloy block present', Boolean(alloy && alloy.raw && alloy.derived));
  if (!alloy || !alloy.raw || !alloy.derived) continue;
  equal(prefix + 'alloy part code', alloy.raw.partCode, 6);
  equal(prefix + 'alloy part name', alloy.raw.partName, 'alloy');
  equal(prefix + 'alloy colour copied verbatim', alloy.derived.colour, alloy.raw.colour);
  sameNumber(prefix + 'alloy specPow copied verbatim',
    alloy.derived.specPow, alloy.raw.specPow);
  sameNumber(prefix + 'alloy specInt copied verbatim',
    alloy.derived.specInt, alloy.raw.specInt);
  unitVector(prefix + 'alloy colour in 0..1', alloy.derived.colour, 3);
  check(prefix + 'alloy specPow non-negative',
    Number.isFinite(alloy.derived.specPow) && alloy.derived.specPow >= 0,
    alloy.derived.specPow);
  check(prefix + 'alloy specInt non-negative',
    Number.isFinite(alloy.derived.specInt) && alloy.derived.specInt >= 0,
    alloy.derived.specInt);

  // -- missing -----------------------------------------------------------
  check(prefix + 'missing is an array', Array.isArray(car.missing));
  const missingFields = [];
  for (const row of car.missing ?? []) {
    equal(prefix + 'missing keys ' + row.field, Object.keys(row).sort(),
      ['field', 'present', 'reason', 'searchedFields', 'sourceField']);
    check(prefix + 'missing field is absent from the car: ' + row.field,
      !(row.field in car), row.field);
    check(prefix + 'missing present flag is false: ' + row.field, row.present === false,
      row.present);
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(
      row.sourceField ?? '');
    check(prefix + 'missing names a Record.field: ' + row.field, Boolean(match),
      row.sourceField);
    if (match) {
      const [, record, field] = match;
      const fields = manifest.sourceFields[record];
      check(prefix + 'missing record is catalogued: ' + record, Array.isArray(fields),
        record);
      if (Array.isArray(fields)) {
        check(prefix + 'missing field is really absent from ' + record + ': ' + field,
          !fields.includes(field), field);
        check(prefix + 'missing searched fields are serialized by ' + record,
          Array.isArray(row.searchedFields) && row.searchedFields.length > 0 &&
          row.searchedFields.every((name) => fields.includes(name)),
          row.searchedFields);
      }
    }
    check(prefix + 'missing reason is non-empty: ' + row.field,
      typeof row.reason === 'string' && row.reason.trim().length > 0);
    missingFields.push(row.field);
  }
  equal(prefix + 'missing field list', missingFields, MISSING_FIELDS);
  equal(prefix + 'missing entries match the manifest catalogue', car.missing,
    manifest.missingFields);

  // -- source ------------------------------------------------------------
  const source = car.source;
  check(prefix + 'source present', Boolean(source && typeof source === 'object'));
  if (source) {
    equal(prefix + 'source amax tag', source.amaxTag, car.amaxTag);
    equal(prefix + 'source amax record id', source.amaxRecordId, car.amaxRecordId);
    equal(prefix + 'source paint job name', source.paintJob.name,
      paint.raw.paintJob.name);
    equal(prefix + 'source paint job record id', source.paintJob.recordId,
      paint.raw.paintJob.recordId);
    equal(prefix + 'source glass record id', source.glass.recordId,
      glass.raw.recordId);
    equal(prefix + 'source light record id', source.light.recordId,
      light.raw.recordId);
    equal(prefix + 'source alloy record id', source.alloy.recordId,
      alloy.raw.recordId);
    for (const block of ['glass', 'light', 'alloy']) {
      equal(prefix + 'source ' + block + ' pack', source[block].pack,
        car[block].raw.pack);
      equal(prefix + 'source ' + block + ' lookup path', source[block].lookupPath,
        car[block].raw.lookupPath);
    }
  }

  perCar[slug] = car;
}

// ---------------------------------------------------------------- module contract
for (const slug of rosterSlugs) {
  const car = perCar[slug];
  if (!car) continue;
  const returned = module.materialsFor(slug);
  const prefix = slug + ' ';

  equal(prefix + 'materialsFor schema', returned.schema, RUNTIME_SCHEMA);
  equal(prefix + 'materialsFor slug', returned.slug, slug);
  equal(prefix + 'materialsFor baseColour', returned.baseColour,
    car.paint.derived.baseColour);
  equal(prefix + 'materialsFor glass', returned.glass, car.glass.derived);
  equal(prefix + 'materialsFor emissive', returned.emissive,
    car.light.derived.emissive);
  sameNumber(prefix + 'materialsFor emissiveStrength', returned.emissiveStrength,
    car.light.derived.emissiveStrength);
  equal(prefix + 'materialsFor alloy', returned.alloy, car.alloy.derived);
  equal(prefix + 'materialsFor missing', returned.missing, car.missing);
  equal(prefix + 'materialsFor source', returned.source, car.source);

  for (const key of ['schema', 'slug', 'baseColour', 'glass', 'emissive',
    'emissiveStrength', 'alloy', 'missing', 'source']) {
    check(prefix + 'materialsFor has ' + key, key in returned);
  }
  check(prefix + 'materialsFor omits metallic', !('metallic' in returned));
  check(prefix + 'materialsFor omits roughness', !('roughness' in returned));
  check(prefix + 'materialsFor is deep-frozen',
    Object.isFrozen(returned) && Object.isFrozen(returned.baseColour) &&
    Object.isFrozen(returned.glass) && Object.isFrozen(returned.missing));
  throws(prefix + 'materialsFor result rejects mutation',
    () => { 'use strict'; returned.baseColour[0] = -1; }, null);

  // -- every number maps to a manifest field ------------------------------
  let unmapped = 0;
  for (const runtimePath of numericPaths(returned)) {
    if (runtimePath.startsWith('source.')) continue;
    const mapping = resolveMapping(runtimePath);
    if (!mapping) {
      unmapped++;
      check(prefix + 'number has a manifest source: ' + runtimePath, false);
      continue;
    }
    const sourceValue = getPath(car, mapping.manifestPath);
    const expected = mapping.index === undefined
      ? sourceValue
      : (sourceValue ?? [])[mapping.index];
    sameNumber(prefix + 'copied verbatim: ' + runtimePath + ' <- ' +
      mapping.manifestPath + (mapping.index === undefined ? '' : '.' + mapping.index),
    getPath(returned, runtimePath), expected);
  }
  equal(prefix + 'no unmapped numbers', unmapped, 0);

  // -- override table ------------------------------------------------------
  const override = module.MATERIAL_OVERRIDES[slug];
  check(prefix + 'override present', Boolean(override));
  if (override) {
    equal(prefix + 'override keys', Object.keys(override).sort(),
      ['alloy', 'baseColour', 'emissive', 'emissiveStrength', 'glass', 'missing']);
    equal(prefix + 'override baseColour', override.baseColour, returned.baseColour);
    equal(prefix + 'override glass', override.glass, returned.glass);
    equal(prefix + 'override emissive', override.emissive, returned.emissive);
    sameNumber(prefix + 'override emissiveStrength', override.emissiveStrength,
      returned.emissiveStrength);
    equal(prefix + 'override alloy', override.alloy, returned.alloy);
    equal(prefix + 'override missing', override.missing, returned.missing);
  }
}

throws('unknown slug throws a typed error', () => module.materialsFor('nope'),
  { name: 'CarMaterialError', code: 'unknown-slug' });
throws('retail record name is not a slug',
  () => module.materialsFor('Corvette_ZR1_Stock'),
  { name: 'CarMaterialError', code: 'unknown-slug' });
throws('non-string slug throws a typed error', () => module.materialsFor(7),
  { name: 'CarMaterialError', code: 'invalid-slug' });
throws('undefined slug throws a typed error', () => module.materialsFor(),
  { name: 'CarMaterialError', code: 'invalid-slug' });

// ---------------------------------------------------------------- determinism
const temp = mkdtempSync(path.join(os.tmpdir(), 'car-materials-runtime-'));
try {
  const runs = [];
  for (const suffix of ['a', 'b']) {
    const moduleOut = path.join(temp, 'runtime-materials-' + suffix + '.mjs');
    const result = spawnSync(process.execPath, [
      BUILDER_FILE, '--manifest', MANIFEST_FILE, '--module-out', moduleOut, '--quiet'
    ], { cwd: ROOT, encoding: 'utf8' });
    equal('builder run ' + suffix + ' exit 0', result.status, 0);
    check('builder run ' + suffix + ' no stderr', !result.stderr || result.stderr.trim() === '',
      result.stderr ?? '');
    runs.push(readFileSync(moduleOut));
  }
  check('two builds byte-identical module', runs[0].equals(runs[1]));
  check('committed module equals build',
    normalizeNewlines(runs[0]) === normalizeNewlines(readFileSync(MODULE_FILE)));
} finally {
  rmSync(temp, { recursive: true, force: true });
}

// Two in-process derivations of the runtime view must be identical.
function runtimeView() {
  return rosterSlugs.map((slug) => {
    const car = perCar[slug];
    return {
      slug,
      baseColour: car.paint.derived.baseColour,
      glass: car.glass.derived,
      emissive: car.light.derived.emissive,
      emissiveStrength: car.light.derived.emissiveStrength,
      alloy: car.alloy.derived,
      missing: car.missing
    };
  });
}
const viewA = JSON.stringify(runtimeView());
const viewB = JSON.stringify(runtimeView());
check('two derivations are identical', viewA === viewB);
check('derivation hash is stable', sha256(Buffer.from(viewA, 'utf8')) ===
  sha256(Buffer.from(viewB, 'utf8')));

// ---------------------------------------------------------------- summary
const recovered = {
  paint: rosterSlugs.filter((slug) => perCar[slug] && perCar[slug].paint.derived.baseColour)
    .length,
  glass: rosterSlugs.filter((slug) => perCar[slug] && perCar[slug].glass.derived.tint).length,
  emissive: rosterSlugs.filter((slug) => perCar[slug] &&
    perCar[slug].light.derived.emissive).length,
  alloy: rosterSlugs.filter((slug) => perCar[slug] && perCar[slug].alloy.derived.colour)
    .length
};
console.log('  cars ' + Object.keys(perCar).length + '/' + CAR_COUNT +
  '; recovered paint ' + recovered.paint + '/' + CAR_COUNT +
  ', glass ' + recovered.glass + '/' + CAR_COUNT +
  ', emissive ' + recovered.emissive + '/' + CAR_COUNT +
  ', alloy ' + recovered.alloy + '/' + CAR_COUNT);
console.log('  manifest sha256 ' + sha256(manifestBuffer));
console.log('  module sha256 ' + sha256(readFileSync(MODULE_FILE)));
for (const failure of failures) {
  console.log('FAIL ' + failure.name +
    (failure.detail === null ? '' : ' :: ' + JSON.stringify(failure.detail)));
}
const passed = checks.length - failures.length;
console.log(passed + '/' + checks.length + ' checks passed');
if (failures.length > 0) process.exitCode = 1;

