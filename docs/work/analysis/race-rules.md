# Race rules layer — deterministic, standalone M1 rules

**Status:** implemented and verified, 7 November 2026.
**Location:** `probes/race-rules/`.
**Scope:** rules-only module for 2-4 participants; no engine call, no renderer,
no network transport, no retail-parity claim.
**Inputs:** `_work/e1-drive/sprint.json` and `_work/e1-drive/sprint-lap.json`,
read-only.
**Verifier:** `node probes/race-rules/verify.mjs` -> **67/67 checks passed**.

This document records what the race-rules layer implements, how it is
deterministic, what was verified, and how the M1 online race should consume it.
It does not claim that the retail race director, split-line system, damage,
pickups, scoring or network ABI has been ported.

---

## 1. What was built

The probe separates the existing single-car sprint/lap rule surface into five
small modules plus one integration wrapper:

| Module | Public API | Purpose |
|---|---|---|
| `RaceDirector` | phases, `command`, `advance`, `snapshot` | lobby/loading/countdown/running/finished/results, tick clock, ready/start/finish/DNF/disconnect/restart, host authority |
| `CourseModel` | `CourseModel`, `lineCrossing` | ordered gates/laps from the committed layout, projection, ground, crossing, respawn target, provisional grid |
| `ProgressTracker` | `ProgressTracker`, progress events | ordered checkpoints, laps and lap times, best lap, wrong-way, off-course, respawn, finish validation |
| `RespawnPolicy` | `RespawnPolicy` | off-course/below-ground/airborne reasons and last-checkpoint/line target; never a collision barrier |
| `ResultModel` | `ResultModel` | ordered results by laps/checkpoints/progress/time, ties, DNF, disconnect, total and best lap |
| `RaceSession` | `RaceSession` | one-call integration wrapper around the five modules |

`hash.mjs` is a standalone canonical JSON + SHA-256 implementation so the probe
does not import e1-drive, net-mvp, Node crypto or WebCrypto.

### Files created

```text
probes/race-rules/README.md
probes/race-rules/index.mjs
probes/race-rules/hash.mjs
probes/race-rules/course-model.mjs
probes/race-rules/race-director.mjs
probes/race-rules/progress-tracker.mjs
probes/race-rules/respawn-policy.mjs
probes/race-rules/result-model.mjs
probes/race-rules/race-session.mjs
probes/race-rules/verify.mjs
```

No `probes/e1-drive`, `probes/net-mvp`, `probes/prop-collision`,
`probes/asset-reader`, `tools/`, `upstream/` or `game-data/` file was changed.

---

## 2. Data inputs

`CourseModel` accepts the parsed layout, validates `kind/version/courseId`,
recomputes the canonical layout hash and rejects a mismatch. It copies gate and
line metadata but keeps the measured `samples` as a read-only reference; no
geometry is re-derived or duplicated.

| Input | Canonical layout hash | Raw file SHA-256 | Model hash |
|---|---|---|---|
| `_work/e1-drive/sprint.json` | `sha256:9240e9c136059ccd209992999b8570860f99f1bedd4b4ec9ff0a56d5cf8cad53` | `sha256:516647664f7ff3590db457f8685a3d4308b030b86fbf962f0e9bfa708da89e49` | `sha256:e0c4e7c6c04bb0f3a055f262b5a53052913f583cc7d84724eab5aea21bf2dc3e` |
| `_work/e1-drive/sprint-lap.json` | `sha256:167643a9a108bc927d093da2b3d1408d639c1cc4110920511455b68c68ad1f91` | `sha256:153717d52cd7eae1df3693636405fdf757cd14a36f2ecbbf83bd2539a2c3c460` | `sha256:81a2a2bee34f843a4569e54417cab46bd392af3ba0acaca134d043a878f1be54` |

The sprint model exposes:

- `courseId: "310m"`, `mode: "sprint"`;
- 1,245 measured samples, finish arc `300.159666 m`, measured length
  `310.395196 m`;
- four ordered gates: `start`, `checkpoint-1`, `checkpoint-2`, `finish`;
- declared corridor `+/-6 m`, fall `1 m`, airborne `30 ticks`, outside margin
  `1 m`, overshoot `2 m`.

The lap model exposes:

- `courseId: "lap"`, `mode: "lap"`;
- 902 measured samples, three laps of `222.040211 m`;
- `start` and `finish` on the same loop-01 line;
- lap line at `(115.5, 1164)`, heading `1.638873 rad`;
- declared corridor `+/-1.25 m`, fall `1 m`, airborne `30 ticks`, margins `0`.

The committed layout's own labels remain in force: the 310 m sprint is the
defensible M1 point-to-point course, and the loop course keeps its partial
draw-coverage label from the existing e1-drive derivation.

---

## 3. Rule semantics

### 3.1 RaceDirector phases

```text
lobby -> loading -> countdown -> running -> finished -> results
```

- `start` requires the host (by default), 2-4 participants and every participant
  ready. It enters `loading`.
- `loading` consumes `loadingTicks` (default 0) and enters `countdown`.
- `countdown` consumes `countdownTicks` (layout value: 90 at 60 Hz) and emits
  `go`; `raceTick` starts at 0.
- `running` increments `raceTick` once per `advance()`/`step()`. A finish event
  moves the participant to `finished`; a disconnect moves it to `disconnected`
  with `dnf:true`; a timeout moves every remaining runner to `dnf` with reason
  `timeout`.
- When every participant is terminal the phase is `finished`; after
  `resultsDelayTicks` (default 120) it becomes `results`.
- `restart` from finished/results returns to `lobby`, clears readiness and race
  counters, and preserves the roster.

Host authority is explicit in every snapshot:

```json
{
  "hostId": "p1",
  "hostAuthoritative": true,
  "requireHostCommands": true,
  "clientsAcceptHostResult": true,
  "note": "host runs the rules and broadcasts phase/events; clients do not run an independent finish judge"
}
```

`start`, `finish`, `dnf` and `restart` are host-only when `hostAuthority` is on.
A disconnect from the participant itself is accepted; a post-finish disconnect
keeps the valid finish.

### 3.2 Sprint progress

- Gate order is strict. `checkpoint-1` only counts when it is the expected gate;
  a later gate crossed first emits `gate-out-of-order`.
- A finish crossing before both checkpoints emits `finish-blocked`; the
  participant stays `running`.
- Progress is the furthest measured arc reached, clamped to the finish arc.
- The start line is primed without counting a crossing; the first running tick
  is race tick 1.

### 3.3 Loop progress

- The start/finish line is one physical line crossed three times.
- A lap counts only when the line is crossed forward after a full lap of
  accumulated forward travel (`lapDistance >= (lapIndex + 1) * length - 2 m`).
- `lapTimes` are race-clock deltas; `bestLapSeconds` is the minimum.
- Three completed laps set the finish tick and `progress = 1`; a short crossing
  does not count.

### 3.4 Wrong-way and off-course

- Wrong-way: the normalized `forward` (or `velocity`, or position delta) has a
  dot product below `-0.25` with the measured tangent for 30 consecutive ticks.
  One `wrong-way` event is emitted on entry and `wrong-way-cleared` on recovery.
- Off-course: sprint arc before start / past finish (with the declared margins)
  or lateral distance beyond the declared corridor + margin; lap lateral
  distance beyond its corridor. The event carries `outside-corridor`,
  `behind-start` or `past-finish-line` detail.
- Below ground and airborne are separate explicit reasons.

These are post-hoc rule counters. They do not change physics and do not create
an invisible wall.

### 3.5 Respawn

`RespawnPolicy` evaluates, in order, `off-course`, `below-ground`, `airborne`
(and `invalid-state` for a direct non-finite policy call). A respawn event
contains the full reason objects, the observed position and a target:

- sprint: the gate point and heading of the last passed checkpoint, or the
  start line before the first checkpoint;
- lap: the start/finish line point and heading.

The tracker sets `awaitingRejoin`; the caller rebuilds the car and calls
`rejoin(id, state, tick)` before the next step. Repeated respawn events are
suppressed until rejoin. This is a respawn rule, not a collision barrier.

### 3.6 Results

Rows are ordered by:

1. finishers first, by finish tick (total time), then participant id;
2. still-racing participants: laps completed, checkpoints passed, progress,
   then id;
3. DNF participants by the same progress criteria;
4. disconnected participants;
5. left participants.

Equal finish ticks (or equal laps/checkpoints/progress) share a position using
standard competition ranking (`1, 2, 2, 4`) and set `tied:true`. Each row carries
`totalTimeSeconds`, `lapTimes`, `bestLapSeconds`, `lapsCompleted`,
`checkpointsPassed`, `progress`, `finishTick` and the DNF reason. No retail AMAX
score or medal is invented.

---

## 4. Determinism

- No `Date.now`, `Math.random`, `performance.now`, `new Date`, wall clock or
  engine import appears in any rules module. The verifier scans the module
  sources for those tokens (`C12`).
- The only clock is the integer race tick. `RaceDirector` owns it;
  `ProgressTracker` receives it. There is no timer callback and no frame delta.
- All stored geometry, times, progress values and hashes are rounded to 1e-6.
- Hashing uses sorted-key canonical JSON and a dependency-free SHA-256.
- Every scenario is executed twice from a fresh session; final snapshot hash,
  event-log hash and replay hash must match. The two designated replay
  scenarios also compare every per-tick hash (1,376 ticks total).
- Two full verifier runs produced byte-identical `trace.json`, `verify.json` and
  `hashes.json`.

---

## 5. Verification record

### Command

```powershell
node probes/race-rules/verify.mjs
```

### Result

```text
checks: 67 total, 67 passed, 0 failed
traceHash: sha256:54fee9a62428a5290fbbfd18233b0e4cd0a5ee0613bbb8b8b5f2c8e8a215e2ae
```

### Coverage groups

| Group | Checks | What it proves |
|---|---:|---|
| Course (`C01`-`C12`) | 12 | layout hashes, no mutation, mode/gates/lengths, projection round-trip, grid, rejection of unsupported/tampered input, no clock/random/engine import |
| Director (`D01`-`D16`) | 16 | lobby, host/non-host start, readiness, minimum size, loading/countdown/GO timing, timeout DNF, disconnect, results, restart, authority flags, host-only finish, finish retention, lobby leave, lobby join |
| Sprint progress (`P01`-`P14`) | 14 | ordered checkpoints, finish validation, skipped checkpoint, out-of-order gate, wrong-way, off-course, respawn targets, rejoin suppression, below-ground, airborne, no invisible walls, non-finite rejection, missing-contact transparency |
| Lap progress (`L01`-`L06`) | 6 | full-loop lap counting, three-lap finish, lap times/best lap, short crossing rejection, lap respawn target, one lap is not a finish |
| Results (`R01`-`R07`) | 7 | finish order, ties, DNF/disconnect ordering, total/best lap, hash stability, laps/checkpoints/progress ranking |
| Scenarios (`S-*`) | 12 | sprint/lap with 2, 3 and 4 participants, double-run replay equality, 1,376 per-tick hashes, restart to lobby and running |

### Scenario results

| Scenario | Course | Participants | Outcome |
|---|---|---:|---|
| `sprint-2p` | 310 m | 2 | p1 5.016667 s, p2 6.016667 s |
| `sprint-3p` | 310 m | 3 | p1/p2/p3 at ticks 301/328/361 |
| `sprint-4p` | 310 m | 4 | p1/p2/p3/p4 at ticks 301/322/347/376 |
| `lap-2p` | loop-01 | 2 | p1 11.116667 s (best 3.7 s), p2 12.116667 s |
| `lap-3p` | loop-01 | 3 | p1/p2/p3 at ticks 667/727/800 |
| `lap-4p` | loop-01 | 4 | p1/p2/p3/p4 at ticks 667/714/769/833 |
| `tie` | 310 m | 2 | both position 1, tie group |
| `sprint-dnf-3p` | 310 m | 3 | finished, DNF, disconnected |

### Key hashes

| Object | Hash |
|---|---|
| Sprint layout | `sha256:9240e9c136059ccd209992999b8570860f99f1bedd4b4ec9ff0a56d5cf8cad53` |
| Lap layout | `sha256:167643a9a108bc927d093da2b3d1408d639c1cc4110920511455b68c68ad1f91` |
| Sprint CourseModel | `sha256:e0c4e7c6c04bb0f3a055f262b5a53052913f583cc7d84724eab5aea21bf2dc3e` |
| Lap CourseModel | `sha256:81a2a2bee34f843a4569e54417cab46bd392af3ba0acaca134d043a878f1be54` |
| `sprint-3p` final / replay | `sha256:4331248e36bcd9c9aa72eb8a4a01ace831c6dcf429c5de4a2d9257341898f48b` / `sha256:e0f9b5fb0cf5f8f555c1a060ff4120c8659e5f324c9f5295cf6c414b0a8151b7` |
| `lap-4p` final / replay | `sha256:2a713f161da42243a83ed0ce1101d5889c502703e2d96fa2514aa57160113360` / `sha256:4e52ed83aac5c08ecc2ca1054f3ed90a8d0e874d800c48b493bed01078a83642` |
| Full trace | `sha256:54fee9a62428a5290fbbfd18233b0e4cd0a5ee0613bbb8b8b5f2c8e8a215e2ae` |

Evidence file hashes at report time:

| File | SHA-256 |
|---|---|
| `_work/race-rules/trace.json` | `69A715BF016DD4A63F6C6CAC1111B2761CD0F550560993A1CBECC97787ABBFA4` |
| `_work/race-rules/verify.json` | `498C30878A8343AAF3E2B8541B5666CBA4C42860ED98267E3D0E1F3A06A93B91` |
| `_work/race-rules/hashes.json` | `867B3CACC6802B5218232992C36C7E5DA7F34D8458CC3369396947CB0A87D977` |

### Outputs

| Evidence | Path |
|---|---|
| Full trace, scenario events, results, per-tick hashes | `_work/race-rules/trace.json` |
| Check-by-check result and counts | `_work/race-rules/verify.json` |
| Compact hash table | `_work/race-rules/hashes.json` |
| Human-readable check log | `_work/logs/race-rules/verify.log` |

---

## 6. M1 integration recipe

The existing M1 design is host-authoritative simulation with a room service and
WebSocket snapshots. The rules layer plugs in at the host's fixed tick:

1. Room creates a `RaceSession` with the committed layout JSON and the stable
   participant roster (`2-4` ids). The first/host id is passed as `hostId`.
2. Lobby messages map `ready` to `session.command({type:'ready', from, ready})`.
   The host presses start: `session.command({type:'start', from:hostId})`.
3. Each authoritative 60 Hz tick after the engine step:
   ```js
   const events = session.step({
     [playerId]: {
       position: [x, y, z],
       forward:  [fx, fy, fz],   // or velocity
       contact:  onGround
     }
   });
   ```
4. The host broadcasts `session.director.snapshot()` (phase, `raceTick`,
   authority, participants), the rule events, and at 20 Hz the existing pose
   snapshot. Clients render and accept the host phase/result; they do not run a
   second judge.
5. On a respawn event the host rebuilds the car at the returned target and calls
   `session.progress.rejoin(id, state, session.raceTick)` before the next step.
6. On disconnect, the room sends `{type:'disconnect', from:id}`. A reconnect
   within the room's window returns the same slot; the rules layer does not
   implement late join after start.
7. At `finished`/`results`, render `session.snapshot().results` (position, total
   time, best lap, DNF/disconnect). Restart sends `{type:'restart', from:hostId}`
   and returns to the lobby.

`RaceSession.snapshot()` already contains `course`, `grid`, `director`,
`progress` and `results`. `RaceSession.hash()` is the deterministic host state
hash; `RaceSession.replayHash()` additionally covers the ordered event log.

---

## 7. Tuning and provenance

Layout-declared values (read from the committed documents):

- corridor half-width, fall-below-ground, airborne ticks, outside/overshoot
  margins, countdown ticks, lap count and lap length.

Project-specific values, labelled `provisional` / `source: provisional`:

- start grid: 2.2 m spacing, 5.0 m rows, 2 per row, label `provisional`;
- wrong-way: dot threshold `-0.25`, 30 consecutive ticks;
- lap crossing tolerance: 2 m;
- director: loading 0 ticks, results delay 120 ticks, timeout 18,000 ticks,
  minimum 2 / maximum 4 participants.

The start grid is explicitly not a recovered retail start-position table. The
layout points and headings are measured; the grid offsets are not.

---

## 8. Limits and non-claims

- Rules only. No physics step, engine import, renderer, asset reader or network
  transport is implemented or claimed.
- Synthetic participant motion is arc interpolation on the measured centre line.
  It proves rule determinism, not vehicle physics or lap-time balance.
- The 310 m sprint is the M1-ready course. The loop-01 lap course keeps the
  existing e1-drive partial draw-coverage label; it is a rules test course, not
  a claim that the full loop is visually complete.
- No retail split-line, race-director, damage/health/wreck, pickup, scoring,
  rubber-banding, AI, profile or results-table behaviour is claimed.
- Late join after start and reconnection state transfer are room-layer work; the
  rules layer only accepts commands and authoritative states.
- The verifier uses synthetic states, not the wasm engine. M1 must still prove
  host/client finish equality with real engine states in the integration gate.

---

## 9. Evidence paths

| Evidence | Path |
|---|---|
| Module entry point | `probes/race-rules/index.mjs` |
| Probe README / API | `probes/race-rules/README.md` |
| Verifier | `probes/race-rules/verify.mjs` |
| Trace + events + tick hashes | `_work/race-rules/trace.json` |
| Check results | `_work/race-rules/verify.json` |
| Hash table | `_work/race-rules/hashes.json` |
| Log | `_work/logs/race-rules/verify.log` |
| Committed layouts | `_work/e1-drive/sprint.json`, `_work/e1-drive/sprint-lap.json` |
| Existing rules reference | `probes/e1-drive/web/sprint-rules.js`, `sprint-layout.js` |
| Game-logic audit | `docs/work/analysis/game-logic-audit.md` |
| M1 design | `docs/plan/M1_ONLINE_RACE.md` |
