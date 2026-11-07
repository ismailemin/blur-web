# Power-up, weapon, mine, shield, nitro, repair and shock definitions

**Date:** 7 November 2026
**Owner:** PWR1 (sub-agent)
**Scope:** recovery and documentation only. New directory `probes/powerups/` and
outputs under `_work/powerups/` / `_work/logs/powerups/`. No change to
`probes/e1-drive/`, `probes/asset-reader/`, the engine, `tools/`, other probes,
`upstream/` or `game-data/`. Game data is read-only.
**Result:** **11 `PickupType` entities** with a fully recovered definition field
set, **8 multiplayer enable flags**, per-race and per-event settings, HUD/audio
references, a deterministic manifest, an independent verifier (1,783 checks) and
a 9/9 unit-tested rules prototype. **This is not a full-game or retail-parity
claim.**

---

## 0. TL;DR

| item | result |
| --- | --- |
| definition pack | `\gamedata\xt\pickups.bin` in `gamedata.pak` |
| schema | FLSK v2, 101 types, 401 fields, 912 refs, 863 records, 132,056 B |
| entities | **11** `PickupType` records: Nitrous, Shock, Shunt, Blindfire, Barge, Bomb, Repair, Shield, Fan, Stopwatch, SuperShield |
| multiplayer classes | **8** `MpPickup` flags: nitro, shock, barge, mine, shunt, bolt, shield, repair |
| per-race settings | **439** `MultiplayerRace` records |
| per-event settings | **86** single-player `AmaxEvent` records with difficulty power-up damage modifiers |
| pickup probability lists | **51** `PickupProbabilityList` records (0.0–5.0 raw sums, not normalised) |
| position rows | **64** `PickupPositionRow` records (8 named `PickupTypeList` flags) |
| HUD refs | 16 `UiPerkInfo` entries with `texture_index` and colour/loc ids |
| audio refs | 18 named perk audio entities (fire/projectile/hit families) |
| manifest | `_work/powerups/powerups.json`, 982,981 B, SHA-256 `6ee5a3e6…bc73d7`, content hash `543b059a…c654df` |
| verifier | **1,783/1,783 checks PASS**, Python + native `xt_inspect.exe` agreement |
| rules prototype | **9/9 tests PASS** (mine hit/miss, shield absorb, effect expiry, pickup respawn, inventory, event sequencing) |

The shipped data proves the **eight retail multiplayer classes** by explicit enum
labels. It also contains three single-player-only pickups (Fan, Stopwatch,
SuperShield) that have no multiplayer flag. The internal name **Blindfire** is
used for the multiplayer **Bolt** class and **Bomb** for **Mine**; those two
aliases are marked *inferred* (evidence in §3), not as serialized equalities.

---

## 1. Sources and hashes

All sources are entries inside `game-data/Blur/cache/gamedata.pak` (V2, codec 2
zlib, secure FAT). Nothing was extracted to `upstream/` or written back.

| source | path | offset | stored / logical | types | fields | records | SHA-256 (decoded) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| pickups | `\gamedata\xt\pickups.bin` | 22,464,512 | 50,403 / 132,056 | 101 | 401 | 863 | `f8e9ba3d0749dcb2b7b775c25fc1e0ec5c337b4835efa947f0cfe329a4965ed7` |
| multiplayer | `\gamedata\xt\multiplayer.bin` | 22,425,600 | 38,176 / 103,912 | 93 | 798 | 646 | `0dcf60bc5306069c2dfa6a4d89701a27f0e789235a1bcf5f9aa2167d9ef6ab48` |
| UI | `\gamedata\xt\ui.bin` | 22,589,440 | 249,271 / 1,004,480 | 135 | 671 | 201 | `e7fd10138524b7e0912561a797cd037a3a6d82b0859750f74ebf8f8ea9f67691` |
| audio | `\gamedata\xt\audioentities.bin` | 21,354,496 | 369,013 / 592,392 | 19 | 34 | 228 | `a7ef1c0416fc335eb72a379da2e771ddaa91c4ca08757f9f5f61327cf422b785` |
| dynamic FX | `\gamedata\xt\dynamiceffects.bin` | 21,766,144 | 75,275 / 335,580 | 75 | 323 | 1,132 | `d8a2d8c22b14ca99550d0ea03a6eaefb0f60df4f4598e6e35a17514715eda60e` |
| single-player | `\gamedata\xt\singleplayer.bin` | 22,550,528 | 28,592 / 120,736 | 106 | 310 | 89 | `14af6d07a0fe6eb84253c794e1473196098eeeed215dd7988a8c387d86d65f19` |
| scoring (searched) | `\gamedata\xt\scoring.bin` | — | 7,973 / 14,728 | 12 | — | 96 | `18097782d86d2d37458f9bb40b8f002c041663022119fb9133227064633a733d` |

`singleplayer.bin` is the per-event/difficulty settings source used in §5.2.
`scoring.bin` was searched and contains no pickup definition types (recorded in
`powerups.json.searchedPacks`). `dynamiceffects.bin` is used only to resolve
external `Particle_Event` / `Light_Object` handles by 32-bit record id; its
payloads are not decoded into the manifest.

The PAK entry offsets, stored sizes, path CRCs and FAT indexes are in
`powerups.json.sources[]`. No payload signature or authenticity check is claimed.

---

## 2. Decoding method (no guessed offsets)

`probes/powerups/tools/xt_decode.py` is a bounded FLSK v1/v2 reader. It re-uses
the committed table validation (`tools/prepare_xt_fixture.py`,
`FORMAT-xt.md`) and adds payload decoding with the source-defined rules:

| serialized construct | rule | source authority |
| --- | --- | --- |
| atom width | use the schema type size (all atoms here are 4 B except `u64` 8 B) | `XtReflection.h` `XtAtomType`; `FlaskDecodeAtom` |
| struct | inline at the field offset, base structs first | `XtFlaskEmit.cpp` `EmitStruct` |
| pointer (behaviour 4) | `{u16 component, u16 element}` into the **owning record's** component table | `FlaskDecodePtr`, `XtFlaskImport.cpp:696-713` |
| handle (behaviour 5) | `u32` index into the **sorted refs table** after `CompileRefList` | `FlaskDecodeHandle` `:715-727`; `XtFlaskExport.cpp` |
| array | `{u16 component, u16 element, u32 length}` into the owning record's component table | `FlaskDecodeArray` `:729-760` |
| enum | stored as a **label index**; the declared integer is not serialized | `FlaskDecodeEnum` `:656-666` |
| record strings | v2 XOR/previous-byte transform, final byte NUL | `XtFlaskDecodeStrings`, `XtFlask.cpp:11-28` |

The decoder is exercised on all 863 pickup records. The verifier re-parses the
same files with a **second direct-offset reader** (no import of `xt_decode`) and
compares every scalar it can, plus the schema/record extents reported by the
committed native `xt_inspect.exe`. All three paths agree on 1,783 checks.

Manifest: `_work/powerups/powerups.json`. Raw decoded copies (not committed):
`_work/powerups/{pickups,multiplayer,ui,audio,dynamiceffects,singleplayer}.xt`.

---

## 3. Enumerated entities and class mapping

`PickupSystem` (record 54, id 253474959) has a `Types` handle array of **11**
`PickupType` records. That array is the enumeration authority; the entity set is
not inferred from file names.

| # | PickupType record | record id | levels present | base prob | MP flag | HUD key(s) | audio entities |
| ---: | --- | ---: | ---: | ---: | --- | --- | --- |
| 1 | Nitrous | 473 / 2377082647 | 3 | 0.5 | `nitro` (exact) | `nitrous` | `NitrousHit` |
| 2 | Shock | 202 / 973327125 | 2 | 0.2 | `shock` (exact) | `shock` | `Shock`, `ShockProjectile`, `ShockHit` |
| 3 | Shunt | 152 / 736887763 | 3 | 1.0 | `shunt` (exact) | `shunt` | `Shunt`, `ShuntProjectile`, `ShuntHit` |
| 4 | Blindfire | 271 / 1291339931 | 4 | 1.0 | `bolt` (**inferred**) | `blindfire1/2/3` | `BlindFire`, `BlindFireProjectile`, `BlindFireHit` |
| 5 | Barge | 329 / 1621319152 | 1 | 1.0 | `barge` (exact) | `barge` | `Barge`, `BargeHit` |
| 6 | Bomb | 148 / 733160612 | 5 | 1.0 | `mine` (**inferred**) | `bomb` | `Bomb`, `BombProjectile`, `BombHit` |
| 7 | Repair | 35 / 162617178 | 1 | 0.5 | `repair` (exact) | `repair` | `RepairHit` |
| 8 | Shield | 373 / 1866809209 | 2 | 0.5 | `shield` (exact) | `shield` | `Shield` |
| 9 | Fan | 758 / 3748041782 | 1 | 0.0 | none | none | none |
| 10 | Stopwatch | 703 / 3476635578 | 1 | 0.0 | none | none | none |
| 11 | SuperShield | 619 / 3093073274 | 1 | 0.0 | none | `superShield` | none |

### 3.1 Variant slots (serialized enum `Pickup`)

`PickupType` points to up to seven `PickupLevel` handles:
`Normal`, `DoubleTap`, `Reversed`, `ReversedDoubleTap`, `Mini`, `Modified`,
`ReversedModified`. Missing slots are serialized as null handles; they are not
invented.

- Bomb has all five of `Normal / DoubleTap / Reversed / Mini / Modified`.
- Blindfire has `Normal / Reversed / Modified / ReversedModified`.
- Nitrous and Shunt have `Normal / DoubleTap / Reversed`.
- Shock and Shield have `Normal / DoubleTap`.
- Barge, Repair, Fan, Stopwatch and SuperShield have `Normal` only.

`Reversed` is the serialized backward variant. There is no “forward” label: the
forward case is `Normal`. “Bolt” is not a `Pickup` label; it is the multiplayer
flag/`PickupTypeList` name for the Blindfire class.

### 3.2 Why the two aliases are marked inferred

| internal | multiplayer | evidence (not a serialized equality) |
| --- | --- | --- |
| Blindfire | bolt | `MpPickup` and `PickupTypeList` both contain `bolt` and no `blindfire`; the Blindfire levels reference `Bolt_Shotgun_Projectile.cycle` and `BoltLaserSightBeam.cycle`, and no other pickup references those assets. |
| Bomb | mine | `MpPickup` has `mine` and no `bomb`; `PickupTypeList` has `Mine`; `BombBalancingData` carries `MasterMinePrimeTimer`; `BombModifiedBalancingData` carries `NoMiniMinesToCreate` and `TotalSpreadWidth`; the FX slots are `MineSpecialFX`, `MasterMinePrimedSpecialFX`, `MasterMineEquipedSpecialFX`. |

The manifest stores these as `multiplayer.status = "inferred-alias"`, with the
evidence strings. Direct matches are `status = "exact-label-match"`; Fan,
Stopwatch and SuperShield are `status = "not-in-mp-pickup-enum"`.

---

## 4. Recovered definitions

### 4.1 Global `PickupSystem` parameters (record 74, id 367762224)

| field | value | note |
| --- | ---: | --- |
| `PickupRadius` | 2.0 | pickup trigger radius |
| `PickupDeactivateTimer` | 0.6 s | deactivated time after collection |
| `PostPickupAwardCoolDownTimer` | 0.0 s | award cooldown |
| `DestroyExistingPickupOnNewPickup` | false | |
| `MaximumXPMultiplication` | 8.0 | |
| `GarageSpecialFX` / `GarageLockedCarSFX` | record 574 / 532 | model `Garage_Engulf_01`, `Garage_Mystery_Car` |
| `ParametersStoredOnline` | external ref id **534771951** | resolves in `multiplayer.bin` to `PickupParametersStoredOnline`: `RecoveryTime=6.0`, `RecoveryTimeSpeedMod=0.1` |

### 4.2 `PickupType` fields (all 11 entities)

Recovered from every entity: base `RLBaseObject.LocString`, `Type` (enum),
seven level handles, `AIUsageType` (`Aggressive/Passive`), `AIPickupTypes`
(derived `AIPickupTypeDamageLevel` / `AIPickupTypeEnemyInRange` /
`AIPickupTypeAheadOfEnemy`), `DoNotRandomise`, `BaseProbability`,
`PositionModifiers`, eight SpecialFX handles, `PickupSpecialFXBeginCycle` /
`EndCycle`, four target/delay FX handles.

Per-entity AI trigger payloads (exact values in the manifest):

| entity | AI usage | triggers |
| --- | --- | --- |
| Repair | Passive | 3× `AIPickupTypeDamageLevel` (health-level selector) |
| Bomb | Aggressive | one empty `AIPickupTrigger` |
| Nitrous | Passive | one empty `AIPickupTrigger` |
| Shunt / Blindfire | Aggressive | 3× `EnemyInRange` with distance/angle adjustments 40/40, 30/30, 20/20 |
| Shock | Aggressive | `EnemyInRange` 50/0, then 2× `AheadOfEnemy` (80/45, 200/20) |
| Barge / Shield | — | no trigger array |
| Fan | Passive | — |
| Stopwatch | Aggressive | — |
| SuperShield | Passive | — |

`Nitrous` is the only entity with `PositionModifiers` (5 rows: positions 1–6 →
0.2, 7–9 → 2.0, 10–12 → 3.0, 13–15 → 2.0, 16–20 → 0.5).

### 4.3 Balance data (`Normal` slot; variants in the manifest)

| entity | balancing type | recovered values (Normal) |
| --- | --- | --- |
| Nitrous | `NitrousBalancingData` | Delay 0, Duration **1.3 s**, DurationCheckpoint 2.5, SlowDownGraphValue 0.5275 / checkpoint 0.45, class modifiers A 1.0, B 0.95, C 0.90, D 0.85; DoubleTap: `LowSpeedBoost 0.03`, `DraftingBoost 0.0001`, Duration 2.5, RiftTime 2.5, RiftRadius 30, RiftMin/MaxForce 500/1500, RiftAngleRange 0.1, AirBrakeCutOff 40; Reversed: Damage 50, Duration 1.2, ForwardDot 0.2, RiftRangeSquared 100 |
| Shock | `ShockBalancingData` | Delay 1.0, InnerRadius 7, OuterRadius 14 (DoubleTap 14.5), Lifetime **1.5 s**, Damage **100**, HeightDiff −1.5 |
| Shunt | `ShuntBalancingData` | Delay 0.5, Radius 0.75, FallRate 1.25, Damage 100, FXDropTime 0.2, ShuntTurnRateScalar 0.3, ECM distances 13/20/25, ECMWarningEnabled true; DoubleTap `ShotDelay 0.5`; Reversed Speed 50, Height 0.2, WarningDistance 70, WarningDot 0.9 |
| Blindfire | `BlindfireBalancingData` | Delay 0.1, Radius 0.2 (Modified 0.4), FallRate 1.0, HeightFromGround 0.3, Speed **300** (Reversed 50), Damage **50**, WarningDistance 100, WarningDot 0.99 |
| Barge | `BargeBalancingData` | Delay 0.2, Radius 7, Damage 100, Duration **0.4 s**, MinMinePushForce 50,000, MinePushForceMultiplier 1,000 |
| Bomb | `BombBalancingData` | Delay 0.2, Radius 1.0, OuterRadius 3.5, Lifespan **60 s**, PlaceBehindDistance 5, Damage **100**, MasterMinePrimeTimer **0.3 s**; DoubleTap radius 2/5, lifespan 3 s; Mini `ThrownBomb` radius 0.5, lifespan 30, Damage 50, throw forces 50k–80k, Y 1.3; Modified `NoMiniMinesToCreate 5`, `TotalSpreadWidth 3`; Reversed `BombReverse` min speed 250, scaled speed 2.5, deceleration 200, lifetime 0.5 |
| Repair | `RepairBalancingData` | Delay 0, **AmountToRepair 400** |
| Shield | `ShieldBalancingData` | Delay 0, Health **50**, Lifetime **6 s** (DoubleTap 12 s) |
| Fan | `FanBalancingData` | **FansToGain 1**, Delay 0 |
| Stopwatch | `StopwatchBalancingData` | **TimeToGain 0.0**, Delay 0 |
| SuperShield | `SuperShieldBalancingData` | Lifetime **10 s**, Health 50, NitroOnStartup true, NitroTargetSpeed 50 mph, BoostDuringUse true, SteeringForwardOffset 2.5, SteeringBoost 1000, AccelerationBoost 1500, BrakingBoost 1500, DownForceBoost 5000, MinimumTriggerValue 0.5, DamagePointsOnImpact 100, IncreaseMassDuringUse true, IncreasedMass 10,000 |

Each level also carries `BalancingGraph` (array of `RLHermiteKeyFrame`:
Time/Value/InTangent/OutTangent) and a `PickupBaseSpecialFX` tree with up to
seven arrays: `PickedUpSpecialFX`, `RoadsweeperedSpecialFX`,
`ChargingSpecialFX`, `FiredSpecialFX`, `HitVehicleSpecialFX`,
`HitVehicleSpecialFXDecoy`, `ShieldedSpecialFX`. Every `PickupSpecialFX` item
has a `SpecialFXLocation` enum (`GroundIcon`, `ActingCar`, `TargetCar`,
`TargetCarFixedOrientation`, `WorldPosition`, `RearWheelPosition`,
`VehicleToMatrix`), four `SpecialFX` handles, and intro/loop/outro durations.
The graph keyframes and FX asset strings are in the manifest per level.

### 4.4 HUD / icon references (`ui.bin`)

`UiXtConfig` record 95 (id 1934272550) has `PerkDisplayParameters` at byte 96
(type `UiPerkDisplayParameters`). The 16 entries use `UIPerkInfo`:

| key | texture_index | fill / glow / text | loc id / past loc id |
| --- | ---: | --- | --- |
| nitrous | 4 | Nitro_Icon / Nitro_Glow / Nitro_Text | `eeb38897` / `b505138e` |
| shock | 3 | Shock_Icon / Shock_Glow / Shock_Text | `e8766375` / `e20a30f1` |
| shunt | 2 | Shunt_Icon / Shunt_Glow / Shunt_Text | `041eb61f` / `2f8b78a0` |
| barge | 1 | Barge_Icon / Barge_Glow / Barge_Text | `73acd70f` / `bab3186b` |
| bomb | 0 | Flash_Icon / Flash_Glow / Flash_Text | `f5478e50` / `63472297` |
| blindfire1/2/3 | 5 / 9 / 6 | Blindfire_Icon / … | `16324275` / `b50fca99` |
| repair | 8 | Repair_Icon / … | `3e17499b` / `63f9012c` |
| shield | 7 | Shield_Icon / … | `82b883fc` / `fabdaa41` |
| superShield | 104 | `!255 153 153 255` / Main_1 | `6340deaf` / `fabdaa41` |
| empty | 5 | Main_Black | `00000000` |
| extra_blindfire1..4 | 103 / 102 / 101 / 100 | Blindfire_Icon family | `16324275` |

The icon sheet name `perk_icons` is present as a string in the same record
(offset 601) but has no typed field binding in this pack. The `Help_Powerups`
screen (record 17) names `perk_sheet` and the icon elements
`Gfx_PowerupsImgIcon{Nitro,Shock,Shunt,Bolt,Mine,Shield,Repair}`; this is
recorded as string evidence, not as a resolved texture binding.

### 4.5 Audio references (`audioentities.bin`)

18 `AudioEntityDef` names map to the pickup classes by name:
`Shock` (40/781427306), `ShockProjectile` (10/190168282), `ShockHit`
(120/2086061546), `Barge` (64/1277914503), `BargeHit` (215/3982820121),
`Bomb` (65/1285085496), `BombProjectile` (112/1946034805), `BombHit`
(136/2478605246), `NitrousHit` (145/2653780993), `Shunt` (165/3049673102),
`ShuntProjectile` (196/3565409508), `ShuntHit` (149/2748494763), `RepairHit`
(185/3442217762), `BlindFire` (189/3494030784), `BlindFireProjectile`
(199/3674726041), `BlindFireHit` (209/3862297026), `Shield` (214/3973355297),
plus the spatializer `PickupPosition` (187/3457019949). The perk audio graph in
record 0/1 contains `Perk*Fire/Hit/Charge/Explode/…` event ports; the graph
wiring and mix are **not** decoded.

---

## 5. Per-mode and per-race settings

### 5.1 Multiplayer (`multiplayer.bin`)

`MultiplayerRace` (84 B) carries the enable/behaviour fields:

| field | offset | recovered meaning |
| --- | ---: | --- |
| `type` | 0 | race type enum (`racing`, `destruction`, `hardcore`, …) |
| `min_players` / `max_players` | 4 / 8 | |
| `powerups` | 36 | `MpPickup` mask: 8 named flags `nitro, shock, barge, mine, shunt, bolt, shield, repair` (bits 0–7 of the 32-bit field) |
| `PickupProbabilities` | 40 | handle to a `PickupProbabilityList`; null in 438/439 races |
| `damage_mode` | 44 | `off / low / medium / high / one_hit` |
| `poweruprespawn` | 68 | `Normal / AlwaysOn / Long / VeryLong / None` |
| `randompowerups` | 72 | `Off / On` |

**439 races** were decoded. Aggregate:

| measure | values |
| --- | --- |
| all 8 flags set (bits 255) | 320 races |
| no power-ups (bits 0) | 72 races |
| per flag | barge 364, nitro 361, repair 361, shield 359, bolt 358, mine 356, shunt 354, shock 325 |
| respawn | Normal 385, None 48, Long 3, AlwaysOn 2, VeryLong 1 |
| random power-ups | Off 428, On 11 |
| damage mode | medium 353, high 82, off 4, low 0, one_hit 0 |
| non-null probability list | 1 (race record 203, id 1363684996 → id 1360266851 → pickups record 279) |

`MultiplayerConfig` (record 586, id 3880964192):

- `powerup_respawn_toggle_long = 5.0 s`, `powerup_respawn_toggle_very_long = 20.0 s`.
- `damage_multiplier_values = {Low 0.5, Medium 1.0, High 2.0}`.
- `defaults` (`CustomRaceDefaults`): racing, 3 laps, 300 s, class B, damage
  `medium`, power-up respawn `Normal`, random power-ups `Off`, AI `Off`.
- `PickupParametersStoredOnline` (record 68, id 534771951):
  `RecoveryTime = 6.0`, `RecoveryTimeSpeedMod = 0.1`.
- 33 `MultiplayerAbility` rows (IronFist, RoadSweeper, Mastermine, ECM,
  SplashDamage, ShieldedBay, Boss… variants) with ability id, slot, icon name,
  value and `OnActivateSpecialFX` count. These are mods that modify power-up
  behaviour; they are listed, not simulated.

### 5.2 Single-player (`singleplayer.bin`)

Each of the **86** `AmaxEvent` records carries:

| field | offset | recovered value |
| --- | ---: | --- |
| `Name` | 12 (base) | event name, e.g. `Boss Battle Part 1/2` |
| `PickupsDoNotRespawn` | 48 | false in all 86 |
| `PickupSpawnLevel` | 52 | 3 in 84, 1 in 2 |
| `PickupDisableTime` | 56 | 0 s in 30, 10 s in 22, 1 s in 18, 4 s in 8, 2 s in 6, 3 s in 2 |
| `PickupProbabilities` | 60 | non-null in 2 events; both resolve to pickups record 737 (id 3634767065) |
| `AIDontGoForPickups` | 64 | true in 1 event |
| `Easy/Medium/Hard.PowerUpDamageModifier` | +88 in each block | 0.0 in 83 events per difficulty, 1.0 in 3 |
| `Easy/Medium/Hard.AIPerkUse` | +64 | empty in all 258 difficulty blocks |
| `Opponents[*].PerkGiftTypes` | inline | empty in all 932 opponent setups |
| `Opponents[*].AlwaysShields` | inline | true in 1 setup |

The two boss events (`Boss Battle Part 1/2`) are the only events that bind a
probability list; that list (pickups record 737) contains Blindfire 1.0,
Bomb 0.653, Shunt 0.493, Shield 0.287, Nitrous 0.157, Shock 0.103, Repair 0.0.

### 5.3 Probability lists and position rows

- **51** `PickupProbabilityList` records. Each item is `(Pickup enum, f32)`.
  Raw sums range **0.0 … 5.0**, so the field is **not** a normalised
  probability; the engine’s weight/normalisation rule is not serialized.
  No value was altered or rescaled.
- **64** `PickupPositionRow` records use the `PickupTypeList` mask
  (`Barge, Bolt, Mine, Nitrous, Repair, Shield, Shock, Shunt`; 8 named bits),
  e.g. `bits=138 → Bolt, Nitrous, Shunt`. These rows are referenced from level
  actor/placement data that is not in these packs; the placement itself is not
  claimed here.

---

## 6. Classification

Every entity is classified **`fully-recovered`**: all serialized fields
of the `PickupType`, every present `PickupLevel`, its `BalancingData`,
`BalancingGraph` and SpecialFX reference tree decode. External
`Particle_Event` / `Light_Object` handles (**133** across the 11 entities) resolve
by 32-bit id to `dynamiceffects.bin`; their payloads are **not** decoded into the
manifest (`externalFxPayloadDecoded: false`), and no handle remains unresolved.

What the shipped data does **not** contain (typed in the manifest and in
`UNKNOWNS` of the rules prototype):

| missing field | status | reason |
| --- | --- | --- |
| charges / ammo | absent-from-schema | no charge/count field exists; only the HUD names `blindfire1..3` and `extra_blindfire1..4` |
| projectile lifetime | not-serialized | Blindfire/Shunt have Speed and Damage but no lifetime |
| human targeting | runtime-only | only AI trigger data is serialized |
| hit test / falloff | runtime-only | Bomb has Radius/OuterRadius but no falloff law; projectile hit volume is code |
| normal respawn seconds | not-serialized | `MpPowerupRespawn.Normal` has no seconds; only Long 5 s and VeryLong 20 s |
| pickup inventory capacity | runtime-only | `NetPlayerVehicle.pickupSlots` is a 16-bit mask; held-item rules are code |
| health scale / max health | runtime-only | Repair `AmountToRepair=400` but no max-health field in these packs |
| shield absorb model | prototype-assumption | this prototype treats `ShieldBalancingData.Health` as shield HP |
| respawn enum semantics | prototype-assumption | AlwaysOn→0 s and None→no respawn are prototype interpretations |
| `Delay` semantics | ambiguous | prototype uses it as the next-use delay |
| `MasterMinePrimeTimer` | ambiguous | prototype uses it as the arming delay |
| `PickupSpawnLevel` / `PickupDisableTime` / `PowerUpDamageModifier` | raw-only | values are recorded; their engine semantics are not verified |
| HUD icon sheet | partial | `perk_icons`/`perk_sheet` are strings without a typed binding |
| loc strings | partial | `LocId` values are raw ids; no loc table in these packs |
| audio graph | partial | entity names/ids recovered; event wiring and mix not decoded |
| pickup placement | not in packs | spawn points are in level/actor data outside these packs |

No unknown was replaced by a guessed value.

---

## 7. Rules prototype

Files:

- `probes/powerups/rules/engine.js` — standalone ESM, no engine, no game data.
- `probes/powerups/rules/tests.mjs` — node unit tests.

It loads `_work/powerups/powerups.json`, fails explicitly when it is missing,
and exposes:

```js
createWorld(manifest, { authorityId, mode, normalRespawnSeconds })
  world.addPlayer(id, { health, maxHealth, inventoryCapacity, position })
  world.spawnPickup(typeLabel, position)
  world.pickup(pickupId, playerId)
  world.use(playerId, { slot, level, targetId, position, checkpoint })
  world.damage(targetId, amount, source)
  world.resolveProjectile(projectileId, targetId)
  world.advance(dtSeconds)
  world.snapshot()
```

All emitted events carry `seq`, `type`, `at`, `authority`. `snapshot()` sorts
players/pickups so the same command sequence yields the same JSON (tested).

Data-driven behaviour:

- pickup → inventory (capacity; rejected second pickup), pickup deactivation
  `0.6 s + mode delay`; Long/VeryLong come from `MultiplayerConfig`, Normal is
  unresolved unless the caller supplies `normalRespawnSeconds`;
- `use` resolves the `Normal` level (or a requested variant) and applies only
  serialized values: Shield/SuperShield lifetime + `Health` capacity, Nitrous
  duration/checkpoint, Repair amount, Bomb radius/outer radius/lifespan/arming
  timer, Shock radii/lifetime/damage, Barge radius/duration/push forces,
  Blindfire/Shunt speed/damage, Fan/Stopwatch amounts;
- hit resolution: mine detonates when a player is inside `OuterRadius`; full
  damage only inside `Radius`; the in-between case emits `mine-near-miss` with a
  typed `falloff: not-serialized` (no invented falloff);
- shield absorbs up to `Health`, emits `shield-absorbed`, then `shield-broken`,
  and passes the remainder to health;
- effects/mines/expiry use the recovered `Lifetime` / `Duration` / `Lifespan`;
- projectile lifetime remains `UNKNOWNS.projectileLifetime`, so projectiles do
  not auto-expire.

Test result (`node probes/powerups/rules/tests.mjs`, 9/9 PASS):

1. manifest exposes 11 types and typed unknowns;
2. **mine hit** — inside `Bomb.Radius`, victim loses `Bomb.DamageInflicted`;
3. **mine miss** — outside `Bomb.OuterRadius`, no damage;
4. **shield absorb** — 50 HP shield absorbs 25, then 25 of a 50 hit, breaks and
   passes 25 to health;
5. **weapon/effect expiry** — Nitrous expires at `Duration` (1.3 s), Shock at
   `Lifetime` (1.5 s);
6. **pickup respawn** — Long = 0.6 + 5.0 s; Normal without a caller value stays
   `respawn-unresolved` (`not-serialized`);
7. inventory capacity + deactivated pickup cannot be re-collected;
8. event sequence/authority;
9. snapshot determinism.

This is a rules prototype driven by recovered numbers, **not** a retail
behaviour claim.

---

## 8. Integration points for e1-drive / multiplayer

### 8.1 Events to synchronise

Canonical event names from the prototype and their retail counterparts in the
existing T-006 wire analysis (`docs/work/analysis/t006-wire-format.md` §3.2):

| prototype event | retail event (where it exists) | sync |
| --- | --- | --- |
| `pickup-spawned` | `PickupDroppedOnTrack` (2) / initial placement | reliable, once |
| `pickup` | `DroppedPickupPickedUp` (1) | reliable |
| `pickup-rejected` | — | local |
| `pickup-respawn` | `SetPowerupRespawnDelay` / respawn | reliable |
| `use` → `shield-activated`, `nitro-activated`, `repaired`, `mine-placed`, `shock-activated`, `barge-activated`, `projectile-fired`, `fans-gained`, `stopwatch-gained` | `PickupFired` (5), `Repaired` (13), `AbilityActivated` (18) | reliable |
| `projectile-hit` | `HitByPickup` (8) / `JudgedPowerupHit` (20) | reliable |
| `mine-detonated` / `mine-near-miss` / `mine-expired` | later `MineMoved`, `MineDestroyedByProjectile`, `PickupKilled` | reliable |
| `shield-absorbed` / `shield-broken` | `ShieldedPickup` (later) | reliable |
| `damage` / `wrecked` | `DamageDealt` (17) + replicated health | reliable for events; health in the vehicle state |
| `effect-expired` | — | derived; may be omitted if both peers tick the same world |
| `respawn-unresolved` | — | local diagnostic only |

Existing network state already reserves `NetPlayerVehicle.pickupSlots` (16 bits),
`shieldSlots` (8 bits) and `additionalHealthPips` (8 bits)
(`docs/work/analysis/net-layout.md` §2). The prototype’s inventory/effect ids
should map onto those slots rather than introduce a second inventory model.

### 8.2 Authority model

- **Host-authoritative** for M1/M2, matching the plan’s “host runs the wasm
  step, broadcasts authoritative state” rule.
- Clients send **intents** (`pickup`, `use`, `resolveProjectile`); the host
  validates against its world (active pickup, inventory, cooldown, shield) and
  emits the canonical event with `seq`.
- Clients apply events in `seq` order and keep a short snapshot buffer. The
  prototype’s `snapshot()` and deterministic event sequence are the reference
  for reconciliation.
- Reliable/ordered channel for pickup/use/hit/shield/respawn events; state
  snapshots at 20–30 Hz. Do not put these events on an unreliable channel until
  the packet budget is measured.
- Late join: send the current pickup states, active mines/effects and inventory
  slots, then replay from the next `seq`.

### 8.3 What must still be recovered before M2

1. Pickup **placement** per track/mode (spawn points, rows, level actor data) —
   recovered by PWR3 for the raced `usa_la_river` route; see §11 and
   `docs/work/analysis/pickup-placement.md`.
2. `Normal` respawn seconds and the exact `AlwaysOn`/`None` semantics.
3. Projectile lifetime, hit volume and line-of-sight rules.
4. Charge/ammo rules (Blindfire levels vs HUD `blindfire1..3`).
5. Human targeting / aim assist (AI trigger data is not a human rule).
6. Damage falloff, explosion occlusion and mine trigger/arming logic.
7. Shield absorb model (`Health` as HP is a prototype assumption).
8. Health scale / max health, wreck/respawn timing.
9. Probability normalisation (weight vs probability) and the RNG seed flow.
10. HUD icon-sheet binding and loc-string resolution.
11. Audio graph wiring/mix for the perk entities.

---

## 9. Evidence and reproduce

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py probes/powerups/tools/build_powerups.py
& $py probes/powerups/tools/verify_powerups.py
node probes/powerups/rules/tests.mjs
```

Artifacts:

| path | content |
| --- | --- |
| `_work/powerups/powerups.json` | 982,981 B, SHA-256 `6ee5a3e6…bc73d7`, content hash `543b059a…c654df` |
| `_work/powerups/verify.json` | 1,783 checks, PASS, failure list empty |
| `_work/powerups/{pickups,multiplayer,ui,audio,dynamiceffects,singleplayer}.xt` | decoded PAK bytes (not committed) |
| `_work/logs/powerups/build-run1.log`, `build-run2.log` | two builds, identical file hash |
| `_work/logs/powerups/verify.log` | verifier output |
| `_work/logs/powerups/rules-tests.log` | 9/9 PASS |
| `probes/powerups/tools/xt_decode.py` | FLSK decoder (SHA-256 recorded in `powerups.json.decoder`) |
| `probes/powerups/tools/build_powerups.py` | manifest builder |
| `probes/powerups/tools/verify_powerups.py` | independent verifier + native schema agreement |
| `probes/powerups/rules/engine.js`, `tests.mjs` | rules prototype + tests |

Determinism: two consecutive builds produce the same `powerups.json` SHA-256
(`6ee5a3e6…bc73d7`); the verifier re-reads the PAK and recomputes
`manifestContent`, so a hand-edited value fails the hash check.

---

## 10. Limits

- **Definitions only.** No pickup placement, race timing, results or full-game
  behaviour is claimed.
- **No retail parity claim.** The rules prototype is an original state machine
  driven by the recovered values; retail hit/miss, charge, respawn and audio
  code were not ported.
- **FX payloads are referenced, not decoded.** External particle/light handles
  are resolved by id to `dynamiceffects.bin`; their inner payload is not in the
  manifest.
- **HUD/audio linkage is name-based.** `pickups.bin` does not serialize a HUD or
  audio reference; the matches are recorded with their basis and are not claimed
  as typed links.
- **Enum integers are not recovered.** Only label indices/labels are serialized;
  the retail integer values are not invented.
- **No e1-drive/asset-reader change.** This task produced data, a prototype and
  this document only.

---

## 11. Pickup placement (PWR3, 7 November 2026)

**Date:** 7 November 2026
**Owner:** PWR3 (sub-agent)
**Scope:** `probes/powerups/**`, `_work/powerups/**`, `_work/logs/powerups/**`,
this section and `docs/work/analysis/pickup-placement.md`. No change to
e1-drive, race-rules, net-mvp, asset-reader, tools, other probes, `upstream/` or
`game-data/`.
**Result:** **54 `PickupPosition` actors** recovered for the raced
`usa_la_river` multiplayer route (record 1643385212, `RouteNumber 3`) through
`MultiplayerRace.route → Route.MultiplayerActorLists → LevelActorList 2512484467`.
Types: Nitrous 7, Shock 3, Shunt 9, Blindfire 12, Barge 7, Bomb 4, Repair 6,
Shield 6. Eight shuffle groups cover 26 placements (one of each allowed type per
`(RowType, RowId)`); 28 placements are fixed-type. All overrides are neutral
(`PickupActiveLevel 1`, zero timers, no shuffle flags).

The retail set is **not on the 310 m collision-only course** (0 within 2.0 m;
nearest 72.80 m). It does cross loop-01: 2 placements are within the 2.0 m
pickup radius (nearest 1.26 m) and 5 within 10 m. The same route's 20-slot
`StartPosition` list sits on loop-01 (0.285–34.50 m), which is why loop-01 is
part of the retail start area while the 310 m spawn is not.

Against the PWR2 provisional 6-slot plan (arcs `[40,90,140,190,240,280]`,
types `[Bomb,Shield,Repair]×2`): **0/6** provisional slots have a recovered
position within 2.0 m; the nearest provisional slot is **73.04 m** from a
recovered placement. The plan stays correctly labelled `provisional` for the
310 m course.

The secondary River route 2942047131 (`RouteNumber 6`) has a 53-placement layout
but is referenced by **0** multiplayer races; it is recorded, not used.

Manifest: `_work/powerups/placements.json` (file
`6458e37aebb84a0df52f9601ce4bc719cfd4624f81c37150c4a4e4f9211bfc05`, canonical
`e5e2e449fed98c4b7a2d83255566978a2fd15bdf8f4b35f159cb0f4f0b2d3607`).
Verifier: **1415/1415 PASS**. Full sources, table, respawn-group semantics,
course projections, provisional diff and the M2/PWR2 integration contract are in
`docs/work/analysis/pickup-placement.md`.

**Limits:** placement data only; no renderer/full-game claim. The retail `.aid`
route arc, `Normal` respawn seconds, runtime RNG order and probability
normalisation remain unrecovered and are typed in the manifest.
