# Tyre and collision audio — decoded retail layers and a standalone Web Audio module

**Status:** decoded, implemented and verified headlessly; **not** integrated into `e1-drive`
**Date:** 7 November 2026
**Scope:** `probes/audio/web/tyre-collision-audio.js`, its harness page and its
headless verifier. Two tyre states (dry/offroad), one material-routed world
impact path, one active impact voice.
**Depends on:** `docs/work/analysis/audio-feasibility.md` and
`docs/work/analysis/audio-engine-module.md` (BAF/ADPCM/AOBJ decode, P62
harness patterns).

## 1. What this is

The engine module proved that Blur ships short retail recordings plus
data-driven PLF curves, and that the browser can play them without a
synthesiser. This task extends the same method to the two feedback layers the
engine cannot provide:

- **tyre** — the retail `Wheel_Dry` and `Wheel_OffRoad` loops, driven by the
  exact `GroundSpeed` / `WheelXSlide` curves in `wheel_dry.dat` and
  `wheel_offroad.dat`;
- **collision** — the `CollisionWorld` one-shot tables, the material routing
  recovered from the 155-word `CollisionScript` bytecode, and the retail
  `CollisionVolume` force→dB curve.

The module is not a synth and does not invent sounds. It starts every decoded
loop once and modulates gain/rate; one-shots are the original recordings. It
creates no `AudioContext` until `ensureStarted()` is called from a user
gesture, reports typed failures instead of substituting audio, and exposes
plain-object diagnostics.

### 1.1 Provenance

| Item | Value |
| --- | --- |
| Tyre controller | `root.pak:\audio\dat\wheel_controller.dat`, 4,386 B, `cfa5ed18deb50f4d2b625350d81d4742a4cb0e5aa204509bb1933bddfa500852` |
| Dry graph | `root.pak:\audio\dat\wheel_dry.dat`, 8,900 B, `783dd4844c602d483b2be4ae0e89a35af253c47930f8c380c4ed23aae535397a` |
| Dry bank | `root.pak:\audio\wheel_dry.baf`, 817,726 B decoded, `8d451333a13923607c23e6093df085207deb74264a012e55bec2b2c9a6b7d90d` |
| Offroad graph | `root.pak:\audio\dat\wheel_offroad.dat`, 20,895 B, `0bfeef0d74e241156301a946aaa31936b3c1b78e5f7a6179d90beefa55e00fdb` |
| Offroad bank | `root.pak:\audio\wheel_offroad.baf`, 1,290,460 B decoded, `cb0dfc118957d70aa83e2d5123cb0cf43f50ed00552cb43286a1b5e282a8216a` |
| Collision graph | `root.pak:\audio\dat\collisionworld.dat`, 5,891 B, `1cbd19fe2e604721b7cbe45496510573ae6ee0784b2d0a1bae8cb95d03d62549` |
| Car-collision bank | `root.pak:\audio\car_collisions.baf`, 2,121,181 B decoded, `9663d8210f5d21dc9bdcc965c5d35045c08464455ec673fca35ce49cb2fc2339` |
| Material enum | `upstream/BlurRebuilt/code/amax/game/Game/GameDef/Materials.h:15-57` |
| Script opcodes | `upstream/BlurRebuilt/code/mercury/library/audio/source/components/Script.cpp:34-451` |
| Reference model | `_work/audio/tyre-collision-model.json` (`probes/audio/dump_tyre_collision.py`) |

## 2. Banks decoded

All assets are in `root.pak` (`packet-zlib`, codec 4) and use the same BAF
version 4 / format 7 (`Audio::Core::uADPCM4Bit`) container as `race_v8.baf`.
Every decoded wave is 48 kHz; all are mono except three `imp_DistantDecay*`
waves in `car_collisions.baf`. Continuous loops carry loop flag 1; impacts and
transition/stone one-shots carry 0.

| Bank | Logical bytes | SHA-256 | Waves | Decoded | Loops | One-shots |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `root.pak:\audio\wheel_dry.baf` | 817,726 | `8d451333a13923607c23e6093df085207deb74264a012e55bec2b2c9a6b7d90d` | 11 | 11 | 11 | 0 |
| `root.pak:\audio\wheel_offroad.baf` | 1,290,460 | `cb0dfc118957d70aa83e2d5123cb0cf43f50ed00552cb43286a1b5e282a8216a` | 50 | 50 | 13 | 37 |
| `root.pak:\audio\wheel_common.baf` | 1,063,945 | `2643e11085003d4e4963fc3af62de3416ad1b725c984cdd7031b328e1ca9be9e` | 37 | 37 | 5 | 32 |
| `root.pak:\audio\car_collisions.baf` | 2,121,181 | `9663d8210f5d21dc9bdcc965c5d35045c08464455ec673fca35ce49cb2fc2339` | 124 | 124 | 3 | 121 |
| `root.pak:\audio\do_metal_vehicle_car.baf` | 77,062 | `f140a57f53ede1771c5c9f3fa5111b4a3d8c2127ebdc2bb29524d8981ee3883d` | 3 | 3 | 0 | 3 |
| `root.pak:\audio\do_concrete_fence_chain.baf` | 61,552 | `d4ea14dddcd9b2ac5bd585c8a1ac3d79ebcab0032eb45dbdb0903e2c9f01d410` | 3 | 3 | 0 | 3 |
| `root.pak:\audio\do_concrete_fence_plastic.baf` | 56,272 | `5a2071bac0b8ef026a835e0c3fde0664802215e3680286cae324b9cde61d3683` | 3 | 3 | 0 | 3 |
| `root.pak:\audio\do_concrete_large.baf` | 73,300 | `d8996c4e235ab1842a4687fcd2e57feca70e0c31ef597c5b5395b690080b136a` | 3 | 3 | 0 | 3 |
| `root.pak:\audio\do_glass_hit.baf` | 50,200 | `d5f7db3bde85e7f6682b7f80b5b8ca85b71632d258366d9bf5d6c7809b17f2df` | 3 | 3 | 0 | 3 |
| `root.pak:\audio\do_metal_armco.baf` | 78,451 | `90d2d41817c36203dc9671d9e198fef937e1a54a1638f1d9e47368132f3f4589` | 5 | 5 | 0 | 5 |
| `root.pak:\audio\do_metal_fence_chainlink.baf` | 97,555 | `af1bf9599e539103c3fc230aacc63c8f91e44bff3ff3284ac8ae9b65d8bc3da3` | 3 | 3 | 0 | 3 |
| `root.pak:\audio\do_metal_hollow_large.baf` | 118,147 | `bebc859ad1306bb372a0e0dd58c2d7fcba7e75699a5497ae57b3de45777548ad` | 3 | 3 | 0 | 3 |
| `root.pak:\audio\do_metal_post_tall.baf` | 34,921 | `6bb8ab420765864d2dc13c3c9fe128069aa582b1ecf1e91035704d9dca088d1a` | 3 | 3 | 0 | 3 |
| `root.pak:\audio\do_metal_railing.baf` | 51,850 | `0c0b52f11d3234ca7f089b35b0b685a8922d1172a02bebfc57bc471bc8e483e2` | 3 | 3 | 0 | 3 |
| `root.pak:\audio\do_metal_sheet.baf` | 57,031 | `022945df9a2180887d0769644de8f7304ee01723479ee59fe702d498c48472b7` | 3 | 3 | 0 | 3 |
| `root.pak:\audio\do_metal_solid_medium.baf` | 62,245 | `c3428472206690f05db8508139850ed9c164da6633553bee79cc9efc10635ba0` | 3 | 3 | 0 | 3 |
| `root.pak:\audio\do_rubber_tyre.baf` | 23,272 | `caf4e6238277ddd799ef773f080b0336238a931900f21deed8d69d16895cdb51` | 3 | 3 | 0 | 3 |
| `root.pak:\audio\do_vegetation_hedge.baf` | 78,316 | `e98bf8389b31c993aa56b4d57c2f2fea911ed4bd680ea8556d4d6a124444ca66` | 3 | 3 | 0 | 3 |
| `root.pak:\audio\do_wood_fence.baf` | 60,067 | `ed505608e5fb359ebe0b4a3f1959b88b9e38600b0894d43cebd6b27c7e34f1cf` | 3 | 3 | 0 | 3 |

269 waves were decoded in total. The model JSON contains every wave's
duration, peak, RMS and WAV SHA-256.

### 2.1 ADPCM extent handling

The retail decoder decodes whole 64-sample/33-byte blocks and then either stops
at `mDestPCMSamples` or pads the tail with zeros
(`decoderadpcm4bit.cpp:133-136`). Many tyre/collision waves have a header
sample count that is not a multiple of 64 (for example `Bump_1` declares 3,770
samples over 59 blocks = 3,776 decoded). `extract_baf.py` now truncates to the
header count (or pads, if a file ever needs it) and records
`extent.trimmedFrames`/`extent.paddedFrames`. `wheel_dry` and the engine loops
are unaffected (their counts are exact multiples of 64).

### 2.2 AOBJ parser corrections (required for these graphs)

The tyre/collision graphs exposed four size-table errors in
`probes/audio/inspect_dat.py`. All were fixed from the upstream component
headers, not guessed:

| Component | Before | Correct | Source |
| --- | ---: | ---: | --- |
| `eVectorIn` (4) | 4 | **16** | `VectorIn.h:12-18` (name + X/Y/Z floats) |
| `eVectorOut` (5) | 4 | **40** | `VectorOut.h:12-29` (name + 3 connectors) |
| `eCoordinateOutput` (11) | 12 | **8** | `CoordinateOutput.h:12-16` (name + Com) |
| `eImpactFilter` | missing | **28** | `ImpactFilter.h:12-20`; enum index 198, not 200 (`Component.h:368`) |
| `eSampleAndHold` (51) | missing | **8** | `SampleAndHold.h:12-16` |
| `eExponent` (40) | 8+n·8 (mis-grouped) | **16** | `Exponent.h:12-17` |
| `eLowPass`/`eHighPass` (26/27) | missing | **16** | `LowPass.h`, `HighPass.h` |
| `eMonoOneShotSoundTable` (61/62) | 52 + wrong offset | **60 + uWaves·4 + uEffects·4** | `MonoOneShotSoundTable.h:12-25`, `:118` |

The `eVectorIn` error was especially consequential: it created four phantom
`ParameterIn` components (`metal_vehicle_car`) in every do_* graph and shifted
every later control index by four. Fixing it made the do_* control chain
coherent (`CollisionForce → Gradient → Multiplier → SampleAndHold →
CollisionForceVolume → SoundTable level`) and made the `CollisionScript`
material mapping resolve to the correct sound-table names. The full corrected
walk is in `_work/logs/audio/do_metal_vehicle_car-graph-fixed.log`.

## 3. Retail tyre mixing rules

### 3.1 Surface switch

`wheel_controller.dat` (`Wheel_Controller`, 76/76 components) declares the
wheel inputs (`WheelSpeed`, `WheelXSlide`, `WheelZSlide`, `WheelDownForce`,
`WheelOnGround`, `WheelSurfaceType`, `WheelSpringForce`, `WheelHitModifier`,
`WheelAttached`, `PadBrake`, `HandBrake`, `WheelStaticLoad`,
`WheelPriorityVolume`) and the events `StartWheelCommon`, `StartWheelDry`,
`StopWheelDry`, `StartWheelOffroad`, `StopWheelOffroad`.
`WheelSubSystem.cpp:134-238` resumes/suspends the named instances
`FLWheelDry/FRWheelDry/RLWheelDry/RRWheelDry` and
`FLWheelOffroad/…` on those events. The surface-type **numeric enum** and the
script body that chooses dry vs offroad are not interpreted; the module
therefore exposes only the proven two-state API.

### 3.2 Dry loops (`wheel_dry.dat`, 107/107 components)

| Layer | Wave | Gain curve (control) | Rate curve (control) |
| --- | --- | --- | --- |
| road | `Asphalt_Road` | `DryRoadSpeedVolumeTrue` (GroundSpeed 8) | none (1.0) |
| skid0 | `Asphalt_Lateral_1` | `SkidSpeedVolume` (8) × `Asphalt_Skid0VolumePLF` (WheelXSlide 1) | `SkidSpeedPitch` (8) × `Asphalt_SkidSlidePitchModifier` (1) |
| skid1 | `Asphalt_Lateral_2` | `SkidSpeedVolume` × `Asphalt_Skid1VolumePLF` (1) | same pair |
| skid2 | `Asphalt_Lateral_3` | `SkidSpeedVolume` × `Asphalt_Skid2VolumePLF` (1) | same pair |
| spin | `Asphalt_Spin` | `SpinSpeedVolume` (WheelSpeed 0) × `SpinSlipVolume` (WheelZSlide 2) | `SpinPitchMod` (2) |
| brakes | `Asphalt_Brakes` | `BrakesSpeedVolume` (8) × `BrakesGradientVolume` (45) × `BrakesXSlipMultiplier` (1) | `Asphalt_BrakesPitchMod` (45) |
| ABS brakes | `Asphalt_Brakes_ABS` | `BrakesSpeedVolume` × ABS curves | `Asphalt_ABSBrakesPitchMod` (45) |
| concrete/cobbles/metal/wood road | `Concrete_Road`, `Cobbles_Road`, `Metal_Road`, `Wood_Road` | decoded per-surface speed/volume curves; **not wired** in this slice | 1.0 |

The graph also carries `DownForceVolume`, `RoadNoiseX/ZModifier`,
`RoadNoiseDownForceVolume`, `HighDownforceSkidVolumeModifier`, and many mixer/EQ
components. The module applies the road gain and the skid pair only; the other
multipliers (downforce, X/Z modifiers, high-downforce modifier) are decoded but
**not applied**.

### 3.3 Offroad loops (`wheel_offroad.dat`, 206/206 components)

The graph has four road beds and three skid/spin beds. The sound table names are
the authority, including the non-obvious mapping `Grass_Road_Sound → Dirt_road`
and `Grass_Skid_Sound → Dirt_skid`.

| Substrate | Road wave | Skid wave | Spin wave |
| --- | --- | --- | --- |
| gravel | `Gravel_road` | `Gravel_skid` | `Gravel_spin` |
| grass | `Dirt_road` | `Dirt_skid` | `Dirt_spin` |
| sand | `Sand_road` | `Sand_skid` | `Sand_spin` |
| foliage | `Foliage_road` | — | — |

| Layer | Gain curve (control) | Rate curve (control) |
| --- | --- | --- |
| road | `OffRoadSpeedVolume` (GroundSpeed 8) | none (1.0) |
| skid | `OffRoadSkidSpeedVolume` (8) × `OffRoadSkidVolumePLF` (WheelXSlide 1) | `OffRoadSkidSpeedPitch` (8) × `OffRoadSkidSlidePitch` (1) |
| spin | `OffRoadSpinSpeedVolume` (WheelSpeed 0) × `OffRoadSpinSlipVolume` (WheelZSlide 2) | `OffRoadZSlidePitch` (2) |

The graph also contains stones (`BigStone*`, `SmallStone*`, `Mud*`), surface
transition one-shots, in-puddle modifiers, and high-pass/mixer components. All
47 sound references and 28 curves were decoded; only road/skid are wired.

### 3.4 `wheel_common.baf`

37 waves (puddles, rim, skid_rim, paving stones, metal joints, suspension,
car-to-floor landings, tyre burst, train tracks) and `wheel_common.dat`
(144/144) were decoded. The generic puddle/rim/suspension path is **not wired**;
it is a separate `Wheel_Common` entity, not part of the dry/offroad bed.

### 3.5 Tyre formulas used by the module

`slip` is supplied to the retail `WheelXSlide` control; `speed` is supplied to
`GroundSpeed`. The physical definition of `WheelXSlide` is not decoded, so the
mapping is named as an input mapping, not a claim that it is exactly lateral
slip.

Dry:

```text
roadGain  = PLF(DryRoadSpeedVolumeTrue, speed)
skidGainN = PLF(SkidSpeedVolume, speed) * PLF(Asphalt_SkidNVolumePLF, slip)
skidRate  = PLF(SkidSpeedPitch, speed) * PLF(Asphalt_SkidSlidePitchModifier, slip)
roadRate  = 1.0
```

Offroad:

```text
roadGain  = PLF(OffRoadSpeedVolume, speed)
skidGain  = PLF(OffRoadSkidSpeedVolume, speed) * PLF(OffRoadSkidVolumePLF, slip)
skidRate  = PLF(OffRoadSkidSpeedPitch, speed) * PLF(OffRoadSkidSlidePitch, slip)
roadRate  = 1.0
```

## 4. Retail collision mixing rules

### 4.1 CollisionWorld graph (`collisionworld.dat`, 57/57 components)

The entity takes `CollisionSurfaceType`, `CollisionForce`, listener/object
vectors, `OcclusionValue` and `InTunnelInput`, and plays one of 14 one-shot
tables. The decoded chain is:

```text
CollisionForce
  -> CollisionImpactFilter (ImpactFilter, threshold/half-life data)
  -> CollisionForceSample (SampleAndHold)
  -> CollisionVolume (PLF, dB): (0.8, -5) .. (50, +3)
  -> CollisionFinalVolume (product with occlusion modifier)
CollisionPitch = random + sum -> sound-table frequency input
CollisionSelector3 (3 elements, weight 1 each) -> sound-table wave index
```

The module applies only `CollisionVolume` (converted with `10^(dB/20)`) and the
surface table. The impact filter's half-life, occlusion, tunnel, distance
rolloff and frequency/pitch random are **not applied**.

### 4.2 Material routing (proven from the script)

`CollisionScript` compares `CollisionSurfaceType` against 18 constants and sends
`PlayMsg` (message 0) to one table. The decoded routing is:

| `E_EffectMaterial` | Value | Surface table | Bank |
| --- | ---: | --- | --- |
| Concrete / Rock / Brick | 2 / 3 / 11 | `Concrete_Large` | `DO_concrete_large` |
| Vegetation | 12 | `vegetation_hedge` | `DO_vegetation_hedge` |
| Wood | 13 | `wood_fence` | `DO_wood_fence` |
| Metal / Plastic / MetalSheet | 14 / 15 / 27 | `metal_sheet` | `DO_metal_sheet` |
| Glass | 16 | `glass_hit` | `DO_glass_hit` |
| Rubber | 17 | `rubber_tyre` | `DO_rubber_tyre` |
| ConcreteFenceChain | 23 | `concrete_fence_chain` | `DO_concrete_fence_chain` |
| ConcreteFencePlastic | 24 | `concrete_fence_plastic` | `DO_concrete_fence_plastic` |
| MetalHollow | 25 | `metal_hollow_large` | `DO_metal_hollow_large` |
| MetalArmco | 26 | `metal_armco` | `DO_metal_armco` |
| MetalFenceChain | 28 | `metal_fence_chainlink` | `DO_metal_fence_chainlink` |
| MetalFenceSolid | 29 | `metal_solid_medium` | `DO_metal_solid_medium` |
| MetalFenceSlatted | 30 | `metal_railing` | `DO_metal_railing` |
| MetalSolidPost | 31 | `metal_post_tall` | `DO_metal_post_tall` |

Every other `E_EffectMaterial` value (Default, Tarmac, Dirt, Grass, Water,
Vehicle, …) falls through the script without playing a world-impact sound. The
module returns `unsupported-material` for those values rather than guessing a
bank. `car_collisions.baf` is **not** the world-impact source; it belongs to the
car-to-car graph (`CollisionCar`) and is decoded but not wired.

### 4.3 Other collision graphs

- `collisioncar.dat` — `CollisionCar`, 103 declared / 84 parsed. The bounded
  walk stops at component 83 (`StereoToSurroundMixer`, offset `0x1004`) because
  that mixer's DataSize rule is not implemented; the walk refuses to guess and
  reports the offset. 11 curves and 11 sound components were decoded before
  that point. `car_collisions.baf` (124 waves, 3 stereo) is fully decoded as an
  asset, but the car-to-car mix is not applied.
- `collisionscrape.dat` — `CollisionScrape`, 59/59 components; 3 looping
  sounds (`ScrapeMetalSound`, `RoofScrapeSound`, `SideScrapeSound`) and six
  curves decoded. Not wired.
- `do_*.dat` — 14 object-impact graphs (13 surface graphs plus
  `metal_vehicle_car`) parsed 53–54/54. Each has one 3-wave table and a
  per-material **linear** `CollisionForceVolume` curve. These are
  the dynamic-object (prop) path, not the vehicle-vs-world path. They are
  recorded in `_work/audio/tyre-collision-model.json` and
  `_work/logs/audio/do_curves.log`; the module does not apply them.
  `do_concrete_fence_chain` has a bank but no `.dat`; its surface table exists
  only inside `collisionworld.dat`.

## 5. Module API

`probes/audio/web/tyre-collision-audio.js`:

```js
import {
  createTyreCollisionAudio,
  sampleTyreCurves,
  sampleCollision,
  resolveCollisionMaterial,
  evalPlf, dbToGain,
  DRY_TYRE, OFFROAD_TYRE,
  COLLISION_SURFACES, COLLISION_VOLUME_DB, MATERIAL_TO_SURFACE,
  EFFECT_MATERIALS, RETAIL_TYRE_COLLISION,
  DEFAULT_BASE_URL, MIN_PLAYBACK_RATE,
} from './tyre-collision-audio.js';
```

| Method | Behaviour |
| --- | --- |
| `ensureStarted(): Promise<status>` | Gesture-only. Creates the context, resumes it, loads 53 WAVs, starts 11 looping tyre sources, then reports `running`. Never rejects; failures resolve to `unavailable` + typed `reason`. |
| `setSurface('dry'\|'offroad', substrate?)` | Switches the tyre bed. Offroad substrate is `gravel` (default), `grass`, `sand` or `foliage`. Invalid values throw `RangeError`. Returns the pure sample. |
| `setSlip(slipRatio, speed)` | Stores slip/speed, recomputes every layer, applies gain/rate with `setTargetAtTime(now, 0.02)`. Throws `TypeError` on non-finite, `RangeError` on negative speed. Returns the pure sample. |
| `triggerImpact(strength, material?)` | Resolves material (name/index/table key; default `Metal`), evaluates `CollisionVolume`, gates to one active voice, plays the next wave round-robin. Returns `{triggered, reason, ...}`. Never throws on unsupported material. |
| `setMuted(bool)` | Drives the master gain to 0 / `masterGain` with `setTargetAtTime(0.01)`. Works before start. |
| `dispose()` | Stops all sources/impacts, disconnects, closes the context, drops buffers, state `disposed`. Idempotent. |
| `getDiagnostics()` | State/reason, context state, sample rate, surface/substrate/slip/speed, decoded buffers, tyre target vs live gain/rate, collision last/active/played, analyser RMS/peak, provenance. |
| `onStatusChange(fn)` / `onImpact(fn)` | Subscribe to state transitions / impact events; both return unsubscribe functions and cannot break the state machine. |

Typed statuses: `idle`, `loading`, `running`, `unavailable`, `disposed`.
Unavailable reasons: `no-audio-context`, `graph-failed`, `resume-failed`,
`not-running`, `fetch-failed`, `decode-failed`, `load-failed`, `start-failed`.
Impact rejection reasons: `not-running`, `unsupported-material`,
`below-threshold`, `in-progress`, `decode-failed`.

### 5.1 Deliberate simplifications

- The retail `Selector` chooses one of three waves with equal random weight.
  The module advances them **round-robin per surface** so runs are repeatable.
  This is a policy substitution, not a claim of retail randomness.
- One active impact voice globally. The retail graph has a per-entity
  `VoicesActiveSwitch`; `g_bMaxNumberCollision` is 10 for concurrent collision
  entities. The module's single-voice gate is a subset.
- No ImpactFilter decay, occlusion, tunnel, distance rolloff, pitch random,
  mixer/EQ/send/return or safety compressor replication. The bus is
  `gain → analyser → safety compressor → destination`.
- Road rate is 1.0 because no road pitch curve exists in the decoded dry /
  offroad graphs. Skid rate is the product of the two decoded pitch curves.

## 6. Harness and verification

Files:

| File | Role |
| --- | --- |
| `probes/audio/web/tyre-collision-audio.js` | The module. |
| `probes/audio/web/tyre-collision.html` | Harness page. |
| `probes/audio/web/tyre-collision-harness.js` | Page wiring; exposes `window.tyreCollisionProbe`. |
| `probes/audio/capture_tyre_collision.mjs` | Headless Edge verifier. |
| `probes/audio/dump_tyre_collision.py` | Builds the reference model + script disassembly. |
| `probes/audio/extract_baf.py` | BAF/ADPCM decoder (now with retail extent handling). |
| `probes/audio/inspect_dat.py` | AOBJ walker (size-table corrections above). |
| `probes/audio/serve.mjs` | Existing read-only server; `/web/` routes already covered the new page. Not modified. |

Commands:

```powershell
cd "C:\Users\ismailemin\Documents\Blur Web"
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# 1. Decode banks and graphs (game data stays under _work)
$banks = @(
  'wheel_dry','wheel_offroad','wheel_common','car_collisions','do_metal_vehicle_car',
  'do_concrete_fence_chain','do_concrete_fence_plastic','do_concrete_large','do_glass_hit',
  'do_metal_armco','do_metal_fence_chainlink','do_metal_hollow_large','do_metal_post_tall',
  'do_metal_railing','do_metal_sheet','do_metal_solid_medium','do_rubber_tyre',
  'do_vegetation_hedge','do_wood_fence'
)
foreach ($b in $banks) { & $py probes/audio/extract_baf.py --asset "\audio\$b.baf" }

$graphs = @(
  'wheel_controller','wheel_dry','wheel_offroad','wheel_common','collisionworld',
  'collisioncar','collisionscrape','do_metal_vehicle_car','do_concrete_fence_plastic',
  'do_concrete_large','do_glass_hit','do_metal_armco','do_metal_fence_chainlink',
  'do_metal_hollow_large','do_metal_post_tall','do_metal_railing','do_metal_sheet',
  'do_metal_solid_medium','do_rubber_tyre','do_vegetation_hedge','do_wood_fence'
)
foreach ($g in $graphs) {
  & $py probes/audio/extract_dat.py --asset "\audio\dat\$g.dat" --out "_work/audio/$g.dat"
}

# 2. Build the model + script disassembly
& $py probes/audio/dump_tyre_collision.py

# 3. Headless verification (exits 0 on success)
node probes/audio/capture_tyre_collision.mjs
```

### 6.1 Result

Command `node probes/audio/capture_tyre_collision.mjs` → exit code 0.

```text
verdict: tyre-collision-audio-module-verified
console: 0 messages, 0 errors/warnings
before gesture: state idle, contextState none, decoded 0, levels null, 14 surfaces, 18 routes
after gesture:  state running, contextState running, sampleRate 48000, decoded 53/53, 11 tyre loops
routing:        18/18 material values match the decoded CollisionScript
WAV hashes:     53/53 served WAVs match the decoded bank reports
impacts:        first imp_tyre01 (gain 1.4125, RMS 0.2927), second gated in-progress, retrigger imp_tyre02
mute:           RMS 0.0000 → unmute RMS 0.0963
dispose:        state disposed, contextState closed, decoded 0, layers 0
screenshot:     _work/audio/tyre-collision-harness.png (1280×900, ≈100 KB)
```

Measured tyre gains/rates (targets equal the retail PLFs to < 1e-9; live values
settle to < 1e-7 of the targets):

| State | Wave | Target gain | Target rate | Analyser RMS |
| --- | --- | ---: | ---: | ---: |
| dry, slip 0.2, speed 20 | `Asphalt_Road` | 0.2000 | 1.0000 | 0.0658 |
| dry, slip 0.2, speed 20 | `Asphalt_Lateral_1` | 0.5000 | 1.2156 | (shared) |
| dry, slip 0.2, speed 20 | `Asphalt_Lateral_2` | 0.1250 | 1.2156 | (shared) |
| dry, slip −0.35, speed 5 | `Asphalt_Road` | 0.0500 | 1.0000 | 0.0394 |
| dry, slip −0.35, speed 5 | `Asphalt_Lateral_2` | 0.2500 | 1.3198 | (shared) |
| dry, slip 0, speed 0 | — | 0 | — | 0.0000 |
| offroad gravel, slip 0.2, speed 20 | `Gravel_road` | 0.3333 | 1.0000 | 0.0611 |
| offroad gravel, slip 0.2, speed 20 | `Gravel_skid` | 0.4485 | 0.7225 | (shared) |
| offroad grass, slip −0.3, speed 10 | `Dirt_road` | 0.1667 | 1.0000 | 0.0880 |
| offroad grass, slip −0.3, speed 10 | `Dirt_skid` | 0.2824 | 0.7367 | (shared) |
| offroad sand, slip 0.5, speed 30 | `Sand_road` | 0.5000 | 1.0000 | 0.1705 |
| offroad sand, slip 0.5, speed 30 | `Sand_skid` | 0.7206 | 0.7933 | (shared) |
| offroad foliage, slip 0.1, speed 15 | `Foliage_road` | 0.2500 | 1.0000 | 0.1474 |

Analyser RMS is representative: it varies with the phase of the loops/one-shots
between runs (the gains, rates and routing are deterministic). Collision checks:
`imp_tyre01` at strength 150 → gain 1.4125
(`10^(3/20)`); a second call during playback returns `in-progress`; after the
gate clears the next call returns `imp_tyre02`; `Tarmac` returns
`unsupported-material`. The screenshot shows a Metal impact
(`imp_metsheet03`, gain 1.4125) with the gate active.

## 7. Integration recipe for `e1-drive` (not applied)

The E1 drive loop already has the analogue state; no module code changes are
needed for the wiring below.

1. **Construct at page load** (no context, no fetch):
   ```js
   import { createTyreCollisionAudio } from '../probes/audio/web/tyre-collision-audio.js';
   const audio = createTyreCollisionAudio({ baseUrl: '/assets/audio/', masterGain: 0.5 });
   ```
2. **Gesture hook** — call `audio.ensureStarted()` from the same click/tap that
   starts the drive scene. On `unavailable`, show `status.reason`; do not claim
   audio is playing.
3. **Per frame**, after the physics/telemetry read:
   ```js
   audio.setSurface(onRoad ? 'dry' : 'offroad', substrate); // substrate from surface material
   audio.setSlip(lateralSlip, groundSpeed);
   ```
   `lateralSlip` is the existing lateral slip/velocity ratio; `groundSpeed` is
   the existing m/s velocity magnitude. Feeding them to `WheelXSlide`/`GroundSpeed`
   is the documented input mapping; the retail definition of `WheelXSlide` is
   not decoded.
4. **Collision event point** — when the existing impact/collision path fires
   (`C_VehicleImpactMsg` / the prop resolver), call:
   ```js
   audio.triggerImpact(maxImpulseStrength, effectMaterialName);
   ```
   `effectMaterialName` is the existing `E_EffectMaterial` value from the
   collision (`m_EffectMaterial`). Unsupported materials are refused explicitly.
   Do not synthesize a generic hit for them.
5. **Mute/teardown** — reuse the existing `M` mute and `pagehide`/scene-exit
   hooks: `audio.setMuted(bool)`, `audio.dispose()`.
6. **Do not** create a second AudioContext or pass a shared context unless the
   page accepts that `dispose()` closes it.

What remains unknown for E1:

- The numeric `WheelSurfaceType` enum and the `OnRoadScript`/
  `OffRoadScript` bodies that decide dry vs offroad; the page must choose the
  state from its own surface query.
- The physical definition/bounds of `WheelXSlide`; the module maps the page's
  lateral slip into that control.
- The `E_EffectMaterial` → surface table mapping is now proven for the 18
  values in §4.2, but the level/scene must supply those values; props that use
  the separate do_* object path are not covered by the world module.
- Distance rolloff, occlusion, tunnel, impact-filter half-life, pitch random,
  mixer/EQ/send/return and the retail limiter are not modelled.
- `car_collisions.baf` / `CollisionCar`, `collisionscrape.dat` and the do_*
  object curves are decoded but not wired.

## 8. Proof vs unknown

### Proven

- The exact PAK assets, bank hashes and per-wave WAV hashes of 19 banks.
- `uADPCM4Bit` 48 kHz decode, including retail partial-block truncation/padding.
- `wheel_controller` inputs/events, the dry/offroad graph split, and the exact
  `DryRoadSpeedVolumeTrue`, `SkidSpeedVolume`, `Asphalt_SkidNVolumePLF`,
  `SkidSpeedPitch`, `Asphalt_SkidSlidePitchModifier`, `OffRoadSpeedVolume`,
  `OffRoadSkidSpeedVolume`, `OffRoadSkidVolumePLF`, `OffRoadSkidSpeedPitch`,
  `OffRoadSkidSlidePitch` curves and their control components.
- The offroad substrate → wave mapping (including grass → `Dirt_*`).
- The `CollisionWorld` 14 sound tables, `CollisionVolume` dB curve, and the
  18-value `CollisionScript` material routing.
- The `E_EffectMaterial` enum order from `Materials.h`.
- A headless browser mix of the original loops/tables with those curves,
  non-silent, deterministic wave rotation, gated one-shots, mute/dispose,
  clean console and screenshot.

### Unknown / not done

- The `CollisionCar` graph beyond component 84 (`StereoToSurroundMixer` size
  rule); its car-to-car mix is not applied.
- `CollisionScrape` and all do_* object-impact curves are decoded but not wired.
- The numeric `WheelSurfaceType` enum, `OnRoadScript`/`OffRoadScript` bodies,
  and the exact surface transition/debounce.
- The `ImpactFilter` threshold/half-life runtime, occlusion/tunnel/distance
  attenuation, `CollisionPitch` random, mixer/EQ/send/return and the retail
  limiter.
- The retail random selector sequence; the module uses deterministic
  round-robin.
- Native/PS3/x64 audio runtime parity; no latency, jitter or long-run soak.
- Other cars' wheel/collision sets; only the shared `Wheel_*` and
  `CollisionWorld` graphs were decoded.

## 9. Evidence index

| Path | What |
| --- | --- |
| `_work/audio/tyre-collision-model.json` | Full model: 19 banks, 269 waves with hashes, 21 graphs, curves, sound tables, selectors, script words, 18-route map. |
| `_work/logs/audio/script-disassembly.txt` | Disassembly of every decoded AOBJ script. |
| `_work/logs/audio/do_metal_vehicle_car-graph-fixed.log` | Post-fix control chain for the do_* graphs. |
| `_work/logs/audio/decode_tyre_collision.log`, `decode_surface_banks.log` | Bank decode logs. |
| `_work/logs/audio/list_*.log` | Wave listings (codec, rate, samples, loop). |
| `_work/audio/tyre-collision-evidence.json` | Verdict, 53 WAV hash checks, 18 routing checks, 7 tyre cases, impact gating/retrigger, mute, dispose, 0-console. |
| `_work/audio/tyre-collision-harness.png` | Harness screenshot, 1280×900, ≈100 KB. |
| `_work/logs/audio/tyre-collision-edge.log` | Edge stdout/stderr. |
| `_work/logs/audio/capture_tyre_collision.stdout.log` | Verifier summary. |

The 53 waves wired by the module:

<!-- WIRED-WAVES -->
| Wave | Bank | ch | loop | Duration (s) | WAV bytes | SHA-256 | Peak | RMS |
| --- | --- | ---: | :---: | ---: | ---: | --- | ---: | ---: |
| Asphalt_Road | Wheel_dry | 1 | yes | 2.944 | 282,668 | 7a30f32053ad3e4e34f20bc2b4b139edee8bcb1f942bd6585e808a9de8b425e8 | 0.8803 | 0.2726 |
| Asphalt_Lateral_1 | Wheel_dry | 1 | yes | 3.072 | 294,956 | 394b5359078a6bf7cd22ae0c523fba313f97efdbca522a88b1c87406fd5cb669 | 0.8774 | 0.3308 |
| Asphalt_Lateral_2 | Wheel_dry | 1 | yes | 2.872 | 275,756 | e2af185554671d43965bf812d5563d0ae219a1496ae50eda236002edce818e9e | 0.8467 | 0.3059 |
| Asphalt_Lateral_3 | Wheel_dry | 1 | yes | 2.960 | 284,204 | 2ef515b278be1efa4f7ed71bece9f52e3ea1056f7663d4bb0b2bab997a845c31 | 0.8815 | 0.4738 |
| Gravel_road | Wheel_offroad | 1 | yes | 3.496 | 335,660 | 996823a330b7cbcab34c2b11e21f8ae194f455b3d54f2f6b2c7005f90b19f117 | 0.8915 | 0.2148 |
| Gravel_skid | Wheel_offroad | 1 | yes | 2.968 | 284,972 | ce2f823d3dab7d99c00c7a06e3aedde4e0d1dc8795dc3828e44afb1719e50b74 | 0.8835 | 0.2890 |
| Dirt_road | Wheel_offroad | 1 | yes | 2.992 | 287,276 | f84385da7f3e45559f52ce20efe9210717350144fa80d170114b98e118e583cd | 0.8801 | 0.2381 |
| Dirt_skid | Wheel_offroad | 1 | yes | 3.872 | 371,756 | 4e5ba30cbfc505f6acbe2fee7bc5a1a447e8abcf090927ac176774e9521bab75 | 0.8797 | 0.3252 |
| Sand_road | Wheel_offroad | 1 | yes | 3.172 | 304,588 | adfc937240c1183b15db3b6d4889c1bcc190a90a54512e17d9bc045418c74d5d | 0.8734 | 0.2117 |
| Sand_skid | Wheel_offroad | 1 | yes | 2.626 | 252,170 | 410718899b4fcac8c16576ffbfceba11935b511eeca6778c95c11d496933ce46 | 0.9306 | 0.3276 |
| Foliage_road | Wheel_offroad | 1 | yes | 4.000 | 384,044 | a58f85e1164eafaa8a114c7ee01d8ed4fcfad9fcb0abad33ef2be3892359313d | 0.6510 | 0.0581 |
| imp_conchain01 | DO_concrete_fence_chain | 1 | no | 0.810 | 77,836 | 70ba4b69508836b79b6f8dacac34753090183ed2f1daddc8c3d0ef797b0c9d98 | 0.9922 | 0.3773 |
| imp_conchain02 | DO_concrete_fence_chain | 1 | no | 0.867 | 83,264 | 8215278426240191a9d66784c5c6a53213328bffc68f225ebc2f3cd64987ef3b | 0.9924 | 0.3752 |
| imp_conchain03 | DO_concrete_fence_chain | 1 | no | 0.795 | 76,372 | 85217d8ed8f1f39774a71fe97bc0137d3aeaaa7c586f764de7161c621e0ebc7d | 0.9921 | 0.3711 |
| imp_conplast01 | DO_concrete_fence_plastic | 1 | no | 0.790 | 75,872 | 923014806e4e0fe7bb65e152e16c3cedbc7233ef1d06e6dd6ba79a4d85720ab4 | 0.9642 | 0.3141 |
| imp_conplast02 | DO_concrete_fence_plastic | 1 | no | 0.801 | 76,908 | 062f8d735b6f28cf8cc0b624f5d6a85666518c59d23c09b86ee8702a28f4f8cb | 0.9607 | 0.2942 |
| imp_conplast03 | DO_concrete_fence_plastic | 1 | no | 0.669 | 64,240 | 17335bea239d1ba2f76da800dcc511235c6c30e783a8ed1ae1ebd28b84793848 | 0.9901 | 0.3105 |
| imp_concl01 | DO_concrete_large | 1 | no | 0.960 | 92,188 | 38c96aac56ab9fe83051f9474bd6b94a9da9b0247fe070df790401378c4b628d | 0.9596 | 0.3351 |
| imp_concl02 | DO_concrete_large | 1 | no | 0.992 | 95,260 | 2902146e44837d07dff33b28710a4a884b5982338c7f0dcc25ef2784eb015b48 | 0.9908 | 0.3291 |
| imp_concl03 | DO_concrete_large | 1 | no | 0.997 | 95,716 | 5f9a96ca5df9b16aa129e0760d8eb483c7ef75eba13121ff9a0bf90d1b0ffce1 | 0.9859 | 0.3516 |
| imp_glasshit01 | DO_glass_hit | 1 | no | 0.611 | 58,730 | 3b2ed499d143c3c2480d2f1cdf2fb1d10a353051d5a66e71b40b6c7686b7f72b | 0.9777 | 0.4243 |
| imp_glasshit02 | DO_glass_hit | 1 | no | 0.732 | 70,280 | 948e2fe3bd981620b4da6526682adae4ce9604ed41ad4fb1b521e27d28faef19 | 0.9885 | 0.3960 |
| imp_glasshit03 | DO_glass_hit | 1 | no | 0.671 | 64,508 | 66f6539986d276a0b42b3611c687b12ad59e4bd709266ebdcbb2ffcffba0b6c9 | 0.9863 | 0.3459 |
| imp_armco01 | DO_metal_armco | 1 | no | 0.656 | 63,056 | a16b0375d1792b2607f2f4c5d4825cff073dd39b5fecd6e3961640f4df412da6 | 0.9867 | 0.3953 |
| imp_armco02 | DO_metal_armco | 1 | no | 0.667 | 64,088 | e8a76b54d85e4ad801fc2000c9a7d22de5d15b1b55f455ad61333e802d0716a5 | 0.9915 | 0.3776 |
| imp_armco03 | DO_metal_armco | 1 | no | 0.617 | 59,312 | 74047a14c16357c63e64a6879ea98ba462801740e7b04fd53c687c609ba1883a | 0.9914 | 0.3872 |
| imp_metal_fence_chainlink01 | DO_metal_fence_chainlink | 1 | no | 1.307 | 125,476 | 257d2f72bad39571b34bec78356388cc07bbf63e84de5f7449834de60812c162 | 0.9854 | 0.3153 |
| imp_metal_fence_chainlink02 | DO_metal_fence_chainlink | 1 | no | 1.300 | 124,832 | 443abd04fcfbe27d97d453dc76f0e7073372f7300dc4f762997576b181e7ab6b | 0.9757 | 0.3055 |
| imp_metal_fence_chainlink03 | DO_metal_fence_chainlink | 1 | no | 1.322 | 126,958 | eb4850593edf6f81dd704537fe46e2cfe14ef00856e79bbf2f60ae0661a57f3f | 0.9883 | 0.3049 |
| imp_metholol01 | DO_metal_hollow_large | 1 | no | 1.575 | 151,232 | bc4a090aa23ae9db512dcac8d4c3844efa3ca02095d033c7fab348d54a253023 | 0.9631 | 0.4422 |
| imp_metholol02 | DO_metal_hollow_large | 1 | no | 1.540 | 147,916 | 1416298537526ecf447e80311a3cb33fe0c0eb7f06bf91a04f1ada05c1282fdd | 0.9623 | 0.4182 |
| imp_metholol03 | DO_metal_hollow_large | 1 | no | 1.643 | 157,780 | 489135be738286da98d9d32735f839dd6197539e4a3f818431fc5ef68df04939 | 0.9856 | 0.4681 |
| imp_metpostt01 | DO_metal_post_tall | 1 | no | 0.473 | 45,454 | 8f809aea7b2cca3366987f63509a29c741c54795cf6ba926c7dfc3840fb94aa4 | 0.9840 | 0.3751 |
| imp_metpostt02 | DO_metal_post_tall | 1 | no | 0.464 | 44,560 | 734136188e63b0a389d0b361ebe0672e8159b760e67810323e4eb7348c9cb5e0 | 0.9896 | 0.3293 |
| imp_metpostt03 | DO_metal_post_tall | 1 | no | 0.460 | 44,224 | 79fbf3da6d42ff44a7400666840810ed573c832abbb678e92d4275e0d17b8e19 | 0.9688 | 0.3273 |
| imp_metrailng01 | DO_metal_railing | 1 | no | 0.603 | 57,884 | e72e2806329d5db481093768f32a9f5b7839f3f28de45273d35c7af90e0bea9e | 0.9907 | 0.4284 |
| imp_metrailng02 | DO_metal_railing | 1 | no | 0.637 | 61,150 | 9608fd189c7df48133172a6f71d0219095bb1b18d5d0359e78f8102a88709e34 | 1.0186 | 0.4038 |
| imp_metrailng03 | DO_metal_railing | 1 | no | 0.842 | 80,920 | 89f060830b566bf78582f2a96cb13ee0b5e0e06c50f210466e0e50ea0b288689 | 0.9917 | 0.4176 |
| imp_metsheet01 | DO_metal_sheet | 1 | no | 0.826 | 79,322 | e120a59363925cfe4cbc714359f0a9ab2a50d7b7ca952538154002efabb8ac29 | 0.9787 | 0.4581 |
| imp_metsheet02 | DO_metal_sheet | 1 | no | 0.781 | 75,052 | de7efe5c55342f2b93d807d1ce4c87043d4818067e9dd9a66f15080cdae5f407 | 0.9962 | 0.4311 |
| imp_metsheet03 | DO_metal_sheet | 1 | no | 0.683 | 65,590 | 4d4384b18229064fce19dab31a4d247a999aa92094902e240b3d5728380eb12a | 0.9840 | 0.4212 |
| imp_metalsolidm01 | DO_metal_solid_medium | 1 | no | 0.809 | 77,698 | c81f3b3d16839e10d6399d63a7ad1a73b875110aa11fb60888f4a07b6926ac2c | 0.9884 | 0.3717 |
| imp_metalsolidm02 | DO_metal_solid_medium | 1 | no | 0.813 | 78,134 | dcae6dcb3ab42bb7ae7970326891c3506905267afd57f925e89d8bf249aea9f5 | 0.9746 | 0.3573 |
| imp_metalsolidm03 | DO_metal_solid_medium | 1 | no | 0.877 | 84,280 | ac8ae86b17bcf3b9d9fef8fb25581447b605d38c1e10c4263ba47de368e2e4ec | 0.9684 | 0.3641 |
| imp_tyre01 | DO_rubber_tyre | 1 | no | 0.289 | 27,776 | 658ec4cd079028339c0b612e3065e22696d20c7b95dc04db2849e908fba2220c | 0.9221 | 0.2388 |
| imp_tyre02 | DO_rubber_tyre | 1 | no | 0.303 | 29,160 | 6bb9a4a3a54afaa0b82ed00815f622edc46946580d5e5c062716ee37e7f0f61e | 0.9249 | 0.2790 |
| imp_tyre03 | DO_rubber_tyre | 1 | no | 0.334 | 32,092 | 7032c055beead6a3e36f7f6ba3f68b7bb316fb0a238b7ff29a850170563dcad5 | 0.9440 | 0.2697 |
| imp_veghedge01 | DO_vegetation_hedge | 1 | no | 1.023 | 98,244 | d84ff369e9a2e283771d5fdc7d2732f8fc60118c9724580727ebaa9d18bd2ead | 0.9914 | 0.2347 |
| imp_veghedge02 | DO_vegetation_hedge | 1 | no | 1.124 | 107,924 | 2d4248702f1a9037611248000245bca2af3318bc64e6a3dcb9d1fbfae9361a19 | 0.9770 | 0.2004 |
| imp_veghedge03 | DO_vegetation_hedge | 1 | no | 1.003 | 96,336 | 9496951a844fe72ade7dacfbfbb098f2489f0563b374dfd654bba7bf7e44c28f | 0.9922 | 0.1897 |
| imp_wood_fence01 | DO_wood_fence | 1 | no | 0.739 | 70,976 | ee41846a61d87ca8be7ea77475a45cf7cf184eaa952ce3c925cbe02510effc4c | 0.9630 | 0.2834 |
| imp_wood_fence02 | DO_wood_fence | 1 | no | 0.905 | 86,908 | 5282f83e6da91ae075b4cc3baa853f7dfe5f3528f9cc5651284444766c0b2c06 | 0.9903 | 0.2404 |
| imp_wood_fence03 | DO_wood_fence | 1 | no | 0.769 | 73,860 | f655e29d4bc78c89e72f77e99ec2ea01fa6ee0f98a683ad8af0b7037c556ed0d | 0.9655 | 0.2666 |

No game data, decoded fixture or generated WASM is committed. The decoded WAVs,
`.dat`/`.baf` copies and logs live under `_work/` only.

## 10. Non-claims

- Not full-game audio and not a retail-fidelity claim.
- Not the retail mixer/Ovis runtime; one active impact voice, deterministic
  round-robin instead of the random selector, no impact-filter decay,
  occlusion, tunnel, distance or pitch random.
- Not a claim that `WheelXSlide` is exactly the page's lateral-slip variable;
  it is the documented input mapping.
- Not a claim that the 18 material routes cover every effect material; values
  outside them are refused, not substituted.
- Not a claim that the do_* object-impact path equals the world-impact path.
- Verified in headless Microsoft Edge (Chromium) on Windows only.
