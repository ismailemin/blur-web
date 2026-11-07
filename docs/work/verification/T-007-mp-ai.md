# T-007 — online AI opponents (host-simulated, 0–3 per room)

Status: **implementation + evidence**, 7 November 2026. Adds host-controlled AI
opponents to the existing two-human online room on River, Amboy and Gracia. The
AI is an original project driver on the measured centre line; it is not retail
AI and does not change the vehicle physics.

Scope labels: `engineIntegration:true`, `retailProtocol:false`, `webrtc:false`,
`turn:false`, `accounts:false`, `database:false`, `sameCar:false` (each AI may
use a different roster car), `remotePhysicsAuthority:'peer-state'`,
`hostRulesAuthority:true`, `remoteSlots:'1 human + 0..3 AI'`,
`maps:3` (River/Amboy/Gracia), `mapSelection:'host-lobby'`,
`ai:true`, `aiSimulation:'host-only'`, `aiTransport:'host-relay-20Hz'`,
`aiMax:3`, `aiPowerups:false`, `retailAi:false`, `browserClients:2`.

Owned files: `probes/e1-drive/**`, `_work/e1-drive/**`,
`_work/logs/e1-drive/**`, `probes/e1-drive/README.md`,
`docs/work/analysis/e1-drive-slice.md`, this document.
`probes/ai-driver/**`, `probes/net-mvp/**`, `probes/race-rules/**`,
`probes/powerups/**`, `probes/map-slice/**`, `tools/`, `upstream/` and
`game-data/` were not modified. No commit was made by this subagent.

---

## 0. Result summary

| Gate | Result | Evidence |
|---|---|---|
| `verify_e1_drive` (Node) | **2281/2281 checks passed** | `_work/e1-drive/run.json`, `_work/logs/e1-drive/verify-mp-ai-3.log` |
| MP AI Node checks | **16/16** (inside the 2281) | `_work/e1-drive/mp-ai-node-report.json` |
| River AI capture | **PASS**, 1 host + 1 guest + 2 AI, console **0/0** | `_work/e1-drive/browser-evidence-mp-ai.json` |
| Amboy AI capture | **PASS**, console **0/0** | `browser-evidence-mp-ai-amboy.json` |
| Gracia AI capture | **PASS**, console **0/0** | `browser-evidence-mp-ai-gracia.json` |
| Reconnect with AI | guest drop/resume; host AI ticks 403→489; guest poses 264→324 | `browser-evidence-mp-ai.json → race.reconnect` |
| River M1 regression | **PASS**, rows unchanged 970/1074, console 0/0 | `browser-evidence-mp.json` |
| Gracia M3 MP regression | **PASS**, rows unchanged 4065/4253, console 0/0 | `browser-evidence-mp-gracia.json` |
| River M2 power-up regression | **PASS**, console 0/0 | `browser-evidence-mp-powerups.json` |
| Solo River sprint regression | **PASS**, packet hash exact, console 0 | `_work/logs/e1-drive/solo-sprint-regression-mp-ai.log` |
| `verify_asset_probe.py --skip-build` | **57/57 PASS** | `_work/verification/suite.json` |
| `check_e1_poc.py --json` (user 8801 server) | **23/23 PASS**, exit 0 | `_work/logs/e1-drive/check-e1-poc-mp-ai-final.log` |

The River acceptance case — one human host + one human guest + two AI finish the
real 310 m course, both pages render the same table including the AI rows, the
guest never simulates AI, console 0/0 — is met. Amboy and Gracia use the same
path and the driver owner's map control; the Gracia Dodge spawn limit is a typed
refusal.

---

## 1. Lobby / AI contract

The room protocol is unchanged (`probes/net-mvp/**` was not modified). AI is a
host room setting, not a room player:

```text
Host URL:  ?mp=1&host=1&script=sprint&ai=2&aiCars=<slug,slug>&aiProfiles=<profile,profile>
Guest URL: ?mp=1&room=CODE&script=sprint      (AI is inherited read-only)
Lobby UI:  host-only AI count 0..3 + one car select and one skill-profile select per AI
Debug API: window.__mp.setAi({count, cars, profiles})   host only, lobby only
```

Rules:

- `count` is an integer in `[0, 3]`. A guest that passes `?ai=`/`?aiCars=`/
  `?aiProfiles=` is rejected at page load.
- Participant ids are stable: `ai-1`, `ai-2`, `ai-3`; slots follow the two human
  slots (`3`, `4`, `5`). They are **not** room player ids and never appear in
  `room.finished` as players.
- Skill profiles are `cautious` (0.85), `standard` (0.95) and `reference` (1.0).
  They scale only the longitudinal speed target; physics, steering authority,
  car fields, layout and grid are untouched.
- Each AI record is `{id, slot, name, car, carName, profile, speedScale, ai:true}`.
  An unknown car/profile, a count outside 0..3, or a map-specific spawn limit is
  a typed refusal (`built:false`, `errors[]`, `errorCodes[]`), never a silent
  drop.
- Start requires all **humans** ready and `aiRosterReady(ai)` (all AI records
  built). The host start button is disabled otherwise. The guest sees the same
  list read-only and cannot start.
- Changing the room map in the lobby rebuilds the AI list, because the map
  changes the control floor and the spawn support.

### Gracia + Dodge Challenger

`ai-spawn-unsupported`: the driver owner measured the Dodge's front axle
unloaded at the committed Gracia start pose (7 respawns/DNF). The lobby refuses
that combination with a typed code and the message records the reason. Other
cars (Audi, Corvette, Lotus, …) are supported on Gracia.

### AI relay

The room service's only channels are `input`/`state`, and its relay strips extra
fields. AI therefore uses the same project-specific ordered HTTP relay pattern
as the power-up slice, at a new endpoint in `probes/e1-drive/tools/serve.mjs`
(read-only room service untouched):

```text
POST /_mp-ai/relay  {room, from, kind:'roster'|'pose'|'result', payload}
GET  /_mp-ai/relay?room=CODE&after=N&exclude=PLAYER_ID
GET  /_mp-ai/relay/stats?room=CODE
```

- `roster` carries the lobby list (host → guest).
- `pose` carries the 20 Hz snapshot: `{tick, cars:[{id,tick,position,quaternion,speed}]}`.
- `result` carries the merged-AI input rows and the host's per-AI simulation
  diagnostic (`finish`, respawns, state-sequence hash).
- The relay is bounded (1,500 messages/room) and ordered; unknown kinds are a
  400. It is not a retail protocol, not WSS, not authenticated.

---

## 2. Host simulation

- **One wasm instance per AI.** `e1_drive.mjs` has one global world, so the host
  calls `engineFactory()` once per AI, copies the committed
  `Level.levelphysics` and that AI car's `.fields` into the instance's heap, and
  calls `e1_create` at a grounded start slot.
- **Driver.** `web/ai-driver-browser.js` is a verbatim copy of the committed
  `probes/ai-driver/ai-driver.mjs` with exactly one dependency change
  (`node:crypto` → the slice's `web/sha256.js`). The verifier compares the
  controller source and skill tables, then drives both copies on the real wasm:
  identical inputs and finish ticks (Audi reference 849 / 14.15 s; Dodge
  cautious 1014 / 16.90 s).
- **Same fixed tick.** The host steps every AI once per host engine tick in
  `mpAfterLocalTick`, before `RaceSession`: zero input during the 90-tick
  countdown, then `driver.step(state)` → `e1_set_input` → `e1_step` →
  `driver.observe(next, raceTick)`. The AI engine ticks are aligned to the host
  tick (the first AI world is stepped to tick 1 after `startTimeline`).
- **Map control.** The committed driver selects `MAP_CONTROL` for `amboy`/
  `gracia`. Amboy additionally passes `{minSpeed: 3.5}` (the driver owner's
  measured hairpin floor); Gracia passes `null`. River keeps `SPRINT_CONTROL`.
- **Start grid.** AI uses the released provisional grid when it probes clean
  (River/Amboy). Every AI slot is probed with its own real engine for 140 ticks
  (countdown + 50 running) before the final world is created. Gracia's released
  lateral row has no ground at slots 3/4 and the measured path has no ground
  behind the spawn, so the page uses the **spawn-row lateral grid**
  (`+2.2 m/−2.8 m` and `0 m/−2.8 m` along/across the measured tangent). AI never
  shares a human start pose; candidates within 2 m of an occupied human/AI slot
  are skipped.
- **Respawn.** The authoritative `RaceSession` owns the respawn decision. On an
  AI `respawn` event the host rebuilds that AI's world at the event target,
  `driver.reprime`s it and calls `progress.rejoin` before the next tick. The AI
  driver's own observer is kept as a duplicate diagnostic and is not the finish
  judge.
- **Finish / DNF.** AI finish comes from `RaceSession` checkpoint/finish state,
  not a separate judge. `aiResultRows` converts the race tick to the human engine
  tick convention (`+ countdown + 1`, the same −1 race-tick offset the M1 guest
  validation records). A stuck AI is marked DNF at the map tick cap
  (3,600 River / 20,000 package) with a typed reason.
- **No power-ups.** AI participants are never added to the power-up model; in
  this gate no AI can pick up, hold, use or be hit by a power-up.
- **Host finish hold.** With AI present the host records its own finish but
  delays the room `client.finished` report until all AI are finished or DNF, so
  `room.finished` and the AI result exist together on both pages. The host
  engine keeps ticking through its post-finish brake tail for this wait.

---

## 3. Remote rendering

- The packet now declares `diagnostics.extras.remotes.slots = 1 + aiCount`; the
  packet/WebGPU consumer reserves that many car draw sets in the existing ghost
  pipeline. With zero AI the extra block is absent and the M1 packet path is
  unchanged.
- `PacketConsumer.setGhostFrames([{nodeMatrices,tint}, …])` draws N remote cars
  from the already-uploaded car mesh; no new geometry or texture upload. The
  single `setGhostFrame` API is kept for the solo ghost.
- The host page renders its own AI through the same interpolation buffer it
  feeds; the guest renders only host-relayed poses. Tint: human peer cyan,
  AI amber. Position lerp + quaternion slerp with the existing 3-tick display
  delay and the bounded `RemoteDisplay` corrector (0.5 m / 0.25 rad hard set,
  otherwise 3-frame blend). No collision with the player and no collision
  between AI (separate wasm worlds).
- Labels: the multi-line `#mp-remotes` overlay shows the human peer and every AI
  as `AI · <profile> · AI n · <car> · 20 Hz host relay · no collision`. With AI
  present the single M1 `REMOTE` tag is hidden to avoid overlap; the M1 page
  (zero AI) keeps the original tag.
- The E1 state snapshot has no wheel angle, so remote/AI wheel spin remains
  explicitly static, as in M1.

---

## 4. Shared result

Both pages build one table from `room.finished` + the host AI result:

```text
buildMpResult({ layout, room, results, aiPlayers, aiResults })
```

- Human rows are unchanged. AI rows add `ai:true`, `profile`, the same finish
  tick/time convention and the same finish-gate position.
- Rows are ordered by finish tick then slot; DNF rows follow finishers. Ties
  keep the shared position and `tied:true`.
- With zero AI the output object and hash are byte-identical to the M1 builder
  (no `ai` field, no `ai` keys on rows).
- The host posts the AI rows before its delayed human report; the guest waits for
  the AI result (typed status) rather than rendering a table without the AI
  participants.

Measured tables (host):

| Map | P1 | P2 | P3 | P4 | Shared hash |
|---|---|---|---|---|---|
| River | `ai-1` Audi reference 14.383 s (953) | Host 14.667 s (970) | Guest 17.167 s (1120) | `ai-2` Dodge cautious 17.300 s (1128) | `sha256:110d4f21…d20f03ab` |
| Amboy | `ai-1` Audi reference 221.067 s (13,354) | Host 222.000 s (13,410) | Guest 243.233 s (14,684) | `ai-2` Dodge cautious 258.783 s (15,617) | `sha256:6b304d0b…b191b4a6` |
| Gracia | `ai-1` Audi reference 63.667 s (3,910) | Host 66.250 s (4,065) | Guest 70.950 s (4,347) | `ai-2` Corvette cautious 76.650 s (4,689) | `sha256:4a60b2c5…88fd4627e` |

River AI times differ from the standalone AI1 anchors (14.15 / 16.90 s) by the
grid row offset (~0.23 s / 0.40 s), not by a controller change: the verifier
still proves the browser copy and the committed driver produce identical inputs
from the same start pose. The AI rows are ordered by the actual host finish
ticks, so the faster reference AI can finish ahead of the human host.

Per-AI host evidence (from the `result` payload):

| Map | AI | Car | Profile | Finish | Respawns | State hashes | State-sequence hash |
|---|---|---|---|---|---:|---:|---|
| River | ai-1 | Audi R8 V10 | reference | 14.383333 s | 0 | 1,073 | `sha256:74a19987…4dae69fa` |
| River | ai-2 | Dodge Challenger | cautious | 17.300000 s | 0 | 1,128 | `sha256:b832e85f…b307290f` |
| Amboy | ai-1 | Audi R8 V10 | reference | 221.066667 s | 0 | 13,474 | `sha256:fc6b3c28…06aff7c80` |
| Amboy | ai-2 | Dodge Challenger | cautious | 258.783333 s | 0 | 15,617 | `sha256:e6becca2…ae3ce2e91` |
| Gracia | ai-1 | Audi R8 V10 | reference | 63.666667 s | 0 | 4,030 | `sha256:2184c093…f371926875` |
| Gracia | ai-2 | Corvette ZR1 | cautious | 76.650000 s | 0 | 4,689 | `sha256:14962213…c31c04b2` |

---

## 5. Verification

### 5.1 Commands

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp-ai --port 8802 --room-port 8812
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp-ai --map amboy --port 8804 --room-port 8814
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp-ai --map gracia --port 8804 --room-port 8814
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp --port 8802 --room-port 8812
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp --map gracia --port 8804 --room-port 8814
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp-powerups --port 8802 --room-port 8812
```

Ports 8802/8804 + 8812/8814 were used so the user's 8801/8811 servers were not
touched.

### 5.2 Node checks (16)

1. 0–3 roster with `ai-1…` ids and slots 3+ (and empty roster ready).
2. Invalid count/car/profile is a typed refusal.
3. RaceSession participants: 2 humans + `ai-1`/`ai-2`.
4. Browser driver copy source (controller region) and skill tables equal the
   committed driver.
5. Browser copy vs committed driver on the real wasm: identical inputs, Audi
   849.
6. Two fresh runs identical (Audi 849, Dodge cautious 1014; input hashes equal).
7. Amboy reference AI finishes cleanly in the 220–229 s band and repeats
   (225.516667 s; `inputHash sha256:3ecf476c…`).
8. Gracia reference AI matches the committed 66.266667 s anchor and repeats
   (3976 ticks; `inputHash sha256:780ca7b3…`).
9. Gracia + Dodge is `ai-spawn-unsupported`.
10. Map-control hooks: Amboy `{minSpeed:3.5}`, Gracia/River `null`; Dodge only
    refused on Gracia.
11. A 4-participant RaceSession finishes both AI and orders rows by tick.
12. AI rows add the countdown and use the human tick convention.
13. Merged human+AI table is deterministic and includes both AI rows.
14. The 0-AI table keeps the M1 shape (no `ai` field).
15. Guest remote set interpolates 20 Hz poses and corrects display error.
16. The AI relay carries roster → pose → result in order and rejects unknown
    kinds.

Evidence: `_work/e1-drive/mp-ai-node-report.json` and `run.json → mpAi`.

### 5.3 Browser captures

Each capture starts the unchanged room service on the capture port, one Edge
process with two pages, and drives the real scripted sprint. Checks include:
host-only AI count/list, guest read-only list, ids/slots/profiles, host start
gate, one wasm instance per AI with grounded slots, all four rows finished, the
same result hash/rows on both pages, AI rows ordered by tick, human rows within
one tick of local finish, guest AI poses (no local simulation), per-AI
state-sequence hashes, `AI · profile` labels, no power-ups, room statistics and
**console 0/0**. River additionally drops the guest's socket and checks that the
host AI keeps ticking and the resumed guest keeps receiving poses.

Screenshots (River):
`_work/e1-drive/browser-mp-ai-lobby-{host,guest}.png`,
`browser-mp-ai-mid-{host,guest}.png`,
`browser-mp-ai-finish-{host,guest}.png`.
Amboy/Gracia use the same names with `-amboy` / `-gracia`.

### 5.4 Regression

- M1 River capture: rows host 970 / 14.666667 s and guest 1074 / 16.400000 s
  unchanged, console 0/0.
- Gracia M3 MP capture: rows 4065 / 66.250000 s and 4253 / 69.383333 s
  unchanged, console 0/0.
- M2 power-up capture: `clean-console-and-gates`, console 0/0.
- Node suite: 2281/2281; portable suite 57/57; PoC checker exit 0.

---

## 6. Evidence hashes (at report time)

| Object | SHA-256 |
|---|---|
| `mp-ai-node-report.json` | `BC0CF6F345B35248CD4412A175A723A74A1F0DA4DE92FE5F42A2441A03C3D48A` |
| `browser-evidence-mp-ai.json` (River) | `45CF9454D7B0A7254B5CAE9B9C7E81FEB2367F797684CB2108144E607F2E8498` |
| `browser-evidence-mp-ai-amboy.json` | `229ACB2101401E48D23DC8527AD54908AE8E9DDB82774F22C9DD84DED5C6DC4A` |
| `browser-evidence-mp-ai-gracia.json` | `2F2E171B4D14820450F01A230796A6B8FE1740AD03166366FFFC5AF63F1B6645` |
| `browser-evidence-mp.json` (M1 regression) | `E438006F506A5E2A9A5F82646C34C2071A1E29194688A81ACCBEDE6817075BFD` |
| `browser-evidence-mp-gracia.json` | `48E48DA2D1B34692F5B51E43FA4993E2B3D03B5119EAC36EA33F4A4872566987` |
| `browser-evidence-mp-powerups.json` | `925C897241892F33D7C20A6A6CA0EEFAE2CB6DF8FD76324638847556F56C8021` |
| `run.json` (2281 checks) | `A6CE45C4CA727D1ABA66B675564A205A08F0A5D2F2888F5D5C5526E85915F62E` |
| `_work/verification/suite.json` (57/57) | `4CDAFC41F42C15D4381C3387F5633EAADB667A284C76519C440B1F9BB15B7467` |

Room codes, player ids and therefore the shared table hashes change per room by
design; the row order, finish ticks/times, per-AI state hashes and check
outcomes are the reproducible parts.

---

## 7. Limits and non-claims

1. **Host-simulated AI only.** Clients render the host's 20 Hz relay; they never
   run an AI engine or inputs. A guest cannot add, remove or tune AI.
2. **No car-to-car physics.** AI cars are independent wasm worlds; there is no
   collision, slipstream, overtaking logic, traffic or rubber-banding. Two cars
   may occupy the same space without contact.
3. **No power-ups for AI.** The M2 slice is human-only in this gate.
4. **Start grid is project-specific.** AI slots use the race-rules provisional
   grid when its real-engine probe passes; Gracia uses the measured spawn-row
   lateral grid because the released row/behind-spawn candidates have no ground.
   Starting far ahead (≥4.4 m) of the Gracia spawn measurably degrades the
   controller and is not used.
5. **Gracia Dodge is refused**, not silently retried. Ford F100 can finish with
   one respawn on Gracia (driver-owner record); this gate's captures use Audi and
   Corvette.
6. **River/Amboy/Gracia only.** No other map, lap course, free roam, late join,
   restart, host migration, mid-race car/map/AI change or power-up AI.
7. **Loopback HTTP relay.** Reliable/ordered on one machine; no WSS/TLS/auth,
   cross-machine clock skew, packet loss or long room soak claim. The room itself
   remains WebSocket loopback.
8. **Result timing.** AI rows are derived from the host `RaceSession` finish
   tick, converted to the human engine-tick convention with the same −1 race
   offset documented for M1; the raw per-AI race tick and state-sequence hash
   remain in the payload for audit.
9. **No retail AI and no full game.** The driver is the committed original
   centre-line follower; there is no retail AI code, `.aid` route, race director
   parity, menus, results screens, audio mix, damage or anti-cheat claim.

---

## 8. Files

```text
probes/e1-drive/web/ai-driver-browser.js   new  (verbatim committed driver + pure SHA-256)
probes/e1-drive/web/mp-ai.js               new  (lobby roster, participants, result rows, guest remote set, map limits)
probes/e1-drive/web/mp-client.js           AI-aware shared result builder
probes/e1-drive/web/mp-remote.js           unchanged remote corrector/rig (reused per AI)
probes/e1-drive/web/packet-consumer.js     N ghost/remote slots + per-slot tint
probes/e1-drive/web/app.js                 host AI simulation, relay, lobby UI, N-slot render, results
probes/e1-drive/web/index.html             AI lobby controls, remote labels, legend
probes/e1-drive/web/style.css              AI lobby/label/result presentation
probes/e1-drive/tools/serve.mjs            /_mp-ai/relay (ordered, bounded, read-only room service)
probes/e1-drive/tools/verify_e1_drive.mjs  16 MP AI Node checks + report
probes/e1-drive/tools/capture_browser.mjs  --mode mp-ai (River/Amboy/Gracia + reconnect)
probes/e1-drive/README.md                  M4 section
docs/work/analysis/e1-drive-slice.md       §38
docs/work/verification/T-007-mp-ai.md      this file
```
