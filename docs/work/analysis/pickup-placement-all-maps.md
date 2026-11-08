# Pickup placement on `usa_amboy` and `spa_barcelona_gracia` — final runtime set

**Date:** 8 November 2026
**Owner:** PWR6
**Scope:** `probes/powerups/**`, `_work/powerups/**`, `_work/logs/powerups/**`
and this document only. No change to `probes/e1-drive/**`, `probes/map-slice/**`,
`probes/race-rules/**`, `probes/net-mvp/**`, `probes/asset-reader/**`, `tools/`,
`upstream/` or `game-data/`. Game data is read-only. The e1-drive files named in
§8 are an **integration contract**, not an edit.

**Result:** every retail `PickupPosition` / shuffle-group record for the raced
Amboy and Gracia routes is recovered with absolute byte offsets, projected onto
the measured e1-drive paths, checked against the committed collision mesh and
draw buffers, and published as an ordered host runtime set with yaw, shuffle
groups, typed exclusions/flags and River-identical respawn/reset semantics.
**This is placement data, not a renderer, vehicle, race-loop or full-game
claim.**

---

## 0. Result summary

| measure | `usa_amboy` | `spa_barcelona_gracia` |
| --- | ---: | ---: |
| raced routes recovered | **2** | **3** |
| all placements (every variant) | **135** | **144** |
| primary route | **633252245** (`RouteNumber 3`, 11 racing races) | **46220414** (`RouteNumber 2`, 17 racing races) |
| primary placements | **83** | **59** |
| primary spawnable (default set) | **82** | **59** |
| primary excluded (hard) | **1** | **0** |
| primary flagged | **80** | **57** |
| MP types on the primary route | **all 8** | **all 8** |
| on measured path ≤ 2.0 m | **2** | **1** |
| on measured path ≤ 6.0 m (declared band) | **2** | **2** |
| at static-box centreline ≤ 1.25 m | **1** | **1** |
| collectable with car offset (≤ 6.0 m) | **2** | **2** |
| no collision ground under the slot | **0** | **0** |
| inside a collision/visible structure | **0** | **0** |
| shuffle groups (row / fixed) | **10 / 58** | **8 / 35** |
| min nearest-neighbour spacing | **5.979 m** | **6.881 m** |
| duplicate uids / XZ duplicates | **0 / 0** | **0 / 0** |
| verifier | **8,268 / 8,268 PASS** | **8,852 / 8,852 PASS** |
| runtime file SHA-256 | `66f6b213…c5292f` | `4245749b…3da130` |
| canonical SHA-256 | `26292894…85b403` | `864c9919…c2be5a` |

The decisive point: the **retail placement set covers all eight MP types**, but
the **measured e1-drive sub-course touches only two of them per map** (Amboy
Shunt + Blindfire; Gracia Blindfire + Bomb). Everything else is real shipped
data that is off the measured centreline. No slot was moved, snapped or
invented to increase coverage; §8 says how the host must report this.

Artifacts: `_work/powerups/runtime-amboy.json`,
`runtime-gracia.json`, their `.verify.json`, and the condensed
`pwr6-summary.json`. Details below.

---

## 1. Sources and hashes

All payloads are entries inside `game-data/Blur/cache/gamedata.pak` (V2, codec 2
zlib, secure FAT). Nothing was written back.

| source | path | PAK offset | stored / logical | SHA-256 (decoded) |
| --- | --- | ---: | ---: | --- |
| Amboy actor placement | `\gamedata\levels\usa_amboy\actorpack.xt` | 9,508,864 | 149,405 / 360,316 | `b6700f8bb1009c33306e36bcdd5f58cce076e609f8038af63933615653b5388a` |
| Gracia actor placement | `\gamedata\levels\spa_barcelona_gracia\actorpack.xt` | 3,627,008 | 212,031 / 464,720 | `cb6b7dfbf2c73d6af9e557f052863b34c14bdf7a0edc98ccfedc5687c8e45880` |
| pickup definitions | `\gamedata\xt\pickups.bin` | 22,464,512 | 50,403 / 132,056 | `f8e9ba3d0749dcb2b7b775c25fc1e0ec5c337b4835efa947f0cfe329a4965ed7` |
| multiplayer races | `\gamedata\xt\multiplayer.bin` | 22,425,600 | 38,176 / 103,912 | `0dcf60bc5306069c2dfa6a4d89701a27f0e789235a1bcf5f9aa2167d9ef6ab48` |
| routes | `\gamedata\xt\amax.bin` | 21,028,864 | 308,744 / 1,078,940 | `a833487bd66552ecf61b1f13790ee228b18ca8f4d76c524dcd94e44c63d1e3c7` |
| single-player events | `\gamedata\xt\singleplayer.bin` | 22,550,528 | 28,592 / 120,736 | `14af6d07a0fe6eb84253c794e1473196098eeeed215dd7988a8c387d86d65f19` |

Measured inputs and constants:

| input | path | SHA-256 / value |
| --- | --- | --- |
| Amboy measured layout | `_work/e1-drive/amboy/layout.json` | `b89ae430dff3aaea3511abc6244687430ec66433055bfbcb4eb63b3a1d364f8d` |
| Amboy layout body | same | `sha256:bccb6bed…b08f644`, 2,060.595408 m, 8,673 samples |
| Gracia measured layout | `_work/e1-drive/gracia/layout.json` | `e2f9a1114c283ca84838db96286c5482e9b7b6c4fec779b34bbb4a579991a3b8` |
| Gracia layout body | same | `sha256:1aa622fd…33faf30`, 624.913781 m, 2,571 samples |
| Amboy physics | `game-data/Blur/levels/usa_amboy/Level.levelphysics` | `18c73e1cca6f13c5bbd4937454f25ec3163a67553fea6842a7797400af2175f2` |
| Gracia physics | `game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics` | `acfb58a20ff7adced0b2424dc39474509e6b4c4c805729fd9463bdd310a173c0` |
| Amboy draw positions | `_work/map-slice/amboy/draws.positions.f32.bin` | `5d85409b9b838227907eca2d53b34a4d7f37cb6d67158dc596b70bc24dbb2755` |
| Amboy draw indices | `_work/map-slice/amboy/draws.indices.u32.bin` | `f4d77438b7ce99a809280e71b6cd356dedef784f613faf0147bd447c50b41e66` |
| Gracia draw positions | `_work/map-slice/gracia/draws.positions.f32.bin` | `f6edf5720a7399665e83018fee83de97a21b9f3cdc7fde7fcf310caca971ba11` |
| Gracia draw indices | `_work/map-slice/gracia/draws.indices.u32.bin` | `dea21ba6dcb38b88ac0d303f4346c12f781d7998e2c0e4e525f033c6964e789f` |
| PWR1 manifest | `_work/powerups/powerups.json` | file `6ee5a3e6…bc73d7`, content `543b059a…c654df` |
| `PickupRadius` | PWR1 `pickupSystem.parameters` | 2.0 m |
| `PickupDeactivateTimer` | same | 0.6000000238418579 s (f32) |
| `powerupRespawnToggleLong` | PWR1 `modes.config` | 5.0 s |
| `powerupRespawnToggleVeryLong` | same | 20.0 s |

Draw triangles used: **348,948 non-degenerate** (Amboy, all of the committed
buffer) and **550,602 of 550,632** (Gracia; 30 degenerate triangles are skipped
by the normal test). They are diagnostic geometry — materials, alpha and
textures are not applied.

---

## 2. Method

### 2.1 Authority chain

```text
multiplayer.bin  MultiplayerRace.route / powerups / poweruprespawn / randompowerups
  -> amax.bin    Route.City / RouteNumber / MultiplayerActorLists
  -> actorpack.xt LevelActorList
  -> actorpack.xt PickupPosition  (WorldMatrix + PickupType + RowType + RowId)
```

`MultiplayerRace.powerupActorListOverride` is null in all races (PWR3 §2), so
the route's `MultiplayerActorLists` is the placement authority. A raced route
must resolve to exactly one `LevelActorList` with `PickupPosition` elements; the
builder refuses to merge several silently. The primary route uses the documented
PWR5 rule: most racing races, then most total races, then lowest route record
id. Every variant is kept in `authority.variants[]`.

### 2.2 Byte offsets (per slot)

Each `PickupPosition` is a 108-byte struct element. `provenance` records:

- the PAK path + decoded SHA-256;
- the record-table row offset (`21220` Amboy / `20128` Gracia, 16-byte rows);
- the record data offset (`29488` / `210888`) and payload/string byte counts;
- the component-relative index, component offset and element stride (108 B);
- the **absolute element offset** (`29844–38700` Amboy, `211148–217412` Gracia);
- the absolute offset of every serialized field and of `ax/ay/az/aw`.

Field offsets inside the element are schema-derived, not guessed:

| field | offset | field | offset |
| --- | ---: | --- | ---: |
| `SerialisableUid` | 0 | `ExcludedPickupTypes` (array desc) | 64 |
| `Name` (sz8 index) | 4 | `PickupActiveLevel` | 72 |
| `IsCommented` | 8 | `RotateGraphic` | 76 |
| `WorldMatrix` | 12 | `ActivationTimer` | 80 |
| `WorldMatrix.ax.vx` | 12 | `ActivationLap` | 84 |
| `WorldMatrix.az.vx` | 36 | `RespawnTimerOverride` | 88 |
| `WorldMatrix.aw.vx` | 48 | `ConstantShuffle` | 92 |
| `PickupType` (handle) | 60 | `ShuffleTypes` (flags) | 96 |
| | | `RowType` (handle) | 100 |
| | | `RowId` | 104 |

The verifier reads these offsets straight from the raw actorpack bytes (uid,
`aw` xyz, type-handle ref index, active level, rotate, respawn override, row
handle and `RowId`) and compares them to the documented values, so a
hand-edited offset fails.

### 2.3 Measured-path projection

`distance` is planar distance to the committed measured polyline; `arc` is the
nearest point's arc; `signedCross2d = tx*(z-qz) - tz*(x-qx)` is the 2D cross of
the travel tangent and the point offset (a sign convention, not a left/right
claim). `tangentYawRadians = atan2(tx, tz)`.

Classification thresholds are labelled project thresholds:

| class | rule |
| --- | --- |
| `on-path` | distance ≤ 2.0 m (`PickupRadius` proximity threshold) |
| `near-path` | 2.0 < distance ≤ 6.0 m (declared measurement band half-width) |
| `off-path` | distance > 6.0 m |
| `collectableAtCentreline` | distance ≤ 1.25 m (static trigger-box half-width) |
| `collectableWithOffset` | distance ≤ 6.0 m |

### 2.4 Collision / visible-structure test

For every slot position `(x, y, z)`:

- **ground below**: highest up-facing triangle (`normal.y > 0.1`) containing the
  XZ point at or below `y`;
- **first surface above**: lowest triangle containing the XZ point above `y`;
  `coverAboveMetres = y_above - y`;
- **steep wall clearance**: exact 3D point/triangle distance to the nearest
  triangle with `|normal.y| < 0.5` within 12 m (`null` = none within 12 m);
- the same three measures on the **draw** buffers (visible geometry).

Status rules (all thresholds are project thresholds, not retail trigger
volumes):

| typed reason | kind | rule |
| --- | --- | --- |
| `no-collision-ground-below` | hard exclusion | no up-facing triangle at/below the slot |
| `inside-collision-structure` | hard exclusion | wall distance < 0.05 m or cover < 0.05 m |
| `pickup-active-level-0` | hard exclusion | serialized `PickupActiveLevel != 1` |
| `non-drivable-surface` | flag | ground `normal.y ≤ 0.94` (≤ ~20°) |
| `elevated-above-detected-ground` | flag | height above ground > 2.0 m |
| `collision-clearance-low` | flag | 0.05 ≤ wall < 0.30 m |
| `collision-cover-low` | flag | 0.05 ≤ cover < 0.50 m |
| `visible-structure-overlap` | flag | visible wall distance < 0.05 m |
| `inside-visible-structure` | flag | visible cover < 0.05 m |
| `off-measured-path` | flag | distance > 6.0 m |

`spawn` = no reason; `flag` = spawnable with reasons; `exclude` = not spawnable.
`spawnSet` = every `spawn`/`flag` slot; `measuredCourseSet` = `spawn`/`flag`
slots with `on-path`/`near-path`, ordered by arc.

**Result: 0 slots are inside a collision or visible structure, 0 are over a
void, and the minimum wall clearance is 0.660 m (Amboy) / 0.611 m (Gracia).**
That minimum is a centre-point measure: the 2.5 m trigger box may still overlap a
guardrail by design. It is not enlarged or moved.

---

## 3. `usa_amboy`

### 3.1 Route authority

| route record | `RouteNumber` | racing / total races | MP pickup list | placements | spawnable / excluded |
| ---: | ---: | ---: | ---: | ---: | ---: |
| **633252245** (primary) | **3** | **11 / 11** | **12510741** | **83** | **82 / 1** |
| 2779865848 | 1 | 10 / 10 | 3608483955 | 52 | 52 / 0 |
| 2213074116 | 5 | 0 / 0 | — (unraced) | 0 | — |
| 2751477814 | 0 | 0 / 0 | — (unraced) | 0 | — |

City `USA_Amboy` (record 2115846046). The separate `usa_amboy_multiplayer`
destruction arena is not this level and ships no MP actor list.

### 3.2 Primary route 633252245 — type counts

| type | count | MP type |
| --- | ---: | --- |
| Blindfire (`Bolt`) | 18 | Blindfire |
| Nitrous (`Nos`) | 17 | Nitrous |
| Shunt | 14 | Shunt |
| Repair | 9 | Repair |
| Barge | 7 | Barge |
| Bomb (`Mine`) | 7 | Bomb |
| Shield | 6 | Shield |
| Shock | 5 | Shock |
| **total** | **83** | all 8 |

Alternate route 2779865848: Blindfire 10, Shunt 9, Barge 7, Bomb 7, Repair 6,
Shield 5, Nitrous 4, Shock 4 = 52 (all 8 types).

### 3.3 Shuffle groups

`68` groups = **10 row-backed groups / 25 placements** + **58 fixed-type
singletons**. Nine row groups hold exactly their allowed canonical set. The
exception is real and is not filled in:

| group | allowed | members | serialized types | complete |
| --- | --- | ---: | --- | --- |
| `771609565:7` | Barge, Blindfire, Bomb, Shunt | **1** | Barge (uid 4231571987) | **no** |

That single member also stores `PickupActiveLevel = 0`, so the whole group has
no spawnable member. No missing actor is invented.

Alternate route 2779865848: 40 groups = 9 row groups / 21 placements + 31 fixed;
all row groups complete.

### 3.4 Measured-path coverage

| measure | value |
| --- | ---: |
| measured length | 2,060.595408 m |
| minimum distance | **0.452 m** (uid 505192272, arc 1,050.106) |
| median distance | 207.505 m |
| ≤ 2.0 m | **2** |
| ≤ 5.0 m | 2 |
| ≤ 6.0 m | 2 |
| ≤ 10 m | 5 |
| ≤ 25 m | 8 |
| at centreline ≤ 1.25 m | **1** |
| with offset ≤ 6.0 m | **2** |

Near-path slots (≤ 25 m):

| uid | type | x | y | z | dist | arc | height above ground | yaw° | tangent° | group |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 505192272 | Shunt | −166.037 | 0.805 | 1276.677 | **0.452** | 1050.106 | 0.701 | −52.715 | 135.008 | 379463969:10 |
| 4245419773 | Blindfire | −157.150 | 0.898 | 1380.702 | **1.731** | 521.757 | 0.728 | 129.804 | −44.992 | fixed |
| 4158343510 | Repair | −150.491 | 0.891 | 1389.117 | 8.843 | 519.448 | 0.704 | 131.650 | −44.992 | fixed |
| 953200634 | Shield | −171.703 | 0.804 | 1268.856 | 9.084 | 1051.628 | 0.700 | −50.897 | 134.984 | fixed |
| 906316855 | Repair | −160.482 | 0.871 | 1284.008 | 9.565 | 1048.854 | 0.700 | −52.034 | 134.984 | fixed |
| 3362603906 | Barge | −155.431 | 0.873 | 1290.481 | 17.713 | 1047.843 | 0.701 | −52.034 | 135.008 | 379463969:10 |
| 2200508302 | Shock | −177.816 | 0.804 | 1261.335 | 18.725 | 1052.629 | 0.700 | −50.897 | 135.008 | fixed |
| 3318541855 | Shield | −142.397 | 0.891 | 1399.386 | 21.741 | 519.448 | 0.700 | 131.650 | −44.992 | fixed |

`yaw` is the retail actor `WorldMatrix.az` facing, **not** the track tangent.
The consumer must not copy the tangent over it.

Alternate route 2779865848: min 0.578 m (uid 462581234 Shock, arc 404.23,
centreline-collectable), median 193.843 m, ≤ 2 m 1, ≤ 25 m 3.

### 3.5 Exclusions and flags (primary)

| uid | type | status | reasons | evidence |
| ---: | --- | --- | --- | --- |
| 4231571987 | Barge | **exclude** | `pickup-active-level-0` | `PickupActiveLevel 0`; on the ground (y −1.311, ground −1.979, height 0.668 m) but off-path 709.86 m; sole member of `771609565:7` |
| 2569061116 | Repair | flag | `non-drivable-surface`, `elevated-above-detected-ground`, `off-measured-path` | ground normal 0.9154 (23.7°), height 2.642 m, off-path 207.51 m |
| 844266989 | Shock | flag | `non-drivable-surface`, `elevated-above-detected-ground`, `off-measured-path` | ground normal 0.7531 (41.1°), height 2.883 m, off-path 206.54 m |
| 2082384099, 2131486818, 1802474478, 83197833, 4025371211, 2020598615 | Blindfire ×3, Shield, Shock, Shield | flag | `elevated-above-detected-ground` | 3.236–7.668 m above the highest exported triangle below |

Flag counts on the primary route (reason occurrences; one slot can carry
several): `off-measured-path` 81 (including the excluded slot),
`elevated-above-detected-ground` 8, `non-drivable-surface` 2. There are
**no** `no-collision-ground-below`, `inside-collision-structure`,
`collision-clearance-low`, `collision-cover-low`, `visible-structure-overlap`
or `inside-visible-structure` cases.

Properties of the primary set:

| measure | value |
| --- | ---: |
| height above ground | 0.617 / 0.700 / 7.668 m (min / median / max) |
| nearest steep collision triangle | 0.660 m min; 18 slots have one within 12 m, 65 do not |
| nearest steep draw triangle | 0.434 m min; 47 slots have one within 12 m |
| collision surface above | 14 slots have one; minimum cover 2.650 m |
| yaw range | −143.848° … 131.650° |
| min nearest-neighbour | 5.979 m |
| duplicate uids / XZ | 0 / 0 |

**Refinement of PWR5 (§11.2).** PWR5 used the *highest* up-facing triangle and
reported negative heights for uids 1705750750 and 1529678209, flagging four
slots as non-drivable. The PWR6 probe separates "ground below" from "surface
above": those two slots sit on flat ground (`normal.y = 1.0`, height 0.70 m)
under a structure 13.645 m / 13.178 m above, and are **not** non-drivable. The
two remaining non-drivable slots are 2569061116 and 844266989. The PWR5 text is
historical evidence; this measurement supersedes its four-flag count.

---

## 4. `spa_barcelona_gracia`

### 4.1 Route authority

| route record | `RouteNumber` | racing / total races | MP pickup list | placements | spawnable / excluded |
| ---: | ---: | ---: | ---: | ---: | ---: |
| **46220414** (primary) | **2** | **17 / 20** | **2129257726** | **59** | **59 / 0** |
| 2844032875 | 5 | 11 / 17 | 803212761 | 45 | 45 / 0 |
| 3824353713 | 1 | 11 / 14 | 3665871924 | 40 | 40 / 0 |
| 307136456 | 0 | 0 / 0 | — (unraced) | 0 | — |
| 3491235362 | 6 | 0 / 0 | — (unraced) | 0 | — |

City `SPA_Barcelona_Gracia`. The total-race column includes non-racing
(`hardcore`) rows; they are recorded in `races[]` but do not change the primary.

### 4.2 Primary route 46220414 — type counts

| type | count | MP type |
| --- | ---: | --- |
| Blindfire | 15 | Blindfire |
| Shunt | 13 | Shunt |
| Bomb | 9 | Bomb |
| Barge | 7 | Barge |
| Nitrous | 4 | Nitrous |
| Repair | 4 | Repair |
| Shield | 4 | Shield |
| Shock | 3 | Shock |
| **total** | **59** | all 8 |

Alternate 2844032875: Blindfire 10, Barge 7, Shunt 7, Bomb 5, Repair 5, Nitrous 4,
Shock 4, Shield 3 = 45. Alternate 3824353713: Blindfire 10, Barge 6, Bomb 6,
Shield 5, Nitrous 4, Shunt 4, Shock 3, Repair 2 = 40. Both carry all 8 types.

### 4.3 Shuffle groups

Primary: **43 groups = 8 row groups / 24 placements + 35 fixed singletons**; all
eight row groups hold their complete allowed set (`serializedTypesEqualAllowedSet
= true`). Alternate 2844032875: 33 groups = 7 row / 19 + 26 fixed. Alternate
3824353713: 25 groups = 7 row / 22 + 18 fixed.

### 4.4 Measured-path coverage

| measure | value |
| --- | ---: |
| measured length | 624.913781 m |
| minimum distance | **0.834 m** (uid 2287257657, arc 383.113) |
| median distance | 449.130 m |
| ≤ 2.0 m | **1** |
| ≤ 5.0 m | 2 |
| ≤ 6.0 m | 2 |
| ≤ 10 m | 4 |
| ≤ 25 m | 5 |
| at centreline ≤ 1.25 m | **1** |
| with offset ≤ 6.0 m | **2** |

Near-path slots:

| uid | type | x | y | z | dist | arc | height above ground | yaw° | tangent° | group |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2287257657 | Blindfire | 654.910 | 130.700 | −117.166 | **0.834** | 383.113 | 0.700 | 108.052 | 90.000 | fixed |
| 5715789 | Bomb | 657.394 | 130.700 | −109.544 | **4.993** | 391.168 | 0.700 | 108.052 | 44.997 | fixed |
| 2234632569 | Shunt | 652.380 | 130.800 | −124.927 | 6.927 | 380.583 | 0.700 | 108.052 | 90.000 | fixed |
| 2161991382 | Barge | 659.983 | 130.700 | −101.600 | 8.780 | 398.616 | 0.700 | 108.052 | 45.005 | fixed |
| 3669525037 | Shunt | 662.619 | 130.743 | −93.511 | 13.142 | 402.588 | 0.643 | 108.052 | 44.997 | fixed |

Alternates: 2844032875 is entirely off the measured path (minimum 94.278 m).
3824353713 touches the measured finish: uid 1893848846 Blindfire at 2.505 m
(arc 620.09), then 9.92 m and 23.49 m; 0 at the static-box centreline.

### 4.5 Exclusions and flags (primary)

There are **no hard exclusions** and **no inside-structure cases**. The 57
non-on-course slots carry only `off-measured-path`; all 59 have ground.

| measure | value |
| --- | ---: |
| height above ground | 0.614 / 0.700 / 0.754 m |
| nearest steep collision triangle | 0.611 m min; 57 slots have one within 12 m, 2 do not |
| nearest steep draw triangle | 0.712 m min; 47 slots have one within 12 m |
| collision surface above | 1 slot (uid 3074095606, cover 6.355 m) |
| yaw range | −173.870° … 129.644° |
| min nearest-neighbour | 6.881 m |
| duplicate uids / XZ | 0 / 0 |

---

## 5. All eight MP types and the ninth

| MP type | `PickupType.refId` | Amboy primary | Gracia primary |
| --- | ---: | ---: | ---: |
| Nitrous | 2377082647 | 17 | 4 |
| Shock | 973327125 | 5 | 3 |
| Shunt | 736887763 | 14 | 13 |
| Blindfire (`Bolt`) | 1291339931 | 18 | 15 |
| Barge | 1621319152 | 7 | 7 |
| Bomb (`Mine`) | 733160612 | 7 | 9 |
| Repair | 162617178 | 9 | 4 |
| Shield | 1866809209 | 6 | 4 |
| **total** | | **83** | **59** |

**SuperShield (refId 3093073274) is not placed by default.** It is defined in
`pickups.bin` but has no multiplayer flag and no `PickupPosition` on either
map. `extensions.SuperShield` records `placedByDefault:false`,
`status:"project-extension"`. Adding a slot would invent a coordinate, so no
slot exists. See `docs/work/analysis/supershield.md`.

Fan (3748041782) and Stopwatch (3476635578) are also defined with no placement;
they are recorded in `typeTable.notPlacedByDefault`.

### 5.1 Types on the measured sub-course

| map | types on `measuredCourseSet` | types only on the retail route |
| --- | --- | --- |
| Amboy | **Shunt, Blindfire** | Nitrous, Shock, Barge, Bomb, Repair, Shield |
| Gracia | **Blindfire, Bomb** | Nitrous, Shock, Shunt, Barge, Repair, Shield |

The measured e1-drive path is draw coverage, not the retail lap. Placing the six
missing types on the measured sub-course would require either the retail `.aid`
arc (not decoded) or an explicitly labelled `provisional-measured-arc` slot
(PWR2's six-slot plan). PWR6 does neither: it reports the fact and leaves the
choice to the host.

---

## 6. Runtime set

### 6.1 Schema (`powerups.pickup-runtime/1`)

Top level: `kind`, `version`, `level`, `measuredLayout`, `sources`,
`courseInputs`, `reader`, `verifier`, `typeTable`, `geometryModel`,
`respawnModel`, `collectionModel`, `authority`, `runtime`, `extensions`,
`integration`, `missing`, `limits`, `hashes`.

`authority.variants[]` holds every raced route, each with `slots[]`, `groups[]`,
`races[]`, `defaultRaceConfig`, `summary`, `defaultSpawnSet`,
`measuredCourseSet`, `excluded`, `flagged`, `offPath` and `startGrid`.

A slot:

```json
{
  "index": 0, "retailOrder": 0, "uid": 505192272,
  "actorListId": 12510741, "actorListRecord": 1,
  "component": 2, "element": 0,
  "provenance": { "recordDataOffset": 29488, "elementOffset": 29844,
                  "elementStrideBytes": 108, "fieldOffsets": {...},
                  "matrixOffsets": {...} },
  "position": {"x": -166.03741455078125, "y": 0.8053200244903564,
               "z": 1276.67724609375},
  "basis": {"ax": [...], "ay": [...], "az": [...]},
  "yaw": {"radians": -0.9200453692910437, "degrees": -52.714716620932045,
          "source": "WorldMatrix.az (retail actor basis; forward = (sin yaw, cos yaw))",
          "measuredTangentRadians": 2.3563317711140104,
          "measuredTangentDegrees": 135.0078656174191},
  "serializedType": {"refId": 736887763, "name": "Shunt",
                     "mpType": "Shunt", "isMultiplayerType": true},
  "row": {"refId": 379463969, "id": 10, "shuffleGroup": "379463969:10",
          "allowedTypes": [...], "canonicalAllowedTypes": [...],
          "runtimeTypeRule": "row-assignment-without-replacement"},
  "rowIdRaw": 10,
  "overrides": {"pickupActiveLevel": 1, "rotateGraphic": false,
                "activationTimer": 0.0, "activationLap": 0,
                "respawnTimerOverride": 0.0, "constantShuffle": false,
                "shuffleTypes": {"bits": 0, "labels": []},
                "excludedPickupTypes": []},
  "measuredPath": {"distance": 0.45245691712612096,
                   "arc": 1050.1060152188948,
                   "signedCross2d": 0.452456917126121,
                   "nearestSampleIndex": 4418,
                   "nearestSampleGroundY": 0.10480000078678131,
                   "heightAbovePathSurface": 0.7005200237035751, "tangent": [...]},
  "surface": {"groundBelowY": 0.10477304390806594,
              "groundBelowNormalY": 0.9999999331478233,
              "heightAboveGround": 0.7005469805822905, "surfacePresent": true,
              "firstSurfaceAboveY": null, "coverAboveMetres": null,
              "nearestSteepCollisionDistance3d": null, "drivableSurface": true},
  "reachability": {"pathClass": "on-path", "status": "spawn",
                   "hardExclusions": [], "flags": [],
                   "spawnable": true, "onMeasuredCourse": true,
                   "collectableAtCentreline": true,
                   "collectableWithOffset": true},
  "respawn": {"overrideSeconds": 0.0, "overrideUsed": false,
              "deactivateSeconds": 0.6000000238418579,
              "modeSeconds": null, "modeStatus": "not-serialized"}
}
```

Abridged; the file carries every field.

### 6.2 Ordering

- `slots[]`: retail actor order — `component`, then `element`, then `index`.
- `groups[]`: sorted by `groupId` string.
- `measuredCourseSet`: the measured course subset ordered by `arc`.
- `defaultSpawnSet`: spawnable slots filtered by the modal race `powerups` mask,
  in retail order.

### 6.3 Yaw

`yaw.radians = atan2(az.x, az.z)`, the engine convention
`forward = (sin yaw, cos yaw)`. It comes from the retail actor basis; it is not
derived from the track and must not be replaced by `measuredTangentRadians`.
The tangent is recorded separately for diagnostics.

### 6.4 Respawn / reset semantics (identical to River)

| item | value | status |
| --- | --- | --- |
| per-slot `RespawnTimerOverride` | 0.0 on every slot | serialized, override unused |
| deactivate after collection | 0.6000000238418579 s | PWR1 `PickupDeactivateTimer` |
| `Normal` respawn seconds | **null** | not serialized → host emits `respawn-unresolved` |
| `Long` | 5.0 s | `MultiplayerConfig` |
| `VeryLong` | 20.0 s | `MultiplayerConfig` |
| `AlwaysOn` / `None` | no decoded seconds | label-only semantics |
| `ActivationTimer` / `ActivationLap` | 0 / 0 on every slot | no timed/lap override |
| `ConstantShuffle` | false on every slot | no continuous reshuffle |
| row group | pop one allowed type without replacement; re-initialise when empty | engine rule (PWR3 §4.2) |
| fixed slot | keep the serialized type unless `randomPowerups = On` | modal default is `Off` |

Race-start reset: re-spawn every spawnable slot with its serialized type and
reset every row group's list to its allowed mask. There is **no lap reset** in
the recovered data (all activation laps are 0). Respawn relocates nothing: the
`WorldMatrix` is static and absolute, with no relative-to-route binding.

Default race configuration per primary route (modal over racing rows):

| map | masks | respawn | random | default enabled types |
| --- | --- | --- | --- | --- |
| Amboy | 255 ×10, 245 ×1 (intersection 245) | Normal ×10, Long ×1 | Off ×10, On ×1 | all 8 |
| Gracia | 255 ×17 | Normal ×17 | Off ×17 | all 8 |

A host binding a specific race must additionally apply that race's `powerups`
mask. Amboy's 245 race disables Shock and Bomb; the manifest records both the
modal set (used by `defaultSpawnSet`) and the intersection/union so this is not
hidden.

### 6.5 Groups at runtime

Each group carries `allowedTypes`, `canonicalAllowedTypes`,
`availableTypesAtRaceStart`, `placementUids`, `serializedTypes`,
`serializedTypesEqualAllowedSet`, `cycleRule` and `respawnsAsGroup`. Fixed slots
are `kind:"fixed-singleton"`; row slots are `kind:"row-shuffle"`. The incomplete
Amboy group is published as incomplete, not repaired.

---

## 7. Verifier, determinism, regression

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/powerups/tools/build_pickup_runtime.py --level usa_amboy
& $py probes/powerups/tools/build_pickup_runtime.py --level spa_barcelona_gracia
& $py probes/powerups/tools/verify_pickup_runtime.py --level usa_amboy
& $py probes/powerups/tools/verify_pickup_runtime.py --level spa_barcelona_gracia
```

| gate | Amboy | Gracia |
| --- | ---: | ---: |
| verifier checks | **8,268** | **8,852** |
| passed / failed | **8,268 / 0** | **8,852 / 0** |
| variants / placements covered | 2 / 135 | 3 / 144 |
| determinism (two builds) | byte-identical, equals manifest | byte-identical, equals manifest |
| runtime file SHA-256 | `66f6b213…c5292f` | `4245749b…3da130` |
| canonical SHA-256 | `26292894…85b403` | `864c9919…c2be5a` |

The verifier deliberately does not import the builder's `xt_decode`. It:

- re-reads the five PAK entries and re-checks the SHA-256 and extents;
- validates the FLSK tables with the committed reference parser and decodes
  every field with the second direct-offset reader;
- re-derives the 8 type ids, all row masks, the MP mask labels and respawn
  labels;
- re-reads every route, race, spawn set and actor list;
- for every slot, re-decodes the actor and compares position, basis, uid, name,
  type, row, every override and the matrix;
- reads every documented offset from the raw bytes (uid, `aw`, type handle,
  active level, rotate, respawn override, row handle, `RowId`);
- recomputes yaw, projection, signed cross, tangent and sample height;
- recomputes ground-below / surface-above / cover / steep-wall distance on the
  collision mesh and the draw buffers with a different point/triangle formula;
- recomputes the full reachability classification, groups, duplicates, counts,
  runtime sets, type coverage and the SuperShield extension;
- re-runs the builder twice and requires byte identity with each other and with
  the manifest;
- recomputes the canonical hash.

River regression after the change: `verify_pickup_placement.py` →
**1,415 / 1,415 PASS** (`_work/logs/powerups/pwr6-river-regression.log`).

The full repository suite (`tools/verify_asset_probe.py --skip-build`) was not
run by this sub-agent because it writes `_work/verification/suite.json`, which
is outside PWR6's file ownership. The main agent runs it before commit.

---

## 8. Integration contract for e1-drive

PWR6 does not modify `probes/e1-drive/**`. This is what the host must consume.

### 8.1 Files and schema

| item | value |
| --- | --- |
| Amboy input | `_work/powerups/runtime-amboy.json` |
| Gracia input | `_work/powerups/runtime-gracia.json` |
| schema | `powerups.pickup-runtime/1` |
| route selection | `runtime.routeRecordId` → `authority.variants[]` |
| per-map file SHA-256 | Amboy `66f6b2133325052497c5cd24c931fa1bb20556cf61de3b7dbf033e8888c5292f`, Gracia `4245749be5ab073b14fbde1e82933724b22c5649fee4eb5bbebf258f7c3da130` |
| per-map canonical SHA-256 | Amboy `262928949dcc1ecb350dfe709bc25b27fc6a2602e7ab3927092dc7ba7a85b403`, Gracia `864c991997a488957c43eb996eb4d7b737b4eb34f4bb0192ec402421a3c2be5a` |
| verifier result | `runtime-<map>.verify.json` (`documentFileSha256` must equal the file hash above) |
| reader pin | `xt_decode.py` `594f2bf7…fedded4`, geometry `59f42bf1…be49b57a` |
| verifier pin | `verify_pickup_runtime.py` `522c136e…7444f6a9` |

Do **not** use `_work/powerups/placements-{amboy,gracia}.json` as a spawn list.
They remain the PWR5 provenance artifact but have no yaw, no structure test and
no runtime status.

### 8.2 What the host must send / do

1. Load the map's runtime file; verify `documentFileSha256` against
   `.verify.json` and `hashes.canonicalSha256`; refuse to start on a mismatch.
2. Pick the variant by `runtime.routeRecordId` (or an explicit variant record id
   supplied by the room, labelled). Never mix variants in one race.
3. Spawn slots from `runtime.defaultSpawnSet`, using the slot's `position`,
   `yaw.radians`, `serializedType.refId`, `row.shuffleGroup`, `overrides` and
   `respawn` verbatim. For the measured e1-drive sub-course, use
   `runtime.measuredCourseSet` instead and label every item
   `placement:"measured-course-retail"`.
4. Apply the race `powerups` mask on top (`defaultRaceConfig` is the modal, not
   a guarantee); a slot whose MP type is disabled does not spawn.
5. Own the group available lists, the RNG, deactivation/respawn timers and the
   collection box test. Emit `pickup-spawned`, `pickup`, `pickup-respawn`,
   `pickup-rejected` (local) with `uid`, `typeRefId`, `group`, `position`, `at`,
   `authority`, `seq`.
6. Validate collection against the **oriented 1.25 × 1.25 × 0.25 m Gravity
   box** at `WorldMatrix.aw` oriented by `ax/ay/az`. `PickupRadius = 2.0` is a
   proximity threshold, not the trigger.
7. Keep `respawn.modeSeconds = null` for `Normal` and emit
   `respawn-unresolved`; never substitute 5.0/6.0/20.0 by guess.
8. Late join: send the full slot state (`active`, `typeRefId`, `respawnAt`),
   every group's remaining list, `routeRecordId` and map id, then continue from
   the next `seq`.
9. Fail closed with a typed reason if a uid is missing, excluded, or a group
   list is empty. Never fall back to the nearest measured sample.

### 8.3 What the client must not assume

- It must not invent, interpolate or snap a coordinate. Every coordinate comes
  from `slots[].position`; yaw comes from `yaw.radians`.
- It must not assume all 8 types are on the measured sub-course. Only the uids
  in `measuredCourseSet` are collectable as-is (2 per map).
- It must not assume `Normal` respawn seconds, RNG order, probability
  normalisation or inventory capacity; those are runtime-only / not serialized.
- It must not roll a type, respawn a pickup or judge a collection locally.
- It must not treat the diagnostic draw buffers as a rendered map or the
  collision triangle export as the complete physics file (simple shapes and
  `InstancedTriangleMesh` are excluded).
- It must not present a provisional slot as retail. If the host adds a
  six-arc provisional plan for the measured course, it stays labelled
  `provisional-measured-arc` and the retail uids stay separate.

### 8.4 Host event payloads (minimum)

| event | payload |
| --- | --- |
| `pickup-spawned` | `uid, typeRefId, group, position{x,y,z}, yawRadians, routeRecordId, mapId, placement, seq` |
| `pickup` | `uid, typeRefId, group, playerId, at, seq` |
| `pickup-respawn` | `uid, typeRefId, group, respawnAt, seq` |
| `pickup-rejected` | `uid, playerId, reason` (`not-active`, `type-disabled`, `outside-box`, `inventory-full`, `inactive-level`), local only |

---

## 9. Limits and non-claims

1. **Placement data only.** No renderer, GPU, browser frame, vehicle, race loop
   or full-game claim.
2. **No retail arc.** The `.aid` v6 spline is not decoded. The measured layouts
   are draw-covered point-to-point paths, not retail start lines or laps.
   Projections are reported, never used to move a slot.
3. **Measured sub-course coverage is partial.** All 8 types are on the retail
   route, but only 2 per map are on the measured path. Filling the gap needs the
   retail route or a labelled provisional plan; PWR6 does neither.
4. **`Normal` respawn seconds are not serialized.** `RespawnTimerOverride` is
   0.0 on every slot. `AlwaysOn` / `None` semantics are label-only.
5. **RNG order is runtime-only.** The allowed set and the no-replacement rule
   are proven; the draw order is not.
6. **Collision export is partial.** The committed scanner exports static
   triangle meshes only. Boxes, cylinders and `InstancedTriangleMesh` are not in
   the queried mesh, so a slot whose support is one of those can read as
   elevated. Eight Amboy slots are flagged
   `elevated-above-detected-ground` for that reason (or because they are
   deliberate jump pickups); none is excluded.
7. **Visible geometry is diagnostic.** The draw buffers have no materials,
   alpha, shader or texture state; the clearance test is geometry only.
8. **Structure test is a centre-point test.** The trigger box is 2.5 m wide; a
   wall at 0.66 m from the centre can overlap the box without the centre being
   inside. No box was enlarged or moved.
9. **`PickupActiveLevel` semantics are raw-only.** Value 1 on 278 of 279
   placements; Amboy uid 4231571987 stores 0 and is excluded, not guessed.
10. **No probability normalisation.** No raced Amboy/Gracia route binds a
    `PickupProbabilityList`; only the `MpPickup` mask enables/disables types.
11. **Incomplete row group is published as-is.** `771609565:7` has one actor
    for a four-type row; no actor is invented.
12. **No file outside PWR6 ownership was changed**, and no verification output
    outside `_work/powerups/**` / `_work/logs/powerups/**` was written.

---

## 10. Evidence and reproduce

| artifact | content |
| --- | --- |
| `_work/powerups/runtime-amboy.json` | 2 variants / 135 placements; file `66f6b213…c5292f`, canonical `26292894…85b403` |
| `_work/powerups/runtime-amboy.verify.json` | **8,268 checks, PASS**; file `fe9145cb…d693659a` |
| `_work/powerups/runtime-gracia.json` | 3 variants / 144 placements; file `4245749b…3da130`, canonical `864c9919…c2be5a` |
| `_work/powerups/runtime-gracia.verify.json` | **8,852 checks, PASS**; file `c84d4054…b7f2e7118e` |
| `_work/powerups/pwr6-summary.json` | condensed tables used here; file `79c65f1f…594271ce` |
| `_work/logs/powerups/pwr6-extract-{amboy,gracia}.log` | builder output and file hashes |
| `_work/logs/powerups/pwr6-verify-{amboy,gracia}.log` | verifier output |
| `_work/logs/powerups/pwr6-river-regression.log` | River 1,415/1,415 PASS |
| `probes/powerups/tools/build_pickup_runtime.py` | builder (`ff829a4f…c2218a2e`) |
| `probes/powerups/tools/verify_pickup_runtime.py` | independent verifier (`522c136e…7444f6a9`) |
| `probes/powerups/tools/pickup_runtime_common.py` | geometry/projection helpers (`59f42bf1…be49b57a`) |

Determinism: two consecutive builder runs per map produced byte-identical
runtime files and the same SHA-256 as the committed artifact (the verifier
performs this comparison on every run).
