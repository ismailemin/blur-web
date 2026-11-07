# Power-up pickup placement — `usa_la_river` (recovered)

**Date:** 7 November 2026
**Owner:** PWR3 (sub-agent)
**Scope:** `probes/powerups/**`, `_work/powerups/**`, `_work/logs/powerups/**`
and this document only. No change to `probes/e1-drive`, `probes/race-rules`,
`probes/net-mvp`, `probes/asset-reader`, `tools/`, other probes, `upstream/` or
`game-data/`. Game data is read-only.
**Result:** the shipped **54 `PickupPosition` actors** for the raced
`usa_la_river` multiplayer route are recovered, with types, row/shuffle groups,
overrides, collision checks and projections to the measured 310 m and loop-01
arcs. **This is placement data, not a renderer or full-game claim.**

---

## 0. TL;DR

| item | result |
| --- | --- |
| source chain | `multiplayer.bin` `MultiplayerRace.route` → `amax.bin` `Route.City / MultiplayerActorLists` → `actorpack.xt` `LevelActorList` → `PickupPosition` |
| raced River route | record **1643385212**, `RouteNumber 3`, city **USA_LA_River** |
| raced by | **11** `MultiplayerRace` records (all `racing`, 3 laps, `Normal` respawn, random power-ups `Off`) |
| placement actor list | **2512484467** (record 31), **54 `PickupPosition`** actors |
| types | Nitrous 7, Shock 3, Shunt 9, Blindfire 12, Barge 7, Bomb 4, Repair 6, Shield 6 |
| rows | **8 shuffle groups / 26 placements**; **28 fixed-type** placements; 36 total group keys |
| row masks | every group contains exactly one of each allowed type (after the PWR1 `Bolt→Blindfire`, `Mine→Bomb` aliases) |
| overrides | `PickupActiveLevel 1`, `ActivationTimer 0`, `ActivationLap 0`, `RespawnTimerOverride 0`, `ConstantShuffle false`, `ShuffleTypes 0`, no excluded types — **all 54** |
| collision | 54/54 have ground; 52 pass the P48 ≤20° drivable rule; 2 sit at `normal.y = 0.9394` (20.06°), still ~0.70 m above ground |
| 310.395 m course | **0** within the 2.0 m proximity threshold; nearest **72.80 m** |
| loop-01 | **2** within 2.0 m (min **1.26 m**), 3 within 5 m, 5 within 10 m |
| start grid | the same route references a **20-slot `StartPosition`** list 1076417167; its grid is **0.285–34.50 m** from loop-01 |
| duplicates | none (unique uids, unique XZ to 1 mm); min nearest-neighbour **7.809 m** |
| secondary layout | route 2942047131 (`RouteNumber 6`, 0 raced MP rows) has **53** placements in actor list 1521262461 |
| manifest | `_work/powerups/placements.json`, file SHA-256 `6458e37a…11bfc05`, canonical `e5e2e449…b2d3607` |
| verifier | **1415/1415 PASS**, independent direct-offset reader + committed oracle |
| missing | retail `.aid` route arc, `Normal` respawn seconds, runtime RNG order, probability normalisation |

The “within 2.0 m” columns use the PWR1 `PickupRadius = 2.0` as a labelled
**proximity threshold**. The collection trigger itself is an oriented
2.5 × 2.5 × 0.5 m box (`RotateGraphic false`), not a sphere; see §8.5.

The decisive finding: **the retail pickup set is not on the 310 m collision-only
course.** The 310 m course begins at a spawn chosen from a ground probe, while
the retail River route starts at the 20-slot grid near loop-01. The measured
loop-01 is part of the retail start area (the grid is on it), so a few retail
pickups do straddle loop-01. Everything else on the retail route is outside both
measured sub-courses.

---

## 1. Sources and hashes

All payloads are entries inside `game-data/Blur/cache/gamedata.pak` (V2, codec 2
zlib, secure FAT). Nothing was written back or extracted into `upstream/`.

| source | path | PAK offset | stored / logical | SHA-256 (decoded) |
| --- | --- | ---: | ---: | --- |
| actor placement | `\gamedata\levels\usa_la_river\actorpack.xt` | 16,250,880 | 209,136 / 482,156 | `56cac570f2bbd6df91c8fd5535fc6452fba2f9aa3213a28b81109f565b7fb380` |
| pickup definitions | `\gamedata\xt\pickups.bin` | 22,464,512 | 50,403 / 132,056 | `f8e9ba3d0749dcb2b7b775c25fc1e0ec5c337b4835efa947f0cfe329a4965ed7` |
| multiplayer races | `\gamedata\xt\multiplayer.bin` | 22,425,600 | 38,176 / 103,912 | `0dcf60bc5306069c2dfa6a4d89701a27f0e789235a1bcf5f9aa2167d9ef6ab48` |
| routes | `\gamedata\xt\amax.bin` | 21,028,864 | 308,744 / 1,078,940 | `a833487bd66552ecf61b1f13790ee228b18ca8f4d76c524dcd94e44c63d1e3c7` |
| single-player events | `\gamedata\xt\singleplayer.bin` | 22,550,528 | 28,592 / 120,736 | `14af6d07a0fe6eb84253c794e1473196098eeeed215dd7988a8c387d86d65f19` |

Course/target inputs:

| input | path | SHA-256 |
| --- | --- | --- |
| P48 310.395 m course | `_work/drivable-path/path.json` | `81eac0ce413075de33e2b3c0e1c077412b35002420b199d9f05d2fdeef230e7f` |
| P61 loop-01 | `_work/lap-search/loops.json` | `2aabf0cd04fc96b2e2cf903a392fc86fc5b2cd6e85772b9d0e8b523a0826a59c` |
| collision mesh | `game-data/Blur/levels/usa_la_river/Level.levelphysics` | `1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28` |

The PAK offsets/sizes/path CRCs are recorded in `placements.json.sources[]`.

---

## 2. Authority chain (why this is the real set)

`actorpack.xt` contains **51 `LevelActorList` records** and **558
`PickupPosition` actors** in total. The file does not say which list a race uses,
so the list is selected from the shipped route table, not from actor names:

1. `actorpack.xt` has `PickupPosition` (type 36, 108 B) with the fields
   `WorldMatrix`, `PickupType`, `ExcludedPickupTypes`, `PickupActiveLevel`,
   `RotateGraphic`, `ActivationTimer`, `ActivationLap`, `RespawnTimerOverride`,
   `ConstantShuffle`, `ShuffleTypes`, `RowType`, `RowId`.
2. `amax.bin` has `Route` (type 2, 124 B) with `City`, `RouteNumber`,
   `ActorLists`, `MultiplayerActorLists`, `CutsceneActorLists`.
3. `multiplayer.bin` has `MultiplayerRace.powerupActorListOverride`; it is
   **null in all 439 races**, so the route's `MultiplayerActorLists` is the
   placement authority.
4. For **USA_LA_River** there are four `Route` records:

| route record | route number | used by MP races | MP placement list | placements |
| ---: | ---: | ---: | ---: | ---: |
| **1643385212** | **3** | **11** | **2512484467** (record 31) | **54** |
| 2942047131 | 6 | 0 | 1521262461 (record 17) | 53 |
| 2808833237 | 0 | 0 | — | — |
| 3514031538 | 6 | 0 | — | — |

All 11 multiplayer races that reference a River route reference
**1643385212**. The used `MultiplayerActorLists` array is:

```text
[2512484467 (54 PickupPosition), 1076417167 (20 StartPosition),
 2283576985, 34763157, 2535322374, 2983073881, 83811684]
```

`2512484467` is the only list in that array with `PickupPosition` actors.

The 11 races (record ids, from `multiplayer.bin`):

| race record | players | power-up mask | respawn | random |
| ---: | --- | --- | --- | --- |
| 576623001 | 4–20 | 255 = all 8 | Normal | Off |
| 978304146 | 4–20 | 255 | Normal | Off |
| 1194817800 | 4–10 | 255 | Normal | Off |
| 1904939042 | 2–10 | 255 | Normal | Off |
| 2631028840 | 2–10 | 255 | Normal | Off |
| 2654130278 | 2–10 | 255 | Normal | Off |
| 3128505724 | 2–20 | 255 | Normal | Off |
| 3820261331 | 4–20 | 255 | Normal | Off |
| 3880617764 | 2–10 | 255 | Normal | Off |
| 4092497482 | 4–20 | **229** = nitro, barge, bolt, shield, repair | Normal | Off |
| 4092541809 | 2–20 | 255 | Normal | Off |

No River race binds a `PickupProbabilityList`.

### 2.1 Why 558 positions exist but only 54 are raced

The other `PickupPosition` lists belong to single-player events, the unused
route 6 layout, or have no decoded owner; they are real shipped data but are
**not** the raced MP layout:

| actor list id | record | placements | owner |
| ---: | ---: | ---: | --- |
| 2512484467 | 31 | **54** | **MP route 3 (raced)** |
| 1521262461 | 17 | 53 | MP route 6 (0 MP races) |
| 3143921984 | 36 | 53 | SP route 3 `ActorLists`; event `T2E1` also references it |
| 3975895947 | 48 | 53 | SP route 6 `ActorLists`; no decoded event reference |
| 2073912470 | 23 | 65 | SP event `T1E5` (route 3); not in the route's actor list |
| 2307428356 | 27 | 71 | SP event `T4E3` (route 6); not in the route's actor list |
| 526481896 | 10 | 33 | SP event `T3E6` (route 6); not in the route's actor list |
| 413892124 | 6 | 11 | actor names `TUT_Perk01..11`; no decoded route/event reference |
| 489844649 | 8 | 61 | actor names `GroupNN_Perk`; no decoded route/event reference |
| 3798648126 | 43 | 45 | actor names `NewPickupPosition`; no decoded route/event reference |
| 3863297647 | 47 | 59 | actor names `NewPickupPosition`; no decoded route/event reference |

The names of the four unreferenced lists are actor-name evidence, not a proven
mode mapping. They are recorded as shipped actor data, not claimed as a race
layout.

Only the first row is claimed as the raced placement.

---

## 3. Recovered placements (54)

The full machine-readable list is `placements.json.placements[]`. Compact table:

| # | uid | serialized | type | x | y | z | loop-01 dist | shuffle group |
| ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | --- |
| 0 | 369101506 | Shunt | Shunt | 662.21 | 0.44 | 2304.73 | 1163.62 | 771609565:3 |
| 1 | 3344079945 | Repair | Repair | 423.82 | 0.58 | 1538.66 | 380.98 | — |
| 2 | 375899284 | Barge | Barge | 514.38 | 0.10 | 1897.82 | 732.80 | — |
| 3 | 2962549639 | Repair | Repair | 785.59 | 0.76 | 2359.95 | 1268.12 | — |
| 4 | 1231347851 | Nos | Nitrous | 319.25 | 3.35 | 1188.22 | 145.19 | 2979812146:6 |
| 5 | 1466821156 | Repair | Repair | 137.59 | 3.86 | 1199.89 | **1.80** | — |
| 6 | 841693256 | Nos | Nitrous | 523.49 | 0.10 | 1895.62 | 735.05 | — |
| 7 | 3372072116 | Bolt | Blindfire | 280.57 | 0.56 | 1281.13 | 105.23 | — |
| 8 | 2719325835 | Bolt | Blindfire | 141.16 | 8.61 | 856.40 | 308.51 | — |
| 9 | 3363902376 | Shunt | Shunt | 442.34 | −0.32 | 1527.22 | 384.61 | 2885791346:1 |
| 10 | 559293766 | Shield | Shield | 544.48 | 0.29 | 1879.28 | 730.86 | — |
| 11 | 3555843894 | Bolt | Blindfire | 502.12 | 1.27 | 1902.98 | 731.92 | — |
| 12 | 2305102812 | Barge | Barge | −91.99 | 6.69 | 937.53 | 305.80 | 771609565:8 |
| 13 | 1010165486 | Shunt | Shunt | −75.72 | 6.69 | 937.53 | 295.11 | 771609565:8 |
| 14 | 3744303828 | Shield | Shield | 433.13 | −0.32 | 1532.98 | 382.71 | — |
| 15 | 160671442 | Shock | Shock | 415.23 | 2.24 | 1544.29 | 379.96 | 2885791346:1 |
| 16 | 2757158465 | Shield | Shield | 147.11 | 3.87 | 1192.90 | **1.26** | — |
| 17 | 3059778688 | Nos | Nitrous | 537.64 | 5.78 | 2282.97 | 1097.22 | — |
| 18 | 2068063683 | Shield | Shield | 554.68 | 5.57 | 2284.20 | 1104.05 | — |
| 19 | 1683338348 | Mine | Bomb | 410.50 | −0.42 | 1460.01 | 314.44 | 771609565:5 |
| 20 | 2249188236 | Shield | Shield | 518.20 | −0.19 | 1690.81 | 558.87 | 443857132:4 |
| 21 | 4235782314 | Barge | Barge | 667.28 | 0.39 | 2297.18 | 1158.87 | 771609565:3 |
| 22 | 3370233259 | Shunt | Shunt | 696.61 | 3.62 | 2556.18 | 1408.63 | 771609565:2 |
| 23 | 429521655 | Bolt | Blindfire | 135.32 | 8.57 | 872.53 | 292.02 | — |
| 24 | 1486324850 | Shock | Shock | 289.58 | −0.69 | 1191.15 | 116.49 | 2979812146:6 |
| 25 | 1332285785 | Shunt | Shunt | 130.43 | 3.72 | 1205.14 | 7.06 | — |
| 26 | 3753799837 | Bolt | Blindfire | 138.21 | 8.61 | 864.55 | 300.16 | — |
| 27 | 3044386948 | Shunt | Shunt | 310.67 | 0.23 | 1189.07 | 136.84 | 2151342480:7 |
| 28 | 3794695457 | Shunt | Shunt | 577.61 | 3.90 | 1945.41 | 804.72 | — |
| 29 | 3882439897 | Bolt | Blindfire | 279.13 | −0.68 | 1192.18 | 106.52 | 2151342480:7 |
| 30 | 1553286725 | Nos | Nitrous | 555.48 | 0.15 | 1949.99 | 798.07 | — |
| 31 | 971724886 | Shield | Shield | 268.63 | −0.68 | 1193.22 | 96.62 | 2979812146:6 |
| 32 | 3927098854 | Mine | Bomb | −83.77 | 6.68 | 937.53 | 300.33 | 771609565:8 |
| 33 | 4153689464 | Barge | Barge | 543.90 | 4.48 | 1685.17 | 570.40 | 443857132:4 |
| 34 | 1698119854 | Nos | Nitrous | 182.71 | 3.72 | 1247.15 | **2.72** | — |
| 35 | 2666471777 | Repair | Repair | 300.88 | −0.68 | 1190.04 | 127.36 | — |
| 36 | 2466386756 | Repair | Repair | 546.42 | 5.28 | 2283.60 | 1100.71 | — |
| 37 | 2543429057 | Shunt | Shunt | 492.07 | 4.16 | 1905.49 | 729.83 | — |
| 38 | 4260954909 | Bolt | Blindfire | 672.11 | 0.50 | 2289.97 | 1154.39 | 771609565:3 |
| 39 | 1404769140 | Shock | Shock | 617.55 | 4.04 | 2082.67 | 944.39 | — |
| 40 | 3152773273 | Bolt | Blindfire | 694.64 | 3.22 | 2532.89 | 1386.26 | 771609565:2 |
| 41 | 3975545446 | Barge | Barge | 426.29 | 3.62 | 1445.07 | 316.39 | 771609565:5 |
| 42 | 3094469363 | Shunt | Shunt | 418.64 | 1.12 | 1451.64 | 314.82 | 771609565:5 |
| 43 | 4148493057 | Repair | Repair | 530.82 | 0.83 | 1685.42 | 562.36 | — |
| 44 | 56995134 | Bolt | Blindfire | 153.40 | 3.83 | 1188.28 | **6.54** | — |
| 45 | 1232786629 | Barge | Barge | 562.56 | 5.95 | 2285.50 | 1107.96 | — |
| 46 | 3115028907 | Bolt | Blindfire | 569.28 | 1.37 | 1947.59 | 802.54 | — |
| 47 | 1274494203 | Mine | Bomb | 676.91 | 0.38 | 2282.83 | 1149.99 | 771609565:3 |
| 48 | 2508688809 | Bolt | Blindfire | 402.02 | −0.42 | 1465.46 | 312.18 | 771609565:5 |
| 49 | 3414742116 | Nos | Nitrous | 547.48 | 0.07 | 1952.44 | 796.52 | — |
| 50 | 1678467320 | Nos | Nitrous | 509.54 | 0.12 | 1691.28 | 554.06 | 443857132:4 |
| 51 | 1144843188 | Bolt | Blindfire | −100.45 | 6.70 | 937.53 | 311.55 | 771609565:8 |
| 52 | 1875353604 | Mine | Bomb | 695.68 | 3.15 | 2545.12 | 1398.01 | 771609565:2 |
| 53 | 2841091803 | Barge | Barge | 693.68 | 3.71 | 2521.52 | 1375.35 | 771609565:2 |

`serialized` is the actor's `Name` string (`Nos`, `Bolt`, `Mine` are the retail
short names). `type` is the `PickupType` enum label. The JSON additionally
records the full basis (`ax`, `ay`, `az`), the world matrix translation, the
collision ground/normal/height and both course projections.

### 3.1 Type ids (data ids, not invented enum integers)

| label | `PickupType` ref id | MP short name |
| --- | ---: | --- |
| Nitrous | 2377082647 | Nitrous / `Nos` |
| Shock | 973327125 | Shock |
| Shunt | 736887763 | Shunt |
| Blindfire | 1291339931 | `Bolt` |
| Barge | 1621319152 | Barge |
| Bomb | 733160612 | `Mine` |
| Repair | 162617178 | Repair |
| Shield | 1866809209 | Shield |

Fan (3748041782), Stopwatch (3476635578) and SuperShield (3093073274) are
defined but have **no placement** on this route. Their integer
`E_PICKUP_TYPE` values are not serialized and are not invented here.

---

## 4. Rows, shuffle groups and respawn

### 4.1 Serialized fields

Every one of the 54 actors has:

| field | value (all 54) |
| --- | --- |
| `PickupActiveLevel` | 1 |
| `RotateGraphic` | false |
| `ActivationTimer` | 0.0 |
| `ActivationLap` | 0 |
| `RespawnTimerOverride` | 0.0 |
| `ConstantShuffle` | false |
| `ShuffleTypes` | bits 0, no labels |
| `ExcludedPickupTypes` | empty |

So no per-placement respawn or activation override is serialized.

### 4.2 Row groups

`RowType` (handle to `PickupPositionRow` in `pickups.bin`) plus `RowId` (u32)
form the engine's shuffle key:

- `C_PickupPositionManager::GetMapId(pickupId, recordId)` packs
  `(pickupId << 32) | recordId` (`PickupPositionManager.cpp:24-29`).
- `AddPickupActor(GetCreationData()->m_uRowId, row)` is called with the actor's
  `RowId` and the `RowType` record (`PickupPositionActor.cpp:1019-1023`).
- `PickupPositionInfo::AssignPickup` draws from the allowed mask **without
  replacement** and re-initialises when the list is exhausted
  (`PickupPositionManager.cpp:74-92`).

Therefore a **respawn/shuffle group is `(RowType.refId, RowId)`**. There are
8 groups with 26 placements; the other 28 placements have no row and are
fixed-type singletons. Every group contains exactly one of each allowed type
(after the PWR1 aliases):

| group | allowed types | placements | serialized types |
| --- | --- | ---: | --- |
| 771609565:2 | Barge, Bolt, Mine, Shunt | 4 | Shunt, Blindfire, Bomb, Barge |
| 771609565:3 | Barge, Bolt, Mine, Shunt | 4 | Shunt, Barge, Blindfire, Bomb |
| 771609565:5 | Barge, Bolt, Mine, Shunt | 4 | Bomb, Barge, Shunt, Blindfire |
| 771609565:8 | Barge, Bolt, Mine, Shunt | 4 | Barge, Shunt, Bomb, Blindfire |
| 2979812146:6 | Nitrous, Shield, Shock | 3 | Nitrous, Shock, Shield |
| 2885791346:1 | Shock, Shunt | 2 | Shunt, Shock |
| 443857132:4 | Barge, Nitrous, Shield | 3 | Shield, Barge, Nitrous |
| 2151342480:7 | Bolt, Shunt | 2 | Shunt, Blindfire |

The four `771609565` rows are four pickups in a line at one location (the four
slots are 7.8–9.1 m apart), which is why each row holds exactly one of the four
allowed types.

### 4.3 Respawn timing (what is and is not in the file)

- `RespawnTimerOverride` is **0.0 for all 54**, so the override path is unused.
- `MpPowerupRespawn.Normal` has **no serialized seconds** (PWR1 powerups.md §6);
  `Long = 5.0 s`, `VeryLong = 20.0 s` come from `MultiplayerConfig`.
- `PickupDeactivateTimer = 0.6 s`, `PickupRadius = 2.0 m` (PWR1 §4.1).
- `PickupParametersStoredOnline`: `RecoveryTime = 6.0`,
  `RecoveryTimeSpeedMod = 0.1` (PWR1 §5.1).
- All 11 River races use `Normal` respawn and `randompowerups = Off`, so the
  fixed type of a row persists unless the host applies a documented random
  rule. The exact `Normal` seconds remain **provisional** in M2.

---

## 5. Projection to the measured courses

The committed P48 path (310.3952 m, 1,245 samples) and the P61 `loop-01`
(222.0402 m, 902 samples, closed) are **not** the retail route. Their nearest
distances are therefore reported, not used to move a placement.

| measure | 310.395 m course | loop-01 |
| --- | ---: | ---: |
| nearest placement | 72.80 m | **1.26 m** |
| nearest uid | 1332285785 (Shunt) | 2757158465 (Shield) |
| median distance | 569.11 m | 554.06 m |
| within 2.0 m (proximity threshold) | **0** | **2** |
| within 5 m | 0 | 3 |
| within 10 m | 0 | 5 |
| within 25 m | 0 | 5 |

Placements within 10 m of loop-01:

| uid | type | position | loop dist | loop arc |
| ---: | --- | --- | ---: | ---: |
| 2757158465 | Shield | (147.11, 1192.90) | 1.26 | 44.19 |
| 1466821156 | Repair | (137.59, 1199.89) | 1.80 | 175.33 |
| 1698119854 | Nitrous | (182.71, 1247.15) | 2.72 | 109.62 |
| 56995134 | Blindfire | (153.40, 1188.28) | 6.54 | 44.52 |
| 1332285785 | Shunt | (130.43, 1205.14) | 7.06 | 175.83 |

### 5.1 The start grid proves loop-01 is the retail start area

The same raced route references actor list **1076417167** with **20
`StartPosition`** actors. Their world positions span:

```text
x 85.961 … 183.136
z 1143.217 … 1265.262
loop-01 distance 0.285 … 34.502 m
```

`StartPosition0` is at `(85.961, 3.942, 1143.217)`. The grid sits on/around
loop-01, so loop-01 is a genuine part of the retail start complex. The 310 m
course starts at `(-88, 1050)`, which is **not** one of these start positions
(it is the P48 ground-probe spawn). This is the reason the retail pickup set
does not follow the 310 m course.

### 5.2 Collision check

Using the committed collision oracle on `Level.levelphysics`:

- 54/54 placements have an up-facing triangle under their XZ;
- height above ground is `0.692–1.564 m` (median ~0.70 m);
- 52/54 have `normal.y > 0.94` (the P48 ≤20° drivable rule);
- 2 placements (uids 1231347851 and 3044386948) have `normal.y = 0.93939`
  (20.06°), just outside the rule, but still on ground at ~0.70 m. They are
  recorded as `drivableSurface:false`, not as "unreachable".

No placement is over a void.

### 5.3 Collection trigger is a box, not the 2.0 m radius

`PickupPositionActor::CreateTrigger` (`PickupPositionActor.cpp:478-520`) builds
a `Gravity::C_BoxDesc` at the actor's `WorldMatrix`:

| case | half extents (m) |
| --- | --- |
| static (`RotateGraphic false`) | **1.25 × 1.25 × 0.25** |
| rotating (`RotateGraphic true`) | 1.25 × 1.25 × 1.25 |
| Fan | 2.5 × 2.5 × 0.5 |

All 54 recovered placements are static, so the collection volume is an oriented
**2.5 × 2.5 × 0.5 m box**. `PickupRadius = 2.0` initialises `mCollisionRadius`
(`PickupPositionActor.cpp:215`) and is used by AI/debug paths, but the collection
trigger is the box. The 2.0 m column in §5 is therefore a labelled proximity
threshold, not the trigger, and M2 must not substitute a 2.0 m sphere.

---

## 6. Provisional vs recovered

The provisional plan exists in the parallel PWR2 slice
`probes/e1-drive/web/powerups.js` (untracked at recovery time; SHA-256
`c270553b3beaa589462f3dcb02b4bdabab0e617b860c505675e370a40f944a90`):

- arcs **`[40, 90, 140, 190, 240, 280]`** on the measured P48 310.395 m path;
- types **`[Bomb, Shield, Repair, Bomb, Shield, Repair]`**;
- `measuredArcPosition()` snaps each arc to the nearest 0.25 m sample; no
  interpolation, no invented point.

The comparison below uses the same committed arc table and the same
nearest-sample rule:

| comparison | value |
| --- | ---: |
| provisional slots | 6 |
| recovered placements | 54 |
| provisional slots with a recovered placement ≤ 2.0 m | **0 / 6** |
| recovered placements with a provisional slot ≤ 2.0 m | **0 / 54** |
| nearest provisional slot to a recovered placement | **73.04 m** |
| recovered placements on the 310 m arc ≤ 2.0 m | 0 |
| recovered placements on loop-01 ≤ 2.0 m | 2 |
| recovered placements off both measured arcs | 52 / 54 |
| provisional type set | Bomb, Shield, Repair |
| recovered type set | all 8 MP classes (5 not in the provisional set) |

| arc | sample | x | z | type | nearest recovered |
| ---: | ---: | ---: | ---: | --- | ---: |
| 39.943 | 160 | −60.269 | 1078.748 | Bomb | 142.06 m |
| 90.122 | 361 | −25.431 | 1114.862 | Shield | 180.12 m |
| 140.037 | 561 | 8.971 | 1151.000 | Repair | 132.98 m |
| 190.094 | 762 | 37.331 | 1192.231 | Bomb | 93.99 m |
| 239.999 | 962 | 63.600 | 1234.600 | Shield | 73.04 m |
| 279.938 | 1122 | 85.750 | 1267.750 | Repair | 76.92 m |

The provisional plan is correctly labelled `provisional-measured-arc`; it is
not retail data and remains valid **as a project choice** for the 310 m
collision-only course. The recovery does not say it is "54 positions wrong":
the real set belongs to the retail route (length not decoded), while the
provisional plan describes only the measured sub-course. The honest conclusion is:

- **310 m course:** no shipped pickup is on it (nearest 72.80 m). If this course
  is used, its six provisional slots must stay labelled `provisional`; there is
  no recovered placement to substitute.
- **loop-01:** the retail route crosses it; 2 shipped pickups are within the
  2.0 m proximity threshold and 5 within 10 m. Those two (uids 2757158465 Shield and
  1466821156 Repair) can replace provisional slots if the mode uses the retail
  start area.
- **Counts** (6 provisional vs 54 recovered) are not comparable without the
  retail route length, which is not decoded.

Duplicates and spacing:

- 0 exact XZ duplicates at 1 mm; 0 duplicate uids.
- minimum nearest-neighbour distance **7.809 m** (so rows of four are distinct
  slots, not coincident copies).

### 6.1 What "unreachable" means here

- Against the measured sub-courses: **52/54** are farther than the 2.0 m
  proximity threshold from both centrelines. This is a statement about the measured
  sub-courses, not about the retail route.
- Against the collision mesh: **0** placements have no ground; **0** are
  considered unreachable by the engine's road test; 2 are marginally outside the
  conservative 20° heuristic.
- No position is moved or snapped to make it "reachable".

---

## 7. Missing data and what remains provisional

| item | status | reason |
| --- | --- | --- |
| retail route arc length / ordering | **not-decoded** | the `.aid` v6 route spline is not parsed; only `Route` and its actor lists are decoded |
| `Normal` respawn seconds | **not-serialized** | PWR1 §6; override is 0.0 and `Normal` has no seconds |
| runtime RNG order for row assignment | **runtime-only** | `AssignPickup` uses the race RNG; the set is serialized but the order is not |
| probability normalisation / filtering | **runtime-only** | no River race binds a probability list; the disabled-type re-draw is code (`PickupPositionActor.cpp:1029-1035`) |
| exact `E_PICKUP_TYPE` integers | **not-serialized** | only labels and ref ids are stored (PWR1 §10) |
| `PickupActiveLevel` semantics | **raw-only** | value 1 recorded; meaning not verified |
| inventory capacity | **runtime-only** | `NetPlayerVehicle.pickupSlots` 16-bit mask; rules are code |
| `RowId` uniqueness beyond this route | **not-claimed** | the 8 groups are internally consistent; no global claim |

Everything above stays provisional or typed in the manifest; nothing was filled
with a guess.

---

## 8. Integration contract for M2 / PWR2

### 8.1 Placement list

- Load `_work/powerups/placements.json` and use
  `authority.route.pickupActorListId = 2512484467` plus
  `placements[]` (54 entries). This is the raced River MP layout.
- Each entry is a static spawn slot: `uid` (stable id), `position` (world
  metres), `basis.az` (facing), `serializedType.refId/name`, `row`,
  `collision`, `courseProjection`.
- Spawn **once per race** with `pickup-spawned` for every slot whose type is
  enabled by the race `powerups` mask. Do not re-generate positions and do not
  add slots on the 310 m course and call them retail.
- The race `MpPickup` mask is the only serialized enable/disable input. Race
  4092497482 enables **229** (nitro, barge, bolt, shield, repair; no
  shock/mine/shunt). The retail code also consults `mPickupProbabilities` when a
  type is banned, but no River race binds a list
  (`PickupPositionActor.cpp:1029-1035`). For M2, filter at spawn and label any
  replacement `provisional`; do not present an invented re-draw as retail.
- For the 310 m course, keep the PWR2 provisional set (arcs
  `[40,90,140,190,240,280]`, types `[Bomb,Shield,Repair]×2`) explicitly labelled
  `placement:'provisional-measured-arc'`. For loop-01, the two shipped slots
  within the 2.0 m proximity threshold (uids 2757158465 Shield at 1.26 m,
  1466821156 Repair at 1.80 m) are the only recovered matches; the rest of the
  loop remains provisional if it is used as a closed course. The 1.26 m slot is
  just outside the static trigger box half-width (1.25 m) at the centreline, so
  validate collection with the **box**, not the 2.0 m threshold.

### 8.2 Type ids

- Use the 32-bit `PickupType.refId` (table in §3.1) as the wire id. Do not
  invent an integer enum value.
- The eight enabled classes are Nitrous, Shock, Shunt, Blindfire, Barge, Bomb,
  Repair, Shield. `Bolt` is the `PickupTypeList` name for Blindfire and `Mine`
  for Bomb (inferred, PWR1 §3.2). Canonicalise both spellings before comparing
  a slot to a row mask.
- A row slot's type is **not free**: it is one of the row's allowed types, and
  the group assigns each allowed type once. The serialized `PickupType` is the
  editor's assignment; the runtime row assignment may reorder it.

### 8.3 Respawn group

- Group key `row.shuffleGroup = "<rowRefId>:<rowId>"` (or a singleton for
  `row = null`).
- Maintain one available-type list per group. On spawn/respawn, pop one type
  without replacement; when empty, re-initialise from the allowed mask
  (`PickupPositionManager.cpp:74-92`). Never assign the same type twice inside
  one group cycle.
- `RespawnTimerOverride = 0.0`; use the race mode respawn. `Normal` seconds are
  still unknown; Long 5.0 / VeryLong 20.0 from PWR1. Add the 0.6 s deactivate
  timer before the respawn timer.
- Fixed-type slots keep their serialized type unless `randompowerups = On`.
  All 11 River races are `Off`.

### 8.4 Host authority

- **Host-authoritative** (M1/M2 rule). The host owns the placement table, group
  available lists, RNG, active/deactivated state, respawn timers and collection
  validation.
- Clients send intents (`{pickupUid, playerId, tick}`); they never roll a type,
  respawn a pickup or judge a collection locally.
- Emit sequenced events: `pickup-spawned`, `pickup`, `pickup-rejected` (local),
  `pickup-respawn`. Include `uid`, `typeRefId`, `group`, `position`, `at`,
  `authority`, `seq`.
- Late join: send the full slot state (active/deactivated, typeRefId,
  respawnAt) plus each group's remaining available list, then continue from the
  next `seq`.

### 8.5 Validating a collected item

The host validates, in this order:

1. `pickupUid` exists in the race's active placement set and is not
   deactivated/collected.
2. The type is enabled by the race `powerups` mask and is the slot's current
   type (row assignment included).
3. The car intersects the pickup trigger. `CreateTrigger` builds a **Gravity
   box**, not a sphere (`PickupPositionActor.cpp:478-520`):
   - static (`RotateGraphic false`): half extents **1.25 × 1.25 × 0.25 m**;
   - rotating (`RotateGraphic true`): **1.25 × 1.25 × 1.25 m**;
   - Fan: 2.5 × 2.5 × 0.5 m (no Fan placements on this route).
   The box is centred at `WorldMatrix.AW` and oriented by `ax/ay/az`
   (`PickupPositionActor.h:121-124`). All 54 recovered placements are
   `RotateGraphic false`, so use the **1.25/1.25/0.25 box**. `PickupRadius = 2.0`
   is `mCollisionRadius` initialisation / AI / debug, **not** the collection
   volume; do not substitute a 2.0 m sphere or enlarge the box to make a slot
   collectable.
4. The player exists, is racing, and has inventory capacity. Capacity is
   runtime-only (PWR1 `pickupSlots` 16-bit mask); one active item in M2.
5. The player has not already collected the same slot in the same tick.
6. On success: mark the slot deactivated for 0.6 s, schedule the respawn with
   the mode timer, emit `pickup` with the canonical type id and group, and only
   then grant the item.

A collection that fails any check emits `pickup-rejected` locally (not
replicated) with the failing check name.

### 8.6 Determinism and replay

- Sort slots by `index`; sort groups by `groupId`; the JSON is canonical
  (sorted keys, fixed point) and re-verifies byte-stable.
- The host RNG seed flow is not serialized. For replay, record the host's
  chosen type per slot at spawn/respawn in the event stream, not just the seed.
- The verifier recomputes every position, type, row, group, projection and
  collision value, so a hand-edited manifest fails.

---

## 9. Evidence and reproduce

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/powerups/tools/extract_pickup_placement.py
& $py probes/powerups/tools/verify_pickup_placement.py
```

| artifact | content |
| --- | --- |
| `_work/powerups/placements.json` | 54 placements, provenance, projection, diff; file `6458e37a…11bfc05`, canonical `e5e2e449…b2d3607` |
| `_work/powerups/placements.verify.json` | **1415/1415 PASS**, independent reader + oracle; file `a3b87daa…ae17091` |
| `_work/logs/powerups/placement-build-run1.log` | first build |
| `_work/logs/powerups/placement-build-run2.log`, `run3.log` | repeat builds; identical file hash |
| `_work/logs/powerups/placement-verify.log` | verifier output |
| `probes/powerups/tools/extract_pickup_placement.py` | extractor (`424c1bb8…d96b3e0`) |
| `probes/powerups/tools/verify_pickup_placement.py` | independent verifier (`6a35ef36…dc255a`) |

Determinism: two consecutive builds produced the identical
`placements.json` SHA-256 `6458e37aebb84a0df52f9601ce4bc719cfd4624f81c37150c4a4e4f9211bfc05`.

The verifier:

- re-reads the five PAK entries and re-checks their SHA-256 and extents;
- re-derives the 8 type ids/names and all 64 row masks from `pickups.bin`;
- re-reads the route 1643385212, its city name and `MultiplayerActorLists`;
- re-decodes all 54 `PickupPosition` elements (position, matrix, type, row,
  overrides) with a direct-offset reader that does **not** import `xt_decode`;
- re-decodes the 20 start positions and their loop-01 distances;
- re-reads the 11 `MultiplayerRace` rows and their masks;
- recomputes every 310 m / loop-01 projection from the committed artifacts;
- recomputes every collision ground/normal with the committed oracle;
- re-checks grouping, duplicates, counts and the provisional plan diff;
- recomputes the canonical hash.

---

## 10. Limits

- **Placement data only.** No renderer, GPU, vehicle, race-loop or full-game
  claim.
- **No retail arc.** The `.aid` route spline is not decoded, so no retail
  distance-along-route is claimed. Course projections are to the measured
  310 m and loop-01 artifacts only.
- **The 310 m course is not the retail route.** It starts at the P48
  ground-probe spawn, not at the retail 20-slot grid. Its pickups are
  provisional by necessity.
- **loop-01 is only a sub-region.** It overlaps the retail start area, but it is
  not the full retail lap; 2 shipped pickups are within its 2.0 m proximity
  threshold.
- **Rows are a data grouping.** The group key and no-replacement rule are
  proven from the engine source; the RNG order is not.
- **No probability normalisation.** No River race binds a probability list;
  `MpPickup` bits only enable/disable classes.
- **No invented integers, positions or respawn values.** Unknowns are listed in
  §7 and in `placements.json.missing`.
