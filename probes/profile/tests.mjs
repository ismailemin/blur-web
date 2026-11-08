// Profile store tests. Run:
//   node probes/profile/tests.mjs
//
// The suite uses only Node built-ins and an injected in-memory storage. It
// writes `_work/profile/tests.json` for the evidence record and exits non-zero
// on any failed case. Every assertion is counted manually so the recorded total
// is the number the suite actually executed.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './profile.mjs';

const FIXED_NOW = 1_735_689_600_000; // 2025-01-01T00:00:00.000Z
const FIXED_DATE = '2025-01-01T00:00:00.000Z';
const now = () => FIXED_NOW;

const GHOST_ENTRY = Object.freeze({
  slug: 'corvette-zr1-stock',
  course: '310m',
  file: 'probes/e1-drive/ghosts/corvette-zr1-stock-310m.json',
  bytes: 57731,
  sha256: 'sha256:29b8d9cb2109224570973bf2d22fd956986c4423acb3722928fa55b4a0828914',
  ghostHash: 'sha256:10a2e115a897a0c87eff30aba7d13944658ff2f9dd009f0f07c48178b35c9f1e',
  timeSeconds: 14.65,
  finishTick: 969,
  tickCount: 970,
  layoutHash: 'sha256:9240e9c136059ccd209992999b8570860f99f1bedd4b4ec9ff0a56d5cf8cad53'
});

let assertions = 0;
const cases = [];

function test(name, fn) {
  try {
    fn();
    cases.push({ name, ok: true });
  } catch (error) {
    cases.push({ name, ok: false, error: error.message, stack: error.stack });
  }
}

function ok(condition, message = 'assertion failed') {
  assertions += 1;
  assert.ok(condition, message);
}

function eq(actual, expected, message = '') {
  assertions += 1;
  assert.equal(actual, expected, message);
}

function deep(actual, expected, message = '') {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

function throws(fn, matcher, message = '') {
  assertions += 1;
  assert.throws(fn, matcher, message);
}

function quotaError() {
  const error = new Error('The quota has been exceeded.');
  error.name = 'QuotaExceededError';
  error.code = 22;
  return error;
}

function securityError() {
  const error = new Error('storage is blocked');
  error.name = 'SecurityError';
  return error;
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const state = {
    failGet: false,
    failSet: 0,
    alwaysQuota: false,
    nextError: null,
    writes: 0,
    removed: []
  };
  const storage = {
    state,
    getItem(key) {
      if (state.failGet) throw securityError();
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (state.alwaysQuota) throw quotaError();
      if (state.failSet > 0) {
        state.failSet -= 1;
        throw quotaError();
      }
      if (state.nextError) {
        const error = state.nextError;
        state.nextError = null;
        throw error;
      }
      map.set(key, String(value));
      state.writes += 1;
    },
    removeItem(key) {
      if (map.delete(key)) state.removed.push(key);
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    get length() {
      return map.size;
    },
    dump() {
      return Object.fromEntries(map);
    },
    has(key) {
      return map.has(key);
    }
  };
  return storage;
}

function sampleRecord(overrides = {}) {
  return {
    map: 'river',
    course: '310m',
    mode: 'sprint',
    car: 'corvette-zr1-stock',
    bestTimeSeconds: 14.65,
    bestLapSeconds: null,
    lapSplits: [],
    ghost: null,
    date: FIXED_DATE,
    lastTimeSeconds: 14.9,
    lastDate: FIXED_DATE,
    runs: 2,
    ...overrides
  };
}

function legacyBest(cars) {
  return JSON.stringify({ kind: 'e1-drive.sprint-best', version: 1, cars });
}

// ---------------------------------------------------------------------------

test('default profile is versioned and complete', () => {
  const profile = P.defaultProfile();
  eq(profile.kind, P.PROFILE_KIND);
  eq(profile.schemaVersion, P.PROFILE_SCHEMA_VERSION);
  eq(profile.revision, 0);
  eq(profile.updatedAt, 0);
  eq(profile.settings.quality, 'high');
  eq(profile.settings.volumes.master, 0.8);
  eq(profile.settings.volumes.music, 0.5);
  eq(profile.settings.volumes.sfx, 0.8);
  eq(profile.settings.cameraMode, 'chase');
  eq(profile.settings.steer, 'normal');
  eq(profile.settings.inputBindingsRef, 'default-keyboard-v1');
  eq(profile.settings.muted, false);
  eq(profile.settings.hud.units, 'metric');
  eq(profile.progress.lastMode, 'sprint');
  eq(profile.progress.lastCar, null);
  deep(profile.records, {});
  deep(profile.stats, { races: 0, wins: 0 });
  eq(profile.migration, null);
  deep(profile.extra, {});
  ok(P.QUALITY_LEVELS.includes('ultra'));
  ok(P.CAMERA_MODES.includes('chase'));
  ok(P.RECORD_MODES.includes('lap'));
});

test('fresh load without storage is explicit', () => {
  const store = P.createProfileStore({ now });
  const result = store.load();
  eq(result.ok, true);
  eq(result.code, P.PROFILE_ERROR.STORAGE_UNAVAILABLE);
  eq(result.profile.schemaVersion, 1);
  eq(result.revision, 0);
  eq(result.persisted, false);
  eq(result.readOnly, false);
  eq(store.persistent, false);
  eq(store.lastError, null);
});

test('fresh load with empty storage does not write', () => {
  const storage = memoryStorage();
  const store = P.createProfileStore({ storage, now });
  const result = store.load();
  eq(result.code, 'fresh');
  eq(result.persisted, true);
  eq(result.profile.revision, 0);
  eq(storage.state.writes, 0);
  eq(storage.length, 0);
});

test('save writes a canonical document and load roundtrips', () => {
  const storage = memoryStorage();
  const store = P.createProfileStore({ storage, now });
  const profile = store.load().profile;
  profile.settings.quality = 'ultra';
  profile.progress.lastCar = 'audi-r8v10-stock';
  const result = store.save(profile);
  eq(result.ok, true);
  eq(result.code, 'saved');
  eq(result.revision, 1);
  eq(result.persisted, true);
  ok(storage.has(P.PROFILE_STORAGE_KEY));
  const reloaded = P.createProfileStore({ storage, now }).load();
  eq(reloaded.code, 'loaded');
  eq(reloaded.profile.settings.quality, 'ultra');
  eq(reloaded.profile.progress.lastCar, 'audi-r8v10-stock');
  eq(P.serializeProfile(reloaded.profile), P.serializeProfile(result.profile));
});

test('serialization is independent of key insertion order', () => {
  const left = P.defaultProfile();
  left.records['river/310m/sprint/corvette-zr1-stock'] = sampleRecord();
  const right = {};
  for (const key of ['extra', 'migration', 'stats', 'records', 'progress', 'settings', 'updatedAt',
    'revision', 'schemaVersion', 'kind']) {
    right[key] = left[key];
  }
  right.settings = {};
  for (const key of Object.keys(left.settings).reverse()) right.settings[key] = left.settings[key];
  eq(P.serializeProfile(left), P.serializeProfile(right));
  eq(P.profileFingerprint(left), P.profileFingerprint(right));
});

test('serialization rejects non-finite numbers and reserved keys', () => {
  throws(() => P.canonicalJson({ value: NaN }), TypeError);
  throws(() => P.canonicalJson({ value: Infinity }), TypeError);
  throws(() => P.canonicalJson(JSON.parse('{"__proto__":1}')), TypeError);
  throws(() => P.canonicalJson({ value: 1n }), TypeError);
});

test('fingerprint is stable and content-sensitive', () => {
  const profile = P.defaultProfile();
  const first = P.profileFingerprint(profile);
  eq(first, P.profileFingerprint(profile));
  ok(first.startsWith('fnv1a64:'));
  eq(first.length, 'fnv1a64:'.length + 16);
  profile.settings.volumes.master = 0.4;
  ok(P.profileFingerprint(profile) !== first);
});

test('unknown top-level fields survive a save and reload', () => {
  const withExtra = P.defaultProfile();
  withExtra.futureFlag = { enabled: true };
  withExtra.extra = { kept: 1 };
  const storage = memoryStorage({
    [P.PROFILE_STORAGE_KEY]: JSON.stringify(withExtra)
  });
  const store = P.createProfileStore({ storage, now });
  const loaded = store.load();
  eq(loaded.code, 'repaired');
  deep(loaded.profile.extra, { kept: 1, futureFlag: { enabled: true } });
  store.save(loaded.profile);
  const reloaded = P.createProfileStore({ storage, now }).load();
  deep(reloaded.profile.extra, { kept: 1, futureFlag: { enabled: true } });
});

test('strict validation accepts the default profile', () => {
  const check = P.validateProfile(P.defaultProfile());
  eq(check.ok, true);
  eq(check.errors.length, 0);
  eq(check.warnings.length, 0);
});

test('strict validation rejects missing sections', () => {
  const check = P.validateProfile({ kind: P.PROFILE_KIND, schemaVersion: 1 });
  eq(check.ok, false);
  ok(check.errors.length >= 4);
  ok(check.errors.some((entry) => entry.path === 'settings'));
  ok(check.errors.some((entry) => entry.path === 'records'));
  ok(check.errors.some((entry) => entry.path === 'stats'));
});

test('strict validation rejects a future schemaVersion', () => {
  const profile = P.defaultProfile();
  profile.schemaVersion = 2;
  const check = P.validateProfile(profile);
  eq(check.ok, false);
  ok(check.errors.some((entry) => entry.code === P.PROFILE_ERROR.UNSUPPORTED_SCHEMA_VERSION));
});

test('partial profile is repaired with warnings', () => {
  const result = P.normalizeProfile({
    kind: P.PROFILE_KIND,
    schemaVersion: 1,
    settings: { quality: 'low' },
    records: {},
    stats: { races: 2 }
  });
  eq(result.errors.length, 0);
  eq(result.profile.settings.quality, 'low');
  eq(result.profile.settings.volumes.master, 0.8);
  eq(result.profile.settings.cameraMode, 'chase');
  eq(result.profile.stats.races, 2);
  eq(result.profile.stats.wins, 0);
  eq(result.profile.progress.lastMode, 'sprint');
  eq(result.profile.records ? Object.keys(result.profile.records).length : -1, 0);
  ok(result.warnings.length >= 1);
  ok(result.changed);
});

test('invalid enums fall back to documented defaults', () => {
  const result = P.normalizeProfile({
    kind: P.PROFILE_KIND,
    schemaVersion: 1,
    settings: {
      quality: 'cinematic',
      cameraMode: 'third-person',
      steer: 'sideways',
      hud: { units: 'nautical' }
    },
    progress: { lastMode: 'drift' },
    records: {},
    stats: { races: 0, wins: 0 }
  });
  eq(result.profile.settings.quality, 'high');
  eq(result.profile.settings.cameraMode, 'chase');
  eq(result.profile.settings.steer, 'normal');
  eq(result.profile.settings.hud.units, 'metric');
  eq(result.profile.progress.lastMode, 'sprint');
  ok(result.issues.filter((entry) => entry.code === P.PROFILE_ERROR.INVALID_ENUM).length >= 5);
});

test('volumes clamp to [0,1] and round to three decimals', () => {
  const result = P.normalizeProfile({
    kind: P.PROFILE_KIND,
    schemaVersion: 1,
    settings: { volumes: { master: 1.4, music: -0.2, sfx: 0.12345 } },
    records: {},
    stats: { races: 0, wins: 0 },
    progress: {}
  });
  eq(result.profile.settings.volumes.master, 1);
  eq(result.profile.settings.volumes.music, 0);
  eq(result.profile.settings.volumes.sfx, 0.123);
  ok(result.issues.some((entry) => entry.path === 'settings.volumes.master'));
});

test('HUD settings persist through the store', () => {
  const storage = memoryStorage();
  const store = P.createProfileStore({ storage, now });
  store.load();
  const result = store.updateSettings({
    hud: { showMinimap: true, units: 'imperial' },
    inputBindingsRef: 'default-gamepad-v1'
  });
  eq(result.ok, true);
  const reloaded = P.createProfileStore({ storage, now }).load();
  eq(reloaded.profile.settings.hud.showMinimap, true);
  eq(reloaded.profile.settings.hud.units, 'imperial');
  eq(reloaded.profile.settings.inputBindingsRef, 'default-gamepad-v1');
  eq(reloaded.profile.settings.volumes.master, 0.8);
});

test('progress validation rejects a display name as a car slug', () => {
  const result = P.normalizeProfile({
    kind: P.PROFILE_KIND,
    schemaVersion: 1,
    settings: {},
    progress: { lastCar: 'Audi R8', lastMap: 'river', lastMode: 'lap' },
    records: {},
    stats: { races: 0, wins: 0 }
  });
  eq(result.profile.progress.lastCar, null);
  eq(result.profile.progress.lastMap, 'river');
  eq(result.profile.progress.lastMode, 'lap');
  ok(result.issues.some((entry) => entry.code === P.PROFILE_ERROR.INVALID_SLUG));
  const store = P.createProfileStore({ now });
  const rejected = store.setProgress({ lastCar: 'Audi R8' });
  eq(rejected.ok, false);
  eq(rejected.code, P.PROFILE_ERROR.INVALID_PROGRESS);
});

test('stats clamp wins to races', () => {
  const result = P.normalizeProfile({
    kind: P.PROFILE_KIND,
    schemaVersion: 1,
    settings: {},
    progress: {},
    records: {},
    stats: { races: 2, wins: 5 }
  });
  eq(result.profile.stats.wins, 2);
  ok(result.issues.some((entry) => entry.path === 'stats.wins'));
});

test('record keys roundtrip and reject invalid segments', () => {
  const key = P.recordKey({
    map: 'river', course: '310m', mode: 'sprint', car: 'audi-r8v10-stock'
  });
  eq(key, 'river/310m/sprint/audi-r8v10-stock');
  deep(P.parseRecordKey(key), {
    map: 'river', course: '310m', mode: 'sprint', car: 'audi-r8v10-stock'
  });
  eq(P.parseRecordKey('river/310m/sprint'), null);
  eq(P.parseRecordKey('river/310m/drift/audi-r8v10-stock'), null);
  throws(() => P.recordKey({ map: 'river', course: '310m', mode: 'free', car: 'audi-r8v10-stock' }), /mode/);
  throws(() => P.recordKey({ map: 'river', course: '310m', mode: 'sprint', car: 'Audi R8' }), /car/);
});

test('a valid record normalizes without warnings', () => {
  const profile = P.defaultProfile();
  profile.records['river/310m/sprint/corvette-zr1-stock'] = sampleRecord({
    ghost: P.ghostReferenceFromIndex(GHOST_ENTRY, {
      storageKey: 'e1-drive.sprint.ghost.v1.310m'
    })
  });
  const result = P.normalizeProfile(profile);
  eq(result.errors.length, 0);
  eq(result.warnings.length, 0);
  eq(result.changed, false);
  const record = result.profile.records['river/310m/sprint/corvette-zr1-stock'];
  eq(record.bestTimeSeconds, 14.65);
  eq(record.lastTimeSeconds, 14.9);
  eq(record.runs, 2);
  eq(record.date, FIXED_DATE);
  eq(record.ghost.source, 'reference');
  eq(record.ghost.timeSeconds, 14.65);
  eq(record.ghost.finishTick, 969);
  eq(record.ghost.storageKey, 'e1-drive.sprint.ghost.v1.310m');
});

test('a record stored under the wrong key is re-keyed with a warning', () => {
  const profile = P.defaultProfile();
  profile.records['river/310m/sprint/corvette-zr1-stock'] = sampleRecord({
    car: 'audi-r8v10-stock'
  });
  const result = P.normalizeProfile(profile);
  ok('river/310m/sprint/audi-r8v10-stock' in result.profile.records);
  ok(!('river/310m/sprint/corvette-zr1-stock' in result.profile.records));
  ok(result.issues.some((entry) => entry.code === P.PROFILE_ERROR.INVALID_RECORD_KEY));
});

test('invalid records are dropped or repaired explicitly', () => {
  const profile = P.defaultProfile();
  profile.records['river/310m/sprint/corvette-zr1-stock'] = sampleRecord({
    bestTimeSeconds: 10,
    bestLapSeconds: 20,
    lapSplits: [NaN, 1.2]
  });
  profile.records['river/310m/sprint/audi-r8v10-stock'] = sampleRecord({
    car: 'audi-r8v10-stock',
    bestTimeSeconds: -1
  });
  profile.records['river/310m/sprint/lotus-exige-cup260-stock'] = sampleRecord({
    car: 'lotus-exige-cup260-stock',
    bestTimeSeconds: 'fast'
  });
  const result = P.normalizeProfile(profile);
  eq(Object.keys(result.profile.records).length, 1);
  const record = result.profile.records['river/310m/sprint/corvette-zr1-stock'];
  eq(record.bestLapSeconds, null);
  deep(record.lapSplits, [1.2]);
  ok(result.issues.some((entry) => entry.path === 'records.river/310m/sprint/corvette-zr1-stock.bestLapSeconds'));
  ok(result.issues.some((entry) => entry.path === 'records.river/310m/sprint/audi-r8v10-stock.bestTimeSeconds'));
  ok(result.issues.some((entry) => entry.path === 'records.river/310m/sprint/lotus-exige-cup260-stock.bestTimeSeconds'));
});

test('ghost references are built from ghost-index entries', () => {
  const reference = P.ghostReferenceFromIndex(GHOST_ENTRY, {
    storageKey: 'e1-drive.sprint.ghost.v1.310m'
  });
  eq(reference.source, 'reference');
  eq(reference.indexUrl, P.GHOST_INDEX_URL);
  eq(reference.file, GHOST_ENTRY.file);
  eq(reference.sha256, GHOST_ENTRY.sha256);
  eq(reference.hash, GHOST_ENTRY.ghostHash);
  eq(reference.layoutHash, GHOST_ENTRY.layoutHash);
  eq(reference.timeSeconds, 14.65);
  eq(reference.finishTick, 969);
  eq(reference.tickCount, 970);
  eq(reference.storageKey, 'e1-drive.sprint.ghost.v1.310m');
  eq(P.validateGhostReference(reference).ok, true);
  throws(() => P.ghostReferenceFromIndex({ ...GHOST_ENTRY, ghostHash: 'sha256:abc' }), TypeError);
  throws(() => P.ghostReferenceFromIndex({ ...GHOST_ENTRY, file: '../escape.json' }), TypeError);
});

test('ghost references reject unsafe paths and inconsistent ticks', () => {
  const reference = P.ghostReferenceFromIndex(GHOST_ENTRY);
  eq(P.validateGhostReference({ ...reference, file: '../escape.json' }).ok, false);
  eq(P.validateGhostReference({ ...reference, hash: 'nope' }).ok, false);
  eq(P.validateGhostReference({ ...reference, finishTick: reference.tickCount }).ok, false);
  eq(P.validateGhostReference({ ...reference, sha256: null }).ok, false);
});

test('migration reads the v1 best-time store', () => {
  const storage = memoryStorage({
    'e1-drive.sprint.best.v1': legacyBest({
      'corvette-zr1-stock': { seconds: 2.8, car: 'Corvette ZR1', checkpoints: 2, respawns: 0 }
    })
  });
  const store = P.createProfileStore({ storage, now });
  const result = store.load();
  eq(result.code, 'migrated');
  eq(result.ok, true);
  eq(result.persisted, true);
  eq(result.migration.records, 1);
  eq(result.migration.sources[0].key, 'e1-drive.sprint.best.v1');
  eq(result.profile.revision, 0);
  eq(result.profile.stats.races, 0);
  eq(result.profile.progress.lastCar, null);
  const record = result.profile.records['river/310m/sprint/corvette-zr1-stock'];
  eq(record.bestTimeSeconds, 2.8);
  eq(record.date, null);
  eq(record.ghost, null);
  eq(result.profile.migration.source, 'legacy-best-times');
  ok(storage.has('e1-drive.sprint.best.v1'));
  const stored = JSON.parse(storage.getItem(P.PROFILE_STORAGE_KEY));
  eq(stored.kind, P.PROFILE_KIND);
  eq(stored.records['river/310m/sprint/corvette-zr1-stock'].bestTimeSeconds, 2.8);
});

test('migration reads the v2 per-course best-time stores', () => {
  const storage = memoryStorage({
    'e1-drive.sprint.best.v2.310m': legacyBest({
      'corvette-zr1-stock': { seconds: 14.65, car: 'Corvette ZR1' }
    }),
    'e1-drive.sprint.best.v2.short': legacyBest({
      'corvette-zr1-stock': { seconds: 2.8, car: 'Corvette ZR1' }
    }),
    'e1-drive.sprint.best.v2.lap': legacyBest({
      'corvette-zr1-stock': { seconds: 86.1, car: 'Corvette ZR1', lapTimes: [29, 28.55, 28.55] }
    }),
    'e1-drive.sprint.best.v2.free': legacyBest({
      'corvette-zr1-stock': { seconds: 1, car: 'Corvette ZR1' }
    })
  });
  const result = P.createProfileStore({ storage, now }).load();
  eq(result.code, 'migrated');
  eq(result.migration.records, 3);
  eq(result.migration.unmapped.length, 1);
  ok('river/310m/sprint/corvette-zr1-stock' in result.profile.records);
  ok('river/short/sprint/corvette-zr1-stock' in result.profile.records);
  ok('river/lap/lap/corvette-zr1-stock' in result.profile.records);
  ok(!('river/free/free/corvette-zr1-stock' in result.profile.records));
  const lap = result.profile.records['river/lap/lap/corvette-zr1-stock'];
  eq(lap.bestTimeSeconds, 86.1);
  deep(lap.lapSplits, [29, 28.55, 28.55]);
  eq(result.profile.migration.unmapped, 1);
});

test('migration reads the v3 map best-time stores', () => {
  const storage = memoryStorage({
    'e1-drive.sprint.best.v3.amboy': legacyBest({
      'corvette-zr1-stock': { seconds: 222.05, car: 'Corvette ZR1' }
    }),
    'e1-drive.sprint.best.v3.gracia': legacyBest({
      'audi-r8v10-stock': { seconds: 66.27, car: 'Audi R8 V10' }
    })
  });
  const result = P.createProfileStore({ storage, now }).load();
  eq(result.code, 'migrated');
  eq(result.migration.records, 2);
  eq(result.profile.records['amboy/310m/sprint/corvette-zr1-stock'].bestTimeSeconds, 222.05);
  eq(result.profile.records['gracia/310m/sprint/audi-r8v10-stock'].bestTimeSeconds, 66.27);
  eq(result.profile.migration.sources.length, 2);
});

test('migration reads a legacy bestTime object with a car', () => {
  const storage = memoryStorage({
    bestTime: JSON.stringify({ seconds: 14.2, car: 'audi-r8v10-stock' })
  });
  const result = P.createProfileStore({ storage, now }).load();
  eq(result.code, 'migrated');
  eq(result.migration.records, 1);
  eq(result.migration.sources[0].key, 'bestTime');
  eq(result.profile.records['river/310m/sprint/audi-r8v10-stock'].bestTimeSeconds, 14.2);
  eq(result.profile.records['river/310m/sprint/audi-r8v10-stock'].date, null);
  eq(result.profile.migration.assumptions.length, 1);
  ok(result.profile.migration.assumptions[0].includes('river/310m/sprint'));
});

test('migration reports a bare bestTime number without guessing a car', () => {
  const storage = memoryStorage({ bestTime: '12.34' });
  const result = P.createProfileStore({ storage, now }).load();
  eq(result.code, 'migrated');
  eq(result.migration.records, 0);
  eq(result.migration.unmapped.length, 1);
  eq(result.migration.unmapped[0].reason, 'no-car-attribution');
  eq(Object.keys(result.profile.records).length, 0);
  eq(result.profile.migration.unmapped, 1);
  ok(storage.has('bestTime'));
});

test('migration is idempotent and non-destructive', () => {
  const storage = memoryStorage({
    'e1-drive.sprint.best.v1': legacyBest({
      'corvette-zr1-stock': { seconds: 2.8 }
    })
  });
  const store = P.createProfileStore({ storage, now });
  const first = store.load();
  eq(first.code, 'migrated');
  eq(storage.state.writes, 1);
  const second = store.load();
  eq(second.code, 'loaded');
  eq(second.profile.records['river/310m/sprint/corvette-zr1-stock'].bestTimeSeconds, 2.8);
  eq(storage.state.writes, 1);
  ok(storage.has('e1-drive.sprint.best.v1'));
  eq(second.profile.migration.source, 'legacy-best-times');
});

test('a namespaced profile does not consume the default legacy keys', () => {
  const storage = memoryStorage({
    'e1-drive.sprint.best.v1': legacyBest({
      'corvette-zr1-stock': { seconds: 2.8 }
    })
  });
  const store = P.createProfileStore({ storage, namespace: 'guest2', now });
  const result = store.load();
  eq(result.code, 'fresh');
  eq(Object.keys(result.profile.records).length, 0);
  eq(result.migration.skipped, 'namespaced-profile');
  ok(storage.has('e1-drive.sprint.best.v1'));
  eq(storage.has(P.PROFILE_STORAGE_KEY), false);
  eq(store.key, P.PROFILE_STORAGE_KEY + '.guest2');
});

test('corrupt JSON is backed up and reset to a typed fresh profile', () => {
  const storage = memoryStorage({ [P.PROFILE_STORAGE_KEY]: '{not json' });
  const store = P.createProfileStore({ storage, now });
  const result = store.load();
  eq(result.ok, true);
  eq(result.code, P.PROFILE_ERROR.CORRUPT_JSON);
  eq(result.reset, true);
  eq(result.readOnly, false);
  eq(result.persisted, true);
  eq(result.backupKey, P.PROFILE_BACKUP_KEY);
  eq(result.profile.schemaVersion, 1);
  eq(result.profile.revision, 0);
  eq(JSON.parse(storage.getItem(P.PROFILE_STORAGE_KEY)).kind, P.PROFILE_KIND);
  const backup = JSON.parse(storage.getItem(P.PROFILE_BACKUP_KEY));
  eq(backup.raw, '{not json');
  eq(backup.reason, P.PROFILE_ERROR.CORRUPT_JSON);
  eq(store.load().code, 'loaded');
});

test('an invalid schema is backed up and reset', () => {
  const raw = JSON.stringify({ kind: 'not-a-profile', schemaVersion: 1 });
  const storage = memoryStorage({ [P.PROFILE_STORAGE_KEY]: raw });
  const result = P.createProfileStore({ storage, now }).load();
  eq(result.ok, true);
  eq(result.code, P.PROFILE_ERROR.INVALID_SCHEMA);
  eq(result.reset, true);
  eq(result.backupKey, P.PROFILE_BACKUP_KEY);
  eq(JSON.parse(storage.getItem(P.PROFILE_BACKUP_KEY)).raw, raw);
  eq(JSON.parse(storage.getItem(P.PROFILE_STORAGE_KEY)).kind, P.PROFILE_KIND);
});

test('an invalid records container is backed up, not silently emptied', () => {
  const raw = JSON.stringify({
    kind: P.PROFILE_KIND,
    schemaVersion: 1,
    revision: 2,
    settings: {},
    progress: {},
    records: [],
    stats: { races: 0, wins: 0 }
  });
  const storage = memoryStorage({ [P.PROFILE_STORAGE_KEY]: raw });
  const result = P.createProfileStore({ storage, now }).load();
  eq(result.ok, true);
  eq(result.code, P.PROFILE_ERROR.INVALID_SCHEMA);
  eq(result.reset, true);
  eq(result.backupKey, P.PROFILE_BACKUP_KEY);
  eq(JSON.parse(storage.getItem(P.PROFILE_BACKUP_KEY)).raw, raw);
  deep(result.profile.records, {});
});

test('backup slots do not overwrite older backups', () => {
  const storage = memoryStorage({
    [P.PROFILE_STORAGE_KEY]: '{bad',
    [P.PROFILE_BACKUP_KEY]: 'old-0',
    [P.PROFILE_BACKUP_KEY + '.1']: 'old-1'
  });
  const result = P.createProfileStore({ storage, now }).load();
  eq(result.backupKey, P.PROFILE_BACKUP_KEY + '.2');
  eq(storage.getItem(P.PROFILE_BACKUP_KEY), 'old-0');
  eq(storage.getItem(P.PROFILE_BACKUP_KEY + '.1'), 'old-1');
  ok(storage.has(P.PROFILE_BACKUP_KEY + '.2'));
  eq(JSON.parse(storage.getItem(P.PROFILE_BACKUP_KEY + '.2')).raw, '{bad');
});

test('a corrupt profile with no backup slot is not overwritten', () => {
  const storage = memoryStorage({
    [P.PROFILE_STORAGE_KEY]: '{bad',
    [P.PROFILE_BACKUP_KEY]: 'old-0',
    [P.PROFILE_BACKUP_KEY + '.1']: 'old-1',
    [P.PROFILE_BACKUP_KEY + '.2']: 'old-2'
  });
  const store = P.createProfileStore({ storage, now });
  const result = store.load();
  eq(result.ok, true);
  eq(result.reset, false);
  eq(result.readOnly, true);
  eq(result.backupKey, null);
  eq(storage.getItem(P.PROFILE_STORAGE_KEY), '{bad');
  eq(store.save(P.defaultProfile()).code, P.PROFILE_ERROR.READ_ONLY);
});

test('a future schema is left untouched and read-only', () => {
  const raw = JSON.stringify({
    kind: P.PROFILE_KIND,
    schemaVersion: 99,
    revision: 7,
    settings: { quality: 'ultra' },
    progress: {},
    records: {},
    stats: { races: 9, wins: 4 }
  });
  const storage = memoryStorage({ [P.PROFILE_STORAGE_KEY]: raw });
  const store = P.createProfileStore({ storage, now });
  const result = store.load();
  eq(result.ok, false);
  eq(result.code, P.PROFILE_ERROR.FUTURE_SCHEMA);
  eq(result.profile, null);
  eq(result.readOnly, true);
  eq(storage.getItem(P.PROFILE_STORAGE_KEY), raw);
  eq(store.save(P.defaultProfile()).ok, false);
  eq(store.save(P.defaultProfile()).code, P.PROFILE_ERROR.READ_ONLY);
  const resetRefused = store.reset();
  eq(resetRefused.ok, false);
  eq(resetRefused.code, P.PROFILE_ERROR.READ_ONLY);
  eq(store.updateSettings({ quality: 'low' }).code, P.PROFILE_ERROR.READ_ONLY);
  eq(store.setProgress({ lastCar: 'audi-r8v10-stock' }).code, P.PROFILE_ERROR.READ_ONLY);
  eq(store.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'audi-r8v10-stock', timeSeconds: 14.1
  }).code, P.PROFILE_ERROR.READ_ONLY);
  eq(store.deleteRecord({
    map: 'river', course: '310m', mode: 'sprint', car: 'audi-r8v10-stock'
  }).code, P.PROFILE_ERROR.READ_ONLY);
  const forced = store.reset({ force: true });
  eq(forced.ok, true);
  eq(storage.getItem(P.PROFILE_STORAGE_KEY) !== raw, true);
  eq(JSON.parse(storage.getItem(P.PROFILE_STORAGE_KEY)).schemaVersion, 1);
  ok(storage.has(P.PROFILE_BACKUP_KEY));
  eq(JSON.parse(storage.getItem(P.PROFILE_BACKUP_KEY)).reason, 'forced-schema-downgrade');
  eq(store.load().code, 'loaded');
});

test('save backs up a damaged stored profile before overwriting it', () => {
  const storage = memoryStorage();
  const first = P.createProfileStore({ storage, now });
  eq(first.save(P.defaultProfile()).revision, 1);
  storage.setItem(P.PROFILE_STORAGE_KEY, '{bad');
  const result = P.createProfileStore({ storage, now }).save(P.defaultProfile());
  eq(result.ok, true);
  eq(result.code, 'saved');
  eq(result.revision, 1);
  ok(storage.has(P.PROFILE_BACKUP_KEY));
  eq(JSON.parse(storage.getItem(P.PROFILE_BACKUP_KEY)).raw, '{bad');
  eq(JSON.parse(storage.getItem(P.PROFILE_STORAGE_KEY)).kind, P.PROFILE_KIND);
});

test('quota failure keeps the current profile in memory and reports it', () => {
  const storage = memoryStorage();
  const store = P.createProfileStore({ storage, now });
  store.load();
  eq(store.save(store.get()).revision, 1);
  storage.state.alwaysQuota = true;
  const submitted = store.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'corvette-zr1-stock',
    timeSeconds: 14.6, date: FIXED_DATE
  });
  eq(submitted.ok, false);
  eq(submitted.code, P.PROFILE_ERROR.QUOTA_EXCEEDED);
  eq(submitted.quota, true);
  eq(submitted.persisted, false);
  eq(submitted.recorded, true);
  eq(JSON.parse(storage.getItem(P.PROFILE_STORAGE_KEY)).revision, 1);
  eq(store.persistent, true);
  const memory = store.load();
  eq(memory.code, 'loaded-memory');
  ok('river/310m/sprint/corvette-zr1-stock' in memory.profile.records);
  storage.state.alwaysQuota = false;
  const retried = store.save();
  eq(retried.ok, true);
  eq(retried.persisted, true);
  ok(retried.revision >= 2);
  const stored = JSON.parse(storage.getItem(P.PROFILE_STORAGE_KEY));
  ok('river/310m/sprint/corvette-zr1-stock' in stored.records);
});

test('quota retry reclaims one backup slot', () => {
  const storage = memoryStorage();
  const store = P.createProfileStore({ storage, now });
  store.load();
  store.save(store.get());
  storage.setItem(P.PROFILE_BACKUP_KEY, 'backup');
  storage.state.failSet = 1;
  const profile = store.get();
  profile.settings.quality = 'low';
  const result = store.save(profile);
  eq(result.ok, true);
  eq(result.quota, true);
  eq(result.freedBackup, P.PROFILE_BACKUP_KEY);
  eq(storage.has(P.PROFILE_BACKUP_KEY), false);
  eq(JSON.parse(storage.getItem(P.PROFILE_STORAGE_KEY)).settings.quality, 'low');
});

test('a non-quota write failure disables persistence without throwing', () => {
  const storage = memoryStorage();
  const store = P.createProfileStore({ storage, now });
  store.load();
  storage.state.nextError = securityError();
  const profile = store.get();
  profile.settings.quality = 'low';
  const failed = store.save(profile);
  eq(failed.ok, false);
  eq(failed.code, P.PROFILE_ERROR.STORAGE_UNAVAILABLE);
  eq(failed.persisted, false);
  eq(store.persistent, false);
  profile.settings.quality = 'medium';
  const memory = store.save(profile);
  eq(memory.ok, true);
  eq(memory.code, 'saved-memory');
  eq(memory.persisted, false);
});

test('read failures degrade to an explicit memory profile', () => {
  const storage = memoryStorage();
  storage.state.failGet = true;
  const store = P.createProfileStore({ storage, now });
  const result = store.load();
  eq(result.code, P.PROFILE_ERROR.STORAGE_UNAVAILABLE);
  eq(result.profile.schemaVersion, 1);
  eq(result.persisted, false);
  eq(store.persistent, false);
  const profile = store.get();
  profile.settings.quality = 'low';
  eq(store.save(profile).code, 'saved-memory');
  eq(store.persistent, false);
});

test('concurrent tabs merge records and keep the higher revision', () => {
  const storage = memoryStorage();
  const a = P.createProfileStore({ storage, now });
  const b = P.createProfileStore({ storage, now });
  const a0 = a.load().profile;
  a0.settings.quality = 'low';
  eq(a.save(a0).revision, 1);
  const b0 = b.load().profile;
  eq(b0.revision, 1);
  const aRun = a.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'corvette-zr1-stock',
    timeSeconds: 14.6, date: FIXED_DATE
  });
  eq(aRun.revision, 2);
  eq(aRun.conflict, false);
  b.get().settings.quality = 'ultra';
  const bRun = b.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'audi-r8v10-stock',
    timeSeconds: 14.1, date: FIXED_DATE
  });
  eq(bRun.conflict, true);
  eq(bRun.code, 'saved-merged');
  eq(bRun.revision, 3);
  const merged = b.load().profile;
  ok('river/310m/sprint/corvette-zr1-stock' in merged.records);
  ok('river/310m/sprint/audi-r8v10-stock' in merged.records);
  eq(merged.settings.quality, 'ultra');
  eq(merged.stats.races, 1);
  eq(merged.revision, 3);
});

test('a stale tab cannot overwrite a faster record', () => {
  const storage = memoryStorage();
  const a = P.createProfileStore({ storage, now });
  const b = P.createProfileStore({ storage, now });
  a.load();
  a.save(a.get());
  b.load();
  a.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'corvette-zr1-stock',
    timeSeconds: 14.6, date: FIXED_DATE
  });
  const stale = b.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'corvette-zr1-stock',
    timeSeconds: 14.9, date: '2025-01-02T00:00:00.000Z'
  });
  eq(stale.conflict, true);
  const record = b.load().profile.records['river/310m/sprint/corvette-zr1-stock'];
  eq(record.bestTimeSeconds, 14.6);
  eq(record.lastTimeSeconds, 14.9);
  eq(record.runs, 1);
  eq(record.lastDate, '2025-01-02T00:00:00.000Z');
});

test('saving identical content is a no-op', () => {
  const storage = memoryStorage();
  const store = P.createProfileStore({ storage, now });
  store.load();
  store.save(store.get());
  const writes = storage.state.writes;
  const result = store.save(store.get());
  eq(result.ok, true);
  eq(result.code, 'no-change');
  eq(result.revision, 1);
  eq(storage.state.writes, writes);
});

test('revision increments on every persisted save', () => {
  const storage = memoryStorage();
  const store = P.createProfileStore({ storage, now });
  store.load();
  const profile = store.get();
  profile.settings.quality = 'low';
  eq(store.save(profile).revision, 1);
  profile.settings.quality = 'medium';
  eq(store.save(profile).revision, 2);
  profile.settings.quality = 'high';
  eq(store.save(profile).revision, 3);
  eq(store.revision, 3);
  eq(P.createProfileStore({ storage, now }).load().profile.revision, 3);
});

test('submitResult keeps the fastest time and counts runs', () => {
  const storage = memoryStorage();
  const store = P.createProfileStore({ storage, now });
  store.load();
  const first = store.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'corvette-zr1-stock',
    timeSeconds: 14.6, date: FIXED_DATE
  });
  eq(first.ok, true);
  eq(first.improved, true);
  eq(first.record.bestTimeSeconds, 14.6);
  eq(first.record.runs, 1);
  eq(first.stats.races, 1);
  eq(first.stats.wins, 0);
  eq(first.profile.progress.lastCar, 'corvette-zr1-stock');
  eq(first.profile.progress.lastMap, 'river');
  eq(first.profile.progress.lastMode, 'sprint');
  const second = store.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'corvette-zr1-stock',
    timeSeconds: 14.9, date: '2025-01-02T00:00:00.000Z'
  });
  eq(second.improved, false);
  eq(second.record.bestTimeSeconds, 14.6);
  eq(second.record.lastTimeSeconds, 14.9);
  eq(second.record.runs, 2);
  eq(second.stats.races, 2);
  eq(second.record.date, FIXED_DATE);
});

test('lap results store splits and a separate best lap', () => {
  const storage = memoryStorage();
  const store = P.createProfileStore({ storage, now });
  store.load();
  const first = store.submitResult({
    map: 'river', course: 'lap', mode: 'lap', car: 'corvette-zr1-stock',
    timeSeconds: 86, lapTimes: [29, 28.5, 28.5], bestLapSeconds: 28.5,
    win: true, date: FIXED_DATE
  });
  eq(first.record.bestTimeSeconds, 86);
  eq(first.record.bestLapSeconds, 28.5);
  deep(first.record.lapSplits, [29, 28.5, 28.5]);
  eq(first.stats.races, 1);
  eq(first.stats.wins, 1);
  const second = store.submitResult({
    map: 'river', course: 'lap', mode: 'lap', car: 'corvette-zr1-stock',
    timeSeconds: 87, lapTimes: [28.2, 29, 29.8], bestLapSeconds: 28.2,
    date: '2025-01-02T00:00:00.000Z'
  });
  eq(second.improved, false);
  eq(second.record.bestTimeSeconds, 86);
  eq(second.record.bestLapSeconds, 28.2);
  deep(second.record.lapSplits, [29, 28.5, 28.5]);
  eq(second.record.runs, 2);
  eq(second.stats.wins, 1);
});

test('online results count local stats but never write records', () => {
  const storage = memoryStorage();
  const store = P.createProfileStore({ storage, now });
  store.load();
  const result = store.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'audi-r8v10-stock',
    timeSeconds: 14.1, online: true, win: true, date: FIXED_DATE
  });
  eq(result.ok, true);
  eq(result.recorded, false);
  eq(result.record, null);
  eq(result.stats.races, 1);
  eq(result.stats.wins, 1);
  deep(store.load().profile.records, {});
  eq(store.get().progress.lastMode, 'multiplayer');
});

test('submitResult rejects unsupported modes and values', () => {
  const store = P.createProfileStore({ now });
  throws(() => store.submitResult({
    map: 'river', course: 'free', mode: 'free', car: 'audi-r8v10-stock', timeSeconds: 1
  }), /solo records/);
  throws(() => store.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'audi-r8v10-stock', timeSeconds: 0
  }), /timeSeconds/);
  throws(() => store.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'audi-r8v10-stock', timeSeconds: 14,
    ghost: { file: '../x' }
  }), /ghost/);
  throws(() => store.submitResult({
    map: 'river', course: 'lap', mode: 'lap', car: 'audi-r8v10-stock',
    timeSeconds: 86, bestLapSeconds: 90
  }), /bestLapSeconds/);
});

test('a ghost reference survives submit and reload', () => {
  const storage = memoryStorage();
  const store = P.createProfileStore({ storage, now });
  store.load();
  const ghost = P.ghostReferenceFromIndex(GHOST_ENTRY, {
    storageKey: 'e1-drive.sprint.ghost.v1.310m'
  });
  const result = store.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'corvette-zr1-stock',
    timeSeconds: 14.65, ghost, date: FIXED_DATE
  });
  eq(result.ok, true);
  eq(result.record.ghost.hash, GHOST_ENTRY.ghostHash);
  const reloaded = P.createProfileStore({ storage, now }).load().profile;
  deep(reloaded.records['river/310m/sprint/corvette-zr1-stock'].ghost, ghost);
  eq(reloaded.records['river/310m/sprint/corvette-zr1-stock'].ghost.storageKey,
    'e1-drive.sprint.ghost.v1.310m');
});

test('reset clears progress and removes legacy keys', () => {
  const storage = memoryStorage({
    'e1-drive.sprint.best.v1': legacyBest({
      'corvette-zr1-stock': { seconds: 2.8 }
    })
  });
  const store = P.createProfileStore({ storage, now });
  store.load();
  store.updateSettings({ quality: 'low' });
  store.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'corvette-zr1-stock',
    timeSeconds: 14.6, date: FIXED_DATE
  });
  const before = store.revision;
  const result = store.reset();
  eq(result.ok, true);
  eq(result.code, 'reset');
  eq(result.persisted, true);
  ok(result.revision > before);
  deep(store.get().records, {});
  eq(store.get().stats.races, 0);
  eq(store.get().settings.quality, 'high');
  eq(store.get().progress.lastCar, null);
  eq(storage.has('e1-drive.sprint.best.v1'), false);
  ok(result.removedLegacy.includes('e1-drive.sprint.best.v1'));
});

test('reset can keep settings and stats', () => {
  const storage = memoryStorage();
  const store = P.createProfileStore({ storage, now });
  store.load();
  store.updateSettings({ quality: 'low' });
  store.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'corvette-zr1-stock',
    timeSeconds: 14.6, win: true, date: FIXED_DATE
  });
  const result = store.reset({ keepSettings: true, keepStats: true });
  eq(result.ok, true);
  eq(store.get().settings.quality, 'low');
  eq(store.get().stats.races, 1);
  eq(store.get().stats.wins, 1);
  deep(store.get().records, {});
});

test('namespaced stores are disjoint', () => {
  const storage = memoryStorage();
  const a = P.createProfileStore({ storage, namespace: 'alpha', now });
  const b = P.createProfileStore({ storage, namespace: 'beta', now });
  eq(a.key, 'blur.profile.v1.alpha');
  eq(b.key, 'blur.profile.v1.beta');
  a.load();
  b.load();
  const aProfile = a.get();
  aProfile.settings.quality = 'low';
  a.save(aProfile);
  const bProfile = b.get();
  bProfile.settings.quality = 'ultra';
  b.save(bProfile);
  eq(JSON.parse(storage.getItem(a.key)).settings.quality, 'low');
  eq(JSON.parse(storage.getItem(b.key)).settings.quality, 'ultra');
  eq(a.load().profile.settings.quality, 'low');
  eq(b.load().profile.settings.quality, 'ultra');
  throws(() => P.sanitizeNamespace('Bad Name'), TypeError);
});

test('a guest namespace never inherits the host profile', () => {
  const storage = memoryStorage();
  const host = P.createProfileStore({ storage, now });
  host.load();
  host.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'corvette-zr1-stock',
    timeSeconds: 14.6, date: FIXED_DATE
  });
  const guest = P.createProfileStore({ storage, namespace: 'guest1', now });
  const loaded = guest.load();
  eq(loaded.code, 'fresh');
  deep(loaded.profile.records, {});
  eq(loaded.profile.stats.races, 0);
  guest.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'audi-r8v10-stock',
    timeSeconds: 14.1, online: true, date: FIXED_DATE
  });
  eq(guest.get().stats.races, 1);
  deep(guest.get().records, {});
  const hostReload = P.createProfileStore({ storage, now }).load();
  eq(hostReload.profile.stats.races, 1);
  ok(hostReload.profile.records['river/310m/sprint/corvette-zr1-stock']);
  eq(Object.keys(guest.get().records).length, 0);
});

test('deleteRecord removes only the named record', () => {
  const store = P.createProfileStore({ now });
  store.load();
  store.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'corvette-zr1-stock',
    timeSeconds: 14.6, date: FIXED_DATE
  });
  store.submitResult({
    map: 'river', course: '310m', mode: 'sprint', car: 'audi-r8v10-stock',
    timeSeconds: 14.1, date: FIXED_DATE
  });
  eq(Object.keys(store.get().records).length, 2);
  const result = store.deleteRecord({
    map: 'river', course: '310m', mode: 'sprint', car: 'corvette-zr1-stock'
  });
  eq(result.deleted, true);
  eq(Object.keys(store.get().records).length, 1);
  const missing = store.deleteRecord({
    map: 'river', course: '310m', mode: 'sprint', car: 'corvette-zr1-stock'
  });
  eq(missing.deleted, false);
  eq(store.get().records['river/310m/sprint/audi-r8v10-stock'].bestTimeSeconds, 14.1);
});

test('profile size estimate is deterministic', () => {
  const profile = P.defaultProfile();
  const first = P.estimateProfileBytes(profile);
  const second = P.estimateProfileBytes(profile);
  deep(first, second);
  eq(first.bytesApprox, first.characters * 2);
  profile.records['river/310m/sprint/corvette-zr1-stock'] = sampleRecord();
  ok(P.estimateProfileBytes(profile).characters > first.characters);
});

test('the integration contract matches the module constants', () => {
  const path = fileURLToPath(new URL('./contract.json', import.meta.url));
  const contract = JSON.parse(readFileSync(path, 'utf8'));
  eq(contract.kind, 'blur.profile.contract');
  eq(contract.version, 1);
  eq(contract.schemaVersion, P.PROFILE_SCHEMA_VERSION);
  eq(contract.module, 'probes/profile/profile.mjs');
  eq(contract.keys.profile, P.PROFILE_STORAGE_KEY);
  eq(contract.keys.backup, P.PROFILE_BACKUP_KEY);
  deep(contract.keys.backupOverflow, [P.PROFILE_BACKUP_KEY + '.1', P.PROFILE_BACKUP_KEY + '.2']);
  deep(contract.keys.legacyBestTimes, P.LEGACY_BEST_KEYS.map((entry) => entry.key));
  eq(contract.keys.legacyBestTime, P.LEGACY_BEST_TIME_KEY);
  eq(contract.keys.ghostStorePrefix, P.GHOST_STORE_KEY_PREFIX);
  eq(contract.keys.ghostIndexUrl, P.GHOST_INDEX_URL);
  eq(contract.saveTriggers.length, 5);
  eq(contract.failureUi[P.PROFILE_ERROR.QUOTA_EXCEEDED].level, 'error');
  ok(contract.failureUi[P.PROFILE_ERROR.QUOTA_EXCEEDED].message.includes('storage is full'));
  eq(contract.failureUi['saved-memory'].level, 'warning');
  eq(contract.ghostReference.indexUrl, P.GHOST_INDEX_URL);
  eq(contract.ghostReference.recordField,
    'records[<map>/<course>/<mode>/<car>].ghost');
});

// ---------------------------------------------------------------------------

const failed = cases.filter((entry) => entry.ok === false);
const report = {
  kind: 'blur.profile.tests',
  version: 1,
  assertions,
  cases: cases.length,
  passed: cases.length - failed.length,
  failed: failed.length,
  results: cases
};
const out = resolve(process.cwd(), '_work/profile/tests.json');
mkdirSync(resolve(process.cwd(), '_work/profile'), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');

for (const entry of failed) {
  console.error('FAIL ' + entry.name + ': ' + entry.error);
}
console.log(JSON.stringify({
  assertions,
  cases: cases.length,
  passed: report.passed,
  failed: report.failed,
  report: '_work/profile/tests.json'
}));
if (failed.length > 0) process.exit(1);
