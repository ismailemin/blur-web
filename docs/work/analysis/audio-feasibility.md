# Engine audio feasibility — smallest faithful path for E1

**Status:** data/feasibility only; proposed for main-agent review
**Date:** 6 November 2026
**Scope:** one retail V8 engine bank, its decoded loops, its RPM graph, and a
local Web Audio harness. No integration into `e1-drive`.
**Non-claim:** this is not full-game audio. It covers one engine graph, one
vehicle class, and one continuous parameter (RPM). It does not reproduce the
retail mixer, effects, occlusion, other cars, music or UI.

## Summary

The smallest faithful browser path is **not** a new synthesiser. The retail
game already ships short, looped engine recordings plus a data-driven RPM
crossfade graph. The browser can play six decoded loops with the **exact retail
piecewise-linear gains and pitches**, so the timbre comes from the original
recordings rather than from a synthesis model.

Evidence chain, all from retail data and upstream source:

1. `root.pak:\audio\race_v8.baf` contains `RaceV8_Engine_1500 … 6000` and
   `RaceV8_Engine_decel` as `uADPCM4Bit` 48 kHz mono loops.
2. `root.pak:\audio\dat\race_v8_engine.dat` is an `AOBJ` audio graph. It defines
   `Engine1..7Sound`, `Engine1..7Volume`, `Engine1..7Pitch`, all driven by the
   `RPMInput` control.
3. `BaseMessageHandler.cpp:1940` and `:1970` set
   `DynamicsRPM = Engine().RPM() * 0.0001`; therefore the graph's x axis is
   `RPM / 10000`.
4. For the six RPM-labelled loops, each `EngineNPitch` curve is `0 → 0` at x=0
   and `2 → 2.0` at x = 2 × rpmLabel / 10000. The resulting playback rate is
   exactly `RPM / rpmLabel`; this is an algebraic consequence of the stored
   curve, not an invented mapping.
5. Each `EngineNVolume` curve is the retail crossfade gate. It is read verbatim
   and evaluated in the harness.

Result: the harness decodes six original loops, mixes them with the retail
curves, reports `decoded-audio-playing-and-curves-match`, produces non-silent
output at 1500/3015/6000 RPM, and has a clean console. See
`_work/audio/harness-evidence.json` and `_work/audio/harness.png`.

## 1. Assets located

PAK index values are from `_work/asset-layout/retail-layout.json` (read-only
diagnostic). Offsets are absolute in the PAK.

| PAK | In-PAK path | Offset | Stored | Logical | Role |
| --- | --- | ---: | ---: | ---: | --- |
| `root.pak` | `\audio\race_v8.baf` | 56,643,584 | 780,986 | 961,744 | V8 engine/exhaust/induction/supercharger waves |
| `root.pak` | `\audio\dat\race_v8_engine.dat` | 15,486,976 | 2,339 | 8,715 | `AOBJ` engine graph |
| `root.pak` | `\audio\dat\race_v8_exhaust.dat` | — | 3,053 | 11,189 | exhaust graph (not wired) |
| `gamedata.pak` | `\gamedata\xt\AudioEntities.bin` | — | 369,013 | 592,392 | audio entity schema/pack |
| `gamedata.pak` | `\gamedata\xt\Audio.bin` | — | 14,621 | 31,576 | audio object pack |
| `root.pak` | `\audio\wheel_common.baf` | 81,881,088 | 865,258 | 1,063,945 | shared wheel/tyre waves |
| `root.pak` | `\audio\wheel_dry.baf` | 82,747,392 | 638,848 | 817,726 | dry tyre loops |
| `root.pak` | `\audio\wheel_offroad.baf` | 83,386,368 | 1,031,669 | 1,290,460 | off-road tyre loops |
| `root.pak` | `\audio\car_collisions.baf` | 8,628,224 | 1,679,082 | 2,121,181 | vehicle collision waves |

`root.pak` uses PAK V2 `packet-zlib` (`codec 4`); `gamedata.pak` uses ordinary
`zlib` (`codec 2`). Both are read by the probe without writing to the PAKs.

The engine graph is loaded by name in upstream source:

- `GameAudioLayer.cpp:485-486` loads `gamedata\xt\Audio.bin` and
  `AudioEntities.bin`.
- `GameAudioLayer.cpp:740-742` loads the front/mid engine 3D mixer `.dat`s.
- `VehicleActor.cpp:5050` copies `VehiclePhysics->Engine().RPM()` into the
  vehicle model; `:7248` copies the per-car `audioRPMLimit`.

Tyre and collision hooks exist, but were not decoded in this task:

- `WheelSubSystem.cpp:134-238` switches named instances
  `FLWheelDry/FRWheelDry/RLWheelDry/RRWheelDry` and
  `FLWheelOffroad/…` on surface changes.
- `CollisionSubSystem.cpp:56,121-132` loads the collision `.dat` and wave banks;
  `:295,634` gate collision messages.
- Collision is not one continuous parameter. `VehicleAudioComponent.h:28-40`
  carries `m_fMaxImpulseStrength`, `m_fDecayingPeakImpulse`,
  `m_bCollidedWithStaticBody` and `m_MaterialType`; `VehicleActor.cpp:2936`
  builds `C_VehicleAudioImpactMsg`. The material-specific `do_*` banks
  (`do_metal_vehicle_car.baf`, `do_concrete_large.baf`, …) are the likely
  collision sources, but they were not decoded here.

## 2. Container and codec

### 2.1 PAK

The PAK V2 header, FAT and string table are read by `tools/inspect_asset_layout.py`
and by `probes/audio/extract_baf.py`. `packet-zlib` is a 64 KiB packet stream
with raw-DEFLATE packets; `zlib` is a single zlib stream. Both paths are
implemented and bounded.

### 2.2 BAF wave bank

`upstream/BlurRebuilt/code/mercury/library/audio/source/common/WaveBank.h`
defines the format:

- `:12-16` extension `.baf`, tags `BANK`, `WAVE`, `DATA`
- `:21` version 4
- `:88-104` `BankHeader` (tag, size, version, numWaves, endian, streaming,
  name[32])
- `:106-118` `WaveBaseHeader`
- `:147-156` `ADPCMWave { size, sampleRate, samples, loop, interleaved,
  bitsPerSample, channels }`

`WaveBankReader.cpp:270-409` reads `WAVE` chunks; `:418-520` reads `DATA`
chunks; `:302-329` maps format ids to headers. `SampleTypes.h:11-23` gives the
ids; the engine loops are **`0x7` = `uADPCM4Bit`**.

The observed bank is little-endian, non-streaming, version 4. A `WAVE` chunk is
76 bytes (60-byte base + 16-byte ADPCM header); a `DATA` chunk is
`8 + payload`. The first engine loop, `RaceV8_Engine_720`, has its `DATA` chunk
header at bank offset `0x7502` and its payload at `0x750A`.

### 2.3 ADPCM

`decoderadpcm4bit.cpp`:

- `:37-40` `BATCH_SIZE_IN_SAMPLES 64`, `BATCH_SIZE_IN_BYTES 33`
- `:1038-1107` `DecodeBlock`: predictor/shift nibble, 4-bit nibbles, five
  predictor pairs, 33-byte block
- `:277-290` pitch clamp to `[0.00390625, 4.0]`
- `:1109-1111` `DecodeBlock3` forwards to `DecodeBlock` on PC

The probe ports `DecodeBlock` literally, including the `mDeltaFader` fade-in
(`decoderadpcm4bit.h:24-33`: initial `mDeltaFader = 1.0`; each block
`d = 0.9025 * d`, `vol = 1 - d`). The first block is therefore attenuated and
the loop fades in over roughly 66 ms. The WAVs preserve that behaviour.

Stereo waves interleave a 33-byte left block and a 33-byte right block per
64-sample frame (`ReadVagStreamStereo`, `decoderadpcm4bit.cpp:142-249`). The
engine loops used here are mono; the exhaust waves are stereo.

### 2.4 AOBJ graph

`Definition.cpp:84-125` defines the `.dat` header:

- magic `AOBJ` at byte 0 (file bytes `4a 42 4f 41`)
- version at `puHeader[1]`; observed `0x0002000b` = 2.11
- string-table offset at `puHeader[2]`; observed 6216
- object-name offset at `puHeader[3]`
- component count at `puHeader[4]`
- frame skip at `puHeader[5]`
- component data at `&puHeader[6]` (byte 24)

`Object.cpp:103-160` walks the components; `:453+` advances by each component's
`DataSize`. The probe uses the same `Data` layouts from
`components/*.h`. `Component.h:140-393` is the type enum.

`race_v8_engine.dat` reports `Race_V8_engine`, version 2.11, frame skip 6,
**119 declared components**. The bounded walk reaches the string table exactly
after **114** components at `0x1848`. The five names that are never used as a
component name are `Engine0Sound`, `Engine0Volume`, `SuperchargerGroupVolume`,
`SteamVolumeLevel`, `FlamesVolumeLevel`. This is an open format detail, recorded
below; it does not affect the Engine1..7 curves, which are all decoded before the
end of the walk and whose control input is component 1 (`RPMInput`).

## 3. Decode result

`probes/audio/extract_baf.py` extracts and decodes the bank. The decoded bank
is 961,744 bytes,
SHA-256 `f9d25fd4762d1fcf81fdad8419c41a19ec8de8cae945331886b11a18365ff2fe`.
The graph is 8,715 bytes,
SHA-256 `40993340fa508dffc18b79ab93f8c001faa176e418b2187ee19030789b246089`.

Decoded engine loops (48 kHz, mono, PCM16 WAV):

| Wave | Duration | WAV bytes | WAV SHA-256 (first 16) | Peak | RMS |
| --- | ---: | ---: | --- | ---: | ---: |
| `RaceV8_Engine_720` | 2.904 s | 278,828 | `9a037958f5286396` | 0.114 | 0.0340 |
| `RaceV8_Engine_1500` | 1.040 s | 99,884 | `cc23b1f9b7338a99` | 0.251 | 0.1074 |
| `RaceV8_Engine_1995` | 1.080 s | 103,724 | `82ba13b19ae3a5da` | 0.259 | 0.0912 |
| `RaceV8_Engine_3015` | 0.840 s | 80,684 | `8c614ef2b96da7ef` | 0.267 | 0.0824 |
| `RaceV8_Engine_4005` | 0.992 s | 95,276 | `918b0be1ba3e625d` | 0.348 | 0.0968 |
| `RaceV8_Engine_4995` | 1.200 s | 115,244 | `90dc40816f3eadef` | 0.873 | 0.2616 |
| `RaceV8_Engine_6000` | 1.400 s | 134,444 | `34027924bcea2805` | 0.835 | 0.2664 |
| `RaceV8_Engine_decel` | 0.032 s | 3,116 | `58b1facab64cd1d0` | 0.656 | 0.2061 |

Full hashes are in `_work/audio/race_v8.baf.json` and
`_work/audio/engine-model.json`.

### 3.1 Decode validation

The loop names state the recording RPM. For a four-stroke V8 the expected firing
frequency is `RPM / 60 × 4`. FFT peaks of the decoded WAVs:

| Loop | Expected firing | Strongest peak | Verdict |
| --- | ---: | ---: | --- |
| 720 | 48.0 Hz | 47.4 Hz | matches |
| 1500 | 100.0 Hz | 100.0 Hz | matches |
| 1995 | 133.0 Hz | 133.3 Hz | matches |
| 3015 | 201.0 Hz | 200.0 Hz | matches |
| 4995 | 333.0 Hz | 333.3 Hz | matches |
| 6000 | 400.0 Hz | 400.0 Hz | matches |
| 4005 | 267.0 Hz | 99.8/199.5/399.1/465.6 Hz | label/graph is authority; firing peak is not dominant |

Five of six used loops land on the expected firing frequency within 1 Hz; the
4005 loop has a different spectral balance but still decodes to a non-silent
waveform. The 720 loop is additional validation but is not used by this graph
(see below).

## 4. RPM mapping — exact retail curves

### 4.1 Parameter

`BaseMessageHandler.cpp`:

- `:1940` `m_rpm = engineRPM * .0001f;`
- `:1946` `SetEntityValue(..., DynamicsRPM, m_rpm)`
- `:1970` `SetEntityValue(..., DynamicsRPM, engineRPM * .0001f)`
- `:1990` boost is a separate parameter; `:1994` clutch is separate

Therefore `x = RPM / 10000`. The engine graph's `RPMInput` is component 1
(`ControlInput`). Every decoded `EngineNVolume` and `EngineNPitch` curve stores
`ctrlInput.sCom = 1`, i.e. it reads `RPMInput` output 0. This was verified from
the `Control` word at `data + 4` for each curve.

The graph has no literal `Load` input. Its continuous vehicle inputs are
`RPMInput`, `ThrottleAdjustedInput`, `ThrottleGradientInput`, `ClutchInput`,
`ForcedInductionInput`, `CarOverallDamageLevelInput`,
`FocusCarHeightFinalInput` and `CameraPresetInput` (component string table in
`race_v8_engine.dat`). This probe wires only `RPMInput`; the rest are E2 work.

### 4.2 Graph shape

The graph does **not** have a discrete "select loop N" switch. It instantiates
`Engine1Sound … Engine7Sound` (`MonoLoopingSound`) and drives each with its own
`EngineNVolume` and `EngineNPitch` curve. The graph also contains an
`EngineMixer` (`MonoToMonoMixer`). The harness sums the active layers through a
master gain; the exact retail mixer connection list was not decoded, so this is
a documented bus simplification, not a claim of bit-identical routing. The
volume curves are the per-layer crossfade; the pitch curves are the resampling
rate.

The graph also carries `EngineType` and `EngineTypeYArray`/`EngineTypeZArray`
(two-element arrays). Their values and selection semantics were not decoded, so
the model assumes the V8 branch that matches the bank's `RaceV8_Engine_*` waves.

`race_v8_engine.dat` instantiates Engine1..7 only. There is no
`Engine0Sound`/`Engine0Volume`, so `RaceV8_Engine_720` is present in the bank but
unused by this graph. Do not assume it is the idle layer.

### 4.3 Exact curves

Points are shown as `RPM → value`, converted from the stored x by `RPM = x ×
10000`. The stored x values are kept in `_work/audio/engine-model.json`; the
conversion is only for readability.

| Slot | Wave | RPM label | `EngineNVolume` (RPM → gain) | `EngineNPitch` (RPM → rate) |
| ---: | --- | ---: | --- | --- |
| 1 | `RaceV8_Engine_1500` | 1500 | 850→0, 1200→1, 1500→1, 2250→0 | 0→0, 2999.28→2 |
| 2 | `RaceV8_Engine_1995` | 1995 | 1250→0, 1930→1, 2250→1, 3000→0 | 0→0, 3999.0→2 |
| 3 | `RaceV8_Engine_3015` | 3015 | 2000→0, 2680→1, 3250→1, 4000→0 | 0→0, 6003.9→2 |
| 4 | `RaceV8_Engine_4005` | 4005 | 3000→0, 3680→1, 4250→1, 5000→0 | 0→0, 7978.8→2 |
| 5 | `RaceV8_Engine_4995` | 4995 | 4000→0, 4680→1, 5250→1, 6000→0 | 0→0, 10000.2→2 |
| 6 | `RaceV8_Engine_6000` | 6000 | 5000→0, 5680→1, hold 1 | 0→0, 12002.7→2 |
| 7 | `RaceV8_Engine_decel` | — | 2276→0, 2951→0.0269, 3718→0.1001, 4724→0.2485, 5500→0.5, 6500→1 | 0→0, 14941.5→2 |

At a loop's own label, its pitch curve gives rate = 1.0 (`RPM / rpmLabel =
1`). Between labels the rate follows the same line, so the engine firing
frequency tracks RPM continuously. The stored pitch curve saturates at 0 and
2.0, i.e. at most one octave above the recorded loop; the harness evaluates the
stored curve, so it inherits that limit. The volume curves overlap (for example,
at 1500 RPM slot 1 is 1.0 and slot 2 is 0.368), which is the retail crossfade.

Slot 7 is a 32 ms decel layer. In this graph `EngineDecelThrottleVolume`
(`0.1→0`, `0.3→0`) and `EngineDecelVolume` (`0.7→0`, `1.0→0`) are both flat
zero, so the decel layer is effectively muted regardless of RPM. The harness
excludes it; it should not be re-enabled without decoding the intended gating
(`EngineDecelClutchModifier`, `EngineDecelThrottleVolume`) and the clutch state.

## 5. Browser harness

Files:

- `probes/audio/harness/index.html`
- `probes/audio/harness/harness.js`
- `probes/audio/serve.mjs` (port 8810, read-only, `.wav`/`.json` only)
- `probes/audio/capture_harness.mjs` (headless Edge)

The harness fetches `_work/audio/engine-model.json` and the six WAVs, creates
one `AudioBufferSourceNode` per loop (`loop=true`), one `GainNode` per loop, a
master gain and a safety `DynamicsCompressorNode`. On every RPM change it
evaluates the stored volume and pitch PLFs and applies
`setTargetAtTime(…, 0.02)`. It never synthesises the engine; it only plays and
mixes the original loops.

If the model or WAVs cannot be fetched, the page switches to a clearly labelled
**MOCK — scheduling only** mode and produces no sound. The decoded path was the
one exercised. In a normal browser press **Play** (a user gesture is required);
the headless capture uses `--autoplay-policy=no-user-gesture-required`.

### 5.1 Automated result

`node probes/audio/capture_harness.mjs` produced:

- verdict `decoded-audio-playing-and-curves-match`
- 6/6 WAVs decoded, 48 kHz, durations 0.84–1.40 s
- `AudioContext.state = running`, sample rate 48000
- console: **0 messages, 0 errors/warnings**
- non-silent analyser output at every test RPM (RMS/peak vary slightly per run):
  - 1500 RPM: RMS ≈ 0.058, peak ≈ 0.11
  - 3015 RPM: RMS ≈ 0.040, peak ≈ 0.12
  - 6000 RPM: RMS ≈ 0.131, peak ≈ 0.38
- gains/rates match the retail PLFs (max gain delta < 0.01, max rate delta <
  0.01):

| RPM | Active layer | Gain | Rate |
| ---: | --- | ---: | ---: |
| 1500 | slot 1 `1500` | 1.0000 | 1.0002 |
| 1500 | slot 2 `1995` | 0.3676 | 0.7502 |
| 3015 | slot 3 `3015` | 1.0000 | 1.0060 |
| 3015 | slot 4 `4005` | 0.0294 | 0.7570 |
| 6000 | slot 6 `6000` | 1.0000 | 0.9998 |

Screenshot: `_work/audio/harness.png` (1280×760).
Evidence: `_work/audio/harness-evidence.json`.
Server/browser log: `_work/logs/audio/harness-edge.log`.

The headless test also plays a 440 Hz oscillator (RMS 0.14) and a single
decoded buffer (RMS 0.10) through separate paths, so the non-zero result is not
an artefact of the model graph. The in-graph test uses the same analyser as the
model mix.

## 6. What is proven vs unknown

### Proven

- The exact PAK paths, offsets and sizes of the V8 bank and engine graph.
- The BAF container, `uADPCM4Bit` format id, 33-byte/64-sample block layout, and
  a source-faithful decode of the six engine loops plus decel and the unused 720.
- The `.dat` `AOBJ` header, component walk, `RPMInput` wiring, and the exact
  `Engine1..7Volume/Pitch` PLF points.
- `DynamicsRPM = RPM × 0.0001` from source, and `playbackRate = RPM / rpmLabel`
  as the algebraic result of the stored pitch curves.
- A local Web Audio mix of the original loops with those curves, non-silent and
  console-clean, verified headless.

### Unknown / not done

- The five declared components that are not reached by the walk (declared 119,
  walked 114). The walk reaches the string table exactly; the cause is not
  identified. The five names never used as a component name are listed in §2.4.
- The `AOBJ` script bytecode (`StartScript`, low-pass bypass/enable) is not
  interpreted.
- Throttle, damage, induction, supercharger, clutch/decel, cone/occlusion,
  mixer/EQ/return layers are decoded as curves but not wired.
- Other banks exist (for example `audi_i4.baf`, `lotus_i4.baf`,
  `dodge_v8.baf`, `ford_i5.baf` and the `race_*` family) with their own RPM
  labels and curves. The E1 car-to-audio mapping has not been established, so
  none of them were decoded here.
- The retail bus/limiter and 3D mixer are not reproduced; the harness uses a
  documented safety compressor.
- No real-time latency, jitter or long-run stability measurement; only a local
  headless run and a local server.
- No claim that the browser mix is bit-identical to the retail mixer. The input
  samples and the RPM curves are original; the bus is not.

## 7. Blockers

1. **`.dat` component-count anomaly.** `race_v8_engine.dat` declares 119
   components but the bounded walk reaches the string table after 114. The five
   names that never appear as a component name are listed in §2.4. This is
   recorded as an open format detail, not silently skipped. The Engine1..7 curves
   are before the end of the walk and are internally consistent with the wave
   labels.
2. **No Engine0 component.** `RaceV8_Engine_720` exists in the bank but has no
   sound/volume component in this graph. It must not be used as an idle layer
   without another graph that instantiates it.
3. **Decel is muted in this graph.** The 32 ms decel loop's
   `EngineDecelThrottleVolume` and `EngineDecelVolume` curves are flat zero in
   `race_v8_engine.dat`, so it is not audible from RPM alone. Re-enabling it
   requires the intended clutch/throttle gating and a clutch model; the harness
   leaves it off.
4. **Per-car graphs.** The E1 roster is not one audio graph. Each car needs its
   own `.baf`/`.dat` decode; the same method applies, but the curves and wave
   labels will differ.
5. **Proprietary graph runtime.** The `.dat` is data; the retail Ovis runtime is
   not ported. The probe reads only the component data it can bound. Script
   bytecode and connection routing beyond the decoded control words are not
   executed.

## 8. Recommendation for E1 / E2

### E1 (smallest faithful slice)

1. Ship the six `RaceV8_Engine_*` loops for the E1 car whose audio graph is
   confirmed to be `Race_V8_engine.dat`. The car-to-graph mapping is not part of
   this probe; confirm it before naming the car in UI or documentation. Decode
   them to `AudioBuffer` at load; do not synthesise.
2. Drive them from the wasm simulation's `Engine().RPM()` (already available in
   the vehicle telemetry path). Evaluate the six stored volume curves and six
   stored pitch curves exactly as in
   `_work/audio/engine-model.json`.
3. Use `AudioBufferSourceNode(loop=true)` + `GainNode` per layer, a master gain
   and a safety limiter. Start all layers once and modulate gain/rate; do not
   restart sources per tick.
4. Keep the decel layer off until clutch state exists; in this graph its volume
   chain is already flat zero. Keep throttle, damage, induction and supercharger
   off for E1; label them as not applied.
5. Add tyre and collision after the engine: `wheel_dry.baf`/`wheel_offroad.baf`
   and `car_collisions.baf` are the next smallest feedback wins, and their
   subsystem hooks are already named in source.
6. Asset cost: six ADPCM payloads are 162,162 bytes; the decoded PCM16 WAVs are
   629,256 bytes; float32 `AudioBuffer`s are about 1.26 MB. Any of these is
   small for E1. Shipping the ADPCM and decoding in wasm is an E2 optimisation,
   not an E1 requirement.

### E2 (fidelity)

- Wire the remaining graph layers: throttle (`EngineThrottleVolume`), decel
  clutch/throttle, damage, induction, supercharger, cone/occlusion, mixer/EQ/
  send/return.
- Decode the other car graphs and map each E1 car slug to its audio set.
- Either interpret the `AOBJ` scripts and connections, or port the retail Ovis
  runtime; do not approximate the graph routing.
- Replace the safety compressor with the retail bus/limiter if fidelity
  requires it.
- Consider decoding ADPCM in wasm and streaming from the PAK to reduce memory
  and avoid shipping PCM WAVs.

### Order

Engine RPM (this probe) → tyre → collision → exhaust/induction → other cars →
music/UI. The engine is the only continuous sound that defines the car; tyre and
collision are short, high-value feedback; exhaust/induction are layers on top of
the engine and can wait.

## 9. Reproduction

Bundled Python:

```text
C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe
```

```powershell
cd "C:\Users\ismailemin\Documents\Blur Web"
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# 1. List the bank waves and decode the engine loops
& $py probes/audio/extract_baf.py --list
& $py probes/audio/extract_baf.py --wave RaceV8_Engine_720 --wave RaceV8_Engine_1500 `
  --wave RaceV8_Engine_1995 --wave RaceV8_Engine_3015 --wave RaceV8_Engine_4005 `
  --wave RaceV8_Engine_4995 --wave RaceV8_Engine_6000 --wave RaceV8_Engine_decel

# 2. Read the graph curves and build the model
& $py probes/audio/extract_dat.py --asset "\audio\dat\race_v8_engine.dat" `
  --out _work/audio/race_v8_engine.dat
& $py probes/audio/inspect_dat.py _work/audio/race_v8_engine.dat --curves `
  --json _work/audio/race_v8_engine.dat.json
& $py probes/audio/dump_engine_curves.py

# 3. Serve and verify the harness
node probes/audio/serve.mjs --port 8810
node probes/audio/capture_harness.mjs
```

The server binds `127.0.0.1` only, serves `probes/audio/harness` and
`_work/audio/*.wav|*.json`, and refuses directory listings and path escapes.

## 10. Evidence index

| Path | What |
| --- | --- |
| `_work/audio/race_v8.baf` | decoded bank (961,744 bytes) |
| `_work/audio/race_v8.baf.json` | bank hash, wave table, per-wave hashes |
| `_work/audio/race_v8_engine.dat` | decoded graph (8,715 bytes) |
| `_work/audio/race_v8_engine.dat.json` | component walk, names, curves |
| `_work/audio/engine-model.json` | exact RPM model + WAV hashes |
| `_work/audio/RaceV8_Engine_*.wav` | decoded loops |
| `_work/audio/harness.png` | harness screenshot |
| `_work/audio/harness-evidence.json` | capture verdict, gains/rates, RMS, console |
| `_work/logs/audio/extract_race_v8.log` | extractor output |
| `_work/logs/audio/inspect_dat_engine.log` | graph walk + curves |
| `_work/logs/audio/dump_engine_curves.log` | model build |
| `_work/logs/audio/harness-edge.log` | Edge stderr/stdout |
| `_work/logs/audio/capture_harness_console.log` | capture summary |

No game data, decoded fixture or build output is committed. The decoded WAVs
and `.dat`/`.baf` copies live under `_work/` only.

## 11. Non-claims

- Not a full-game audio implementation.
- Not a port of the Ovis runtime or the retail mixer.
- Not a claim that the harness matches the retail mix sample-for-sample.
- Not a claim that the five unreached declared `.dat` components are understood.
- Not a claim that `RaceV8_Engine_720` is the idle loop.
- Not a claim that other cars share these curves.
