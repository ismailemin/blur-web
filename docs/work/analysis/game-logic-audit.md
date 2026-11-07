# Race/game-logic audit — portability and the minimum original rules layer

**Status:** analysis complete, read-only. No engine, e1-drive, asset-reader,
tools, upstream or game-data file was changed.
**Date:** 7 November 2026
**Upstream:** `upstream/BlurRebuilt`, commit
`5270304b81983b9e3edbd569ba25235c17bbabd7`, clean checkout (verified).
**Inventory:** `probes/game-logic-audit/inventory.py` →
`_work/game-logic-audit/game-logic-inventory.json`.
**Verifier:** `probes/game-logic-audit/verify_inventory.py` → PASS.
**Compile probe:** `probes/game-logic-audit/compile_ai_probe.py` →
`_work/game-logic-audit/ai-compile-probe.json` (29/29 AI-core TUs compile as
objects).
**Scope labels:** `fullGame:false`, `engineIntegration:false`,
`runtimeClaim:false`, `retailParity:false`.

This document answers one question: which upstream race logic can be reused in
the browser build, and what must be rebuilt as an original rules layer. It does
not claim that any race rule already runs in the browser beyond the existing
e1-drive sprint/lap/free-roam slice.

---

## 1. Method

1. Read the task documents and the existing wasm/physics closure
   (`docs/work/tasks/T-005-*.md`, `docs/work/analysis/engine-wasm-probe.md`,
   `_work/engine-vehicle-spike/build.py`).
2. Walked the race-relevant trees under `code/amax/game` and
   `code/mercury/library/ai` and recorded every file, line count, class/struct
   declaration and lexical dependency indicator.
3. Traced the runtime path from `E_GameflowMessage_StartRaceLoad` through
   `RaceLogicCore`, `RaceMode*`, split/lap controllers, finish and results.
4. Compiled the entire `mercury/library/ai/air` library (the algorithmic AI
   core) with the existing `PLATFORM_WEB` headers and the already patched
   common tree. This is an object compile, not a link or a run.
5. Attempted one representative `amax` game TU (`RaceLogicCore.cpp`) with the
   same headers. It fails in the shared game PCH: `pthread_key_t`, DirectX
   shader/texture types, 17 errors before Clang's error limit.
6. Compared the result with the existing e1-drive rules
   (`probes/e1-drive/web/sprint-rules.js`), which already implements an original
   sprint/lap/free-roam state machine.

The inventory is deterministic: the verifier re-runs the scan and compares the
output byte for byte.

---

## 2. System map

Counts are files / lines / classes from the inventory. "Deps" are lexical
indicators, not proof of linkage.

| Subsystem | Files | Lines | Classes | Primary source | Main deps | Classification |
|---|---:|---:|---:|---|---|---|
| Race logic core | 26 | 8,891 | 131 | `GameLogic/RaceLogicCore/**` | actor, physics, XT, UI | reimplement |
| Race modes | 35 | 11,939 | 43 | `GameLogic/RaceModes/**` | network, UI, actor | 15 reimplement / 20 platform-bound |
| Race rules | 56 | 5,298 | 36 | `GameLogic/RaceRules/**` | actor, UI, network | reimplement |
| Game modes | 19 | 4,542 | 32 | `GameLogic/GameModes/**` | network, profile, UI | 13 reimplement / 6 platform-bound |
| Pickups | 79 | 13,978 | 87 | `GameLogic/Pickups/**` | physics, XT, audio, network | reimplement |
| Single-player event flow | 15 | 4,604 | 79 | `GameLogic/SinglePlayer/**` | save, profile, UI | platform-bound |
| Result/state structures | 13 | 2,663 | 37 | `GameLogic/Structures/**` | btl, UI, network | reimplement |
| Game data (event/pickup config) | 8 | 6,460 | 162 | `GameLogic/GameData/**` | XT/sorcery | unknown |
| Play mode / custom race | 5 | 933 | 13 | `GameLogic/PlayMode/**` | UI, profile | reimplement |
| Vehicle logic (damage, scoring, pickups, HoG) | 57 | 29,276 | 156 | `Game/GameActors/Components/VehicleLogic/**` | physics, actor, XT, audio | reimplement |
| AI glue (`AI_Amax`, perks, modes) | 48 | 16,399 | 166 | `code/amax/game/AI/**` | actor, physics, scheduler, XT | reimplement |
| AI core (`air`) | 108 | 26,369 | 212 | `code/mercury/library/ai/air/**` | btl, maths, component system | portable (object compile) |
| Race actors (traffic, split, start, pickup position) | 12 | 3,589 | 24 | `GameLogic/ActorStudioActors/**` | actor, render, XT | reimplement |
| **Total** | **481** | **134,941** | **1,178** | | | |

The 41 platform-bound files are the network race modes
(`RaceModeMultiplayer*`, `RaceModeFriendDemand*`), the network game modes
(`GameModeNetwork`, `GameModeOnline`, `GameModeSystemLink`), and the
single-player save/profile flow.

---

## 3. What the upstream code actually does

### 3.1 Race modes

`E_RaceMode` declares 14 real modes plus a sentinel
(`GameLogic/RaceModes/RaceModeDefines.h:11-33`):

- single-player: StreetRace, Destruction, Checkpoint, FanDemand, BossBattle;
- multiplayer: Racing, Elimination, Points, Destruction;
- five FriendDemand variants.

`C_RaceModeBase` exposes the lifecycle every mode implements:
`Initialise → SetupRace → SetupOpponents → StartLevel → StartRace → Update →
UpdateHUD → SetupResults` (`RaceModeBase.h:39-87`).
`C_RaceModeMultiplayer` adds rolling start, network updates, finish/timeout,
team scores and results (`RaceModeMultiplayer.h:41-104, 120-176`).

The mode that corresponds to the first browser milestone is
`E_RaceMode_Multiplayer_Racing` (lap race) and, for offline, StreetRace. The
full destruction/elimination/points modes are not needed for M1.

### 3.2 Race state machine and start

`RaceLogicCore` has its own loading state machine
`E_RLC_STATE_CREATED … E_RLC_STATE_READY`
(`RaceLogicCore/Data/RLEnums.h:39-57`). It creates vehicles, waits for vehicle
and AI resources, analyses splits and AI data, then broadcasts
`RLCReadyToRock` (`RaceLogicCore.cpp:202-307`).

The race itself is driven by gameflow messages, not by the race mode directly
(`Game/Messaging/GameflowMessages.h:37-70`):

| Message | Meaning |
|---|---|
| `RaceLoaded` | level loaded, first in-game screen |
| `IntroStarted` / `IntroFinished` | intro; "3,2,1 Go" follows |
| `BeginRollingStart` / `EndRollingStart` | MP rolling start |
| `RaceStarted` | player is in control; race clock starts |
| `RaceFinished` | logical end; post-race begins |
| `ResultsCalculated` | `C_LevelResult` is valid |

`C_RaceModeBase::StartLevel` puts cars into
`E_VEHICLE_STATE_WAITING_TO_START`; `StartRace` puts them into `RACING` and sets
`mRaceInProgress` (`RaceModeBase.cpp:93-137`).
`RaceLogicCore::PreUpdate` advances `mRaceTime` only when
`mTrackData->mRaceStarted` is true (`RaceLogicCore.cpp:750-755`), and
`SendControls` refuses to send input before that flag
(`RaceLogicCore.cpp:838-850`). The clock is therefore message-gated, not
wall-clock-gated.

In multiplayer, local human vehicles are temporarily forced to AI control for
the rolling start and returned to human control in `StartRace`
(`RaceModeMultiplayer.cpp:410-419, 481-509`). `RaceStarted` is also when pickups
are enabled and vehicles are told the race has started
(`RaceLogicCore.cpp:2073-2088`).

**Implication:** a browser rules layer needs an explicit phase enum and a
countdown/start event. It cannot infer "race started" from the physics step.

### 3.3 Checkpoints, splits and laps

The track model is split-based, not a single finish trigger:

- Up to 16 split lines and 10 stored laps
  (`RLDefinitions.h:20-26`); `SplitData` stores start/end/centre, true
  start/end, split number, waypoint, track percentage
  (`RLDefinitions.h:44-67`).
- Split 0 is always the start/finish line; the rest are intermediate splits
  (`RLTrackPositionController.cpp:214-262`).
- `SplitLineActor` supplies the line geometry and split number
  (`GameLogic/ActorStudioActors/SplitLineActor.h:24-60`).
- `RLTrackPositionController::AnalyseActorStudioSplits` re-centres each split
  on the AI route and computes an accurate waypoint
  (`RLTrackPositionController.cpp:124-212`).
- Crossing is detected either by a 2D segment intersection or by the vehicle's
  accurate waypoint straddling the split's waypoint
  (`RLTrackPositionController.cpp:400-458`). The 2D test is
  `Line2DIntersect` (`:460-482`).
- Crossings are ordered: a split only counts if it is the expected next split
  (`ValidSplit`, `:502-506`). A reverse crossing decrements the lap/split
  counters (`:552-568`).
- Crossing split 0 increments `mNoLaps`; crossing any split increments
  `mNoSplits` (`:508-550`). A `C_LapIncrementedMsg` is broadcast when the lap
  number advances (`:532-537`).
- `mMaximumLap` / `mMaximumSplit` are the "high tide" values. The lap/split
  time controller compares them with the previous frame's values to decide that
  a lap or split completed (`RLLapSplitTimeController.cpp:59-71`).
- Lap time accumulates the frame time; the lap controller stores the lap and
  updates fastest/slowest (`RLLapSplitTimeController.cpp:95-183`).
- Race percentage is
  `(trackPercentage + (maximumLap - 1)) / levelLaps`
  (`RLTrackPositionController.cpp:716-751`); a configurable
  `mEndOfRacePercentage` marks "nearly finished".

The current e1-drive rules already implement an equivalent, simpler model:
ordered gates, a start gate, checkpoint gates and a finish gate
(`probes/e1-drive/web/sprint-rules.js:1-40, 219-530`). That is an original
reconstruction from the measured course, not a claim about retail split lines.

**Important limitation:** the existing lap course is derived from a three-loop
document, and the file itself warns that the real River draws do not cover a
lap (`probes/e1-drive/web/sprint-layout.js:1296`). For M1 the measured 310 m
point-to-point sprint is the defensible course. A lap race needs a course whose
draw/collision coverage is complete, or an explicit partial-coverage label.

### 3.4 Start positions and vehicle placement

`LevelStateCar` carries `mStartPosition`, `mStartDisabled`, `mAIDriver`,
`mAISteering`, `mTeam`, health overrides and pickup overrides
(`GameLogic/Structures/LevelState.h:63-140`). `RaceLogicCore::PlaceVehicles`
uses `GetStartPosition(levelState.mCars[i].mStartPosition)` and resets each
vehicle to that matrix (`RaceLogicCore.cpp:1773-1817`). Missing start positions
fall back to index 0 with a log (`:1795-1801`).

For the browser rules layer, the grid must be an explicit input. The existing
e1-drive slice has one car; there is no start-grid model yet.

### 3.5 Finish and results

Single-player results are assembled by the race mode:
`C_RaceModeCheckpoint::SetupResults` fills `C_LevelResult` and derives a medal
from remaining time (`RaceModeCheckpoint.cpp:657-697`). The generic
`C_RaceModeBase::SetupResults` only clears `mRaceInProgress`
(`RaceModeBase.cpp:149-152`).

Multiplayer results are richer:

- `C_RaceModeMultiplayer::CheckForEndOfEvent` ends when no global racing
  vehicles remain, or when only one local vehicle is left after a post-race
  delay (`RaceModeMultiplayer.cpp:693-739`).
- `VehicleFinished` sets `E_VEHICLE_STATE`, tidies the vehicle, sends results
  and marks the primary vehicle finished
  (`RaceModeMultiplayer.cpp:1128-1249`).
- `SetupResults` updates race positions, total race length, team scores and
  broadcasts `ResultsCalculated` (`RaceModeMultiplayer.cpp:1769-1830`).
- `C_LevelResult` stores position, score, pass/fail rules and
  `VehicleRaceStatistics` (`Structures/LevelResult.h:19-46`).
- `C_MpResults` stores finish order, live/sorted vehicle data and team data
  (`Structures/MpResults.h:34-90`).
- `NetVehicleData` stores state, position, skill/team rating and multiplayer
  statistics (`Structures/NetVehicleData.h:18-66`).

The lap-race finish test is `mCurrentLap > mLaps`, not `>=`
(`RaceModeMultiplayerRacing.cpp:332-349`). The reason is that the first
start/finish crossing increments the lap counter; this is a behaviour to verify,
not a value to copy blindly.

**M1 result model:** position by completed laps/checkpoints, then distance to
the finish, then finish time. Best lap and total time are enough. Full AMAX
scoring is not required.

### 3.6 Damage, health and wreck

Damage state is explicit:

- `E_IMPACT_LEVEL` = light / medium / heavy
  (`RLEnums.h:173-186`).
- `E_HEALTH_LEVEL` = low / medium / high / wrecked
  (`RLEnums.h:188-199`).
- `E_DAMAGE_MODE` = normal / invulnerable / multiplier / one-shot kill /
  power-ups only (`RLEnums.h:201-214`).
- `RLDamageParameters` holds max impulses, reset timer, light/medium/heavy
  damage, health increment and per-group base health
  (`RLDatabase.h:891-917`).
- `RLHealthLevelZone` maps health ranges to damage filters and screen effects
  (`RLDatabase.h:853-865`).
- `RLDamageFilter` lists scratch/deform/dislodge/detach/burst/light/smoke/fire
  behaviours (`RLDatabase.h:837-851`).

`C_VehicleComponent_Damage::AdjustHealth` clamps health to `0 … max-1`, updates
the health level and enters wrecked state (`VLC_Damage.cpp:514-556`). The
wrecked branch counts down `mWreckedTimer`; at zero it either removes the
vehicle, respawns it, or eliminates it according to
`mWreckedBehaviour` (`VLC_Damage.cpp:206-269`). `LevelState` defaults to
`E_AMAXWRECKED_RESPAWN` (`LevelState.cpp:154`).

The respawn itself is the Hand-of-God reset:

- `ResetVehicleOnTrack` uses either a reset zone override or the AI spline's
  last valid position/direction/speed (`VLC_HandOfGod.cpp:908-939`);
- `ResetVehicleOnTrackStatic` ray-traces down to the ground, builds an
  orientation from the ground normal and direction, and applies a ghost time
  (`VLC_HandOfGod.cpp:977-1015`);
- reset criteria are a bit mask: crashed, tumbled, stuck, off-spline, not facing
  forwards, flipped (`VLC_HandOfGod.h:56-69`).

**M1 scope:** off-course/fall respawn only, at the last passed checkpoint or
the start line. The existing `SprintRules.respawnTarget()` already does this
(`sprint-rules.js:439-449`). **M2 scope:** impact damage, health levels, wreck
timer and respawn/eliminate.

### 3.7 Power-ups

Power-up types are enumerated as 11 primary/secondary types plus `ALL`
(`RLEnums.h:92-114`): nitrous, shock, shunt, blindfire, barge, bomb, repair,
shield, fan, stopwatch, super shield. Sub-types cover normal, double-tap,
reversed, reversed double-tap, decoy, mods and mini
(`RLEnums.h:121-135`). Respawn policy and cause-of-death are separate enums
(`RLEnums.h:144-171`).

The runtime is a manager plus one class per pickup:

- `C_PickupsManager` keeps active and buffered pickup lists, allocates unique
  IDs, creates pickups, owns the shock manager and a scheduler group
  (`PickupsManager.h:28-131`).
- `C_PickupBase` holds type/sub-type, firing index, unique/parent/group IDs,
  health, hit/shield sets, collision set, AI trackable data and autopsy report
  (`PickupBase.h:52-161`).
- `C_PickupPositionManager` maps pickup-position actor IDs to allowed types and
  assigns a type from the allowed list (`PickupPositionManager.h:32-44`).
- 39 `Pickup*.cpp` files implement the individual behaviours across normal,
  double, reverse, upgraded, misc and mods.

The tuning data lives in `RLDatabase`: `RLPickupSystem`, `RLPickupType`,
`RLPickupLevel`, balancing graphs, `mBaseProbability`, position modifiers and AI
type (`RLDatabase.h:632-708`). `RLPickupParameters` holds pickup radius,
deactivate timer, post-pickup cooldown and XP multiplier (`:684-695`).

**M1 scope:** none. **M2 scope:** one pickup family (for example nitro) and one
defensive/utility pickup (repair or shield), with an explicit event state
machine. The other 30+ behaviours wait.

### 3.8 Scoring

Scoring is a separate, very large layer:

- `AMAX_SCORING_EVENT` has 97 event values
  (`RLEnums.h:266-402`), from shunts and shocks to drifting, air, near misses,
  comeback and clean-racing bonuses.
- `VLC_NewScoring.cpp` is 4,288 lines; `VLC_Scoring.cpp` is 2,372 lines;
  `VLC_Statistics.cpp` tracks the per-vehicle statistics.
- `C_RaceRulesManager` evaluates pass/fail rules and lap/time actions
  (`RaceRulesManager.h:28-63`, `.cpp:201-380`); there are 19 rule types
  (`RaceRuleBase.h:23-47`).

**M1 scope:** no AMAX score. Record laps, checkpoints, time, best lap and
position. **Later:** race-rule pass/fail and score only after the rule data is
decoded.

### 3.9 AI drivers and opponents

`AIAmax::AmaxAIR` is the game-side glue:

- loads AI route data from `gamedata/levels/<city>/<route>.aid`, a version-6
  binary (`AI_Amax.cpp:1595-1643, 1652+`);
- loads event balancing from `.csv` (for example
  `gamedata/Events/Default_Easy.csv`) (`AI_Amax.cpp:494-540`);
- runs on a scheduler group (`AI_Amax.cpp:20-21, 159, 197-203`);
- owns spline tracking, driving, avoidance, recovery, speed tracking, race
  director and rubber-banding in `mercury/library/ai/air`;
- writes `C_VehicleUpdateAIControlsMsg` with throttle/brake/steering
  (`AI_Amax.cpp:2626-2662`), and in some paths also applies force/torque
  directly (`AI_Amax.cpp:2812-2879`);
- copies AI lap/position data back into `VehicleLogicActor`
  (`AI_Amax.cpp:3145-3173`).

Opponent setup is data-driven: `AmaxOpponentSetup` selects character, vehicle
override, detail, always-shields, only-attacks-player, health override, perk
slots, perk-gift timer/types (`GameData/GameEventData.h:65-79`). The event
contains an `opponents` array (`:489-527`).

The AI core compiles: all 29 `air` TUs (26,369 lines including headers, 212
classes) build as objects with the existing web headers. The glue does not:
`AI_Amax.cpp` includes the game/actor/XT/UI stack.

**M1 scope:** no AI. **M2 scope:** one original simple AI driver, not the retail
race director. It can use the measured racing line and the same control struct
as a human. The retail `.aid` parser and event-balancing CSV are later work;
their absence must not be hidden by a fake "retail AI".

### 3.10 Rubber-banding

There are two separate systems:

- AI rubber-banding in `air`: fuzzy catch-up/slow-down with per-segment
  distance, speed percentage and catch/slow rates
  (`air/include/rubberbanding/irubberbandingai.h:17-55`,
  `crubberbandingai.h:20-81`).
- player rubber-banding in `VLC_PlayerRubberBanding`: computes a modifier from
  race positions/distance and applies an impulse to the vehicle
  (`VLC_PlayerRubberBanding.h:41-99`); config lives in
  `MultiplayerData.h:499, 647`.

Both are online-balancing systems, not race-completion requirements. They wait
until M2/M5 and any value must be labelled project-specific until decoded.

### 3.11 Traffic

`TrafficActor` is a visual spline decoration, not gameplay:

- creation data holds spline, traffic group, speed, spacing, spacing variation
  and an update-lighting flag (`TrafficActor.h:60-75`);
- `CreateImpl` builds `splineLength / spacing` model instances
  (`TrafficActor.cpp:106-174`);
- `OnMessage(Update)` advances a spline offset and writes model matrices; there
  is no collision body, no AI and no race state (`TrafficActor.cpp:258-303`).

Traffic can be reimplemented in the renderer later or skipped. It is not an M1
or M2 blocker.

---

## 4. Portability classification

### 4.1 Counts

| Classification | Files | Lines | Meaning |
|---|---:|---:|---|
| portable | 108 | 26,369 | AI core only; 29 TUs compile as objects with existing web headers |
| reimplement | 324 | 88,749 | behaviour understood, but bound to actor/game/XT/UI runtime; rebuild in JS |
| platform-bound | 41 | 13,363 | network/DemonWare, Windows, save/profile, UI-driven modes |
| unknown | 8 | 6,460 | event/pickup configuration values not decoded |
| **total** | **481** | **134,941** | |

### 4.2 Existing wasm closure

**0 of 481** race/game-logic files are in the existing wasm closure. The
vehicle spike compiles 287 objects: RacingPhysics, Gravity, common maths/system,
scheduler and the harness (`_work/engine-vehicle-spike/build.py:41-127`). The
earlier 48-TU probe contains no game TU either
(`docs/work/analysis/engine-wasm-probe.md:137-149`). The verifier scans
`_work/**/*.o` for known game stems and fails if one appears.

The AI core was **not** in that closure. In this audit it was compiled
separately: 29/29 object compiles, using
`_work/engine-vehicle-spike/tree` (the already patched common tree) plus
`engine/harness/t005b/msvc_crt_web.h` and
`engine/harness/t005c/web_platform.h`. No link, no run, no numerical parity.
This is why `portable` is narrower than "the game logic runs in wasm".

A representative game TU (`RaceLogicCore.cpp`) fails before reaching game code:
the shared `code/amax/game/stdafx.h` includes `<Display.h>`; the compile stops
on `pthread_key_t` in `ThreadLocalStorage.h` and then on DirectX
`C_VertexShader`/`C_Texture` types in `Display2/Utils/Utils.h`. The log is
`_work/logs/game-logic-audit/racelogiccore.log`.

### 4.3 Why almost everything is "reimplement"

`RaceLogicCore` is a `C_GameActor` (`RaceLogicCore.h:14-18, 62`) that reaches
`C_GameApp`, `C_LevelState`, `C_GameWorld`, `C_VehicleActor`,
`C_VehicleLogicActor`, `AIAmax`, `RLDatabase`, cameras, UI and audio. It is not
a separable rules library. Its core logic is still readable, so the rules can be
rebuilt in JS, but extracting the C++ file would pull the whole game runtime.

The same is true of damage, pickups and scoring: the policy is in the component,
but the component is an actor component with physics callbacks, XT data, audio
messages and UI messages. The audit therefore classifies them as reimplement,
not portable.

The `game_data` files are `unknown`, not because the source is missing, but
because the actual event/pickup tuning values live in XT/sorcery packs that the
project has not decoded. No value is guessed.

---

## 5. Minimum original rules layer

### 5.1 M1 — two-player online race on the measured 310 m sprint

M1 needs five small modules. All are deterministic functions of the tick and
the committed layout; none call into the engine.

| Module | Inputs | Outputs | Reads |
|---|---|---|---|
| `RaceDirector` | tick, phase commands, participant list, config | phase, race clock, start/finish events | room/ready state, countdown config |
| `CourseModel` | measured layout JSON, start grid | ordered gates, start gate, finish gate, arc/sample index, respawn points | e1-drive `sprint-layout.js` output; no retail guess |
| `ProgressTracker` | per-tick vehicle position/velocity/forward, course model | next checkpoint, checkpoints passed, laps, lap times, progress fraction, wrong-way/off-course | vehicle state, course model |
| `RespawnPolicy` | position/ground/airborne ticks, last checkpoint | respawn command + target transform + reason | course model, config |
| `ResultModel` | finish events, lap times, disconnect events | ordered results, total time, best lap, DNF | progress tracker, room roster |

Proposed public contract (text, no implementation here):

```text
RaceRules.step(tick, vehicles[], events[], config) -> {
  phase,                    // lobby | loading | countdown | running | finished | results
  raceTimeTicks,
  vehicles: [{
    id, lap, checkpointIndex, checkpointsPassed, progress,
    lapTimes[], finished, finishTick, dnf, respawn
  }],
  results: { order[], totalTime, bestLap, dnf[] },
  events: [...]             // go, checkpoint, lap, finish, respawn, dnf
}
```

M1 rules:

- Start only after every participant reports `ready` and the host sends
  `start`; countdown is a fixed tick count from config, not wall time.
- A checkpoint counts only in order; a finish counts only after all checkpoints.
- Lap race: the start/finish line is both gate 0 and the lap line; the first
  crossing starts lap 1. A finish requires `lapsCompleted == config.laps`.
- Position: laps completed, then checkpoints, then progress fraction, then
  finish time. DNF sorts after finishers.
- Respawn: off-course, fall below local ground, or airborne too long. Target is
  the last passed checkpoint (or start). The existing `SprintRules` already has
  this policy and an event log (`sprint-rules.js:219-530`).
- Host authority: the host runs the rules; clients send input/state, receive
  authoritative phase/events. Do not run two independent finish judges.

M1 explicitly excludes: damage, health, wreck, power-ups, AI opponents,
rubber-banding, traffic, AMAX score, retail race modes, profiles and
achievements.

The existing e1-drive slice already supplies most of the geometry and a
single-car version of the rules. The M1 work is to separate it from the demo
page, add participants/authority and a results model, then connect the room
transport. It is not a from-zero rules engine.

### 5.2 M2 — damage, respawn, one power-up family, one simple AI

| Module | Inputs | Outputs | Data source |
|---|---|---|---|
| `HealthModel` | impact event (relative speed, normal, masses), current health, damage mode | health delta, health level, wreck event | decoded `RLDamageParameters` if available; otherwise explicit `provisional` config |
| `WreckRespawn` | wreck event, wreck timer, last valid route point | respawn/eliminate command, ghost time | decoded HoG parameters if available; otherwise `provisional` |
| `PowerupModel` | pickup/fire/hit/expire events, vehicle and projectile state | inventory slot, projectile/mine state, hit/block/expire events | decoded `RLPickup*` tables if available; otherwise one-family config |
| `AIDriver` | vehicle state, racing line, car physics parameters, difficulty | throttle/brake/steering (same struct as human) | measured line + XT car data; no retail AI data claim |

M2 rules:

- Damage is applied from explicit impact events, not from an inferred visual
  collision. The event carries enough data to reproduce the result.
- Wreck behaviour is a config enum: `respawn` or `eliminate`; `do-nothing` is
  allowed for special modes.
- Respawn waits for the wreck timer, then uses the same placement ray/ground
  logic as M1, with ghost time.
- Power-ups use an explicit event log so host and clients agree:
  `spawn → pickup → fire → hit/block/expire → respawn`.
- Only one pickup family and one defensive/utility pickup are in M2. More types
  are content, not architecture.
- The simple AI is a pure-pursuit/speed-target driver on the measured line:
  nearest arc, look-ahead point, steering from heading error, target speed from
  curvature and grip, brake when over target. It writes the same control struct
  as a human. It is host-simulated and included in the snapshot.
- Any AI speed cap, aggression or rubber-band factor is a named config value
  tagged `provisional`; it is not presented as a retail value.

### 5.3 Data the rules layer may read

| Data | Status | Use |
|---|---|---|
| measured course samples/gates | available in e1-drive layout output | M1 progress/checkpoints |
| start grid | needs an explicit model; upstream `RLStartPosition` is the contract (`RLDefinitions.h:184-198`) | M1 placement |
| car physics parameters (mass, engine, wheels, grip) | available from XT/vehicle physics work | M2 AI |
| `RLDamageParameters` | struct known (`RLDatabase.h:891-917`); values not decoded | M2 damage |
| `RLHandOfGodParameters` | struct known (`RLDatabase.h:977-1015`); values not decoded | M2 respawn |
| `RLPickupSystem` / `RLPickupType` | struct known (`RLDatabase.h:632-708`); values not decoded | M2 power-ups |
| `AmaxEvent` / `AmaxOpponentSetup` | struct known (`GameEventData.h:65-79, 489-527`); values not decoded | later event/opponent setup |
| AI `.aid` v6 + event CSV | parser source known (`AI_Amax.cpp:1595-1643`); no reader in probes | later retail AI, not M1/M2 |

No retail value is invented. When a value is not decoded, the module takes a
configuration object with an explicit `source: "provisional"` tag and the UI /
telemetry must show that the rule is not retail-faithful.

---

## 6. Work quantification and blockers

### 6.1 Size

- 481 files, 134,941 lines, 1,178 classes in the audited race-relevant trees.
- 0 of those files in the existing wasm closure.
- 29 AI-core TUs (108 files including headers, 26,369 lines) compile as objects
  in the audit probe; no link/run.
- Largest single units: `VLC_NewScoring.cpp` 4,288 lines, `AI_Amax.cpp` 4,159,
  `VLC_Pickups.cpp` 3,552, `RaceModeMultiplayer.cpp` 2,930,
  `VLC_Damage.cpp` 2,861, `RaceLogicCore.cpp` 2,419.

### 6.2 Top five blockers

1. **Shared game PCH and DirectX.** Both game PCHs pull platform/render
   headers: `code/amax/game/stdafx.h` includes `<winsock2.h>`, `<windows.h>`
   under `PLATFORM_PC` and `<Display.h>` unconditionally
   (`stdafx.h:8-28, 43`); `GameLogic/StdAfx.h` does the same and adds
   `Display/Core/Includes.h` (`GameLogic/StdAfx.h:8-30, 45`). The representative
   compile dies on `pthread_key_t` and DirectX shader/texture types. Any C++
   port starts by replacing these PCHs and the display/UI types, not by
   compiling a rules file.
2. **Actor/runtime coupling.** `RaceLogicCore` is an actor that reaches
   `C_GameApp`, `C_LevelState`, `C_GameWorld`, `C_VehicleActor`,
   `C_VehicleLogicActor`, `AIAmax` and `RLDatabase`
   (`RaceLogicCore.h:14-18, 62`; `.cpp:18-49`). There is no isolated rules
   API to link. Reimplementation in JS is cheaper and testable.
3. **AI data and control path.** The retail AI needs a version-6 `.aid` binary
   on the AI spline/route model (`AI_Amax.cpp:1595-1643, 1652+`), event CSV
   balancing (`:494-540`) and, in some paths, direct force/torque application
   (`:2812-2879`). No `.aid` reader exists in the probes. The air core compiles,
   but the glue and data do not.
4. **Network race modes.** `RaceModeMultiplayer` is 2,930 lines and depends on
   RacerNet, reliable/unreliable messages, voice, DemonWare-era services and
   network result messages (`RaceModeMultiplayer.h:120-176`,
   `.cpp:336-359, 1769-1830`). The retail wire ABI has been measured
   (`docs/work/analysis/net-layout.md:25-35`), but the transport/protocol is
   platform-bound. M1 needs an original room/transport/event layer.
5. **Damage/pickup/scoring data and coupling.** `VLC_Damage.cpp` (2,861),
   `VLC_Pickups.cpp` (3,552), 39 pickup implementation files and 97 scoring
   events depend on physics collision callbacks, XT tuning and audio/UI. The
   behaviour is readable but the values are not decoded. This is the largest
   M2 risk and must be staged one family at a time.

A sixth, lower-risk item is results/profile/UI: `C_LevelResult` and
`C_MpResults` are simple enough to reimplement, but profile/save/achievements
are platform-bound and can wait.

### 6.3 Recommended order

**M1 (online race) — do first**

1. Freeze the measured 310 m course and its gates as the only M1 course; keep
   the lap course behind an explicit partial-coverage label until draw coverage
   is complete.
2. Extract the existing `SprintRules`/`LapRules` state machines into a reusable
   rules module with a stable phase/event/result schema.
3. Add the participant model, host authority, countdown/start/finish and
   results. Two players, one map, five current cars.
4. Keep only off-course respawn. Add disconnect/DNF and reconnect handling.
5. Integrate the room/transport. No damage, power-ups or AI in M1.

**M2 (power-ups/rules) — after M1 is playable**

6. Simple AI opponent on the measured line, host-simulated, same control
   struct. This is a testable original driver, not the retail race director.
7. Damage/health + wreck respawn, using decoded `RLDamageParameters`/
   `RLHandOfGodParameters` when available; otherwise a clearly labelled
   provisional config.
8. One pickup family + one utility pickup, with event sync and host authority.
9. Only then add more pickup types, rubber-banding and AI difficulty.

**Can wait**

- the other 13 race modes, destruction/elimination/points, boss battles and
  fan demands;
- 97-event AMAX scoring, race-rule pass/fail, achievements, profiles, save,
  leaderboards and AMX/DemonWare;
- retail AI race director, `.aid`/event CSV ingestion, retail rubber-banding;
- traffic, crowds, driver animation, cutscenes, full UI;
- retail wire protocol and voice.

---

## 7. Limits

- This is not a full-game claim and not a retail-parity claim.
- `portable` means object-compiled in this audit, not linked, run or numerically
  compared.
- Line counts include comments and blank lines; class counts are lexical
  declarations and include forward declarations.
- Dependency flags are token indicators, not proof of a link dependency.
- The source is the reference; no retail tuning value was recovered or guessed.
- The existing e1-drive sprint/lap/free-roam rules are original reconstructions.
  They are the correct starting point for M1, but they are not evidence that the
  retail race director has been ported.
- The 310 m sprint is the only course recommended for M1; the lap course's draw
  coverage is explicitly incomplete in the current derivation.

---

## 8. Evidence paths

| Evidence | Path |
|---|---|
| Inventory JSON | `_work/game-logic-audit/game-logic-inventory.json` |
| Inventory SHA-256 | printed by `verify_inventory.py` (`8e431241531f6eb66eef212aa5b9e6763c78a05e5fe5c3c77f779d9fceca3c0a` at report time) |
| Inventory script | `probes/game-logic-audit/inventory.py` |
| Verifier | `probes/game-logic-audit/verify_inventory.py` |
| AI compile probe | `_work/game-logic-audit/ai-compile-probe.json` |
| AI compile logs | `_work/logs/game-logic-audit/ai-compile/` |
| Game TU failure log | `_work/logs/game-logic-audit/racelogiccore.log` |
| Existing wasm closure | `_work/engine-vehicle-spike/build.py`, `_work/wasm-engine-probe/matrix.json` |
| Existing browser rules | `probes/e1-drive/web/sprint-rules.js`, `sprint-layout.js` |
| Existing net ABI measurement | `docs/work/analysis/net-layout.md` |
