// Blur Web local profile store.
//
// One versioned document for everything a browser build currently keeps in
// localStorage: settings, last-used car/map/mode, per-map/course/car/mode
// records and local race statistics. The module is storage-agnostic: it never
// touches `window`, `localStorage` or `navigator` at import time and every
// entry point accepts an injected localStorage-shaped object and clock.
//
// Design rules:
//   - A stored document is either fully migrated, explicitly reset, or left
//     untouched. There is no silent downgrade of a newer schema.
//   - Corrupt bytes are copied to a backup key before any reset.
//   - Quota exhaustion never removes the player's current profile.
//   - Concurrent tabs are last-write-wins for settings/progress, but records
//     merge by fastest time and stats keep their maximum, so a stale tab cannot
//     erase a better lap.
//   - Serialisation is canonical (sorted keys), so two equivalent profiles
//     produce byte-identical strings and fingerprints.
//
// See docs/work/analysis/profile-store.md for the schema and the integration
// contract. The legacy reader below is intentionally read-only: migration never
// deletes the old best-time keys.

export const PROFILE_KIND = 'blur.profile';
export const PROFILE_SCHEMA_VERSION = 1;

/** Main storage key. A namespace appends `.<namespace>`. */
export const PROFILE_STORAGE_KEY = 'blur.profile.v1';
/** First backup slot; overflow slots are `.backup.1` … `.backup.2`. */
export const PROFILE_BACKUP_KEY = 'blur.profile.v1.backup';
export const PROFILE_BACKUP_MAX = 3;
export const PROFILE_MAX_RECORDS = 4096;
export const PROFILE_MAX_LAP_SPLITS = 128;
export const PROFILE_MAX_SECONDS = 86400;

export const QUALITY_LEVELS = Object.freeze(['low', 'medium', 'high', 'ultra']);
export const CAMERA_MODES = Object.freeze(['chase', 'orbit']);
export const STEER_MODES = Object.freeze(['normal', 'inverted']);
export const HUD_UNITS = Object.freeze(['metric', 'imperial']);
export const PROGRESS_MODES = Object.freeze(['sprint', 'lap', 'free', 'multiplayer']);
export const RECORD_MODES = Object.freeze(['sprint', 'lap']);
export const GHOST_SOURCES = Object.freeze(['local', 'reference']);
export const GHOST_INDEX_URL = '/ghosts/index.json';
export const GHOST_STORE_KEY_PREFIX = 'e1-drive.sprint.ghost.v1.';

/** The legacy single-value key used by the first drive slice, if present. */
export const LEGACY_BEST_TIME_KEY = 'bestTime';

/**
 * Best-time stores written by the current build. Each entry maps a storage key
 * to the record namespace it belongs to. `nulls` are not guessed: a missing
 * legacy key is simply skipped.
 */
export const LEGACY_BEST_KEYS = Object.freeze([
  Object.freeze({ key: 'e1-drive.sprint.best.v1', map: 'river', course: '310m', mode: 'sprint' }),
  Object.freeze({ key: 'e1-drive.sprint.best.v2.310m', map: 'river', course: '310m', mode: 'sprint' }),
  Object.freeze({ key: 'e1-drive.sprint.best.v2.short', map: 'river', course: 'short', mode: 'sprint' }),
  Object.freeze({ key: 'e1-drive.sprint.best.v2.lap', map: 'river', course: 'lap', mode: 'lap' }),
  Object.freeze({ key: 'e1-drive.sprint.best.v2.free', map: 'river', course: 'free', mode: 'free' }),
  Object.freeze({ key: 'e1-drive.sprint.best.v3.amboy', map: 'amboy', course: '310m', mode: 'sprint' }),
  Object.freeze({ key: 'e1-drive.sprint.best.v3.gracia', map: 'gracia', course: '310m', mode: 'sprint' })
]);

export const PROFILE_ERROR = Object.freeze({
  INVALID_ROOT: 'invalid-root',
  INVALID_KIND: 'invalid-kind',
  INVALID_SCHEMA_VERSION: 'invalid-schema-version',
  UNSUPPORTED_SCHEMA_VERSION: 'unsupported-schema-version',
  FUTURE_SCHEMA: 'future-schema',
  INVALID_SECTION: 'invalid-section',
  INVALID_NUMBER: 'invalid-number',
  INVALID_ENUM: 'invalid-enum',
  INVALID_BOOLEAN: 'invalid-boolean',
  INVALID_STRING: 'invalid-string',
  INVALID_DATE: 'invalid-date',
  INVALID_SLUG: 'invalid-slug',
  INVALID_RECORD: 'invalid-record',
  INVALID_RECORD_KEY: 'record-key-mismatch',
  INVALID_GHOST_REFERENCE: 'invalid-ghost-reference',
  RESERVED_KEY: 'reserved-key',
  UNKNOWN_FIELD: 'unknown-field',
  MISSING_SECTION: 'missing-section',
  CORRUPT_JSON: 'corrupt-json',
  INVALID_SCHEMA: 'invalid-schema',
  STORAGE_UNAVAILABLE: 'storage-unavailable',
  QUOTA_EXCEEDED: 'quota-exceeded',
  READ_ONLY: 'read-only',
  BACKUP_FAILED: 'backup-failed',
  INVALID_PROFILE: 'invalid-profile',
  INVALID_SETTINGS: 'invalid-settings',
  INVALID_PROGRESS: 'invalid-progress'
});

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NAMESPACE_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const BINDING_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_PATH_RE = /^[A-Za-z0-9._~/-]+$/;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SETTINGS_KEYS = new Set([
  'quality', 'volumes', 'muted', 'cameraMode', 'steer', 'inputBindingsRef', 'hud'
]);
const VOLUME_KEYS = new Set(['master', 'music', 'sfx']);
const HUD_KEYS = new Set(['showSpeed', 'showGhostDelta', 'showMinimap', 'units']);
const PROGRESS_KEYS = new Set(['lastCar', 'lastMap', 'lastCourse', 'lastMode']);
const PROFILE_KEYS = new Set([
  'kind', 'schemaVersion', 'revision', 'updatedAt', 'settings', 'progress',
  'records', 'stats', 'migration', 'extra'
]);
const RECORD_KEYS = new Set([
  'map', 'course', 'mode', 'car', 'bestTimeSeconds', 'bestLapSeconds',
  'lapSplits', 'ghost', 'date', 'lastTimeSeconds', 'lastDate', 'runs'
]);
const GHOST_REF_KEYS = new Set([
  'source', 'storageKey', 'indexUrl', 'file', 'sha256', 'hash', 'layoutHash',
  'timeSeconds', 'finishTick', 'tickCount'
]);

const round3 = (value) => Math.round(value * 1000) / 1000;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isReserved(key) {
  return RESERVED_KEYS.has(key);
}

/** Fresh mutable default document. Always returns new nested objects. */
export function defaultProfile() {
  return {
    kind: PROFILE_KIND,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    revision: 0,
    updatedAt: 0,
    settings: {
      quality: 'high',
      volumes: { master: 0.8, music: 0.5, sfx: 0.8 },
      muted: false,
      cameraMode: 'chase',
      steer: 'normal',
      inputBindingsRef: 'default-keyboard-v1',
      hud: {
        showSpeed: true,
        showGhostDelta: true,
        showMinimap: false,
        units: 'metric'
      }
    },
    progress: {
      lastCar: null,
      lastMap: null,
      lastCourse: null,
      lastMode: 'sprint'
    },
    records: {},
    stats: { races: 0, wins: 0 },
    migration: null,
    extra: {}
  };
}

/** Canonical JSON: object keys sorted recursively, finite numbers only. */
export function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson rejected a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(sortJson);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      if (isReserved(key)) throw new TypeError('canonicalJson rejected the reserved key ' + key);
      out[key] = sortJson(value[key]);
    }
    return out;
  }
  throw new TypeError('canonicalJson rejected a ' + typeof value + ' value');
}

/** Deterministic FNV-1a-64 fingerprint of the canonical bytes. */
export function profileFingerprint(profile) {
  const text = typeof profile === 'string' ? profile : serializeProfile(profile);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return 'fnv1a64:' + hash.toString(16).padStart(16, '0');
}

/** Byte-stable document text. No clock, no locale, no random value. */
export function serializeProfile(profile) {
  return canonicalJson(profile);
}

/** Approximate quota cost. localStorage usually stores UTF-16 code units. */
export function estimateProfileBytes(profile) {
  const characters = serializeProfile(profile).length;
  return { characters, bytesApprox: characters * 2 };
}

export function sanitizeNamespace(namespace) {
  if (typeof namespace !== 'string' || !NAMESPACE_RE.test(namespace)) {
    throw new TypeError('profile namespace must match ' + NAMESPACE_RE + ' (got ' + JSON.stringify(namespace) + ')');
  }
  return namespace;
}

export function profileStorageKey(namespace = null) {
  return namespace === null || namespace === undefined || namespace === ''
    ? PROFILE_STORAGE_KEY
    : PROFILE_STORAGE_KEY + '.' + sanitizeNamespace(namespace);
}

export function profileBackupKey(namespace = null) {
  return namespace === null || namespace === undefined || namespace === ''
    ? PROFILE_BACKUP_KEY
    : PROFILE_BACKUP_KEY + '.' + sanitizeNamespace(namespace);
}

export function recordKey({ map, course, mode, car }) {
  for (const [name, value] of Object.entries({ map, course, mode, car })) {
    if (typeof value !== 'string' || !SLUG_RE.test(value)) {
      throw new TypeError('record key needs a valid ' + name + ' slug (got ' + JSON.stringify(value) + ')');
    }
  }
  if (!RECORD_MODES.includes(mode)) {
    throw new TypeError('record key mode must be one of ' + RECORD_MODES.join(', '));
  }
  return [map, course, mode, car].join('/');
}

export function parseRecordKey(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split('/');
  if (parts.length !== 4) return null;
  const [map, course, mode, car] = parts;
  try {
    recordKey({ map, course, mode, car });
  } catch {
    return null;
  }
  return { map, course, mode, car };
}

export function isQuotaError(error) {
  if (!error) return false;
  const name = String(error.name ?? '');
  const code = error.code;
  const message = String(error.message ?? '');
  return name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 || code === 1014 ||
    /quota/i.test(message);
}

// ---------------------------------------------------------------------------
// validation and repair
// ---------------------------------------------------------------------------

function makeContext(strict) {
  const issues = [];
  const add = (path, code, message, severity) => {
    issues.push({ path, code, message, severity });
  };
  return {
    strict,
    issues,
    issue(path, code, message, options = {}) {
      const severity = options.severity ?? (strict ? 'error' : 'warning');
      add(path, code, message, severity);
    },
    missing(path) {
      add(path, PROFILE_ERROR.MISSING_SECTION, path + ' is missing', strict ? 'error' : 'warning');
    },
    unknown(path) {
      add(path, PROFILE_ERROR.UNKNOWN_FIELD, path + ' is not part of this schema and was dropped', 'warning');
    },
    enum(path, value, allowed, fallback) {
      if (value === undefined) return fallback;
      if (!allowed.includes(value)) {
        add(path, PROFILE_ERROR.INVALID_ENUM,
          path + ' must be one of ' + allowed.join(', ') + ' (got ' + JSON.stringify(value) + ')',
          strict ? 'error' : 'warning');
        return fallback;
      }
      return value;
    },
    number(path, value, options = {}) {
      const { fallback, min, max, integer = false } = options;
      if (value === undefined) return fallback;
      if (!isFiniteNumber(value)) {
        add(path, PROFILE_ERROR.INVALID_NUMBER,
          path + ' must be a finite number (got ' + JSON.stringify(value) + ')',
          strict ? 'error' : 'warning');
        return fallback;
      }
      let number = value;
      if (integer && !Number.isInteger(number)) {
        add(path, PROFILE_ERROR.INVALID_NUMBER, path + ' must be an integer (got ' + number + ')',
          strict ? 'error' : 'warning');
        if (strict) return fallback;
        number = Math.round(number);
      }
      if (min !== undefined && number < min) {
        add(path, PROFILE_ERROR.INVALID_NUMBER, path + ' must be >= ' + min + ' (got ' + number + ')',
          strict ? 'error' : 'warning');
        if (strict) return fallback;
        number = min;
      }
      if (max !== undefined && number > max) {
        add(path, PROFILE_ERROR.INVALID_NUMBER, path + ' must be <= ' + max + ' (got ' + number + ')',
          strict ? 'error' : 'warning');
        if (strict) return fallback;
        number = max;
      }
      return number;
    },
    boolean(path, value, fallback) {
      if (value === undefined) return fallback;
      if (typeof value !== 'boolean') {
        add(path, PROFILE_ERROR.INVALID_BOOLEAN, path + ' must be a boolean', strict ? 'error' : 'warning');
        return fallback;
      }
      return value;
    },
    string(path, value, options = {}) {
      const { fallback = null, pattern = null, allowNull = false } = options;
      if (value === undefined || value === null) {
        if (allowNull) return null;
        if (value === null) {
          add(path, PROFILE_ERROR.INVALID_STRING, path + ' must be a string', strict ? 'error' : 'warning');
          return fallback;
        }
        return fallback;
      }
      if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
        add(path, PROFILE_ERROR.INVALID_STRING, path + ' must be a non-empty string', strict ? 'error' : 'warning');
        return fallback;
      }
      if (pattern && !pattern.test(value)) {
        add(path, PROFILE_ERROR.INVALID_STRING, path + ' has an unsupported format',
          strict ? 'error' : 'warning');
        return fallback;
      }
      return value;
    },
    slug(path, value, fallback = null) {
      if (value === undefined || value === null) return fallback;
      if (typeof value !== 'string' || !SLUG_RE.test(value)) {
        add(path, PROFILE_ERROR.INVALID_SLUG, path + ' must be a lowercase slug',
          strict ? 'error' : 'warning');
        return fallback;
      }
      return value;
    },
    date(path, value) {
      if (value === undefined || value === null || value === '') return null;
      if (typeof value !== 'string' || !ISO_RE.test(value)) {
        add(path, PROFILE_ERROR.INVALID_DATE, path + ' must be an ISO-8601 UTC string',
          strict ? 'error' : 'warning');
        return null;
      }
      const milliseconds = Date.parse(value);
      if (!Number.isFinite(milliseconds)) {
        add(path, PROFILE_ERROR.INVALID_DATE, path + ' is not a valid date',
          strict ? 'error' : 'warning');
        return null;
      }
      return new Date(milliseconds).toISOString();
    }
  };
}

function normalizeSettings(value, ctx) {
  const out = defaultProfile().settings;
  if (value === undefined) { ctx.missing('settings'); return out; }
  if (!isPlainObject(value)) {
    ctx.issue('settings', PROFILE_ERROR.INVALID_SECTION, 'settings must be an object');
    return out;
  }
  for (const key of Object.keys(value)) if (!SETTINGS_KEYS.has(key)) ctx.unknown('settings.' + key);

  out.quality = ctx.enum('settings.quality', value.quality, QUALITY_LEVELS, out.quality);
  out.muted = ctx.boolean('settings.muted', value.muted, out.muted);
  out.cameraMode = ctx.enum('settings.cameraMode', value.cameraMode, CAMERA_MODES, out.cameraMode);
  out.steer = ctx.enum('settings.steer', value.steer, STEER_MODES, out.steer);
  out.inputBindingsRef = ctx.string('settings.inputBindingsRef', value.inputBindingsRef, {
    fallback: out.inputBindingsRef,
    pattern: BINDING_RE
  });

  const volumes = value.volumes;
  if (volumes !== undefined) {
    if (!isPlainObject(volumes)) {
      ctx.issue('settings.volumes', PROFILE_ERROR.INVALID_SECTION, 'settings.volumes must be an object');
    } else {
      for (const key of Object.keys(volumes)) if (!VOLUME_KEYS.has(key)) ctx.unknown('settings.volumes.' + key);
      for (const key of VOLUME_KEYS) {
        const fallback = out.volumes[key];
        const number = ctx.number('settings.volumes.' + key, volumes[key], { fallback, min: 0, max: 1 });
        out.volumes[key] = round3(number);
      }
    }
  }

  const hud = value.hud;
  if (hud !== undefined) {
    if (!isPlainObject(hud)) {
      ctx.issue('settings.hud', PROFILE_ERROR.INVALID_SECTION, 'settings.hud must be an object');
    } else {
      for (const key of Object.keys(hud)) if (!HUD_KEYS.has(key)) ctx.unknown('settings.hud.' + key);
      for (const key of ['showSpeed', 'showGhostDelta', 'showMinimap']) {
        out.hud[key] = ctx.boolean('settings.hud.' + key, hud[key], out.hud[key]);
      }
      out.hud.units = ctx.enum('settings.hud.units', hud.units, HUD_UNITS, out.hud.units);
    }
  }

  return out;
}

function normalizeProgress(value, ctx) {
  const out = defaultProfile().progress;
  if (value === undefined) { ctx.missing('progress'); return out; }
  if (!isPlainObject(value)) {
    ctx.issue('progress', PROFILE_ERROR.INVALID_SECTION, 'progress must be an object');
    return out;
  }
  for (const key of Object.keys(value)) if (!PROGRESS_KEYS.has(key)) ctx.unknown('progress.' + key);
  out.lastCar = ctx.slug('progress.lastCar', value.lastCar, null);
  out.lastMap = ctx.slug('progress.lastMap', value.lastMap, null);
  out.lastCourse = ctx.slug('progress.lastCourse', value.lastCourse, null);
  out.lastMode = ctx.enum('progress.lastMode', value.lastMode, PROGRESS_MODES, out.lastMode);
  return out;
}

function normalizeLapSplits(value, ctx, path) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    ctx.issue(path, PROFILE_ERROR.INVALID_NUMBER, path + ' must be an array of lap times');
    return [];
  }
  const out = [];
  for (const [index, split] of value.slice(0, PROFILE_MAX_LAP_SPLITS).entries()) {
    if (!isFiniteNumber(split) || split <= 0 || split > PROFILE_MAX_SECONDS) {
      ctx.issue(path + '[' + index + ']', PROFILE_ERROR.INVALID_NUMBER,
        'lap split must be a positive number of seconds');
      continue;
    }
    out.push(round3(split));
  }
  if (value.length > PROFILE_MAX_LAP_SPLITS) {
    ctx.issue(path, PROFILE_ERROR.INVALID_NUMBER,
      'only the first ' + PROFILE_MAX_LAP_SPLITS + ' lap splits are stored');
  }
  return out;
}

function normalizeGhostReference(value, ctx, path) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    ctx.issue(path, PROFILE_ERROR.INVALID_GHOST_REFERENCE, path + ' must be an object or null');
    return null;
  }
  for (const key of Object.keys(value)) if (!GHOST_REF_KEYS.has(key)) ctx.unknown(path + '.' + key);

  const source = ctx.enum(path + '.source', value.source, GHOST_SOURCES, 'reference');
  const file = ctx.string(path + '.file', value.file, { fallback: null, pattern: SAFE_PATH_RE });
  const sha256 = ctx.string(path + '.sha256', value.sha256, { fallback: null, pattern: HASH_RE });
  const hash = ctx.string(path + '.hash', value.hash, { fallback: null, pattern: HASH_RE });
  const layoutHash = ctx.string(path + '.layoutHash', value.layoutHash, {
    fallback: null, pattern: HASH_RE, allowNull: true
  });
  const timeSeconds = ctx.number(path + '.timeSeconds', value.timeSeconds, {
    fallback: null, min: 0.001, max: PROFILE_MAX_SECONDS
  });
  const finishTick = ctx.number(path + '.finishTick', value.finishTick, {
    fallback: null, min: 0, max: 10_000_000, integer: true
  });
  const tickCount = ctx.number(path + '.tickCount', value.tickCount, {
    fallback: null, min: 1, max: 10_000_001, integer: true
  });

  if (file === null || file.split('/').includes('..')) {
    ctx.issue(path + '.file', PROFILE_ERROR.INVALID_GHOST_REFERENCE, path + '.file must be a safe relative path');
    return null;
  }
  if (sha256 === null || hash === null || timeSeconds === null || finishTick === null || tickCount === null) {
    ctx.issue(path, PROFILE_ERROR.INVALID_GHOST_REFERENCE, path + ' is missing a required ghost field');
    return null;
  }
  if (finishTick >= tickCount) {
    ctx.issue(path, PROFILE_ERROR.INVALID_GHOST_REFERENCE,
      path + '.finishTick must be below tickCount');
    return null;
  }

  let storageKey = null;
  if (value.storageKey !== undefined && value.storageKey !== null) {
    storageKey = ctx.string(path + '.storageKey', value.storageKey, {
      fallback: null, pattern: /^[A-Za-z0-9._-]+$/
    });
  }
  let indexUrl = null;
  if (value.indexUrl !== undefined && value.indexUrl !== null) {
    indexUrl = ctx.string(path + '.indexUrl', value.indexUrl, {
      fallback: null, pattern: SAFE_PATH_RE
    });
  }

  return {
    source,
    storageKey,
    indexUrl,
    file,
    sha256,
    hash,
    layoutHash,
    timeSeconds: round3(timeSeconds),
    finishTick,
    tickCount
  };
}

function normalizeRecord(value, expectedKey, ctx) {
  const path = 'records.' + expectedKey;
  if (!isPlainObject(value)) {
    ctx.issue(path, PROFILE_ERROR.INVALID_RECORD, 'record must be an object');
    return null;
  }
  for (const key of Object.keys(value)) if (!RECORD_KEYS.has(key)) ctx.unknown(path + '.' + key);

  const map = ctx.slug(path + '.map', value.map, null);
  const course = ctx.slug(path + '.course', value.course, null);
  const mode = ctx.enum(path + '.mode', value.mode, RECORD_MODES, null);
  const car = ctx.slug(path + '.car', value.car, null);
  if (map === null || course === null || mode === null || car === null) return null;

  const rawBestTime = value.bestTimeSeconds;
  if (!isFiniteNumber(rawBestTime) || rawBestTime <= 0 || rawBestTime > PROFILE_MAX_SECONDS) {
    ctx.issue(path + '.bestTimeSeconds', PROFILE_ERROR.INVALID_NUMBER,
      'bestTimeSeconds must be a positive number of seconds');
    return null;
  }
  const bestTimeSeconds = round3(rawBestTime);

  let bestLapSeconds = null;
  if (value.bestLapSeconds !== undefined && value.bestLapSeconds !== null) {
    const rawBestLap = value.bestLapSeconds;
    if (!isFiniteNumber(rawBestLap) || rawBestLap <= 0 || rawBestLap > PROFILE_MAX_SECONDS) {
      ctx.issue(path + '.bestLapSeconds', PROFILE_ERROR.INVALID_NUMBER,
        'bestLapSeconds must be a positive number of seconds');
    } else if (rawBestLap > rawBestTime) {
      ctx.issue(path + '.bestLapSeconds', PROFILE_ERROR.INVALID_RECORD,
        'best lap is slower than the total time and was dropped');
    } else {
      bestLapSeconds = round3(rawBestLap);
    }
  }

  const lapSplits = normalizeLapSplits(value.lapSplits, ctx, path + '.lapSplits');
  const ghost = normalizeGhostReference(value.ghost, ctx, path + '.ghost');
  const date = ctx.date(path + '.date', value.date);
  const lastDate = ctx.date(path + '.lastDate', value.lastDate) ?? date;
  const lastTimeSeconds = ctx.number(path + '.lastTimeSeconds', value.lastTimeSeconds, {
    fallback: bestTimeSeconds, min: 0.001, max: PROFILE_MAX_SECONDS
  }) ?? bestTimeSeconds;
  const runs = ctx.number(path + '.runs', value.runs, {
    fallback: 1, min: 1, max: 1_000_000, integer: true
  }) ?? 1;

  const record = {
    map,
    course,
    mode,
    car,
    bestTimeSeconds: round3(bestTimeSeconds),
    bestLapSeconds: bestLapSeconds === null ? null : round3(bestLapSeconds),
    lapSplits,
    ghost,
    date,
    lastTimeSeconds: round3(lastTimeSeconds),
    lastDate,
    runs
  };
  const computed = recordKey(record);
  if (expectedKey !== computed) {
    ctx.issue(path, PROFILE_ERROR.INVALID_RECORD_KEY,
      'stored key ' + expectedKey + ' does not match its fields; the record was re-keyed as ' + computed);
  }
  return record;
}

function normalizeRecords(value, ctx) {
  const out = {};
  if (value === undefined) { ctx.missing('records'); return out; }
  if (!isPlainObject(value)) {
    ctx.issue('records', PROFILE_ERROR.INVALID_SECTION, 'records must be an object');
    return out;
  }
  const keys = Object.keys(value);
  if (keys.length > PROFILE_MAX_RECORDS) {
    ctx.issue('records', PROFILE_ERROR.INVALID_SECTION,
      'only the first ' + PROFILE_MAX_RECORDS + ' records are stored');
  }
  for (const key of keys.slice(0, PROFILE_MAX_RECORDS)) {
    if (isReserved(key)) {
      ctx.issue('records.' + key, PROFILE_ERROR.RESERVED_KEY, 'reserved record key was dropped');
      continue;
    }
    const record = normalizeRecord(value[key], key, ctx);
    if (record) out[recordKey(record)] = record;
  }
  return out;
}

function normalizeStats(value, ctx) {
  const out = { races: 0, wins: 0 };
  if (value === undefined) { ctx.missing('stats'); return out; }
  if (!isPlainObject(value)) {
    ctx.issue('stats', PROFILE_ERROR.INVALID_SECTION, 'stats must be an object');
    return out;
  }
  for (const key of Object.keys(value)) if (key !== 'races' && key !== 'wins') ctx.unknown('stats.' + key);
  out.races = ctx.number('stats.races', value.races, { fallback: 0, min: 0, max: 1_000_000, integer: true }) ?? 0;
  out.wins = ctx.number('stats.wins', value.wins, { fallback: 0, min: 0, max: 1_000_000, integer: true }) ?? 0;
  if (out.wins > out.races) {
    ctx.issue('stats.wins', PROFILE_ERROR.INVALID_NUMBER, 'wins cannot exceed races; wins was clamped');
    out.wins = out.races;
  }
  return out;
}

function normalizeMigration(value, ctx) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    ctx.issue('migration', PROFILE_ERROR.INVALID_SECTION, 'migration must be an object or null');
    return null;
  }
  const source = ctx.string('migration.source', value.source, {
    fallback: 'legacy-best-times', pattern: /^[a-z0-9-]+$/
  }) ?? 'legacy-best-times';
  const sources = Array.isArray(value.sources)
    ? value.sources.filter((entry) => typeof entry === 'string').slice(0, 32)
    : [];
  const migratedAt = ctx.number('migration.migratedAt', value.migratedAt, {
    fallback: 0, min: 0, max: 8_640_000_000_000
  }) ?? 0;
  const unmapped = ctx.number('migration.unmapped', value.unmapped, {
    fallback: 0, min: 0, max: 100_000, integer: true
  }) ?? 0;
  const assumptions = Array.isArray(value.assumptions)
    ? value.assumptions.filter((entry) => typeof entry === 'string').slice(0, 16)
    : [];
  return { source, sources, migratedAt, unmapped, assumptions };
}

function normalizeExtra(value, ctx) {
  const out = {};
  const copy = (key, entry, path) => {
    if (isReserved(key)) {
      ctx.issue(path, PROFILE_ERROR.RESERVED_KEY, 'reserved top-level key was dropped');
      return;
    }
    try {
      out[key] = JSON.parse(canonicalJson(entry));
    } catch (error) {
      ctx.issue(path, PROFILE_ERROR.INVALID_SECTION, 'unknown field was not JSON-safe: ' + error.message);
    }
  };
  if (value.extra !== undefined) {
    if (!isPlainObject(value.extra)) {
      ctx.issue('extra', PROFILE_ERROR.INVALID_SECTION, 'extra must be an object');
    } else {
      for (const [key, entry] of Object.entries(value.extra)) copy(key, entry, 'extra.' + key);
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    if (PROFILE_KEYS.has(key)) continue;
    copy(key, entry, key);
  }
  return out;
}

function normalizeProfileInternal(value, ctx) {
  const out = defaultProfile();
  if (!isPlainObject(value)) {
    ctx.issue('', PROFILE_ERROR.INVALID_ROOT, 'profile must be a JSON object', { severity: 'error' });
    return out;
  }

  if (value.kind !== PROFILE_KIND) {
    ctx.issue('kind', PROFILE_ERROR.INVALID_KIND,
      'kind must be ' + JSON.stringify(PROFILE_KIND) + ' (got ' + JSON.stringify(value.kind) + ')',
      { severity: 'error' });
  }
  if (value.schemaVersion === undefined) {
    ctx.issue('schemaVersion', PROFILE_ERROR.INVALID_SCHEMA_VERSION, 'schemaVersion is required',
      { severity: 'error' });
  } else if (!Number.isInteger(value.schemaVersion) || value.schemaVersion < 1) {
    ctx.issue('schemaVersion', PROFILE_ERROR.INVALID_SCHEMA_VERSION,
      'schemaVersion must be a positive integer', { severity: 'error' });
  } else if (value.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    ctx.issue('schemaVersion', PROFILE_ERROR.UNSUPPORTED_SCHEMA_VERSION,
      'schemaVersion ' + value.schemaVersion + ' is not ' + PROFILE_SCHEMA_VERSION, { severity: 'error' });
  }

  out.revision = ctx.number('revision', value.revision, {
    fallback: 0, min: 0, max: 1_000_000_000, integer: true
  }) ?? 0;
  out.updatedAt = ctx.number('updatedAt', value.updatedAt, {
    fallback: 0, min: 0, max: 8_640_000_000_000
  }) ?? 0;
  out.settings = normalizeSettings(value.settings, ctx);
  out.progress = normalizeProgress(value.progress, ctx);
  out.records = normalizeRecords(value.records, ctx);
  out.stats = normalizeStats(value.stats, ctx);
  out.migration = normalizeMigration(value.migration, ctx);
  out.extra = normalizeExtra(value, ctx);
  return out;
}

/**
 * Repair a profile. Invalid fields fall back to the documented defaults and
 * every repair is reported as an issue. `strict:true` reports errors instead
 * of silently repairing (used by validateProfile).
 */
export function normalizeProfile(value, options = {}) {
  const ctx = makeContext(Boolean(options.strict));
  const profile = normalizeProfileInternal(value, ctx);
  let changed = true;
  try {
    changed = canonicalJson(value) !== canonicalJson(profile);
  } catch {
    changed = true;
  }
  return {
    profile,
    issues: ctx.issues,
    changed,
    errors: ctx.issues.filter((entry) => entry.severity === 'error'),
    warnings: ctx.issues.filter((entry) => entry.severity === 'warning')
  };
}

/** Strict schema validation. Missing sections are errors; unknown fields warn. */
export function validateProfile(value) {
  const result = normalizeProfile(value, { strict: true });
  return {
    ok: result.errors.length === 0,
    errors: result.errors,
    warnings: result.warnings,
    profile: result.profile
  };
}

/** Validate and normalize one ghost reference. */
export function validateGhostReference(value) {
  const ctx = makeContext(true);
  const reference = normalizeGhostReference(value, ctx, 'ghost');
  const errors = ctx.issues.filter((entry) => entry.severity === 'error');
  return { ok: errors.length === 0 && reference !== null, errors, reference };
}

/**
 * Build the profile pointer for a committed `/ghosts/index.json` entry. The
 * reference stores hashes only; the ghost payload stays in the existing ghost
 * store / committed index and is verified by the consumer on load.
 */
export function ghostReferenceFromIndex(entry, options = {}) {
  const reference = {
    source: options.source ?? 'reference',
    storageKey: options.storageKey ?? null,
    indexUrl: options.indexUrl ?? GHOST_INDEX_URL,
    file: entry?.file,
    sha256: entry?.sha256,
    hash: entry?.ghostHash ?? entry?.hash,
    layoutHash: entry?.layoutHash ?? null,
    timeSeconds: entry?.timeSeconds,
    finishTick: entry?.finishTick,
    tickCount: entry?.tickCount
  };
  const check = validateGhostReference(reference);
  if (!check.ok) {
    throw new TypeError('ghost index entry is not a valid reference: ' +
      check.errors.map((error) => error.message).join('; '));
  }
  return check.reference;
}

// ---------------------------------------------------------------------------
// legacy migration
// ---------------------------------------------------------------------------

function safeGet(storage, key, errors = null) {
  try {
    const value = storage.getItem(key);
    return value === undefined ? null : value;
  } catch (error) {
    if (errors) {
      errors.push({
        key,
        reason: 'storage-error',
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return null;
  }
}

function parseLegacyCars(parsed) {
  if (!isPlainObject(parsed)) return null;
  if (isPlainObject(parsed.cars)) return parsed.cars;
  const values = Object.values(parsed);
  if (values.length > 0 && values.every((entry) =>
    isPlainObject(entry) || (isFiniteNumber(entry) && entry > 0))) {
    return parsed;
  }
  return null;
}

function legacyRecord(slug, value, spec, options = {}) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return null;
  if (!RECORD_MODES.includes(options.mode ?? spec.mode)) return null;
  let seconds;
  let car = slug;
  let bestLapSeconds = null;
  let lapSplits = [];
  let runs = 1;
  if (isFiniteNumber(value)) {
    seconds = value;
  } else if (isPlainObject(value)) {
    seconds = value.seconds;
    if (typeof value.car === 'string' && value.car) car = value.car;
    bestLapSeconds = value.bestLapSeconds ?? value.bestLap ?? null;
    lapSplits = value.lapTimes ?? value.lapSplits ?? [];
    if (Number.isInteger(value.runs) && value.runs > 0) runs = value.runs;
  } else {
    return null;
  }
  if (!isFiniteNumber(seconds) || seconds <= 0 || seconds > PROFILE_MAX_SECONDS) return null;
  if (bestLapSeconds !== null) {
    if (!isFiniteNumber(bestLapSeconds) || bestLapSeconds <= 0 || bestLapSeconds > seconds) bestLapSeconds = null;
    else bestLapSeconds = round3(bestLapSeconds);
  }
  if (!Array.isArray(lapSplits)) lapSplits = [];
  const splits = lapSplits
    .filter((entry) => isFiniteNumber(entry) && entry > 0 && entry <= PROFILE_MAX_SECONDS)
    .slice(0, PROFILE_MAX_LAP_SPLITS)
    .map(round3);
  return {
    map: options.map ?? spec.map,
    course: options.course ?? spec.course,
    mode: options.mode ?? spec.mode,
    car: slug,
    bestTimeSeconds: round3(seconds),
    bestLapSeconds,
    lapSplits: splits,
    ghost: null,
    date: null,
    lastTimeSeconds: round3(seconds),
    lastDate: null,
    runs
  };
}

function addMigratedRecord(profile, record) {
  const key = recordKey(record);
  const previous = profile.records[key];
  if (!previous || record.bestTimeSeconds < previous.bestTimeSeconds) {
    profile.records[key] = record;
    return true;
  }
  if (record.bestTimeSeconds === previous.bestTimeSeconds && record.runs > previous.runs) {
    previous.runs = record.runs;
  }
  return false;
}

/**
 * Read the known legacy best-time keys into a profile. The legacy keys are not
 * deleted. `bestTime` without a car cannot be attributed and is reported as
 * unmapped instead of being assigned to a guessed car.
 */
export function migrateLegacy(storage, options = {}) {
  const profile = defaultProfile();
  const sources = [];
  const unmapped = [];
  const assumptions = [];
  let records = 0;
  if (!storage || typeof storage.getItem !== 'function') {
    return { profile: null, sources, records, unmapped, assumptions, changed: false };
  }

  for (const spec of LEGACY_BEST_KEYS) {
    const raw = safeGet(storage, spec.key, unmapped);
    if (raw === null || raw === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      unmapped.push({ key: spec.key, reason: 'corrupt-json', message: error.message });
      continue;
    }
    const cars = parseLegacyCars(parsed);
    if (!cars) {
      unmapped.push({ key: spec.key, reason: 'unsupported-shape' });
      continue;
    }
    let count = 0;
    for (const [slug, value] of Object.entries(cars)) {
      const record = legacyRecord(slug, value, spec);
      if (!record) {
        unmapped.push({ key: spec.key, car: slug, reason: 'invalid-record' });
        continue;
      }
      if (addMigratedRecord(profile, record)) count += 1;
    }
    if (count > 0) {
      sources.push({ key: spec.key, records: count });
      records += count;
    }
  }

  const rawBestTime = safeGet(storage, LEGACY_BEST_TIME_KEY, unmapped);
  if (rawBestTime !== null && rawBestTime !== '') {
    let parsed;
    try {
      parsed = JSON.parse(rawBestTime);
    } catch {
      const numeric = Number(rawBestTime);
      parsed = Number.isFinite(numeric) ? numeric : undefined;
    }
    if (isFiniteNumber(parsed)) {
      unmapped.push({ key: LEGACY_BEST_TIME_KEY, reason: 'no-car-attribution' });
    } else if (isPlainObject(parsed) && isPlainObject(parsed.cars)) {
      let count = 0;
      for (const [slug, value] of Object.entries(parsed.cars)) {
        const record = legacyRecord(slug, value, { map: 'river', course: '310m', mode: 'sprint' });
        if (!record) {
          unmapped.push({ key: LEGACY_BEST_TIME_KEY, car: slug, reason: 'invalid-record' });
          continue;
        }
        if (addMigratedRecord(profile, record)) count += 1;
      }
      if (count > 0) {
        sources.push({ key: LEGACY_BEST_TIME_KEY, records: count });
        records += count;
      }
    } else if (isPlainObject(parsed) && typeof parsed.car === 'string') {
      const map = typeof parsed.map === 'string' ? parsed.map : 'river';
      const course = typeof parsed.course === 'string' ? parsed.course : '310m';
      const mode = typeof parsed.mode === 'string' ? parsed.mode : 'sprint';
      if (map === 'river' && course === '310m' && mode === 'sprint' && !parsed.map && !parsed.course && !parsed.mode) {
        assumptions.push('bestTime without map/course/mode mapped to river/310m/sprint');
      }
      const record = legacyRecord(parsed.car, parsed, { map, course, mode });
      if (!record) {
        unmapped.push({ key: LEGACY_BEST_TIME_KEY, reason: 'invalid-record' });
      } else if (addMigratedRecord(profile, record)) {
        sources.push({ key: LEGACY_BEST_TIME_KEY, records: 1 });
        records += 1;
      }
    } else {
      unmapped.push({ key: LEGACY_BEST_TIME_KEY, reason: 'unsupported-shape' });
    }
  }

  if (sources.length === 0 && unmapped.length === 0) {
    return { profile: null, sources, records, unmapped, assumptions, changed: false };
  }
  profile.migration = {
    source: 'legacy-best-times',
    sources: sources.map((entry) => entry.key),
    migratedAt: options.now ?? 0,
    unmapped: unmapped.length,
    assumptions
  };
  return { profile, sources, records, unmapped, assumptions, changed: true };
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

function hasStorage(storage) {
  return Boolean(storage &&
    typeof storage.getItem === 'function' &&
    typeof storage.setItem === 'function');
}

function cloneProfile(profile) {
  return JSON.parse(canonicalJson(profile));
}

function sameContent(left, right) {
  if (!left || !right) return false;
  const strip = (profile) => {
    const copy = cloneProfile(profile);
    copy.revision = 0;
    copy.updatedAt = 0;
    return copy;
  };
  try {
    return canonicalJson(strip(left)) === canonicalJson(strip(right));
  } catch {
    return false;
  }
}

function laterIso(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  return left >= right ? left : right;
}

function pickBetterRecord(left, right) {
  const base = right.bestTimeSeconds < left.bestTimeSeconds ? right : left;
  const other = base === right ? left : right;
  const picked = cloneProfile(base);
  picked.runs = Math.max(left.runs ?? 1, right.runs ?? 1);
  picked.lastTimeSeconds = other.lastTimeSeconds ?? picked.lastTimeSeconds;
  picked.lastDate = laterIso(left.lastDate ?? null, right.lastDate ?? null);
  return picked;
}

/**
 * Merge two profiles after a concurrent-tab conflict. Settings, progress and
 * extra fields are last-write-wins (incoming); records keep the faster time;
 * stats keep the maximum.
 */
export function mergeProfiles(stored, incoming) {
  const out = cloneProfile(incoming);
  out.records = {};
  for (const [key, record] of Object.entries(stored?.records ?? {})) {
    out.records[key] = cloneProfile(record);
  }
  for (const [key, record] of Object.entries(incoming?.records ?? {})) {
    const previous = out.records[key];
    out.records[key] = previous ? pickBetterRecord(previous, record) : cloneProfile(record);
  }
  out.stats = {
    races: Math.max(stored?.stats?.races ?? 0, incoming?.stats?.races ?? 0),
    wins: Math.max(stored?.stats?.wins ?? 0, incoming?.stats?.wins ?? 0)
  };
  out.stats.wins = Math.min(out.stats.wins, out.stats.races);
  out.settings = cloneProfile(incoming.settings);
  out.progress = cloneProfile(incoming.progress);
  out.extra = { ...(stored?.extra ?? {}), ...(incoming?.extra ?? {}) };
  out.migration = incoming.migration ?? stored?.migration ?? null;
  return out;
}

function isoFrom(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function storageError(error) {
  return error instanceof Error ? error.message : String(error);
}

function dateFromNow(now) {
  const value = typeof now === 'function' ? now() : now;
  return isoFrom(isFiniteNumber(value) && value >= 0 ? value : 0);
}

function normalizeResultSplits(value, path) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(path + ' must be an array of lap times');
  const out = [];
  for (const entry of value) {
    if (!isFiniteNumber(entry) || entry <= 0 || entry > PROFILE_MAX_SECONDS) {
      throw new TypeError(path + ' entries must be positive seconds');
    }
    out.push(round3(entry));
  }
  if (out.length > PROFILE_MAX_LAP_SPLITS) {
    throw new TypeError(path + ' has more than ' + PROFILE_MAX_LAP_SPLITS + ' entries');
  }
  return out;
}

/**
 * Create a profile store bound to one storage object and namespace.
 *
 * `storage` is any object with getItem/setItem (removeItem is optional). The
 * module never reads a browser global; callers pass window.localStorage inside
 * their own try/catch or a memory shim for tests/private mode.
 */
export function createProfileStore(options = {}) {
  const storage = options.storage ?? null;
  const namespace = options.namespace ?? null;
  const key = profileStorageKey(namespace);
  const backupKey = profileBackupKey(namespace);
  const now = options.now ?? (() => Date.now());

  let persistent = hasStorage(storage);
  let readOnly = false;
  let readOnlyReason = null;
  let lastError = null;
  let current = null;
  let dirty = false;

  function clock() {
    const value = typeof now === 'function' ? now() : now;
    return isFiniteNumber(value) && value >= 0 ? value : 0;
  }

  function readRaw() {
    if (!persistent) return { ok: true, value: null };
    try {
      const value = storage.getItem(key);
      return { ok: true, value: value === undefined ? null : value };
    } catch (error) {
      lastError = storageError(error);
      persistent = false;
      return { ok: false, error: lastError };
    }
  }

  function removeKey(target) {
    if (!persistent) return false;
    try {
      const existing = storage.getItem(target);
      if (existing === null || existing === undefined || existing === '') return false;
      if (typeof storage.removeItem === 'function') storage.removeItem(target);
      else storage.setItem(target, '');
      return true;
    } catch (error) {
      lastError = storageError(error);
      return false;
    }
  }

  function backupRaw(raw, reason) {
    if (!persistent) return { key: null, error: 'storage-unavailable' };
    let payload;
    try {
      payload = canonicalJson({
        kind: 'blur.profile.backup',
        version: 1,
        reason,
        savedAt: clock(),
        raw
      });
    } catch (error) {
      return { key: null, error: storageError(error) };
    }
    for (let slot = 0; slot < PROFILE_BACKUP_MAX; slot += 1) {
      const target = slot === 0 ? backupKey : backupKey + '.' + slot;
      let existing;
      try {
        existing = storage.getItem(target);
      } catch (error) {
        lastError = storageError(error);
        return { key: null, error: lastError };
      }
      if (existing !== null && existing !== undefined && existing !== '') continue;
      try {
        storage.setItem(target, payload);
        return { key: target, error: null };
      } catch (error) {
        lastError = storageError(error);
        return { key: null, error: lastError };
      }
    }
    return { key: null, error: 'backup-slots-full' };
  }

  function writeRaw(raw) {
    if (!persistent) return { ok: true, persisted: false, freedBackup: null, quota: false };
    try {
      storage.setItem(key, raw);
      return { ok: true, persisted: true, freedBackup: null, quota: false };
    } catch (error) {
      lastError = storageError(error);
      if (!isQuotaError(error)) {
        persistent = false;
        return { ok: false, persisted: false, freedBackup: null, quota: false, error: lastError };
      }
      for (let slot = 0; slot < PROFILE_BACKUP_MAX; slot += 1) {
        const target = slot === 0 ? backupKey : backupKey + '.' + slot;
        if (!removeKey(target)) continue;
        try {
          storage.setItem(key, raw);
          return { ok: true, persisted: true, freedBackup: target, quota: true };
        } catch (retryError) {
          lastError = storageError(retryError);
          if (!isQuotaError(retryError)) break;
        }
      }
      return { ok: false, persisted: false, freedBackup: null, quota: true, error: lastError };
    }
  }

  function parseStored(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { status: 'corrupt-json', error: error.message, raw };
    }
    if (!isPlainObject(parsed)) {
      return { status: 'invalid-schema', error: 'profile root is not an object', raw };
    }
    if (parsed.kind !== PROFILE_KIND) {
      return { status: 'invalid-schema', error: 'profile kind is not ' + PROFILE_KIND, raw };
    }
    if (!Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion < 1) {
      return { status: 'invalid-schema', error: 'schemaVersion is not a positive integer', raw };
    }
    if (parsed.schemaVersion > PROFILE_SCHEMA_VERSION) {
      return { status: 'future-schema', schemaVersion: parsed.schemaVersion, raw };
    }
    const normalized = normalizeProfile(parsed, { now: clock() });
    const sectionInvalid = normalized.issues.some((entry) =>
      entry.code === PROFILE_ERROR.INVALID_SECTION &&
      ['settings', 'progress', 'records', 'stats'].includes(entry.path));
    if (normalized.errors.length > 0 || sectionInvalid) {
      return {
        status: 'invalid-schema',
        error: (normalized.errors[0] ?? normalized.issues.find((entry) => entry.code === PROFILE_ERROR.INVALID_SECTION))?.message,
        raw
      };
    }
    return {
      status: 'ok',
      profile: normalized.profile,
      repaired: normalized.changed || normalized.issues.length > 0,
      issues: normalized.issues,
      raw
    };
  }

  function recover(raw, reason) {
    const backup = backupRaw(raw, reason);
    if (!backup.key) {
      return {
        ok: true,
        code: reason,
        profile: defaultProfile(),
        revision: 0,
        persisted: false,
        readOnly: true,
        backupKey: null,
        backupError: backup.error,
        reset: false,
        issues: [],
        migration: null,
        error: 'could not back up the damaged profile: ' + backup.error
      };
    }
    const fresh = defaultProfile();
    fresh.updatedAt = clock();
    const write = writeRaw(serializeProfile(fresh));
    if (write.ok) {
      current = fresh;
      dirty = false;
      readOnly = false;
      return {
        ok: true,
        code: reason,
        profile: fresh,
        revision: fresh.revision,
        persisted: write.persisted,
        readOnly: false,
        backupKey: backup.key,
        backupError: null,
        reset: write.persisted,
        issues: [],
        migration: null,
        error: null
      };
    }
    return {
      ok: true,
      code: reason,
      profile: fresh,
      revision: fresh.revision,
      persisted: false,
      readOnly: false,
      backupKey: backup.key,
      backupError: null,
      reset: false,
      issues: [],
      migration: null,
      error: write.error ?? null
    };
  }

  function emptyResult(code, profile, extra = {}) {
    return {
      ok: true,
      code,
      profile,
      revision: profile?.revision ?? 0,
      persisted: persistent,
      readOnly,
      backupKey: null,
      backupError: null,
      reset: false,
      issues: [],
      migration: null,
      error: null,
      ...extra
    };
  }

  function load() {
    if (!persistent) {
      const profile = current ?? defaultProfile();
      return emptyResult(PROFILE_ERROR.STORAGE_UNAVAILABLE, profile, {
        persisted: false,
        error: lastError
      });
    }
    if (dirty && current) {
      return emptyResult('loaded-memory', current, { persisted: false });
    }

    const raw = readRaw();
    if (!raw.ok) {
      const profile = current ?? defaultProfile();
      return emptyResult(PROFILE_ERROR.STORAGE_UNAVAILABLE, profile, {
        persisted: false,
        error: raw.error
      });
    }
    if (raw.value === null || raw.value === '') {
      const migration = namespace === null
        ? migrateLegacy(storage, { now: clock() })
        : { profile: null, sources: [], records: 0, unmapped: [], assumptions: [], changed: false };
      if (migration.profile) {
        migration.profile.updatedAt = clock();
        const write = writeRaw(serializeProfile(migration.profile));
        current = migration.profile;
        return emptyResult('migrated', migration.profile, {
          persisted: write.persisted,
          migration: {
            sources: migration.sources,
            records: migration.records,
            unmapped: migration.unmapped,
            assumptions: migration.assumptions
          },
          error: write.error ?? null
        });
      }
      const profile = defaultProfile();
      current = profile;
      return emptyResult('fresh', profile, {
        persisted: true,
        migration: namespace === null ? null : { sources: [], records: 0, unmapped: [], assumptions: [], skipped: 'namespaced-profile' }
      });
    }

    const parsed = parseStored(raw.value);
    if (parsed.status === 'future-schema') {
      readOnly = true;
      readOnlyReason = 'profile schemaVersion ' + parsed.schemaVersion +
        ' is newer than this build (' + PROFILE_SCHEMA_VERSION + ')';
      return {
        ok: false,
        code: PROFILE_ERROR.FUTURE_SCHEMA,
        profile: null,
        revision: 0,
        persisted: true,
        readOnly: true,
        backupKey: null,
        backupError: null,
        reset: false,
        issues: [],
        migration: null,
        error: readOnlyReason
      };
    }
    if (parsed.status === 'corrupt-json' || parsed.status === 'invalid-schema') {
      readOnly = false;
      const result = recover(raw.value, parsed.status === 'corrupt-json'
        ? PROFILE_ERROR.CORRUPT_JSON : PROFILE_ERROR.INVALID_SCHEMA);
      readOnly = result.readOnly;
      readOnlyReason = result.readOnly ? result.error : null;
      return result;
    }

    current = parsed.profile;
    dirty = false;
    readOnly = false;
    readOnlyReason = null;
    return emptyResult(parsed.repaired ? 'repaired' : 'loaded', parsed.profile, {
      persisted: true,
      issues: parsed.issues
    });
  }

  function ensureCurrent() {
    if (current) return current;
    const result = load();
    return result.profile;
  }

  function save(profile = null, options = {}) {
    const force = options.force === true;
    const strategy = options.strategy ?? 'merge';
    if (readOnly && !force) {
      return {
        ok: false,
        code: PROFILE_ERROR.READ_ONLY,
        revision: current?.revision ?? 0,
        persisted: false,
        conflict: false,
        error: readOnlyReason ?? 'profile is read-only'
      };
    }
    const candidate = profile ?? ensureCurrent();
    if (!candidate) {
      return {
        ok: false,
        code: PROFILE_ERROR.READ_ONLY,
        revision: 0,
        persisted: false,
        conflict: false,
        error: readOnlyReason ?? 'no profile is loaded'
      };
    }
    const checked = validateProfile(candidate);
    if (!checked.ok) {
      return {
        ok: false,
        code: PROFILE_ERROR.INVALID_PROFILE,
        revision: candidate.revision ?? 0,
        persisted: false,
        conflict: false,
        errors: checked.errors,
        error: checked.errors[0]?.message ?? 'profile is invalid'
      };
    }

    if (!persistent) {
      const memory = cloneProfile(candidate);
      memory.revision = Math.max(candidate.revision ?? 0, current?.revision ?? 0) + 1;
      memory.updatedAt = clock();
      current = memory;
      dirty = true;
      return {
        ok: true,
        code: 'saved-memory',
        revision: memory.revision,
        persisted: false,
        conflict: false,
        freedBackup: null,
        profile: memory,
        error: lastError
      };
    }

    const storedRaw = readRaw();
    if (!storedRaw.ok) {
      return {
        ok: false,
        code: PROFILE_ERROR.STORAGE_UNAVAILABLE,
        revision: candidate.revision ?? 0,
        persisted: false,
        conflict: false,
        error: storedRaw.error
      };
    }

    let stored = null;
    let storedRevision = -1;
    if (storedRaw.value !== null && storedRaw.value !== '') {
      const parsed = parseStored(storedRaw.value);
      if (parsed.status === 'future-schema') {
        if (!force) {
          readOnly = true;
          readOnlyReason = 'refusing to overwrite a newer profile schema';
          return {
            ok: false,
            code: PROFILE_ERROR.FUTURE_SCHEMA,
            revision: 0,
            persisted: false,
            conflict: false,
            error: readOnlyReason
          };
        }
        const backup = backupRaw(storedRaw.value, 'forced-schema-downgrade');
        if (!backup.key) {
          return {
            ok: false,
            code: PROFILE_ERROR.BACKUP_FAILED,
            revision: 0,
            persisted: false,
            conflict: false,
            error: 'newer profile could not be backed up before the forced save: ' + backup.error
          };
        }
        readOnly = false;
        readOnlyReason = null;
      } else if (parsed.status === 'corrupt-json' || parsed.status === 'invalid-schema') {
        const backup = backupRaw(storedRaw.value, parsed.status === 'corrupt-json'
          ? PROFILE_ERROR.CORRUPT_JSON : PROFILE_ERROR.INVALID_SCHEMA);
        if (!backup.key) {
          return {
            ok: false,
            code: PROFILE_ERROR.BACKUP_FAILED,
            revision: candidate.revision ?? 0,
            persisted: false,
            conflict: false,
            error: 'stored profile is damaged and could not be backed up: ' + backup.error
          };
        }
      } else {
        stored = parsed.profile;
        storedRevision = stored.revision;
      }
    }

    if (readOnly && !force) {
      return {
        ok: false,
        code: PROFILE_ERROR.READ_ONLY,
        revision: storedRevision >= 0 ? storedRevision : candidate.revision ?? 0,
        persisted: false,
        conflict: false,
        error: readOnlyReason ?? 'profile is read-only'
      };
    }
    if (readOnly && force && storedRaw.value !== null && storedRaw.value !== '') {
      const backup = backupRaw(storedRaw.value, 'forced-save');
      if (!backup.key) {
        return {
          ok: false,
          code: PROFILE_ERROR.BACKUP_FAILED,
          revision: storedRevision >= 0 ? storedRevision : 0,
          persisted: false,
          conflict: false,
          error: 'read-only profile could not be backed up before the forced save: ' + backup.error
        };
      }
      readOnly = false;
      readOnlyReason = null;
    }

    const baseRevision = options.baseRevision ?? candidate.revision ?? 0;
    const conflict = stored !== null && baseRevision !== storedRevision;
    if (stored && sameContent(candidate, stored) && baseRevision === storedRevision) {
      current = stored;
      dirty = false;
      return {
        ok: true,
        code: 'no-change',
        revision: storedRevision,
        persisted: true,
        conflict: false,
        freedBackup: null,
        profile: stored
      };
    }

    let merged;
    if (conflict && strategy === 'merge' && stored) {
      merged = mergeProfiles(stored, candidate);
    } else {
      merged = cloneProfile(candidate);
    }
    merged.revision = Math.max(storedRevision, candidate.revision ?? 0, current?.revision ?? 0, 0) + 1;
    merged.updatedAt = clock();
    const normalized = normalizeProfile(merged, { now: clock() });
    if (normalized.errors.length > 0) {
      return {
        ok: false,
        code: PROFILE_ERROR.INVALID_PROFILE,
        revision: merged.revision,
        persisted: false,
        conflict,
        errors: normalized.errors,
        error: normalized.errors[0].message
      };
    }
    merged = normalized.profile;

    const write = writeRaw(serializeProfile(merged));
    if (!write.ok) {
      current = merged;
      dirty = true;
      return {
        ok: false,
        code: write.quota ? PROFILE_ERROR.QUOTA_EXCEEDED : PROFILE_ERROR.STORAGE_UNAVAILABLE,
        revision: merged.revision,
        persisted: false,
        conflict,
        freedBackup: write.freedBackup,
        quota: write.quota,
        profile: merged,
        error: write.error
      };
    }
    current = merged;
    dirty = false;
    if (write.quota) lastError = 'quota exceeded; a backup slot was reclaimed';
    return {
      ok: true,
      code: conflict ? 'saved-merged' : 'saved',
      revision: merged.revision,
      persisted: true,
      conflict,
      freedBackup: write.freedBackup,
      quota: write.quota,
      profile: merged
    };
  }

  function updateSettings(patch) {
    if (!isPlainObject(patch)) {
      return { ok: false, code: PROFILE_ERROR.INVALID_SETTINGS, errors: [{ path: 'settings', message: 'patch must be an object' }] };
    }
    for (const key of Object.keys(patch)) {
      if (!SETTINGS_KEYS.has(key)) {
        return { ok: false, code: PROFILE_ERROR.INVALID_SETTINGS, errors: [{ path: 'settings.' + key, message: 'unknown setting' }] };
      }
    }
    if (patch.volumes !== undefined) {
      if (!isPlainObject(patch.volumes)) {
        return { ok: false, code: PROFILE_ERROR.INVALID_SETTINGS, errors: [{ path: 'settings.volumes', message: 'must be an object' }] };
      }
      for (const key of Object.keys(patch.volumes)) {
        if (!VOLUME_KEYS.has(key)) {
          return { ok: false, code: PROFILE_ERROR.INVALID_SETTINGS, errors: [{ path: 'settings.volumes.' + key, message: 'unknown volume' }] };
        }
      }
    }
    if (patch.hud !== undefined) {
      if (!isPlainObject(patch.hud)) {
        return { ok: false, code: PROFILE_ERROR.INVALID_SETTINGS, errors: [{ path: 'settings.hud', message: 'must be an object' }] };
      }
      for (const key of Object.keys(patch.hud)) {
        if (!HUD_KEYS.has(key)) {
          return { ok: false, code: PROFILE_ERROR.INVALID_SETTINGS, errors: [{ path: 'settings.hud.' + key, message: 'unknown HUD option' }] };
        }
      }
    }
    const base = ensureCurrent();
    if (!base) {
      return {
        ok: false,
        code: PROFILE_ERROR.READ_ONLY,
        revision: 0,
        persisted: false,
        conflict: false,
        error: readOnlyReason ?? 'no profile is loaded'
      };
    }
    const candidate = cloneProfile(base);
    candidate.settings = {
      ...candidate.settings,
      ...patch,
      volumes: { ...candidate.settings.volumes, ...(patch.volumes ?? {}) },
      hud: { ...candidate.settings.hud, ...(patch.hud ?? {}) }
    };
    const checked = validateProfile(candidate);
    if (!checked.ok) {
      return {
        ok: false,
        code: PROFILE_ERROR.INVALID_SETTINGS,
        errors: checked.errors.filter((entry) => entry.path.startsWith('settings'))
      };
    }
    return save(candidate);
  }

  function setProgress(patch) {
    if (!isPlainObject(patch)) {
      return { ok: false, code: PROFILE_ERROR.INVALID_PROGRESS, errors: [{ path: 'progress', message: 'patch must be an object' }] };
    }
    for (const key of Object.keys(patch)) {
      if (!PROGRESS_KEYS.has(key)) {
        return { ok: false, code: PROFILE_ERROR.INVALID_PROGRESS, errors: [{ path: 'progress.' + key, message: 'unknown progress field' }] };
      }
    }
    const base = ensureCurrent();
    if (!base) {
      return {
        ok: false,
        code: PROFILE_ERROR.READ_ONLY,
        errors: [{ path: 'progress', message: readOnlyReason ?? 'no profile is loaded' }]
      };
    }
    const candidate = cloneProfile(base);
    candidate.progress = { ...candidate.progress, ...patch };
    const checked = validateProfile(candidate);
    if (!checked.ok) {
      return {
        ok: false,
        code: PROFILE_ERROR.INVALID_PROGRESS,
        errors: checked.errors.filter((entry) => entry.path.startsWith('progress'))
      };
    }
    return save(candidate);
  }

  function submitResult(result) {
    if (!isPlainObject(result)) throw new TypeError('submitResult needs a result object');
    const map = result.map;
    const course = result.course;
    const mode = result.mode ?? 'sprint';
    const car = result.car;
    if (typeof map !== 'string' || !SLUG_RE.test(map)) throw new TypeError('result.map must be a slug');
    if (typeof course !== 'string' || !SLUG_RE.test(course)) throw new TypeError('result.course must be a slug');
    if (typeof car !== 'string' || !SLUG_RE.test(car)) throw new TypeError('result.car must be a slug');
    if (!PROGRESS_MODES.includes(mode)) throw new TypeError('result.mode must be one of ' + PROGRESS_MODES.join(', '));
    if (!isFiniteNumber(result.timeSeconds) || result.timeSeconds <= 0 || result.timeSeconds > PROFILE_MAX_SECONDS) {
      throw new TypeError('result.timeSeconds must be a positive number of seconds');
    }
    const online = result.online === true || mode === 'multiplayer';
    if (!online && !RECORD_MODES.includes(mode)) {
      throw new TypeError('solo records only exist for ' + RECORD_MODES.join(' and ') + ' (got ' + mode + ')');
    }
    const bestLapSeconds = result.bestLapSeconds === undefined || result.bestLapSeconds === null
      ? null
      : result.bestLapSeconds;
    if (bestLapSeconds !== null &&
        (!isFiniteNumber(bestLapSeconds) || bestLapSeconds <= 0 || bestLapSeconds > PROFILE_MAX_SECONDS)) {
      throw new TypeError('result.bestLapSeconds must be a positive number of seconds or null');
    }
    if (bestLapSeconds !== null && bestLapSeconds > result.timeSeconds) {
      throw new TypeError('result.bestLapSeconds cannot be slower than result.timeSeconds');
    }
    const lapSplits = normalizeResultSplits(result.lapTimes ?? result.lapSplits, 'result.lapTimes');
    let ghost = null;
    if (result.ghost !== undefined && result.ghost !== null) {
      const check = validateGhostReference(result.ghost);
      if (!check.ok) {
        throw new TypeError('result.ghost is not a valid ghost reference: ' +
          check.errors.map((entry) => entry.message).join('; '));
      }
      ghost = check.reference;
    }
    const date = result.date === undefined || result.date === null
      ? dateFromNow(now)
      : (() => {
        const ctx = makeContext(true);
        const normalized = ctx.date('result.date', result.date);
        if (ctx.issues.length > 0) throw new TypeError('result.date must be an ISO-8601 UTC string');
        return normalized;
      })();
    const win = result.win === undefined
      ? (result.position === 1)
      : result.win;
    if (typeof win !== 'boolean') throw new TypeError('result.win must be a boolean');

    const base = ensureCurrent();
    if (!base) {
      return {
        ok: false,
        code: PROFILE_ERROR.READ_ONLY,
        recorded: false,
        improved: false,
        record: null,
        stats: { races: 0, wins: 0 },
        revision: 0,
        persisted: false,
        conflict: false,
        quota: false,
        profile: null,
        error: readOnlyReason ?? 'no profile is loaded'
      };
    }
    const profile = cloneProfile(base);
    profile.stats.races += 1;
    if (win) profile.stats.wins += 1;
    profile.progress = {
      lastCar: car,
      lastMap: map,
      lastCourse: course,
      lastMode: online ? 'multiplayer' : mode
    };

    let record = null;
    let improved = false;
    if (!online) {
      const key = recordKey({ map, course, mode, car });
      const previous = profile.records[key] ?? null;
      const bestTimeSeconds = round3(result.timeSeconds);
      improved = previous === null || bestTimeSeconds < previous.bestTimeSeconds;
      const previousBestLap = previous?.bestLapSeconds ?? null;
      const bestLap = bestLapSeconds === null ? null : round3(bestLapSeconds);
      const bestLapImproves = bestLap !== null &&
        (previousBestLap === null || bestLap < previousBestLap);
      record = {
        map,
        course,
        mode,
        car,
        bestTimeSeconds: improved ? bestTimeSeconds : previous.bestTimeSeconds,
        bestLapSeconds: bestLapImproves ? bestLap : previousBestLap,
        lapSplits: improved ? lapSplits : previous.lapSplits,
        ghost: improved ? ghost : previous.ghost,
        date: improved ? date : previous.date,
        lastTimeSeconds: bestTimeSeconds,
        lastDate: date,
        runs: (previous?.runs ?? 0) + 1
      };
      profile.records[key] = record;
    }

    const saved = save(profile);
    return {
      ok: saved.ok,
      code: saved.code,
      recorded: !online,
      improved,
      record,
      stats: { ...profile.stats },
      revision: saved.revision,
      persisted: saved.persisted,
      conflict: saved.conflict,
      quota: saved.quota === true,
      profile: saved.profile ?? profile,
      error: saved.error ?? null
    };
  }

  function removeLegacyKeys() {
    const removed = [];
    if (namespace !== null) return removed;
    for (const spec of LEGACY_BEST_KEYS) if (removeKey(spec.key)) removed.push(spec.key);
    if (removeKey(LEGACY_BEST_TIME_KEY)) removed.push(LEGACY_BEST_TIME_KEY);
    return removed;
  }

  function reset(options = {}) {
    const force = options.force === true;
    const keepSettings = options.keepSettings === true;
    const keepStats = options.keepStats === true;
    const removeLegacy = options.removeLegacy !== false;
    const previous = ensureCurrent();
    if (readOnly && !force) {
      return {
        ok: false,
        code: PROFILE_ERROR.READ_ONLY,
        revision: previous?.revision ?? 0,
        persisted: false,
        removedLegacy: [],
        error: readOnlyReason ?? 'profile is read-only'
      };
    }
    const fresh = defaultProfile();
    if (keepSettings && previous) fresh.settings = cloneProfile(previous.settings);
    if (keepStats && previous) fresh.stats = cloneProfile(previous.stats);
    const saved = save(fresh, { strategy: 'replace', force: true });
    if (!saved.ok) {
      return {
        ok: false,
        code: saved.code,
        revision: saved.revision,
        persisted: false,
        removedLegacy: [],
        error: saved.error
      };
    }
    const removedLegacy = saved.persisted && removeLegacy ? removeLegacyKeys() : [];
    current = saved.profile;
    return {
      ok: true,
      code: 'reset',
      revision: saved.revision,
      persisted: saved.persisted,
      removedLegacy,
      profile: saved.profile,
      error: null
    };
  }

  function deleteRecord(target) {
    const key = recordKey(target ?? {});
    const base = ensureCurrent();
    if (!base) {
      return {
        ok: false,
        code: PROFILE_ERROR.READ_ONLY,
        revision: 0,
        persisted: false,
        deleted: false,
        error: readOnlyReason ?? 'no profile is loaded'
      };
    }
    const profile = cloneProfile(base);
    if (!(key in profile.records)) {
      return { ok: true, code: 'missing', revision: profile.revision, deleted: false, persisted: persistent };
    }
    delete profile.records[key];
    const saved = save(profile);
    return { ...saved, deleted: true };
  }

  return {
    key,
    backupKey,
    namespace,
    get persistent() { return persistent; },
    get readOnly() { return readOnly; },
    get readOnlyReason() { return readOnlyReason; },
    get lastError() { return lastError; },
    get revision() { return current?.revision ?? 0; },
    get profile() { return current; },
    load,
    save,
    get: ensureCurrent,
    updateSettings,
    setProgress,
    submitResult,
    reset,
    deleteRecord,
    removeLegacyKeys
  };
}
