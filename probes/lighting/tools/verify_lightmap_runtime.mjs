#!/usr/bin/env node
// Verifier for the exported lightmap pixels and the renderer resolver.
//
//   node probes/lighting/tools/verify_lightmap_runtime.mjs
//   node probes/lighting/tools/verify_lightmap_runtime.mjs --maps river,amboy
//
// It checks, for every selected map:
//   * the export index `_work/lighting/<map>/lightmap/index.json` against the
//     committed runtime table (`data/runtime-lighting.json`): count, dimensions,
//     byte totals, set sha256 and every per-texture hash;
//   * every exported `.rgba` file: existence, size, sha256, and that no stale
//     `.rgba` file is left in the directory;
//   * `probes/lighting/lightmap-runtime.mjs`: `lightmapSetFor`,
//     `lightmapTextureFor` and `lightmapShaderFor` return exactly the index and
//     the committed shader rule;
//   * re-derivation and determinism: the exporter is run twice into fresh
//     temporary roots and both indexes must be byte-identical to each other and
//     to the committed export, with every re-derived file hash matching.
//
// Exit code 0 only when every check passes. The Python exporter uses the
// bundled interpreter when PYTHON is set, otherwise `python` on PATH.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const PYTHON = process.env.PYTHON || 'python';
const EXPORTER = path.join(HERE, 'export_lightmap_rgba.py');
const EXPORT_ROOT = path.join(ROOT, '_work/lighting');
const RUNTIME_JSON = path.join(ROOT, 'probes/lighting/data/runtime-lighting.json');
const MODULE_PATH = path.join(ROOT, 'probes/lighting/lightmap-runtime.mjs');

const MAP_ORDER = ['river', 'amboy', 'gracia', 'longbeach'];
const EXPORT_SCHEMA = 'blur.lightmap-rgba/1';
const RUNTIME_SCHEMA = 'blur.lightmap-runtime/1';
const LIGHTING_SCHEMA = 'blur.lighting-runtime/1';
const UV_SET = 'luxlightmap';
const URL_PREFIX = '/_work/lighting';

const checks = [];
const failures = [];

function check(name, ok, detail = null) {
  const row = { name, ok: Boolean(ok), detail };
  checks.push(row);
  if (!row.ok) failures.push(row);
  return row.ok;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return '[' + value.map((entry) => canonicalJson(entry)).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function equal(name, actual, expected) {
  return check(name, canonicalJson(actual) === canonicalJson(expected), { actual, expected });
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function parseArgs(argv) {
  const options = { maps: MAP_ORDER.slice(), python: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--maps') {
      options.maps = argv[++index].split(',').map((name) => name.trim()).filter(Boolean);
    } else if (arg === '--python') {
      options.python = argv[++index];
    } else {
      throw new Error('unknown argument ' + JSON.stringify(arg));
    }
  }
  for (const mapId of options.maps) {
    if (!MAP_ORDER.includes(mapId)) {
      throw new Error('unknown map ' + JSON.stringify(mapId));
    }
  }
  return options;
}

function throwsCode(fn, code) {
  try {
    fn();
    return false;
  } catch (error) {
    return error && error.code === code;
  }
}

const options = parseArgs(process.argv.slice(2));
const python = options.python || PYTHON;
const maps = options.maps;

const runtime = readJson(RUNTIME_JSON);
equal('runtime table schema', runtime.schema, LIGHTING_SCHEMA);

const module = await import(pathToFileURL(MODULE_PATH).href);
equal('module schema', module.LIGHTMAP_RUNTIME_SCHEMA, RUNTIME_SCHEMA);
equal('module map list', module.LIGHTMAP_MAPS, MAP_ORDER);
check('module rejects a non-string map id',
  throwsCode(() => module.lightmapSetFor(null), 'invalid-map-id'));
check('module rejects the retail package id',
  throwsCode(() => module.lightmapSetFor('usa_amboy'), 'unknown-map'));

for (const mapId of maps) {
  const prefix = mapId + ' ';
  const indexFile = path.join(EXPORT_ROOT, mapId, 'lightmap', 'index.json');
  const present = check(prefix + 'export index exists', existsSync(indexFile), indexFile);
  if (!present) {
    check(prefix + 'export index present (run export_lightmap_rgba.py)', false, indexFile);
    continue;
  }
  const index = readJson(indexFile);
  const runtimeMap = runtime.maps[mapId];
  check(prefix + 'runtime map present', Boolean(runtimeMap), null);
  if (!runtimeMap) continue;
  const runtimeLightmap = runtimeMap.lightmap;
  check(prefix + 'runtime lightmap is decoded', runtimeLightmap?.decoded === true, null);
  if (!runtimeLightmap) continue;

  // -- index shape -------------------------------------------------------
  equal(prefix + 'index schema', index.schema, EXPORT_SCHEMA);
  equal(prefix + 'index kind', index.kind, 'lightmap-rgba-export');
  equal(prefix + 'index mapId', index.mapId, mapId);
  equal(prefix + 'index level', index.level, runtimeMap.level);
  equal(prefix + 'index uvSet', index.uvSet, UV_SET);
  equal(prefix + 'index format', index.format, 'RGBA8');
  equal(prefix + 'index mipLevel', index.mipLevel, 0);
  equal(prefix + 'index colorTransformApplied', index.colorTransformApplied, false);
  equal(prefix + 'index sourceFormat', index.sourceFormat, runtimeLightmap.format);
  equal(prefix + 'index sourceFormatName', index.sourceFormatName, runtimeLightmap.formatName);
  equal(prefix + 'index count', index.count, runtimeLightmap.count);
  equal(prefix + 'index count equals texture list length', index.count, index.textures.length);
  equal(prefix + 'index dimensions', index.dimensions, runtimeLightmap.dimensions);
  equal(prefix + 'index set sha256 equals the runtime decodedRgbaSha256',
    index.sha256, runtimeLightmap.decodedRgbaSha256);
  check(prefix + 'index set sha256 is a sha256 digest',
    typeof index.sha256 === 'string' && /^[0-9a-f]{64}$/.test(index.sha256), index.sha256);
  check(prefix + 'index byte total equals the texture sum',
    index.bytes === index.textures.reduce((sum, texture) => sum + texture.bytes, 0),
    index.bytes);
  check(prefix + 'index byte total equals width*height*4 sum',
    index.bytes === index.textures.reduce(
      (sum, texture) => sum + texture.width * texture.height * 4, 0), index.bytes);

  // -- per texture -------------------------------------------------------
  const runtimeByName = new Map(runtimeLightmap.textures.map((texture) =>
    [texture.name, texture]));
  const seen = new Set();
  for (const texture of index.textures) {
    const name = texture.name;
    check(prefix + 'texture name is unique: ' + name, !seen.has(name), name);
    seen.add(name);
    const source = runtimeByName.get(name);
    check(prefix + 'runtime texture exists: ' + name, Boolean(source), null);
    if (!source) continue;
    equal(prefix + 'texture width: ' + name, texture.width, source.width);
    equal(prefix + 'texture height: ' + name, texture.height, source.height);
    equal(prefix + 'texture bytes: ' + name, texture.bytes, source.decodedRgbaBytes);
    equal(prefix + 'texture decodedRgbaSha256: ' + name, texture.decodedRgbaSha256,
      source.decodedRgbaSha256);
    equal(prefix + 'texture file sha256 equals decoded sha256: ' + name,
      texture.sha256, texture.decodedRgbaSha256);
    check(prefix + 'texture bytes equal width*height*4: ' + name,
      texture.bytes === texture.width * texture.height * 4, texture.bytes);
    equal(prefix + 'texture file path: ' + name, texture.file,
      mapId + '/lightmap/' + name + '.rgba');

    const file = path.join(EXPORT_ROOT, texture.file);
    const exists = check(prefix + 'texture file exists: ' + name, existsSync(file), file);
    if (!exists) continue;
    const buffer = readFileSync(file);
    check(prefix + 'texture file size: ' + name, buffer.length === texture.bytes,
      buffer.length);
    check(prefix + 'texture file sha256: ' + name, sha256(buffer) === texture.sha256,
      sha256(buffer));
    check(prefix + 'texture file sha256 equals decodedRgbaSha256: ' + name,
      sha256(buffer) === texture.decodedRgbaSha256, sha256(buffer));
  }
  equal(prefix + 'index texture set equals the runtime texture set',
    [...seen].sort(), [...runtimeByName.keys()].sort());

  const directory = path.join(EXPORT_ROOT, mapId, 'lightmap');
  const onDisk = readdirSync(directory).filter((name) => name.endsWith('.rgba')).sort();
  equal(prefix + 'no stale .rgba files',
    onDisk, index.textures.map((texture) => texture.name + '.rgba').sort());

  // -- module ------------------------------------------------------------
  const shader = {
    uvSource: runtimeLightmap.shader.uvSource,
    sunSky: runtimeLightmap.shader.sunSky,
    rgbNormalisedGamma: runtimeLightmap.shader.rgbNormalisedGamma
  };
  const expectedSet = {
    mapId,
    count: index.count,
    uvSet: UV_SET,
    shader,
    textures: index.textures.map((texture) => ({
      name: texture.name,
      width: texture.width,
      height: texture.height,
      url: URL_PREFIX + '/' + mapId + '/lightmap/' + texture.name + '.rgba',
      bytes: texture.bytes,
      sha256: texture.sha256
    }))
  };
  const set = module.lightmapSetFor(mapId);
  equal(prefix + 'module set matches the index', set, expectedSet);
  equal(prefix + 'module shader matches the table', module.lightmapShaderFor(mapId), shader);
  check(prefix + 'module shader is the set shader',
    module.lightmapShaderFor(mapId) === set.shader, null);
  equal(prefix + 'module texture lookup: ' + index.textures[0].name,
    module.lightmapTextureFor(mapId, index.textures[0].name), expectedSet.textures[0]);
  equal(prefix + 'module texture lookup: ' + index.textures[index.textures.length - 1].name,
    module.lightmapTextureFor(mapId, index.textures[index.textures.length - 1].name),
    expectedSet.textures[expectedSet.textures.length - 1]);
  equal(prefix + 'module texture lookup returns null for an unknown name',
    module.lightmapTextureFor(mapId, 'not-a-lightmap'), null);
  check(prefix + 'module set is deep-frozen',
    Object.isFrozen(set) && Object.isFrozen(set.textures) &&
    Object.isFrozen(set.shader) && set.textures.every((texture) => Object.isFrozen(texture)),
    null);
}

// -- re-derivation and determinism ----------------------------------------
const tempA = mkdtempSync(path.join(os.tmpdir(), 'lightmap-runtime-a-'));
const tempB = mkdtempSync(path.join(os.tmpdir(), 'lightmap-runtime-b-'));
try {
  for (const [label, root] of [['a', tempA], ['b', tempB]]) {
    const result = spawnSync(python, [
      EXPORTER, '--maps', maps.join(','), '--out-root', root, '--quiet'
    ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    equal('export run ' + label + ' exit 0', result.status, 0);
    check('export run ' + label + ' no stderr',
      !result.stderr || result.stderr.trim() === '', result.stderr ?? '');
    if (result.status !== 0) {
      console.error(result.stderr || result.stdout || 'export failed');
      process.exit(1);
    }
  }

  for (const mapId of maps) {
    const relative = path.join(mapId, 'lightmap', 'index.json');
    const committed = path.join(EXPORT_ROOT, relative);
    if (!existsSync(committed)) {
      check(mapId + ' committed export index exists for comparison', false, committed);
      continue;
    }
    const expected = readFileSync(committed);
    const runA = readFileSync(path.join(tempA, relative));
    const runB = readFileSync(path.join(tempB, relative));
    check(mapId + ' re-derived index is byte-identical to the export',
      runA.equals(expected), null);
    check(mapId + ' two export runs are byte-identical', runA.equals(runB), null);

    const index = JSON.parse(runA.toString('utf8'));
    let filesOk = true;
    for (const texture of index.textures) {
      const fileA = readFileSync(path.join(tempA, texture.file));
      const fileB = readFileSync(path.join(tempB, texture.file));
      if (fileA.length !== texture.bytes || fileB.length !== texture.bytes ||
          sha256(fileA) !== texture.sha256 || sha256(fileB) !== texture.sha256) {
        filesOk = false;
        check(mapId + ' re-derived file matches: ' + texture.name, false, texture.name);
      }
    }
    check(mapId + ' every re-derived file matches the index', filesOk, null);
  }
} finally {
  rmSync(tempA, { recursive: true, force: true });
  rmSync(tempB, { recursive: true, force: true });
}

for (const failure of failures) {
  const detail = failure.detail === null ? '' : ' :: ' + JSON.stringify(failure.detail);
  console.log('FAIL ' + failure.name + (detail.length > 240 ? detail.slice(0, 240) + '…' : detail));
}
const passed = checks.length - failures.length;
console.log(passed + '/' + checks.length + ' checks passed');
if (failures.length > 0) process.exitCode = 1;
