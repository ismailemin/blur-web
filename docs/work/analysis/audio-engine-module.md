# Engine audio module — standalone Web Audio package for E1

**Status:** implemented and verified headlessly; **not** integrated into `e1-drive`
**Date:** 6 November 2026
**Scope:** `probes/audio/web/engine-audio.js`, its harness page and its headless
verifier. One retail V8 engine graph, one continuous parameter (RPM).
**Depends on:** `docs/work/analysis/audio-feasibility.md` (asset decode, graph
curves, P62 harness evidence).

## 1. What this is

`probes/audio/web/engine-audio.js` is a framework-free ES module that packages
the data and the mix the P62 harness proved:

- six decoded retail loops — `RaceV8_Engine_1500/1995/3015/4005/4995/6000`;
- one looping `AudioBufferSourceNode` per layer, decoded once;
- the exact retail `EngineNVolume` and `EngineNPitch` piecewise-linear curves
  from `race_v8_engine.dat`, evaluated at `x = RPM × 0.0001`;
- `setTargetAtTime` smoothing on every gain and playback-rate change;
- typed failure states instead of silent substitution;
- a gesture-gated `ensureStarted()` that never creates an `AudioContext` on load.

The module makes no sound on its own and starts nothing automatically. It is
not a synth: the timbre is the original recordings.

### 1.1 Provenance of the embedded data

| Item | Value |
| --- | --- |
| Graph object | `Race_V8_engine` |
| Graph file | `root.pak:\audio\race_v8_engine.dat`, 8,715 bytes |
| Graph SHA-256 | `40993340fa508dffc18b79ab93f8c001faa176e418b2187ee19030789b246089` |
| Bank | `root.pak:\audio\race_v8.baf`, 961,744 bytes decoded |
| Bank SHA-256 | `f9d25fd4762d1fcf81fdad8419c41a19ec8de8cae945331886b11a18365ff2fe` |
| Parameter | `RPMInput`, `x = Engine().RPM() * 0.0001` (`BaseMessageHandler.cpp:1940`, `:1970`) |
| Reference model | `_work/audio/engine-model.json` (`probes/audio/dump_engine_curves.py`) |

The curve table in the module is a literal copy of that model. The harness page
and the verifier both re-read `_work/audio/engine-model.json` and compare it to
the module, so drift between the shipped table and the decoded graph is a test
failure, not a silent change.

## 2. Module API

```js
import {
  createEngineAudio,              // factory
  sampleEngineCurves,             // pure curve evaluation
  evalPlf,                        // piecewise-linear evaluator
  rpmToX, clampPlaybackRate,
  RETAIL_RACE_V8_ENGINE_CURVES,   // frozen six-layer table
  RETAIL_RACE_V8_ENGINE,          // frozen provenance block
  MIN_PLAYBACK_RATE,              // 0.00390625
  DEFAULT_BASE_URL,               // '/_work/audio/'
} from './engine-audio.js';
```

### 2.1 `createEngineAudio(options)`

Synchronous and side-effect free: no `AudioContext`, no fetch, no audio. A page
can construct it while loading.

| Option | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `'/_work/audio/'` | Prefix for the six WAVs. A trailing `/` is added if missing. E1 must pass its own asset base. |
| `fetchImpl` | global `fetch` | Injectable fetch (tests, auth, cache policy). |
| `audioContextFactory` | `new AudioContext({ latencyHint: 'interactive' })` | Injectable context. **The module takes ownership**: `dispose()` closes it. |
| `curves` | `RETAIL_RACE_V8_ENGINE_CURVES` | Layer descriptors `{ slot, wave, rpmLabel, volume, pitch, file? }`. The shape of `engine-model.json.loops`. |
| `rpmLabel` | `null` | Per-layer label override: a `(layer, index) => number\|null` function or a `{ wave: number\|null }` map. `null` uses `layer.rpmLabel`. Layers that resolve to `null` are excluded and reported. |
| `initialRpm` | `0` | RPM held until the first `setRpm`. |
| `masterGain` | `0.5` | Master gain (the P62 harness value). |
| `smoothing` | `0.02` | `setTargetAtTime` time constant in seconds for gain/rate. |
| `muteSmoothing` | `0.01` | Time constant for `setMuted`. |
| `limiter` | `true` | Safety `DynamicsCompressorNode` (−3 dB, knee 6, ratio 12, 3 ms/120 ms). Not the retail bus. |
| `resolveUrl` | `(layer, base) => base + (layer.file ?? wave + '.wav')` | Full URL override. |

Malformed options/curves throw `TypeError`/`RangeError` at construction. That is
deliberate: a wrong table must fail loudly rather than play the wrong sound.

### 2.2 Instance methods

| Method | Behaviour |
| --- | --- |
| `ensureStarted(): Promise<status>` | Must be called from a user gesture. Creates the `AudioContext`, resumes it, fetches and decodes the six WAVs, starts one looping source per layer, then reports `running`. Idempotent while in flight. **Never rejects** — failures resolve to `unavailable` + `reason`. Calling it again after a failure retries from a clean context. |
| `setRpm(rpm)` | Stores the value; when running, applies every layer's gain and playback rate with `setTargetAtTime(now, smoothing)`. O(layers): no nodes are created, only AudioParam automations. Throws `TypeError` on non-finite and `RangeError` on negative RPM. Returns the pure curve sample. |
| `setMuted(bool)` | Smoothly drives the master gain to 0 / `masterGain`. Returns the flag. Works before start (starts muted). |
| `dispose()` | Stops sources, disconnects the graph, closes the context, drops buffers, state `disposed`. Idempotent. The (closed) context object is kept so diagnostics report `closed`, not a guess. A disposed instance cannot be restarted; create a new one. |
| `getDiagnostics()` | Plain-object snapshot: state/reason/detail, `contextState`, `sampleRate`, rpm/x, decoded buffers with duration/sampleRate/channels/peak/bytes, per-layer `targetGain/targetRate` (pure PLF) and `gain/rate` (live `AudioParam`), analyser RMS/peak, excluded layers, provenance. |
| `sampleAt(rpm)` | Pure curve evaluation using this instance's curves/label overrides. |
| `onStatusChange(fn)` | Subscribe to state transitions; returns an unsubscribe function. A throwing listener cannot break the audio state machine. |
| `state`, `status`, `curves`, `provenance` | Read-only introspection. |

### 2.3 Typed statuses

`state` is one of `idle`, `loading`, `running`, `unavailable`, `disposed`.
`unavailable` always carries a `reason`:

| `reason` | Cause |
| --- | --- |
| `no-audio-context` | No Web Audio API, or the factory threw/returned nothing. |
| `graph-failed` | A node could not be created/connected. |
| `resume-failed` | `resume()` rejected — usually a missing user gesture. |
| `not-running` | `state !== 'running'` after resume. |
| `fetch-failed` | A WAV fetch failed or returned a non-2xx status. |
| `decode-failed` | `decodeAudioData` rejected, empty buffer, or a missing decoded layer. |
| `load-failed` / `start-failed` | Loader/start failure that has no more specific code. |

`detail` carries the underlying message. The module never logs to the console
and never falls back to a different sound or a mocked layer.

## 3. Curve semantics (exactly the P62 values)

- Domain: `x = RPM × 0.0001`.
- Evaluation: piecewise-linear interpolation between the stored points, with
  **endpoint clamping** (the first/last stored y is held outside the range); a
  zero-width segment returns the latter y. Same function as
  `probes/audio/harness/harness.js` `evalPlf`.
- Gain: evaluated `EngineNVolume` value, applied to that layer's `GainNode`.
- Rate: evaluated `EngineNPitch` value, clamped to
  `MIN_PLAYBACK_RATE = 0.00390625` (`decoderadpcm4bit.cpp:277-290`) and applied
  to `AudioBufferSourceNode.playbackRate`.
- Smoothing: `setTargetAtTime(target, ctx.currentTime, 0.02)` — an exponential
  approach, ~63 % in 20 ms, < 0.1 % error after ~140 ms. The verifier waits
  500 ms before sampling.
- Not hard-coded anywhere: gain/rate are recomputed from the table every
  `setRpm`, so an RPM outside the recorded labels still follows the retail line.
- `RaceV8_Engine_decel` (slot 7) is intentionally absent. In this graph its
  volume chain is flat zero and audible playback needs clutch/throttle state
  that is not modelled (feasibility doc §4.3, blocker 3).

### 3.1 Measured behaviour (headless run, 6 Nov 2026)

Only layers with non-zero gain are listed; the other layers sit at gain 0.

| RPM | Active layer | Gain | Rate |
| ---: | --- | ---: | ---: |
| 1500 | slot 1 `1500` | 1.00000 | 1.00024 |
| 1500 | slot 2 `1995` | 0.36765 | 0.75019 |
| 3015 | slot 3 `3015` | 1.00000 | 1.00435 |
| 3015 | slot 4 `4005` | 0.02206 | 0.75575 |
| 6000 | slot 6 `6000` | 1.00000 | 0.99977 |

Max live-vs-PLF delta: gain `1.3e-8`, rate `5.9e-8` (both far inside 1e-3).

Rates at a layer's own label are close to, but not exactly, `rpm / rpmLabel`:
the stored pitch breakpoints are not exactly `2 × label / 10000`, so the
deviation is up to ~0.44 % (slot 3). The module evaluates the stored curve; it
does not "correct" the data to make the identity exact.

> P62's table lists 3015 RPM as slot 4 gain 0.0294 / slot 3 rate 1.0060. That
> run moved a `<input type=range step=10>` to 3015, which the browser sanitised
> to **3020**. This harness uses `step=1` and the module API directly, so 3015
> is exact and the numbers differ accordingly. Both sets are consistent with the
> same stored curves.

## 4. Harness and verifier

### 4.1 Files

| File | Role |
| --- | --- |
| `probes/audio/web/engine-audio.js` | The module. No framework, no build step. |
| `probes/audio/web/index.html` | Harness page (transport, per-layer target vs live table, RMS/peak, log, deliberate failure-path button). |
| `probes/audio/web/module-harness.js` | Wires the page to the module; exposes `window.engineAudioProbe` for the verifier. |
| `probes/audio/capture_module.mjs` | Headless Edge verifier; writes new evidence files. |
| `probes/audio/serve.mjs` | Adds `/web/` routes; `/` and `/harness.js` are unchanged (byte-identical). |

The P62 harness (`probes/audio/harness/*`, `capture_harness.mjs`) and its evidence
(`_work/audio/harness.png`, `_work/audio/harness-evidence.json`) were not
modified.

### 4.2 Commands

```powershell
cd "C:\Users\ismailemin\Documents\Blur Web"

# Manual page
node probes/audio/serve.mjs --port 8810
# open http://127.0.0.1:8810/web/ and press "Start audio"

# Headless verification (exits 0 on success)
node probes/audio/capture_module.mjs
```

`capture_module.mjs` launches Edge **without**
`--autoplay-policy=no-user-gesture-required`, so the gesture claim is real. It
records the gesture as an `Input.dispatchMouseEvent` press/release on `#play`.

### 4.3 What the verifier asserts

| # | Assertion |
| --- | --- |
| 1 | Before the click: module `idle`, `contextState === 'none'`, 0 buffers, `levels === null` (no autoplay, no context). |
| 2 | After the synthetic mouse click: `AudioContext` is `running` and six layers are playing. |
| 3 | 6/6 WAVs decoded, mono, at the context sample rate; every buffer non-silent. |
| 4 | The six served WAV byte streams hash-match the P62 model hashes (SHA-256). |
| 5 | The module's curve table equals `engine-model.json` (all points and labels). |
| 6 | At 1500 / 3015 / 6000 RPM: reported RPM is the requested value; per-layer target gain/rate match the retail PLF exactly (< 1e-9) and live `AudioParam` values match within **1e-3**. |
| 7 | Analyser RMS > 0.001 at each of the three RPMs (non-silent). |
| 8 | `setMuted(true)` silences the analyser (< 0.002) without stopping the context; unmute restores output. |
| 9 | A second engine with a rejecting `fetchImpl` reports `unavailable` / `fetch-failed`; a third pointed at an HTTP 200 non-audio file reports `unavailable` / `decode-failed`. Both decode nothing, both are released, and the running engine is unaffected. |
| 10 | `dispose()` reports `disposed`, closes the context (`closed`), and drops buffers/layers. |
| 11 | Console 0 messages, 0 errors/warnings; page error list empty. |
| 12 | Screenshot written (> 20 KB). |

## 5. Verified result

Command: `node probes/audio/capture_module.mjs` → exit code 0.

```
verdict: engine-audio-module-verified
console: 0 messages, 0 errors/warnings
before gesture: state idle, contextState none, decoded 0, levels null
after gesture:  state running, contextState running, sampleRate 48000, decoded 6/6
1500 RPM: RMS 0.06513  peak 0.13965
3015 RPM: RMS 0.04157  peak 0.11321
6000 RPM: RMS 0.13674  peak 0.40277
mute: RMS 0.00000 → unmute RMS 0.03731
failure paths: unavailable/fetch-failed (decoded 0), unavailable/decode-failed (decoded 0)
dispose: state disposed, contextState closed, decoded 0, layers 0
screenshot: _work/audio/module-harness.png (1280×760, ≈60 KB)
```

Decoded buffers (all 48 kHz mono, peaks from the decoded PCM):

| Wave | Duration | Peak |
| --- | ---: | ---: |
| `RaceV8_Engine_1500` | 1.040 s | 0.2477 |
| `RaceV8_Engine_1995` | 1.080 s | 0.2587 |
| `RaceV8_Engine_3015` | 0.840 s | 0.2606 |
| `RaceV8_Engine_4005` | 0.992 s | 0.3482 |
| `RaceV8_Engine_4995` | 1.200 s | 0.8715 |
| `RaceV8_Engine_6000` | 1.400 s | 0.8251 |

The served bytes for all six waves match the hashes in
`_work/audio/engine-model.json` (`cc23b1f9…`, `82ba13b1…`, `8c614ef2…`,
`918b0be1…`, `90dc4081…`, `34027924…`).

## 6. Integration recipe for `e1-drive` (not applied in this task)

The E1 page already has one continuous RPM source: `Engine().RPM()` from the
wasm simulation. The module needs exactly one gesture hook and one call per
frame.

```js
import { createEngineAudio } from '../probes/audio/web/engine-audio.js';

// 1. Construct at page load. Nothing is fetched and no AudioContext exists.
const engineAudio = createEngineAudio({
  baseUrl: '/assets/audio/race_v8/',  // where E1 serves the six WAVs
  initialRpm: 0,
  masterGain: 0.5,
});

engineAudio.onStatusChange((status) => {
  if (status.state === 'unavailable') {
    hud.setAudioNotice(`Engine audio unavailable (${status.reason})`, status.detail);
  }
});

// 2. Gesture hook: the existing click/tap control that starts the drive scene.
startControl.addEventListener('click', () => {
  engineAudio.ensureStarted().then((status) => {
    if (status.state !== 'running') {
      hud.setAudioNotice(`Engine audio unavailable (${status.reason})`, status.detail);
    }
  });
});

// 3. Per frame, after the telemetry read. One call, six layers.
function frame(dt) {
  const rpm = sim.Engine().RPM();          // existing value; 0..~8000
  engineAudio.setRpm(rpm);                 // smooths gain + playbackRate
  // ... rest of the frame
}

// 4. Teardown when leaving the drive scene.
window.addEventListener('pagehide', () => engineAudio.dispose());
// or, for an in-page scene switch:
// engineAudio.dispose();
```

Rules that matter:

- **Call `ensureStarted()` only from the gesture handler.** Do not call it from
  the frame loop or from module load: the module refuses to create a context
  outside the gesture and would report `resume-failed`/`not-running`.
- **One `setRpm` per frame after the RPM read.** Do not restart sources; the
  module starts all six once and only modulates parameters.
- **Clamp RPM before passing it.** `setRpm` throws on `NaN`/`Infinity` and on
  negative values by design. `Math.max(0, rpm)` is enough; the curves clamp
  above 8000 RPM on their own.
- **Do not hang UI state on `await ensureStarted()` alone.** If it resolves
  `unavailable`, the page keeps running silently with an explicit notice; it
  must not pretend audio is playing.
- **`dispose()` closes the context it was given.** Do not pass a shared
  `AudioContext` unless the page accepts that `dispose()` closes it.
- **Optional HUD/menu without audio:** `sampleEngineCurves(rpm)` or
  `engineAudio.sampleAt(rpm)` returns the retail gain/rate per layer with no
  AudioContext and no side effects.
- **Fallback policy:** there is none. If the assets are missing, the module says
  so; wiring a different bank or a synth is a separate, explicit decision.

Asset note: the six decoded WAVs are 629,256 bytes total (float32
`AudioBuffer`s ≈ 1.26 MB). They are game data and are **not** committed in this
repo. E1 has to ship them through its own asset pipeline, or wait for the E2
wasm ADPCM decoder; either way the module's public API does not change.

## 7. Limits and non-claims

- Not full-game audio and not a retail-fidelity claim. One engine graph
  (`Race_V8_engine`) and one continuous parameter (RPM).
- Only `Engine1..6Volume/Pitch` are applied. Throttle, damage, induction,
  supercharger, clutch/decel, `EngineType`, cone/occlusion, mixer/EQ/sends and
  the `AOBJ` scripts are not wired (feasibility doc §4.2, §6).
- The decel layer is excluded because its retail volume chain is flat zero.
  `RaceV8_Engine_720` is not used; it has no component in this graph.
- The bus is `gain → analyser → safety compressor → destination`, not the retail
  mixer/limiter. Master gain 0.5 is a harness choice.
- The 66 ms ADPCM fade-in at the start of each decoded loop repeats at every
  loop point, exactly as decoded; the module does not crossfade or repair it
  (that would be invented signal processing).
- Pitch breaks at 2.0 (one octave up), inherited from the stored curve.
- Rate at a label deviates from `rpm / rpmLabel` by up to ~0.44 % because the
  stored breakpoints are not exactly `2 × label / 10000`; the stored curve is
  authoritative.
- Verified in headless Microsoft Edge (Chromium) on Windows only, via
  `decodeAudioData`. Other browsers were not tested.
- No latency, jitter, CPU or long-run stability measurement; no measurement of
  the retail mix against these gains.
- No car-to-graph mapping. Do not tell a player that their car uses this bank
  until the mapping is decoded.

## 8. Evidence index

| Path | What |
| --- | --- |
| `_work/audio/module-evidence.json` | Verdict, gesture/no-autoplay checks, decoded buffers, WAV hash checks, per-RPM gains/rates/deltas/RMS, mute, dispose, console. |
| `_work/audio/module-harness.png` | Harness screenshot, 1280×760, `running` at 3015 RPM. |
| `_work/logs/audio/module-edge.log` | Edge stderr/stdout. |
| `_work/logs/audio/module-verify.stdout.log` | Full verifier stdout (verdict summary). |
| `_work/audio/harness.png`, `_work/audio/harness-evidence.json` | P62 evidence, unchanged. |

Source hashes (SHA-256, first 16 hex):

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `probes/audio/web/engine-audio.js` | 24,475 | `df80feaa87005124…` |
| `probes/audio/web/index.html` | 5,756 | `b1f004c1c494f8dd…` |
| `probes/audio/web/module-harness.js` | 13,115 | `f33e6bae66fcaaa9…` |
| `probes/audio/capture_module.mjs` | 20,901 | `56bd013a2a2e100d…` |
| `probes/audio/serve.mjs` | 3,306 | `021c2d7ee9b086c7…` |

## 9. Handoff notes for the main agent

- This task only created `probes/audio/web/*`, `probes/audio/capture_module.mjs`,
  additive `/web/` routes in `probes/audio/serve.mjs`, evidence under `_work/`,
  and this document. `e1-drive`, engine, tools, `upstream/` and `game-data/`
  were not touched.
- Still open for the main agent, per `AGENTS.md`: task card, session log and
  `docs/handoff/CURRENT.md` in Turkish, the `docs/STATUS.md` milestone entry,
  the full `verify_asset_probe.py --skip-build` gate, and the commit.
- Suggested next step for E1: decide how the six WAVs are shipped, add the
  gesture hook and the one `setRpm` call, and keep the "audio unavailable"
  notice in the UI. Wiring other cars needs their own `.baf`/`.dat` decode, not
  a change to this module's shape.
