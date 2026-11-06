# T-007 — engine audio in the E1 drive slice (P71)

**Status:** implemented and verified headlessly (16/16 audio checks, 826/826
non-browser checks, console clean).
**Module:** committed `probes/audio/web/engine-audio.js` (P62/P71 module task),
used unchanged as a read-only dependency.
**Inputs (read-only):** the six decoded retail WAVs under `_work/audio/` and
`_work/audio/engine-model.json`; **no game data is copied or committed**.
**Scope:** one retail `Race_V8_engine` graph, one continuous parameter (RPM).

The module's own analysis document (`docs/work/analysis/audio-engine-module.md`)
is owned by the audio task; its "not integrated into `e1-drive`" status line
predates this integration and is superseded here for the E1 page.

## 1. What this adds

The car in the E1 browser slice now has an audible engine that follows the
simulation's own RPM:

- six decoded retail loops (`RaceV8_Engine_1500/1995/3015/4005/4995/6000`) play
  as looping `AudioBufferSourceNode`s;
- every frame the page calls `setRpm(rpm)` once with the wasm car's live
  `Engine().RPM()`, exposed as `e1_engine_rpm()`;
- the module evaluates the exact retail `EngineNVolume`/`EngineNPitch`
  piecewise-linear curves at `x = RPM × 0.0001` and smooths every gain/playback
  rate with `setTargetAtTime` (20 ms);
- `M` mutes/unmutes through the module's master gain;
- the HUD row `audio` shows state, RPM, active layer count and mute;
- `?audio=0` forces the feature off (no module instance, no fetch, no context).

The page does not synthesise, substitute or guess a sound. If the WAVs, the
`AudioContext` or the live RPM accessor are unavailable, it stays silent and the
HUD states the typed reason.

## 2. Integration points

| file | change |
| --- | --- |
| `probes/e1-drive/native/e1_drive_lib.cpp` | new export `float e1_engine_rpm()`: returns `gWorld.car->Engine().RPM()` when a world is ready, otherwise `-1`. This is the documented `RPMInput` source (`BaseMessageHandler.cpp:1940/1970`), read from the integrated engine state, never derived from speed or a guessed gear. |
| `probes/e1-drive/tools/build_module.mjs` | `_e1_engine_rpm` added to `EXPORTED_FUNCTIONS`; the wasm was rebuilt deterministically (A/B hash identical). |
| `probes/e1-drive/tools/serve.mjs` | two read-only trees with the existing `safeJoin`: `/audio/` → `probes/audio/web/` (the module) and `/_work/audio/` → `_work/audio/` (the WAVs). `.wav` is served as `audio/wav`. No writes, no directory listing, no path escapes. |
| `probes/e1-drive/web/app.js` | imports `createEngineAudio` from `/audio/engine-audio.js`; constructs it at load (no side effects); starts it only from a real user gesture; calls `setRpm` once per rendered frame and after reset/respawn; `M` mute; HUD row; `pagehide` dispose; `window.e1DriveAudio` capture/diagnostic handle. |
| `probes/e1-drive/web/index.html` | `M` key row and the audio line in the legend. |
| `probes/e1-drive/tools/verify_e1_drive.mjs` | eight non-browser audio checks (table, curves, WAV hashes, no-context construction, typed errors, dispose, live accessor). |
| `probes/e1-drive/tools/capture_browser.mjs` | `--mode audio`: force-off, pre-gesture silence, trusted gesture, three RPM holds, RMS, mute, screenshots, console gate. Existing modes untouched. |

### 2.1 Data flow

```
wasm e1_step -> RacingPhysics::Car::Engine().RPM()  (~800 idle .. limiter)
        │
        ▼
e1_engine_rpm()  (float; -1 before a world)
        │
        ▼
app.js driveEngineAudio()  ->  engineAudio.setRpm(rpm)   once per frame
        │                         │
        │                         ├── EngineNVolume PLF -> six GainNodes
        │                         └── EngineNPitch  PLF -> playbackRate
        ▼
HUD: state / rpm / active layers / mute      analyser RMS for diagnostics
```

### 2.2 Captures and the RPM hold

`window.e1DriveAudio` exposes the live instance for diagnostics and a
**presentation-only** RPM override:

```js
window.e1DriveAudio.getDiagnostics();  // same object as engineAudio.getDiagnostics()
window.e1DriveAudio.setRpm(3015);      // hold this RPM for the capture, per frame
window.e1DriveAudio.clearRpm();        // return to the simulation RPM
window.e1DriveAudio.setMuted(true);    // same path as M
```

The override is never set by normal play; only `--mode audio` uses it, and the
page HUD marks it `capture hold`.

## 3. Gesture rule

- Constructing the module at page load creates **no** `AudioContext`, performs
  no fetch and decodes nothing (`state: idle`, `contextState: none`).
- `ensureStarted()` is called only from `pointerdown` or a driving-key `keydown`
  (`W/A/S/D`, arrows, Space) and `M`. Restart (`R`), ghost (`G`) and invert-steer
  (`I`) do not start audio: those keys are used by headless captures and must
  not create an `AudioContext` (Chromium then logs an autoplay warning, breaking
  the console gate).
- The audio-capture gesture is a real CDP
  `Input.dispatchMouseEvent` press/release at the viewport centre. Edge is
  launched **without** `--autoplay-policy=no-user-gesture-required`, so the
  gesture requirement is real.
- `pagehide` disposes the instance: sources stopped, graph disconnected, context
  closed, buffers dropped.

## 4. Mute and HUD

- `M` toggles the module's master gain (`0`/`0.5`) with its own 10 ms smoothing.
  It works before start (the first start then begins muted).
- The HUD row is:

```
audio     running · 6000 rpm · 1 layer · M mute
audio     running · 3015 rpm · 2 layers · capture hold · muted (M)
audio     idle · drive key/click starts · M mute
audio     off (?audio=0)
audio     audio unavailable: fetch-failed
```

`layers` counts layers whose retail gain is above `0.0005` at that RPM, so at
1500 RPM it is 2 and at 6000 RPM it is 1 (the other layers are held at gain 0 by
the stored curves).

## 5. Error states

The module's typed statuses are passed straight to the HUD; the page never logs
to the console and never falls back to another sound.

| state / reason | page behaviour |
| --- | --- |
| `idle` | silent; HUD explains how to start |
| `loading` | silent; HUD `loading six layers` |
| `running` | audible; follows RPM |
| `unavailable / no-audio-context` | silent; `audio unavailable: no-audio-context` |
| `unavailable / fetch-failed` | silent (missing WAV or non-2xx); typed row |
| `unavailable / decode-failed` | silent; typed row |
| `unavailable / resume-failed`, `not-running` | silent; typed row (gesture/autoplay) |
| `unavailable / rpm-unavailable` | silent; the wasm build has no `_e1_engine_rpm()` |
| `unavailable / rpm-invalid` | silent; RPM was non-finite/negative (never clamped silently) |
| `disposed` | page is unloading |

`?audio=0` bypasses construction entirely: `window.e1DriveAudio.getDiagnostics()
=== null`, no WAV request and no context.

## 6. Verified result

### 6.1 Non-browser gate

`node probes/e1-drive/tools/verify_e1_drive.mjs` → **826/826 checks, 0
failures** (818 existing + 8 audio). The new checks:

1. the shipped curve table equals `_work/audio/engine-model.json` (slots, wave,
   label and every FLT point);
2. only slot 7 `RaceV8_Engine_decel` is excluded, as documented;
3. `x = RPM × 0.0001` and all six gains/rates equal an independent PLF
   evaluation of the decoded model at 1500/3015/6000 (max delta **0**);
4. the six WAVs under `_work/audio/` are present, the recorded sizes and
   SHA-256 match the model;
5. construction + `setRpm` create no `AudioContext` and decode nothing;
6. negative RPM throws `RangeError`, non-finite RPM throws `TypeError`;
7. `dispose()` reports `disposed` with no live layers/buffers;
8. `_e1_engine_rpm()` is `-1` before a world and returns the live engine RPM
   after `e1_create` (measured **799.75 RPM** at the settled spawn; limiter
   7250).

`run.json` carries the `engineAudio` block (module, model, rpm list, max delta,
WAV hash result, before/after-create RPM).

### 6.2 Browser gate (`--mode audio`)

Command: `node probes/e1-drive/tools/capture_browser.mjs --mode audio`
→ **PASS, 16/16 checks, 0 console messages, 0 failures.**

| RPM | active layer (gain / rate) | max live gain delta | max live rate delta | RMS | peak |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1500 | slot 1 `1500` 1.000000 / 1.000240; slot 2 `1995` 0.367647 / 0.750188 | 1.30e-8 | 5.76e-8 | 0.0643 | 0.1201 |
| 3015 | slot 3 `3015` 1.000000 / 1.004347; slot 4 `4005` 0.022059 / 0.755753 | 8.57e-10 | 5.93e-8 | 0.0394 | 0.1159 |
| 6000 | slot 6 `6000` 1.000000 / 0.999775 | 1.23e-14 | 4.98e-8 | 0.1391 | 0.4075 |

All live-vs-retail deltas are far inside the required **1e-3**. Mute drives the
analyser RMS to **0.00000** while the context stays `running`; unmute restores
**0.1330**. The six decoded buffers are mono, 48 kHz, durations 1.04 / 1.08 /
0.84 / 0.992 / 1.2 / 1.4 s (peaks match the module evidence).

Capture checks: `?audio=0` leaves no instance and an explicit off HUD; before a
gesture the page is `idle` with `contextState none` and 0 decoded layers; the
trusted mouse gesture reaches `running` with 6/6 layers; each RPM hold matches
the retail curves and is non-silent; the HUD names state/RPM/layers; mute is
silent and the HUD says `muted (M)`; unmute recovers; console is clean.

### 6.3 Regression

| gate | result |
| --- | --- |
| `node probes/e1-drive/tools/verify_e1_drive.mjs` | **826/826**, 0 failures (818 existing unchanged) |
| `node probes/e1-drive/tools/capture_browser.mjs --mode lap` | PASS, 20 captures, **0 console**, 0 assertions, 15/20 byte-exact packet hashes (the documented Node/Edge last-bit cases) |
| `node probes/e1-drive/tools/capture_browser.mjs --mode free` | PASS, 20 captures, **0 console**, 0 assertions, 14/20 byte-exact |
| `python tools/verify_asset_probe.py --skip-build` | **30/30 PASS** |
| `python tools/check_e1_poc.py` (server up) | **23 PASS, 0 FAIL, 0 INFO** |

The free-roam capture presses `R`; the gesture filter (§3) keeps that synthetic
key from creating a context, which is why the free run is console-clean again.

## 7. Evidence

| path | content |
| --- | --- |
| `_work/e1-drive/browser-evidence-audio.json` | 16 checks, force-off, pre-gesture, gesture, six decoded buffers, three RPM rows with every layer gain/rate/delta/RMS/peak, mute/unmute, console |
| `_work/e1-drive/browser-audio-running.png` | 1600×900 running at 6000 RPM, HUD `audio running · 6000 rpm · 1 layer · capture hold · M mute` |
| `_work/e1-drive/browser-audio-muted.png` | same frame muted, HUD `muted (M)` |
| `_work/e1-drive/run.json` | `engineAudio` block and the full 826-check report |
| `_work/logs/e1-drive/p71-verify.stdout.log` | verifier output |
| `_work/logs/e1-drive/p71-capture-audio.stdout.log` | audio capture summary |
| `_work/logs/e1-drive/p71-capture-lap.stdout.log`, `p71-capture-free.stdout.log` | regression captures |
| `_work/logs/e1-drive/p71-asset-probe.log`, `p71-check-e1-poc.log` | suite logs |

Screenshot hashes (SHA-256):

| file | bytes | SHA-256 |
| --- | ---: | --- |
| `browser-audio-running.png` | 465,905 | `e7b12a5ec46f9a2f7a7d42dff8db4701954478d53ae8672ca94629bf9cf81fd8` |
| `browser-audio-muted.png` | 465,999 | `454eae5837ed086a3f060c3c06bb24b9a16c4f9b2dc4d34510741737d34d12e1` |
| `browser-evidence-audio.json` | 12,607 | `f8f7825d6912e8a214c42f7a3af360c2292b75cf54d2d122246678705b28466e` |

## 8. Reproduce

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

# rebuild the module after the new export (deterministic A/B)
& $node probes/e1-drive/tools/build_module.mjs

# non-browser gate (826 checks)
& $node probes/e1-drive/tools/verify_e1_drive.mjs

# audio capture: gesture, 3 RPM holds, mute, console + screenshots
& $node probes/e1-drive/tools/capture_browser.mjs --mode audio

# regressions
& $node probes/e1-drive/tools/capture_browser.mjs --mode lap --port 8862 --debug-port 9342
& $node probes/e1-drive/tools/capture_browser.mjs --mode free --port 8863 --debug-port 9343

$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py tools/verify_asset_probe.py --skip-build
& $py tools/check_e1_poc.py
```

The wasm rebuild changes the module bytes (1,006,289 B,
`sha256:eb9efc0064f0d871…`) from the 1,006,186 B build pinned by older
measurement documents; those documents remain their own historical records and
are not gates. The physics state hashes are unchanged (the T-007 anchor still
matches in the 826-check run).

The page server must be restarted after this change: a process started before
`tools/serve.mjs` gained the `/audio/` and `/_work/audio/` routes cannot serve
the module. The capture tools start their own server, so they are unaffected.

## 9. Limits and non-claims

1. **One graph, one parameter.** Only retail `Race_V8_engine` is played, and
   only its six RPM layers. Throttle, damage, induction, supercharger,
   clutch/decel, `EngineType`, cone/occlusion, EQ/sends and `AOBJ` scripts are
   not wired.
2. **Not the retail mixer.** The bus is `gain → analyser → safety compressor →
   destination`; master gain 0.5 is the module's harness choice, not a decoded
   retail level.
3. **No car-to-bank mapping.** The slice does not claim that any roster car uses
   `Race_V8`; it is the one decoded graph. Other banks need their own decode.
4. **`RaceV8_Engine_decel` is excluded** (slot 7): its retail volume chain is
   flat zero and audible playback needs clutch/throttle state that is not
   modelled.
5. **Loop seams.** The 66 ms decoded ADPCM fade-in repeats at every loop point
   exactly as decoded; the module does not crossfade or repair it.
6. **Pitch is the stored curve**, including its break at 2.0 (one octave up);
   the rate at a label differs from `rpm / label` by up to ~0.44 % because the
   stored breakpoints are not exactly `2 × label / 10000`.
7. **The WAVs are game data.** They stay under `_work/audio/`, are served
   read-only by the local tools and are **not committed**. A shipped build needs
   its own asset pipeline or the E2 wasm ADPCM decoder.
8. **Headless Chromium on Windows only** was measured (`decodeAudioData`,
   `setTargetAtTime`, analyser). No other browser, latency, CPU or retail-mix
   comparison is claimed.
9. **bfcache.** `pagehide` disposes the context; a page restored from the
   back/forward cache stays silent until reloaded. Normal navigation and reload
   re-create it.
10. **Capture-only RPM hold.** `window.e1DriveAudio.setRpm` is a diagnostic
    override used by `--mode audio`; normal play always uses the simulation RPM.
