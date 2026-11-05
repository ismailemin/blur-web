# T-007 telemetry — per-car measured dynamics (`?telemetry=1`)

**Date:** 5 November 2026
**Owner:** P39 (sub-agent)
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
`docs/work/analysis/e1-drive-slice.md` §16 and this record. No change to the
engine, the wasm module, `probes/render-packet/`, `probes/car-parts/`, `tools/`,
the other `T-007-*.md` records, `upstream/` or `game-data/`. No vehicle-physics
change: all five drive and sprint state sequence hashes and all five drive packet
hashes are the P36/P37 values (pinned in the verifier).

## Result

The page has a deterministic **telemetry mode**:

```
/?telemetry=1&car=<slug>
```

It runs three scripted manoeuvres for the selected XT car, records one state per
engine tick at 60 Hz, and shows a metric table plus three traces in a panel. The
same series runs in `verify_e1_drive.mjs` and writes the JSON report. Every
number is a measurement of the state the engine reports; no engine parameter is
inferred and no curve is fitted.

`verify_e1_drive.mjs` is **423/423 PASS** (348 P37 checks + 75 telemetry checks).
Five headless Edge/WebGPU telemetry captures, plus a full 15-capture sprint pass
and a 4-capture drive regression, are **clean-console-and-gates** with
**0 console messages**. The browser recomputes the whole series from its own
wasm instances and matches the node metrics **exactly** (max |delta| = 0) and the
per-tick state hash sequence of all three manoeuvres **by SHA-256**.

| car | 0–50 km/h | 0–100 km/h | speed at 86 m | brake 80–0 | peak / mean decel | lateral peak | yaw peak | yaw response |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Audi R8 V10 (AWD) | **1.133 s** | **2.650 s** | **135.2 km/h** | **13.34 m** | 24.77 / 15.46 m/s² | **1.52 g** | 22.7 °/s | 12.7 ticks |
| Corvette ZR1 (RWD) | 1.817 s | 3.650 s | 126.5 km/h | 14.83 m | 20.80 / 15.13 m/s² | 0.86 g | 22.2 °/s | 15.3 ticks |
| Lotus Exige Cup260 (RWD) | 1.900 s | 3.833 s | 119.1 km/h | 17.00 m | 18.40 / 12.65 m/s² | 0.99 g | 22.7 °/s | 12.3 ticks |
| Dodge Challenger (RWD) | 2.100 s | 4.633 s | 108.2 km/h | 17.07 m | 18.47 / 13.34 m/s² | 0.84 g | 19.0 °/s | 14.7 ticks |
| Ford Focus RS (FWD) | 2.400 s | 5.133 s | 107.1 km/h | 18.73 m | 16.59 / 11.76 m/s² | 1.32 g | 26.3 °/s | 13.3 ticks |

All five: wheel contact on every tick of every manoeuvre (288/256/235 or
248/213/235 ticks for accel/brake/lateral), 0 non-finite states, and the 0–100
times are strictly ordered behind 0–50 and 0–80.

## Manoeuvres

`probes/e1-drive/web/telemetry.js` owns the three scripts and the analysis; the
node verifier and the page run the same code. Inputs are functions of the tick
number only:

| manoeuvre | ticks | input | measured |
| --- | --- | --- | --- |
| `accel` | 248–335 | throttle on **every** tick | 0–50, 0–80, 0–100 km/h ticks, top speed, speed and distance at the end of the fixed 86 m window |
| `brake` | 213–347 | throttle, then brake from the tick the accel run first measured 80 km/h | entry speed, stop tick, braking time, distance, peak and mean deceleration |
| `lateral` | 235 | 120 throttle ticks, then 4 square steering half-periods of 36 ticks at ±0.6, then coast | peak lateral acceleration, peak yaw rate, yaw lag behind every steering reversal |

The brake step tick is **measured** in the accel run of the same series
(`plan.brakeTick`) and is a constant inside the brake run, so the executed input
is still a pure step function of the tick. The lateral steer is a square wave
built from integer division (`Math.floor`), not `sin`/`cos`, so Node and Edge
produce the same input on every platform. `plan` is emitted in the evidence, the
page probe and the panel footer.

Each manoeuvre runs in a **fresh wasm module instance** built by `e1_create` at
the committed spawn (`-88, 1050, heading π/2`). This is needed because the module
build cannot rebuild one instance more than about three times (recorded under
Limits). A set of three instances is created up front; `reset()` selects the next
one, so the series is synchronous and no state survives between manoeuvres.

## What is measured, and how

| quantity | definition |
| --- | --- |
| speed | `state.speed` (m/s) × 3.6, km/h |
| time | engine ticks ÷ 60 (no wall clock anywhere) |
| distance | XZ distance between `state.position` samples |
| acceleration | per-tick finite difference of `state.velocity` (m/s²), projected on the body forward (`axisZ`) or lateral (`axisX`) axis |
| lateral g | lateral acceleration ÷ 9.80665 |
| yaw rate | `state.angular` projected on the body up axis (`axisY`), rad/s and °/s |
| yaw response | ticks from a steering reversal to the first tick the yaw rate reaches the measured sign for that steer |
| steer→yaw sign | measured from the first sweep half-period, not assumed; it is `+1` for all five cars |

Sampling is **60 Hz, one sample per engine tick**, from tick 0 to the stop tick.
The JSON keeps the full trace; the panel draws every sample (the x-axis label
states the duration and the sample count).

The panel and the JSON state what each row is, in units, and the panel marks the
mode as diagnostic, not retail fidelity.

## Determinism and verification

`_work/e1-drive/run.json` — **PASS, 423/423 checks**. The 75 telemetry checks:

- three manoeuvres per car in one instance each, start tick 0 (5 × 1);
- monotonic timers 0 < 0–50 < 0–80 < 0–100 and strictly growing distances
  (5 × 1);
- every timer is the measured tick and agrees with an independent
  `tickAtSpeedKph()` pass over the recorded states (5 × 1);
- the accel run reaches its fixed 86 m window on the ground (86.03–86.41 m
  recorded), with contact on every tick and no NaN (5 × 1);
- the reported top speed is the maximum measured speed (5 × 1);
- braking from 80 km/h stops inside the strip with a measured distance,
  deceleration and stop state (5 × 1);
- the sweep has a plausible peak lateral acceleration and yaw rate, and every
  steering reversal is answered with the measured sign (5 × 1);
- 60 Hz traces, one sample per tick, tick 0..N contiguous (5 × 1);
- every input is a tick-only step script, re-derived from the spec (5 × 1);
- every manoeuvre starts on the same settled tick-0 state as the 300-tick drive
  (5 × 1);
- **two independent wasm instance sets** produce identical per-tick state hashes
  in every manoeuvre (5 × 1);
- **replaying the recorded input sequence** in a third instance set reproduces
  every state hash (5 × 1);
- every telemetry tick has a distinct state hash inside its manoeuvre (5 × 1);
- the drive, sprint and packet physics anchors are unchanged (5 × 1);
- cross-car: distinct sequences, AWD quickest / FWD slowest to 100 km/h, 0–100
  order equals the XT torque-scale-to-mass order, braking order within two places
  of the XT brake-to-mass order, all sweeps stay on the ground with the same
  steer→yaw sign (5).

Per-tick state hashes, aggregates and the `hashOf(hashes)` trace hash are in
`_work/e1-drive/telemetry-<slug>.json` and `telemetry.json`. The run times are
24–31 ms per series in node (three manoeuvres, three wasm instances).

Physics unchanged: the verifier pins and re-checks all five drive state sequence
hashes, all five drive packet hashes and all five sprint sequence hashes
(`PHYSICS_ANCHORS`). The telemetry pass uses its own instances and never touches
the drive, sprint, keyboard or packet paths; the default Corvette's drive anchor
is still `sha256:83f76590…008e1f`.

## Comparison with the XT records (plausibility, not fidelity)

| car | drivetrain | mass | torque scale | gears | wheelbase | front/rear brake |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Audi R8 V10 | AWD | 1600 kg | 905 Nm | 6 | 2.635 m | 1.0 / 0.975 |
| Corvette ZR1 | RWD | 1600 kg | 780 Nm | 6 | 2.652 m | 1.0 / 1.100 |
| Lotus Exige Cup260 | RWD | 890 kg | 370 Nm | 6 | 2.323 m | 1.0 / 0.985 |
| Dodge Challenger | RWD | 1700 kg | 675 Nm | 6 | 2.981 m | 1.0 / 1.000 |
| Ford Focus RS | FWD | 1400 kg | 455 Nm | 6 | 2.787 m | 1.0 / 0.725 |

- **Acceleration is plausible.** The measured 0–100 order
  (Audi < Corvette < Lotus < Dodge < Focus) is **exactly** the order of
  `torqueScaleNm / mass` (905/1600 = 0.566, 780/1600 = 0.488, 370/890 = 0.416,
  675/1700 = 0.397, 455/1400 = 0.325). The AWD car puts its torque down best and
  is quickest; the FWD car has the least torque per kilogram and is slowest; the
  1700 kg Dodge is slower than the 1600 kg Corvette with less torque. The 86 m
  terminal-speed order is the same. The verifier records `accelRankDistance = 0`.
- **Braking is broadly plausible but not explained by the brake scalars.** The
  measured stopping order from 80 km/h is Audi (13.34 m) < Corvette (14.83 m) <
  Lotus (17.00 m) < Dodge (17.07 m) < Focus (18.73 m). That is the same as the
  acceleration order and within two places of the `(brakesFront + brakesRear) /
  mass` order, but the **Lotus is the anomaly**: it has the highest XT
  brake-to-mass ratio (1.985 / 890) and its rear brake scalar (0.985) is between
  the Corvette's (1.1) and the Audi's (0.975), yet it stops third. Tyre grip,
  brake balance and the entry speed (39.5 km/h in the sweep, 80.06 km/h here)
  are also part of the stop, so the brake scalars alone do not order it. The
  measurement is recorded as-is; no explanation is claimed.
- **Lateral output separates the cars where the XT data has grip differences.**
  All five XT records share the same grip points and the same front brake scalar,
  so the sweep differences come from mass, track, wheelbase, drivetrain and
  speed at the same steer. The AWD Audi (1.52 g at 64.6 km/h entry) and the Focus
  (1.32 g at 29.8 km/h) reach the highest lateral acceleration; the heavy,
  long-wheelbase Dodge is lowest (0.84 g at 36.9 km/h). A fixed steer at a
  different entry speed is not a grip limit, so this orders the *response*, not
  the *limit*.
- **No retail-fidelity claim.** Torque curves, gear ratios and tyre models are
  decoded records used by the unchanged engine; the telemetry only reports what
  that engine does on one measured strip. It is not a claim about the retail
  game's handling, lap times or car performance.

Peak deceleration is a one-tick finite difference and contains the brake
application transient (1.69–2.53 g); the mean over the stop (1.20–1.58 g) is the
robust figure and both are reported. That is a measured property of this
simulation, not a physical validation of the brake model.

## Browser evidence

Headless Edge/WebGPU, 1600×900, fresh profile, `--mode telemetry`:

- five captures, one per car, at `/?telemetry=1&car=<slug>`, held at the accel
  tick where the car first measured 100 km/h (219 / 230 / 278 / 308 / 159), so the
  car is on the drawn road in every frame;
- **0 console messages of any kind** in every capture;
- the page recomputed the node metrics **exactly** (`maxNumericDelta = 0`), the
  brake plan tick equals the node tick, and the three per-tick state hash traces
  are **SHA-256 equal** to the node run;
- the panel is visible with one table and three charts, and its text carries the
  car name, the measured 0–100 time to 3 decimals, `60 Hz`, `km/h`, `m/s²`,
  `°/s`, `samples` and `NaN`;
- the packet still renders: 3 geometry uploads at the level + own body + track
  byte count, `drawsIssued = frames × draws`, 9 matrices per rendered tick.

Screenshots (`_work/e1-drive/`):

| file | what it shows |
| --- | --- |
| `browser-<slug>-telemetry.png` | the frame at the 0–100 tick with the HUD and the telemetry panel: metric table, 0–100 time, speed at 86 m, brake distance/deceleration, lateral peak/yaw response, three labelled traces |
| `browser-<slug>-telemetry-car.png` | 2× crop of the same frame around the car |

The legacy paths were re-run after the change and are unchanged: the full sprint
pass is clean-console with **12/15 exact** packet hashes (the same three
documented last-bit `atan2`/`sin` differences as P37) and 0 failures; the
Corvette drive regression is clean-console with **4/4 exact** packet hashes and
the P36 positions/speeds (`-66.25, 1049.38` at 14.526 m/s at tick 150;
`-42.64, 1048.58` at 0.448 m/s at tick 300).

## Limits

- **One measured strip, not a lap.** All manoeuvres use the committed sprint spawn
  and the measured River strip. The standing start runs 86 m (to `x = -2`), the
  brake from 80 km/h stops in 13–19 m, and the sweep ends before the level wall at
  `x ≈ +7`. A full lap, a second sector, a true Vmax run and a 100–0 km/h brake
  test do not fit on the data. 0–100 km/h does fit for all five cars.
- **"Top speed" is the maximum measured speed inside the 86 m window**, not the
  car's Vmax. The column is labelled that way in the JSON and the panel.
- **Braking is from 80 km/h, not 100 km/h**, chosen so every car can reach the
  entry speed and stop on the strip. Entry speeds are 80.05–80.35 km/h and are
  reported; the distances are not corrected to a common speed.
- **Lateral is a fixed 0.6 square-steer sweep, not a grip limit.** It measures the
  lateral acceleration and yaw rate the car produces at its own entry speed
  (29.8–64.6 km/h). Peak deceleration contains a one-tick transient; the mean is
  reported alongside.
- **Diagnostic visuals.** Materials, colours, camera and the panel are diagnostic.
  The three traces are SVG drawn from the measured samples; there is no telemetry
  HUD in the retail sense and no per-parameter engine readout (torque, gear,
  RPM), because the state does not expose them.
- **~~One module rebuild limit~~ — Superseded by P40** (`T-007-reset-fix.md`):
  the root cause was missing `Scheduler::CreateGroup`/group handles in
  `C_Scene`; the fix supports 10+ rebuilds per instance and in-place restart.
  The paragraph below is the historical measurement, kept for the record.
- **One module rebuild limit (measured, not fixed here).** This wasm build cannot
  rebuild the same module instance more than about three times: the third
  `e1_reset()` after `e1_create` aborts with an out-of-bounds, and the fourth
  `e1_create` in one instance aborts (`Aborted()`). Every existing path stays
  under that (drive 1 rebuild, sprint 2, respawn 2), but telemetry needs three
  rebuilds, so it uses **one fresh instance per manoeuvre** instead of resetting.
  `R` in telemetry mode reloads the page rather than calling `e1_reset`. This is
  a recorded library limitation, not a workaround that hides a physics change.
- **No retail-fidelity claim.** One diagnostic validation on one strip, five XT
  cars, unchanged physics. No opponents, traffic, audio, multiplayer, streaming
  or race rules in this mode.
- Native-vs-wasm parity remains blocked by the DirectX SDK
  (`T-007-vehicle-physics.md` §7).

## Commands

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# 423 checks: telemetry determinism, replay, metric sanity and the physics anchors
& $node probes/e1-drive/tools/verify_e1_drive.mjs

# five telemetry frames with the panel; writes browser-evidence-telemetry.json
& $node probes/e1-drive/tools/capture_browser.mjs --mode telemetry --port 8819

# legacy regression after the change
& $node probes/e1-drive/tools/capture_browser.mjs --mode sprint --port 8821
& $node probes/e1-drive/tools/capture_browser.mjs --car corvette-zr1-stock --label-prefix telemetry-regression `
    --evidence-name browser-evidence-drive-regression-p39.json --port 8823
& $py   tools/verify_asset_probe.py --skip-build      # Passed 29 checks
```

Interactive: `node probes/e1-drive/tools/serve.mjs` →
`http://127.0.0.1:8801/?telemetry=1&car=audi-r8v10-stock`.

## What changed

| file | change |
| --- | --- |
| `probes/e1-drive/web/telemetry.js` | **new**: the three manoeuvres, tick-only inputs, the fresh-instance engine set, the measured metrics/traces |
| `probes/e1-drive/web/app.js` | `?telemetry=1` mode: run the series, build the presented accel timeline, HUD rows, panel render, `R` reload |
| `probes/e1-drive/web/index.html`, `style.css` | telemetry panel container and styles; legend/keys hidden in telemetry mode |
| `probes/e1-drive/tools/verify_e1_drive.mjs` | 75 telemetry checks, physics anchors for all five cars, `telemetry.json` and `telemetry-<slug>.json`, telemetry block in `run.json` |
| `probes/e1-drive/tools/capture_browser.mjs` | `--mode telemetry` (5 captures, metric/trace/panel/console gates), `browser-evidence-telemetry.json` |
| `probes/e1-drive/README.md` | telemetry section, commands, evidence, limits |
| `docs/work/analysis/e1-drive-slice.md` §16 | analysis record |
| `docs/work/verification/T-007-telemetry.md` | this record |

## Evidence paths

| path | content |
| --- | --- |
| `_work/e1-drive/run.json` | 423 checks, telemetry cars/ordering/anomalies/limits |
| `_work/e1-drive/telemetry.json` | all five cars' metrics, hashes and rank comparison |
| `_work/e1-drive/telemetry-<slug>.json` | full 60 Hz traces, per-manoeuvre metrics, hash aggregates, unit definitions |
| `_work/e1-drive/browser-evidence-telemetry.json` | five captures, panel text/shape, exact metric and trace-hash agreement, console log |
| `_work/e1-drive/browser-<slug>-telemetry.png` (+ `-car.png`) | telemetry panel frames |
| `_work/e1-drive/browser-evidence-sprint.json` | re-run of the 15-capture sprint pass (0 console, 12/15 exact) |
| `_work/e1-drive/browser-evidence-drive-regression-p39.json` | Corvette drive regression (0 console, 4/4 exact) |
| `_work/logs/e1-drive/verify-p39.log`, `capture-telemetry-p39.log`, `capture-sprint-p39.log`, `capture-drive-p39.log`, `verify-asset-probe-p39.log` | raw runs |
