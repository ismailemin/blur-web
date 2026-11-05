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

## Limits

- Only the `Race_V8` engine graph is decoded. Other banks exist (for example
  `audi_i4.baf`, `lotus_i4.baf`, `dodge_v8.baf`, `ford_i5.baf` and the `race_*`
  family) with their own RPM labels and curves. The E1 car-to-audio mapping is
  not established; none of them were decoded here.
- Only the RPM layer is wired. Throttle, damage, induction, supercharger,
  clutch/decel, cone/occlusion and mixer/EQ layers are left for E2.
- The harness uses a safety compressor; it is not the retail bus/limiter.
- Decoded WAVs are game data and live under `_work/`; they are not committed.

See `docs/work/analysis/audio-feasibility.md` for the evidence, hashes and
recommendation.
