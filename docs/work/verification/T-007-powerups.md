# T-007/PWR2 — power-up slice: Mine, Shield, Repair in the online race

Status: **implementation + evidence**, 7 November 2026. Second M2 slice on top of
the committed M1 race (`f9ff085`). This is an original project rules/relay layer
driven by the recovered PWR1 values; it is **not** a retail protocol, a retail
hit-test, a HUD-icon binding or a full-game claim.

Scope labels: `engineIntegration:true`, `powerups:true`,
`powerupTypes:['Bomb','Shield','Repair']`, `placement:'provisional-measured-arc'`,
`hostRulesAuthority:true`, `clientJudgement:false`, `healthModel:'diagnostic-100hp'`,
`retailProtocol:false`, `projectileSlice:false`, `nitro:false`, `ai:false`,
`browserClients:2`, `fullGame:false`.

Owned files: `probes/e1-drive/**`, `_work/e1-drive/**`,
`_work/logs/e1-drive/**`, `probes/e1-drive/README.md`,
`docs/work/analysis/e1-drive-slice.md`, this document. The read-only inputs
`_work/powerups/powerups.json`, `probes/powerups/rules/engine.js`,
`probes/race-rules/**`, `probes/net-mvp/**`, `probes/prop-collision/**`,
`probes/audio/**`, `probes/asset-reader/**`, `tools/`, `upstream/` and
`game-data/` were not modified.

---

## 0. Result summary

| Gate | Result | Evidence |
|---|---|---|
| Node event-model tests | **68/68 PASS** | `_work/e1-drive/powerups-node-report.json`, `_work/logs/e1-drive/powerups-node-tests.log` |
| Two-browser power-up capture | **PASS**, verdict `clean-console-and-gates`, console **0/0** | `_work/e1-drive/browser-evidence-mp-powerups.json`, `_work/logs/e1-drive/mp-capture-powerups.log` |
| Host/guest event counts | identical for every required type | evidence → `scenario.minePlaced.hostCounts` / `guestCounts` |
| Mine hit / wreck / respawn | guest health 100 → 0 → wrecked → respawn at the R1 target → 100 | screenshots `browser-mp-powerups-wrecked-guest.png`, `…-respawn-guest.png` |
| Shield absorb / break | 50-capacity shield absorbs a 100 mine, breaks, 50 overflow damages health | screenshot `browser-mp-powerups-shield-guest.png`, `…-shield-hit-guest.png` |
| Repair | +50 to the diagnostic 100 HP cap | screenshot `browser-mp-powerups-repair-guest.png` |
| Marker pass | mine/pickup/shield markers drawn on both pages, 16 slots, 0 dropped | evidence → `final.*Power.markers` |
| M1 regression (existing 874 checks) | **874/874 PASS**, 0 failures | `_work/e1-drive/run.json`, `_work/logs/e1-drive/verify-874-powerups.log` |
| Portable asset suite (`--skip-build`) | **41/41 PASS** (the concurrent Amboy map slice added `amboy-render`; every step passes) | `_work/verification/suite.json`, `_work/logs/e1-drive/verify-asset-probe-powerups.log` |
| PoC readiness (`check_e1_poc.py --json`) | **23/23 PASS**, exit 0 | `_work/logs/e1-drive/check-e1-poc-powerups.log` |
| M1 two-browser capture regression | **PASS**, console 0/0, host P1 / guest P2 | `_work/e1-drive/browser-evidence-mp.json`, `_work/logs/e1-drive/mp-capture-m1-regression.log` |
| Solo sprint regression | **PASS**, console 0, finish 14.650 s | `_work/e1-drive/browser-evidence-sprint.json`, `_work/logs/e1-drive/sprint-capture-powerups-regression.log` |

The `?powerups=1` flag is default **off**. The M1 `?mp=1` page and every solo
mode keep their previous code paths; the power-up world, relay, HUD and marker
pass only exist when the flag is present.

---

## 1. What runs

```text
host page                                      guest page
  PWR1 manifest + createWorld                    PWR1 manifest (labels only)
  PowerupModel (host authority)                  PowerupView (event reducer)
  pickup proximity / use validation              use intent (no local judgement)
  damage / shield / wreck / R1 respawn           render host snapshot + events
  sequenced events + snapshots                   HUD / markers
        │                                              ▲
        └──── /_powerups/relay (ordered HTTP) ─────────┘
              project-specific control channel;
              probes/net-mvp/** is unchanged
```

- **URL:** `?mp=1&host=1&powerups=1` and `?mp=1&room=CODE&powerups=1`.
  Both pages must add the flag; the capture opens both with it.
- **Inputs:** `_work/powerups/powerups.json` (served read-only at
  `/_work/powerups/powerups.json`) and `probes/powerups/rules/engine.js`
  (served read-only at `/powerups/engine.js`). `createWorld` is passed into the
  e1-drive wrapper; no balancing value is copied or re-typed.
- **Placement:** six pickups on the measured 310 m P48 arcs
  **40 / 90 / 140 / 190 / 240 / 280 m**, cycling **Bomb / Shield / Repair**.
  Every item/event carries `placement:'provisional-measured-arc'` and the
  measured sample index. PWR3 owns the real level/actor placement; this is a
  labelled project choice, not retail data.
- **Inventory:** one active slot (`inventoryCapacity:1`); a second pickup is
  rejected with `pickup-rejected {reason:'inventory-full'}`.
- **Collection:** host-side planar proximity against the recovered
  `PickupRadius=2.0 m`; the collector event enters the inventory and the pickup
  is deactivated for the recovered `0.6 s` timer. Normal pickup respawn seconds
  are not serialized, so `normalRespawnSeconds:null` emits a typed
  `respawn-unresolved`, never a guessed respawn time.
- **Use:** the host validates inventory/cooldown/type. The guest sends
  `{type:'use',slot:0}` over the relay and never applies damage, a mine hit or a
  shield result locally. Bomb placement uses the recovered
  `PlaceBehindDistance=5.0 m` along the engine's forward axis.
- **Wreck/respawn:** the model emits `wrecked`; after a labelled **1.0 s
  diagnostic delay** it emits `respawn` with the R1 target from
  `RaceSession.progress.course.respawnTargetForGate(lastPassedGate)`. The page
  rebuilds the car through the existing `respawnAt()` path, then rejoins the
  sprint/RaceSession progress. The car is not teleported by a guessed pose.

---

## 2. Recovered values (traced to `_work/powerups/powerups.json`)

Manifest: 982,981 B, SHA-256 `6ee5a3e699187086665B4B5330ABCDA29859E77B4464EDAE65E6ED00B7BC73D7`,
content hash `543b059ab7bc511cc61947ba584ff461f8f54b86ea02c06fbd2538f5d2c654df`.

| Item | Value | Manifest source |
|---|---|---|
| Bomb radius | `Radius=1.0 m`, `OuterRadius=3.5 m` | `BombBalancingData` (`pickup.Bomb`, Normal level) |
| Bomb damage | `DamageInflicted=100` | same |
| Bomb lifetime / arming | `Lifespan=60 s`, `MasterMinePrimeTimer=0.3 s` | same |
| Bomb placement | `PlaceBehindDistance=5.0 m`, `Delay=0.2 s` | same |
| Shield | `Health=50`, `Lifetime=6 s`, `Delay=0` | `ShieldBalancingData` (`pickup.Shield`, Normal) |
| Repair | `AmountToRepair=400`, `Delay=0` | `RepairBalancingData` (`pickup.Repair`, Normal) |
| Pickup system | `PickupRadius=2.0`, `PickupDeactivateTimer=0.6 s` | `pickupSystem.parameters` |
| Online pickup parameters | `RecoveryTime=6.0`, `RecoveryTimeSpeedMod=0.1` (recorded, **not** used as Normal respawn seconds) | `modes.onlinePickupParameters` |

The capture's manifest hash is `543b059a…c654df` on both pages. The Node test
asserts each value above independently.

**Project labels (not recovered retail data):**

- health pool **100 HP** (`PWR1 healthScale` is runtime-only);
- wreck delay **1.0 s** (`Normal` respawn seconds are not serialized);
- one inventory slot (`pickupInventoryCapacity` is runtime-only);
- `ShieldBalancingData.Health` as shield HP (prototype assumption);
- Bomb: full damage inside `Radius`, no damage outside `OuterRadius`, and a
  typed `mine-near-miss` between them (the falloff law is not serialized);
- HUD icon: a letter/glyph in a coloured slot, not a retail perk texture (the
  icon-sheet binding is not recovered).

The typed unknowns remain in `snapshot().labels` and in `POWERUP_DEFERRED`.

---

## 3. Host-authoritative event list

Every event carries `seq`, `type`, `at`, `authority` (the host room player id).
The host emits, the relay carries, and the guest applies in `seq` order.

| Event | Payload (abridged) | Emitted by |
|---|---|---|
| `pickup-spawned` | `pickupId, pickupType, position, placement, arc, sampleIndex` | host `spawnPickup` |
| `pickup` | `pickupId, playerId, pickupType, respawn{status}` | host collection |
| `pickup-rejected` | `pickupId, playerId, reason` (`inventory-full`, `not-active`) | host collection |
| `pickup-respawn` / `respawn-unresolved` | pickup + typed `normalRespawnSeconds` | prototype `advance` |
| `mine-placed` | `mine{id,ownerId,position,radius,outerRadius,damage,armAt,expiresAt}` | host `use(Bomb)` |
| `mine-armed` | `mineId, armAt, primeSeconds` | host tick (`MasterMinePrimeTimer`) |
| `mine-detonated` | `mineId, position, directHits[], nearMisses[]` | host tick |
| `mine-near-miss` | `mineId, targetId, falloff{status:'not-serialized'}` | host tick |
| `mine-expired` | `mineId, at` | host tick (`Lifespan`) |
| `shield-activated` | `effect{id,ownerId,expiresAt,capacity,maxCapacity}` | host `use(Shield)` |
| `shield-absorbed` | `targetId, absorbed, remaining, capacity, effectId` | host damage |
| `shield-broken` | `targetId, effectId` | host damage |
| `repaired` | `playerId, amount, health` | host `use(Repair)` |
| `damage` | `targetId, amount, health` | host damage |
| `wrecked` | `targetId, source` | host damage at 0 HP |
| `respawn` | `playerId, health, maxHealth, target{gateId,gateIndex,x,y,z,headingRad}` | host model |
| `use-rejected` | `playerId, reason` (`empty`, `cooldown`, `not-in-slice`, `wrecked`) | host validation |

The capture observed identical host/guest counts for the required set:
`pickup-spawned 9, mine-placed 3, mine-armed 3, mine-detonated 3, wrecked 1,
respawn 1, shield-activated 1, shield-absorbed 1, shield-broken 1, repaired 1,
damage 2` (plus `pickup`, `mine-near-miss`, `respawn-unresolved`,
`pickup-rejected`, `effect-expired`). The host emitted, the guest applied; the
guest never decremented health or destroyed a mine on its own.

---

## 4. Effects, HUD and diagnostic rendering

### 4.1 Marker pass

`packet-consumer.js` gained a bounded marker pass that is inactive unless the
packet carries `diagnostics.extras.powerups`:

- injected mesh `e1.powerup.marker`: 6 vertices / 8 triangles (an octahedron),
  no texture, no UV stream, 16 reserved uniform slots;
- the marker is drawn with the existing translucent ghost pipeline (no depth
  write, no texture sample, no new buffer or texture);
- `setPowerupMarkers()` receives pickup / mine / shield descriptors; the default
  `null` hides the pass, so existing captures and the soak gate are unchanged;
- stats are exposed (`powerupSlots=16`, `powerupDrawsIssued`,
  `powerupFrames`, `powerupDropped=0`).

In the capture both pages drew markers (host 2,939 draws / 436 frames, guest
2,168 / 332). The mine screenshot shows the orange marker; the shield
screenshot shows the large cyan octahedron bubble. The label in the HUD states
`diagnostic markers` and `provisional measured-arc placement`.

### 4.2 HUD

`#powerup-hud` shows:

- inventory icon/letter + type name (`MINE · Bomb`, `SHIELD · Shield`,
  `REPAIR · Repair`) and `E — use · host validates`;
- health bar `100 / 100 HP`;
- shield bar `50 / 50 · 6.00 s` (remaining time from the host snapshot clock);
- status (`ready`, `use intent sent to the host`, `WRECKED — waiting …`,
  `respawned at the race-rules target`);
- the last six sequenced events (`#17 damage -100`, `#18 WRECKED`, …);
- the provisional/diagnostic note and relay errors, if any.

The icon is explicitly a diagnostic glyph; `perk_icons`/HUD texture binding is
not recovered in PWR1.

---

## 5. Node event-model tests (68/68)

`node probes/e1-drive/tools/powerups_model_tests.mjs` loads the real manifest,
`createWorld`, and the e1-drive host wrapper. It asserts:

1. 11 entities; integrated slice = Bomb/Shield/Repair; six deferred types with
   typed reasons.
2. Every recovered value in §2, plus `PickupRadius=2.0` and `0.6 s`.
3. Provisional plan: 6 measured arcs, sample/arc/position agreement, type
   restriction, `provisional-measured-arc` on every entry.
4. Pickup proximity collection, one-slot capacity, second pickup rejected with
   `inventory-full`, rejected pickup stays active, out-of-radius miss.
5. Mine arm before `MasterMinePrimeTimer`; `mine-armed`; direct hit inside
   `Radius`; 100 damage → wreck; respawn delay; R1 target; health restored.
6. Near miss inside `OuterRadius` / outside `Radius`: detonation + typed
   `mine-near-miss`, no damage. Miss outside `OuterRadius`: no detonation;
   `Lifespan=60` expiry and removal.
7. Shield activation (capacity 50, expiry 6); absorb 25; absorb remaining 25;
   break; 25 overflow to health; effect removed.
8. Repair heals 60 → 100 (capped by the diagnostic max).
9. Direct 100 damage → wreck → respawn at the supplied target.
10. Monotonic `seq`, host authority, sorted snapshot, provisional labels.
11. The same command sequence produces the same snapshot JSON.

Report: `_work/e1-drive/powerups-node-report.json` (68 checks, 0 failures).

---

## 6. Two-browser capture (`--mode mp-powerups`)

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp-powerups --port 8803 --room-port 8813
```

The capture starts the unchanged room service on 8813 and the game server on
8803 (the user's 8801/8811 servers were occupied and were not touched), opens
two headless Edge pages, starts the real 310 m race with
`?powerups=1&mpPace=0.55/0.5`, and stages the following through the page debug
surface (`window.__powerups`, capture-only):

1. **Provisional spawn:** six pickups on measured arcs, identical on both
   pages; screenshot `browser-mp-powerups-spawn-host.png` /
   `…-spawn-guest.png`.
2. **Host mine:** host stages/collects a Bomb, uses it; `mine-placed` reaches
   the guest; screenshot `browser-mp-powerups-mine-host.png` (orange marker).
3. **Guest hit:** host places a mine where the guest will be when the recovered
   0.3 s arming timer elapses (`placeMineOnGuest('arm')`); the guest is wrecked;
   screenshot `…-wrecked-guest.png` (health 0, `WRECKED`, feed `#17 damage -100`,
   `#18 WRECKED`). The guest respawns at the R1 target; screenshot
   `…-respawn-guest.png`.
4. **Shield:** host stages a Shield for the guest; the guest sends a use intent;
   `shield-activated` on both pages; screenshot `…-shield-guest.png` (cyan
   bubble, `50 / 50 · 6.00 s`). A staged mine is absorbed (50), breaks the
   shield, and 50 damages health; screenshot `…-shield-hit-guest.png`.
5. **Repair:** host stages a Repair for the guest; the guest sends the intent;
   `repaired +50 · 100 HP`; screenshot `…-repair-guest.png`.

Measured evidence (final run, room `K5X23`; room codes are per-run and not
committed):

| Field | Value |
|---|---|
| verdict | `clean-console-and-gates` |
| manifest hash | `543b059ab7bc511cc61947ba584ff461f8f54b86ea02c06fbd2538f5d2c654df` |
| host/guest required event counts | identical (see §3) |
| host/guest HUD | visible; inventory/health/shield/feed populated; note `provisional measured-arc placement` |
| marker pass | host 2,939 draws / 436 frames; guest 2,168 / 332; slots 16; dropped 0 |
| relay | 18 events, 2 intents, 117 polls, 20 delivered, **0 dropped** |
| console | host **0**, guest **0** |
| room | 1 room created, 0 finished (the capture stops after repair; finish is covered by `--mode mp`) |

The shared M1 capture (`--mode mp`) was also re-run on the same ports:
`clean-console-and-gates`, host P1 14.667 s, guest P2 16.400 s, shared hash
identical on both pages, console 0/0.

---

## 7. Reproduce

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $node probes/e1-drive/tools/powerups_model_tests.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $py   tools/verify_asset_probe.py --skip-build
& $py   tools/check_e1_poc.py --json
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp-powerups --port 8803 --room-port 8813
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp --port 8803 --room-port 8813
& $node probes/e1-drive/tools/capture_browser.mjs --mode sprint --car corvette-zr1-stock --port 8803
```

The page must be served by `probes/e1-drive/tools/serve.mjs` (it now serves
`/_work/powerups/`, `/powerups/engine.js` and `/_powerups/relay`). A server
process started before this change must be restarted.

---

## 8. Evidence and hashes

| Object | SHA-256 |
|---|---|
| `_work/e1-drive/browser-evidence-mp-powerups.json` | `82D86917612D3C34550C51AEC17B8023E2719C2471B7E18DAB42E1D3A6DB89FF` |
| `_work/e1-drive/powerups-node-report.json` | `15F6550DFEFB5D0FF18656ED75AA258B0BE6D0183B704F6FAAD2664DF646E337` |
| `_work/e1-drive/run.json` (874 checks) | `3CF06DF8A5D52A4F63E8D5CEDF50FC621DA17D31B65222C4708CCB49EFA7FB01` |
| `_work/verification/suite.json` (41/41) | `56E59F7C24717E870B6D2E545100BB74B14E46589218B8B00D30FF14026D59BF` |
| `_work/logs/e1-drive/mp-capture-powerups.log` | `1E9C97953226FC205E977FF6C8FAB08965460247D702E9BB410E685F4D6D08C4` |
| `_work/logs/e1-drive/powerups-node-tests.log` | `D8C299DDC7FE1FDA8BE6A6DE5E6333C68F10D61493A51F6D7CFD4CB403929834` |
| `_work/logs/e1-drive/verify-874-powerups.log` | `C0B373BDC67178A14EDF0DCBF3502B306ED90184355CE405491FDD4DA57FBC04` |
| `_work/logs/e1-drive/verify-asset-probe-powerups.log` | `C6E39B8F3B05752F0F2EDCD69CEEA477574F480F086085AAB74D0F4E60360230` |
| `_work/logs/e1-drive/check-e1-poc-powerups.log` | `89823A9868101A4014C2D5ECB839B1C78F9394179B1D75C50E2B175348A5CCBE` |
| `_work/e1-drive/browser-evidence-mp.json` (M1 regression) | `8E36B1985105DC9ABC9FCD11B0463706646F04DBB825C011C274563E7720D73B` |
| `_work/e1-drive/browser-evidence-sprint.json` (solo regression) | `27B7F211831F8224B8FE4A25F678CCA51F1002106CC8EC21B0A4062A0A00358F` |

Screenshots (all under `_work/e1-drive/`):

| File | SHA-256 | Content |
|---|---|---|
| `browser-mp-powerups-spawn-host.png` | `C6400BE480D7C50B29D18C28C7EABB0811FE85EE3F22823B744E584A91BA99F6` | six provisional pickups / HUD at spawn |
| `browser-mp-powerups-spawn-guest.png` | `9B5A6D1BF3CD9CC8AF13F29A9F868322F4D2A0C0673AF06EC1240CBCC5B59500` | guest HUD and roster |
| `browser-mp-powerups-mine-host.png` | `D9263EAD0F466970B7E039D2BEDF539803841C0D4690449378F32EAA79755A2C` | orange mine marker + HUD |
| `browser-mp-powerups-wrecked-guest.png` | `069B38AD1B4246EFBC360BD4A598895211BF61E371BFBC5EDA6FA72A8325866D` | health 0, `WRECKED`, damage/WRECKED feed |
| `browser-mp-powerups-respawn-guest.png` | `5D9960FC495E090D5D70A14909C5519C854CE02524F8564ED9FE0509821EEA5A` | respawned at 100 HP |
| `browser-mp-powerups-shield-guest.png` | `822E3E6BDEEEC3231E40B84DAD1C28E59E528FF40CAAB224C36481D55C494397` | cyan shield bubble, `50 / 50 · 6.00 s` |
| `browser-mp-powerups-shield-hit-guest.png` | `9FE496E43A9E9EEF94CC8B2AC67E376EC28987B9BE2F99325443DBD3BCEDBAAB` | shield broken, 50 HP |
| `browser-mp-powerups-repair-guest.png` | `C0FDB2BD234DDA92F22FC0CB51896F0A1EEBBFF1117663CC895803F65A2383FB` | repaired +50, 100 HP |

---

## 9. Limits and non-claims

1. **One car per page, one remote slot.** The host does not simulate a second
   physics body; M1's `peer-state` remote authority is unchanged.
2. **Diagnostic health scale.** PWR1 has no max-health field. The 100 HP pool,
   the 1.0 s wreck delay and the one-slot capacity are labelled project values;
   they are not a retail damage model.
3. **Mine falloff is not implemented.** Full damage inside `Radius`, no damage
   outside `OuterRadius`, typed `mine-near-miss` in between. The falloff law is
   not serialized; no curve was invented.
4. **Pickup respawn is unresolved.** `Normal` respawn seconds are not
   serialized; the capture/pickups stay deactivated and emit
   `respawn-unresolved`. `RecoveryTime=6.0` is recorded but not substituted.
5. **Provisional placement.** The six arcs are measured 310 m samples but are a
   project choice; PWR3 owns the real level/actor placement. No retail spawn
   point is claimed.
6. **No Nitro/Shock/Shunt/Blindfire/Barge/projectiles.** There is no proven
   engine boost/impulse hook and the projectile lifetime/hit test/human
   targeting are runtime-only (`POWERUP_DEFERRED`). These are not partially
   applied or silently approximated.
7. **HUD icon is a diagnostic glyph.** The `perk_icons` texture binding and loc
   strings are not recovered; the letter/colour slot is labelled as such.
8. **Project-specific relay.** The power-up control channel is an ordered
   in-memory HTTP relay beside the unchanged room service. It is not a retail
   protocol, not WebRTC and not a production service; it has no auth or
   anti-cheat.
9. **Same-machine capture.** Both pages run on one machine; WAN latency, loss
   and cross-machine clocks are not tested. The relay is loopback.
10. **Finish after a respawn.** The M1 finish report uses a logical tick
    (`local engine tick + accumulated rebuild offset`) so a rebuild does not
    reset the race clock; the power-up capture stops after the repair evidence,
    and the separate M1 capture proves the normal finish path. The offset is
    recorded in the finish hash payload.
11. **No retail or full-game claim.** One measured River course, one 310 m
    sprint, two pages, three integrated pickup types.

---

## 10. M2a — Nitro and Shock (online race)

Status: **implementation + evidence**, 7 November 2026. This section adds
Nitro and Shock on top of the PWR2 Mine/Shield/Repair slice. It is an original
project integration using the exact recovered PWR1 curves; it is not a retail
protocol, a retail hit-test or a full-game claim.

Scope labels: `nitro:true`, `shock:true`, `engineIntegration:true`,
`powerupTypes:['Bomb','Shield','Repair','Nitrous','Shock']`,
`hostRulesAuthority:true`, `clientJudgement:false`, `retailProtocol:false`,
`projectileSlice:false`, `shunt:false`, `barge:false`,
`classSource:'project-class-A-assumption'`, `browserClients:2`, `fullGame:false`.

### 10.1 Result summary

| Gate | Result | Evidence |
|---|---|---|
| wasm build | 1,012,634 B, SHA-256 `bcdc2d99…de265`, two links identical | `_work/e1-drive/module/build.json` |
| Boost Node tests | **31/31 PASS** | `_work/e1-drive/boost-node-report.json` |
| Power-up Node tests | **79/79 PASS** | `_work/e1-drive/powerups-node-report.json` |
| E1 drive verifier | **2254/2254 PASS**, 0 failures | `_work/e1-drive/run.json` |
| Portable asset suite | **46/46 PASS** (concurrent map-slice additions; every step passes) | `_work/verification/suite.json` |
| PoC readiness | **23/23 PASS**, exit 0 | `_work/logs/e1-drive/boost-check-e1-poc.log` |
| Native CTest | **15/15 PASS** | `_work/logs/e1-drive/boost-ctest.log` |
| Two-browser `mp-powerups` | **PASS**, `clean-console-and-gates`, console **0/0** | `_work/e1-drive/browser-evidence-mp-powerups.json` |
| Host/guest required event counts | identical | evidence → `scenario.minePlaced.hostCounts/guestCounts` |
| Nitro speed gain | host `10.15 → 48.49 m/s`, guest `12.51 → 48.82 m/s` (peak) | evidence → `scenario.nitro` |
| Shock | host and guest events, 100 damage, brake effect applied; exact `19.995 m/s` sprint-speed target asserted in Node | evidence → `scenario.shock` |
| M1 two-browser regression | **PASS**, console 0/0 | `_work/e1-drive/browser-evidence-mp.json` |
| Solo sprint regression | **PASS**, console 0 | `_work/e1-drive/browser-evidence-sprint.json` |

### 10.2 What runs

- `?mp=1&powerups=1` now integrates five types: **Bomb, Shield, Repair,
  Nitrous, Shock**. The six provisional measured-arc pickups cycle
  `Bomb / Shield / Repair / Nitrous / Shock / Bomb`.
- The host validates use, evaluates the target at the host-observed fire speed
  and emits a sequenced `nitro-activated` or `shock-activated` event.
- Each page applies the host event to **its own** car through
  `e1_boost_queue(...)`; the host does not simulate the guest body. The event
  carries a relative `delayTicks` (4); a receiver queues at
  `localTick + delayTicks - 1` (the wasm `startTick` is the first pre-Simulate
  tick).
- Nitro applies `C_Body::AddForce` along the horizontal body +Z axis **before**
  `C_Scene::Simulate`; Shock applies the velocity-opposed brake force. No
  post-tick velocity or pose is written.
- The host model emits `effect-expired` at 1.3 s (Nitro) / 1.5 s (Shock). The
  HUD timer/status shows the active effect, remaining seconds, target speed and
  the wasm `remaining/applied` diagnostic counters.
- Mine/Shield/Repair behaviour, damage/wreck/respawn, marker pass and the relay
  are unchanged.

### 10.3 Recovered values and provenance

The manifest is the same PWR1 file pinned by PWR2
(`_work/powerups/powerups.json`, content hash
`543b059ab7bc511cc61947ba584ff461f8f54b86ea02c06fbd2538f5d2c654df`).
`web/boost-model.js` evaluates `C_HermiteCurve::Evaluate` exactly (tangents
`tan(deg*pi/180)/3`) and reads the keyframes/class modifiers from the manifest;
no curve sample is re-typed.

| item | value | source |
|---|---|---|
| Nitro force | `300 m/s^2 * mass * adjust` | `FakePhysics.cpp:191`, `:730-734` |
| Nitro force window / duration | 30 ticks (0.5 s) / 78 ticks (1.3 s) | `_value` `FakePhysics.cpp:711/748-751`; PWR1 `Duration` |
| Nitro class-A target @ 24.73 m/s | **52.758963 m/s** (118.018 mph) | exact curve `graphValue 0.590092` |
| Nitro B/C/D @ 24.73 m/s | 50.121015 / 47.483066 / 44.845120 m/s | exact curve * 0.95/0.90/0.85 |
| Nitro class-A @ 35.134 m/s | 64.484674 m/s raw, capped to **55 m/s** | exact curve; project safety cap |
| Shock target @ 24.73 m/s | **19.995236 m/s** (44.728 mph) | exact Shock curve `graphValue 0.223640` |
| Shock floor | `speed - 10 mph` | `ShockManager.cpp:52` |
| Shock radii/lifetime/damage | `Inner 7 / Outer 14 / 1.5 s / 100` | PWR1 `ShockBalancingData` |

The e1 roster does not record `AmaxVehicle::carClass`. M2a uses the exact
class-A target, carries all four class targets in `targetTable`, and labels the
choice in every event (`classSource:'project-assumption: AmaxVehicle::carClass
is not recorded by the e1 roster; M2a uses the exact class-A target'`). The
55 m/s cap is a project safety value, not retail data; `capApplied` records
when it binds.

### 10.4 Authority and event payloads

Every event keeps the PWR2 shape (`seq`, `type`, `at`, `authority`) and adds:

| event | payload additions |
|---|---|
| `nitro-activated` | `targetPlayer, startTick, delayTicks, ticks, targetMps, magnitude, speedMps, classLetter, classModifier, classSource, targetTable, targetSource:'pwr1-hermite', source:'recovered', capMps, capApplied` |
| `shock-activated` | `startTick, delayTicks, ticks, magnitude, innerRadius, outerRadius, lifetime, damage, targets:[{targetPlayer, distanceM, hit, speedMps, targetMps, graphValue, floorMps, floorApplied, damage}], targeting:'project-planar-distance'` |
| `effect-expired` | unchanged PWR1 effect expiry; now also for `kind:'nitro'` and `kind:'shock'` |

The guest never judges a hit: it applies the host event to its own car and
renders the host snapshot/feed. Shock damage is applied on the host through the
existing diagnostic health model; a 100-damage hit wrecks and uses the existing
R1 respawn path.

### 10.5 Tests

**Node boost tests (31/31).** `tools/boost_model_tests.mjs` asserts:

1. the exact target tables at 24.73 and 35.134 m/s for classes A–D
   (52.758963 / 50.121015 / 47.483066 / 44.845120 and the corresponding
   64.484674 / 61.260439 / 58.036205 / 54.811974 raw values);
2. the 55 m/s cap applies exactly above 55, and the Shock sprint-speed target
   is 19.995236 m/s with the 10 mph floor not binding there;
3. the pure queue model applies the 0.5 s force window, expires at 1.3 s,
   brakes to the Shock target, and is deterministic;
4. the real wasm module on the BOOST1 fixture reaches `53.21259 m/s` (class A
   at the measured pre-speed), measures `57.822` at 0.5 s, `51.370` at 1.3 s
   (baseline `33.076`, **+18.294 m/s**), peak `58.608` (**+25.532**), 0 NaN,
   expires with `remaining 0`, and is byte-identical in two fresh instances;
5. Shock at `20.116619 m/s` measures `18.283 m/s` at 1.3 s
   (**-14.793 m/s** from baseline).

**Power-up model tests (79/79).** The existing 68 checks plus Nitro/Shock
coverage: slice membership, recovered values, `nitro-activated` target fields
and full class table, effect expiry, Shock target fields, Shock damage/wreck,
no-target behaviour outside `OuterRadius`, and snapshot determinism.

**Two-browser capture.** `--mode mp-powerups` (ports 8803/8813) stages:

1. host Nitro and guest Nitro (guest sends the use intent; the host sequences
   and the guest applies to its own car);
2. host Shock on the guest and guest Shock on the host, each with the target
   position staged by the capture-only `__powerups` API (the effect is the
   host-authoritative event; the target position is a staging input);
3. the existing mine/wreck/respawn, shield absorb/break and repair evidence.

Measured: **clean-console-and-gates**, console **0/0**, relay 0 dropped,
host/guest counts identical for the required set (`nitro-activated 2`,
`shock-activated 2`, `pickup-spawned 13`, `mine-placed 3`, `mine-armed 3`,
`mine-detonated 2`, `wrecked 3`, `respawn 2`, `shield-activated 1`,
`shield-absorbed 1`, `shield-broken 1`, `repaired 1`, `damage 4`). The capture
also confirms `effect-expired` on both pages. The HUD shows the active effect
timer/status on both pages (`SHOCK · … s · target … m/s · wasm …`).

Screenshots (all under `_work/e1-drive/`):

| file | content |
|---|---|
| `browser-mp-powerups-nitro-host.png` | host in the Nitro effect / HUD timer |
| `browser-mp-powerups-nitro-guest.png` | guest in the Nitro effect / HUD timer |
| `browser-mp-powerups-shock-guest.png` | guest hit by Shock, 0 HP, `WRECKED` |
| `browser-mp-powerups-shock-host.png` | host hit by the guest Shock |
| `browser-mp-powerups-spawn-host.png`, `…-spawn-guest.png` | five-type provisional pickups |
| `browser-mp-powerups-mine-host.png`, `…-wrecked-guest.png`, `…-respawn-guest.png`, `…-shield-guest.png`, `…-shield-hit-guest.png`, `…-repair-guest.png` | unchanged PWR2 evidence |

### 10.6 Reproduce

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $node probes/e1-drive/tools/build_module.mjs
& $node probes/e1-drive/tools/boost_model_tests.mjs
& $node probes/e1-drive/tools/powerups_model_tests.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs
& $py   tools/verify_asset_probe.py --skip-build
& $py   tools/check_e1_poc.py --json
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp-powerups --port 8803 --room-port 8813
& $node probes/e1-drive/tools/capture_browser.mjs --mode mp --port 8803 --room-port 8813
& $node probes/e1-drive/tools/capture_browser.mjs --mode sprint --car corvette-zr1-stock --port 8803
```

### 10.7 Evidence hashes

| Object | SHA-256 |
|---|---|
| `_work/e1-drive/module/e1_drive.wasm` | `BCDC2D994A499CC399333B44CFC418D6594F8B5182A668C3A9DF761D891DE265` |
| `_work/e1-drive/module/build.json` | `8493193CB8AACC5A9D108874318C612298B46EDB5FE28B12C8558B7F0D5C7577` |
| `_work/e1-drive/boost-node-report.json` | `116EAC32C972597EC96D231FDDF85709D8686EC7B66337759E5A79A34CB8465A` |
| `_work/e1-drive/powerups-node-report.json` | `C2134764506147432A8B5F89BC686EF9F64755E5D2A60CFC52AEFC8FD1FA1F55` |
| `_work/e1-drive/browser-evidence-mp-powerups.json` | `2FC0E7B4AE94772D9E65C16BB6561829572E16E7AF66DC7155B50946A5DD1036` |
| `_work/e1-drive/run.json` (2254 checks) | `D51B289BFB773A30EA421E05E3BBEF46F4CD65A6312E1E2F78F2149DDCCB1982` |
| `_work/verification/suite.json` (46/46) | `ED0F9EDE00239CD75FAEFBA3786526EB5CB5B246D694CDD3399B9AF1E1438897` |
| `_work/logs/e1-drive/boost-asset-probe.log` | `11FEB5E8EA06688425D795E5002FD4CC59C9865CD2DDA4979F1D8B822F834B98` |
| `_work/logs/e1-drive/boost-mp-powerups-capture.log` | `D80013EF17671CFDCBFFAE7E873B67B3DC8C145CBB5EB5CACFA605F26D870604` |
| `_work/logs/e1-drive/boost-mp-regression.log` | `53E2922EC5552E486A774227FC2FBE9F1EA6B5998681674188D1B92903B07C53` |
| `_work/logs/e1-drive/boost-sprint-regression.log` | `1FE9D9F0555DAA2F3195F6ED96680D2F56B35D0D2AF46B6E1C914B79A4DFE349` |
| `_work/logs/e1-drive/boost-ctest.log` | `6682AD40BBC0DD37AEEF15C8AD06F17C691F1518110E77D54071AEB8DB88B559` |
| `_work/e1-drive/browser-evidence-mp.json` (M1 regression) | `7C246C56EC34347AADAA1A8BD64B5FD1AD0F85F5A32284A6036A528A38B05342` |
| `_work/e1-drive/browser-evidence-sprint.json` (solo regression) | `CE11C36660836C7078995707EAE427B68F587C9395089E9B75E64E377A2E4076` |

Screenshots:

| File | SHA-256 |
|---|---|
| `browser-mp-powerups-nitro-host.png` | `1E42382C7CB997803FF573D34D82F6FF7CF4D3A184314C9CB7D650AC30DDC839` |
| `browser-mp-powerups-nitro-guest.png` | `AE83B3909F8224359DCD5CB2656D6CD95C3FCF8FC2C19E6978F3F4B522DB46F4` |
| `browser-mp-powerups-shock-guest.png` | `30DEB2B65052A1D55B98DE6637ED8EC6D9E5FD4F8EA89D4607E31789A2FAA961` |
| `browser-mp-powerups-shock-host.png` | `9CBFB7E5A19EA63EA1424BE1BE5416553F4993D0EC389B55030D4ED8298CFB25` |

### 10.8 Limits and deferrals

1. **Car class is a project assumption.** The curve evaluator and all four
   class targets are recovered; `AmaxVehicle::carClass` is not in the e1
   roster, so M2a uses class A and labels it. No retail class assignment is
   claimed.
2. **No wall test.** The 55 m/s cap is arithmetic against the measured body
   length (BOOST1 §6.3); wall penetration is not measured.
3. **Shock hit test is project-planar.** PWR1 serializes radii/lifetime/damage
   but not the retail hit/falloff rule. M2a applies 100 damage to every target
   inside `OuterRadius` by planar distance; no falloff curve is invented.
4. **No host simulation of the guest body.** The host applies the event to its
   own car; the guest applies it to its own car. This is the existing M1
   peer-state authority, not server-side physics for every car.
5. **Shunt, Barge, Blindfire and projectiles remain deferred** with typed
   reasons in `POWERUP_DEFERRED`. Retail Shunt is a projectile hit plus
   `E_FAKE_PHYSICS_FLIP_FORWARD`/`TIP_FORWARD` and damage; the impulse magnitude
   and hit timing are not recovered. Barge/Blindfire need the projectile hit
   test and targeting that PWR1 does not serialize.
6. **Same-machine capture.** Both pages run on one machine over the loopback
   relay; WAN latency, cross-machine clocks and anti-cheat are not tested.
7. **External generated pins refreshed.** Rebuilding the e1 module changes the
   module identity pins in `_work/map-slice/amboy` and `_work/ai-driver`. The
   map-slice physics hashes (`tick0`, `tick60`, state sequence) are unchanged;
   the AI driver was re-run on its existing five-reference-car selection and is
   26/26. Only generated `_work` artifacts were regenerated; no probe source,
   tool or game data was edited.

---

## WPN1 addendum - Blindfire/Bolt, Shunt and Barge (8 November 2026)

Status: **implementation + evidence**. This addendum extends the M2 power-up
slice with the three remaining core weapons; the PWR2 text above remains the
historical Mine/Shield/Repair record.

Scope labels: `engineIntegration:true`, `powerups:true`,
`powerupTypes:['Bomb','Shield','Repair','Nitrous','Shock','Blindfire','Shunt','Barge']`,
`projectiles:true`, `hostRulesAuthority:true`, `clientJudgement:false`,
`healthModel:'diagnostic-100hp'`, `retailProtocol:false`, `fullGame:false`.
Read-only inputs: `_work/powerups/projectiles.json`,
`probes/powerups/rules/projectiles.js` (PWR4), `_work/powerups/powerups.json`,
`probes/powerups/rules/engine.js` (PWR1). No powerups/ai-driver/race-rules/
net-mvp/boost-feasibility/map-slice/tools/upstream/game-data file was modified.

### Result summary

| Gate | Result | Evidence |
|---|---|---|
| Node event-model tests | **107/107 PASS** (39 new weapon checks) | `_work/e1-drive/powerups-node-report.json`, `_work/logs/e1-drive/powerups-node-wpn1.log` |
| PWR4 projectile rules | **19/19 PASS** (unchanged) | `_work/logs/e1-drive/projectiles-node-wpn1.log` |
| PWR1 rules | **9/9 PASS** (unchanged) | suite |
| `verify_e1_drive.mjs` | **2281/2281 PASS** | `_work/e1-drive/run.json`, `_work/logs/e1-drive/verify-e1-drive-wpn1.log` |
| Suite `--skip-build` | **57/57 PASS** | `_work/logs/e1-drive/verify-asset-probe-wpn1.log` |
| Checker | **23/23 PASS**, exit 0 | `_work/logs/e1-drive/check-e1-poc-wpn1.log` |
| Two-browser capture | `clean-console-and-gates`, console **0/0** | `_work/e1-drive/browser-evidence-mp-powerups.json`, `_work/logs/e1-drive/mp-capture-powerups-wpn1.log` |

### Recovered values used

- **Blindfire/Bolt:** Speed 300 m/s, Radius 0.2 m, Damage 50 (XT); lifetime
  10 s, 3 charges, forward fire (runtime-only).
- **Shunt:** Radius 0.75 m, Damage 100 major / 50 minor (XT + minor rule);
  initial speed `clamp(max(forward+15,10),60,110)`, homing
  `clamp(d^2/50^2,0.3,1.0)*50 + targetSpeed`, lifetime 40 s, 1 charge, target
  500 m / cos 45 deg / lowest `(1-dot)*sqrt(d/500)` (runtime-only + recovered
  source rule).
- **Barge:** Radius 7.0 m, Damage 100, Duration 0.4 s (XT); +0.5 m runtime
  padding, 2.0 m inner band, 1.75 m extents fudge. With the documented 2.98 x
  1.68 m envelope the outer/inner bands are 8.08 m / 6.08 m.
- **Target shape:** 1.7105 m sphere = OBB circumradius of the documented
  `CAR_ENVELOPE` (2.98 x 1.68 x 1.35 m); not a recovered retail hull.
- **Shunt impulse:** 20000 N*s, `source:'provisional-impulse'`, applied through
  the BOOST1 queue as kind 3 on the hit car only. Retail is a FakePhysics
  flip/tip whose magnitude is not serialized.
- **Barge jink:** `JINK_BARGE_LEFT/RIGHT` with
  `magnitude:{status:'not-serialized'}`; no linear vehicle impulse.
- **Dynamic objects:** none in this slice, so no `dynamic-object-impulse`.

### Host events

`projectile-fired`, `projectile-hit`, `projectile-expired`, `shunt-hit` (with
the provisional impulse), `barge-activated`, `barge-hit`, `effect-expired`
(Barge) and the typed `projectile-rejected` / `use-rejected` diagnostics. All
host events carry the host `seq`/`authority`; clients send only use intents.

### Capture

`?mp=1&host=1&powerups=1` and `?mp=1&room=CODE&powerups=1` on River. The capture
uses each weapon in both directions: Blindfire 50 damage host to guest and
guest to host; Shunt `flip-forward` + 12.5 m/s provisional impulse + engine
kind 3; Barge radius 7 /
0.4 s / 100 damage. Event counts are identical on both pages:
`projectile-fired 5`, `projectile-hit 4`, `projectile-expired 1`,
`shunt-hit 2`, `barge-activated 2`, `barge-hit 2`. The marker pass reserves 16
octahedron slots and 4 Barge ring slots, 0 dropped. Screenshots:
`browser-mp-powerups-blindfire-host.png`, `...-shunt-guest.png`,
`...-barge-host.png`, `...-barge-guest.png`.

### Limits

- No retail fake-physics magnitude, camera-LOS targeting, ground ray,
  dynamic-object impulse or damage-mode modifiers.
- Shunt linear impulse and the Barge ring are labelled project devices, not
  retail data or FX.
- Target radius/extents are the documented project envelope; missing values
  are typed, never guessed.
- Capture weapon fire is host-staged (`staged:true`) to make both directions
  deterministic; normal play uses the recovered host forward-cone rule.
- No retail-parity or full-game claim.