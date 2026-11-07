# Race rules probe

Status: implemented and verified, 7 November 2026. Rules-only module: no engine,
renderer, asset-reader or network claim.

This probe is the standalone, multiplayer-ready race-rules layer for the M1
online race. It consumes the committed measured layouts read-only and turns
synthetic or engine-reported vehicle states into deterministic phases, ordered
checkpoints, laps, respawns, finishes and results for 2-4 participants.

## Scope labels

| Label | Value |
|---|---|
| `rulesOnly` | `true` |
| `engineIntegration` | `false` |
| `renderer` | `false` |
| `network` | `false` |
| `retailParity` | `false` |
| `assetReaders` | `false` |

`probes/e1-drive`, `probes/net-mvp`, `probes/prop-collision`,
`probes/asset-reader`, `tools/`, `upstream/` and `game-data/` were not modified.

## Inputs (read-only)

| File | Canonical layout hash | Raw file SHA-256 |
|---|---|---|
| `_work/e1-drive/sprint.json` | `sha256:9240e9c136059ccd209992999b8570860f99f1bedd4b4ec9ff0a56d5cf8cad53` | `sha256:516647664f7ff3590db457f8685a3d4308b030b86fbf962f0e9bfa708da89e49` |
| `_work/e1-drive/sprint-lap.json` | `sha256:167643a9a108bc927d093da2b3d1408d639c1cc4110920511455b68c68ad1f91` | `sha256:153717d52cd7eae1df3693636405fdf757cd14a36f2ecbbf83bd2539a2c3c460` |

`CourseModel` recomputes the canonical hash and fails if the layout changed.
Geometry is never duplicated: gates, lines, arcs, samples, ground heights and
the lap line come from the committed document.

## Modules

| File | API | Responsibility |
|---|---|---|
| `hash.mjs` | `hashOf`, `canonicalJson`, `sha256Hex` | dependency-free sorted-JSON SHA-256 |
| `course-model.mjs` | `CourseModel`, `lineCrossing` | ordered gates/laps, projection, ground, crossing, respawn target, provisional start grid |
| `race-director.mjs` | `RaceDirector`, `RACE_PHASE`, `RACE_EVENT` | lobby/loading/countdown/running/finished/results, tick clock, ready/start/finish/DNF/disconnect/restart, host authority |
| `progress-tracker.mjs` | `ProgressTracker`, `PROGRESS_EVENT` | ordered checkpoints, laps/lap times/best lap, wrong-way, off-course, respawn, finish validation |
| `respawn-policy.mjs` | `RespawnPolicy`, `RESPAWN_REASON` | off-course/below-ground/airborne reasons and last-checkpoint/line target; never blocks motion |
| `result-model.mjs` | `ResultModel`, `RESULT_STATUS` | ranking by laps/checkpoints/progress/time, ties, DNF/disconnect, total and best lap |
| `race-session.mjs` | `RaceSession` | one-tick integration wrapper and snapshot/replay hash |
| `verify.mjs` | CLI | synthetic 2/3/4-player harness and evidence writer |
| `index.mjs` | re-exports | public entry point |

## Minimal host loop

```js
import { RaceSession } from './probes/race-rules/index.mjs';

const session = new RaceSession({
  layout: parsedSprintLayout,          // _work/e1-drive/sprint.json or sprint-lap.json
  participants: ['p1', 'p2'],          // room roster, 2-4 stable ids
  config: { hostId: 'p1' }             // room assigns the host
});

session.command({ type: 'ready', from: 'p1', ready: true });
session.command({ type: 'ready', from: 'p2', ready: true });
session.command({ type: 'start', from: 'p1' });

// Authoritative fixed tick, after the engine step produced each car state.
const events = session.step({
  p1: { position: [x, y, z], forward: [fx, fy, fz], contact: true },
  p2: { position: [x, y, z], velocity: [vx, vy, vz], contact: true }
});

// Feed phase/events to the room. The host sends the result; clients accept it.
const snapshot = session.snapshot();
const hash = session.hash();           // deterministic
```

`step()` may be called during loading/countdown with start-line states; the GO
tick primes the start state without counting a crossing. The first running step
is race tick 1. `session.phase`, `session.raceTick` and
`session.director.snapshot()` expose the clock. A participant that respawns must
be rebuilt by the caller, then `session.progress.rejoin(id, state, raceTick)` is
called before the next `step()`.

`session.command()` accepts `ready`, `start`, `finish`, `dnf`, `disconnect`,
`restart` and `join` (lobby only). Start/finish/DNF/restart are host-authoritative
by default. A disconnect mid-race becomes `disconnected` and sorts after DNF and
finishers; a disconnect after a valid finish keeps the finish.

## Determinism contract

- No `Date.now`, `Math.random`, `performance.now`, wall clock or engine import.
- The only clock is the integer race tick passed to `ProgressTracker.step`; the
  session derives it from `RaceDirector.raceTick`.
- Positions, times, progress and hashes are rounded to 1e-6.
- Same roster + same command sequence + same state sequence produces identical
  events, snapshots and hashes. Every scenario is run twice by `verify.mjs`.
- Hashing uses key-sorted canonical JSON, so object insertion order is irrelevant.

## Verification

```powershell
node probes/race-rules/verify.mjs
```

Recorded result: **67/67 checks passed**, 2 courses, 2/3/4 participants,
4 repeated deterministic scenarios and 1,376 per-tick replay hashes.

```text
checks: 67 total, 67 passed, 0 failed
traceHash: sha256:54fee9a62428a5290fbbfd18233b0e4cd0a5ee0613bbb8b8b5f2c8e8a215e2ae
```

Outputs:

| Evidence | Path |
|---|---|
| Full trace, events, tick hashes, results | `_work/race-rules/trace.json` |
| Check list and counts | `_work/race-rules/verify.json` |
| Compact hash table | `_work/race-rules/hashes.json` |
| Human log | `_work/logs/race-rules/verify.log` |

Key hashes:

| Object | Hash |
|---|---|
| Sprint layout | `sha256:9240e9c136059ccd209992999b8570860f99f1bedd4b4ec9ff0a56d5cf8cad53` |
| Lap layout | `sha256:167643a9a108bc927d093da2b3d1408d639c1cc4110920511455b68c68ad1f91` |
| Sprint CourseModel | `sha256:e0c4e7c6c04bb0f3a055f262b5a53052913f583cc7d84724eab5aea21bf2dc3e` |
| Lap CourseModel | `sha256:81a2a2bee34f843a4569e54417cab46bd392af3ba0acaca134d043a878f1be54` |
| Trace | `sha256:54fee9a62428a5290fbbfd18233b0e4cd0a5ee0613bbb8b8b5f2c8e8a215e2ae` |

Scenario hashes are in `_work/race-rules/hashes.json`. Example:
`sprint-3p` replay hash
`sha256:e0f9b5fb0cf5f8f555c1a060ff4120c8659e5f324c9f5295cf6c414b0a8151b7`;
`lap-4p` replay hash
`sha256:4e52ed83aac5c08ecc2ca1054f3ed90a8d0e874d800c48b493bed01078a83642`.

## Verified scenarios

| Scenario | Course | Participants | Result |
|---|---|---:|---|
| `sprint-2p` | 310 m | 2 | p1 5.016667 s, p2 6.016667 s |
| `sprint-3p` | 310 m | 3 | p1/p2/p3 at ticks 301/328/361 |
| `sprint-4p` | 310 m | 4 | p1/p2/p3/p4 at ticks 301/322/347/376 |
| `lap-2p` | loop-01 | 2 | p1 11.116667 s (best 3.7 s), p2 12.116667 s |
| `lap-3p` | loop-01 | 3 | p1/p2/p3 at ticks 667/727/800 |
| `lap-4p` | loop-01 | 4 | p1/p2/p3/p4 at ticks 667/714/769/833 |
| `tie` | 310 m | 2 | both position 1, tie group |
| `sprint-dnf-3p` | 310 m | 3 | finished, DNF, disconnected |

## Tuning labels

Layout-declared values (read from the committed layout):

- corridor half-width 6 m sprint / 1.25 m lap;
- fall below ground 1 m, airborne 30 ticks;
- sprint outside-band margin 1 m and overshoot 2 m; lap margins 0;
- countdown 90 ticks at 60 Hz.

Project-specific / provisional values (never presented as retail):

- start-grid spacing 2.2 m, row spacing 5.0 m, two per row (`GRID_DEFAULTS`);
- wrong-way dot threshold -0.25 for 30 consecutive ticks;
- lap crossing tolerance 2 m;
- loading 0 ticks, results delay 120 ticks, race timeout 18,000 ticks,
  minimum 2 / maximum 4 participants (`DIRECTOR_DEFAULTS`).

## Limits

- This is not a physics, renderer or network implementation. It is the rules
  layer only.
- The lap course's draw coverage remains the partial-coverage state recorded by
  the existing e1-drive derivation; see `docs/work/analysis/game-logic-audit.md`.
- Synthetic states move on the measured centre line; they do not model grip,
  collisions, damage, pickups or AI.
- Airborne detection requires an explicit `contact`/`onGround` flag. If the
  state omits it, the snapshot reports `contactKnown:false` and no airborne
  respawn is claimed.
- No retail split-line, race-director, damage, pickup, scoring or results
  behaviour is claimed.
- Late join after start is not implemented; the room should reconnect a
  returning client to its existing slot.
