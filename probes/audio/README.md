# probes/audio — engine audio feasibility

Data/feasibility probe for the E1 browser PoC. It does not integrate audio into
`e1-drive` and makes no full-game claim. It extracts one retail engine bank,
decodes its ADPCM loops to WAV, reads the retail RPM graph, and drives the loops
through Web Audio with the exact retail curves.

## What is here

| File | Role |
| --- | --- |
| `extract_baf.py` | PAK V2 reader + BAF parser + PS2-VAG ADPCM decoder → WAV + JSON |
| `extract_dat.py` | PAK V2 reader for a named `AOBJ`/other asset → `_work/audio/` |
| `inspect_dat.py` | Bounded `AOBJ` `.dat` component walk and piecewise-linear curve reader |
| `dump_engine_curves.py` | Builds `_work/audio/engine-model.json` from `race_v8_engine.dat` |
| `serve.mjs` | Read-only server for the harness and `_work/audio` |
| `harness/index.html`, `harness/harness.js` | Web Audio harness (6 RPM loops + exact PLF gains/pitches) |
| `capture_harness.mjs` | Headless Edge verification: decoded buffers, gains/rates, RMS, console, screenshot |
| `web/engine-audio.js` | **Standalone ES module** — six looping layers + exact retail PLF curves, gesture-gated start, typed failure states |
| `web/index.html`, `web/module-harness.js` | Harness page for the module; exposes `window.engineAudioProbe` |
| `capture_module.mjs` | Headless Edge verification of the module (no autoplay override, real click) |
| `dump_tyre_collision.py` | Builds `_work/audio/tyre-collision-model.json` and the AOBJ script disassembly |
| `web/tyre-collision-audio.js` | **Standalone ES module** — dry/offroad tyre loops + material-routed CollisionWorld one-shots, gesture-gated start, typed failures |
| `web/tyre-collision.html`, `web/tyre-collision-harness.js` | Harness page; exposes `window.tyreCollisionProbe` |
| `capture_tyre_collision.mjs` | Headless Edge verification of the tyre/collision module |
| `runtime-audio.mjs` | **Runtime ES module** — every game event from decoded retail waves; `createAudio({ ctx, baseUrl })` |
| `data/runtime-audio.json` | Committed runtime catalog: event → source file, gain, loop, pitch range, provenance |
| `tools/build_runtime_audio.mjs` | Deterministic builder for `data/runtime-audio.json` |
| `tools/verify_runtime_audio.mjs` | Re-derives every source, checks hashes, determinism and the module contract |
| `tools/redecode_runtime_sources.py` | Independent PAK/ADPCM re-decode reference used by the verifier |

## Run

Use the bundled Python:

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py probes/audio/extract_baf.py --list
& $py probes/audio/extract_baf.py --wave RaceV8_Engine_720 --wave RaceV8_Engine_1500 `
  --wave RaceV8_Engine_1995 --wave RaceV8_Engine_3015 --wave RaceV8_Engine_4005 `
  --wave RaceV8_Engine_4995 --wave RaceV8_Engine_6000 --wave RaceV8_Engine_decel
& $py probes/audio/extract_dat.py --asset "\audio\dat\race_v8_engine.dat" `
  --out _work/audio/race_v8_engine.dat
& $py probes/audio/inspect_dat.py _work/audio/race_v8_engine.dat --curves `
  --json _work/audio/race_v8_engine.dat.json
& $py probes/audio/dump_engine_curves.py
node probes/audio/serve.mjs --port 8810
```

Open <http://127.0.0.1:8810/> and press **Play**. The page fetches
`_work/audio/engine-model.json` and the WAVs. If they are missing it switches to
a clearly labelled **MOCK** mode (scheduling only, no sound).

`inspect_dat.py` prints `PARTIAL` and exits 2 for this file because the declared
component count is 119 while the bounded walk reaches 114; the curve output is
printed before the exit. The model dump does not depend on the exit code.

Automated capture:

```powershell
node probes/audio/capture_harness.mjs
```

## Reusable module

`probes/audio/web/engine-audio.js` packages the same six layers and curves as an
ES module for the E1 page. It creates no `AudioContext` until `ensureStarted()`
is called from a user gesture, and reports `unavailable` + `reason` instead of
playing a substitute.

```powershell
node probes/audio/serve.mjs --port 8810
# open http://127.0.0.1:8810/web/ and press "Start audio"
node probes/audio/capture_module.mjs
```

API, integration recipe, evidence and limits:
`docs/work/analysis/audio-engine-module.md`. The P62 harness above is unchanged
(`/` and `/harness.js` still serve the same bytes).

## Tyre + collision module

`probes/audio/web/tyre-collision-audio.js` extends the same pattern to the
retail `Wheel_Dry` / `Wheel_OffRoad` loops and the `CollisionWorld` impact
tables. It exposes `setSurface('dry'|'offroad')`, `setSlip(slip, speed)`,
`triggerImpact(strength, material)`, `setMuted`, `dispose` and gesture-only
`ensureStarted()`.

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
# decode the banks/graphs listed in the analysis doc, then:
& $py probes/audio/dump_tyre_collision.py
node probes/audio/serve.mjs --port 8810
# open http://127.0.0.1:8810/web/tyre-collision.html and press "Start audio"
node probes/audio/capture_tyre_collision.mjs
```

API, decoded material routing, evidence and limits:
`docs/work/analysis/audio-tyre-collision.md`.

## Runtime audio catalog

`probes/audio/runtime-audio.mjs` is a standalone ES module (no build step, no
framework) that plays every documented game event from decoded retail waves. The
committed catalog is `probes/audio/data/runtime-audio.json`; schema
`blur.audio-runtime/1`.

### Import contract

```js
import { createAudio, AUDIO_SCHEMA, EVENT_IDS } from './probes/audio/runtime-audio.mjs';

const ctx = new AudioContext();                 // created by the page on a user gesture
const audio = createAudio({
  ctx,
  baseUrl: '/_work/audio/',                     // decoded retail WAVs (not committed)
  // catalogUrl: '/probes/audio/data/runtime-audio.json',  // optional override
  // catalog: parsedCatalog,                     // optional: skip the catalog fetch
  // fetchImpl, masterGain, limiter, analyser, verifyHashes, smoothing, fadeIn, fadeOut
});

// One-shots and loops. `play` returns immediately; await `handle.ready` for the
// typed result. It never throws for an unknown/unsupported event.
const click = await audio.play('ui-click').ready;
// click.status: 'queued' | 'playing' | 'unsupported' | 'failed' | 'stopped'
// click.reason: null | 'unknown-event' | 'catalog-unavailable' | 'context-not-running' | ...

// Continuous engine bed (six retail RPM layers).
await audio.play('engine').ready;
audio.setEngine({ rpm: 4200 });                 // or audio.setEngine(4200)

// Continuous tyre skid (three retail lateral loops, retail slip/speed curves).
const skid = await audio.play('tyre-squeal', { slip: 0.2, speed: 12 }).ready;
skid.set({ slip: 0.1, speed: 8 });              // update without restarting

// Impact: material route or car-size table, optional retail CollisionVolume.
await audio.play('impact', { material: 'Metal', strength: 16 }).ready;
await audio.play('impact', { size: 'small' }).ready;

// Loops return a stoppable handle.
const shield = await audio.play('weapon-shield').ready;
shield.stop();

audio.stop();                                   // stop every voice and the engine bed
const state = audio.snapshot();                 // catalog/engine/voices/decoded/stats
```

`play(event, options)` options: `variant` (id, wave or index), `gain` (caller
multiplier, default 1), `rate` (clamped to the catalog pitch range), `loop`,
`when`, `fadeIn`, plus event-specific `slip`/`speed` (`tyre-squeal`),
`material`/`size`/`route`/`strength` (`impact`), and `layerGain` (per-layer
multiplier for layered events). `handle.set(next)` updates a loop in place;
`handle.stop(fade)` stops it. `setEngine` accepts a number or `{ rpm }` and
returns the evaluated layers. `snapshot()` returns the schema, catalog state,
context state, engine layers, active voices, decoded buffers and counters.
`setMuted(value)` is an optional helper that ramps the master gain.

The module verifies each fetched WAV against the catalog SHA-256 before decoding
(`verifyHashes: true` by default). A mismatch is a typed `hash-mismatch`
failure; the module does not play a substitute. If the platform has no
`crypto.subtle`, the module records `hashVerified: null` in `snapshot().decoded`
instead of claiming a verified file; pass `verifyHashes: false` to skip the
check explicitly. `masterGain` defaults to `1.0` (no invented attenuation) and a
safety limiter is enabled by default; both are integration choices, not retail
values.

### Event table

23 events. `N` is the number of source waves (layers are simultaneous, variants
are alternatives). Gain is the retail linear gain when `source=retail`; `neutral`
means the retail graph gain is control-linked and the runtime applies `1.0` with
the retail curve where one exists. Pitch is the catalog playback-rate range.

| Event | Kind | N | Source wave(s) | Loop | Gain | Pitch |
| --- | --- | ---: | --- | :---: | ---: | ---: |
| `engine` | engine | 6 | RaceV8_Engine_1500 … 6000 | yes | 1 (neutral) | 0.00390625–2 |
| `tyre-squeal` | loop | 3 | Asphalt_Lateral_1/2/3 | yes | 1 (neutral) | 0.85–1.69 |
| `impact` | one-shot | 59 | 17 collision tables (59 waves) | no | 1 (neutral) | 1–1 |
| `pickup-bolt` | one-shot | 1 | PerkPickup (shared) | no | 1 (retail) | 1–1 |
| `pickup-shunt` | one-shot | 1 | PerkPickup (shared) | no | 1 (retail) | 1–1 |
| `pickup-barge` | one-shot | 1 | PerkPickup (shared) | no | 1 (retail) | 1–1 |
| `pickup-mine` | one-shot | 1 | PerkPickup (shared) | no | 1 (retail) | 1–1 |
| `pickup-shock` | one-shot | 1 | PerkPickup (shared) | no | 1 (retail) | 1–1 |
| `pickup-nitro` | one-shot | 1 | PerkPickup (shared) | no | 1 (retail) | 1–1 |
| `pickup-shield` | one-shot | 1 | PerkPickup (shared) | no | 1 (retail) | 1–1 |
| `pickup-repair` | one-shot | 1 | PerkPickup (shared) | no | 1 (retail) | 1–1 |
| `weapon-bolt` | one-shot | 1 | BlindFireFire | no | 1 (retail) | 1–1 |
| `weapon-shunt` | one-shot | 1 | ShuntFire | no | 1 (retail) | 1–1 |
| `weapon-barge` | one-shot | 1 | BargeFire | no | 1 (retail) | 1–1 |
| `weapon-mine` | one-shot | 1 | MineForwardsFire | no | 1 (retail) | 1–1 |
| `weapon-shock` | one-shot | 2 | ShockFire, ShockFireLFE | no | 1 (retail) | 1–1 |
| `weapon-nitro` | one-shot | 3 | NitroFire, NitroFireSweetener, NitroBackwardFire | no | 1 (retail) | 1–1 |
| `weapon-shield` | loop | 1 | ShieldActivate | yes | 1 (neutral) | 1–1 |
| `weapon-repair` | one-shot | 1 | RepairActivate | no | 1 (retail) | 1–1 |
| `ui-click` | one-shot | 1 | FE_Forward | no | 0.794328 (retail) | 1–1 |
| `countdown` | one-shot | 2 | HUD_CountDown03, HUD_RaceEndCountDown10 | no | 3.16228 (retail) | 1–1 |
| `finish` | one-shot | 1 | HUD_MPFinishIn | no | 1 (retail) | 1–1 |
| `wreck` | one-shot | 1 | HUD_Wrecked | no | 1 (neutral) | 1–1 |

`impact` routes by `E_EffectMaterial` (14 world tables: concrete/rock/brick,
vegetation, wood, metal/plastic, glass, rubber, the fence/armco/hollow/railing/
post variants) or by car size (`car-large`, `car-medium`, `car-small`). The
default route is `car-medium`; that selection is an integration choice and is
marked `selectionProvisional: true`. `strength` drives the retail
`CollisionVolume` dB curve; without it no dynamic attenuation is applied.
`countdown` has two variants: `short` (`HUD_CountDown03`, gain 3.16228) and
`long` (`HUD_RaceEndCountDown10`, gain 2.23872); the table shows the default
`short` gain.

### Unsupported and shared sources

The catalog has **0 unsupported events**: all 23 events resolve to decoded retail
waves. The eight `pickup-<type>` events have no type-specific retail pickup wave
— `Pickups.dat` ships one `PerkPickupSound` for every perk. They therefore carry
`sharedSource: true`, `typeSpecific: false`, `typeSpecificStatus:
"unsupported"` and `typeSpecificReason: "no-type-specific-pickup-wave"`, and play
the shared retail `PerkPickup` wave. No beep or substitute is synthesised.

Every source records `file`, `sha256`, `bytes`, `loop`, `sampleRate`, `channels`,
`samples`, `durationSeconds` and a `provenance` block with the PAK name, BAF
asset, bank SHA-256, wave index/data range, graph path/SHA-256 and component
name. The decoded WAVs live under `_work/audio/` (game data, not committed); the
catalog is committed metadata only.

### Build and verify

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
node probes/audio/tools/build_runtime_audio.mjs
node probes/audio/tools/verify_runtime_audio.mjs
```

The verifier re-runs the builder twice (determinism), re-decodes every unique
source from the retail PAK with `redecode_runtime_sources.py`, checks every file
hash/size, cross-checks `audio-manifest.json` / `tyre-collision-model.json`,
checks every retail gain/rate against its graph component, checks the
engine/tyre/impact curves, and exercises the module with a mock AudioContext
(including a tampered-file hash failure). It prints `N/M checks passed`.

## Format notes

- `root.pak` is PAK V2 with `packet-zlib` (`codec 4`).
- `\\audio\\race_v8.baf` is a `BANK`/`WAVE`/`DATA` wave bank, version 4. The
  engine loops are format `7` (`Audio::Core::uADPCM4Bit`), 48 kHz, mono.
- ADPCM blocks are 33 bytes = 64 samples (`BATCH_SIZE_IN_SAMPLES 64`,
  `BATCH_SIZE_IN_BYTES 33`). The decoder is a direct port of
  `ADPCM4bitDecoder::DecodeBlock`.
- The `.dat` graph is `AOBJ` version 2.11. `race_v8_engine.dat` declares 119
  components; the bounded walk reaches the string table after 114. The five
  unused names are `Engine0Sound`, `Engine0Volume`, `SuperchargerGroupVolume`,
  `SteamVolumeLevel`, `FlamesVolumeLevel`. This is recorded, not hidden; it does
  not affect the Engine1..7 curves used here.
- `RaceV8_Engine_720` exists in the bank but has no `Engine0Sound`/`Engine0Volume`
  component in this graph, so it is not used by the model.
- Tyre/collision waves use the same BAF/ADPCM format, but many have a header
  sample count that is not a multiple of 64. `extract_baf.py` decodes whole
  blocks and truncates/pads to the header count, matching
  `decoderadpcm4bit.cpp:133-136`, and records the extent in the report.
- `inspect_dat.py` now reads `VectorIn` (16 B), `VectorOut` (40 B),
  `CoordinateOutput` (8 B), `ImpactFilter` (type 198, 28 B), `SampleAndHold`
  (8 B), `Exponent` (16 B), low/high pass (16 B) and the one-shot sound-table
  layout from the upstream headers. Before the `VectorIn` fix, four phantom
  `ParameterIn` components shifted every later control index in the do_* graphs.
- `collisionworld.dat` has 14 surface tables and an 18-value
  `CollisionScript` material routing; the full mapping is in
  `docs/work/analysis/audio-tyre-collision.md` §4.2.

## Limits

- Only the `Race_V8` engine graph is decoded. Other banks exist (for example
  `audi_i4.baf`, `lotus_i4.baf`, `dodge_v8.baf`, `ford_i5.baf` and the `race_*`
  family) with their own RPM labels and curves. The E1 car-to-audio mapping is
  not established; none of them were decoded here.
- Only the RPM layer is wired. Throttle, damage, induction, supercharger,
  clutch/decel, cone/occlusion and mixer/EQ layers are left for E2.
- The harness uses a safety compressor; it is not the retail bus/limiter.
- The runtime catalog is one engine graph (`Race_V8`), one tyre surface model
  (dry asphalt skid), one car/world impact model, and the eight multiplayer
  perk types. Other car engine banks, offroad tyre layers, music, ambience,
  weapons' projectile loops, and the retail mixer/bus/ducking are not in this
  catalog. Unsupported cases stay typed; nothing is substituted.
- `pickup-<type>` uses the shared retail `PerkPickup` wave because the bank has
  no per-type pickup sound. This is recorded on every pickup event.
- Decoded WAVs are game data and live under `_work/`; they are not committed.

See `docs/work/analysis/audio-feasibility.md` for the evidence, hashes and
recommendation.
