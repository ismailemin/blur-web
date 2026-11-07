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
