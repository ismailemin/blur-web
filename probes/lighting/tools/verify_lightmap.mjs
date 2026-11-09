#!/usr/bin/env node
// Independent verifier for the decoded static-world lightmap set.
//
//   node probes/lighting/tools/verify_lightmap.mjs
//   node probes/lighting/tools/verify_lightmap.mjs --levels river,amboy
//
// It re-derives the decoded bytes and hashes from the committed retail source
// with `lightmap_reference.py` (which does not import the manifest builder),
// then checks:
//   * every manifest `lightmap` block against the reference (dimensions,
//     format, byte counts, blob sha256, decoded RGBA sha256, source offsets);
//   * the g_tLightmap reference set equals the lightmap_* texture set;
//   * the committed runtime table carries the same lightmap set;
//   * `ambient.lightmap` is absent from `missing` when the set is decoded;
//   * two reference builds are byte-identical.
//
// Exit code 0 only when every check passes.  The Python reference uses the
// bundled interpreter when PYTHON is set, otherwise `python` on PATH.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const PYTHON = process.env.PYTHON || 'python';
const REFERENCE = path.join(HERE, 'lightmap_reference.py');
const MAP_ORDER = [
  'river', 'amboy', 'gracia', 'longbeach',
  'observatory', 'downtown', 'mharuna', 'highrise', 'shutoko', 'oval', 'amboy-mp',
  'dumbo', 'downtown-mp'
];
const SCHEMA = 'blur-lighting-lightmap-reference/1';
const FORMAT = 894720068;
const FORMAT_NAME = 'DXT5/BC3';

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

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
}

function parseArgs(argv) {
  const options = { levels: MAP_ORDER.slice() };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--levels') {
      options.levels = argv[++index].split(',').map((name) => name.trim()).filter(Boolean);
    } else if (argv[index] === '--python') {
      options.python = argv[++index];
    } else {
      throw new Error('unknown argument ' + JSON.stringify(argv[index]));
    }
  }
  for (const short of options.levels) {
    if (!MAP_ORDER.includes(short)) {
      throw new Error('unknown level ' + JSON.stringify(short));
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const python = options.python || PYTHON;

const index = readJson('_work/lighting/index.json');
const runtime = readJson('probes/lighting/data/runtime-lighting.json');
const manifests = {};
for (const short of options.levels) {
  const record = index.levels[short];
  if (!record) {
    check(short + ' is in the lighting index', false, null);
    continue;
  }
  manifests[short] = readJson(record.path);
}

const temp = mkdtempSync(path.join(os.tmpdir(), 'lightmap-reference-'));
let reference = null;
try {
  const runs = [];
  for (const suffix of ['a', 'b']) {
    const out = path.join(temp, 'reference-' + suffix + '.json');
    const result = spawnSync(python, [
      REFERENCE, '--levels', options.levels.join(','), '--out', out
    ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    equal('reference run ' + suffix + ' exit 0', result.status, 0);
    check('reference run ' + suffix + ' no stderr',
      !result.stderr || result.stderr.trim() === '', result.stderr ?? '');
    if (result.status !== 0) {
      console.error(result.stderr || result.stdout || 'reference failed');
      process.exit(1);
    }
    runs.push(readFileSync(out));
  }
  check('two reference builds are byte-identical', runs[0].equals(runs[1]));
  reference = JSON.parse(runs[0].toString('utf8'));
} finally {
  rmSync(temp, { recursive: true, force: true });
}

equal('reference schema', reference.schema, SCHEMA);
equal('reference kind', reference.kind, 'lightmap-reference');
equal('reference level set', Object.keys(reference.levels).sort(),
  options.levels.slice().sort());

for (const short of options.levels) {
  const manifest = manifests[short];
  const ref = reference.levels[short];
  const prefix = short + ' ';
  check(prefix + 'manifest present', Boolean(manifest));
  check(prefix + 'reference present', Boolean(ref));
  if (!manifest || !ref) continue;

  const lightmap = manifest.lightmap;
  const referenceLightmap = ref.lightmap;
  check(prefix + 'manifest lightmap block present', Boolean(lightmap));
  check(prefix + 'reference lightmap block present', Boolean(referenceLightmap));
  if (!lightmap || !referenceLightmap) continue;

  // -- source identity ---------------------------------------------------
  equal(prefix + 'reference level id', ref.level, manifest.level);
  equal(prefix + 'reference render path', ref.source.render.path,
    manifest.source.render.path);
  equal(prefix + 'reference render bytes', ref.source.render.bytes,
    manifest.source.render.bytes);
  equal(prefix + 'reference render sha256', ref.source.render.sha256,
    manifest.source.render.sha256);
  equal(prefix + 'reference stream path', ref.source.stream.path,
    manifest.source.stream.path);
  equal(prefix + 'reference stream bytes', ref.source.stream.bytes,
    manifest.source.stream.bytes);
  const streamFile = readFileSync(path.join(ROOT, ref.source.stream.path));
  equal(prefix + 'reference stream sha256 matches the file',
    ref.source.stream.sha256, sha256(streamFile));

  // -- set shape ---------------------------------------------------------
  equal(prefix + 'lightmap kind', lightmap.kind, referenceLightmap.kind);
  equal(prefix + 'lightmap decoded', lightmap.decoded, referenceLightmap.decoded);
  equal(prefix + 'lightmap complete', lightmap.complete, referenceLightmap.complete);
  equal(prefix + 'lightmap partial flag', lightmap.partial === true,
    referenceLightmap.partial === true);
  equal(prefix + 'lightmap unsupportedReferences', lightmap.unsupportedReferences,
    referenceLightmap.unsupportedReferences);
  equal(prefix + 'lightmap uvSet', lightmap.uvSet, referenceLightmap.uvSet);
  equal(prefix + 'lightmap format', lightmap.format, referenceLightmap.format);
  equal(prefix + 'lightmap formatName', lightmap.formatName, referenceLightmap.formatName);
  equal(prefix + 'lightmap format is DXT5/BC3', lightmap.format, FORMAT);
  equal(prefix + 'lightmap formatName is DXT5/BC3', lightmap.formatName, FORMAT_NAME);
  equal(prefix + 'lightmap count', lightmap.count, referenceLightmap.count);
  equal(prefix + 'lightmap width', lightmap.width, referenceLightmap.width);
  equal(prefix + 'lightmap height', lightmap.height, referenceLightmap.height);
  equal(prefix + 'lightmap dimensions', lightmap.dimensions,
    referenceLightmap.dimensions);
  equal(prefix + 'lightmap bytes', lightmap.bytes, referenceLightmap.bytes);
  equal(prefix + 'lightmap sha256', lightmap.sha256, referenceLightmap.sha256);
  equal(prefix + 'lightmap decodedRgbaSha256', lightmap.decodedRgbaSha256,
    referenceLightmap.decodedRgbaSha256);
  check(prefix + 'lightmap count is non-negative', lightmap.count >= 0, lightmap.count);
  check(prefix + 'lightmap decoded matches the reference',
    lightmap.decoded === referenceLightmap.decoded, lightmap.decoded);
  check(prefix + 'lightmap unsupported is a list', Array.isArray(lightmap.unsupported),
    lightmap.unsupported);
  if (lightmap.complete) {
    check(prefix + 'complete lightmap has no unsupported entries',
      lightmap.unsupported.length === 0, lightmap.unsupported);
  } else {
    check(prefix + 'incomplete lightmap has typed entries',
      lightmap.unsupported.length > 0, lightmap.unsupported);
  }
  equal(prefix + 'lightmap unsupported names',
    lightmap.unsupported.map((entry) => entry.name ?? null),
    referenceLightmap.unsupported.map((entry) => entry.name ?? null));
  equal(prefix + 'lightmap unsupported keys',
    lightmap.unsupported.map((entry) => entry.key ?? null),
    referenceLightmap.unsupported.map((entry) => entry.key ?? null));
  equal(prefix + 'lightmap unsupported counts',
    lightmap.unsupported.map((entry) => entry.count ?? 1),
    referenceLightmap.unsupported.map((entry) => entry.count ?? 1));
  equal(prefix + 'lightmap unsupported reasons',
    lightmap.unsupported.map((entry) => entry.reason),
    referenceLightmap.unsupported.map((entry) => entry.reason));
  equal(prefix + 'lightmap unsupported byte positions',
    lightmap.unsupported.map((entry) => entry.bytePosition ?? null),
    referenceLightmap.unsupported.map((entry) => entry.bytePosition ?? null));
  check(prefix + 'lightmap byte total equals the texture sum',
    lightmap.bytes === lightmap.textures.reduce((sum, texture) => sum + texture.bytes, 0),
    lightmap.bytes);
  if (lightmap.complete) {
    check(prefix + 'lightmap reference set is clean',
      lightmap.referenceSummary.unresolved.length === 0 &&
      lightmap.referenceSummary.unreferencedNamePrefixLightmaps.length === 0 &&
      lightmap.referenceSummary.referencedLightmapsMissingFromNamePrefix.length === 0 &&
      lightmap.referenceSummary.referencedNonLightmaps.length === 0,
      lightmap.referenceSummary);
  } else {
    check(prefix + 'incomplete lightmap records the unclean reference set',
      lightmap.referenceSummary.unresolved.length > 0 ||
      lightmap.referenceSummary.referencedNonLightmaps.length > 0,
      lightmap.referenceSummary);
    check(prefix + 'incomplete lightmap is decoded with textures',
      lightmap.decoded === true && lightmap.textures.length > 0, lightmap.decoded);
  }

  // -- per texture -------------------------------------------------------
  const manifestNames = lightmap.textures.map((texture) => texture.name);
  const referenceNames = referenceLightmap.textures.map((texture) => texture.name);
  equal(prefix + 'lightmap texture names', manifestNames, referenceNames);
  check(prefix + 'lightmap texture names are sorted',
    JSON.stringify(manifestNames) === JSON.stringify([...manifestNames].sort()),
    manifestNames.slice(0, 3));
  const referenceByName = new Map(referenceLightmap.textures.map((texture) =>
    [texture.name, texture]));
  for (const texture of lightmap.textures) {
    const expected = referenceByName.get(texture.name);
    const name = texture.name;
    check(prefix + 'reference texture exists: ' + name, Boolean(expected), null);
    if (!expected) continue;
    equal(prefix + 'texture width: ' + name, texture.width, expected.width);
    equal(prefix + 'texture height: ' + name, texture.height, expected.height);
    equal(prefix + 'texture format: ' + name, texture.format, expected.format);
    equal(prefix + 'texture formatName: ' + name, texture.formatName, expected.formatName);
    equal(prefix + 'texture levels: ' + name, texture.levels, expected.levels);
    equal(prefix + 'texture bytes: ' + name, texture.bytes, expected.bytes);
    equal(prefix + 'texture payloadBytes: ' + name, texture.payloadBytes,
      expected.payloadBytes);
    equal(prefix + 'texture sha256: ' + name, texture.sha256, expected.sha256);
    equal(prefix + 'texture decodedRgbaBytes: ' + name, texture.decodedRgbaBytes,
      expected.decodedRgbaBytes);
    equal(prefix + 'texture decodedRgbaSha256: ' + name, texture.decodedRgbaSha256,
      expected.decodedRgbaSha256);
    equal(prefix + 'texture referenceCount: ' + name, texture.referenceCount,
      expected.referenceCount);
    equal(prefix + 'texture source: ' + name, texture.source, expected.source);
    check(prefix + 'texture bytes equal header+payload: ' + name,
      texture.bytes === texture.source.headerBytes + texture.payloadBytes,
      texture.bytes);
    check(prefix + 'texture decoded bytes equal w*h*4: ' + name,
      texture.decodedRgbaBytes === texture.width * texture.height * 4,
      texture.decodedRgbaBytes);
    check(prefix + 'texture source fits its stream record: ' + name,
      texture.source.headerOffsetInChunk + texture.source.headerBytes <=
        texture.source.streamRecordBytes &&
      texture.source.dataOffsetInChunk + texture.source.dataBytes <=
        texture.source.streamRecordBytes,
      texture.source);
  }

  // -- runtime table -----------------------------------------------------
  const runtimeEntry = runtime.maps[short];
  check(prefix + 'runtime map present', Boolean(runtimeEntry), null);
  if (!runtimeEntry) continue;
  const runtimeLightmap = runtimeEntry.lightmap;
  if (lightmap.decoded !== true) {
    check(prefix + 'runtime lightmap is null for an unsupported set',
      runtimeLightmap === null, runtimeLightmap);
    check(prefix + 'runtime missing lists ambient.lightmap for an unsupported set',
      runtimeEntry.missing.some((row) => row.field === 'ambient.lightmap'),
      runtimeEntry.missing.map((row) => row.field));
    continue;
  }
  check(prefix + 'runtime lightmap present', Boolean(runtimeLightmap), null);
  if (!runtimeLightmap) continue;
  equal(prefix + 'runtime lightmap kind', runtimeLightmap.kind, lightmap.kind);
  equal(prefix + 'runtime lightmap decoded', runtimeLightmap.decoded, lightmap.decoded);
  equal(prefix + 'runtime lightmap complete', runtimeLightmap.complete, lightmap.complete);
  equal(prefix + 'runtime lightmap partial flag', runtimeLightmap.partial === true,
    lightmap.partial === true);
  equal(prefix + 'runtime lightmap unsupportedReferences',
    runtimeLightmap.unsupportedReferences, lightmap.unsupportedReferences);
  equal(prefix + 'runtime lightmap unsupported entries', runtimeLightmap.unsupported,
    lightmap.unsupported.map((entry) => ({
      name: entry.name ?? null,
      key: entry.key ?? null,
      count: entry.count ?? 1,
      reason: entry.reason,
      bytePosition: entry.bytePosition ?? null
    })));
  equal(prefix + 'runtime lightmap uvSet', runtimeLightmap.uvSet, lightmap.uvSet);
  equal(prefix + 'runtime lightmap format', runtimeLightmap.format, lightmap.format);
  equal(prefix + 'runtime lightmap formatName', runtimeLightmap.formatName,
    lightmap.formatName);
  equal(prefix + 'runtime lightmap count', runtimeLightmap.count, lightmap.count);
  equal(prefix + 'runtime lightmap dimensions', runtimeLightmap.dimensions,
    lightmap.dimensions);
  equal(prefix + 'runtime lightmap bytes', runtimeLightmap.bytes, lightmap.bytes);
  equal(prefix + 'runtime lightmap sha256', runtimeLightmap.sha256, lightmap.sha256);
  equal(prefix + 'runtime lightmap decodedRgbaSha256',
    runtimeLightmap.decodedRgbaSha256, lightmap.decodedRgbaSha256);
  equal(prefix + 'runtime lightmap texture names',
    runtimeLightmap.textures.map((texture) => texture.name), manifestNames);
  const manifestByName = new Map(lightmap.textures.map((texture) =>
    [texture.name, texture]));
  for (const texture of runtimeLightmap.textures) {
    const source = manifestByName.get(texture.name);
    check(prefix + 'runtime texture exists in the manifest: ' + texture.name,
      Boolean(source), null);
    if (!source) continue;
    equal(prefix + 'runtime texture sha256: ' + texture.name,
      texture.sha256, source.sha256);
    equal(prefix + 'runtime texture decodedRgbaSha256: ' + texture.name,
      texture.decodedRgbaSha256, source.decodedRgbaSha256);
    equal(prefix + 'runtime texture source: ' + texture.name,
      texture.source, source.source);
  }
  check(prefix + 'runtime missing does not list ambient.lightmap',
    !runtimeEntry.missing.some((row) => row.field === 'ambient.lightmap'),
    runtimeEntry.missing.map((row) => row.field));
}

for (const failure of failures) {
  const detail = failure.detail === null ? '' : ' :: ' + JSON.stringify(failure.detail);
  console.log('FAIL ' + failure.name + (detail.length > 240 ? detail.slice(0, 240) + '…' : detail));
}
const passed = checks.length - failures.length;
console.log(passed + '/' + checks.length + ' checks passed');
if (failures.length > 0) process.exitCode = 1;
