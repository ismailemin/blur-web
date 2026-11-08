# SuperShield — recovered data and online-race integration decision

**Date:** 8 November 2026
**Owner:** SS1 (sub-agent)
**Scope:** `probes/powerups/**`, `_work/powerups/**`, `_work/logs/powerups/**` and this
document. No change to `probes/e1-drive/`, `probes/boost-feasibility/`,
`probes/race-rules/`, `probes/net-mvp/`, `probes/asset-reader/`, `tools/`,
`upstream/` or `game-data/`. Game data is read-only.
**Result:** every serialized SuperShield field is recovered with record/offset/hash
evidence; the activation, absorb, expiry, collision and ram rules are cited to the
extracted retail source; **SuperShield is not selectable by shipped multiplayer
configuration**, but the entity, wire path, FX and HUD entry exist, so it is
**integrable as a project extension** with one explicitly missing multiplayer
enable/spawn rule. A typed model passes **17/17** tests and an independent
verifier passes **571/571** checks. **This is not a full-game or retail-parity
claim.**

---

## 0. TL;DR

| question | answer |
| --- | --- |
| definition | `pickups.bin` `PickupType` record **619**, refId **3093073274**, label **SuperShield** |
| level | `Normal` `PickupLevel` record **523**, refId **2601055738** |
| balance | `SuperShieldBalancingData` at absolute file offset **96048**, 60 B, 15 fields |
| duration | **10.0 s** (`Lifetime`) |
| damage | **100** contact damage (`DamagePointsOnImpact`); the shield itself has no HP cap |
| absorb | **time invulnerability** while `mShieldTime > 0`; `Health=50` is serialized **but unused** |
| collision | blocks impact damage; network impulse zeroed; vehicle weight class forced **Ultra** |
| mass | original mass replaced by **10,000 kg** and reverted on expiry |
| start boost | FakeSpeed `E_FAKE_SPEED_ACCELERATE` to **50 mph (22.352 m/s)** |
| steering/accel/downforce | **1000** at 2.5 m forward / **1500** signed throttle / **5000** down |
| `BrakingBoost` | **1500 serialized but unused**; braking uses `AccelerationBoost` |
| ram cooldown | **1.0 s** per rammer |
| MP enable flag | **none** (`UI::E_Pickup` has 8 values, no SuperShield) |
| SP grant path | **none recovered** (0 `DifficultyPerks` records, 0 `AIPerkUse` entries) |
| wire | `PickupFired` type nibble **10** fits the 4-bit field; `PickupKilled`, `ShieldedPickup`, `DamageDealt` all fit |
| HUD | `superShield` `texture_index` **104**, absolute offset **400664** |
| audio | **no SuperShield audio entity**; the FX-duration message is sent as `Shield`, but no Shield audio object is created for this UID |
| decision | **integrable-project-extension** — missing rule is the MP enable/spawn rule, not the shield runtime |
| manifest | `_work/powerups/supershield.json`, 141,123 B, SHA-256 `f97e34da…010e2`, content hash `f3d34e2c…16b4b` |
| verifier | **571/571 PASS** |
| rules model | **17/17 PASS** |

The earlier “single-player-only” label is **too strong**. SuperShield is not
selectable by the recovered shipped multiplayer selection surface, and the
recovered single-player event data shows no grant path. It is reachable only by a
debug switch (`Perks.SuperShield.ForceAllShieldsToBeSuper`), a hand-authored fixed
`PickupPosition` actor, or a network `PickupFired` event. The data does not show a
shipped single-player grant or placement.

---

## 1. Sources and hashes

All payloads are entries in `game-data/Blur/cache/gamedata.pak` (V2, codec 2
zlib, secure FAT). Nothing was written back.

| source | path | offset | stored / logical | SHA-256 (decoded) |
| --- | --- | ---: | ---: | --- |
| pickup definitions | `\gamedata\xt\pickups.bin` | 22,464,512 | 50,403 / 132,056 | `f8e9ba3d0749dcb2b7b775c25fc1e0ec5c337b4835efa947f0cfe329a4965ed7` |
| multiplayer | `\gamedata\xt\multiplayer.bin` | 22,425,600 | 38,176 / 103,912 | `0dcf60bc5306069c2dfa6a4d89701a27f0e789235a1bcf5f9aa2167d9ef6ab48` |
| single-player | `\gamedata\xt\singleplayer.bin` | 22,550,528 | 28,592 / 120,736 | `14af6d07a0fe6eb84253c794e1473196098eeeed215dd7988a8c387d86d65f19` |
| HUD | `\gamedata\xt\ui.bin` | 22,589,440 | 249,271 / 1,004,480 | `e7fd10138524b7e0912561a797cd037a3a6d82b0859750f74ebf8f8ea9f67691` |
| audio | `\gamedata\xt\audioentities.bin` | 21,354,496 | 369,013 / 592,392 | `a7ef1c0416fc335eb72a379da2e771ddaa91c4ca08757f9f5f61327cf422b785` |

The runtime citations are from the read-only extracted reference tree
`_work/engine-vehicle-spike/tree/` (not shipped data, not modified):

| file | SHA-256 (prefix) | used for |
| --- | --- | --- |
| `.../Pickups/Normal/PickupSuperShield.cpp` | `f268f7d4…f99a7` | activation, mass, nitro, boosts, expiry |
| `.../Pickups/Normal/PickupSuperShield.h` | — | class shape |
| `.../Components/VehicleLogic/VLC_Pickups.cpp` | `7ac0b01c…6d69` | absorb gate, ram, cooldown, creation case |
| `.../Components/VehicleLogic/VLC_Damage.cpp` | `d1330a62…66cbc` | impact damage suppression |
| `.../Multiplayer/VLC_Network_Damage.cpp` | `7406e3e8…0b356` | network impulse zero |
| `.../Layers/RaceLogicLayer.cpp` | `0c97dbfc…2062c` | Ultra weight class |
| `.../Pickups/PickupsManager.cpp` | `5a694e06…77db9` | pool create, `PickupKilled`, `PickupFired` |
| `.../ActorStudioActors/PickupPositionActor.cpp` | `27c52c32…7c7c` | hard random exclusion |
| `.../PlayMode/Playlist.cpp` | `83d4969c…11136` | 8-entry MP probability table |
| `.../Multiplayer/MultiplayerDefines.h` | `4f1f4c1d…b963` | `UI::E_Pickup` 8 values |
| `.../GameData/MultiplayerData.h/.cpp` | `9e9001ed…a928` / `a94b9329…4d85` | `XtFlags<XtU16,E_Pickup>` and 8 flags |
| `.../GameData/GameVehicleData.cpp` | — | `AmaxVehicle.ShieldSizeModifier` FX multiplier |
| `.../RaceLogicCore/Data/RLEnums.h` | `4d821e7f…94f` | `E_PICKUP_TYPE` ordinal 10 |
| `.../Structures/NetEventManager.cpp` | `ecf228b1…1d31` | 4-bit type nibble, U8/S16 fields |
| `.../Ui/game/Gadgets/Hud/UIPerks2.cpp` | `21e226a5…cd7` | HUD type mapping |
| `.../RaceLogicCore/Database/RLDatabase.h` | `58b1b3af…1265` | balance struct and damage override |
| `.../GameAudio/PickupSubSystem.cpp` | `fc2474eb…194b` | no SuperShield audio slot |
| `.../Pickups/PickupBase.cpp` | `a2c8a45f…52d2` | `AlwaysShields` spawns normal Shield |
| `.../Pickups/Normal/PickupShield.cpp` | `167f253d…9fa` | normal Shield uses `Health` |

Every exact line and text is stored in
`_work/powerups/supershield.json.sourceCode.citations[]`; the verifier re-hashes
each file and re-reads every cited line.

---

## 2. Recovered fields (exact)

### 2.1 Entity

`PickupType` record **619**, refId **3093073274**, payload absolute offset
**105,380**, payload 120 B, component table offset 0.

| field | field offset | absolute | recovered value | status |
| --- | ---: | ---: | --- | --- |
| `Type` | 4 | 105,384 | `SuperShield` (label index 10) | serialized |
| `Normal` handle | 8 | 105,388 | ref index 553 → refId 2601055738, record 523 | serialized |
| `DoubleTap`…`ReversedModified` | 12–32 | 105,392–105,412 | all null | serialized-null |
| `AIUsageType` | 36 | 105,416 | `Passive` (label index 1) | serialized |
| `AIPickupTypes` | 40 | 105,420 | empty array | serialized |
| `DoNotRandomise` | 48 | 105,428 | `false` | serialized |
| `BaseProbability` | 52 | 105,432 | **0.0** | serialized |
| `PositionModifiers` | 56 | 105,436 | empty array | serialized |
| `PickupSpecialFX` | 64 | 105,444 | ref index 79 | serialized |
| `PickupSpecialFXDecoy` | 92 | 105,472 | ref index 58 | serialized |
| cycle begin / end | 96 / 100 | 105,476 / 105,480 | 0.0 / 20.0 | serialized |
| firing / AI / target FX | 104–116 | 105,484–105,496 | all null | serialized-null |

Only the `Normal` level exists.

### 2.2 Level and balance

`PickupLevel` record **523**, refId **2601055738**, payload absolute offset
**96,028**, payload 460 B.

| component | type | count | payload offset | size |
| ---: | --- | ---: | ---: | ---: |
| 0 | `PickupLevel` | 1 | 0 | 20 |
| 1 | **`SuperShieldBalancingData`** | 1 | **20** | **60** |
| 2 | `PickupShieldSpecialFX` | 1 | 80 | 72 |
| 3 | `PickupSpecialFX` | 7 | 152 | 44 |

`BalancingData` pointer at level payload offset **12** = component 1, element 0.
The balance struct absolute offset is **96,048** (payload 96,028 + 20).

| field | struct offset | payload offset | absolute | atom | value | status |
| --- | ---: | ---: | ---: | --- | ---: | --- |
| `Delay` | 0 | 20 | 96,048 | f32 | 0.0 | serialized |
| `Health` | 4 | 24 | 96,052 | f32 | **50.0** | **serialized-unused** |
| `Lifetime` | 8 | 28 | 96,056 | f32 | **10.0** | serialized |
| `NitroOnStartup` | 12 | 32 | 96,060 | bool | **true** | serialized |
| `NitroTargetSpeedInMPH` | 16 | 36 | 96,064 | f32 | **50.0** | serialized |
| `BoostDuringUse` | 20 | 40 | 96,068 | bool | **true** | serialized |
| `SteeringForwardOffset` | 24 | 44 | 96,072 | f32 | **2.5** | serialized |
| `SteeringBoost` | 28 | 48 | 96,076 | f32 | **1000.0** | serialized |
| `AccelerationBoost` | 32 | 52 | 96,080 | f32 | **1500.0** | serialized |
| `BrakingBoost` | 36 | 56 | 96,084 | f32 | **1500.0** | **serialized-unused** |
| `DownForceBoost` | 40 | 60 | 96,088 | f32 | **5000.0** | serialized |
| `MinimumTriggerValue` | 44 | 64 | 96,092 | f32 | **0.5** | serialized |
| `DamagePointsOnImpact` | 48 | 68 | 96,096 | i32 | **100** | serialized |
| `IncreaseMassDuringUse` | 52 | 72 | 96,100 | bool | **true** | serialized |
| `IncreasedMass` | 56 | 76 | 96,104 | i32 | **10000** | serialized |

`RLSuperShieldBalancingData` overrides `GetDamageInflicted()` to return
`mDamagePointsOnImpact` (`RLDatabase.h:490-492`). `Health` is not read anywhere
in `PickupSuperShield.cpp`; only the **normal** Shield uses `mHealth`
(`PickupShield.cpp:69`). `BrakingBoost` is declared and bound in the schema but
never read by `C_PickupSuperShield`; braking uses `AccelerationBoost` with a
negative throttle (`PickupSuperShield.cpp:291-299`).

### 2.3 FX

`PickupShieldSpecialFX` (component 2) and the seven `PickupSpecialFX` arrays
(component 3) are fully decoded in `supershield.json.fx`. Key rows:

| slot | location | assets | intro / loop / outro |
| --- | --- | --- | --- |
| `PickedUpSpecialFX` | `ActingCar` | `shieldengulf1.cycle`, `models/Perks/shieldengulf1.model` | 0→2.0 / — / — |
| `RoadsweeperedSpecialFX` ×2 | `VehicleToMatrix`, `ActingCar` | `RoadSweeper_Shield_Rotate`, `RoadSweeper_Shield_NoRotate` | 0→1.0 / — / — |
| `HitVehicleSpecialFX` | `ActingCar` | `BatteringRamKhan.cycle/.model`, `E_ParticleSpawn` | 0→2.0 / — / — |
| `HitVehicleSpecialFXDecoy` | `TargetCar` | `ShieldSuperPickupDecoyHit.cycle/.model` | 0→4.0 / — / — |
| `ShieldDomeSpecialFX` | `ActingCar` | `animations\Perks\ShieldSuper.cycle`, `ShieldSuperBumper.cycle`, `ShieldSuper.model`, `ShieldSuperBumper.model` | 0→2.0 / 2.0→5.0 / 5.1→5.9 |
| `ShieldedBoostersSpecialFX` | `TargetCar` | `ShieldedBoosters.cycle/.model` | 0→2.0 / — / — |

SpecialFX record ids (32-bit, exact handles in the manifest):

| slot | refIds |
| --- | --- |
| `PickedUpSpecialFX` | 4159880818 |
| `RoadsweeperedSpecialFX` | 266886103, 781172752 |
| `HitVehicleSpecialFX` | 3892023436, 2906748773 |
| `HitVehicleSpecialFXDecoy` | 1003789732, 2224230936 |
| `ShieldDomeSpecialFX` | 1940843203, 1560296124, 3414821659, 1073336203 |
| `ShieldedBoostersSpecialFX` | 355905587, 2118965165 |

External `Particle_Event` handles: **306038824** → record 67, **1460198147** →
record 381, **1109388832** → record 275 in `dynamiceffects.bin`. Their payloads
are not decoded.

`ChargingSpecialFX`, `FiredSpecialFX` and `ShieldedSpecialFX` are empty.
17 asset strings and 3 external `Particle_Event` handles resolve by 32-bit id to
`dynamiceffects.bin`; payloads are not decoded here.

**Shield multiplier:** `pickups.bin` has no SuperShield “shield multiplier”
field. The FX scale is runtime `g_SuperShieldScale = (1.0, 1.25, 0.47)` times the
vehicle extents times the per-vehicle `AmaxVehicle.ShieldSizeModifier`
(`PickupSuperShield.cpp:88-90`; field declared/bound in
`GameVehicleData.h:257` / `GameVehicleData.cpp:156`). The vehicle field is
vehicle data, not part of the SuperShield balancing record. The local bumper
offset is the runtime vector `(0, -0.65, 1.0)` (`PickupSuperShield.cpp:20`).

### 2.4 HUD

`ui.bin` `UiXtConfig` record **95**, refId **1934272550**,
`PerkDisplayParameters` at field offset **96**; `superShield` entry at entry
offset **240**, absolute **400,664**, 24 B.

| field | absolute | value |
| --- | ---: | --- |
| `texture_index` | 400,664 | **104** |
| `colour_fill` | 400,668 | `!255 153 153 255` |
| `colour_glow` | 400,672 | `!255 153 153 255` |
| `colour_text` | 400,676 | `Main_1` |
| `loc_id_name` | 400,680 | `6340deaf` |
| `past_loc_id_name` | 400,684 | `fabdaa41` |

`perk_icons` is present as a string at string offset 601 but has no typed sheet
binding in this pack. Unlike Fan/Stopwatch, SuperShield **does** have a HUD entry.

### 2.5 Audio

There is **no** `SuperShield` `AudioEntityDef` (228 entities checked; only
`Shield`, record 214, refId 3973355297). `PickUpSubsystem.cpp:1608-1636` fills
`gAudioPickupString` only for the eight `UI::E_Pickup` types, so index 10 is
empty and `CreatePickup` takes the `if(pickupEntityDefinition[ePickupType])`
guard (`:1664`) with no entity. `PickupSuperShield.cpp:104` sends the FX-duration
envelope as `E_PICKUP_TYPE_SHIELD`, but no Shield audio object is created for
this UID. Audio is therefore **unwired**, not “reused”.

---

## 3. Why SuperShield is not in the retail multiplayer race

The shipped data proves six independent restrictions:

1. **UI enum has eight values.** `enum E_Pickup { Nitro, Shock, Barge, Mine,
   Shunt, Bolt, Shield, Repair, Max }` (`MultiplayerDefines.h:63-75`). There is
   no SuperShield value.
2. **The race flag field is typed to that enum.**
   `MultiplayerRace.powerups` is `XtFlags<XtU16, UI::E_Pickup>`
   (`MultiplayerData.h:42`); `MultiplayerData.cpp:447-454` binds exactly eight
   flags (`nitro, shock, barge, mine, shunt, bolt, shield, repair`).
3. **The MP probability table is built in an 8-iteration loop.**
   `for(int i = 0; i < UI::E_Pickup_Max; i++)` pushes one
   `LevelPickupProbability` per UI pickup (`Playlist.cpp:285-298`). A ninth type
   is never added, so `mPickupProbabilities` cannot contain SuperShield.
4. **Random selection hard-excludes it.**
   `PickupPositionActor::SetRandomPickupType` sets `ignore = true` for
   `E_PICKUP_TYPE_SUPER_SHIELD` (`PickupPositionActor.cpp:1094`), the same as
   Stopwatch and Fan. This applies to single-player and multiplayer random
   placement. `BaseProbability` is also **0.0** (entity field 52).
5. **The only probability list that names it is all zero.**
   `pickups.bin` record **279** (refId **1360266851**) has 10 items, including
   `SuperShield = 0.0`; the whole list sums to **0.0**. It is referenced by
   `MultiplayerRace` record **203** (refId **1363684996**, type `hardcore`,
   `powerups` bits **0**), the only race with a non-null list. A zeroed list on a
   race with no power-up flags cannot spawn anything.
6. **`PickupTypeList` has eight bits.** `Barge, Bolt, Mine, Nitrous, Repair,
   Shield, Shock, Shunt` (`pickups.bin` type `PickupTypeList`); there is no
   SuperShield bit, so the fixed/shuffle row path cannot select it either.

### 3.1 No recovered single-player grant path

The recovered single-player event/difficulty data has **no** SuperShield grant:

- 86 `AmaxEvent` records; **0** `DifficultyPerks` records (the type exists in the
  schema but no record uses it).
- **0** `AIPerkUse` entries across all 258 difficulty blocks.
- The one `AlwaysShields` opponent (Boss Battle Part 1, opponent 3) makes
  `PickupBase::RegisterHit` spawn a **normal Shield** on hit
  (`PickupBase.cpp:238-243`), not a SuperShield.
- The two boss events bind list **737**, which has seven items and **no**
  SuperShield.
- The recovered raced placement sets (River 54, Amboy 135, Gracia 144 = 333)
  contain **0** SuperShield placements.

So the correct classification is **“not selectable by the recovered shipped
selection surfaces”**, not “single-player-only”. The entity is reachable only
through:

- the debug switch `Perks.SuperShield.ForceAllShieldsToBeSuper`, which rewrites a
  normal Shield creation to SuperShield (`PickupsManager.cpp:294-298`);
- a hand-authored fixed `PickupPosition` actor whose serialized type is
  SuperShield (none in the recovered raced sets);
- a network `PickupFired` event with type 10 (the retail wire supports it).

---

## 4. Runtime rules (cited, not guessed)

### 4.1 Activation

`C_PickupSuperShield` (`PickupSuperShield.cpp:26-74`):

1. If the actor already has `mSuperShield`, the new pickup kills itself with
   `E_PICKUP_CAUSE_OF_DEATH_REPLACED` and **does not refresh** the timer
   (`:48-52`). Activation while active is a no-op, not a stack/refresh.
2. Otherwise `mShieldTime = Lifetime` (**10 s**) and `mSuperShield = true`
   (`:54-55`).
3. The original body mass is stored; if `IncreaseMassDuringUse`, mass is set to
   **10,000 kg** (`:61-67`).
4. If `NitroOnStartup`, `FakeSpeed.Start(E_FAKE_SPEED_ACCELERATE, 50 mph)`
   (`:69-73`). This is a runtime FakeSpeed effect, not a serialized force.
5. `ShieldDomeSpecialFX` is started with the vehicle extents, a runtime scale
   `(1.0, 1.25, 0.47)` and local bumper offset `(0, -0.65, 1.0)`
   (`:19-20,78-100`).

### 4.2 Absorb

`C_VehicleComponent_Pickups::AttemptHitByPickup` (`VLC_Pickups.cpp:1625-1637`):

```text
timeShielded = pActor->mShieldTime;
if (timeShielded > 0 && pickupType != E_PICKUP_TYPE_NITROUS)
    RegisterShieldedPickup(...);      // no damage
else
    RegisterHitByPickup(...);         // normal damage
```

- The shield is **time-based**, not HP-based. `mShieldHealth` is never set by
  `C_PickupSuperShield`; the comment “Shield no longer takes damage” and the
  Shock-only `mShieldHealth` subtraction are in `VLC_Pickups.cpp:1613-1615`.
- A hit is fully absorbed with no shield depletion. `Health=50` is **not** a
  damage cap.
- **Nitrous is excluded** from the absorb gate. The model does not convert a
  Nitrous hit into damage; it emits a typed bypass.
- The shield does not expire on a hit; only `Lifetime` expiry clears it.

### 4.3 Collision

- While `mShieldTime > 0`, `HandleImpact` skips the impact-damage path
  (`VLC_Damage.cpp:1744`); the network path zeroes the gameplay impulse
  (`VLC_Network_Damage.cpp:142-152`).
- The shield owner is treated as `AmaxVehicleWeight_Ultra` in collision mass
  scaling (`RaceLogicLayer.cpp:1805-1809`).
- The body mass is 10,000 kg until expiry, then the stored original is restored
  (`PickupSuperShield.cpp:192`).

### 4.4 Ram / contact damage

`C_VehicleComponent_Pickups::OnMessage` `E_GameLogicMessage_GameplayImpact`
(`VLC_Pickups.cpp:2277-2343`):

- Condition: the **other** vehicle has an active shield, the receiving vehicle
  does not, and `mHitByDoubleShieldCooldown <= 0` (`:2298`).
- If the other is a SuperShield, the level is `SuperShield.Normal` and the
  receiving vehicle is force-damaged by `GetDamageInflicted()` = **100**
  (`:2334-2337`).
- The receiving vehicle also gets `E_FAKE_PHYSICS_JINK_SHIELD_LEFT/RIGHT`
  (`:2320-2329`), chosen by the sign of the dot between the rammer→shield vector
  and the rammer's local left axis.
- The cooldown is `Perks.DoubleShield.Cooldown` = **1.0 s** (`:115`), stored on
  the receiving vehicle. The shield is **not** consumed.
- If both vehicles are shielded, no damage and no cooldown are applied.
- The **damage cap for one contact is 100** (`DamagePointsOnImpact`). There is no
  falloff or distance term in this path.

### 4.5 Boosts

`ApplyAssortedBoosts` (`PickupSuperShield.cpp:203-311`) runs only for the local
player (`VehicleIsLocal` at `:166-174`) and only when `BoostDuringUse` is true:

| effect | value / formula | source |
| --- | --- | --- |
| steering | `left * steeringInput * 1000`, applied at `forward * 2.5 m` from center | `:276-287` |
| acceleration / brake | `forward * 1500 * throttleInput`; throttle is negative for brake | `:291-299` |
| downforce | `-up * 5000` | `:303-311` |
| trigger normalisation | `input > 0.5 ? (input-0.5)/0.5 : 0` | `:254-272` |

`BrakingBoost` is never read; `AccelerationBoost` is used for both directions.
The model emits the impulse vectors but does not integrate them; that is engine
physics.

### 4.6 Expiry

Every frame `mShieldTime -= frameTime`; at `<= 0` the mass is reverted and
`mSuperShield` is cleared (`PickupSuperShield.cpp:182-195`). The pickup object is
removed; in a network game `PickupsManager::Update` sends `PickupKilled` for
`E_PICKUP_TYPE_SUPER_SHIELD` when it is not a ninja kill
(`PickupsManager.cpp:216-228`).

---

## 5. Decision

**`integrable-project-extension` (provisional).**

The shield runtime is not missing a rule. The missing piece is a **shipped
multiplayer enable/spawn surface**:

| missing piece | status | consequence |
| --- | --- | --- |
| MP enable bit / UI toggle | absent-from-schema | project must define one outside `UI::E_Pickup` (provisional) |
| SP/MP spawn placement | not in recovered raced data | project must choose where it spawns (provisional) |
| original vehicle mass | runtime engine data | caller must supply `massKg` at activation |
| boost impulse integration | runtime physics | host emits owner-local impulses; no physics claim |
| FakeSpeed nitro | runtime-only | event only (`E_FAKE_SPEED_ACCELERATE`, 50 mph) |
| audio entity | absent | add one or explicitly reuse Shield (provisional) |
| HUD icon sheet binding | partial | `texture_index=104` is recovered; sheet binding remains string-only |

What is **not** missing:

- the `PickupType`/`PickupLevel`/balance data and FX tree;
- the HUD `superShield` entry;
- absorb/expire/ram/collision rules;
- a wire path: `PickupFired` packs the type into a 4-bit nibble
  (`NetEventManager.cpp:193`), type 10 fits; `PickupKilled` is already sent for
  SuperShield (`PickupsManager.cpp:224`); `ShieldedPickup` carries the incoming
  type as a U8 (`NetEventManager.cpp:483`); `DamageDealt` is S16
  (`:533`); `CreatePickup` has the SuperShield pool/case and sends
  `Add_PickupFired` (`PickupsManager.cpp:509-514,530-535`).

**No e1-drive or 8-type slice change is required for this task.** The model and
manifest are data/rules only.

---

## 6. Rules model and tests

Files:

- `probes/powerups/rules/supershield.js` — typed model, no engine, no game data.
- `probes/powerups/rules/supershield.test.mjs` — 17 unit tests.
- `_work/powerups/supershield.json` — data/provenance manifest.

API:

```js
const world = createSuperShieldModel(manifest, { authorityId: 'host-A' });

world.addCar(id, { health, maxHealth, massKg, position });
world.activate(ownerId, { pickupId, massKg, provisionalAbsorbCap });
world.hit(targetId, amount, { pickupType });
world.absorb(ownerId, amount, { pickupType });
world.ram(ownerId, rammerId, { relativeDotLeft });
world.applyBoosts(ownerId, { steeringInput, throttleInput, brakeInput, axes });
world.advance(dt);
world.snapshot();
```

Behaviour:

- `activate` requires the original mass (typed rejection otherwise), sets
  `massKg = 10000`, `remainingSeconds = 10`, emits `supershield-activated` with
  the serialized values and the unused `Health`/`BrakingBoost` statuses.
- `hit` on an active shield absorbs the full amount and leaves health unchanged;
  `absorb` has no cap by default. An optional `provisionalAbsorbCap` is a
  **project extension**, labelled `provisional:true`, that absorbs up to the cap,
  leaks the remainder and expires with `reason:'provisional-damage-cap'`.
- `hit` with `pickupType:'Nitrous'` bypasses the shield (typed event, no damage).
- `ram` requires `relativeDotLeft`; without it the model refuses rather than
  inventing a side. It applies exactly `DamagePointsOnImpact` (100), sets a 1.0 s
  per-rammer cooldown, and ignores the ram if both cars are shielded.
- `applyBoosts` uses `AccelerationBoost` for brake as well (BrakingBoost unused);
  the trigger threshold is 0.5; the steering application point is 2.5 m forward.
- `advance` expires at 10 s, reverts mass and emits `supershield-expired`.
- All events carry `seq`, `type`, `at`, `authority`; `snapshot()` sorts cars and
  shields and is deterministic.

Test result (`node probes/powerups/rules/supershield.test.mjs`, **17/17 PASS**):

1. manifest integrity and `Health`/`BrakingBoost` statuses;
2. activation: lifetime, 1600→10000 kg, Ultra, 50 mph→22.352 m/s, HUD, audio;
3. absorb 1000: full absorb, health unchanged, cap null;
4. absorb + expiry: mass revert, post-expiry damage passes;
5. activation while active: replaced, no refresh;
6. missing original mass: typed rejection;
7. Nitrous bypass;
8. ram damage cap 100 and jink side from caller dot;
9. ram cooldown 1.0 s then damage again;
10. both shielded: no damage, no cooldown;
11. ram without dot: refused;
12. boost impulses: 500 steering, 1500 acceleration, −5000 downforce, 2.5 m point;
13. trigger normalisation 0.5/0.75/brake;
14. `BrakingBoost` unused even when mutated to 9999;
15. provisional absorb cap 150: 100 + 50, 50 leak, expiry, `provisional:true`;
16. event seq/authority and snapshot determinism;
17. post-expiry damage and fresh reactivation.

`Health=50` is never used as a damage cap. The model’s `damageCap` is the
**contact** `DamagePointsOnImpact=100`, which is what the retail source applies.

---

## 7. Host event contract

Authority: **host**. Clients send intents; they do not judge absorb, ram, expiry
or inventory. Channel: reliable/ordered for state-changing events; snapshots at
20–30 Hz for late join/reconciliation.

| event | minimum payload | sync |
| --- | --- | --- |
| `supershield-spawned` | `seq, authority, pickupId, pickupType, typeId=3093073274, position, level, spawnSource` | reliable, once |
| `supershield-activated` | `seq, authority, pickupId, ownerId, at, lifetimeSeconds, massKgBefore, massActiveKg, weightClass, nitro, boosts, absorbModel, healthField, hud, audio, level, wireTypeNibble=10` | reliable, once |
| `supershield-absorbed` | `seq, authority, ownerId, sourcePickupType, attemptedDamage, absorbedDamage, leakedDamage, shieldRemainingSeconds, healthUnchanged, absorbModel, cap, provisional` | reliable |
| `supershield-rammed` | `seq, authority, ownerId, rammerId, damage=100, damageCap=100, jink, cooldownSeconds=1.0, shieldRemainingSeconds` | reliable |
| `supershield-ram-ignored` | `seq, authority, ownerId, rammerId, reason, cooldownRemainingSeconds?` | local diagnostic |
| `supershield-expired` | `seq, authority, ownerId, at, reason, lifetimeSeconds, massKgRevertedTo, absorbedTotal` | reliable, once |
| `supershield-replaced` | `seq, authority, ownerId, pickupId, reason='already-active', refreshed=false, remainingSeconds` | reliable, once |
| `supershield-boost-applied` | `seq, authority, ownerId, steeringImpulse, accelerationImpulse, downForceImpulse, steeringApplicationPoint, throttleNormalised, brakeNormalised` | owner-local; not replicated state |
| `supershield-rejected` | `seq, authority, ownerId, reason, missing` | local diagnostic |

Wire mapping:

- spawn: `PickupDroppedOnTrack` (type U8 = 10) for project-dropped pickups; level
  actor data for fixed placements;
- activate: `PickupFired` (type nibble 10, subtype 0);
- absorb: `ShieldedPickup` (incoming pickup type U8) plus authoritative shield
  state;
- ram: `DamageDealt` (S16 = 100);
- expire: `PickupKilled` (pickup UID) or an authoritative shield-state snapshot;
- late join: active shields with `remainingSeconds`, `massKgBefore`,
  `massActiveKg`, and the next `seq`.

---

## 8. Evidence and reproduce

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/powerups/tools/build_supershield.py
& $py probes/powerups/tools/verify_supershield.py
node probes/powerups/rules/supershield.test.mjs
node probes/powerups/rules/tests.mjs            # existing PWR1 9/9
node probes/powerups/rules/projectiles.test.mjs # existing PWR4 19/19
& $py probes/powerups/tools/verify_powerups.py  # existing 1,783 PASS
& $py tools/verify_asset_probe.py --skip-build  # 44/45, known external failure
```

Artifacts:

| path | content |
| --- | --- |
| `_work/powerups/supershield.json` | 141,123 B, file SHA-256 `f97e34dac5cd5abe94b74a694e531859fb3dd9e186284831fa6cb77707d010e2`, content hash `f3d34e2c9cfc7cc843ad900f1c70b5ba82dfbfce4f85264515ce3b97df716b4b` |
| `_work/powerups/supershield.verify.json` | 571 checks, PASS, failure list empty |
| `_work/logs/powerups/ss1-build-run1.log`, `ss1-build-run2.log` | two builds, identical file hash |
| `_work/logs/powerups/ss1-verify.log` | 571/571 PASS |
| `_work/logs/powerups/ss1-rules-tests.log` | 17/17 PASS |
| `_work/logs/powerups/ss1-suite.log` | 44/45, only `prop-collision-v2` fails (pre-existing whole-file geometry pin) |
| `probes/powerups/tools/build_supershield.py` | manifest builder |
| `probes/powerups/tools/verify_supershield.py` | independent direct-offset verifier |
| `probes/powerups/rules/supershield.js` | typed model |
| `probes/powerups/rules/supershield.test.mjs` | 17 tests |

Determinism: two consecutive builds produce the identical file SHA-256
`f97e34da…010e2`. The existing `powerups.json` remains
`6ee5a3e699187086665b4b5330abcda29859e77b4464edae65e6ed00b7bc73d7` (content
`543b059ab7bc511cc61947ba584ff461f8f54b86ea02c06fbd2538f5d2c654df`) and its
verifier remains **1,783/1,783 PASS**.

The suite result is **44/45**; all power-up checks pass
(`powerups-definitions`, `powerups-rules`, `powerups-model`, `projectiles`,
`projectile-rules`, `boost-model`). The single failure is the known
`prop-collision-v2` whole-file `geometry.json` pin, already documented in
`docs/work/verification/T-007-vehicle-batch1.md` §6.1 (input drifted after the
additive car batch; V1 collider replay is identical). It is unrelated to this
task.

---

## 9. Limits

- **Data and a rules/event prototype only.** No e1-drive, renderer, GPU, audio
  mixer or full-game claim.
- **Not a retail multiplayer feature.** The shipped selection surface cannot
  choose SuperShield; the integration is a project extension, explicitly
  `provisional`.
- **No retail parity for physics.** Boost impulses, FakeSpeed nitro, collision
  inertia and jink magnitude are runtime engine behaviour; the model emits
  events, not simulated motion.
- **`Health=50` is not a shield HP cap.** It is serialized but unused by
  `C_PickupSuperShield`; the model keeps it typed as `serialized-unused`.
- **`BrakingBoost=1500` is not a braking model.** It is serialized but unused;
  braking uses `AccelerationBoost`.
- **Audio is unwired.** No `SuperShield` entity; the FX-duration message uses
  the Shield type, but no Shield audio object is created for the SuperShield UID.
- **HUD sheet binding is partial.** `texture_index=104` is recovered; the
  `perk_icons` sheet is string-only.
- **No invented placement or MP bit.** 0 of 333 recovered raced placements name
  SuperShield; no enable bit was added to the 8-type slice.
- **Reference source is `_work/`.** The runtime citations are from the read-only
  extracted tree, not from `upstream/` or committed retail source.
