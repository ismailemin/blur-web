# T-007 — M1 multiplayer: two browsers, one measured 310 m race

Status: **implementation + evidence**, 7 November 2026. M1 gate for the browser
drive slice. This is an original project room/snapshot/authority layer; it is
not a retail Blur protocol, WebRTC, NAT or anti-cheat claim.

Scope labels: `engineIntegration:true`, `retailProtocol:false`, `webrtc:false`,
`turn:false`, `accounts:false`, `database:false`, `sameCar:true`,
`remotePhysicsAuthority:'peer-state'`, `hostRulesAuthority:true`,
`remoteSlots:1`, `maps:1`, `powerups:false`, `ai:false`, `browserClients:2`.

Owned files: `probes/e1-drive/**`, `_work/e1-drive/**`,
`_work/logs/e1-drive/**`, `probes/e1-drive/README.md`,
`docs/work/analysis/e1-drive-slice.md`, this document.
`probes/net-mvp/**`, `probes/race-rules/**`, `probes/prop-collision/**`,
`probes/audio/**`, `tools/`, `upstream/` and `game-data/` were not modified.
No commit was made by this subagent.

---

## 0. Result summary

| Gate | Result | Evidence |
|---|---|---|
| `verify_e1_drive` (Node) | **874/874 checks passed** | `_work/e1-drive/run.json`, `_work/logs/e1-drive/verify.log` |
| M1 Node protocol/authority checks | **18/18 pass** (inside the 874) | `_work/e1-drive/mp-node-report.json`, `run.json → multiplayer` |
| Two-browser MP capture | **PASS, console 0 on both pages** | `_work/e1-drive/browser-evidence-mp.json` |
| Shared result | identical rows/hash on host and guest; host P1, guest P2 | `browser-evidence-mp.json → finish` |
| Remote pose | 20 samples; max display Δ **3.72e-5 m**, max received-vs-authoritative Δ **7.0e-7 m** | `browser-evidence-mp.json → remotePose` |
| Host rules validation | RaceSession `finished`; guest `finished`; delta **-1 tick** | `browser-evidence-mp.json → finish.host.validation` |
| Room service | 1 room created, 1 finished, 2 connections, 0 protocol errors | `browser-evidence-mp.json → room.stats` |
| `check_e1_poc.py` (user 8801 server) | **23/23 PASS** | `_work/logs/e1-drive/check-e1-poc-mp.log` |
| `verify_asset_probe.py --skip-build` | **40/40 PASS** (the concurrent map-slice work added `amboy-textures`; every step passes) | `_work/verification/suite.json` |
| Sprint/lap/free regression captures | **PASS, console 0** (one car per mode; see §5) | `browser-evidence-{sprint,lap,free}.json` |
| Existing 310 m / lap / free / ghost / audio paths | unchanged; MP is a separate `?mp=1` mode | 874/874 and captures |

The M1 acceptance case — two pages complete the real 310 m course through the
page, both results agree with the host, console 0, no existing gate regressed —
is met. The asset-probe failure is not in an M1 file and is documented with the
exact binary/pin mismatch.

---

## 1. What runs

```text
browser page  A (host, slot 1)                 browser page B (guest, slot 2)
  wasm engine → real car physics                  wasm engine → real car physics
  60 Hz input    ───────────────┐                60 Hz input  ───────────────┐
  20 Hz state    ───────────────┤                20 Hz state  ───────────────┤
                                ▼                                             ▼
                 probes/net-mvp/server.mjs (unchanged, port 8811)
                   room code, roster, ready/start, relay, 30 s resume
                                │
       host RaceSession ◄───────┴────────► guest display
       ordered gates/finish/result          sampleRemote + RemoteDisplay
                                │
                    room.finished {results}
                                ▼
                 buildMpResult() on both pages → same overlay
```

- **Ports:** game server **8802**, room service **8811** for the capture; the
  user's 8801/8810 servers are untouched.
- **URLs:** host `/?mp=1&host=1&script=sprint` (lobby shows the allocated code);
  guest `/?mp=1&room=CODE&script=sprint`. `?name=`, `?car=`, `?mpServer=` and
  the capture-only `?mpPace=` are optional.
- **Launcher:** `tools/serve.mjs --with-room --room-port 8811` starts the game
  server and the unchanged room service in one process. `--port 8802` selects
  the capture game port. The page default room URL is
  `ws://<page-host>:8811/ws`.
- **New read-only routes:** `/net-mvp/` serves the dependency-free
  `client.mjs`/`protocol.mjs`/`hash.mjs`/`race.mjs`; `/race-rules/` serves the
  M1 rules `.mjs` files. Neither source probe is modified.

---

## 2. Authority model (M1)

The host is the **rules and result authority**:

- The host creates the room (`hostId`), runs `RaceSession` over both
  participants, feeds both 20 Hz states into the ordered checkpoint/finish
  tracker, and records the session hash.
- The host's own car is simulated by the real wasm engine on the host page. The
  guest's car is simulated by the guest page; the host consumes the guest's
  20 Hz state (peer-state relay). M1 deliberately does **not** run a second
  physics body for the guest on the host. This is labelled
  `remotePhysicsAuthority:'peer-state'`; a host-side second body is M2 work.
- The host keeps ticking after its own finish until the guest's finish is seen
  (bounded by tail ticks) so the validation is not lost to the 20 Hz relay.
  The measured validation delta is -1 tick in the final run (allowed ≤ 6 in the
  capture gate).
- Both pages report `client.finished {tick, hash}`. The unchanged room service
  broadcasts `room.finished {results}` when every connected player has reported.
  Both pages call the same pure `buildMpResult({layout, room, results})`; the
  rows, positions, race times, layout hash and table hash are identical. The
  displayed time is `(finishTick - countdownTicks) / 60`, so the countdown is
  not charged to the race.
- A missing/invalid finish tick is an explicit **DNF** row, never a guessed
  time. Ties share a position. The finish position is the measured finish-gate
  point, not an invented pose.

Remote display:

- Position lerp + quaternion slerp via the net-mvp `InterpolationBuffer`
  (`sampleRemote`), with a **3-tick (50 ms) display delay** so the buffer has a
  future sample; it never extrapolates.
- A delta above **0.5 m** or **0.25 rad** is a counted hard set; smaller deltas
  blend over **3 frames**. The local engine is never teleported. The HUD shows
  `corrections (hard, blend)`.
- The remote car is drawn through the existing ghost draw pipeline: the same
  uploaded car mesh/textures, a second set of nine node matrices, a translucent
  cyan diagnostic tint, the `REMOTE · … · 20 Hz snapshot · no collision` tag.
  The single-player ghost is disabled in an MP page because the one remote slot
  uses that path.
- The E1 state snapshot has no wheel angle, so the remote wheel spin is
  explicitly static (labelled), not guessed.

M1 scope:

- One measured course (`310m` P48, River), one car for both bodies. The host's
  car at creation is the session car; a guest with a different `?car` fails
  explicitly instead of racing a different body. The lobby car selector is
  metadata.
- The provisional race-rules grid (2.2 m spacing, two per row) places the two
  cars side by side on the start line. It is project-specific, not a retail
  start table.
- No power-ups, no AI, no second remote slot, no late join after start, no
  restart in a room, no host migration.

---

## 3. Two-browser capture (`--mode mp`)

### 3.1 Command

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp --port 8802 --room-port 8811
```

The pass starts the unchanged room service on 8811, the game server on 8802,
one headless Edge process with two page targets (host and guest), and drives the
deterministic scripted sprint on both. The guest uses `?mpPace=0.85` (a
capture-only controller-constant override) so the two cars are visibly separate
and the result table has two distinct times; the host uses the committed pace.

### 3.2 Measured result (final run)

| Field | Value |
|---|---|
| verdict | `clean-console-and-gates` |
| room | `KUY26` (allocated per run; not committed) |
| shared result hash | `sha256:0ef78fcbcac2964fa3d790ad2a1ef67006751a6ca511c2893d5ea87aa68bb189` |
| host row | P1, tick **970**, **14.666667 s** |
| guest row | P2, tick **1074**, **16.400000 s** |
| rows/hash on both pages | identical (`rowsEqual:true`) |
| host RaceSession | phase `finished`, guest `finished`, `guestTickDelta -1`, `guestValidated:true` |
| validation session hash | `sha256:de0bf73abf7edc6549e0faa412d7c59ca58ce3926475d8cde7506ecdcc0a27b7` |
| remote pose samples | **20**; max display Δ **3.72e-5 m**; max received-vs-authoritative Δ **7.0e-7 m** |
| sequences | host sent 324 state / 968 input, guest applied 324 / 968; guest sent 358 / 1072, host applied 358 / 1072 |
| authority flags | guest sees host `authority:true`; host sees guest `authority:false` |
| room stats | connections 2, messagesIn 5491, messagesOut 5545, relayed 5444, protocolErrors **0**, roomsCreated 1, roomsFinished 1, resumes 0 |
| console | host **0** messages, guest **0** messages |

The host/guest times differ because the guest's scripted pace is 0.85; both
overlays show the same table and the same winner. The capture checks the host's
local finish time against the table time and does the same for the guest.

Three clean capture runs (`mp-capture-final*.log`) produced the same finish
ticks/times (host 970 / 14.666667 s, guest 1074 / 16.400000 s) and the same
check outcomes; the allocated room code, player ids and therefore the shared
table hash change per room by design. The remote-pose maximum stayed below
**7.3e-5 m** across runs.

### 3.3 Screenshots

| File | Content |
|---|---|
| `_work/e1-drive/browser-mp-lobby-host.png` | host lobby: room code, name/role, car metadata, roster with host/ready markers, ready/start controls |
| `_work/e1-drive/browser-mp-lobby-guest.png` | guest lobby with the same roster and room code |
| `_work/e1-drive/browser-mp-mid-host.png` | host mid-race; HUD room/ping/sequence/correction rows |
| `_work/e1-drive/browser-mp-mid-guest.png` | guest mid-race; the cyan remote host car is visible ahead with the REMOTE tag |
| `_work/e1-drive/browser-mp-finish-host.png` | host finish; shared RACE RESULT table, host validation row |
| `_work/e1-drive/browser-mp-finish-guest.png` | guest finish; the same RACE RESULT table |

The finish screenshots are the browser evidence required by `AGENTS.md`; the
console gate is `0/0` and `assertions.ok:true`.

### 3.4 What the capture checks

- host allocates a 5-character room code; the guest joins it;
- both rosters show two players, host marker and slots 1/2;
- the same session car is loaded on both pages;
- the host start button is hidden for the guest and disabled until all players
  are ready; ready propagates;
- host start broadcasts `room.started` to both;
- both pages reach the shared result;
- result hashes and rows are identical; host P1 / guest P2; no DNF;
- host and guest local finish times equal their table times;
- the host RaceSession validated the guest finish within 6 ticks;
- the remote display is within 0.5 m at sampled ticks and the received snapshot
  matches the sender state at the same tick within 1e-3 m;
- state/input sequences applied (final in-flight state allowed ±1);
- authority flag is host=true / guest=false;
- remote tag is visible and labelled REMOTE / no collision;
- HUD shows room, ping, sequence and correction counts;
- room service created/finished exactly one room;
- **console 0 on both pages**.

---

## 4. Node protocol/authority checks (no browser)

`verify_e1_drive.mjs` starts the unchanged room service on an ephemeral port and
uses two injected `NetClient`s through the page's `MpSession` wrapper. The 18
checks cover:

1. host create + guest join by code;
2. host/guest slots 1/2 and host marker;
3. host car is the M1 session car (guest pick is metadata);
4. non-host start rejected with `NET_NOT_HOST`;
5. ready propagation;
6. `room.started` seed/startTick/tickHz on both;
7. 60 Hz input + 20 Hz state applied in strict order, 0 violations;
8. host relay `authority:true`, guest relay `authority:false`;
9. interpolation sample inside the received window;
10. remote corrector blends a 0.1 m delta and hard-sets a 2 m delta (counted);
11. both `client.finished` reports finish the room;
12. shared result table identical/deterministic on both clients;
13. finish ticks map to equal race times and host is P1;
14. dropped guest resumes the same player id/slot with a stable host;
15. host RaceSession finishes both participants on the committed 310 m layout;
16. RaceSession results order the faster car first; snapshot/replay hashes repeat;
17. URL/code helpers keep the documented M1 contract;
18. the reconnect path uses only the unchanged room service.

Evidence: `_work/e1-drive/mp-node-report.json` and `run.json → multiplayer`.

---

## 5. Regression gates

| Gate | Command | Result |
|---|---|---|
| Node drive-slice verifier | `node probes/e1-drive/tools/verify_e1_drive.mjs` | **874/874 PASS**, 0 failures |
| Portable asset suite | `python tools/verify_asset_probe.py --skip-build` | **40/40 PASS**, 0 failures (`suite.json` SHA-256 `7485E5619C6FE3131B414F1D6E759818BC6AB2943BB21ADBFA96BA6E005E2DF6`) |
| PoC readiness (user 8801) | `python tools/check_e1_poc.py --json` | **23/23 PASS**, exit 0 |
| MP capture | `node probes/e1-drive/tools/capture_browser.mjs --mode mp --port 8802 --room-port 8811` | **PASS**, console 0/0 |
| Sprint capture | `node probes/e1-drive/tools/capture_browser.mjs --mode sprint --car corvette-zr1-stock --port 8802` | **PASS**, console 0, 0 assertions (`browser-evidence-sprint.json`, SHA-256 `6DE4AE9548BAF279BD7BF7D3DA127C6FC128AA4D527A67BFDDDC1CCE27828549`) |
| Lap capture | `node probes/e1-drive/tools/capture_browser.mjs --mode lap --car corvette-zr1-stock --port 8802` | **PASS**, console 0, 0 assertions (`browser-evidence-lap.json`, SHA-256 `86A31FEB7AFEAA1A3F98CCF188E0B99579932566C3EC1372014065453C83F5DB`) |
| Free capture | `node probes/e1-drive/tools/capture_browser.mjs --mode free --car corvette-zr1-stock --port 8802` | **PASS**, console 0, 0 assertions (`browser-evidence-free.json`, SHA-256 `D131EB4ED12251E7F88A9CABDCB3A8844228A7A017F6D180200402673019E055`) |

The MP mode is separate from the single-player page paths: ghost replay and best
times are explicitly off in an MP page; the `?mp=1` parameter is rejected with
telemetry/soak/survey/collision-probe and non-310 courses. The sprint/lap/free
regression captures use the unmodified single-player modes.

### 5.1 Node verifier details

The full run is deterministic: the same five cars, 310 m/29 m layouts, lap and
free runs, telemetry, ghost and prop V2 anchors as the previous 856-check gate.
The 18 new MP checks bring the total to **874/874**. The new checks use an
ephemeral room port and do not touch the capture's 8802/8811 servers. All Node
commands in this record were run with
`_work/toolchains/emsdk/node/24.19.0_64bit/node.exe`.

---

## 6. Asset-probe note (an external pin, resolved during the task)

The first `--skip-build` run during this task was **38/39**: a concurrent native
scene-reader build had changed `level_inspect.exe` to **249,856 B**, SHA-256
`A633A030F530B9939991B4FC5C67AEBE60D00CD22D59A6FFFB3F74B0FBF6965B`
(timestamp 7 Nov 2026 06:41:36), while the `_work/map-slice/amboy/slice.json`
source record still pinned **247,808 B**,
`63ee2801ac10b7dbafb515b8379bd720c5710593b8576b6f10b00070686a11cd`, from before
that build. No M1 file, map-slice file or native source was modified here; the
mismatch was between two concurrent work streams.

The concurrent map-slice owner re-pinned its source record at 07:02:38
(`slice.json` now pins 249,856 B / `a633a030…`); the map-slice verifier passes,
and the final suite is **40/40** (it also gained the concurrent
`amboy-textures` step). The M1 gate itself is unaffected by that transient.

Final asset-suite evidence:

```text
_work/logs/e1-drive/verify-asset-probe-mp-final.log   SHA-256 AB056D264690DA278F371E843EA2B50ECA9A7CE99F62900519A34849D77C22CA
_work/verification/suite.json                          SHA-256 7485E5619C6FE3131B414F1D6E759818BC6AB2943BB21ADBFA96BA6E005E2DF6
```

---

## 7. Limits and non-claims

1. **WebSocket loopback room service.** Reliable/ordered TCP, no WebRTC/SCTP,
   no STUN/TURN, no NAT traversal test. No TLS/auth/accounts/database; the room
   code is a lookup key, not an authorization secret.
2. **Peer-state remote authority.** The host runs the authoritative rules/result
   and its own physics; it does not run a second physics body for the guest. A
   peer could report a false pose; M1 has no anti-cheat claim.
3. **20 Hz relay granularity.** The host can observe the guest finish one or two
   60 Hz ticks before/after the guest's own report. The shared table uses the
   room's finish ticks; the validation delta is recorded.
4. **One map, one car for both bodies, one remote slot, no power-ups/AI.**
   The lobby car pick is metadata; a guest with a different `?car` fails
   explicitly.
5. **Late join, restart and host migration are out of scope.** The room rejects
   late joins; `R` shows a labelled "not available in M1" status; the URL role
   is fixed.
6. **Same-machine clock.** Cross-machine clock skew, WAN latency/loss and
   long-duration room soak are not tested. The display delay is 3 ticks
   (50 ms); the full result is not delayed.
7. **Capture-only pace.** `?mpPace=0.85` changes the scripted controller's speed
   targets only; it is not a physics change and is used only to make the two
   capture cars visibly separate.
8. **No full-game or retail claim.** One measured River course, one 310 m
   sprint, two browser pages, one opponent slot.

---

## 8. Files and evidence

Code added/changed (committed-code candidates):

```text
probes/e1-drive/web/mp-client.js          new
probes/e1-drive/web/mp-remote.js          new
probes/e1-drive/web/app.js                MP mode hooks
probes/e1-drive/web/index.html            lobby, remote tag, result table
probes/e1-drive/web/style.css             MP presentation
probes/e1-drive/web/sprint-script.js      optional controller constants
probes/e1-drive/tools/serve.mjs           /net-mvp/, /race-rules/, --with-room
probes/e1-drive/tools/verify_e1_drive.mjs 18 MP checks + report block
probes/e1-drive/tools/capture_browser.mjs --mode mp
probes/e1-drive/README.md                 M1 section
docs/work/analysis/e1-drive-slice.md      §32
docs/work/verification/T-007-multiplayer.md this file
```

Evidence (ignored by Git):

```text
_work/e1-drive/run.json                      874 checks, multiplayer block
_work/e1-drive/mp-node-report.json           18-check Node MP report
_work/e1-drive/browser-evidence-mp.json      two-page capture evidence
_work/e1-drive/browser-mp-lobby-host.png
_work/e1-drive/browser-mp-lobby-guest.png
_work/e1-drive/browser-mp-mid-host.png
_work/e1-drive/browser-mp-mid-guest.png
_work/e1-drive/browser-mp-finish-host.png
_work/e1-drive/browser-mp-finish-guest.png
_work/e1-drive/browser-evidence-sprint.json  (regression)
_work/e1-drive/browser-evidence-lap.json     (regression)
_work/e1-drive/browser-evidence-free.json    (regression)
_work/logs/e1-drive/verify.log
_work/logs/e1-drive/verify-full-mp-final.log
_work/logs/e1-drive/edge-mp.log
_work/logs/e1-drive/mp-capture-final3.log
_work/logs/e1-drive/check-e1-poc-mp.log
_work/logs/e1-drive/verify-asset-probe-mp-final.log
_work/verification/suite.json                 40/40 PASS
```

Hashes at report time:

| Object | SHA-256 |
|---|---|
| `browser-evidence-mp.json` | `34048A24FF6648A7240A3A99016593CC3CD2100B1F2152CC3C8379A4120EBE4B` |
| shared M1 result (run KUY26) | `sha256:0ef78fcbcac2964fa3d790ad2a1ef67006751a6ca511c2893d5ea87aa68bb189` |
| host RaceSession validation | `sha256:de0bf73abf7edc6549e0faa412d7c59ca58ce3926475d8cde7506ecdcc0a27b7` |
| `browser-evidence-sprint.json` | `6DE4AE9548BAF279BD7BF7D3DA127C6FC128AA4D527A67BFDDDC1CCE27828549` |
| `browser-evidence-lap.json` | `86A31FEB7AFEAA1A3F98CCF188E0B99579932566C3EC1372014065453C83F5DB` |
| `browser-evidence-free.json` | `D131EB4ED12251E7F88A9CABDCB3A8844228A7A017F6D180200402673019E055` |
| `mp-node-report.json` | `F5110ABB5350D773459A55F5C4ABA9C2DEC4ED08FBD5F478631D657E7E33C5DA` |
| `run.json` (874 checks) | `363760FB136E8E41FBCA99AD7988FD10CE1C4A88C6E7D12BA0A0EFBAB693D50E` |

The per-run room code, player ids and shared table hash change with the room;
the layout hash, finish ticks/times and the check outcomes are the reproducible
parts. The `mp-node-report.json` and `run.json → multiplayer` record the Node
session/result hashes for the deterministic 310 m rules run.
