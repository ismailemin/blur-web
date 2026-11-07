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
- **Two courses only.** The 310 m sprint and loop-01 are proved. Other River
  layouts, the 19-level audit and the free-roam basin are not driven.
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
