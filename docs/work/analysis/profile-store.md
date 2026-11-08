# Local player profile — versioned store, migration and integration contract

**Status:** implemented and tested, 8 November 2026
**Module:** `probes/profile/profile.mjs`
**Tests:** `probes/profile/tests.mjs`
**Contract:** `probes/profile/contract.json`
**Owner:** SAVE1
**Scope:** `probes/profile/**`, `_work/profile/**`, `_work/logs/profile/**`, this
record. No change to `probes/e1-drive/**`, `tools/`, `upstream/` or `game-data/`.

## 1. Why this exists

The current build writes best times to `localStorage` with no schema, no
versioning, no settings and no per-map/per-car namespace. It has four different
best-time key families (`v1`, `v2.<course>`, `v3.<map>`), one ghost key per
course, and no way to reset a player cleanly. A shippable shell needs one
document that:

- survives a build update without destroying newer data;
- keeps settings, last-used car/map/mode, per-map/course/car records and stats;
- never mixes a guest's multiplayer session with the host's records;
- degrades to memory instead of throwing into the drive loop;
- backs up damaged bytes before any reset;
- is deterministic enough to test byte for byte.

The store is deliberately storage-agnostic. It imports no browser globals and
accepts an injected localStorage-shaped object and clock, so the same module
runs in the page, in Node tests and in a future shell.

## 2. Schema (v1)

```json
{
  "kind": "blur.profile",
  "schemaVersion": 1,
  "revision": 4,
  "updatedAt": 1735689600000,
  "settings": {
    "quality": "high",
    "volumes": { "master": 0.8, "music": 0.5, "sfx": 0.8 },
    "muted": false,
    "cameraMode": "chase",
    "steer": "normal",
    "inputBindingsRef": "default-keyboard-v1",
    "hud": {
      "showSpeed": true,
      "showGhostDelta": true,
      "showMinimap": false,
      "units": "metric"
    }
  },
  "progress": {
    "lastCar": "corvette-zr1-stock",
    "lastMap": "river",
    "lastCourse": "310m",
    "lastMode": "sprint"
  },
  "records": {
    "river/310m/sprint/corvette-zr1-stock": {
      "map": "river",
      "course": "310m",
      "mode": "sprint",
      "car": "corvette-zr1-stock",
      "bestTimeSeconds": 14.65,
      "bestLapSeconds": null,
      "lapSplits": [],
      "ghost": {
        "source": "reference",
        "storageKey": null,
        "indexUrl": "/ghosts/index.json",
        "file": "probes/e1-drive/ghosts/corvette-zr1-stock-310m.json",
        "sha256": "sha256:29b8d9cb2109224570973bf2d22fd956986c4423acb3722928fa55b4a0828914",
        "hash": "sha256:10a2e115a897a0c87eff30aba7d13944658ff2f9dd009f0f07c48178b35c9f1e",
        "layoutHash": "sha256:9240e9c136059ccd209992999b8570860f99f1bedd4b4ec9ff0a56d5cf8cad53",
        "timeSeconds": 14.65,
        "finishTick": 969,
        "tickCount": 970
      },
      "date": "2025-01-01T00:00:00.000Z",
      "lastTimeSeconds": 14.9,
      "lastDate": "2025-01-02T00:00:00.000Z",
      "runs": 2
    }
  },
  "stats": { "races": 2, "wins": 0 },
  "migration": null,
  "extra": {}
}
```

| field | type | rules |
|---|---|---|
| `kind` | string | always `"blur.profile"`; a different kind is a corrupt profile |
| `schemaVersion` | integer | `1`; a larger value is read-only, never downgraded |
| `revision` | integer ≥ 0 | increments on every persisted save; concurrency token |
| `updatedAt` | number ≥ 0 | injected clock in milliseconds; not used for ordering |
| `settings.quality` | enum | `low`, `medium`, `high`, `ultra` (default `high`) |
| `settings.volumes.master/music/sfx` | number | 0…1, rounded to 3 decimals |
| `settings.muted` | boolean | default `false` |
| `settings.cameraMode` | enum | `chase`, `orbit` (default `chase`) |
| `settings.steer` | enum | `normal`, `inverted` (default `normal`) |
| `settings.inputBindingsRef` | string | binding-table id, not the table itself |
| `settings.hud.*` | booleans + `units` | `metric` or `imperial` |
| `progress.lastCar/lastMap/lastCourse` | slug or null | lowercase `[a-z0-9._-]`, ≤ 64 chars |
| `progress.lastMode` | enum | `sprint`, `lap`, `free`, `multiplayer` |
| `records` | object | key `<map>/<course>/<mode>/<car>`; max 4096 entries |
| `records.*.mode` | enum | `sprint`, `lap` only |
| `records.*.bestTimeSeconds` | number | > 0, ≤ 86400, 3 decimals |
| `records.*.bestLapSeconds` | number or null | > 0 and ≤ the total time |
| `records.*.lapSplits` | number[] | 0…128 positive lap times; the best total run's splits |
| `records.*.ghost` | object or null | pointer, never the sample payload |
| `records.*.date` | ISO string or null | best-time date (UTC, `Z`) |
| `records.*.lastTimeSeconds` / `lastDate` | number / ISO | most recent run |
| `records.*.runs` | integer ≥ 1 | local run count for this key |
| `stats.races` | integer ≥ 0 | completed races; solo and online |
| `stats.wins` | integer ≥ 0 | clamped to `stats.races` |
| `migration` | object or null | legacy source keys, time, unmapped count, assumptions |
| `extra` | object | unknown top-level fields preserved verbatim |

Defaults are the documented fallback for every optional setting. A partial
document is repaired with warnings; a field with the wrong type is replaced by
its default, not guessed. Strict validation (`validateProfile`) reports errors
instead of repairing and is what `save()` uses on caller-built documents.

### Record key

`<map>/<course>/<mode>/<car>`:

- map ids: `river`, `amboy`, `gracia` today, but only the slug format is
  enforced so a new map does not need a store release;
- course ids: `310m`, `short`, `lap`, `free`;
- mode: `sprint` or `lap`;
- car: the roster slug.

The key is derived from the fields. A stored key that disagrees with its fields
is re-keyed with a `record-key-mismatch` warning; the record is not dropped.

## 3. Storage keys and namespacing

| key | purpose |
|---|---|
| `blur.profile.v1` | default local profile |
| `blur.profile.v1.<namespace>` | optional second local player/slot |
| `blur.profile.v1.backup` | first damaged/forced-save backup |
| `blur.profile.v1.backup.1`, `.backup.2` | overflow backup slots |
| `blur.profile.v1.backup.<namespace>` | namespaced backup |
| `e1-drive.sprint.best.*` | **legacy read-only** best-time keys |
| `bestTime` | **legacy read-only** single-value key |
| `e1-drive.sprint.ghost.v1.<course>` | existing ghost store, unchanged |

`profileStorageKey(namespace)` and `profileBackupKey(namespace)` are exported so
the shell never types a key by hand. A namespace must match
`^[a-z0-9][a-z0-9._-]{0,31}$`; `sanitizeNamespace` rejects anything else.

### Multiplayer conflict rules

- `localStorage` is origin-scoped and per browser profile. The room protocol
  carries **no profile document**, so a guest cannot receive the host's records.
- `submitResult({ online: true })` (or `mode: "multiplayer"`) never writes a
  record. It does count the local `stats.races`/`stats.wins`, because those are
  the guest's own stats.
- Room codes are **not** namespaces: they are ephemeral and would fragment or
  leak a player's data. A namespace is a stable local slot chosen by the player
  or the shell, never by the room.
- Two tabs on the same namespace use `revision`. A save whose base revision is
  stale is merged: records keep the faster time, stats keep the maximum,
  settings/progress are last-write-wins. A stale tab cannot erase a better lap.
- Namespaced profiles skip legacy migration. Only the default profile reads the
  shared legacy keys, because those keys cannot be attributed to a named slot.

## 4. Load, save and migration

### Load result

`store.load()` always returns an object; it never throws for storage problems.

| `code` | meaning | `profile` | notes |
|---|---|---|---|
| `fresh` | no profile and no legacy data | defaults | nothing is written |
| `loaded` | valid profile | stored | |
| `repaired` | valid profile with repaired fields | repaired | warnings in `issues`; not written until the next save |
| `migrated` | legacy data imported | migrated | written immediately; legacy keys kept |
| `corrupt-json` / `invalid-schema` | damaged bytes | fresh | backed up, then reset |
| `future-schema` | newer `schemaVersion` | `null` | read-only; no backup/reset |
| `storage-unavailable` | blocked storage | defaults | memory-only |
| `loaded-memory` | unsaved quota/memory state | in-memory | retry with `save()` |

`persisted` says whether the document is durable. `readOnly` says whether the
store will refuse writes. `backupKey` names the backup actually used.

### When to migrate

On the first `load()` with no `blur.profile.v1` key, the default namespace reads:

| legacy key | record namespace |
|---|---|
| `e1-drive.sprint.best.v1` | `river/310m/sprint` |
| `e1-drive.sprint.best.v2.310m` | `river/310m/sprint` |
| `e1-drive.sprint.best.v2.short` | `river/short/sprint` |
| `e1-drive.sprint.best.v2.lap` | `river/lap/lap` |
| `e1-drive.sprint.best.v2.free` | skipped (free roam has no finish) |
| `e1-drive.sprint.best.v3.amboy` | `amboy/310m/sprint` |
| `e1-drive.sprint.best.v3.gracia` | `gracia/310m/sprint` |
| `bestTime` object with `car` | `river/310m/sprint` unless `map`/`course`/`mode` are given |
| `bestTime` bare number | **unmapped**, no car can be attributed |

Behaviour:

- **Non-destructive:** the legacy keys are never deleted by migration. They are
  deleted only by an explicit `reset({ removeLegacy: true })` (the default after
  a successful reset), so a rollback to the old build still works.
- **Idempotent:** the second load reads the new profile and reports `loaded`.
- **Honest:** a `bestTime` number or an unsupported legacy shape is counted in
  `migration.unmapped`; no car or course is invented. `migration.assumptions`
  records the one documented default (`bestTime` object without map/course/mode
  → `river/310m/sprint`).
- **No guessed history:** legacy dates, ghosts, best laps and run counts do not
  exist in the old stores, so they are `null`/`0`/`1`. Stats start at zero. The
  last-used car is not inferred from the fastest record.
- **Duplicate keys:** v1 and v2 may both contain the same car; the faster time
  wins and the migration count is the number of unique records written.

`load()` returns a `migration` summary with per-key counts and unmapped entries.
The persisted `profile.migration` stores the source key list, the migration
time, the unmapped count and the documented assumptions.

### Save result

`store.save(profile)` validates, reads the stored revision, merges on conflict,
increments `revision`, sets `updatedAt` from the injected clock and writes
canonical JSON. A save with identical content and the same revision returns
`no-change` without a write.

| `code` | meaning |
|---|---|
| `saved` | written, no conflict |
| `saved-merged` | stale base revision; records/stats merged |
| `saved-memory` | no usable storage; values kept for this session |
| `no-change` | identical content; no write |
| `quota-exceeded` | storage full; profile kept in memory; `quota:true` |
| `storage-unavailable` | non-quota storage failure; persistence disabled |
| `read-only` | future schema or unrecoverable corruption |
| `invalid-profile` | caller produced an invalid document; stored bytes untouched |
| `backup-failed` | damaged/newer bytes could not be backed up; nothing overwritten |

## 5. Corruption, quota and concurrency

### Corruption recovery

1. Parse/validate the stored bytes.
2. If invalid, write a backup payload to the first free slot:
   `{ kind: "blur.profile.backup", version: 1, reason, savedAt, raw }`.
3. Only after the backup succeeds, write a fresh typed profile to the main key
   and return `reset: true`.
4. If the backup cannot be written (quota, blocked storage, all three slots
   full), **do not overwrite** the damaged bytes. Return `readOnly: true` and
   `reset: false`; the shell must offer a backup/retry, not a silent reset.
5. A backup is never overwritten by a later corruption. Slots fill `.backup`,
   `.backup.1`, `.backup.2`; the third failure is reported honestly.

A newer `schemaVersion` is a separate case: it is not corrupt. It is returned as
`future-schema` with `profile: null` and `readOnly: true`. The only way to
replace it is an explicit `reset({ force: true })` or `save(..., { force: true })`,
and both back up the newer document first.

### Quota

`localStorage.setItem` can throw `QuotaExceededError` (name/code 22/1014 or a
message containing "quota"). The store:

1. retries after removing the oldest profile backup slot (never the main key,
   never the ghost store, never legacy keys);
2. if a retry succeeds, returns `ok: true`, `quota: true`, `freedBackup`;
3. if every retry fails, keeps the new profile in memory, marks `dirty`, and
   returns `ok: false, code: "quota-exceeded", persisted: false, quota: true`;
4. `load()` in that session returns `loaded-memory` so the race result is not
   lost; the shell retries `save()` after the player frees space.

Non-quota failures (`SecurityError`, blocked storage) disable persistence for
the session and degrade to `saved-memory`; they never throw into the race loop.

### Concurrent tabs

`revision` is the concurrency token. Every persisted save writes
`max(storedRevision, candidate.revision, current.revision) + 1`, so revisions
are monotonic even after a failed write. A stale save (`baseRevision` differs)
is merged by default:

- records: faster `bestTimeSeconds` wins; on a tie the incoming record wins;
- `runs` takes the **maximum**, not the sum, so the same run replayed through a
  stale tab is not double-counted;
- `lastTimeSeconds`/`lastDate` take the incoming last run;
- stats: `max(races)`, `max(wins)`, then `wins = min(wins, races)`;
- settings/progress/extra: incoming (last writer wins);
- `revision` becomes stored + 1.

`save(..., { strategy: "replace" })` is the explicit whole-document overwrite
used by `reset`. There is no locking and no cross-tab event; a tab observes a
conflict only when it saves.

## 6. Determinism

- `serializeProfile` is canonical JSON with recursively sorted keys.
- No clock, locale, random value or `toFixed` locale behaviour is used inside
  serialisation. `save()` injects `updatedAt`; tests inject a fixed clock.
- `profileFingerprint` is FNV-1a-64 of the canonical bytes (`fnv1a64:…`).
- Repeated runs of the suite produce byte-identical `_work/profile/tests.json`.
- `estimateProfileBytes` reports `{ characters, bytesApprox }`; localStorage
  usually stores UTF-16 code units, so `bytesApprox = characters × 2`.

## 7. Integration contract for `e1-drive` / shell

The shell must not type a key or a failure code. Import the constants/helpers
from `probes/profile/profile.mjs`; `probes/profile/contract.json` mirrors them
for non-JS tooling.

### Exact keys

| constant | value |
|---|---|
| `PROFILE_STORAGE_KEY` | `blur.profile.v1` |
| `PROFILE_BACKUP_KEY` | `blur.profile.v1.backup` |
| `PROFILE_SCHEMA_VERSION` | `1` |
| `GHOST_STORE_KEY_PREFIX` | `e1-drive.sprint.ghost.v1.` |
| `GHOST_INDEX_URL` | `/ghosts/index.json` |
| namespace form | `blur.profile.v1.<namespace>` |

### Save triggers

| event | call | notes |
|---|---|---|
| settings control commits | `updateSettings(patch)` | debounce slider input; save on change/close, not every `input` event |
| car/map/mode confirmed | `setProgress({ lastCar, lastMap, lastCourse, lastMode })` | one call per confirmation |
| race FINISH | `submitResult({ map, course, mode, car, timeSeconds, lapTimes, bestLapSeconds, win, online, ghost, date })` | exactly once per finish; `online: true` in a room |
| ghost accepted | `submitResult(... ghost: ref)` | after the ghost store accepted a faster clean run; see §8 |
| reset confirmed | `reset({ keepSettings, keepStats })` | default removes legacy keys after a successful write |

`submitResult` is atomic from the caller's point of view: stats, progress and
the record are updated in one document and one save. A quota failure still
returns the updated in-memory profile and `recorded: true`; the result panel
must not discard it.

**Compatibility with the existing shell schema.** `probes/ui-screens/screens.mjs`
already declares the same profile-scoped paths (`quality`, `volumes.*`, `muted`,
`cameraMode`, `steer`, `inputBindingsRef`, `hud.*`). Its
`settingsValuesToProfilePatch()` output is a valid `updateSettings()` patch. Its
error catalog already maps `quota-exceeded`, `read-only`, `corrupt-json` and
`future-schema` (`PROFILE_QUOTA_EXCEEDED`, `PROFILE_READ_ONLY`, `PROFILE_CORRUPT`,
`VERSION_MISMATCH`). When both exist, the shell catalog is authoritative for
copy; this table defines the required severity and action.

### What the UI must show on failure

The exact strings live in `contract.json` → `failureUi`; the shell may translate
them, but the level and action must not change.

| code | level | required message | action |
|---|---|---|---|
| `quota-exceeded` | error | “Progress could not be saved: browser storage is full.” | Retry after freeing space; keep session values |
| `storage-unavailable` | warning | “This browser is blocking local storage; progress will not survive a reload.” | Continue |
| `saved-memory` | warning | “Progress is kept for this session only.” | Continue / retry |
| `future-schema` | error | “This profile was written by a newer build and was not loaded.” | Update; never save over it |
| `read-only` | error | “The profile is read-only because it could not be recovered safely.” | Backup / Reset |
| `corrupt-json` / `invalid-schema` | warning | “The saved profile was damaged and has been reset. A backup was kept.” | Continue; show `backupKey` |
| `backup-failed` | error | “The profile could not be backed up, so it was not overwritten.” | Retry after freeing space |
| `invalid-profile` | error | “The game produced an invalid profile and the save was refused.” | Report; stored profile untouched |

The race, pause and results screens never block on storage: a failed save is a
banner, not an exception. The boot/settings screen may block a reset behind the
confirmation dialog.

### Ghost reference → ghost index

A profile record never stores the ghost body (44 B/tick base64). It stores a
pointer with the same hashes the ghost index already uses:

```text
records[<map>/<course>/<mode>/<car>].ghost = {
  source: "reference" | "local",
  storageKey: "e1-drive.sprint.ghost.v1.<course>" | null,
  indexUrl: "/ghosts/index.json" | null,
  file, sha256, hash, layoutHash, timeSeconds, finishTick, tickCount
}
```

- **Reference ghost:** `ghostReferenceFromIndex(indexEntry)` copies `file`,
  `sha256`, `ghostHash` → `hash`, `layoutHash`, `timeSeconds`, `finishTick`,
  `tickCount` from `/ghosts/index.json`. The consumer must re-hash the fetched
  bytes against `sha256`, decode the record and re-hash it against `hash`, then
  require `layoutHash` to equal the active layout. A mismatch is rejected, not
  replayed.
- **Local ghost:** the existing `e1-drive.sprint.ghost.v1.<course>` store keeps
  the payload. The profile pointer uses `source: "local"` and `storageKey`; it
  must not copy the sample payload into the profile.
- If no verified ghost exists, `ghost: null`; the UI says “no ghost for this car
  and course” instead of inventing a pose.
- The existing ghost key is per course, not per map. The profile pointer adds
  `map`, `course`, `mode` and `car` in the record key, so a future per-map ghost
  store can migrate without changing the profile schema.

## 8. Tests

Command (bundled Node):

```powershell
& "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe" probes/profile/tests.mjs
```

Recorded result (8 November 2026):

- **57 cases, 415 assertions, 57 passed, 0 failed.**
- `_work/profile/tests.json` — deterministic report; repeated runs have the same
  SHA-256 (`A094E39265FE2B87C0222FB4F5467526C7C5989ADD2852CD117D5752361F38C5`).
- Log: `_work/logs/profile/profile-tests.log`.

Coverage:

| area | cases |
|---|---|
| defaults, strict validation, partial repair, enums/ranges, stats, extra roundtrip | 11 |
| canonical serialisation, key order, fingerprint, size estimate | 4 |
| fresh/load/save roundtrip, no-change, revision | 5 |
| record keys, record repair/drop, ghost reference validation | 6 |
| legacy v1/v2/v3, `bestTime`, unmapped, idempotence, namespaces | 7 |
| corrupt JSON/schema, invalid section container, backup slots, no-slot read-only, future schema, damaged-store save | 7 |
| quota, quota retry, non-quota failure, read failure | 4 |
| concurrent tabs, stale record | 2 |
| submitResult (sprint/lap/online/ghost/rejections) | 5 |
| reset, keep sections, namespaced stores, guest isolation, delete | 5 |
| contract constants | 1 |

The suite uses only Node built-ins and an in-memory storage shim. It does not
run a browser and does not claim browser behaviour; the module has no browser
global at import time, which is checked by running it under Node.

## 9. Limits and non-claims

- **localStorage only.** No account, cloud sync, leaderboard or encryption. Any
  script on the origin can read the profile; it contains no secrets.
- **One browser profile, one origin.** Two different browsers or origins have
  separate data. A namespace is a local slot, not a login.
- **No automatic settings application.** The store persists values; the shell
  must apply quality/volumes/camera/steer/HUD when it boots and on change.
- **No map/car registry coupling.** Map and car are slug-validated only, so a
  typo is a valid slug until the shell resolves it. The shell should reject an
  unknown id before saving.
- **No ghost body.** Only a verified pointer is stored. The consumer is
  responsible for re-hashing the ghost bytes; the profile alone cannot prove a
  ghost is authentic.
- **Quota recovery is bounded.** It removes profile backups only, never the
  ghost store or legacy keys. A full origin with no backups still fails.
- **Concurrency is last-write-wins for settings/progress.** There is no
  per-field merge or vector clock; only records/stats merge. `runs` takes the
  maximum, not the sum.
- **Clock is wall time.** `updatedAt` can go backwards if the system clock does;
  `revision` is the ordering token.
- **Dates are UTC ISO-8601 with `Z`.** No locale text, no timezone table.
- **Legacy migration is finite.** Only the listed keys are read. A bare
  `bestTime` number is reported unmapped; no car is guessed. Free-roam legacy
  entries are skipped because free roam has no finish.
- **Schema v1 only.** A newer schema is read-only; a downgrade requires an
  explicit forced reset that backs up the newer document first.
- **No browser capture.** This task is a Node module and suite; visual/browser
  behaviour is out of scope until the shell wires the store into the page.

## 10. Files and evidence

| path | content |
|---|---|
| `probes/profile/profile.mjs` | schema, validation, migration, store, merge, ghost reference — SHA-256 `528487FCD8CBC6A13353B3BEC57E57980C0D9DB6A4851ABA77EA65C1BA852416` |
| `probes/profile/tests.mjs` | 57 cases / 415 assertions — SHA-256 `BF23BD45CF829AECC15FED311652D06E12E1CBCD914A954BEFDC180AF5D7CAE3` |
| `probes/profile/contract.json` | machine-readable keys, save triggers, failure UI, ghost link — SHA-256 `2692DE69721DB89184FD5BC11BF052FEDF6044E24793E36D8081CF31F3C932DC` |
| `probes/profile/README.md` | quick usage |
| `_work/profile/tests.json` | test report and counts — SHA-256 `A094E39265FE2B87C0222FB4F5467526C7C5989ADD2852CD117D5752361F38C5` |
| `_work/logs/profile/profile-tests.log` | captured run |
| `docs/work/analysis/profile-store.md` | this record |
