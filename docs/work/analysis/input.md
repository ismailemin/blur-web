# Retail input recovery and the standalone input layer

**Date:** 8 November 2026
**Owner:** INPUT1 (sub-agent)
**Scope:** `probes/input/**`, `_work/input/**`, `_work/logs/input/**`, this document.
No change to `probes/e1-drive/**`, `tools/`, `upstream/`, `game-data/` or any
committed build. No browser capture was run.

**Result:** the retail Blur PC action list, both keyboard layouts, the three
controller configurations, the 0.25 stick deadzone, the control-space curves and
the camera bindings are recovered with source/data provenance. A dependency-free
input layer (`probes/input/input.mjs`) implements keyboard + Gamepad polling,
deadzone normalisation, per-action mapping, rebinding/persistence and a
deterministic state export. **359/359** verifier checks pass, including a
synthetic Gamepad API test and a read-only comparison with the PoC input block.
Physical-controller verification is **not** claimed; it is a documented manual
check.

---

## 1. Sources and provenance

| evidence | path | identity |
| --- | --- | --- |
| action enum | `upstream/BlurRebuilt/code/amax/game/Game/GameControls/GameControls.h:23-63` | `E_Button_Throttle` = framework count (32) … `E_Button_UsePickupBackward` = 60 |
| axis enum | `.../GameControls.h:94-108` | `E_Axis_Steering`, `E_Axis_DigitalSteering`, `E_Axis_Pitch`, photo axes |
| keyboard layout 0/1 | `.../GameControls.cpp:110-130` | `kKeyLayoutButtons`, 18 rows, two key columns |
| keyboard axis 0/1 | `.../GameControls.cpp:166-174` | `kKeyLayoutAxes`, 6 rows, two key columns |
| split-screen table | `.../GameControls.cpp:132-152`, `176-184` | captured in `_work/input/retail-input.json`, not used by the module |
| pad setup | `.../GameControls.cpp:249-382` | every game button combines keyboard + `C_ControlConfig` pad input |
| boot defaults | `.../GameControls.cpp:391-395` | layout 0, no pad game buttons at boot |
| pad config XT type | `upstream/.../amax/library/Ui/UiXtConfig.h:117-150`, `UiXtConfig.cpp:51-63` | `C_ControlConfig` / `UiXtControlConfig` |
| pad config load | `.../UiXtConfig.cpp:437-438` | `m_ControlConfigs[mControlIndex]` passed to `SetupAmaxUserControlsPC` |
| profile defaults | `upstream/.../Profile/GameProfile.cpp:48`, `233-234`, `269-270` | keyboard layout 0, control index 0, camera 0 |
| assist fields | `upstream/.../Profile/GameProfile.h:72-77`, `98-103` | `mSteeringAssist` and `mBrakingAssist` are **commented out** |
| deadzone value | `upstream/.../input/Pad360.cpp:15` | `m_StickDeadzone(0.25f)` |
| deadzone formula | `upstream/.../input/Input.cpp:10-32` | radial deadzone, `(len-d)/(1-d)`, clamp 1 |
| pad axis conversion | `upstream/.../input/Pad360.cpp:8-11`, `76-82` | `(value-0.5)/32767.5`, both sticks |
| axis combiners | `upstream/.../input/GameInputMapping.cpp:235-245`, `270-273`, `298-306` | axes sum; button-axis = positive − negative; digital buttons ±1 at 0.1 |
| pressed threshold | `upstream/.../input/GameInput.cpp:178`, `212-220` | 0.1 |
| control read | `upstream/.../RaceLogicCore/Core/RaceLogicCore.cpp:861-896` | throttle/brake values, steering clamped to [-1,1], handbrake > 0.5 |
| steering curve | `upstream/.../physics/racingphysics/.../Car/car.cpp:818-821` | `steer * |steer|`, then exponential smoothing |
| throttle/brake curves | `.../car.cpp:799-801`, `812-814`, `825-827` | exponential smoothing, per-car `*SmoothTime` |
| speed-sensitive steer limit | `.../car.cpp:1216-1223`, `1609-1645` | physics-side, not input-side |
| traction control | `.../car.cpp:1447-1465` | per-car physics rule, no player toggle |
| camera cycle | `upstream/.../AmaxCam/VehicleFeed.cpp:184-217` | debounced `ChangeView`, blend 0.5 s / 0 s |
| camera count | `upstream/.../AmaxCam/VFCamera.h:7-12` | Hollywood 0, Bumper 1 |
| look / rear view | `.../VehicleFeed.cpp:239-254`, `244-248` | FlyRotate axes; rear view forces `m_LookY = -1` |
| look axes | `upstream/.../framework/.../UserControls.cpp:283-286`, `338-339` | pad right stick + mouse deltas |
| XT data | `game-data/Blur/cache/gamedata.pak` `\gamedata\xt\ui.bin` | pak SHA-256 `e013f8b795ce8b2a48f9cc83cbc7cf48126a08711b26e7cbc6341661b8fd582b` |
| decoded XT | in memory / `_work/powerups/ui.xt` | **1,004,480 B**, SHA-256 `e7fd10138524b7e0912561a797cd037a3a6d82b0859750f74ebf8f8ea9f67691` |
| car parameters | `_work/e1-drive/cars/*.fields` ← `gamedata\xt\racingphysics.bin` | 62 `RP_CarDynamics` records decoded by `engine/harness/t005d-vehicle/car_xt.py` |

`gamedata.pak` entry: `\gamedata\xt\ui.bin`, PAK offset **22,589,440**, stored
**249,271 B**, logical **1,004,480 B**, zlib stream (checked EOF, length and no
unused bytes by the extractor).

### 1.1 Exact XT identity of the controller configurations

| field | value |
| --- | --- |
| record | **95**, id **1,934,272,550**, type `UiXtConfig` (type 4) |
| decoded record payload | 2,852 B |
| field | `ControlConfigs`, **offset 552** |
| array | component **10**, element **0**, length **3** |
| element type | **48** `UiXtControlConfig`, **44 B** |

`UiXtControlConfig` field offsets (same record layout, 44 B element):

| field | offset | field | offset |
| --- | ---: | --- | ---: |
| `name` | 0 | `FunctionRB` | 32 |
| `FunctionA` | 4 | `FunctionLThumb` | 36 |
| `FunctionB` | 8 | `FunctionRThumb` | 40 |
| `FunctionX` | 12 | | |
| `FunctionY` | 16 | | |
| `FunctionLT` | 20 | | |
| `FunctionRT` | 24 | | |
| `FunctionLB` | 28 | | |

The three records are named by their `XtLocId` in
`\gamedata\xt\loc\common.loc`:

| index | loc id | name |
| ---: | --- | --- |
| 0 | `0xb0b65c46` | `CMN_CONTROLLER_CONFIG_1` |
| 1 | `0x77d25e4f` | `CMN_CONTROLLER_CONFIG_2` |
| 2 | `0x4956e65b` | `CMN_CONTROLLER_CONFIG_3` |

No pad configuration with a value not present in the XT was invented. The
`FunctionA/B/X/Y/LT/RT/LB/RB/LThumb/RThumb` → XInput button mapping is the one the
recovered `C_ControlConfig::CreateButtonInput` uses.

---

## 2. Action list

29 game actions, retail indices **32–60**, in enum order (the module exports the
same list with the same indices):

`Throttle, Brake, Handbrake, GearUp, GearDown, ChangeView, ResetVehicle,
UsePickup, DiscardPickup, SwitchPickup, SwitchPickupLeft, SwitchPickupAlt,
UseShield, UseSecondTierPickup, Auto_Shuffle_Perks, Convert_To_Health,
Clone_Selected_Perk, Fullhouse, UsePickupAlt, PhotoRoll, PhotoZoom,
PhotoRollReset, PhotoZoomReset, FireSlot1, FireSlot2, FireSlot3, RearView,
UsePickupForward, UsePickupBackward`.

The PC keyboard table binds only 18 of them; `GearUp`, `GearDown`,
`ResetVehicle`, `UseShield`, `UseSecondTierPickup`, the perk actions, the fire
slots and `UsePickupAlt` have **no PC keyboard row**. The pad configuration can
bind a subset; anything absent from the configuration has **no pad input** (the
only fallback is for the four photo buttons, `GameControls.cpp:236-247`). This is
an absence, not a hidden default.

---

## 3. Keyboard layouts

Retail has two complete layouts. Layout **0** is the fresh-profile default
(`GameProfile.cpp:48`); layout 1 is the W/S + A/D layout. Both are alternative,
not additive: the PoC's hybrid (W/S **and** arrows) is not a retail layout.

| action | retail label | idx | layout 0 | layout 1 |
| --- | --- | ---: | --- | --- |
| throttle | Throttle | 32 | `KeyQ` | `KeyW` |
| brake | Brake | 33 | `KeyA` | `KeyS` |
| handbrake | Handbrake | 34 | `ArrowDown` | `Space` |
| gearUp | GearUp | 35 | — | — |
| gearDown | GearDown | 36 | — | — |
| changeView | ChangeView | 37 | `KeyV` | `KeyZ` |
| resetVehicle | ResetVehicle | 38 | — | — |
| usePickup | UsePickup | 39 | `ControlRight` | `ControlRight` |
| discardPickup | DiscardPickup | 40 | `KeyD` | `ArrowRight` |
| switchPickup | SwitchPickup | 41 | `ArrowUp` | `ArrowLeft` |
| switchPickupLeft | SwitchPickupLeft | 42 | — | — |
| switchPickupAlt | SwitchPickupAlt | 43 | — | — |
| useShield | UseShield | 44 | — | — |
| useSecondTierPickup | UseSecondTierPickup | 45 | — | — |
| autoShufflePerks | Auto_Shuffle_Perks | 46 | — | — |
| convertToHealth | Convert_To_Health | 47 | — | — |
| cloneSelectedPerk | Clone_Selected_Perk | 48 | — | — |
| fullhouse | Fullhouse | 49 | — | — |
| usePickupAlt | UsePickupAlt | 50 | — | — |
| photoRoll | PhotoRoll | 51 | `End` | `End` |
| photoZoom | PhotoZoom | 52 | `NumpadAdd` | `NumpadAdd` |
| photoRollReset | PhotoRollReset | 53 | `KeyR` | `KeyR` |
| photoZoomReset | PhotoZoomReset | 54 | `KeyQ` | `KeyQ` |
| fireSlot1 | FireSlot1 | 55 | — | — |
| fireSlot2 | FireSlot2 | 56 | — | — |
| fireSlot3 | FireSlot3 | 57 | — | — |
| rearView | RearView | 58 | `Tab` | `PageDown` |
| usePickupForward | UsePickupForward | 59 | `KeyW` | `ArrowUp` |
| usePickupBackward | UsePickupBackward | 60 | `KeyS` | `ArrowDown` |

Steering axes:

| layout | negative | positive | pad (same for both) |
| --- | --- | --- | --- |
| 0 | `ArrowLeft` | `ArrowRight` | left stick X + D-pad left/right |
| 1 | `KeyA` | `KeyD` | left stick X + D-pad left/right |

Notes:

- `PhotoZoomReset` is `Q` in both layouts and `PhotoRollReset` is `R` in both.
  These are **photo-camera-mode** actions; the module scopes them to `photo`, so
  they are not reported as driving conflicts. The e1 page's existing `R`
  restart shortcut is a page shortcut, not a retail driving binding.
- Layout 0's `W`/`S` are `UsePickupForward`/`UsePickupBackward`; layout 1's
  `ArrowUp`/`ArrowDown` take those roles. This is why the PoC's W/S + arrows
  hybrid has no single retail equivalent.
- `Space` is handbrake in layout 1 only. In layout 0 `Space` is the menu Confirm
  key (`GameControls.cpp:198`), not a driving key.
- The browser mapping uses the **physical** `KeyboardEvent.code` (`KeyQ`,
  `ArrowDown`, `Space`, …), not `event.key`, so layout/shift state cannot change
  which action fires. The retail enum is a DirectInput scan-code index; the
  name-to-code table is explicit and tested, not a byte-identical claim.

---

## 4. Controller configurations

The pad always steers with the **left stick X**; D-pad left/right is summed into
the same axis (`GameControls.cpp:169-170`). Pitch is left stick Y plus D-pad
up/down. The right stick is not a game action axis; it feeds camera look.

| action | config 0 (default) | config 1 | config 2 |
| --- | --- | --- | --- |
| throttle | `RightTrigger` | `RightTrigger` | `A` |
| brake | `LeftTrigger` | `LeftTrigger` | `B` |
| handbrake | `B` | `Y` | `RightTrigger` |
| changeView | `RightShoulder` | `RightShoulder` | `RightShoulder` |
| usePickup | `A` | `A` | `X` |
| discardPickup | `Y` | `LeftShoulder` | `Y` |
| switchPickup | `X` | — | `LeftShoulder` |
| switchPickupLeft | — | `X` | — |
| switchPickupAlt | `LeftShoulder` | `B` | — |

All other actions are unbound on the pad in every configuration. `RearView` has
no pad field at all and is keyboard-only on PC; `ResetVehicle` and `GearUp/Down`
are likewise not in the PC pad table.

Synthetic Gamepad API mapping used by the module (`standard` only):

| retail | W3C index | retail | W3C index |
| --- | ---: | --- | ---: |
| A | 0 | LeftTrigger | 6 |
| B | 1 | RightTrigger | 7 |
| X | 2 | Back | 8 |
| Y | 3 | Start | 9 |
| LeftShoulder | 4 | LeftThumb | 10 |
| RightShoulder | 5 | RightThumb | 11 |
| DPadUp | 12 | DPadDown | 13 |
| DPadLeft | 14 | DPadRight | 15 |

Axes: left X 0, left Y 1, right X 2, right Y 3. The W3C standard mapping has
**+Y down**; XInput has **+Y up** (`Pad360.cpp:76-79` passes `sThumbLY` through).
The module negates Y for both sticks so the retail sense is preserved. A pad
whose `mapping` is not `standard` is reported and ignored, never reinterpreted by
index.

---

## 5. Deadzone and normalisation

Retail applies a **radial** deadzone with linear rescale to both sticks
(`Input.cpp:10-32`):

```text
len2 = x*x + y*y
if len2 <= d*d:            x = y = 0
else:                      newLen = (sqrt(len2) - d) / (1 - d)
                           newLen = min(newLen, 1)
                           x *= newLen / sqrt(len2);  y *= newLen / sqrt(len2)
```

`d = 0.25` (`Pad360.cpp:15`); no call to `SetStickDeadzone` exists in the
recovered game source, so 0.25 is fixed in practice.

Consequences the verifier checks:

- `(0.2, 0.2)` is **outside** the deadzone (magnitude 0.283), even though each
  component is below 0.25. A per-axis deadzone would be wrong.
- `(0.5, 0)` → `1/3`; `(1, 0)` → `1`; `(2, 0)` → `1` (clamped).
- Direction is preserved; output is monotonic along a ray.

XInput int16 → float conversion is `(value - 0.5) / 32767.5` (`Pad360.cpp:8-11`),
giving 24,575 positive steps above the 0.25 deadzone. The browser Gamepad API
already reports float axes in [-1, 1]; the module therefore does not re-quantise
to int16. The two representations can differ by up to ~1.5e-5.

---

## 6. Control-space curves

These are **physics-side**, in the car, not in the input table. The e1 wasm
already runs them. The input layer exports the unshaped value so the same
shaping is not applied twice.

| control | retail behaviour | source |
| --- | --- | --- |
| steering | `target = steer * |steer|`, then `state = state*f + target*(1-f)` with `f = exp(-dt/(steerSmoothTime+0.001))` | `car.cpp:818-821` |
| throttle | exponential smoothing with `throttleSmoothTime` | `car.cpp:799-801` |
| brake | exponential smoothing with `brakeSmoothTime` | `car.cpp:812-814` |
| handbrake | exponential smoothing with `handbrakeSmoothTime`; race logic sends a boolean (`> 0.5`) | `car.cpp:825-827`, `RaceLogicCore.cpp:895` |

Per-car values (decoded from the XT; the five e1 roster cars):

| car | mass kg | steerSmoothTime s | throttleSmoothTime s | brakeSmoothTime s | handbrakeSmoothTime s | tractionControlMaxSpin |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `corvette-zr1-stock` (default) | 1600 | 0.1400 | 0.0099999998 | 0.1000000015 | 0 | 100 |
| `lotus-exige-cup260-stock` | 890 | 0.1350 | 0.0099999998 | 0.1000000015 | 0 | 9 |
| `dodge-challenger-stock` | 1700 | 0.1670 | 0.0099999998 | 0.1000000015 | 0 | 9 |
| `ford-focusrs-stock` | 1400 | 0.1100 | 0.0099999998 | 0.1000000015 | 0 | 9 |
| `audi-r8v10-stock` | 1600 | 0.1250 | 0.0099999998 | 0.1000000015 | 0 | 9 |

Across all 25 decoded `.fields` present in `_work/e1-drive/cars/`:
`steerSmoothTime` **0.110–0.175 s**; `steerDamping` **0.115–0.185**;
`slideRecovery` **0.59–1.20**; `antiFlick` **1.18–2.0**;
`tractionControlMaxSpin` **9 or 100**; `tractionControlMaxSlip` **100**;
`wheelSpinMaxSpeed_Mph` **0 or 10–10.333**; `steerLimit` **1.0 rad** for every car.

`steerLimit` is the hard clamp; the *speed-sensitive* limit is computed from
lateral grip and turn radius (`car.cpp:1216-1223`, `1609-1645`). That is physics,
not an input curve. The input layer must not add its own speed scaling.

One-tick step response at 1/60 s (useful for the PoC comparison):

| axis | factor `f` | value after 1 tick |
| --- | ---: | ---: |
| steer (τ 0.14) | 0.888515 | 0.111485 |
| throttle (τ 0.01) | 0.219775 | 0.780225 |
| brake (τ 0.1) | 0.847880 | 0.152120 |
| handbrake (τ 0) | 0.000000 | 1.000000 |

Steering reaches 63.2% of its target at about **9 ticks** (0.15 s) with the
Corvette constant.

---

## 7. Assists: what retail does and does not have

| assist | finding | evidence |
| --- | --- | --- |
| steering assist | **absent**. `mSteeringAssist` is a commented-out option field, and no consumer exists. | `GameProfile.h:73`, `99` |
| braking assist | **absent**. `mBrakingAssist` is also commented out. | `GameProfile.h:74`, `100` |
| ABS | **no ABS module/flag found** in the recovered input, profile or car-settings source. Braking is front/rear brake force + smooth time. | `carsettings.h:118-127`; no `ABS` symbol in the input/profile path |
| traction control | **present, always on, per car**; not a player option. Spin/slip limits are `tractionControlMaxSpin` / `tractionControlMaxSlip`, used in the driven-wheel loop. | `car.cpp:1447-1465`; `carsettings.h:141-142` |
| auto pickup | a profile option (`mAutoPickup`, default 0), but it is a pickup-use convenience, not a driving assist. | `GameProfile.cpp:232` |

The module therefore reports `steeringAssist:false`, `brakingAssist:false`,
`abs:false`, `tractionControl:'physics'`. These are **absences**, not
zero-valued retail sliders.

---

## 8. Camera controls

| control | binding | behaviour |
| --- | --- | --- |
| change view | `V` (layout 0), `Z` (layout 1), pad `RB` | debounced; cycles `Hollywood` (0) ↔ `Bumper` (1); blend 0.5 s, 0 s into Bumper |
| rear view | `Tab` (layout 0), `PageDown` (layout 1) | while held, `lookX = 0`, `lookY = -1` (look straight back) |
| look around | pad right stick, mouse deltas | `FlyRotateX/Y` axes; magnitude ≥ 0.2 yields a look angle |

Sources: `VehicleFeed.cpp:184-217` (cycle, blend), `239-254` (look), `244-248`
(rear view), `VFCamera.h:7-12` (two cameras), `UserControls.cpp:283-286`
(right stick), `338-339` (mouse deltas). Camera type is persisted in
`mOptions.mCameraType` (`VehicleFeed.cpp:213-215`) with default 0
(`GameProfile.cpp:234`).

The mouse path is frame-rate normalised by `MousePC.cpp:39`
(`delta / deltaTime * sensitivity * 0.01`). That is a debug-style normalisation,
not a portable per-frame delta, so the layer exposes a `mouseSource` injection
point and does not claim a browser mouse-look implementation.

The PoC instead uses **mouse drag orbit + wheel zoom**. Those are presentation
controls added by the PoC; they are not retail gameplay bindings.

---

## 9. Comparison with the PoC input block

PoC source: `probes/e1-drive/web/app.js:1234-1325` (read-only).
Retail: layout 0 is the fresh-profile default; layout 1 is the alternative.

### 9.1 Bindings (end-to-end differences)

| control | PoC (`app.js`) | retail layout 0 (default) | retail layout 1 |
| --- | --- | --- | --- |
| throttle | `W` / `ArrowUp` | `Q` | `W` |
| brake | `S` / `ArrowDown` | `A` | `S` |
| handbrake | `Space` | `ArrowDown` | `Space` |
| steer left | `A` / `ArrowLeft` | `ArrowLeft` | `A` |
| steer right | `D` / `ArrowRight` | `ArrowRight` | `D` |
| change view | — | `V` | `Z` |
| rear view | — | `Tab` | `PageDown` |
| pickups | — | `RControl`, `W`, `S`, `D`, `ArrowUp` | `RControl`, `ArrowUp`, `ArrowDown`, `ArrowRight`, `ArrowLeft` |
| steering sign | **−1** by default (`?invertSteer=0` restores +1) | +1 | +1 |
| gamepad | none | config 0 | config 0 |
| deadzone | none | 0.25 (pad) | 0.25 (pad) |

The PoC is a hybrid of the two layouts: it uses layout 1's W/S/Space **and**
layout 0's arrow steering, and it maps both A/D and left/right arrows to
steering. Retail never activates both layouts together. The PoC's default
steering sign is also inverted relative to retail (`D` produces −1 instead of
+1; numeric delta **−2** on that input).

### 9.2 Latent differences (only visible with analog input)

The PoC input block is digital only. Its keyboard values are exactly the retail
digital values (±1, 0), and the e1 wasm already applies the retail square +
smoothing to whatever reaches `e1_set_input`. So the following are **not**
end-to-end numeric errors for the PoC keyboard path; they are the differences
that appear as soon as a gamepad or any analog source exists.

| quantity | PoC input block | retail | delta |
| --- | ---: | ---: | ---: |
| deadzone | 0 | 0.25 | +0.25 |
| steer transfer at 0.5 | 0.5 | 0.25 (`x·|x|`) | −0.25 (−50%) |
| steer transfer at 0.25 | 0.25 | 0.0625 | −0.1875 (−75%) |
| steer levels, keyboard | 3 (−1/0/+1) | 3 | 0 |
| steer levels, pad | — | 24,575 positive steps above deadzone | +24,575 |
| throttle levels | 2 (0/1) | 256 (trigger /255) | +254 |
| steer after 1 tick | 1.0 (no input smoothing) | 0.111485 | −0.888515 |
| steer 63.2% | 1 tick | 9 ticks | +8 ticks |
| throttle after 1 tick | 1.0 | 0.780225 | −0.219775 |
| brake after 1 tick | 1.0 | 0.152120 | −0.847880 |
| handbrake after 1 tick | 1.0 | 1.0 | 0 |
| pitch/camera look | none | right stick + mouse | — |

The last table is why the input layer exports `engineInput` **unshaped**: the
wasm owns the retail curves. `state.shaping` is an opt-in diagnostic preview
(`shapePreview:true`) for HUD/telemetry, never a value to feed back into
`e1_set_input`.

The verifier reads `app.js` and asserts the PoC patterns above, so these deltas
are checks against the current file, not a hand-written claim.

---

## 10. Module

`probes/input/input.mjs` — dependency-free ESM, browser and Node compatible.
No `window`/`navigator` access at import time.

### 10.1 Construction

```js
import { createInputLayer } from './input.mjs';

const input = createInputLayer({
  keyboardLayout: 0,        // retail default; 1 = W/S + A/D
  padConfig: 0,             // retail default; 1 or 2
  deadzone: 0.25,           // Pad360 default
  steerSign: 1,             // retail; -1 preserves the old PoC default
  padIndex: null,           // null = first connected standard pad
  requireStandardMapping: true,
  gamepadSource: undefined, // default: navigator.getGamepads()
  mouseSource: null,        // optional () => ({ dx, dy })
  shapePreview: false,      // diagnostic only
  carParams: { steerSmoothTime: 0.14, throttleSmoothTime: 0.01,
               brakeSmoothTime: 0.1, handbrakeSmoothTime: 0 }
});
input.attach(window);       // keydown/keyup/blur; page shortcuts stay outside
```

### 10.2 Sampling

```js
const state = input.sample(1 / 60);
```

`sample()` is tick-based: it increments `state.tick`, reads held keys and the
current pad, and returns a frozen state. It never reads the wall clock, never
uses `Math.random`, and produces the same canonical JSON/hash for the same input
sequence (checked over 60 samples).

State shape:

```js
{
  schema: 'blur.input-state', version: 1, tick: 1, source: 'device' | 'net',
  devices: { keyboard: true, pad: { connected, index, mapping, connects, disconnects, rejectedMappings } },
  actions: { throttle: 0..1, brake: 0..1, handbrake: 0..1, changeView: 0..1, ... }, // all 29
  pressed: ['changeView', ...],                       // rising edges, threshold 0.1
  axes: { steer, pitch, keyboardSteer, padSteer, lookX, lookY },
  controls: { throttle, brake, steer, handbrake, handbrakeRaw },
  engineInput: [throttle, brake, steer, handbrake],   // e1_set_input order
  netInput: { throttle, brake, steer, handbrake },    // 4-decimal net-mvp shape
  camera: { changeViewPressed, rearView, lookX, lookY },
  shaping: null | { throttle, brake, steer, handbrake },
  raw: { heldKeys, padAxes, padButtons },             // diagnostics/replay
  assists: { steeringAssist: false, brakingAssist: false, abs: false, tractionControl: 'physics' }
}
```

Ranges: throttle/brake **0..1**, steer **−1..1**, `controls.handbrake` **0/1**
(retail `> 0.5`), `controls.handbrakeRaw` **0..1**, `engineInput[3]` **0/1**.

`netInput.handbrake` is the raw 0..1 value (quantised), so a 4-decimal net packet
round-trips exactly even though the engine receives 0/1. This preserves the
sender's trigger position without changing the physics input.

### 10.3 Rebinding and persistence

```js
input.rebindAction('throttle', 'keyboard', 'KeyI');
input.rebindAction('throttle', 'pad', 'A');
input.addActionBinding('brake', 'keyboard', 'KeyB');
input.unbindAction('brake', 'keyboard', 'KeyB');
input.rebindSteer('KeyJ', 'KeyL');
input.setKeyboardLayout(1);
input.setPadConfig(2);
input.setDeadzone(0.3);

const saved = input.serializeBindings();
input.applyBindings(saved);
input.saveBindings(localStorage);       // key: blur.input.bindings
input.loadBindings(localStorage);
input.resetBindings();
input.findConflicts('keyboard');        // [{ device, code, context, actions }]
```

Validation rejects a wrong schema/version, unknown action ids, unknown pad
buttons/axes, invalid keyboard codes, duplicate codes, and out-of-range
deadzones. `loadBindings` returns `false` when the key is absent (no silent
fallback to a different record). Defaults are the retail ones, not the PoC's.

`findConflicts` is **context-scoped**: `photoZoomReset` on `Q` is not a conflict
with `throttle` on `Q` because the photo camera and driving modes are separate.
Within a context, a code bound to two actions or to both steering directions is
reported.

### 10.4 Deterministic export

`exportState()` returns the last state; `stateJson()` sorts object keys;
`stateHash()` is FNV-1a 32 over that JSON for cheap replay equality. For network
packets use `exportNetInput()` and the existing net-mvp canonical hash, not this
diagnostic hash.

`applyNetInput({ throttle, brake, steer, handbrake })` applies one sample from a
recorded/remote packet, then clears itself. Validation is stricter than the
generic net-mvp `checkInput`: throttle/brake/handbrake must be 0..1 and steer
−1..1, because that is what the retail control space and `e1_set_input` accept.

---

## 11. Verification

```powershell
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe probes/input/tools/extract_retail_input.py
node probes/input/verify_input.mjs
```

`_work/input/verify.json`: **PASS, 359/359 checks, 0 failures**.

| group | checks | what it covers |
| --- | ---: | --- |
| A | 175 | every embedded keyboard/pad binding against the independent extraction; action list; defaults; deadzone; per-car constants |
| B | 14 | radial deadzone: circularity, exact boundary, rescale, clamp, symmetry, monotonicity |
| C | 13 | signed-square curve, smoothing constant, one-tick response, handbrake tau |
| D | 27 | keyboard layouts 0/1, opposing keys, layout isolation, steer sign, attach/detach/blur |
| E | 33 | all three pad configs, analog triggers, stick deadzone, D-pad, right-stick look, mapping rejection, threshold |
| F | 29 | rebinding, unbinding, serialise/apply, persistence, validation, conflicts, reset |
| G | 24 | deterministic state/hash, net quantisation, net override one-shot, canonical JSON |
| H | 18 | disconnect/reconnect, no stuck throttle, broken source, pad selection, listener lifecycle |
| I | 17 | read-only PoC-delta checks against `app.js` |
| J | 9 | integration contract: export names, `e1_set_input` order, net-mvp fields |

Independent evidence: `probes/input/tools/extract_retail_input.py` re-extracts
`\gamedata\xt\ui.bin` from `gamedata.pak`, checks the zlib stream, decodes
`UiXtConfig` record 95 with the committed `xt_decode.py`, parses the retail
`GameControls.cpp` tables, and decodes the per-car `.fields`. The verifier
compares the module's tables to that output; a transcription error fails a
check.

**Not proven:** the gamepad path is exercised through the module's deterministic
Gamepad API stub, not a physical controller. No browser capture was run. The
manual check is section 12.

---

## 12. Manual controller check (not executed)

```powershell
node probes/input/serve.mjs --port 8812
# open http://127.0.0.1:8812/
```

The page (`probes/input/manual.html`) shows live pad identity/mapping, raw axes
and buttons, deadzone-normalised controls, camera look, and the exact state JSON.
The on-page steps require a human with an XInput-compatible pad:

1. Connect the pad before opening, press a button once (Gamepad API visibility).
2. Confirm `standard` mapping and `connected`.
3. RT/LT must produce analog 0..1 throttle/brake; the left stick must be zero
   inside the 25% radial deadzone and reach ±1 at the rim; D-pad left/right must
   steer.
4. Config 0: B handbrake, A use pickup, RB change-view edge. Config 1/2 change
   these; switch with the buttons.
5. Right stick must move `lookX/lookY`; rear view must force `lookY = -1`.
6. Unplug while holding RT: no stuck throttle; reconnect must not restore a stale
   value.
7. Keyboard layouts 0/1 must match the table in section 3.

A hardware result is **not claimed** in this record. When it is run, record the
pad name, mapping, the observed values and any mismatch here.

---

## 13. Integration contract for the e1 drive slice

`probes/e1-drive/**` is not modified by this task. The exact replacement point:

| current code | location | replacement |
| --- | --- | --- |
| `const keys = new Set()` | `app.js:1236` | delete; the layer owns held driving keys |
| driving-key lines in `keydown` | `app.js:1289-1290` | delete `keys.add(...)` / arrow `preventDefault`; keep G/I/M/R/E shortcuts in their own listener |
| `keyup` / `blur` | `app.js:1292-1293` | `input.detach()` replaces the key bookkeeping; the layer's own blur handler clears keys |
| `function keyboardInput()` | `app.js:1318-1325` | `return input.sample(1 / 60).engineInput;` |
| `currentInput(tick)` manual branch | `app.js:2694` | `return sprintRules.gateInput(input.sample(1 / 60).engineInput);` |
| `engine.setInput(input)` | `app.js:2637` | unchanged; the array order already matches |
| per-tick step loop | `app.js:6574` | call `input.sample(1 / 60)` once per **engine tick**, then `engine.setInput(...)` |

Do **not** route `?script=drive`, `?script=sprint`, telemetry or soak through the
layer: those are deterministic scripted modes and must keep their byte-identical
hashes. Only the manual (`/`) branch changes.

Recommended construction in the page:

```js
import { createInputLayer } from '/input/input.mjs';

const input = createInputLayer({
  keyboardLayout: 0,       // retail default; ?layout=1 opt-in
  padConfig: 0,
  steerSign: 1             // retail; pass -1 only to preserve the old PoC default
});
input.attach(window);
```

The page's existing `?invertSteer=`/`I` toggle is a PoC user preference. If it is
kept, map `?invertSteer=0` to `steerSign:-1` and the default to `+1`; the
retail-correct default is +1. `?invertSteer=0` in the old page already produced
+1, so the migration can preserve that value while changing the default.

### 13.1 State shape the physics step expects

`e1_set_input(throttle, brake, steer, handbrake)` (wasm signature in
`probes/e1-drive/native/e1_drive_lib.cpp`; page wrapper `app.js:2637`):

| index | field | range | source |
| ---: | --- | --- | --- |
| 0 | throttle | 0..1 | `actions.throttle` (max of keyboard/pad) |
| 1 | brake | 0..1 | `actions.brake` |
| 2 | steer | −1..1 | keyboard steering axis + left stick X + D-pad, clamped |
| 3 | handbrake | 0/1 | raw handbrake `> 0.5` |

The wasm internally applies `steer*|steer|` and the per-car smoothing. The layer
must pass `state.engineInput`, **not** `state.shaping`. `state.controls.steer`
is the same value; `state.axes.keyboardSteer/padSteer` are the pre-sum parts for
HUD/debug.

### 13.2 Net input packets

`probes/net-mvp/protocol.mjs:204-227` defines the packet shape:

```js
{ throttle, brake, steer, handbrake }   // finite, [-1,1], quantised to 4 decimals
```

Map it directly:

```js
mpNet.sendInput(input.exportNetInput(), logicalTick);
```

On the receiving side, either feed the recorded packet into the remote
simulation, or for a one-shot local check:

```js
input.applyNetInput(packet);        // validates 0..1 / -1..1
const state = input.sample(1 / 60); // source === 'net'
```

`state.netInput` is exactly the packet shape, so a local send followed by
`applyNetInput` round-trips at 4 decimals. The net handbrake is analog raw;
the engine input is thresholded to 0/1 by the layer (retail
`RaceLogicCore.cpp:895`). The remote therefore gets the same physics input as
the sender.

The existing `mp` path sends `snapshot.input` (`app.js:4466`), which is the
wasm-echoed 4-array. That is the same values as `state.engineInput`; either is
valid, but `exportNetInput()` is the documented input-layer contract and carries
the analog handbrake.

### 13.3 Determinism

- One `sample(1/60)` per engine tick; no wall clock, no frame count.
- Same held keys + same pad values + same net overrides + same tick count →
  identical `stateJson()` / `stateHash()`.
- `pressed` is a per-tick rising edge (0.1 threshold), so a change-view held
  across several ticks fires once, like `GetButtonPressedDebounced`.
- Scripted modes remain on their own input functions and hashes.

---

## 14. Limits

- **No physical gamepad was tested.** The stub test proves the code path, the
  disconnect handling and the mapping; it does not prove a driver, a browser, a
  specific pad or a specific OS.
- **No browser capture was run** (task instruction). The manual page is provided
  and documented; no console-clean/screenshot claim is made here.
- **Browser `event.code` is a physical-key convention**, not the retail
  DirectInput scan-code index. The name→code table is explicit and covered by
  the verifier; a keyboard with a non-US physical layout uses the same physical
  keys, which is the intent, but it is not a byte-identical retail key code.
- **Pad axis quantisation differs**: retail `(int16-0.5)/32767.5` vs browser
  float axes. No byte-identical pad trace claim.
- **Non-standard mappings are refused**, not guessed. A browser that reports a
  non-standard pad will show `connected:false` and `rejectedMappings>0`.
- **No rumble/force feedback.** `Pad360.cpp` has rumble, but the input layer does
  not model it.
- **No mouse-look implementation.** `mouseSource` is an injection point; the
  retail mouse path is frame-time normalised (`MousePC.cpp:39`) and was not
  ported.
- **Split-screen keyboard table is captured but not used** by the module; it has
  a different key set (`GameControls.cpp:132-152`).
- **No steering/braking assist or ABS** exists in the retail PC profile; the
  layer reports that absence. Do not add a "retail" assist slider.
- **The signed-square/smoothing values are physics-side.** Passing `shaping`
  into `e1_set_input` would double-apply them.
- **`steerLimit` is 1.0 rad, but the speed-sensitive limit is physics-side.**
  The input layer deliberately has no speed curve.
- **Photo actions are mode-scoped.** `Q`/`R` are photo bindings; a page using `R`
  for restart must treat that as a page shortcut, not a driving action.

---

## 15. Reproduce

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/input/tools/extract_retail_input.py      # _work/input/retail-input.json
node  probes/input/verify_input.mjs                   # _work/input/verify.json, 359 checks
node  probes/input/serve.mjs --port 8812              # manual controller page
```

Artifacts:

| path | content |
| --- | --- |
| `_work/input/retail-input.json` | independent extraction: XT identity/offsets, pad configs, keyboard layouts, deadzone, per-car input floats, source anchors |
| `_work/input/verify.json` | 359 checks, group counts, PoC deltas, limits |
| `_work/input/car-input-params.json` | decoded per-car steering/engine/brake floats (working copy) |
| `probes/input/input.mjs` | the module |
| `probes/input/verify_input.mjs` | the verifier |
| `probes/input/tools/extract_retail_input.py` | read-only extractor |
| `probes/input/manual.html`, `probes/input/serve.mjs` | manual hardware check |
