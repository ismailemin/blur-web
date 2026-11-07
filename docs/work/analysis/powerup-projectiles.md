# Power-up projectiles and impulse rules — Blindfire/Bolt, Shunt, Barge, Shock

**Date:** 7 November 2026
**Owner:** PWR4 (sub-agent)
**Scope:** `probes/powerups/**`, `_work/powerups/**`, `_work/logs/powerups/**` and this
document. No change to `probes/e1-drive/`, `probes/boost-feasibility/`,
`probes/race-rules/`, `probes/net-mvp/`, `probes/asset-reader/`, `tools/`,
`upstream/` or `game-data/`. Game data is read-only.
**Result:** the remaining **serialized** projectile/weapon data is recovered, a
previously unreported **`PerkForceEffects`** table is decoded, the runtime
lifetime/charge/targeting/hit-test rules are cited to the extracted retail
source, and a typed rules model reproduces fire → travel → hit/miss →
damage/impulse → expire with **19/19** unit tests. **This is not a retail-parity
or full-game claim.**

---

## 0. TL;DR

| type | serialized (XT) | runtime/script | classification |
| --- | --- | --- | --- |
| **Blindfire / Bolt** | `Speed 300`, `Radius 0.2`, `Damage 50`, `FallRate 1.0`, `HeightFromGround 0.3`, `Health 50`, `WarningDistance 100`, `WarningDot 0.99` | lifetime **10 s**, charges **3**, forward/no homing, sphere 0.2 + swept ray, ground ray | **partial-runtime** |
| **Shunt** | `Radius 0.75`, `Damage 100`, `Health 100`, `FallRate 1.25`, `FXDropTime 0.2`, `ShuntTurnRateScalar 0.3`, `ECM 13/20/25` | lifetime **40 s**, initial speed `max(forward+15,10)` clamped 60–110, homing 0.3–1.0 × 50 + target speed, target rule 500 m / cos 45°, sphere 0.75 | **partial-runtime** |
| **Barge** | `Radius 7.0`, `Damage 100`, `Duration 0.4`, `MinMinePushForce 50000`, `MinePushForceMultiplier 1000` | radius +0.5 = **7.5 m**, inner band **2.0 m**, extents fudge **1.75 m**, fake-physics **JINK**, no linear impulse | **partial-runtime** |
| **Shock** | base `InnerRadius 7`, `OuterRadius 14`, `Lifetime 1.5`, `Damage 100`, `HeightDiff −1.5` | **3 domes**, actual radius `width × sizeMultiplier × base`, width 0.1–0.8, placement on target spline, lifetime `1.5 + distMod`, **always MINOR → 50 damage** | **partial-runtime** |

The single most important correction to the earlier power-up document: **Shock
does not apply 100 damage.** `C_PickupShock::Update` sets `hitType` to
`E_PICKUP_HIT_TYPE_MINOR` (the inner-radius branch is commented out), and
`VLC_Damage.cpp:2296-2299` halves Shunt/Shock minor damage. The applied Shock
damage is **50**; the serialized `DamageInflicted = 100` is the base value.

The second new finding: **`PerkForceEffects`** in `pickups.bin` record 821 is a
real, referenced table of 9 `ForceEffect` entries. It is the dynamic-object
impulse table used by Shunt, Blindfire, Barge, Shock and the mine. It does not
contain vehicle impulses.

---

## 1. Sources and hashes

All game payloads are entries inside `game-data/Blur/cache/gamedata.pak` (V2,
codec 2 zlib, secure FAT). Nothing was extracted into `upstream/` or written back.

| source | PAK path | offset | stored / logical | SHA-256 (decoded) |
| --- | --- | ---: | ---: | --- |
| pickup definitions | `\gamedata\xt\pickups.bin` | 22,464,512 | 50,403 / 132,056 | `f8e9ba3d0749dcb2b7b775c25fc1e0ec5c337b4835efa947f0cfe329a4965ed7` |
| HUD icons | `\gamedata\xt\ui.bin` | 22,589,440 | 249,271 / 1,004,480 | `e7fd10138524b7e0912561a797cd037a3a6d82b0859750f74ebf8f8ea9f67691` |
| audio entities | `\gamedata\xt\audioentities.bin` | 21,354,496 | 369,013 / 592,392 | `a7ef1c0416fc335eb72a379da2e771ddaa91c4ca08757f9f5f61327cf422b785` |
| RL database | `\gamedata\xt\rldatabase.bin` | 22,532,096 | 8,367 / 13,348 | `e01c7dda756c8c3fe520a7288e5db03c8db303df914f0aaa5c95a9643481bd72` |
| routes | `\gamedata\xt\amax.bin` | 21,028,864 | 308,744 / 1,078,940 | `a833487bd66552ecf61b1f13790ee228b18ca8f4d76c524dcd94e44c63d1e3c7` |

The source-code citations below are from the read-only extracted reference tree
`_work/engine-vehicle-spike/tree/` (not shipped game data, not modified):

| source file | SHA-256 | used for |
| --- | --- | --- |
| `.../GameLogic/Pickups/Normal/PickupBlindfire.cpp` | `6ac74a81b136afa47f50deb7fe868596ba289c044c0d6254c805fd8253a631ff` | lifetime, forward fire, hit |
| `.../GameLogic/Pickups/Normal/PickupShunt.cpp` | `87f15093881b7a1ced644105a98b0433778810e0eacf22b8446eec2d8acbf353` | speed, homing, lifetime, warning |
| `.../GameLogic/Pickups/Normal/PickupShock.cpp` | `6fb3c7e718dfb1900b9f26d5a26be442ee3da5d6f2254a9a7ec229d502d595ce` | radius scaling, growth, hit test |
| `.../GameLogic/Pickups/Normal/PickupBarge.cpp` | `ebdcd571f72a0061b2f2f11c045f7223501ee5599083f651f45af081121bf741` | radius, band, jink |
| `.../GameLogic/Pickups/PickupProjectileBase.cpp` | `3cd67e6d8f1b59f5ad14b8dd86b607d444f85ffcb192a5f167142633b5b8195e` | travel, sphere/ray, ground |
| `.../GameLogic/Pickups/PickupBase.cpp` | `a2c8a45f42fa839b86a8efa84e8dad75ff1c132b60ff3d82f62530e902a752d2` | `CheckCanHit`, `RegisterHit` |
| `.../GameLogic/Pickups/PickupBase.h` | `7a031925940291ea4b2a5375fb31ce050149a124672fcae2b818a4bf74ce4158` | `CheckLegalHit` defender-centric rule |
| `.../GameLogic/Pickups/ShockManager.cpp` | `5cacca15a0b8587a0f6a9bca988209a0f5435b2397a6bc868cb25cba1096d955` | 3 domes, placement, width, lifetime |
| `.../Game/GameActors/Components/VehicleLogic/VLC_Pickups.cpp` | `7ac0b01c0e4263342d098d6b76b1d61b904236e90bd832a66f752d692ad46d69` | charges, fake physics, hit dispatch |
| `.../Game/GameActors/Components/VehicleLogic/VLC_Damage.cpp` | `d1330a62e2a237468447f04cf38656af031d315cb8456433eeefd32a69d66cbc` | base/minor damage |
| `.../Game/GameActors/VehicleLogic/VehicleLogicActor.cpp` | `2e2ab0c18fcb5ce9ab98462bb967511dec20a5577b8714862a2c7a2044af3238` | target selection |

Every line number and exact line text is stored in
`_work/powerups/projectiles.json.sourceCode.citations[]` and re-checked by the
verifier (hash + line + text).

`pickups.bin` is the field authority. The model never uses the source to invent a
serialized value; source values are labelled `runtime-only`.

---

## 2. New serialized table: `PerkForceEffects`

`pickups.bin` record **821** (id **4122981083**, type `PerkForceEffects`) is
referenced from `rldatabase.bin` `System` record **40** (id **2206278946**),
field `PerkForceEffects` at payload offset **20**. The handle is
`{refIndex 121, refId 4122981083, typeName PerkForceEffects}`; the record is
`null` in `rldatabase.bin` because it is cross-pack, and the same 32-bit id
resolves to `pickups.bin` record 821. This is a typed cross-pack reference, not a
name match.

The table is a 396-byte `PerkForceEffects` struct with nine 44-byte `ForceEffect`
entries:

| entry | record offset | `ForceType` | `MaxForce` | `Radius` | `Time` | `UpwardForce` | `DamageScale` | electrical |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `LargeExplosion` | 0 | Area | 300 | 20 | 0.5 | 0.2 | 0.1 | no |
| `SmallExplosion` | 44 | Area | 150 | 10 | 0.2 | 0.2 | 0.1 | no |
| `Shock` | 88 | Area | **5** | 0 | 0 | 0.1 | 0 | yes |
| `ShuntFire` | 132 | Area | **10** | 2 | 0 | 0.1 | 0 | yes |
| `ShuntExplode` | 176 | Area | **100** | 10 | 0.1 | 0.2 | 0.1 | yes |
| `Barge` | 220 | Area | **8** | 0 | 0.2 | 0 | 0 | yes |
| `Mine` | 264 | Area | 100 | 10 | 0.1 | 0.2 | 0.1 | yes |
| `MineProjectile` | 308 | Area | 10 | 2 | 0 | 0.1 | 0 | yes |
| `Blindfire` | 352 | Area | **10** | 2 | 0 | 0.1 | 0 | yes |

`ForceEffect` field offsets inside each 44-byte entry: `ForceType` 0,
`MaxForce` 4, `Radius` 8, `Time` 12, `ConeAngle` 16, `UpwardForce` 20,
`DamageScale` 24, `ElectricalEffect` 28, `ElectricalEffectColour` 32.
Exact absolute offsets are in
`projectiles.json.perkForceEffects.effects[*].fields`. All nine `ForceType`
labels are `Area` (label index 0).

Usage in source:

- projectile vs dynamic/physical object: `PickupProjectileBase.cpp:593-652`
  selects `m_ShuntFire`, `m_MineProjectile` or `m_Blindfire` and sends
  `C_DynamicObjectApplyImpulseMsg{m_Force = dir * MaxForce, ...}`;
- Barge dynamic objects: `PickupBarge.cpp:230-281` uses `m_Barge.MaxForce`;
- Shock dynamic objects: `PickupShock.cpp:290-344` uses `m_Shock.MaxForce`;
- projectile-vs-mine/projectile damage uses `GetDamageToApply()` (the pickup's
  `Normal` `DamageInflicted`), not `PerkForceEffects`.

**These are not vehicle impulses.** Vehicle hits go through
`RegisterHit`/`AttemptHitByPickup` and the fake-physics state below.

`PickupScript` record 66 (id 339744575) contains four `PickupTimeNode`s
(Shunt 1 s/3 s, Shock 5 s, Bomb 7 s). It is a scripted/tutorial firing list, not
the multiplayer fire rule; it is recorded in the manifest but not used.

---

## 3. Per-type recovery

### 3.1 Blindfire / Bolt

Entity: `PickupType` record **271**, refId **1291339931**. Levels: `Normal`
(record 752), `Reversed` (647), `Modified` (181), `ReversedModified` (529).

`Normal` balancing payload starts at **record 752, payload offset 20**
(`BalancingData` pointer at `PickupLevel` offset 12, component 1, element 0):

| field | struct offset | record offset | value |
| --- | ---: | ---: | ---: |
| `Delay` | 0 | 20 | 0.1 |
| `Health` | 4 | 24 | 50 |
| `Radius` | 8 | 28 | **0.2** |
| `FallRate` | 12 | 32 | 1.0 |
| `HeightFromGround` | 16 | 36 | 0.3 |
| `Speed` | 20 | 40 | **300** |
| `DamageInflicted` | 24 | 44 | **50** |
| `WarningDistance` | 28 | 48 | 100 |
| `WarningDot` | 32 | 52 | 0.99 |

Variants: `Modified` radius 0.4, `FallRate 0`; `Reversed` and
`ReversedModified` speed 50, `FallRate 0.7`. All variants damage 50.

Runtime:

- lifetime **10.0 s**: `g_debugBlindfireLiveTime("Perks.Blindfire.LiveTime", 10.0f)`
  (`PickupBlindfire.cpp:25`), enforced at `:111`; death reason `OLD_AGE`.
- charges **3**: `GetNumShotsAwarded` returns 3 for `E_PICKUP_TYPE_BLINDFIRE`
  (`VLC_Pickups.cpp:2853-2867`); `mNumShots` is decremented on use at `:1075`.
  This is the `blindfire1/2/3` HUD family. The `extra_blindfire1..4` icons are
  the boss additional-shot slots.
- targeting: no target. The constructor calls `C_PickupProjectile(..., -1,
  E_PICKUP_TYPE_BLINDFIRE, ...)` (`PickupBlindfire.cpp:30-34`); movement is the
  firing basis `AZ()`.
- hit volume: collision body is a sphere of `mRadius` (`PickupProjectileBase.cpp:128-133`);
  collision ray is a transparent ray with radius `mRadius` (`:445`), plus a
  second 1.2× straight ray (`:222`). One hit kills the projectile.
- ground: ray up 2 m / down 100 m and `CheckFall`; depends on the level mesh
  (`PickupProjectileBase.cpp:42-43,300-374`).
- `WarningDistance 100` / `WarningDot 0.99` are the lock/warning cone, **not** a
  maximum range.

Visual/audio: `Bolt_Shotgun_Projectile.cycle` (Modified/ReversedModified) and
`Blind_projectile_01.cycle` (Normal/Reversed); `Blindfire_Pow_01`,
`Blindfire_hit_01`; HUD `blindfire1/2/3` texture indices 5/9/6; audio
`BlindFire` (3494030784), `BlindFireProjectile` (3674726041), `BlindFireHit`
(3862297026).

Classification: **partial-runtime**. Recovered values are exact; lifetime,
charges, target selection, ground alignment and the target collision shape are
runtime/engine data.

### 3.2 Shunt

Entity: `PickupType` record **152**, refId **736887763**. Levels: `Normal`
(record 260), `DoubleTap` (33), `Reversed` (668).

`Normal` payload offset **20** (`ShuntBalancingData`, 44 B):

| field | struct offset | record offset | value |
| --- | ---: | ---: | ---: |
| `Delay` | 0 | 20 | 0.5 |
| `Health` | 4 | 24 | 100 |
| `Radius` | 8 | 28 | **0.75** |
| `FallRate` | 12 | 32 | 1.25 |
| `DamageInflicted` | 16 | 36 | **100** |
| `FXDropTime` | 20 | 40 | 0.2 |
| `ShuntTurnRateScalar` | 24 | 44 | 0.3 |
| `ECMActivationDist` | 28 | 48 | 13 |
| `ECMDeactivationDist` | 32 | 52 | 20 |
| `ECMWarningDist` | 36 | 56 | 25 |
| `ECMWarningEnabled` | 40 | 60 | true |

`DoubleTap` has `Delay 0.5`, `Health 100`, `ShotDelay 0.5` (no projectile
fields). `Reversed` has `Radius 0.75`, `FallRate 1.5`, `Damage 100`,
`Speed 50`, `HeightFromGround 0.2`, `WarningDistance 70`, `WarningDot 0.9`.

Runtime:

- lifetime **40 s**: `g_ShuntKillTime("Perks.Shunt.KillTime", 40.0f)`
  (`PickupShunt.cpp:31`); `m_killTime` decremented at `:300-302`.
- speed: initial velocity = `max(forwardSpeed + 15, 10)` (`:196-200`),
  `m_minSpeed = 60` (`:199`); max speed `g_ShuntMaxSpeed 110` (`:29,510`);
  homing speed `clamp(distance² / 50², 0.3, 1.0) * 50 + targetSpeed`
  (`:609-612`, `:684-687`).
- homing: target required; turn rate `g_debugShuntHomingTurnRate 65°` and
  `g_ShuntMaxTurnRate 180°` (`:38,50`); `m_killTime`/`g_ShuntKillTime`; the state
  machine is `SHUNT_STATE_STAGE_1..6` (`:499-776`).
- target choice, human: `C_VehicleLogicActor::EvaluateShuntTarget`
  (`VehicleLogicActor.cpp:2056-2222`): not self/teammate/wrecked; AI-data path
  uses race position/route; non-AI (MP bowls) path uses camera line of sight,
  `dotForward > 0.707` (45°), `distance <= 500 m`, score
  `(1 - dotForward) * sqrt(distance/500)`, lowest score wins. The XT AI trigger
  data is `AIPickupTypeEnemyInRange` 40/40, 30/30, 20/20.
- warning: `g_ShuntWarningRange 100`, `g_ShuntWarningDot 0.5`
  (`PickupShunt.cpp:36-37,235`). The XT ECM ranges 13/20/25 are separate.
- hit volume: sphere `Radius 0.75` + swept ray; one hit.
- hit strength: `hitType = MAJOR` while `mHealth >= mpShuntData->mHealth`;
  otherwise `MINOR` (`PickupShunt.cpp:389-391`). A projectile damaged by a mine
  or another projectile therefore does half damage.

Source damage: major 100, minor 50 (`VLC_Damage.cpp:2296-2299`).

Classification: **partial-runtime**. `Speed`, homing constants and lifetime are
not in `ShuntBalancingData`; they are runtime defaults/recovered code.

### 3.3 Barge

Entity: `PickupType` record **329**, refId **1621319152**. Only `Normal`
(record 738).

`Normal` payload offset **20** (`BargeBalancingData`, 28 B):

| field | struct offset | record offset | value |
| --- | ---: | ---: | ---: |
| `Delay` | 0 | 20 | 0.2 |
| `Health` | 4 | 24 | 0 |
| `Radius` | 8 | 28 | **7.0** |
| `DamageInflicted` | 12 | 32 | **100** |
| `Duration` | 16 | 36 | **0.4** |
| `MinMinePushForce` | 20 | 40 | 50,000 |
| `MinePushForceMultiplier` | 24 | 44 | 1,000 |

Runtime:

- `mMajorRadius = Radius + g_debugBargeMajorRadius(0) + 0.5` and
  `mMinorRadius = Radius + 0.5` (`PickupBarge.cpp:46-47,81-82`), i.e. a
  **7.5 m circle**.
- `mTimer = Duration` (`:79`), expire at `mTimer <= 0` (`:125-128`).
- hit test: `IsInsideEllipse` (`:308-329`) with target extents fudge
  `(extents.X + extents.Z)/2 - 1.75`; outer hit if inside
  `majorRadius + fudge` (`:142`), major if inside
  `majorRadius + fudge - 2.0` (`:150`), otherwise minor. Both damage 100;
  minor only changes the fake-physics jink.
- fake physics: major `JINK_BARGE_LEFT/RIGHT`, minor
  `JINK_BARGE_MINOR_LEFT/RIGHT` (`VLC_Pickups.cpp:1781-1800`).
- the mine-push branch (`force = multiplier * carSpeed + min`) is **commented
  out** in `PickupBarge.cpp:200-218`; the values are serialized but not active
  for the normal Barge.
- duration is 0.4 s, so the ellipse is a short pulse around the moving car.

Classification: **partial-runtime**. Radius/damage/duration/push values are
serialized; the band, extents fudge and fake-physics magnitude are runtime.

### 3.4 Shock

Entity: `PickupType` record **202**, refId **973327125**. Levels: `Normal`
(record 487), `DoubleTap` (440).

`Normal` balancing payload starts at **record 487, payload offset 148**
(component 2, element 0; the level has a graph component before the balance
struct):

| field | struct offset | record offset | value |
| --- | ---: | ---: | ---: |
| `Delay` | 0 | 148 | 1.0 |
| `Health` | 4 | 152 | 0 |
| `InnerRadius` | 8 | 156 | **7.0** |
| `OuterRadius` | 12 | 160 | **14.0** |
| `Lifetime` | 16 | 164 | **1.5** |
| `DamageInflicted` | 20 | 168 | **100** |
| `HeightDiff` | 24 | 172 | **−1.5** |

`DoubleTap` is identical except `OuterRadius 14.5`. The `Normal` level also has
an 8-key `BalancingGraph` (`(0,0) … (1.5,0.8523)`); it is the speed-scrub curve,
not the hit-test radius.

Runtime — this is the important part:

- **actual radii are scaled**: `mTotalInnerRadius = mTrackSegmentWidth *
  mSizeMultiplier * InnerRadius`;
  `mTotalOuterRadius = mTrackSegmentWidth * mSizeMultiplier * OuterRadius`
  (`PickupShock.cpp:137-138`). `mTrackSegmentWidth` is `mVal` from the Shock
  manager, the clamped route width; `mSizeMultiplier` is a random 0.85–1.15
  seeded by `mUniqueId * width` (`:67-69`). `7` and `14` are **scale factors**,
  not metres.
- width: `shockWidthWeighting = 0.0` on the raced `usa_la_river` route
  (route 1643385212, `Route.ShockWidthWeighting` at `amax.bin` offset 80), so
  `extremeWidthWeighting = 1.0`; `mPoint.mWidth =
  clamp(routeWidth * 1.0 / 60, 0.1, 0.8)` (`ShockManager.cpp:752-757`).
- **3 domes per use**: `g_debugShockManagerNumShocks 3` (`ShockManager.cpp:19,177`).
- placement: domes are placed along the target's AI racing spline ahead by
  `5 m + floor(0.02 * speedMph) + distAhead` (`:766`), with 20 m initial and
  clamping (`:38-43`). This needs the track spline, which is not in these packs.
- lifetime: `mTotalLifetime = Lifetime + lifetimeMod` where
  `lifetimeMod = clamp(-distanceToTarget * 0.1, 0, 10)` (`:110-111`;
  `PickupShock.cpp:71`), then rounded to the shock-dome animation loop
  (`:84-101`). Base 1.5 s; practical 1.5–11.5 s.
- growth: `growth = t * 1.5` before 0.7 s, then
  `1.5*0.7 + 1.5*(t-0.7)`; current outer radius is `min(totalOuter,
  totalOuter * growth)` (`PickupShock.cpp:220-237`).
- hit test: 3D distance `<= currentOuterRadius` (`:252-256`); **inner radius is
  commented out**, so every hit is `MINOR`; height gate
  `heightDiff >= HeightDiff (−1.5)` (`:258-260`); one hit per dome per vehicle;
  the dome dies on the first hit (`:262-275`).
- applied damage: base 100, MINOR halves Shunt/Shock (`VLC_Damage.cpp:2296-2299`)
  → **50**. There is no radial falloff: inside the growing sphere is always 50,
  outside is 0.

Classification: **partial-runtime**. The base radii/lifetime/damage/height are
serialized; the real radii, dome count, placement, size multiplier and lifetime
modifier are runtime.

---

## 4. Damage model

`C_VehicleComponent_Damage::GetDamageInflicted` (`VLC_Damage.cpp:2258-2340`):

1. `damage = pPickup->mNormal->mBalancingData->GetDamageInflicted()`
   (`:2291-2294`).
2. If `hitType == MINOR` **and** type is `SHUNT` or `SHOCK`, `damage /= 2`
   (`:2296-2299`).
3. Harmful pickups then go through `CheckPowerUpDamageModifiers` (Iron Fist,
   etc.) and the `E_DAMAGE_MODE_MULTIPLIER` multiplier (`:2301-2326`).
4. Last-Gasp Barge (`subType MOD`) uses `LastGaspModSettings.bargeDamage`
   (`:2328-2339`).

| type | base | applied (Normal, no mods) | note |
| --- | ---: | ---: | --- |
| Blindfire | 50 | **50** | major hit |
| Shunt | 100 | **100** major / **50** minor | minor if projectile health < max |
| Barge | 100 | **100** major and minor | only Shunt/Shock are halved |
| Shock | 100 | **50** | always MINOR |
| Bomb/Mine | 100 | 100 | not part of this task |

Damage-mode and mod multipliers are **not** applied by the prototype; they are
typed as caller/game-mode inputs.

---

## 5. Targeting model

| type | human rule | AI rule | source |
| --- | --- | --- | --- |
| Blindfire | fires forward; no target (`targetIdx −1`) | `AIPickupTypeEnemyInRange` distance/angle 40/40, 30/30, 20/20 | `PickupBlindfire.cpp:30-34`; entity `AIPickupTypes` |
| Shunt | camera LOS; target ahead `dot > cos 45°`; `distance <= 500 m`; score `(1-dot)*sqrt(distance/500)`; lowest wins | `EnemyInRange` 40/40, 30/30, 20/20 + AI target code | `VehicleLogicActor.cpp:2056-2222`; entity `AIPickupTypes` |
| Shock | `EvaluateShockTarget`: lowest `mRacePosition` among still-racing vehicles | `EnemyInRange 50/0`, then `AheadOfEnemy 80/45`, `200/20` | `VehicleLogicActor.cpp:2025-2052`; entity `AIPickupTypes` |
| Barge | no target; self-centred ellipse | same | `PickupBarge.cpp:132-160` |

`AIPickupControllerSetup` (record 153, id 742508891) adds the shared AI cadence:
`EvaluateTimeInSeconds 0.5`, `EvaluateShieldTimeInSeconds 0.1`,
`OutOfRangePickDropTime 5–20`, `PickupSwitchTime 2`, `FiredPerkDisableTime 2`,
`PlayerHitWithPerkDisableTime 5`, `FireProbabilityRatio 1.0`,
`IgnoreHumanRatio 0.0`, plus **7 `AIPickupAccuracyGraph`** entries. These graphs
are AI **hit probability vs distance**, not the human projectile hit volume. The
prototype does not use them for human hits.

---

## 6. Retail fake-physics / impulse behaviour and reproducibility

| effect | retail mechanism | serialized magnitude? | deterministic JS model |
| --- | --- | --- | --- |
| Shunt major | `E_FAKE_PHYSICS_FLIP_FORWARD` (`VLC_Pickups.cpp:1698`) | no; FakePhysics debug defaults (`FlipForce 1.4`, etc.) | emits `flip-forward` with `magnitude:"not-serialized"`; optional linear impulse is **provisional** |
| Shunt minor | `E_FAKE_PHYSICS_TIP_FORWARD` (`:1702`) | no | emits `tip-forward`; no magnitude |
| Barge major | `JINK_BARGE_LEFT/RIGHT` (`:1782,1798`) | no | emits `jink-barge-left/right`; no magnitude |
| Barge minor | `JINK_BARGE_MINOR_LEFT/RIGHT` (`:1784,1800`) | no | emits `jink-barge-minor-left/right`; no magnitude |
| Blindfire hit | `ApplyBlindfireSpin(false)` (`:1756,2101-2141`) | no | emits `blindfire-spin` left/right; no magnitude |
| Shock hit | `E_FAKE_SPEED_BRAKE` with the Shock Hermite graph and 10 mph floor (`:1715-1745`; BOOST1 §3.2/§4.4) | graph + floor recovered; target speed depends on current speed | speed scrub is a separate BOOST1 model; this model only does the hit test/damage |
| dynamic object | `dir * PerkForceEffects.MaxForce` (`PickupProjectileBase.cpp:614-652`; `PickupBarge.cpp:260-273`; `PickupShock.cpp:323-336`) | **yes**, `MaxForce` table §2 | can reproduce as a force vector if the object mass/response is supplied |

**Vehicle impulse is not reproducible from the recovered data alone.** The
FakePhysics magnitudes are debug defaults and depend on the vehicle body,
inertia and contact state. A deterministic JS model can reproduce the *event*,
the *hit type* and the *damage*, but not the retail flip/tip/jink magnitude.
The BOOST1 20 kN·s forward impulse (+12.1 m/s on 1600 kg) is recorded as a
**provisional design choice**, not a retail value.

**Dynamic-object impulse is reproducible.** `MaxForce` is serialized; the model
emits `dynamic-object-impulse` with the exact vector when the object and mass
are supplied. It is not a vehicle impulse.

---

## 7. Rules prototype

Files:

- `probes/powerups/rules/projectiles.js` — typed model, no engine, no game data.
- `probes/powerups/rules/projectiles.test.mjs` — 19 unit tests.
- `_work/powerups/projectiles.json` — the data/provenance manifest.

API:

```js
const world = createProjectileModel(projectilesManifest, { authorityId: 'host-A' });
world.addCar(id, { position, forward, speedMps, radiusM, extents, racePosition, health });
world.addInventory(ownerId, type, charges);

world.fireBlindfire({ ownerId, direction, level });
world.fireShunt({ ownerId, targetId, level });
world.fireBarge({ ownerId, level });
world.fireShock({ ownerId, targetId, domes: [{ position, width, sizeMultiplier, lifetimeModSeconds }] });
world.applyProvisionalShuntImpulse(targetId, { impulseNs, massKg });
world.damage(targetId, amount, source);
world.advance(dt);
world.snapshot();
```

Data-driven behaviour:

- **Blindfire**: `Speed 300`, `Radius 0.2`, damage 50, lifetime 10 s, 3 charges,
  straight-line sphere/swept-segment hit; target radius is caller input.
- **Shunt**: lifetime 40 s, initial `max(forward+15,10)` clamped 60–110, homing
  turn 65°/s, speed `clamp(dist²/50²,0.3,1)*50 + targetSpeed` clamped 60–110;
  major 100 / minor 50; flip/tip event with unknown magnitude.
- **Barge**: 7.0 m + 0.5 = 7.5 m circle around the owner, 0.4 s, inner band
  2.0 m + extents fudge 1.75 m; major/minor both 100; jink event.
- **Shock**: requires `width` and dome positions; actual radius
  `width * sizeMultiplier * 14`; 3D growing sphere; always minor → 50;
  height gate −1.5; expires at `1.5 + lifetimeMod`.
- **Unknowns**: missing `lifetime`/`charges`/`width`/`target radius`/`extents`
  return a typed rejection (`projectile-rejected`, `shock-rejected`,
  `impulse-refused`) or throw with the exact reason. There is no silent fallback.

Test result (`node probes/powerups/rules/projectiles.test.mjs`, 19/19 PASS):

1. manifest integrity + typed runtime fields;
2. `PerkForceEffects` values;
3. Blindfire speed/radius/damage/lifetime/charges;
4. Blindfire hit (30 m → 50 damage);
5. Blindfire miss + expire at 10 s;
6. Blindfire 3 charges then `no-ammo`;
7. Shunt major 100 + `flip-forward`;
8. Shunt minor 50 + `tip-forward`;
9. Shunt provisional impulse `Δv = J/m` (12.5 m/s) and refusal without inputs;
10. Barge major at 5 m (100 damage, `jink-barge-right`);
11. Barge minor at 8 m (100 damage, `jink-barge-minor-right`);
12. Barge miss at 10 m + expire at 0.4 s;
13. Shock actual radii = width × sizeMultiplier × base;
14. Shock no falloff: 1 m and 6.5 m both 50;
15. Shock growth: 5 m missed at 0.2 s, hit at 0.5 s;
16. Shock height gate −2 m → miss;
17. Shock 8 m outside outer → miss + expire;
18. Shock without dome layout → typed refusal;
19. event seq/authority + snapshot determinism.

Determinism: two runs of the same sequence produce identical `snapshot()` JSON
(test 19). The Shock size multiplier, when the caller omits it, is a documented
FNV-1a mapping into the recovered 0.85–1.15 range (`project-deterministic`); it is
not claimed to be the retail RNG.

Existing PWR1 9/9 tests still pass; the PWR1 `powerups.json` and 1,783-check
verifier are untouched (`sha256 6ee5a3e6…bc73d7`).

---

## 8. Integration contract

### 8.1 Events

| event | payload (minimum) | sync |
| --- | --- | --- |
| `projectile-fired` | `seq, authority, projectileId, pickupType, level, ownerId, origin, direction, speedMps, lifetimeSeconds, lifetimeSource, chargesRemaining, targetId?, homing?` | reliable, once |
| `projectile-travelled` | `seq, projectileId, at, position` | derived/optional; not authoritative |
| `projectile-hit` | `seq, projectileId, pickupType, targetId, hitType, damage, position, fakePhysics, hitTest` | reliable |
| `shunt-hit` | same as hit + `impulse` object | reliable; `impulse.status` is `not-serialized` |
| `projectile-expired` | `seq, projectileId, pickupType, reason, at, lifetimeSeconds` | derived; may be omitted if both peers tick |
| `barge-activated` | `seq, bargeId, ownerId, position, radius, durationSeconds, hitTest` | reliable |
| `barge-hit` | `seq, bargeId, ownerId, targetId, hitType, damage, distance, outerRadius, innerRadius, fakePhysics` | reliable |
| `shock-dome-spawned` | `seq, domeId, ownerId, targetId, position, width, sizeMultiplier, base/actual radii, lifetimeSeconds` | reliable |
| `shock-hit` | `seq, domeId, ownerId, targetId, hitType, damage, distance, currentOuterRadius, heightDiff` | reliable |
| `dynamic-object-impulse` | `seq, sourcePickup, objectId, force, electricalEffect, at` | reliable if the object is replicated |
| `shunt-impulse-provisional` | `seq, targetId, impulseNs, massKg, deltaV, source:'provisional-impulse'` | project-only; not retail |
| `projectile-rejected` / `shock-rejected` / `impulse-refused` | `reason`, typed missing field | local diagnostic; not replicated |

The existing T-006 wire events `PickupFired` (5), `HitByPickup` (8),
`JudgedPowerupHit` (20), `PickupKilled`, `MineMoved`,
`MineDestroyedByProjectile` are the retail counterparts where they exist
(`docs/work/analysis/t006-wire-format.md` §3.2). The prototype names above are
canonical project names, not new retail packets.

### 8.2 Authority

- **Host-authoritative for M2**, matching the plan: the host owns projectile ids,
  `seq`, hit judgement, charges/inventory and expiry.
- Clients send **intents** (`fire`, `aim`, `targetId`); they never judge a hit,
  consume charges or expire a projectile locally.
- Retail validation is **defender-centric**: `C_PickupBase::CheckLegalHit`
  (`PickupBase.h:72`) returns true for the defender's local vehicle for these
  pickups. M2 may use the host as the single judge, but must not silently switch
  to firer-side hit judgement; the event carries `judgedBy:'host'` (M2) and the
  retail rule is recorded for comparison.
- The guest applies the host-sequenced impulse/damage to its own car, mirroring
  the BOOST1 M1 "host-validated, peer-state" model. A literal "host simulates
  every car" needs server-side physics for all cars (architecture change).
- Reliable/ordered channel for fire/hit/shield/respawn/dome events; snapshots at
  20–30 Hz. Do not put them on an unreliable channel until the packet budget is
  measured.
- Late join: send active projectiles/domes/barges, each owner's charges and the
  next `seq`, then replay.

### 8.3 Values

| value | Blindfire | Shunt | Barge | Shock |
| --- | ---: | ---: | ---: | ---: |
| lifetime | 10 s (runtime) | 40 s (runtime) | 0.4 s (XT) | 1.5 + distMod (XT + runtime) |
| speed | 300 m/s (XT) | 10–110 m/s (runtime) | n/a | n/a |
| radius | 0.2 m (XT) | 0.75 m (XT) | 7.5 m (XT + runtime) | width×sizeMul×7/14 (runtime) |
| damage | 50 (XT) | 100/50 (XT + minor) | 100 (XT) | 50 applied (XT + minor) |
| charges | 3 (runtime) | 1 (runtime) | 1 (runtime) | 1 (runtime) |
| target | forward | required, 500 m/45° | self | race position ahead |
| falloff | none | none | none (band only) | none |
| fake physics | spin | flip/tip | jink | speed brake |

### 8.4 What remains provisional

1. **Shunt linear impulse magnitude** — retail uses FakePhysics FLIP/TIP; a
   linear `J` is a design choice. The event is labelled `provisional-impulse`.
2. **Barge jink magnitude** — not serialized.
3. **Shock dome layout/width** — requires the track spline and route width.
   The model refuses without `position`/`width`.
4. **Shock size multiplier RNG** — the model uses a documented deterministic
   hash, not the retail `Util::C_Random` sequence.
5. **Target collision radius/extents** — engine vehicle data; required as caller
   input. The model throws if absent.
6. **Ground alignment** — retail ray-traces the level mesh every tick; the model
   uses straight-line travel and labels `grounding:'not-modelled'`.
7. **Shunt homing stages** — the prototype homes from t=0; retail stages 1/2 go
   straight for 0.075 s and only stages 3/4/6 home (`PickupShunt.cpp:529-566`).
   The event is labelled `homing.status:'runtime-approximation'`.
8. **Barge left/right** — the prototype classifies the side on world X; retail
   uses the target car's local axis (`GetHitDirection`). The jink *kind* is
   provisional, the damage/band is recovered.
9. **Damage modes/mods** — `E_DAMAGE_MODE_MULTIPLIER`, Iron Fist, Last Gasp,
   Safety Net, Titanium Armour, Shielded Boosters are recorded but not applied.
10. **Shock speed scrub** — BOOST1's Hermite/`E_FAKE_SPEED_BRAKE` model is the
    correct place; this model only does hit/damage.

---

## 9. Blockers

| blocker | status | what would unblock |
| --- | --- | --- |
| Shunt projectile speed/lifetime not in `ShuntBalancingData` | **runtime-only**; source defaults recovered | a shipped debug/persisted override table or a decompiled build read |
| Blindfire/Shunt lifetime | **runtime-only**; 10 s / 40 s source defaults | same |
| charges | **runtime-only**; Blindfire 3, others 1 | inventory schema or persisted tuning |
| Shock dome positions/width | **runtime-only**; needs AI spline + route width | decode the `.aid`/AI track data for the raced route |
| Shock size multiplier RNG order | **runtime-only** | decompile `Util::C_Random` and the unique-id allocation order |
| Fake-physics magnitudes | **not-serialized**; debug defaults | decompile `FakePhys_SetupEffect` constants and the vehicle inertia at hit time |
| target collision radius/extents | **engine data** | expose the vehicle body shape in the e1/race state |
| ground alignment | **runtime mesh query** | a committed collision oracle for the projectile path |
| `E_PICKUP_TYPE` integer values | **not-serialized** | do not invent; use the 32-bit ref ids |
| `perk_icons` sheet binding | **string-only** | a typed texture binding in `ui.bin` or the UI runtime |

No unknown was replaced by a guessed value.

---

## 10. Evidence and reproduce

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/powerups/tools/build_projectiles.py
& $py probes/powerups/tools/verify_projectiles.py
node probes/powerups/rules/projectiles.test.mjs
node probes/powerups/rules/tests.mjs   # existing PWR1 9/9
```

Artifacts:

| path | content |
| --- | --- |
| `_work/powerups/projectiles.json` | 263,593 B, file SHA-256 `a611f12c…b245641`, content hash `7f5c5c16…59006e` |
| `_work/powerups/projectiles.verify.json` | **888/888 PASS**, no failures |
| `_work/logs/powerups/pwr4-build-run1.log`, `pwr4-build-run2.log` | two builds, identical file hash |
| `_work/logs/powerups/pwr4-verify-final.log` | 888 checks, 0 failures |
| `_work/logs/powerups/pwr4-rules-tests.log` | 19/19 PASS |
| `probes/powerups/tools/build_projectiles.py` | manifest builder |
| `probes/powerups/tools/verify_projectiles.py` | independent direct-offset reader + source/line verifier |
| `probes/powerups/rules/projectiles.js` | typed model |
| `probes/powerups/rules/projectiles.test.mjs` | 19 tests |

Determinism: two consecutive builds produced the identical
`projectiles.json` SHA-256 `a611f12ca8a1986802eaf5336d19d44b48b4742361b655fc6f44a2beb24b5641`.
The existing `_work/powerups/powerups.json` remains
`6ee5a3e699187086665b4b5330abcda29859e77b4464edae65e6ed00b7bc73d7`
(content `543b059ab7bc511cc61947ba584ff461f8f54b86ea02c06fbd2538f5d2c654df`)
and its verifier remains **1,783/1,783 PASS**; the PWR4 builder/verifier assert
both before and after.

The verifier re-reads the five PAK entries, re-parses the FLSK tables at direct
offsets **without importing `xt_decode`**, re-derives every balancing payload
offset and scalar, re-checks the `PerkForceEffects` cross-pack handle, the AI
controller, HUD texture indices, audio entity refIds/ports, the route
`ShockWidthWeighting`, every source file hash/line/token, and the canonical hash.

---

## 11. Limits

- **Data and a rules prototype only.** No e1-drive/engine change, no renderer,
  no GPU result, no audio mixer, no full-game claim.
- **Runtime values are the shipped source's `Debug::Float`/`Debug::Int`
  defaults.** A retail build's persisted debug overrides are not read.
- **No retail fake-physics parity.** Vehicle flip/tip/jink magnitudes are not
  serialized; the model emits typed events with `magnitude:"not-serialized"`.
- **No track spline.** Shock dome positions/width and the actual per-dome
  lifetime modifier require runtime route data; the model refuses without them.
- **No target collision shape.** The model requires `radiusM`/`extents` from the
  caller; it does not invent vehicle dimensions.
- **No probability/RNG claim.** The deterministic Shock size multiplier is a
  project choice, not the retail RNG.
- **No new integer enum values.** The 32-bit `PickupType.refId` is the wire id;
  the retail `E_PICKUP_TYPE` integers are not serialized and are not invented.
