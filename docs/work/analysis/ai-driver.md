# AI opponent driver — deterministic standalone driver for the River courses

**Status:** implemented and verified, 7 November 2026.
**Location:** `probes/ai-driver/`.
**Scope:** a standalone AI driver plus a read-only wasm evidence harness. It does
not modify `probes/e1-drive/`, `probes/race-rules/`, `probes/net-mvp/`,
`probes/powerups/`, `tools/`, `upstream/` or `game-data/`.
**Inputs:** `_work/e1-drive/module/e1_drive.mjs` + `.wasm`,
`_work/e1-drive/Level.levelphysics`, `_work/e1-drive/cars.json` and each roster
car's `.fields`, `_work/e1-drive/sprint.json`, `_work/e1-drive/sprint-lap.json`,
all read-only.
**Verifier:** `node probes/ai-driver/verify.mjs` → **26/26 checks passed**.
**Map addendum (7 November 2026):** `node probes/ai-driver/verify-maps.mjs` →
**25/25 checks passed** for `usa_amboy` and `spa_barcelona_gracia`; the map
evidence is in §13. The River evidence above is unchanged and still passes.

This document records what the AI driver implements, how it was proved on the
real wasm vehicle, what the skill profiles do, how deterministic it is, and how
it plugs into the R1 rules and N1 room layers. It does not claim retail AI, a
retail `.aid` route, traffic, rubber-banding, car-to-car contact, a full-game
build, or any change to the vehicle physics.

---

## 1. What was built

| File | Purpose |
|---|---|
| `probes/ai-driver/ai-driver.mjs` | standalone driver: `createAiDriver({layout, profile})`, `step(state)`, `observe(state, raceTick)`, `prime`/`reprime`, `snapshot`; control tables, skill profiles, canonical JSON/SHA-256 helpers |
| `probes/ai-driver/run.mjs` | evidence harness: imports the real wasm module, loads the level and every roster car, drives both courses, replays every input sequence in a fresh module, runs the multi-AI races, writes `_work/ai-driver/results.json` |
| `probes/ai-driver/verify.mjs` | independent evidence verifier: artifacts, finishes, NaN, contacts, corridor, replay flags, committed-time comparison, profile cleanliness, races, two-run byte equality, source hygiene; writes `_work/ai-driver/verify.json` |

The driver has no import of e1-drive, race-rules, net-mvp or the wasm module. It
consumes the same committed layout documents and the engine state JSON, and
returns exactly the four-channel input the existing drive path accepts:

```js
const driver = createAiDriver({ layout, profile: 'reference' });
driver.prime(state0);                       // state0 = first engine snapshot
const { input } = driver.step(state);       // [throttle, brake, steer, handbrake]
module._e1_set_input(...input);
module._e1_step();
const events = driver.observe(nextState, raceTick); // checkpoints/laps/finish/respawn
```

`step` is a pure function of the current engine state, the committed layout and
the previous input carried in `state.input` (the engine's own last applied
input). `observe` is the deterministic race observer. Neither reads a clock,
`Math.random`, `Date`, `performance.now` or a timer.

### Engine fields used

`position[3]`, `axisZ[3]`, `angular[1]`, `speed`, `contacts[4]`, `input[4]`.
No force, torque, tyre or solver value is read or written.

### Engine convention

The engine's forward axis is `axisZ`; heading is `atan2(axisZ[0], axisZ[2])`,
so forward is `(sin h, cos h)`. Steering uses the same sign and rate-limit
convention as the committed follower: positive request steers toward positive
heading, and the request is clamped to `previousSteer ± 0.08` per 60 Hz tick.

---

## 2. Read-only data inputs

| Artifact | Value |
|---|---|
| `_work/e1-drive/module/e1_drive.wasm` | `sha256:eb9efc0064f0d871d70b31b335aa478faacc4b4ff4c78e4df193a094c1b53409` (1,006,289 B, 186 objects, deterministic two-link build) |
| `_work/e1-drive/Level.levelphysics` | `sha256:1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28` (1,945,409 B) |
| `_work/e1-drive/sprint.json` | file `sha256:516647664f7ff3590db457f8685a3d4308b030b86fbf962f0e9bfa708da89e49`, layout hash `sha256:9240e9c136059ccd209992999b8570860f99f1bedd4b4ec9ff0a56d5cf8cad53` |
| `_work/e1-drive/sprint-lap.json` | file `sha256:153717d52cd7eae1df3693636405fdf757cd14a36f2ecbbf83bd2539a2c3c460`, layout hash `sha256:167643a9a108bc927d093da2b3d1408d639c1cc4110920511455b68c68ad1f91` |

The five roster cars and their field hashes are checked before any run:

| Car | Drivetrain | Fields SHA-256 |
|---|---|---|
| Corvette ZR1 | RWD | `1c24bbd7f055f904062d1f1b7b377be727a7cf9f64e8ca2c72dff5b138a55381` |
| Lotus Exige Cup260 | RWD | `c967745e1dcd36c0dcc0775ca7b76cf6e039cef324a3a353ac488b2dad86c889` |
| Dodge Challenger | RWD | `0aca70a0ee01e747e968b9166623b68dccc8f7f8fb14cda02a6f1dfb408e8f72` |
| Ford Focus RS | FWD | `28611ddcff67625ad22cb2ac38b20bfc18fbd8e22b22d8bf22c40013ad46d60b` |
| Audi R8 V10 | AWD | `a5e6cd57054c3bcf315cd482c0c93c8fcc639a73ae11521239752c183b414efc` |

Courses:

- **310 m sprint:** 1,245 samples at 0.25 m, finish arc 300.159666 m, declared
  corridor ±6 m, gates `start`/`checkpoint-1`/`checkpoint-2`/`finish`, countdown
  90 ticks.
- **loop-01:** 902 samples at 0.25 m, closed 222.040211 m, three laps, declared
  corridor ±1.25 m, one physical start/finish line, countdown 90 ticks.

The layouts are consumed exactly as committed; no geometry is re-derived and no
layout file is written.

---

## 3. Driver design

### 3.1 Course projection

Every state is projected onto the measured centre line. The nearest segment is
found over the whole polyline on the first call, then over a ±48-sample window
around the previous segment (12 m at 0.25 m/sample, far more than the 0.52 m
travel at 31 m/s in one tick). This is a pure function of the deterministic
state sequence, not a cache of external data.

For loop-01 the closed polyline repeats its first point, so the projected arc is
unwrapped to the branch nearest the previous arc. This keeps `222.0 → 0.0`
continuous across the seam and is what makes the three-lap counter reliable.

The signed lateral offset is computed with the committed convention:

```text
lateral = tangentX · offsetZ − tangentZ · offsetX
```

### 3.2 Speed target

The speed target combines, in order:

1. **Curvature:** for offsets 2…30 m over the braking distance
   (`anticipationMetres + speed · anticipationSeconds`), the path turn gives a
   radius and `sqrt(lateralAccel · radius)`; the minimum caps the target.
2. **Declared band:** the sprint's declared ±6 m corridor caps the target when
   it is narrower than 6 m. The loop's ±1.25 m is a declared respawn rule, not
   the physical lane (the measured flat band is 11.75 m), so it is deliberately
   not used as a speed cap there.
3. **Minimum speed:** 6 m/s sprint, 5 m/s loop (before the skill scale).
4. **Launch guard:** while the car is in the first 15 m and still more than
   0.5 rad off the path heading, the target is capped at 6 m/s.
5. **Finish slowdown:** on the sprint, inside the last 18 m the target is capped
   at 13 m/s so the post-finish brake stops the car before the measured 2.0 m
   narrowing.
6. **Skill scale:** the whole longitudinal target is multiplied by the profile's
   `speedScale`.

### 3.3 Steering

- **310 m sprint:** Stanley form. Heading error to a point 10 m ahead plus
  `atan(2.0 · lateral / max(2, speed))`, with yaw damping `0.8` and a
  speed-scaled gain (the engine's steering authority falls sharply with speed).
- **loop-01:** pure pursuit on a `2.5 + 0.3·v` m lookahead (max 7 m). The
  loop's ~10 m hairpins saturate the Stanley lateral term at low speed; pure
  pursuit was already the committed loop solution.
- **Rate limit:** `steer = clamp(desired, previousSteer ± 0.08)`, where
  `previousSteer` is `state.input[2]`. A driver cannot move lock-to-lock in one
  60 Hz tick, and this stays memoryless.

### 3.4 Longitudinal

Throttle is 1 below the target. Above the target, throttle tapers and brake is
`clamp(0.55 · (speed − target), 0, 1)`. Handbrake is always 0: the driver uses
the service brake, not a handbrake trick.

### 3.5 Finish and brake policy

- **Sprint:** gates are ordered. The start is primed, not counted; checkpoints
  count only in order; the finish is rejected until both checkpoints are
  passed. After the finish crossing the driver returns `[0,1,0,0]` for 120
  further ticks, matching the committed post-finish brake window.
- **Loop:** a lap counts only when the start/finish line is crossed forward
  after at least `(lapsCompleted+1) · 222.040211 − 2 m` of accumulated forward
  travel. Three completed laps set the finish; then the same 120-tick brake.

### 3.6 Observer and respawn

`observe` records checkpoints, laps and lap times. While the race is running it
also evaluates the declared respawn reasons:

- lateral distance beyond the declared corridor + margin;
- chassis more than 1 m below the measured ground at its arc;
- 30 consecutive ticks with no wheel contact.

The respawn target is the last passed checkpoint (sprint) or the start/finish
line (loop), and the harness rebuilds the car with `e1_create` at that pose. The
lap count and timer are retained. This duplicates the declared R1 respawn
semantics for the standalone probe; production should let `RaceSession` own the
respawn and only feed the returned target to the AI.

### 3.7 Determinism

- No `Math.random`, `Date`, `performance.now`, `new Date`, `setTimeout` or
  `setInterval` in the driver source; the verifier scans for them (`V26`).
- The only clock is the integer race tick supplied by the caller.
- All hashes use canonical sorted-key JSON and SHA-256, the same definition as
  `probes/e1-drive/web/packet-hash.js` and `probes/race-rules/hash.mjs`.
- Every run is replayed into a fresh wasm module from the recorded input
  sequence; every per-tick state hash is compared, not only the final hash.

---

## 4. Skill profiles

The profiles change **only** the longitudinal speed target. Physics, grip,
torque, braking capability, steering authority and the layout are untouched.

| Profile | `speedScale` | Status | Description |
|---|---:|---|---|
| `cautious` | 0.85 | supported | 85 % of the reference target |
| `standard` | 0.95 | supported | 95 % of the reference target |
| `reference` | 1.00 | reference | committed follower target; baseline for the recorded times |
| `aggressive` | 1.10 | experimental | 110 % target; expected to be at or beyond the declared loop band |

### Results summary

Full 5-car × 2-course matrix per profile:

| Profile | Runs | Finished | Clean | 310 m mean | loop-01 mean |
|---|---:|---:|---:|---:|---:|
| `cautious` | 10 | 10 | 10 | 16.766667 s | 99.226667 s |
| `standard` | 10 | 10 | 10 | 15.346667 s | 90.000000 s |
| `reference` | 10 | 10 | 10 | 14.740000 s | 86.046667 s |
| `aggressive` | 10 | 10 | **9** | 13.726667 s | 79.573333 s |

“Clean” means finished, 0 respawns, 0 NaN ticks and a matching per-tick replay.

### The documented failure

`aggressive` is **not** a supported clean profile. On loop-01 the Audi R8 V10
exceeds the declared ±1.25 m band and respawns twice:

| Course | Car | Status | Time | Respawns | Max lateral | Replay |
|---|---|---|---:|---:|---:|---|
| loop-01 | Audi R8 V10 | finished after 2 respawns | 80.066667 s | 2 | 1.258774 m | matched |

The race timer keeps running across the respawns, which is why it still
“finishes”. This is recorded in `results.json`
(`profileSummary[aggressive].failed`) and is not hidden or retuned away. The
aggressive Corvette and Dodge also run very close to the band
(1.243497 m and 1.231408 m); they finish without a respawn but are not a safe
default. `cautious`, `standard` and `reference` are the supported profiles.

### Tuning notes

- The reference control constants are the committed e1-drive follower constants
  (`SPRINT_CONTROL`, `LAP_CONTROL` in `ai-driver.mjs`).
- The only project-specific driver values are the skill scale, the ±48-sample
  warm-start window, the 120 post-finish brake ticks and the race tick limits
  (3,600 sprint / 7,200 loop). These are labelled here, not attributed to the
  retail game.
- No profile uses a different start pose, line, layout or physics value.

---

## 5. Verification

### Command

```powershell
node probes/ai-driver/run.mjs
Copy-Item _work/ai-driver/results.json _work/ai-driver/results.previous.json
node probes/ai-driver/run.mjs
node probes/ai-driver/verify.mjs
```

The full matrix is 4 profiles × 5 cars × 2 courses = **40 runs**. Each run is
also replayed into a fresh wasm instance from its recorded inputs.

### Result

```text
checks: 26 total, 26 passed, 0 failed
```

| Check group | What it proves |
|---|---|
| `V01`–`V08` | result schema, driver identity, committed control tables, three supported profiles, artifact/level/layout hashes |
| `V09`–`V15` | one run per selection, no NaN, every per-tick replay matches, supported runs finish, wheel contact on every clean running tick, clean runs inside the declared corridor, canonical hashes |
| `V16`–`V17` | committed follower times were read and the reference AI stays within 50 ms |
| `V18`–`V19` | at least three supported profiles finish cleanly; the experimental profile’s failures are recorded |
| `V20`–`V23` | 2–4 AI race, every entrant finishes, positions ordered by finish tick, two fresh instance sets agree, every race per-tick hash replays |
| `V24`–`V26` | determinism summary, two process-separated result files byte-identical, no random/wall-clock call in the driver source |

### Determinism evidence

- Per-run replay: **133,068 state hashes compared**, all equal, in fresh wasm
  modules.
- Race replay: **20,794 state hashes compared**, all equal.
- Two full process-separated runs produced byte-identical `results.json`:
  `sha256:18020bac0aa5118054538583e35888fa18b4dd048bafa9257593eb7f3baa4b89`.
- `results.json` is 83,074 B; `verify.json` SHA-256 is
  `sha256:10de0c8b1bba98445e6ceca5bd6c980a98d9e798c49a0f95e1f703f49d193b47`
  at report time.

---

## 6. Per-car 310 m results (reference profile)

All five cars finish, 0 respawns, 0 NaN, wheel contact on every running tick.

| Car | Finish time | Max lateral | State-sequence hash |
|---|---:|---:|---|
| Corvette ZR1 | 14.650000 s | 0.590212 m | `sha256:e1286c50fa08285058ebcdea470820486afc195418eb0078d2bb33c0f3d5ee35` |
| Lotus Exige Cup260 | 14.766667 s | 0.614798 m | `sha256:4cf0e1eff4f31644f2bb737ec49fd36d69f60717018d968fc9c8864cead87b7a` |
| Dodge Challenger | 14.916667 s | 0.794924 m | `sha256:36f9da109992fa391cf9324be2df956b1b0ad6b3f3c6b86121092aad0bf0ceae` |
| Ford Focus RS | 15.216667 s | 0.845208 m | `sha256:b01582d345b358c469b77992b284862e387c7db616e6cbd8d8f4b209662f2c6f` |
| Audi R8 V10 | 14.150000 s | 0.703846 m | `sha256:21df3a8ba5b7fa88310a8c5e9737f3f058c8952437260da6c3d13b6a520a10ee` |

Ordering (Audi, Corvette, Lotus, Dodge, Focus) reproduces the committed
order and the XT `torqueScale/mass` expectation.

## 7. Per-car loop-01 three-lap results (reference profile)

All five cars finish three laps, 0 respawns, 0 NaN, wheel contact on every
running tick.

| Car | Lap 1 | Lap 2 | Lap 3 | Total | Best lap | Max lateral | State-sequence hash |
|---|---:|---:|---:|---:|---:|---:|---|
| Corvette ZR1 | 29.000000 | 28.550000 | 28.550000 | 86.100000 s | 28.550000 s | 0.784363 m | `sha256:96094fd474df161837e37d5263b2f31287287c8e11a4ff994d684d7726d29094` |
| Lotus Exige Cup260 | 29.116667 | 28.600000 | 28.583333 | 86.300000 s | 28.583333 s | 0.806823 m | `sha256:f822757c0f3826271e1684c3fa422df5dab9e77cafb372ba1d2476b600688ce0` |
| Dodge Challenger | 29.050000 | 28.550000 | 28.516667 | 86.116667 s | 28.516667 s | 0.854381 m | `sha256:5dafaf94701047727d6263ced1acf336d20820282bde35dfb8d917f63f051099` |
| Ford Focus RS | 29.166667 | 28.533333 | 28.550000 | 86.250000 s | 28.533333 s | 0.983529 m | `sha256:3ae7599e00f0c2418d1823e9f47a501eb8848562605abb96353e81c5c9ea53cb` |
| Audi R8 V10 | 28.650000 | 28.400000 | 28.416667 | 85.466667 s | 28.400000 s | 0.812467 m | `sha256:d2e2eadd8642df6dddae200f25590e5c7951b3ab7b929f10a3c603e35dadc129` |

All five stay inside the declared ±1.25 m band with no respawn.

## 8. Comparison with the committed scripted follower

The committed e1-drive runs are consumed read-only. The AI reference profile
uses the same control constants, start pose and layout.

| Course | Car | Committed | AI reference | Difference |
|---|---|---:|---:|---:|
| 310 m | Corvette ZR1 | 14.650000 s | 14.650000 s | 0.000000 s |
| 310 m | Lotus Exige Cup260 | 14.766667 s | 14.766667 s | 0.000000 s |
| 310 m | Dodge Challenger | 14.916667 s | 14.916667 s | 0.000000 s |
| 310 m | Ford Focus RS | 15.216667 s | 15.216667 s | 0.000000 s |
| 310 m | Audi R8 V10 | 14.150000 s | 14.150000 s | 0.000000 s |
| loop-01 | Corvette ZR1 | 86.100000 s | 86.100000 s | 0.000000 s |
| loop-01 | Lotus Exige Cup260 | 86.283333 s | 86.300000 s | **+0.016667 s** |
| loop-01 | Dodge Challenger | 86.116667 s | 86.116667 s | 0.000000 s |
| loop-01 | Ford Focus RS | 86.250000 s | 86.250000 s | 0.000000 s |
| loop-01 | Audi R8 V10 | 85.466667 s | 85.466667 s | 0.000000 s |

Nine of ten times are identical to the committed follower. The Lotus loop is
one tick slower (lap 2 28.600 s instead of 28.583333 s); the maximum lateral is
0.806823 m instead of the committed 0.810437 m. The difference is kept in
`results.json` and reported by `V17` (max |difference| 0.016667 s), not rounded
away or hidden. It is consistent with a one-tick projection/steer-rate
difference on that car and does not indicate a physics change: the same inputs
replay to identical hashes and the other nine runs match exactly.

For the record, the loop state-sequence hashes for Corvette, Dodge, Focus and
Audi are byte-identical to the committed `sprint-lap-<slug>.json` hashes; the
Lotus differs by one tick. The **sprint** state-sequence hashes are not used as
a committed comparison target: the committed sprint input stream differs from
this controller by a few `1e-9` in the steering request around tick 91 while the
position and speed are equal, and that float32 input field is part of every
state hash. Finish times are identical, which is the comparison this evidence
records. The probe's own replay hashes are compared every tick as described in
§5.

---

## 9. Multi-AI race (M2 AI-opponent proof)

Each AI is a separate wasm module instance (the module has one global world, so
sharing an instance is not possible). All entrants use the same measured start
pose. Because there is no car-to-car physics in this probe, the order is decided
by each car's own deterministic run; no rubber-banding or traffic logic is used.

### `sprint-4ai` — 310 m, 4 AI cars

| Position | Car | Profile | Finish tick (from GO) | Time | Respawns | State-sequence hash |
|---:|---|---|---:|---:|---:|---|
| 1 | Audi R8 V10 | reference | 849 | 14.150000 s | 0 | `sha256:698cc29e4c3a08780d9bd66855b7a94b609b4bf588b4ea1bec67363e42d43f74` |
| 2 | Corvette ZR1 | reference | 879 | 14.650000 s | 0 | `sha256:d46514645d87b77ee206bcf00e3f7d451713ce39f132cc20b74f3dec1947a201` |
| 3 | Lotus Exige Cup260 | standard | 923 | 15.383333 s | 0 | `sha256:cec9cf4be423240cc18b11ccfede10637a2012982fc6d1437afd6a84d5656a07` |
| 4 | Dodge Challenger | cautious | 1014 | 16.900000 s | 0 | `sha256:02d3ef1f0e8454abcf2ab069ceb8a595e5fa94ed789abd9f50372fdb1ef5b128` |

Race hash: `sha256:145431bdd60720c5ac8b4672d2c361ec49dd4b2cef52cac7286560380b8cbae9`.
An independent second set of four fresh module instances produced the same race
hash and the same order. Replaying all four input sequences into fresh modules
matched **940 + 970 + 1,014 + 1,105 = 4,029** per-tick state hashes.

### `lap-3ai` — loop-01, 3 AI cars

| Position | Car | Profile | Finish tick (from GO) | Total | Lap times | State-sequence hash |
|---:|---|---|---:|---:|---|---|
| 1 | Corvette ZR1 | reference | 5166 | 86.100000 s | 29.000000 / 28.550000 / 28.550000 | `sha256:0746619b0ea1b4ee8acc8278764905b195cbc5ab311ed4517fdb56ed5a3364e8` |
| 2 | Lotus Exige Cup260 | standard | 5413 | 90.216667 s | 30.433333 / 29.900000 / 29.883333 | `sha256:7027c9493db5bb714fd86aa8a6556740fab7d7583cd4a53f3d005ca50104bdca` |
| 3 | Audi R8 V10 | cautious | 5913 | 98.550000 s | 33.033333 / 32.766667 / 32.750000 | `sha256:445ecf8d5b25792fef75d935dfadfb68eba450c20c6ffa2fee81aae8f076c98f` |

Race hash: `sha256:f6bb8fd79d37ad37813da00646cec21bc0935ed803c0f4db2ea5df525ca457c9`.
A second set of three fresh module instances produced the same hash and order.
The replay matched 5,257 + 5,504 + 6,004 = 16,765 per-tick state hashes.

The deterministic order is the expected consequence of physics + skill: the
reference Audi wins the sprint, while the tighter loop and the lower cautious
target put the Audi third on loop-01. No result depends on wall time or
iteration order.

---

## 10. Integration recipe: AI as a participant in R1/N1

The AI is meant to be a participant, not a special renderer or a scripted
cut-scene. The integration points are:

### R1 rules (`probes/race-rules/`)

1. The host creates a `RaceSession` with the committed layout and a stable
   roster that includes AI ids (for example `ai-1`, `ai-2`) alongside human ids.
   AI participants are marked ready by the host, so the normal start gate
   applies.
2. The host keeps **one wasm instance per AI** (`e1_drive.mjs` has a single
   global world). Each instance is created at its own start pose with its own
   car fields. The host runs the same fixed 60 Hz tick.
3. Before every engine step, the host calls `driver.step(engineState)` and
   feeds `[throttle, brake, steer, handbrake]` to that instance.
4. After the step, the host calls
   `session.step({ [aiId]: { position, forward: axisZ, contact: onGround } })`
   exactly as it does for a human. The rules layer owns checkpoint/lap order,
   wrong-way, off-course, respawn targets and results.
5. On a `respawn` event, the host rebuilds the AI instance at
   `session.progress.respawnTarget()` (or the event target), re-primes the
   driver with `driver.reprime(newState)`, and calls
   `session.progress.rejoin(aiId, state, session.raceTick)` before the next
   tick. The AI observer in this probe is only a standalone duplicate of that
   policy for evidence.
6. At finish, the rules layer produces the same ordered result row as for a
   human: position, total time, lap times, best lap, DNF/disconnect. The AI does
   not run an independent finish judge.

### N1 room/transport (`probes/net-mvp/`)

1. Add the AI ids to the host's roster as host-controlled participants. They do
   not need a client connection, a ready message or a reconnect slot.
2. The host broadcasts the AI pose/state in the same 20–30 Hz snapshot stream as
   human cars, with the same sequence numbers and interpolation path. Clients
   cannot tell an AI from a remote human at the render layer.
3. The host is authoritative for AI inputs and state. Clients run the same
   deterministic rules/state consumers but never simulate an AI independently.
4. A skill profile is a per-AI difficulty field, not a physics field. Two AI
   cars with different profiles use the same module and same car fields; only
   the speed target differs.
5. Late join/reconnect does not create AI: AI slots are part of the host's
   roster for that race and are removed/restarted with the room's restart
   command.

### Renderer/UI

The existing e1-drive renderer can draw the AI as another car once the host
packet carries its pose. This probe does not touch the renderer, camera, HUD or
audio; those are main-agent integration work.

---

## 11. Limits and non-claims

- **No retail AI.** There is no recovered retail AI code, no behaviour tree, no
  racing-line table, no `.aid` route data and no retail race-director parity.
  The driver is an original pure-pursuit/Stanley follower over the measured
  centre line.
- **No rubber-banding, no traffic, no overtaking logic, no car-to-car contact.**
  Each AI is an independent wasm instance; the multi-AI race proves independent
  deterministic participants, not contact physics.
- **Same start pose in the race.** All AI entrants use the measured start pose;
  no R1 grid offsets are applied. A production grid should use the R1 grid and
  re-run the start-pose evidence for each slot.
- **Two River courses plus two measured maps.** The 310 m sprint and loop-01
  are proved in §6–§9; the measured `usa_amboy` and `spa_barcelona_gracia`
  paths are added in §13. Other River layouts, the 19-level audit and the
  free-roam basin are still not driven.
- **The probe duplicates the declared respawn rules** for standalone evidence.
  Production must let `RaceSession`/`RespawnPolicy` own respawn and results.
- **Not wired to net-mvp.** The recipe above is the integration contract; no
  two-client network run was performed in this task.
- **No full-game claim.** No menus, lobby, power-ups, damage, audio mix,
  results screen or additional maps were added.
- **Aggressive profile is experimental.** The Audi loop-01 run needs two
  respawns; the Corvette/Dodge aggressive runs are at the edge of the declared
  band. They are reported, not hidden.
- **Physics unchanged.** The harness only calls `e1_create`, `e1_set_input`,
  `e1_step`, `e1_get_state`, `e1_ground_probe`/`e1_last_error` on the existing
  module. No engine, XT, tyre, solver, mass or layout value was modified.

---

## 12. Evidence paths

| Evidence | Path |
|---|---|
| Driver module and API | `probes/ai-driver/ai-driver.mjs` |
| Evidence harness | `probes/ai-driver/run.mjs` |
| Evidence verifier | `probes/ai-driver/verify.mjs` |
| Full results (40 runs, races, hashes) | `_work/ai-driver/results.json` |
| Previous identical process run | `_work/ai-driver/results.previous.json` |
| Check-by-check verification | `_work/ai-driver/verify.json` |
| Run logs | `_work/logs/ai-driver/run.log`, `_work/logs/ai-driver/run-second.log` |
| Committed layouts | `_work/e1-drive/sprint.json`, `_work/e1-drive/sprint-lap.json` |
| Committed follower references | `_work/e1-drive/sprint-<slug>.json`, `_work/e1-drive/sprint-lap-<slug>.json` |
| Existing follower source (read-only) | `probes/e1-drive/web/sprint-script.js` |
| Existing rules layer | `probes/race-rules/` |
| Existing room transport | `probes/net-mvp/` |

---

## 13. Measured M3 maps: `usa_amboy` and `spa_barcelona_gracia`

**Status:** implemented and verified on the real wasm, 7 November 2026.
**Verifier:** `node probes/ai-driver/verify-maps.mjs` → **25/25 checks passed**.
**Scope:** the same standalone driver, the same read-only wasm harness. No
change to `probes/e1-drive/`, `race-rules`, `net-mvp`, `powerups`, `map-slice`,
`tools`, `upstream` or `game-data/`.

### 13.1 Inputs and control selection

| Artifact | Value |
|---|---|
| `_work/e1-drive/amboy/layout.json` | 2,060.595408 m, 8,673 samples, file `sha256:b89ae430dff3aaea3511abc6244687430ec66433055bfbcb4eb63b3a1d364f8d`, content `sha256:bccb6bed853827099e5efb55381cb638fda83690201ade40d80fbb095b08f644` |
| `game-data/Blur/levels/usa_amboy/Level.levelphysics` | 4,442,528 B, `sha256:18c73e1cca6f13c5bbd4937454f25ec3163a67553fea6842a7797400af2175f2` |
| `_work/e1-drive/gracia/layout.json` | 624.913781 m, 2,571 samples, file `sha256:e2f9a1114c283ca84838db96286c5482e9b7b6c4fec779b34bbb4a579991a3b8`, content `sha256:1aa622fd77a4637d5b2ddfd9292cc8cd3afd61df197db581db078826133faf30` |
| `game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics` | 5,569,121 B, `sha256:acfb58a20ff7adced0b2424dc39474509e6b4c4c805729fd9463bdd310a173c0` |
| `_work/e1-drive/module/e1_drive.wasm` | 1,012,634 B, `sha256:bcdc2d994a499cc399333b44cfc418d6594f8b5182a668c3a9df761d891de265` (the hash recorded in `build.json`) |
| `_work/e1-drive/cars.json` | 15 active roster cars, each `.fields` hash checked before the run |

The driver selects the measured-path table when `layout.courseId` is `amboy` or
`gracia`. The table is the committed `AMBOY_CONTROL` from
`probes/e1-drive/web/sprint-script.js` (read-only reference):

```text
cruiseSpeed 12 m/s, lateralAccel 2.5 m/s^2, minSpeed 5 m/s,
pure pursuit lookahead 3 + 0.25*v m (max 6), finish cap 10 m/s over 18 m,
launch cap 5 m/s, steer rate 0.08/tick, brake gain 0.55
```

The declared corridor is read from `layout.course.band.halfWidthMetres`
(6 m on both maps), not from a `corridor` field; the band is a declared
controller/respawn band, not a measured road width. The finish gate and the
ordered checkpoints are the committed layout gates. The skill scale still
multiplies only the longitudinal target.

### 13.2 The Amboy tuning (only controller constant changed)

The committed `AMBOY_CONTROL` has `minSpeed = 5 m/s`. The measured Amboy path
turns tighter than that floor allows: the minimum curvature radius over the
controller scan is **6.056 m at arc 82.0 m**, so the raw curvature target there
is `sqrt(2.5 * 6.056) = 3.89 m/s`. With the floor at 5 m/s, three cars run wide
at the 78–96 m hairpin and leave the surface:

| Map | Profile | Car | Status | Respawns | First reason |
|---|---|---|---:|---:|---|
| amboy | standard | Ford FR100 | DNF | 19 | airborne 30 ticks |
| amboy | standard | Ford Bronco | DNF | 19 | below-ground 1 m |
| amboy | reference | Ford FR100 | DNF | 20 | airborne 30 ticks |
| amboy | reference | VW Golf W12 | DNF | 19 | airborne 30 ticks |
| amboy | reference | Ford Bronco | DNF | 19 | below-ground 1 m |

The committed-policy matrix is preserved in
`_work/ai-driver/results-maps-committed.json` (51/60 clean). The tuned policy
changes **one constant**: Amboy `minSpeed` 5 → **3.5 m/s**. Gracia keeps the
committed 5 m/s. With that change all **30/30 Amboy runs** (15 cars × reference
and standard) finish cleanly with 0 respawns, 0 NaN and wheel contact on every
running tick. The cost is documented in §13.3: the tuned Amboy Corvette
reference is 225.516667 s instead of the committed 222.050000 s. The
committed-control anchor below still reproduces 222.050000 s exactly.

Rejected variants (all tested on the real wasm):

| Variant | Amboy | Gracia | Decision |
|---|---|---|---|
| committed lookahead 3 m, min 5 | 25/30 Amboy clean | 26/30 Gracia clean | anchor only |
| lookahead 2.0 / 1.5 m | worse: the Corvette itself leaves the surface and respawns | worse | rejected |
| min 4 m/s (spot test) | the three reference failures finish in the spot test | Corvette 66.566667 s | rejected (same anchor cost, no benefit) |
| **min 3.5 m/s (Amboy only)** | **30/30 clean** | unchanged 26/30 | **used** |

### 13.3 Committed-control anchor

The matrix uses the tuned Amboy floor, so the reference Corvette is re-run with
the committed `MAP_CONTROL` (no override) on both maps. Both runs are exact:

| Map | AI time | Committed time | AI finish hash | Committed hash | Exact |
|---|---:|---:|---|---|---|
| amboy | 222.050000 s | 222.050000 s | `sha256:696e5f14e6d9efa19e0610d5afa4a81beb6724b920a599e3f7111102ae9a36d4` | same | time + hash |
| gracia | 66.266667 s | 66.266667 s | `sha256:cf089202c5ca82327bc068b2a56124f8213443f817c9446fb49c95b8a8e39ce7` | same | time + hash |

The anchor also matches the committed max lateral (1.472246 m Amboy,
1.276489 m Gracia) and replays every per-tick hash. This is the strongest
fidelity statement: with the committed controller the AI is the committed
scripted follower, not an approximation.

### 13.4 Amboy results — 15 cars × 2 profiles (tuned Amboy min 3.5)

All 30 runs: finished, 0 respawns, 0 NaN, contact on every running tick, inside
the declared 6 m band.

| Car | Ref time | Ref max lat | Std time | Std max lat |
|---|---:|---:|---:|---:|
| Corvette ZR1 | 225.516667 | 1.479593 | 235.850000 | 1.447723 |
| Lotus Exige Cup260 | 224.166667 | 1.394293 | 234.983333 | 1.396616 |
| Dodge Challenger | 223.616667 | 1.516116 | 233.950000 | 1.499371 |
| Ford Focus RS | 222.683333 | 1.485086 | 233.550000 | 1.448846 |
| Audi R8 V10 | 220.233333 | 1.833159 | 230.633333 | 1.738628 |
| Audi TT | 227.700000 | 1.237860 | 238.400000 | 1.212499 |
| Ford F100 OffRoad | 223.416667 | 1.507787 | 233.983333 | 1.486952 |
| Ford FR100 | 227.266667 | 1.596451 | 235.666667 | 1.592252 |
| VW Golf W12 | 220.516667 | 1.689061 | 230.566667 | 1.623641 |
| Ford Mustang GTR | 223.483333 | 1.436234 | 233.566667 | 1.364257 |
| Dodge Viper ACR | 222.966667 | 1.543399 | 233.366667 | 1.489617 |
| Audi S3 | 226.283333 | 1.316052 | 236.933333 | 1.267080 |
| Ford Bronco | 228.816667 | 1.457736 | 239.016667 | 1.432669 |
| Nissan Skyline R34 | 218.383333 | 1.880469 | 228.783333 | 1.820288 |
| Chevrolet SoCal HHR | 225.766667 | 1.474923 | 236.433333 | 1.415103 |

Mean: **224.054445 s** reference, **234.378889 s** standard. The standard
profile (0.95 speed scale) is ~4.6 % slower and every car still finishes
cleanly. The fastest reference car is the Nissan Skyline (218.383333 s); the
slowest is the Bronco (228.816667 s). The Corvette's tuned reference differs
from the committed 222.050000 s by **+3.466667 s**, exactly the documented
min-speed tuning cost.

### 13.5 Gracia results — 15 cars × 2 profiles (committed control)

The Corvette reference is exactly the committed 66.266667 s / hash. Thirteen
cars are clean in both profiles. Two cars have a **start-pose contact loss**
unrelated to the path controller:

| Car | Ref time | Ref resp | Ref max lat | Std time | Std resp | Std max lat |
|---|---:|---:|---:|---:|---:|---:|
| Corvette ZR1 | 66.266667 | 0 | 1.276489 | 69.316667 | 0 | 1.261246 |
| Lotus Exige Cup260 | 65.583333 | 0 | 1.222916 | 68.700000 | 0 | 1.213654 |
| Dodge Challenger | **DNF** | **7** | 1.331321 | **DNF** | **7** | 1.331321 |
| Ford Focus RS | 65.466667 | 0 | 1.434794 | 68.566667 | 0 | 1.434794 |
| Audi R8 V10 | 64.116667 | 0 | 1.348366 | 67.300000 | 0 | 1.290352 |
| Audi TT | 67.133333 | 0 | 1.248466 | 70.266667 | 0 | 1.211632 |
| Ford F100 OffRoad | 73.050000 | **1** | 1.283773 | 76.066667 | **1** | 1.246414 |
| Ford FR100 | 66.483333 | 0 | 1.275316 | 69.516667 | 0 | 1.228561 |
| VW Golf W12 | 64.100000 | 0 | 1.334908 | 67.116667 | 0 | 1.309248 |
| Ford Mustang GTR | 65.416667 | 0 | 1.441283 | 68.350000 | 0 | 1.269341 |
| Dodge Viper ACR | 65.000000 | 0 | 1.314339 | 68.116667 | 0 | 1.262070 |
| Audi S3 | 66.866667 | 0 | 1.262680 | 69.950000 | 0 | 1.205496 |
| Ford Bronco | 67.283333 | 0 | 1.348794 | 70.333333 | 0 | 1.269737 |
| Nissan Skyline R34 | 63.550000 | 0 | 1.555522 | 66.683333 | 0 | 1.410780 |
| Chevrolet SoCal HHR | 66.200000 | 0 | 1.251485 | 69.316667 | 0 | 1.229523 |

Mean over finished runs: **66.179762 s** reference, **69.257143 s** standard
(the Dodge DNF is excluded from the mean, not from the result). The standard
profile is ~4.6 % slower here too.

### 13.6 Determinism

- **550,777** per-run state hashes were replayed in fresh wasm instances; every
  one matched, including the runs with respawns (the replay rebuilds at the
  same `afterStep` and compares the rebuilt state hash).
- **71,644** race state hashes were replayed; every one matched.
- Two process-separated runs produced byte-identical `results-maps.json`:
  `sha256:cd8f8fbb50a1a5745f0e298a14a57615bda9bbb5fa0061257710c36eb9d12916`,
  127,832 B.
- `verify-maps.json` at report time:
  `sha256:19bf7c1b736fe0bf5aece152cfe3255b3121be7fc7db5960068441a6017f55cc`.
- The driver source still contains no `Math.random`, `Date.now`,
  `performance.now`, `new Date`, `setTimeout` or `setInterval` (M24).

### 13.7 Multi-AI races (4 AI per map)

Each AI is a separate wasm module instance, all at the same measured start
pose. Amboy uses the tuned min speed; Gracia uses the committed control.

**`amboy-4ai`** — race hash
`sha256:080983ee86ccd2c0190e6d16e6f63b98e886eab813bb4db04cff12d3332ae28c`

| Pos | Car | Profile | Time | Finish tick (from GO) | Respawns | Max lat |
|---:|---|---|---:|---:|---:|---:|
| 1 | Audi R8 V10 | reference | 220.233333 | 13,214 | 0 | 1.833159 |
| 2 | Corvette ZR1 | reference | 225.516667 | 13,531 | 0 | 1.479593 |
| 3 | Ford Focus RS | standard | 233.550000 | 14,013 | 0 | 1.448846 |
| 4 | Lotus Exige Cup260 | standard | 234.983333 | 14,099 | 0 | 1.396616 |

**`gracia-4ai`** — race hash
`sha256:91dab4bdd48364c0ac21fe82a26c0036123b950f89070d6b4c80b566721348f9`

| Pos | Car | Profile | Time | Finish tick (from GO) | Respawns | Max lat |
|---:|---|---|---:|---:|---:|---:|
| 1 | Audi R8 V10 | reference | 64.116667 | 3,847 | 0 | 1.348366 |
| 2 | Corvette ZR1 | reference | 66.266667 | 3,976 | 0 | 1.276489 |
| 3 | Ford Focus RS | standard | 68.566667 | 4,114 | 0 | 1.434794 |
| 4 | Lotus Exige Cup260 | standard | 68.700000 | 4,122 | 0 | 1.213654 |

Both races completed twice in fresh instance sets with the same race hash and
order, and every entrant's per-tick replay matched. The Dodge Challenger is
deliberately not entered on Gracia (see §13.8). There is still no car-to-car
physical contact: the order is each participant's independent deterministic
run.

### 13.8 Profile behaviour and limits

- **Profile behaviour is unchanged.** `reference` is 1.00 of the committed map
  target and `standard` is 0.95; only the longitudinal target is scaled. The
  measured means show the expected ~4.6 % slowdown on both maps, with no
  physics, grip or steering change. No profile changes the start pose, the
  layout, the gates or the respawn semantics.
- **Amboy needs the tuned floor.** The committed 5 m/s floor cannot hold the
  6.056 m minimum-radius hairpin for the FR100, Golf and Bronco. The 3.5 m/s
  Amboy floor is the only controller constant changed, and its cost is the
  +3.466667 s Corvette reference time. The committed-control anchor in §13.3
  preserves the exact 222.050000 s / hash proof.
- **Gracia Dodge Challenger is a spawn-pose limit, not a controller failure.**
  After the mandatory 90-tick countdown the car has only rear-wheel contact
  (`contacts 0110`): the front axle is unloaded at the measured start pose.
  Zero input, brake, coast, partial throttle, handbrake and full/partial steer
  launch sequences were tested; none restored front contact. The car creeps
  ~0.1 m in 500 ticks, then climbs the start surface and goes airborne, so the
  observer respawns it seven times and it does not finish. It is excluded from
  the Gracia race. Its `knownLimit` record is in `results-maps.json`.
- **Gracia Ford F100 OffRoad** has the same start contact loss on its first
  launch; the observer respawns it once at race tick ~402, after which it drives
  the path and finishes (73.05 s reference / 76.07 s standard). It is recorded
  as a one-respawn finish, not as a clean run.
- **The two maps are measured draw-covered paths**, not retail start lines;
  the 6 m band is a declared rule, not a measured road width. No prop
  colliders, opponents, power-ups or race director were added.
- **No e1-drive integration and no full-game claim.** The maps were driven by
  the standalone probe only; the R1/N1 integration recipe in §10 is still the
  contract, not a completed wiring. `probes/e1-drive/` was not modified.

### 13.9 Evidence paths

| Evidence | Path |
|---|---|
| Measured-path driver changes | `probes/ai-driver/ai-driver.mjs` (`MAP_CONTROL`, `measuredPath`, `controlOverrides`) |
| Map evidence harness | `probes/ai-driver/run-maps.mjs` |
| Map evidence verifier | `probes/ai-driver/verify-maps.mjs` |
| Tuned matrix (60 runs, anchor, races, hashes) | `_work/ai-driver/results-maps.json` |
| Identical second process run | `_work/ai-driver/results-maps.previous.json` |
| Committed-policy matrix (before tuning) | `_work/ai-driver/results-maps-committed.json` |
| Tuning + failure traces | `_work/ai-driver/tune-maps.mjs`, `_work/ai-driver/trace-failures.mjs`, `_work/ai-driver/dodge-launch.mjs`, `_work/ai-driver/hairpin.mjs` |
| Check-by-check map verification | `_work/ai-driver/verify-maps.json` |
| Run logs | `_work/logs/ai-driver/run-maps.log`, `_work/logs/ai-driver/run-maps-second.log` |
| Committed layouts | `_work/e1-drive/amboy/layout.json`, `_work/e1-drive/gracia/layout.json` |
| Map physics (read-only) | `game-data/Blur/levels/usa_amboy/Level.levelphysics`, `game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics` |
| Committed scripted map runs | `_work/e1-drive/map-amboy-run.json`, `_work/e1-drive/map-gracia-run.json` |
| River regression (unchanged) | `_work/ai-driver/results.json`, `_work/ai-driver/verify.json` (26/26) |
