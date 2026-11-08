# `probes/ai-driver` — deterministic AI driver evidence

This directory contains the standalone AI driver and three read-only evidence
harnesses that drive the real `e1_drive` wasm vehicle:

| File | Purpose |
|---|---|
| `ai-driver.mjs` | pure AI driver: `createAiDriver({layout, profile})`, `step(state)`, `observe(state, raceTick)`, `prime`/`reprime`, control tables, skill profiles, canonical JSON/SHA-256 helpers |
| `run.mjs` / `verify.mjs` | River 310 m sprint + loop-01 three-lap matrix (57 cars × 4 profiles) |
| `run-maps.mjs` / `verify-maps.mjs` | measured point-to-point map matrix (57 cars × 2 profiles × 6 maps) |
| `run-powerups.mjs` / `verify-powerups.mjs` | power-up policy, usage and determinism evidence |
| `race-controller.mjs` / `racing-line.mjs` | racing-line generator and race controller used by `run-racing.mjs` |

The driver has no clock, no `Math.random`, no `Date.now`, no
`performance.now` and no timer. Every recorded value is a pure function of the
committed layout, the car's `.fields` and the integer race tick.

## Measured map matrix (six maps)

`run-maps.mjs` drives every roster car with the `reference` (1.00) and
`standard` (0.95) speed profiles on six committed collision-clear paths:

| `mapId` | Level | Length | E1 layout | Committed path |
|---|---|---|---|---|
| `amboy` | `usa_amboy` | 2,060.595 m | `_work/e1-drive/amboy/layout.json` | `_work/e1-drive/map-amboy-run.json` |
| `gracia` | `spa_barcelona_gracia` | 624.914 m | `_work/e1-drive/gracia/layout.json` | `_work/e1-drive/map-gracia-run.json` |
| `longbeach` | `usa_la_longbeachdocks` | 785.823 m | `_work/e1-drive/longbeach/layout.json` | `probes/map-laps/data/longbeach-path.json` |
| `observatory` | `usa_la_observatory` | 536.622 m | `_work/e1-drive/observatory/layout.json` | `probes/map-laps/data/observatory-path.json` |
| `downtown` | `usa_la_downtown` | 153.861 m | `_work/e1-drive/downtown/layout.json` | `probes/map-laps/data/downtown-path.json` |
| `mharuna` | `jpn_mharuna` | 309.170 m | `_work/e1-drive/mharuna/layout.json` | `probes/map-laps/data/mharuna-path.json` |

The E1 layout is the run authority. Before a run starts, `run-maps.mjs` checks
that its canonical hash and its sample/gate polylines still equal the committed
collision path; a stale layout is a hard error, not a silent substitution.

### Ground hint

The engine's ground probe column is fixed at Y −170..130. Mount Haruna spawns
at Y 1064.4312, outside that range, so `e1_create` would report `no ground`.
`run-maps.mjs` calls `_e1_set_ground_hint` before every `_e1_create` (initial
pose, respawn rebuild and replay):

- when `course.spawnGroundY` is outside the fixed column, the measured value is
  applied (Mount Haruna: 1064.4312);
- when it is inside the column, the sentinel is set so the committed
  fixed-column result is preserved bit for bit. The committed Amboy/Gracia
  follower runs were recorded with that column.

Each map records `groundHint: { value, applied, reason }`; a layout without a
finite `course.spawnGroundY` is a hard error. The verifier recomputes the
decision from the layout file.

### Required per-run record

Every run in `_work/ai-driver/results-maps.json` records:

- `mapId` / `courseId`, `profile`, `car`
- `status` (`finished` / `dnf`)
- `timeSeconds` and `finish.tick` (60 Hz race ticks from GO)
- `respawns` and every `respawnEvents` entry with its reason codes and observed
  arc/position
- `maxLateralMetres`, `maxArcMetres`, `finalArcMetres`, `finishArcMetres`
- `contacts` (`ticksWithAnyContact`, `ticksWithAllFourContacts`,
  `airborneTicks`, `runningTicks`) and `contactTicks`; these count the driven
  run only, not the 120 post-finish brake ticks (a finish-line crest can keep
  the car airborne while it brakes)
- `replay.matchedEveryTick` plus the replayed aggregate hashes
- `stateSequenceHash` (every per-tick state hash) and
  `finishStateSequenceHash` (through the finish tick)

### Declared limits

A run is `clean` only when it finishes, has zero respawns, zero NaN ticks and
its per-tick replay matches. Any other run must be a **declared limit** with the
car, the course and the cause:

- A replay mismatch or a NaN tick is never a map/car limit; it is an
  `unexpectedFailure` and fails the verifier.
- Every limit is classified from its own recorded evidence:
  `spawn-no-launch` (the car never moved 2 m off the start line),
  `spawn-airborne-respawn-loop` (airborne respawns at arc < 2 m),
  `spawn-airborne-recovered` (one spawn respawn, then a finish),
  `outside-corridor-dnf`, `below-ground-dnf`, `airborne-dnf`,
  `respawn-loop-dnf`, `no-finish-within-tick-budget` or
  `recovered-with-respawns`. The entry keeps the observed lateral distance, the
  arc reached, the tick budget and the respawn reasons.

A car that never gets off the start line is reported as a spawn failure, not as
a hairpin/turning-circle claim. The cause is the observed mode and the arc it
actually reached.

No run is dropped. The verifier checks that every non-clean run is declared and
that the declared set is bounded.

### Committed follower comparison

The committed `map-<map>-run.json` files are recorded side by side, but their
control tables differ:

- `amboy` / `gracia` were produced by the measured `AMBOY_CONTROL`
  (top speed ~13 m/s). The tuned matrix differs only on Amboy by the documented
  **3.466667 s** (`minSpeed` 5 → 3.5 m/s); Gracia matches exactly.
- The four new maps were produced by the sprint follower (recorded top speed
  ~24.7 m/s). The AI matrix uses the measured `MAP_CONTROL` (12 m/s cruise), so
  the times are recorded but marked `comparable: false`. The verifier asserts
  this provenance from the committed run's own top speed rather than assuming
  it.

## Commands

```powershell
# Map matrix, run twice so results-maps.previous.json is a real previous run
node probes/ai-driver/run-maps.mjs
node probes/ai-driver/run-maps.mjs
node probes/ai-driver/verify-maps.mjs

# Same, with the 57-car roster pinned while another task extends the shared
# _work/e1-drive/cars.json:
node probes/ai-driver/run-maps.mjs --roster _work/ai-driver/cars-57.json
node probes/ai-driver/run-maps.mjs --roster _work/ai-driver/cars-57.json
node probes/ai-driver/verify-maps.mjs

# River 310 m + loop-01 matrix, run twice
node probes/ai-driver/run.mjs
node probes/ai-driver/run.mjs
node probes/ai-driver/verify.mjs

# Power-up evidence, run twice
node probes/ai-driver/run-powerups.mjs
node probes/ai-driver/run-powerups.mjs
node probes/ai-driver/verify-powerups.mjs
```

Useful filters for local inspection (they change the recorded selection; the
verifier gate expects the full six-map, full-roster selection):

```powershell
node probes/ai-driver/run-maps.mjs --maps longbeach,mharuna --cars corvette-zr1-stock --profiles reference
node probes/ai-driver/run-maps.mjs --skip-races --skip-replay
```

`--control committed` disables the Amboy `minSpeed` tuning; the default is
`tuned`.

## Verifier

`verify-maps.mjs` checks, among others:

- the wasm, level, layout and committed-path hashes still match;
- one run per car/map/profile and every run is clean or declared;
- zero NaN ticks, per-tick replay equality and canonical state hashes;
- clean runs keep wheel contact and stay inside the declared corridor;
- the ground hint equals each layout's `spawnGroundY` (Mount Haruna 1064.4312);
- every map has a 2–4 AI race, deterministic across two fresh instance sets,
  with a full replay;
- the two process-separated result files are byte-identical and every finish
  time/state hash is identical between them.

It writes `_work/ai-driver/verify-maps.json` and exits non-zero on any failure.

## Measured result (57-car roster, six maps)

Two process-separated runs with `--roster _work/ai-driver/cars-57.json` produced
byte-identical `results-maps.json` files:

| map | runs | clean | declared | DNF |
|---|---|---|---|---|
| `amboy` | 114 | 110 | 4 | 1 |
| `gracia` | 114 | 94 | 20 | 10 |
| `longbeach` | 114 | 114 | 0 | 0 |
| `observatory` | 114 | 114 | 0 | 0 |
| `downtown` | 114 | 114 | 0 | 0 |
| `mharuna` | 114 | 114 | 0 | 0 |
| **total** | **684** | **660** | **24** | **11** |

The four new maps are fully clean for the whole roster. The 24 declared limits
are on Amboy (4) and Gracia (20) and are listed in `knownLimits` with the car,
the profile, the cause, the arc reached and the respawn reasons. The causes are
`spawn-no-launch`, `spawn-airborne-respawn-loop`,
`spawn-airborne-recovered`, `below-ground-dnf` and
`recovered-with-respawns`.

The shared `_work/e1-drive/cars.json` grew from 57 to 59 cars while this
evidence was being produced (another task added `ratrod-na-stock` and
`toyota-supra-smooth`). `_work/ai-driver/cars-57.json` is the pinned 57-car
snapshot used for the two runs, so the matrix is reproducible independently of
later roster edits.

## Evidence

- `_work/ai-driver/results-maps.json` — current run
- `_work/ai-driver/results-maps.previous.json` — previous process-separated run
- `_work/ai-driver/verify-maps.json` — verifier report
- `_work/logs/ai-driver-maps-run*.log` — run logs

The analysis document is `docs/work/analysis/ai-driver.md`.
