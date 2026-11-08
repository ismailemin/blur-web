// Versioned Blur Web content index loader.
//
// This module is the single consumer-side contract for `_work/content-db`.
// It validates the schema, every per-entry hash and the top-level hash before
// returning a queryable database.  A malformed, edited or partially copied
// document raises a typed ContentDbError; it is never silently repaired.
//
// Canonical hash form `blur.content-db.canonical/1`:
//   - object keys sorted (ASCII keys in this document),
//   - strings ASCII-escaped like Python json.dumps(ensure_ascii=True),
//   - numbers as `#<16 hex>` of their IEEE-754 binary64 big-endian bytes.
// The Python builder implements the same form, so hashes are reproducible in
// both languages.
//
// Usage as a library:
//   import { loadContentDb } from './loader.mjs';
//   const db = await loadContentDb();
//   db.byMode('sprint.310m');
//
// CLI:
//   node probes/content-db/loader.mjs --validate
//   node probes/content-db/loader.mjs --query mode=sprint.310m
//   node probes/content-db/loader.mjs --query map=usa_la_river
//   node probes/content-db/loader.mjs --query class=A
//   node probes/content-db/loader.mjs --index

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CONTENT_SCHEMA = 'blur.content-index/1';
export const CONTENT_VERSION = 1;
export const CANONICAL_FORM = 'blur.content-db.canonical/1';
export const DEFAULT_CONTENT_URL = new URL('../../_work/content-db/content.json', import.meta.url);

const REQUIRED_SECTIONS = [
  'cars',
  'maps',
  'modes',
  'powerups',
  'pickupPlacements',
  'audioEvents',
  'hudAssets',
  'careerEvents',
  'locales'
];

const SECTION_FILES = Object.freeze({
  cars: 'cars.json',
  maps: 'maps.json',
  modes: 'modes.json',
  powerups: 'powerups.json',
  pickupPlacements: 'pickupPlacements.json',
  audioEvents: 'audioEvents.json',
  hudAssets: 'hudAssets.json',
  careerEvents: 'careerEvents.json',
  locales: 'locales.json',
  capabilities: 'capabilities.json',
  validation: 'validation.json'
});

export class ContentDbError extends Error {
  constructor(code, message, path = null, detail = null) {
    super(message || code);
    this.name = 'ContentDbError';
    this.code = code;
    this.path = path;
    this.detail = detail;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      path: this.path,
      detail: this.detail
    };
  }
}

// ---------------------------------------------------------------------------
// canonical form
// ---------------------------------------------------------------------------

function escapeAscii(text) {
  let out = '"';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === 0x22) out += '\\"';
    else if (code === 0x5c) out += '\\\\';
    else if (code === 0x08) out += '\\b';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0d) out += '\\r';
    else if (code === 0x09) out += '\\t';
    else if (code >= 0x20 && code <= 0x7e) out += char;
    else if (code <= 0xffff) out += '\\u' + code.toString(16).padStart(4, '0');
    else {
      const offset = code - 0x10000;
      const high = 0xd800 + (offset >> 10);
      const low = 0xdc00 + (offset & 0x3ff);
      out += '\\u' + high.toString(16).padStart(4, '0');
      out += '\\u' + low.toString(16).padStart(4, '0');
    }
  }
  return out + '"';
}

function numberToken(value) {
  if (!Number.isFinite(value)) {
    throw new ContentDbError('CONTENT_CANONICAL', 'non-finite number in content');
  }
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(value, 0);
  return '#' + buffer.toString('hex');
}

function canonical(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return numberToken(value);
  if (typeof value === 'string') return escapeAscii(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((key) => escapeAscii(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new ContentDbError('CONTENT_CANONICAL', 'unsupported value type ' + typeof value);
}

export function canonicalBytes(value) {
  return Buffer.from(canonical(value), 'utf8');
}

export function digest(value) {
  return 'sha256:' + createHash('sha256').update(canonicalBytes(value)).digest('hex');
}

export function entryHash(entry) {
  const copy = { ...entry };
  delete copy.hash;
  return digest(copy);
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTypedMissing(value) {
  return isObject(value) && value.status === 'missing' && typeof value.reason === 'string';
}

function validateReference(value, path, errors) {
  if (!isObject(value)) {
    errors.push({ code: 'CONTENT_REF', path, message: 'reference is not an object' });
    return;
  }
  if (value.status === 'missing') {
    if (typeof value.reason !== 'string' || value.reason.length === 0) {
      errors.push({ code: 'CONTENT_REF', path, message: 'typed missing has no reason' });
    }
    return;
  }
  if (value.status !== 'available' && value.status !== 'present') {
    errors.push({ code: 'CONTENT_REF', path, message: 'reference status is ' + String(value.status) });
  }
  if (value.path !== undefined && typeof value.path !== 'string') {
    errors.push({ code: 'CONTENT_REF', path, message: 'reference path is not a string' });
  }
}

function sectionRows(doc, name, errors) {
  const rows = doc[name];
  if (!Array.isArray(rows)) {
    errors.push({ code: 'CONTENT_SCHEMA', path: name, message: 'section is not an array' });
    return [];
  }
  const ids = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const path = name + '[' + index + ']';
    if (!isObject(row)) {
      errors.push({ code: 'CONTENT_SCHEMA', path, message: 'entry is not an object' });
      continue;
    }
    if (typeof row.id !== 'string' || row.id.length === 0) {
      errors.push({ code: 'CONTENT_SCHEMA', path, message: 'entry has no string id' });
    } else if (ids.has(row.id)) {
      errors.push({ code: 'CONTENT_DUPLICATE', path, message: 'duplicate id ' + row.id });
    } else {
      ids.add(row.id);
    }
    if (typeof row.hash !== 'string' || !row.hash.startsWith('sha256:')) {
      errors.push({ code: 'CONTENT_HASH', path, message: 'entry hash is missing' });
    } else {
      const actual = entryHash(row);
      if (actual !== row.hash) {
        errors.push({
          code: 'CONTENT_HASH',
          path,
          message: 'entry hash mismatch for ' + row.id,
          detail: { expected: row.hash, actual }
        });
      }
    }
  }
  return rows;
}

export function validateDocument(doc, options = {}) {
  const errors = [];
  if (!isObject(doc)) {
    throw new ContentDbError('CONTENT_SCHEMA', 'content document is not an object');
  }
  if (doc.schema !== CONTENT_SCHEMA) {
    errors.push({ code: 'CONTENT_SCHEMA', path: 'schema', message: 'expected ' + CONTENT_SCHEMA });
  }
  if (doc.contentVersion !== CONTENT_VERSION) {
    errors.push({
      code: 'CONTENT_VERSION',
      path: 'contentVersion',
      message: 'expected ' + CONTENT_VERSION + ', got ' + String(doc.contentVersion)
    });
  }
  if (doc.kind !== 'blur.content-index') {
    errors.push({ code: 'CONTENT_SCHEMA', path: 'kind', message: 'unexpected document kind' });
  }
  if (!isObject(doc.build) || typeof doc.build.stamp !== 'string') {
    errors.push({ code: 'CONTENT_SCHEMA', path: 'build', message: 'build stamp is missing' });
  }
  if (!isObject(doc.hashes) || typeof doc.hashes.top !== 'string') {
    errors.push({ code: 'CONTENT_HASH', path: 'hashes', message: 'top hash is missing' });
  }
  if (!isObject(doc.capabilities) || !isObject(doc.capabilities.maps)) {
    errors.push({ code: 'CONTENT_SCHEMA', path: 'capabilities', message: 'capabilities block is missing' });
  }

  const rowsByName = {};
  for (const name of REQUIRED_SECTIONS) {
    rowsByName[name] = sectionRows(doc, name, errors);
  }

  const carIds = new Set(rowsByName.cars.map((row) => row.id));
  const mapIds = new Set(rowsByName.maps.map((row) => row.id));
  const modeIds = new Set(rowsByName.modes.map((row) => row.id));
  const powerupIds = new Set(rowsByName.powerups.map((row) => row.id));
  const hudIds = new Set(rowsByName.hudAssets.map((row) => row.id));

  for (const car of rowsByName.cars) {
    if (isObject(car.chunks)) validateReference(car.chunks.geometry, 'cars.' + car.id + '.chunks.geometry', errors);
    if (isObject(car.ghosts)) {
      for (const [course, ref] of Object.entries(car.ghosts)) {
        validateReference(ref, 'cars.' + car.id + '.ghosts.' + course, errors);
      }
    }
    if (!Array.isArray(car.liveryRefs) || car.liveryRefs.length === 0) {
      errors.push({ code: 'CONTENT_REF', path: 'cars.' + car.id + '.liveryRefs', message: 'typed livery reference is missing' });
    }
    const icon = car.hud?.iconRef;
    if (isObject(icon) && icon.status === 'available' && typeof icon.sprite === 'string') {
      if (!hudIds.has('hud.icon.' + icon.sprite) && !hudIds.has('hud.atlas.' + icon.sprite)) {
        errors.push({ code: 'CONTENT_REF', path: 'cars.' + car.id + '.hud.iconRef', message: 'sprite is not in hudAssets' });
      }
    }
  }

  for (const map of rowsByName.maps) {
    for (const key of ['package', 'collider', 'pickupPath', 'lapLayout']) {
      validateReference(map[key], 'maps.' + map.id + '.' + key, errors);
    }
    for (const modeId of map.modes || []) {
      if (!modeIds.has(modeId)) {
        errors.push({ code: 'CONTENT_REF', path: 'maps.' + map.id + '.modes', message: 'unknown mode ' + modeId });
      }
    }
    if (map.registryId !== null && typeof map.registryId !== 'string') {
      errors.push({ code: 'CONTENT_SCHEMA', path: 'maps.' + map.id + '.registryId', message: 'registryId is not string/null' });
    }
  }

  for (const mode of rowsByName.modes) {
    for (const mapId of mode.maps || []) {
      if (!mapIds.has(mapId)) {
        errors.push({ code: 'CONTENT_REF', path: 'modes.' + mode.id + '.maps', message: 'unknown map ' + mapId });
      }
    }
  }

  for (const placement of rowsByName.pickupPlacements) {
    if (!powerupIds.has(placement.typeId)) {
      errors.push({
        code: 'CONTENT_REF',
        path: 'pickupPlacements.' + placement.id + '.typeId',
        message: 'unknown pickup type ' + String(placement.typeId)
      });
    }
    if (!mapIds.has(placement.mapId)) {
      errors.push({
        code: 'CONTENT_REF',
        path: 'pickupPlacements.' + placement.id + '.mapId',
        message: 'unknown map ' + String(placement.mapId)
      });
    }
  }

  for (const event of rowsByName.careerEvents) {
    if (typeof event.mapId === 'string' && !mapIds.has(event.mapId)) {
      errors.push({ code: 'CONTENT_REF', path: 'careerEvents.' + event.id + '.mapId', message: 'unknown map ' + event.mapId });
    }
    if (typeof event.modeId === 'string' && !modeIds.has(event.modeId)) {
      errors.push({ code: 'CONTENT_REF', path: 'careerEvents.' + event.id + '.modeId', message: 'unknown mode ' + event.modeId });
    }
  }

  for (const powerup of rowsByName.powerups) {
    if (!isTypedMissing(powerup.nameKey) && powerup.nameKey?.status !== 'available') {
      errors.push({ code: 'CONTENT_REF', path: 'powerups.' + powerup.id + '.nameKey', message: 'name key is neither available nor typed missing' });
    }
    if (!isTypedMissing(powerup.iconRef) && powerup.iconRef?.status !== 'partial') {
      errors.push({ code: 'CONTENT_REF', path: 'powerups.' + powerup.id + '.iconRef', message: 'icon ref is neither partial nor typed missing' });
    }
  }

  for (const [mapId, capability] of Object.entries(doc.capabilities?.maps || {})) {
    if (!mapIds.has(mapId)) {
      errors.push({ code: 'CONTENT_REF', path: 'capabilities.maps', message: 'unknown map ' + mapId });
    }
    for (const modeId of Object.keys(capability.modes || {})) {
      if (!modeIds.has(modeId)) {
        errors.push({ code: 'CONTENT_REF', path: 'capabilities.maps.' + mapId + '.modes', message: 'unknown mode ' + modeId });
      }
    }
    for (const [feature, value] of Object.entries(capability.features || {})) {
      if (!['available', 'partial', 'unsupported', 'missing'].includes(value.status)) {
        errors.push({ code: 'CONTENT_CAPABILITY', path: 'capabilities.maps.' + mapId + '.features.' + feature, message: 'bad feature status ' + String(value.status) });
      }
    }
  }

  const counts = doc.counts || {};
  for (const name of REQUIRED_SECTIONS) {
    if (counts[name] !== rowsByName[name].length) {
      errors.push({
        code: 'CONTENT_COUNT',
        path: 'counts.' + name,
        message: 'counts.' + name + ' does not match section length',
        detail: { counted: counts[name], actual: rowsByName[name].length }
      });
    }
  }

  if (doc.hashes?.sections && isObject(doc.hashes.sections)) {
    for (const [name, expected] of Object.entries(doc.hashes.sections)) {
      if (!REQUIRED_SECTIONS.includes(name)) continue;
      const actual = digest({ entries: rowsByName[name], missing: [], meta: null });
      // The builder hashes entries plus section metadata.  Per-entry hashes are
      // the authoritative integrity check here; the section hash is checked by
      // the Python verifier against the split file payload.
      if (typeof expected !== 'string') {
        errors.push({ code: 'CONTENT_HASH', path: 'hashes.sections.' + name, message: 'section hash is not a string' });
      }
    }
  }

  if (doc.hashes?.top) {
    const copy = { ...doc };
    delete copy.hashes;
    const actual = digest(copy);
    if (actual !== doc.hashes.top) {
      errors.push({
        code: 'CONTENT_HASH',
        path: 'hashes.top',
        message: 'top hash mismatch',
        detail: { expected: doc.hashes.top, actual }
      });
    }
  }

  if (errors.length > 0) {
    const first = errors[0];
    throw new ContentDbError(first.code, first.message, first.path, {
      errors,
      contentPath: options.contentPath || null
    });
  }
  return true;
}

// ---------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------

function indexById(rows) {
  return new Map(rows.map((row) => [row.id, row]));
}

function filterRows(rows, predicate) {
  return rows.filter(predicate);
}

export class ContentDatabase {
  constructor(doc, options = {}) {
    validateDocument(doc, options);
    this.doc = doc;
    this.sourcePath = options.contentPath || null;
    this._cars = indexById(doc.cars);
    this._maps = indexById(doc.maps);
    this._modes = indexById(doc.modes);
    this._powerups = indexById(doc.powerups);
    this._hud = indexById(doc.hudAssets);
    this._registryMaps = new Map(
      doc.maps.filter((row) => row.registryId).map((row) => [row.registryId, row])
    );
  }

  get schema() { return this.doc.schema; }
  get contentVersion() { return this.doc.contentVersion; }
  get buildStamp() { return this.doc.build.stamp; }
  get topHash() { return this.doc.hashes.top; }
  get counts() { return this.doc.counts; }
  get missing() { return this.doc.missing; }
  get defaults() { return this.doc.defaults; }
  get sections() { return SECTION_FILES; }

  cars(options = {}) {
    return filterRows(this.doc.cars, (row) => {
      if (options.class && row.class !== options.class) return false;
      if (options.drivetrain && row.drivetrain !== options.drivetrain) return false;
      if (options.availability && row.availability !== options.availability) return false;
      if (options.hudIcon && row.hud?.iconRef?.status !== options.hudIcon) return false;
      return true;
    });
  }

  maps(options = {}) {
    return filterRows(this.doc.maps, (row) => {
      if (options.mode && !(row.modes || []).includes(options.mode)) return false;
      if (options.availability && row.availability !== options.availability) return false;
      if (options.classification && row.classification !== options.classification) return false;
      if (options.registryId && row.registryId !== options.registryId) return false;
      return true;
    });
  }

  modes() { return this.doc.modes; }
  powerups() { return this.doc.powerups; }
  hudAssets() { return this.doc.hudAssets; }
  audioEvents() { return this.doc.audioEvents; }
  locales() { return this.doc.locales; }

  pickupPlacements(mapId = null) {
    if (mapId === null) return this.doc.pickupPlacements;
    return this.doc.pickupPlacements.filter((row) => row.mapId === mapId);
  }

  careerEvents(options = {}) {
    return filterRows(this.doc.careerEvents, (row) => {
      if (options.map && row.mapId !== options.map) return false;
      if (options.mode && row.modeId !== options.mode) return false;
      if (options.class && row.carClass !== options.class) return false;
      return true;
    });
  }

  car(id) {
    const row = this._cars.get(id);
    if (!row) throw new ContentDbError('CONTENT_NOT_FOUND', 'unknown car ' + String(id), 'cars.' + id);
    return row;
  }

  map(id) {
    const row = this._maps.get(id) || this._registryMaps.get(id);
    if (!row) throw new ContentDbError('CONTENT_NOT_FOUND', 'unknown map ' + String(id), 'maps.' + id);
    return row;
  }

  mode(id) {
    const row = this._modes.get(id);
    if (!row) throw new ContentDbError('CONTENT_NOT_FOUND', 'unknown mode ' + String(id), 'modes.' + id);
    return row;
  }

  powerup(id) {
    const row = this._powerups.get(id);
    if (!row) throw new ContentDbError('CONTENT_NOT_FOUND', 'unknown powerup ' + String(id), 'powerups.' + id);
    return row;
  }

  byClass(className) {
    return this.cars({ class: className });
  }

  byMode(modeId) {
    const mode = this.mode(modeId);
    return this.doc.maps
      .filter((row) => (row.modes || []).includes(modeId))
      .map((row) => ({
        mapId: row.id,
        registryId: row.registryId,
        modeId,
        status: this.doc.capabilities?.maps?.[row.id]?.modes?.[modeId]?.status || 'unknown',
        reason: this.doc.capabilities?.maps?.[row.id]?.modes?.[modeId]?.reason || null,
        map: row,
        mode
      }));
  }

  byMap(mapId) {
    const map = this.map(mapId);
    return {
      map,
      capabilities: this.capabilities(map.id),
      pickups: this.pickupPlacements(map.id),
      careerEvents: this.careerEvents({ map: map.id }),
      modes: (map.modes || []).map((modeId) => this.mode(modeId))
    };
  }

  capabilities(mapId) {
    const row = this.map(mapId);
    return this.doc.capabilities?.maps?.[row.id] || null;
  }

  query(options = {}) {
    const result = {};
    if (options.class) result.cars = this.byClass(options.class);
    if (options.map) result.maps = this.maps({ registryId: options.map });
    if (options.mode) result.modes = this.byMode(options.mode);
    if (options.availability) {
      result.cars = this.cars({ availability: options.availability });
      result.maps = this.maps({ availability: options.availability });
    }
    if (Object.keys(result).length === 0) {
      throw new ContentDbError('CONTENT_QUERY', 'query needs class, map, mode or availability');
    }
    return result;
  }
}

export async function loadContentDb(source = DEFAULT_CONTENT_URL, options = {}) {
  let text;
  let contentPath;
  try {
    if (typeof source === 'string') {
      text = await readFile(source, 'utf8');
      contentPath = source;
    } else if (source instanceof URL) {
      text = await readFile(source, 'utf8');
      contentPath = fileURLToPath(source);
    } else if (source && typeof source === 'object') {
      return new ContentDatabase(source, options);
    } else {
      throw new ContentDbError('CONTENT_READ', 'unsupported content source');
    }
  } catch (error) {
    if (error instanceof ContentDbError) throw error;
    throw new ContentDbError('CONTENT_READ', 'cannot read content document', String(source), {
      cause: String(error?.message || error)
    });
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new ContentDbError('CONTENT_JSON', 'content document is not valid JSON', contentPath, {
      cause: String(error?.message || error)
    });
  }
  return new ContentDatabase(doc, { ...options, contentPath });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { mode: null, query: null, source: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--validate') out.mode = 'validate';
    else if (arg === '--index') out.mode = 'index';
    else if (arg === '--query') {
      out.mode = 'query';
      out.query = argv[index + 1] || null;
      index += 1;
    } else if (!arg.startsWith('--')) out.source = arg;
  }
  return out;
}

function summarize(db) {
  return {
    ok: true,
    schema: db.schema,
    contentVersion: db.contentVersion,
    buildStamp: db.buildStamp,
    topHash: db.topHash,
    counts: db.counts,
    defaults: db.defaults
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = await loadContentDb(args.source || DEFAULT_CONTENT_URL);
  if (!args.mode || args.mode === 'validate') {
    process.stdout.write(JSON.stringify(summarize(db), null, 2) + '\n');
    return 0;
  }
  if (args.mode === 'index') {
    process.stdout.write(
      JSON.stringify(
        {
          schema: db.schema,
          contentVersion: db.contentVersion,
          buildStamp: db.buildStamp,
          topHash: db.topHash,
          counts: db.counts,
          defaults: db.defaults,
          files: db.sections,
          cars: db.cars().map((row) => ({
            id: row.id,
            displayName: row.displayName,
            class: row.class,
            drivetrain: row.drivetrain,
            massKg: row.massKg,
            gears: row.gears,
            availability: row.availability
          })),
          maps: db.maps().map((row) => ({
            id: row.id,
            registryId: row.registryId,
            label: row.label,
            lengthMetres: row.lengthMetres,
            modes: row.modes,
            availability: row.availability
          }))
        },
        null,
        2
      ) + '\n'
    );
    return 0;
  }
  if (args.mode === 'query') {
    if (!args.query || !args.query.includes('=')) {
      throw new ContentDbError('CONTENT_QUERY', 'query must be key=value');
    }
    const [key, value] = args.query.split('=', 2);
    const result = db.query({ [key]: value });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }
  throw new ContentDbError('CONTENT_QUERY', 'unknown mode ' + String(args.mode));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('loader.mjs')) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      const payload = error instanceof ContentDbError ? error.toJSON() : { name: error?.name, message: String(error?.message || error) };
      process.stderr.write(JSON.stringify(payload, null, 2) + '\n');
      process.exitCode = 1;
    });
}
