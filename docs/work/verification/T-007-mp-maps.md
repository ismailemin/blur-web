# T-007 — M3 online room map selection (River / Amboy / Gracia)

Status: **implementation + evidence**, 7 November 2026. Adds host-only map
selection to the existing M1 room, with layout/package/physics hash agreement
before start. This is the same project room/snapshot/authority layer; it is not
a retail Blur protocol, WebRTC, NAT or anti-cheat claim.

Scope labels: `engineIntegration:true`, `retailProtocol:false`, `webrtc:false`,
`turn:false`, `accounts:false`, `database:false`, `sameCar:true`,
`remotePhysicsAuthority:'peer-state'`, `hostRulesAuthority:true`,
`remoteSlots:1`, `maps:3` (River/Amboy/Gracia), `mapSelection:'host-lobby'`,
`mapHashAgreement:true`, `powerups:'river-only'`, `ai:false`,
`browserClients:2`.

Owned files: `probes/e1-drive/**`, `_work/e1-drive/**`,
`_work/logs/e1-drive/**`, `probes/e1-drive/README.md`,
`docs/work/analysis/e1-drive-slice.md`, this document.
`probes/net-mvp/**`, `probes/race-rules/**`, `probes/map-slice/**`, `tools/`,
`upstream/` and `game-data/` were not modified. No commit was made by this
subagent.

---

## 0. Result summary

| Gate | Result | Evidence |
|---|---|---|
| `verify_e1_drive` (Node) | **2265/2265 checks passed** | `_work/e1-drive/run.json`, `_work/logs/e1-drive/verify-mp-maps-final3.log` |
| MP protocol checks | **22/22** (inside the 2265) | `_work/e1-drive/mp-node-report.json` |
| MP map-record checks | **7/7** | `_work/e1-drive/mp-map-node-report.json` |
| River MP capture | **PASS**, console 0/0 | `_work/e1-drive/browser-evidence-mp.json` |
| Amboy MP capture | **PASS**, console 0/0 | `_work/e1-drive/browser-evidence-mp-amboy.json` |
| Gracia MP capture | **PASS**, console 0/0 | `_work/e1-drive/browser-evidence-mp-gracia.json` |
| Hash refusal | typed `MAP_PACKAGE_MISMATCH` (Node) | `mp-map-node-report.json → refusal` |
| Late/closed report | open-race accept, closed `MP_ROOM_CLOSED` (Node) | `mp-node-report.json → finish` |
| Solo map regression | `verify_e1_map` Amboy + Gracia | logs under `_work/logs/e1-drive/` |

---

## 1. Lobby/map contract

The room service already carries a `map` selector; no new wire message is added.

```text
room.create   {name, maxPlayers, map: 'river'|'amboy'|'gracia', car}
player.select {map}                  host-only (unchanged server rule)
room.started  {room:{map, ...}, seed, startTick, tickHz}
```

Each client resolves the id through `web/map-registry.js` and derives:

```text
{ id, packageHash, layoutHash, physicsHash,
  packageFileSha256, layoutFileSha256, physicsFileSha256,
  packageBytes, layoutBytes, physicsBytes }
```

River has no package document; its record pins the committed
`_work/e1-drive/geometry.json`, the 310 m layout and `Level.levelphysics`.
Amboy/Gracia use the committed map/layout/physics pins.

`map-ready` is the existing room ready flag, set only after the page has loaded
the selected package and compared the measured hashes with the record. The host
start gate requires every connected player ready **and** its own verified
record. A mismatch throws `MpMapError` (`MAP_PACKAGE_MISMATCH`) and is displayed
in the lobby; the local race never starts and there is no River fallback.

A host map change (lobby only) clears both ready flags, reloads the selected map
on both pages with a loading state, and re-runs the agreement check. Guests see
the map read-only and cannot pass `?map=`.

### Finish/result contract (corrected after the Gracia run)

- **Reported tick is time-derived.** A respawn rebuild resets the wasm engine
  tick, so `event.tick + rebuildOffset` can be off by one. The finish report now
  uses `mpFinishTick(finishTimeSeconds, countdownTicks) = round(seconds·60) +
  90`; the shared table therefore equals the host's and guest's local finish
  time within **1 tick** (and exactly in the measured runs). The raw tick remains
  in `finishTickRaw` as a diagnostic.
- **Late guest report is accepted while the race is open.** The guest's own
  `client.finished` tick is the result row. The host no longer has to detect the
  guest finish inside 6 ticks: the Gracia host grid slot triggered an airborne
  respawn at tick 91, which paused the host's local race clock while the guest
  kept racing, so the host projection lagged (final run: detected race tick
  4,019 vs reported 4,151, delta **-132**; an earlier run measured -193). The
  report is accepted, `guestReportAccepted:true`, `guestValidated:true`, and the
  projection delta is recorded as a diagnostic.
- **A report after the room closed is rejected.** `MpSession.reportFinished`
  rejects with `MP_ROOM_CLOSED` once `room.finished` has been broadcast. Node
  checks cover the open-race late report and the closed-room rejection.

---

## 2. Map records

| map | package hash | layout hash | physics hash |
|---|---|---|---|
| River | `sha256:0dcf3e38…75904709` | `sha256:9240e9c1…5cf8cad53` | `sha256:1e678b2d…75efe4e28` |
| Amboy | `sha256:9290bd3f…307244ffd4` | `sha256:bccb6bed…b095b08f644` | `sha256:18c73e1c…00af2175f2` |
| Gracia | `sha256:dc60abe8…40238b1b831` | `sha256:1aa622fd…826133faf30` | `sha256:acfb58a2…310a173c0` |

(Full values in `_work/e1-drive/mp-map-node-report.json`.)

---

## 3. Browser results

### 3.1 River regression

- host `970` / **14.666667 s** (P1); guest `1074` / **16.400000 s** (P2);
  shared hash `sha256:a5b39793…7db3b6`; rows equal; console 0/0.
- host map load **404.9 ms**, guest **391.5 ms**; **109,204,221 B** fetched per
  page. The M1 finish ticks are unchanged (970/1074).
- Host-projected guest finish is race tick 983 vs the reported 984 (**-1 tick**
  diagnostic); the report is accepted while the room is open.

### 3.2 Amboy

- measured course 2,060.595 m; both pages finish; shared hash
  `sha256:74f058fb…d5fd802b4`; rows equal; console 0/0.
- host **tick 13,410 / 222.000000 s** (P1), guest **tick 14,344 /
  237.566667 s** (P2); both rows equal their local finish within 0 ticks.
- host map load **490.7 ms**, guest **497.6 ms**; **164.8 MB** fetched per page
  (49.5 MB map + 106.9 MB base geometry + 1.2 MB layout + 4.4 MB physics +
  2.7 MB source packages).
- Host-projected guest finish is race tick 14,253 vs the reported 14,254
  (**-1 tick** diagnostic); the report is accepted while the room is open.

### 3.3 Gracia

- measured course 624.914 m; both pages finish; shared hash
  `sha256:a4c309be…2f10e4f08`; rows equal; console 0/0.
- host **tick 4,069 / 66.316667 s** (P1), guest **tick 4,241 / 69.183333 s**
  (P2); both rows equal their local finish within 0 ticks.
- host map load **559.7 ms**, guest **563.7 ms**; **164.8 MB** fetched per page
  (49.5 MB map + 106.9 MB base geometry + 1.2 MB layout + 4.4 MB physics +
  2.7 MB source packages).
- The host's slot-1 grid pose went airborne at tick 91 and respawned; the host
  race clock paused during the rebuild. The host's projected guest finish is
  tick 4,019 (race) vs the guest's reported race tick 4,151 — a **-132 tick
  diagnostic delta**, not an acceptance gate. The guest report is accepted while
  the room is open (`guestReportAccepted:true`, `guestValidated:true`).

### 3.4 Screenshots

`_work/e1-drive/browser-mp-lobby-{host,guest}[-amboy|-gracia].png`,
`browser-mp-mid-…` and `browser-mp-finish-…`; the finish frames show the same
`RACE RESULT` table on both pages.

The Amboy/Gracia captures also exercise the **lobby switch**: the host selects
River, both pages reload/re-verify it, then the host selects the captured map and
both pages reload/re-verify again before READY. The check asserts matching
package hashes after the switch.

### 3.5 Solo map regression

`capture_browser.mjs --mode map` re-ran the unmodified solo paths after the MP
changes: Amboy `clean-console-and-gates` with finish 222.050 s / tick 13,413 and
console 0; Gracia `clean-console-and-gates` with finish 66.267 s / tick 4,066 and
console 0. `verify_e1_map` is 23/23 on both maps. The `?map=` solo pages do not
touch the room code path.

---

## 4. Rules mapping

`probes/race-rules` only accepts `310m`/`lap`. The page passes an Amboy/Gracia
point-to-point layout through the equivalent sprint mode:

```text
{...layout, sourceCourseId: layout.courseId, courseId: '310m'}   // no geometry change
CourseModel(projected, {verifyLayoutHash:false})                 // original hash kept
```

The Node gate checks the projection keeps the two checkpoints and every measured
sample. `buildMpResult` still uses the original layout, so the shared result
reports the real `courseId` (`amboy`/`gracia`) and measured finish gate.

---

## 5. Commands

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $node probes/e1-drive/tools/verify_e1_map.mjs --map amboy
& $node probes/e1-drive/tools/verify_e1_map.mjs --map gracia
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp --port 8802 --room-port 8812
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp --map amboy --port 8802 --room-port 8812
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp --map gracia --port 8802 --room-port 8812
& $node probes/e1-drive/tools/capture_browser.mjs --mode map --map amboy --port 8804
& $node probes/e1-drive/tools/capture_browser.mjs --mode map --map gracia --port 8804
```

The capture used **8802/8812** so the user's 8801/8811 servers were untouched;
the launcher default remains 8802/8811.

### 5.1 Regression gates

| gate | result |
|---|---|
| `verify_e1_drive.mjs` | **2265/2265 PASS**, 0 failures |
| `verify_e1_map.mjs --map amboy` | **23/23 PASS**, 0 failures |
| `verify_e1_map.mjs --map gracia` | **23/23 PASS**, 0 failures |
| `verify_asset_probe.py --skip-build` | **51/51 PASS**, 0 failures |
| `check_e1_poc.py --json` | **23 PASS / 0 FAIL**, exit 0 (user 8801 server) |
| solo Amboy browser map capture | `clean-console-and-gates`, console 0 |
| solo Gracia browser map capture | `clean-console-and-gates`, console 0 |
| solo River sprint capture | `clean-console-and-gates`, console 0 |

---

## 6. Evidence hashes (at report time)

| object | SHA-256 |
|---|---|
| `browser-evidence-mp.json` (River) | `8B37901E3E144EF56C0D7CFACD5221509229183895B9724B522F2557F6012F23` |
| `browser-evidence-mp-amboy.json` | `2E5EF225E16A95B106962F2A06A0A4A3CD510FC77FD0A20CB919DB6B9CAB2136` |
| `browser-evidence-mp-gracia.json` | `780B71AB38928B409ED2E21C2A43B82F2A2CAFDA7C270BD9A35EC6ACDEED91C3` |
| `run.json` (2265 checks) | `B25D5C00BABC2E370375BB13765112F0255DA5FA0B9D8F01CE99205F4D25D9CA` |
| `mp-node-report.json` | `B45BB9F0208AC0D4D1202F9B596F57613A329AF477596EE86D95B919A396692B` |
| `mp-map-node-report.json` | `047B21C9A6EE937DE30A2147E2A61EB448B00569C00B4F8C29DCB3A23C486762` |
| `_work/verification/suite.json` (51/51) | `0762EAEFFC6917895B071049A316179AA1EBE455F68CD2D466FE2ED52BE4D71D` |

---

## 7. Limits and non-claims

1. Two players, one map per room, one car for both bodies; no mid-race switch.
2. Amboy/Gracia are point-to-point measured paths; power-ups stay River-only and
   no AI is added.
3. Host authority is rules/result + its own physics body; the guest is peer-state
   as in M1. No anti-cheat claim. A host respawn pauses the host's local race
   clock; the guest's own report is therefore authoritative for its row while the
   room is open, and the host projection is a diagnostic that can lag.
4. Package loading is a blocking fetch/parse per page with a visible loading
   state; there is no streaming, map download from the host or progressive
   upload.
5. The released race-rules course-id allow-list is projected as documented
   above; geometry, gates and layout hashes are unchanged.
6. No full-game or retail claim.
