# Race replay — format, measured sizes and integration contract

**Date:** 8 November 2026
**Status:** probe implementation + measured self-test. The replay is not wired
into `e1-drive`; §7 is the contract the main agent can integrate.
**Scope labels:** `engineIntegration:false`, `e1DriveModified:false`,
`retailReplayFormat:false`, `sampleRateHz:20`, `engineTickHz:60`,
`multiCar:'2..8'`, `seekable:true`, `powerupsRecorded:'events-only'`,
`authority:'host-recording'`, `antiCheat:false`.

This probe only creates/modifies `probes/replay/**`, `_work/replay/**`,
`_work/logs/replay/**` and this document. `probes/e1-drive/**`,
`probes/net-mvp/**`, `tools/`, `upstream/` and `game-data/` were not modified.
No browser capture was run and no commit was made.

---

## 0. Result summary

| Gate | Result | Evidence |
|---|---|---|
| Replay self-test | **431/431 assertions, 0 failures** | `_work/replay/selftest.json` |
| Deterministic repeat | two runs produced a byte-identical report | `_work/logs/replay/selftest.log` |
| 2/4/8 cars at 20 Hz | **34.6 / 67.0 / 132.0 kB/min** base channels | §5 |
| Raw JSON comparison | replay is **7.5%** of the raw snapshot stream | §5 |
| Ghost comparison | 8-car replay is **31.2%** of the 20 Hz ghost payload and **10.4%** of the 60 Hz ghost payload | §5 |
| Positional error | **4.883e-4 m** per axis, **8.251e-4 m** Euclidean max | §4 |
| Rotation error | **3.198e-5 rad** max | §4 |
| Seek | index seek equals full sequential decode at every sampled/block-boundary tick | §6 |
| Corruption / version / build rejection | 21 integrity/negative checks pass | §6 |
| Report hash | `sha256:f56d5a419fbfa45bbe5e96f8a13df6f3c430a7193f7b0329d5f1ca2461b2c1ce` | `_work/replay/selftest.json → suiteHash` |

---

## 1. What a replay is

A replay is a **recording of one completed race**, not a second simulation:

- every participant (humans and host-simulated AI) at a fixed 20 Hz sample rate
  (one sample every 3 engine ticks at 60 Hz);
- the transform the host emitted for that participant at that tick, quantised
  and delta/RLE compressed;
- an optional extended channel set (velocity, four wheel angles, steer,
  health, shield) when the source provides it;
- a tick-stamped event stream (pickup, hit, wreck, respawn, lap, finish);
- the shared result table produced by the same `buildMpResult` path both pages
  already use;
- hashes that bind the recording to the build, map, layout, physics and each
  car.

It contains no input stream, no physics state and no engine code. A client can
seek and render it; it cannot re-simulate, react or collide.

Input snapshot shapes accepted by the recorder are the host shapes, unchanged:

```js
{ tick, position:[x,y,z], quaternion:[x,y,z,w], speed }          // single car
{ tick, cars:[{ id, tick, position, quaternion, speed }] }        // N-slot relay
```

A car sample may additionally carry `velocity:[3]`, `wheel:[4]` (corners
`frontleft, frontright, backleft, backright`), `steer`, `health` and `shield`.
A participant that declares a channel must declare it on every sample; the
recorder rejects a channel set that changes mid-recording instead of filling a
guessed value.

---

## 2. Format (version 1)

The file is one JSON object (`blur.race-replay/1`). Metadata, events and the
result are JSON; the sample stream is one base64 blob. The canonical hash covers
everything except `hash` itself.

### 2.1 Header

| field | meaning |
|---|---|
| `kind` | `"blur.race-replay"` |
| `version` | `1` |
| `schema` | `"blur.race-replay/1"` |
| `generator` | `"probes/replay/replay.mjs"` |
| `createdAt` | host-supplied timestamp; part of the hash |
| `tickHz`, `engineTickHz` | sample rate (20) and engine tick rate (60) |
| `firstTick`, `lastTick`, `sampleCount` | engine-tick range and number of 20 Hz samples |
| `map` | `{ id, hash }` supplied by the host |
| `labels` | recording scope labels, e.g. `retailReplayFormat:false`, `guestPose:"latest-received"` |
| `hashes` | `{ build, map, layout, physics, cars:{ participantId: carHash } }` |
| `participants` | `[{ id, slot, car, carHash, channels, sampleCount }]` |
| `result` | shared result object with `winnerId` and `rows[]` (`id`, `position`, `status`, `finishTick`, `timeSeconds`) |
| `events` | tick-sorted event objects |
| `quantisation` | scale and max error per channel |
| `encoding` | body encoding, index block size, raw/body/sample/index byte counts |
| `body` | base64 sample stream |
| `hash` | `sha256:<hex>` canonical hash |

`result.rows[].status` is one of `finished`, `dnf`, `disconnected`, `left`.
A DNF row keeps `finishTick:null` and `timeSeconds:null`; no time is invented.

### 2.2 Per-tick car record

A sample stores only quantised integers:

| channel | width | stored form | scale | max error |
|---|---:|---|---:|---:|
| position | 3 | m | 1024 | 4.883e-4 m |
| quaternion | 4 | unit components (x,y,z,w) | 32767 | 1.526e-5 quantum; 1.596e-5 measured after decode |
| speed | 1 | m/s | 100 | 5.0e-3 |
| velocity | 3 | m/s | 100 | 5.0e-3 per component |
| wheel | 4 | rad | 1000 | 5.0e-4 |
| steer | 1 | rad | 10000 | 5.0e-5 |
| health | 1 | points | 10 | 0.05 |
| shield | 1 | points | 10 | 0.05 |

The first sample of every participant and every index block is stored
**absolute**; other samples store **differences** from the previous sample of
the same participant. Quaternions are sign-aligned to the previous sample
(`dot < 0` is negated) before quantisation, so a component delta stays small
and the recorded rotation is continuous.

### 2.3 Sample stream

```text
varint participantCount
for each participant:
  varint sampleCount
  varint blockCount
  blockCount x { varint absoluteTick, varint byteOffset }
  varint sampleByteLength
  sampleByteLength bytes
```

One sample:

```text
varint head
  head == 0   repeat the previous sample, then varint repeatCount
  head == 1   absolute sample, then varint absoluteTick
  head >= 2   delta sample, tickDelta = head - 2
channel values in header channel order (position, quaternion, speed,
velocity, wheel, steer, health, shield)
```

The repeat form is RLE over identical consecutive quantised samples with the
same tick spacing. Because a block boundary is always absolute, a run can never
cross a seek anchor.

### 2.4 Event stream

Event types are `pickup`, `hit`, `wreck`, `respawn`, `lap`, `finish`. An event is
`{ tick, type, participantId?, targetId?, ...payload }`; ids must exist in the
participant list, ticks must lie inside the recorded range, and events are
sorted by tick with stable insertion order. The payload is carried verbatim
(e.g. `pickup`, `damage`, `source`); the format does not reinterpret it.

### 2.5 Index and seeking

Every `INDEX_BLOCK_SAMPLES = 32` samples is absolute and appears in the index as
`{ absoluteTick, byteOffset }` inside the participant's sample bytes. A seek:

1. clamps the requested engine tick to `[firstTick, lastTick]`;
2. binary-searches the last block at or before it;
3. decodes at most 32 samples from that anchor (or walks a repeat run
   arithmetically);
4. returns the exact sample at or before the tick, or an interpolated frame for
   rendering.

No extrapolation is used: past `lastTick` the last sample is held and `ended` is
set.

### 2.6 Hash and validation

`hash = sha256(canonicalJson(record without hash))`. Canonical JSON sorts object
keys recursively. `validateReplay(replay, expected)` checks structure, version,
participants, events, result, body length, seek-block ordering, byte accounting
and the hash, then compares `expected.buildHash|mapHash|layoutHash|physicsHash`
and every `expected.carHashes[id]`.

Rejections are typed strings: `REPLAY_VERSION_MISMATCH`,
`REPLAY_BUILD_MISMATCH`, `REPLAY_MAP_MISMATCH`, `REPLAY_LAYOUT_MISMATCH`,
`REPLAY_PHYSICS_MISMATCH`, `REPLAY_CAR_MISMATCH`, `REPLAY_HASH_MISMATCH`,
`REPLAY_CORRUPT`, `REPLAY_TRUNCATED`, `REPLAY_BAD_BASE64`,
`REPLAY_PARTICIPANT`, `REPLAY_TICK_ORDER`, `REPLAY_EVENT`, `REPLAY_RESULT`.
`loadReplay()` throws `ReplayError('REPLAY_REJECTED')` with every problem; the
caller must not start playback on a rejection.

The hash is an integrity check, not a signature. It proves the file matches the
build manifest; it does not prove a peer did not fabricate a legal-looking race.

---

## 3. Recorder and player API

```js
import {
  ReplayRecorder, ReplayPlayer, ReplayReader, loadReplay,
  validateReplay, replayHash, replaySize, measureReplayError
} from '/replay/replay.mjs';

const recorder = new ReplayRecorder({
  tickHz: 20,
  engineTickHz: 60,
  map: { id, hash },
  hashes: { build, map, layout, physics },
  participants: [{ id, slot, car, carHash }],
  labels: { retailReplayFormat: false, sampleSource: 'host-20Hz-snapshot' },
  createdAt: room.startedAt
});

recorder.capture(snapshot);        // host shape, tick order, no gaps
recorder.addEvent(event);
recorder.setResult(sharedResult);
const replay = recorder.build();   // immutable JSON record + hash

const player = new ReplayPlayer(replay, expectedManifest);
player.seek(tick);                 // exact sample at or before the tick
player.playbackRate = 0.5;         // (0, 8]
player.play(); player.pause();
player.advance(1 / 60);            // seconds × rate × 60 engine ticks
const frame = player.sampleAt(tick); // interpolated cars for rendering
const events = player.eventsBetween(fromTick, toTick);
```

`ReplayReader` also exposes `stateAt(tick, {interpolate})`, `sampleAt(id, tick)`
and `allSamples(id)`; `measureReplayError(rawStream, replay)` computes the
measured bounds in §4 from the recorder's raw input (`keepRaw:true`).

The recorder rejects a tick that moves backwards, an unknown or missing
participant, a non-finite value, a channel set that changes and a result row for
an unknown participant. It never fills a missing car from the previous sample.

---

## 4. Measured error vs the raw values

All numbers are from the 431-assertion self-test over 1,200 samples per
recording (2/4/8 cars, 60 s) and the 8-car extended-channel run. Error is
measured by decoding the replay and comparing every car sample with the raw
snapshot that produced it.

| quantity | max measured | stated bound |
|---|---:|---:|
| position per axis | **4.882606e-4 m** | 4.883e-4 |
| position Euclidean | **8.250856e-4 m** | 8.454e-4 (√3 × axis) |
| quaternion component | **1.596323e-5** | 2.0e-5 after renormalisation |
| quaternion rotation angle | **3.197774e-5 rad** | 1e-4 |
| speed | **4.998619e-3 m/s** | 5.0e-3 |
| velocity Euclidean | **8.500486e-3 m/s** | 8.661e-3 |
| wheel angle | **4.923390e-4 rad** | 5.0e-4 |
| steer | **4.999876e-5 rad** | 5.0e-5 |
| health | **0.030 points** | 0.05 |
| shield | **0.030 points** | 0.05 |

The Euclidean positional error is **0.00027% of the 310 m course**
(8.25e-4 / 310 = 2.66e-6). The rotation error (3.2e-5 rad) is far below one
degree (1.75e-2 rad); health/shield quantum is 0.1 points, so a 0.03 max is
expected for the synthetic fractional values.

---

## 5. Measured size at 20 Hz

60 s of synthetic race data, 1,200 samples, base channels
`position+quaternion+speed` unless marked extended. Raw JSON is the
`JSON.stringify` of the exact snapshot stream the host would have sent. "Ghost
20 Hz" is the ghost payload (44 B/tick/car) at the replay's 20 Hz sample rate;
"Ghost 60 Hz" is the real 44 B per engine tick. Both are per minute.

| recording | cars | raw JSON | replay | replay/raw | replay/car | ghost 20 Hz | ghost 60 Hz | replay/ghost20 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base 2 | 2 | 463,249 | **34,554** | 7.5% | 17,277 | 105,600 | 316,800 | 32.7% |
| base 4 | 4 | 898,685 | **67,017** | 7.5% | 16,754 | 211,200 | 633,600 | 31.7% |
| base 8 | 8 | 1,766,435 | **131,998** | 7.5% | 16,500 | 422,400 | 1,267,200 | 31.2% |
| extended 8 | 8 | 3,737,970 | **301,800** | 8.1% | 37,725 | 422,400 | 1,267,200 | 71.4% |
| base 8, no RLE | 8 | 1,766,435 | 140,024 | 7.9% | 17,503 | 422,400 | 1,267,200 | 33.1% |

All figures are bytes per minute and include the base64 expansion, JSON header,
event stream, result and seek index. Sample bytes are 23,501 / 47,000 / 94,027 /
220,978; index bytes are 305 / 609 / 1,217 / 1,345. The header and index are
below 2 kB even at 8 cars.

Compression contribution:

| variant (8 cars, base) | sample bytes | vs absolute |
|---|---:|---:|
| absolute varint, no delta/RLE | 173,907 | — |
| delta, no RLE | 100,027 | 42.5% smaller |
| delta + RLE (shipped) | 94,027 | **45.9% smaller** |
| RLE gain over delta-only | 6,000 B/min body; 8,026 B/min file | 5.7% of the file |

The test's 1.5 s grid hold is what RLE exploits; a race with no repeated pose
would fall back to the delta-only figure (140 kB/min at 8 cars), still 7.9% of
raw and 33.1% of the 20 Hz ghost payload.

Reading of the comparison:

- the same 8 cars at 20 Hz cost **~2.2 kB/s** raw replay traffic on disk;
  a 60 s race is 132 kB;
- the ghost stores 44 B per car per **engine tick** (60 Hz), so eight cars cost
  1.27 MB/min; the replay is 10.4% of that and additionally contains every car,
  events and the result;
- even the extended recording (velocity, wheel, steer, health, shield) is
  smaller than the 20 Hz ghost payload and 4.2× smaller than the 60 Hz ghost.

---

## 6. Tests and evidence

### 6.1 Command

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
& $node probes/replay/selftest.mjs
```

### 6.2 Result

```text
checks 431 passed 431 failed 0
suiteHash sha256:f56d5a419fbfa45bbe5e96f8a13df6f3c430a7193f7b0329d5f1ca2461b2c1ce
position axis max 4.883e-4 m
quaternion angle max 3.198e-5 rad
base2  2 cars  34,554 B/min  raw 463,249  ghost20 105,600
base4  4 cars  67,017 B/min  raw 898,685  ghost20 211,200
base8  8 cars 131,998 B/min  raw 1,766,435 ghost20 422,400
ext8   8 cars 301,800 B/min  raw 3,737,970 ghost20 422,400
```

The 431 assertions cover (group counts from `selftest.json → groups`):

- **Quantisation bounds (77):** position, quaternion component, speed,
  velocity, wheel, steer, health and shield over deterministic random values,
  plus slerp unit-length at five fractions.
- **Build/header/hash (44):** 2/4/8/extended recordings validate against the
  build manifest, the canonical hash recomputes, every hash field and car hash
  is present, tick/sample/participant counts match, events are sorted, the
  result round-trips and scope labels survive.
- **Round-trip and error (96):** every raw car sample is compared; per-axis and
  Euclidean position, quaternion angle/component, speed, velocity, wheel,
  steer, health and shield bounds; decoded ticks; first/last sample positions;
  every participant decodes every sample; all six event types and their
  payloads round-trip.
- **Seek (124):** 4 datasets × 11 targets (sample 0, 1, 31, 32, 33, 63, 64,
  100, 599, 1000, 1199) compare the index path with full sequential decode
  exactly (position, quantised quaternion, speed); first/last clamping;
  idempotence; every car returned; block count `ceil(n/32)`; block tick order;
  first block tick; offsets inside the sample bytes; interpolation sanity.
- **Playback (14):** default rate 1, duration, play/pause, 1×/2×/0.5× cursor
  movement, invalid rate rejection, end clamping/ended flag, event filtering.
- **Validation and corruption (22):** version, build, map, physics and car hash
  mismatches; tampered body byte; truncated body; invalid base64; missing
  participants; event outside the tick range; unknown event type;
  `loadReplay` rejection; non-monotonic capture; missing participant; NaN
  position; bad event/result; build without a result.
- **Determinism (18):** two builds per dataset produce identical JSON, hash and
  body and decode identically; RLE and non-RLE passes are deterministic.
- **Size accounting (31):** sample+index = body, base64 length, header overhead,
  RLE reduction, delta reduction, every replay smaller than raw JSON, 8-car
  replay smaller than ghost payloads, no-RLE replay still valid and decodes to
  the same cars.
- **Single-car host shape (5):** the page's `{tick,position,quaternion,speed}`
  snapshot records, validates, keeps every tick, stays within the position
  bound, round-trips the result and is deterministic.

### 6.3 Determinism

Two consecutive runs produced a byte-identical `_work/replay/selftest.json`
(SHA-256 `A8FC99DB469F0E9456E49AA32B77A7E646D58E928CC1C005CB555766D25F18EC`).
Recorded replay hashes:

| recording | canonical hash |
|---|---|
| base 2 | `sha256:a98fc4846bc4dc8c686e524e7f53208a162b5a402e978952177bd44731515305` |
| base 4 | `sha256:252ca9f9ef348dce27724992bcd4ade9af3b7ee5bfa36eb81fd6ac7206368f41` |
| base 8 | `sha256:4ec1529f93bc48f4f49b1485229bd400b97978edb6b855f7c48e29a0bc831903` |
| extended 8 | `sha256:13c4e33cf1b68ff21a317db8158d5bd8629be6e4f709f88e7610ba7fe372e97a` |

### 6.4 Evidence paths

| path | content |
|---|---|
| `_work/replay/selftest.json` | 431 checks, error bounds, size rows, recording hashes, `suiteHash` |
| `_work/logs/replay/selftest.log` | human-readable run summary |
| `probes/replay/replay.mjs` | format, recorder, codec, index, reader, player, validation |
| `probes/replay/sha256.mjs` | canonical JSON + SHA-256 |
| `probes/replay/selftest.mjs` | the 431-assertion test |
| `probes/replay/README.md` | quick usage |

---

## 7. Integration contract for e1-drive / multiplayer

This section is a contract, not a change. The main agent owns any edit to
`probes/e1-drive/**` and `tools/`.

### 7.1 When the host records

The host page is the only recorder (it already owns rules and the shared
result):

1. **At `room.started`** create one `ReplayRecorder` with the committed build
   hashes, map/layout hash, physics hash, the participant list (`id`, `slot`,
   car slug, committed car hash), `labels` and a `createdAt` taken from the room
   start. Do not create a recorder for a lobby-only page.
2. **At every host snapshot tick that passes the existing 20 Hz gate**
   (`snapshot.tick % 3 === 0` in `mpAfterLocalTick`) call `capture` once with the
   **same tick for every car**:
   - host car: the local engine snapshot used for `mpNetworkState`;
   - guest car: the state the host received **for that same tick**. Buffer local,
     guest and AI states by tick and capture a tick only when every participant
     has a sample for it (normally one 20 Hz packet of extra latency). Never
     substitute the latest received pose for a missing tick, and never shrink or
     stretch the guest tick to the host tick;
   - each AI: the host's authoritative AI simulation state at that tick.
   Use the participant ids already in the room/AI roster (`pl_…`, `ai-1…`).
   Every car's `tick` field, if present, must equal `snapshot.tick`; the recorder
   rejects a mismatch. If a participant's tick never arrives, the host marks the
   replay unavailable with a typed reason rather than filling a pose.
   Label the recording `guestPose:"latest-received"` when the guest pose is a
   20 Hz relay observation; it is the host's view, not guest-authoritative.
3. **Events** are added as the host observes them:
   - `RaceSession`/progress events → `checkpoint` is not in the replay type set;
     map checkpoint/lap/finish/respawn to `lap`, `finish`, `respawn` and keep the
     raw event in the payload (`source:'rules'`, gate/lap fields);
   - power-up model events → `pickup` (grant), `hit` (damage), `wreck`
     (destroyed), `respawn` (power-up respawn or race respawn, distinguished by
     `source`);
   - pass `tick` in engine ticks, including the countdown offset, so seeking
     and the result use the same axis.
4. **At `room.finished`** (after the host's AI finish hold, when AI rows exist)
   call `setResult(sharedResult)` with the same object `buildMpResult` returns on
   both pages, then `build()`. The result is part of the canonical hash.
5. **Never record display-only values:** `?ghostoffset`, camera, remote
   interpolation or a corrected display pose must not enter `capture`.
6. **A race with a restart** should start a new replay (the engine tick axis
   restarts); do not splice two runs.

Minimal in-page shape:

```js
const recorder = new ReplayRecorder({
  tickHz: 20,
  engineTickHz: 60,
  map: { id: mpMap.id, hash: mpMap.layoutHash },
  hashes: { build: buildHash, map: mapHash, layout: layoutHash, physics: physicsHash },
  participants: roster.map((p) => ({ id: p.id, slot: p.slot, car: p.car, carHash: carHash(p.car) })),
  labels: {
    engineIntegration: true,
    retailReplayFormat: false,
    guestPose: 'latest-received',
    aiSimulation: aiCount ? 'host' : 'none',
    powerupsRecorded: 'events-only'
  },
  createdAt: room.startedAt
});

// inside the 20 Hz host snapshot path: frameForTick() returns the buffered
// local/guest/AI states for the same tick, or null when one is still missing
const frame = frameForTick(tick);
if (frame) {
  recorder.capture({ tick, cars: frame.map((car) => ({ ...car, tick })) });
}

// event bridge
recorder.addEvent({ tick, type: 'hit', participantId: attackerId, targetId, damage, source: 'powerup' });
```

The host must also expose a debug/capture hook so the existing browser-capture
tooling can assert the file without a UI click:

```js
window.__replay = {
  last: () => currentReplay,          // validated record or null
  recorder,
  player
};
```

### 7.2 File naming and storage

The host stores the last races locally; nothing is uploaded and no secret is
involved.

- **Primary:** IndexedDB database `blur-replays`, object store `races`
  (`keyPath:'raceId'`), index `byRoom`, index `byCreatedAt`. Keep the newest 5
  replays or 50 MB, whichever comes first. On quota failure delete the oldest
  and retry; if it still fails, keep the record in memory for `last()` and set
  `stored:false` with the error — never pretend it was saved.
- **Fallback:** memory (`window.__replay.last`).
- **File name / race id:**

```text
<UTC compact>-<roomCode>-<mapId>-<cars>p-<hash8>
20261108T143112Z-KUY26-usa_la_river-4p-4ec1529f
```

  `<hash8>` is the first 8 hex chars of the canonical replay hash. The suffix
  makes two races with the same room code distinguishable.
- **Committed reference files** (for tests or a shipped best) may live under
  `probes/e1-drive/replays/<name>.replay.json` with an index that pins the file
  SHA-256 and the canonical replay hash, exactly like the ghost index. That is a
  main-agent change, not this probe.
- **Pointer file** `replays/last.json`:

```json
{ "raceId": "...", "file": "replays/<raceId>.replay.json",
  "room": "KUY26", "map": "usa_la_river", "cars": 4,
  "hash": "sha256:...", "bytes": 67017, "createdAt": "..." }
```

### 7.3 How a client requests the last race

`tools/serve.mjs` (owned by the main agent) should add read-only routes; this
probe does not modify it:

```text
GET /replays/last.json                  -> pointer (404 if none)
GET /replays/<raceId>.replay.json        -> the replay JSON
GET /_replay/last?room=CODE              -> pointer for that room, or 404
```

Rules:

- read-only, no directory listing, no path traversal, `Cache-Control: no-store`
  for `last.json` and a long immutable cache for a hash-named file;
- `404` carries a typed JSON body (`{error:'REPLAY_NOT_FOUND'}`), never an
  empty/partial replay;
- the client fetches the pointer, then the record, and calls
  `loadReplay(replay, manifest)` where `manifest` is the build’s
  `{buildHash,mapHash,layoutHash,physicsHash,carHashes}`. A hash mismatch is a
  typed refusal and playback does not start;
- a guest may request the last race only after `room.finished`; the pointer is
  scoped by room code so a stale room does not show another race.

Client pseudo-flow:

```js
const pointer = await fetch('/_replay/last?room=' + code).then((r) => r.json());
const replay = await fetch(pointer.file).then((r) => r.json());
const player = new ReplayPlayer(replay, buildManifest); // validates + throws
```

### 7.4 UI hooks

Expose the player through the page’s existing HUD/overlay pattern:

| hook | semantics |
|---|---|
| `play()` / `pause()` | start/stop the wall clock; `play()` at the end restarts from `firstTick` |
| `seek(tick)` | exact sample at or before an engine tick; returns the state; marks `ended` at the last tick |
| `sampleAt(tick)` | interpolated frame for rendering (position lerp, quaternion slerp, speed/velocity/wheel/steer lerp, health/shield step) |
| `playbackRate` | `(0, 8]`; 1×, 2×, 0.5× are the intended presets |
| `advance(dt)` | advance the wall clock by `dt`; returns a frame; used by the render loop |
| `eventsBetween(a, b)` | event markers for the timeline |
| `durationSeconds`, `cursorTick` | time/tick readout |

Suggested controls and labels:

- Space = play/pause, `←`/`→` = ±1 s, `Shift+←/→` = ±5 s,
  `,`/`.` = one 20 Hz sample, `1`/`2`/`4` = rate.
- A seek bar from `firstTick` to `lastTick`; event ticks rendered as markers
  from `events`; clicking a marker calls `seek`.
- Render the cars through the existing extra-car draw path (the ghost/remote
  pipeline) with a diagnostic tint and the label
  `REPLAY · <map> · <result> · no collision`. Do not enable local input,
  physics, collision, power-ups, scoring or the live race clock.
- While replaying show `REPLAY` and the replay time; suppress "best time" and
  live delta rows. The replay must not be written back into best times or the
  ghost store.
- Disable the replay UI in a lobby and during a live MP race; enable it on the
  finish screen and from a debug/URL flag (`?replay=last`).

The player never calls the engine, so a UI bug cannot change a result.

### 7.5 Failure and absence

| case | required behaviour |
|---|---|
| no recording (no finish, recorder refused a tick, storage disabled) | replay UI off; show the typed reason; never synthesise a race |
| hash/build/map/layout/physics/car mismatch | `REPLAY_REJECTED`; no playback |
| corrupt/truncated body | `REPLAY_CORRUPT`/`REPLAY_TRUNCATED`; no partial frame |
| older version | `REPLAY_VERSION_MISMATCH`; no migration guess |
| missing participant in a tick | recorder rejects; host marks that race unavailable |
| storage quota | drop oldest, retry; otherwise memory-only with `stored:false` |

---

## 8. Limits and non-claims

1. **20 Hz recording, not 60 Hz.** The replay stores the host's snapshots every
   three engine ticks. Between samples the player interpolates for display; it
   cannot reconstruct an input, a contact or a collision at tick level.
2. **A recording, not an authority.** It has no input, no physics body and no
   collision. It cannot validate fairness; a peer can fabricate a hash-valid
   file if it also fabricates the build hashes.
3. **Host-observed guest pose.** In M1 the guest is peer-simulated and relayed
   at 20 Hz; the replay labels the guest pose `latest-received`, not
   guest-authoritative. Ticks are aligned by buffering, not by rewriting the
   guest tick, and a missing guest tick is never filled.
4. **No power-up state model.** Only the host's event stream is stored; pickups,
   shields, mines and projectiles are not re-simulated. The events are
   informational.
5. **Wheel/steer only when supplied.** The E1 state snapshot has no wheel angle
   (the existing MP remote wheel spin is labelled static). A replay records
   wheel/steer only when the host feeds the local engine's values; missing
   channels stay absent rather than guessed.
6. **Health/shield are held between samples.** They are discrete, so a step
   hold is used instead of a lerp; the max quantisation error is 0.05 points.
7. **Quaternion quantisation.** Components are rounded to 1/32767 and
   renormalised on decode; the measured rotation error is 3.2e-5 rad.
8. **Base64 JSON container.** The sample blob expands by ~33% in base64. HTTP
   gzip/brotli would reduce transfer but was not measured; the reported sizes
   are file bytes.
9. **No retail replay format, no asset bytes.** Message names, fields and event
   types are project definitions.
10. **No browser capture and no e1-drive change in this task.** The probe is
    Node-only and self-contained. The integration contract is §7; it is not
    evidence that the page already records.
11. **Storage bounds.** The tested sizes are 2–8 cars for 60 s; long races grow
    linearly (8-car base ≈ 2.2 kB/s, extended ≈ 5.0 kB/s). Use IndexedDB and the
    50 MB/5-file cap; a 10-minute 8-car base race is ≈ 1.3 MB.
12. **No encryption/signature.** The hash is integrity, not authentication.
13. **One recorder per race.** A restart or a second host writer must start a
    new record; ticks are strictly increasing and gaps are rejected.

---

## 9. Files

```text
probes/replay/replay.mjs      format, quantisation, recorder, codec, index, reader, player, validation
probes/replay/sha256.mjs      canonical JSON + dependency-free SHA-256
probes/replay/selftest.mjs    431-assertion self-test and size report
probes/replay/README.md       quick usage
docs/work/analysis/replay.md  this document
```

Evidence (ignored by Git):

```text
_work/replay/selftest.json        431 checks, bounds, sizes, hashes, suiteHash
_work/logs/replay/selftest.log    run summary
```
