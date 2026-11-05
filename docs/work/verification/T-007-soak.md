# T-007 soak — deterministic long session (5 simulated minutes, two runs)

**Date:** 5 November 2026
**Owner:** P42 (sub-agent)
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
`docs/work/analysis/e1-drive-slice.md` §18 and this record. No change to the
engine, the wasm module, `probes/render-packet/`, `probes/car-parts/`, `tools/`,
`upstream/` or `game-data/`. Physics is unchanged: the soak's drive and sprint
state sequences are the verifier's P36/P37 anchors and every telemetry metric and
trace hash is the P39 value.

## Result

The page now has a deterministic soak mode and a headless tool:

```text
/?soak=1&soakSeconds=300&soakTicksPerFrame=1&car=corvette-zr1-stock
node probes/e1-drive/tools/soak_browser.mjs --minutes 5 --runs 2 --ticks-per-frame 1
```

The plan is **drive → sprint → telemetry**, repeated until 18,000 fixed 1/60 s
ticks (5 simulated minutes) have run. The first drive uses the page's `e1_create`
world; every later segment starts with an in-place `e1_reset()` and builds a new
packet timeline, which forces a packet reload (level + real track visual + car
body) and exercises the same restart, respawn and mode-switch paths a user session
uses.

| evidence | run 1 | run 2 |
| --- | ---: | ---: |
| simulated ticks | **18,000** (300.000 s) | **18,000** (300.000 s) |
| wall time in headless Edge | **70.20 s** | **70.68 s** |
| cycles / drive / sprint / telemetry segments | **13 / 13 / 13 / 12** | **13 / 13 / 13 / 12** |
| packet timeline loads | **26** | **26** |
| state/packet checkpoints | **38** | **38** |
| console messages (all kinds) | **0** | **0** |
| NaN / Inf states, aborts | **0 / 0** | **0 / 0** |
| wasm heap | **268,435,456 B** constant | **268,435,456 B** constant |
| scheduler pool | head **5**, size **16**, queued **2**, group **0**, deps **0** | same |
| GPU packet buffers | **208 created / 200 destroyed / 8 live** | same |
| frame time p50 / p95 / p99 / max | **7.63 / 8.06 / 8.535 / 11.013 ms** | **7.97 / 8.06 / 8.52 / 8.995 ms** |
| CPU work per frame p50 / p95 / p99 / max | **0.325 / 0.59 / 0.68 / 0.98 ms** | **0.315 / 0.59 / 0.695 / 1.405 ms** |
| JS heap after GC (early → late mean) | **39.87 → 38.05 MB** (drift **−1.82 MB**) | **39.86 → 38.10 MB** (drift **−1.76 MB**) |

The 8,688 rendered frames per run are **one tick per rendered frame** for the
drive and sprint frames (3,874 + 4,762), plus transition frames that are not
counted in the frame-time percentiles. Headless rAF here runs at ~123 Hz
(8,688 frames / 70 s), not 60 Hz, so 18,000 one-tick frames take 70 s of wall time
instead of 300 s; the simulated duration remains 300.000 s. The 26 timeline loads
are 13 drive + 13 sprint reloads; the 12 telemetry segments run synchronously
inside transitions and add no packet load. Geometry uploads are exactly
`3 × 26 = 78`; uniform writes are exactly `8,688 = rendered frames`; draws issued
are exactly `8,688 × 266 = 2,311,008`.

**Determinism:** the two runs produced **38 identical checkpoint records**
(label, cycle, tick, state hash, last-update hash, packet hash, telemetry
manoeuvre aggregates and metrics). Every complete drive segment reproduced
`sha256:83f76590…008e1f` and every complete sprint segment reproduced
`sha256:fdd893bd…e62622` plus finish tick 258 / 2.800 s. Every telemetry segment
reproduced the P39 metrics exactly and the three per-tick state-hash aggregates
(`accel f1ba870a…`, `brake d5e1c91c…`, `lateral 1e6109ca…`). The last sprint of
the 5-minute budget is truncated by the tick budget and is labelled `truncated`;
it is excluded from the node-anchor comparison and is still identical across the
two runs. Browser packet hashes are **not** byte-equal to the Node producer's
packet hash (the documented Edge-vs-Node `Math.atan2`/`Math.sin` last-bit
difference); the two Edge runs' packet hashes **are** identical, and state
sequences, finishes and telemetry hashes are byte-exact against Node.

**Console:** 0 messages of any kind in both runs (no errors, warnings, logs or
exceptions). The 4-ticks-per-frame fast path was also run end to end and returned
`PASS` with the same checkpoint hashes; the one-tick run is the evidence table
above because it advances one engine tick per rendered frame.

**No regression:** `verify_e1_drive.mjs` remains **488/488 PASS**, the portable
`verify_asset_probe.py --skip-build` suite is **29/29 PASS**, and the browser
`capture_browser.mjs --mode restart` pass is still `clean-console-and-gates` for
all five cars with 0 console messages after the consumer buffer-lifecycle change.

## The plan

`probes/e1-drive/web/app.js` adds `?soak=1` only; the normal drive, sprint,
telemetry, restart and capture paths are unchanged.

| segment | ticks | start | end condition |
| --- | ---: | --- | --- |
| `drive` | 300 | first: page `e1_create`; later: `e1_reset()` + new timeline | tick 300 (the 2 s throttle / 2 s coast / 1 s brake script) |
| `sprint` | ~379 | `e1_reset()` + new timeline | finish + 120-tick brake tail, or 600-tick cap |
| `telemetry` | ~779 | the series' own three `e1_reset()` builds | accel 86 m, brake 80→0, lateral sweep |

The loop advances `soakTicksPerFrame` ticks per animation frame (page default 1;
the tool also supports 4). Tick inputs, state hashes, packet hashes, telemetry
metrics and the final tick count do **not** depend on frame pacing; only the
frame-time measurements do. This is why two runs can be compared exactly even
though their wall-clock frame intervals differ.

Every segment also records a checkpoint: engine tick, state hash, last-update
hash and packet hash, the scheduler pool/group record, wasm heap, JS heap after
`window.gc()`, and the consumer's buffer/upload counters. One heap/pool/upload
sample is recorded per simulated second.

## What was measured

- **Frame time:** `requestAnimationFrame` interval per rendered frame, plus the
  CPU work inside that frame (step + adapter + consumer submit). Percentiles use
  linear interpolation over the sorted sample; the first 30 samples and the
  transition frames are excluded from `steadyFrameMs`. Transition work (world
  rebuild, packet reload, synchronous telemetry series) is reported separately in
  `transitions[]`.
- **Ticks:** engine ticks, not wall time: `soakTotalTicks`, per-segment ticks, and
  the packet/state tick counts at every checkpoint.
- **Uploads:** the consumer already counted mesh uploads, uniform writes and draws;
  the soak adds `packetLoads`, `buffersCreated`, `buffersDestroyed` and derives
  `buffersLive`. A timeline load must upload exactly the three packet meshes and
  leave exactly 8 live buffers (3 vertex + 3 index + uniform + scene). The
  previous packet's buffers are destroyed on reload (`releaseGeometry()`), so
  GPU memory is bounded by one packet rather than by the number of mode switches.
- **Wasm heap:** `module.HEAPU8.length` at every sample and checkpoint.
- **Scheduler:** `e1_diag()` pool size/head, queued/executing counts and the live
  scene's group handle/dependencies at every checkpoint.
- **JS heap:** `performance.memory.usedJSHeapSize` (with
  `--enable-precise-memory-info`) at every sample, and after `window.gc()` at every
  checkpoint (`--js-flags=--expose-gc`). The raw samples are noisy because packet
  timelines are allocated/freed; the checkpoint values are the retained heap.
- **Hashes:** the same canonical `hashOf`/`packetHash` the verifier uses for state
  sequences, per-update hashes and packet hashes.

Headless Edge is a proxy. The headless compositor here is not vsync-limited, so
the wall-clock frame intervals are **not** the user's display cadence and this is
not a GPU/retail frame-rate claim. The CPU work per frame and the absence of
aborts/leaks are the measured facts.

## Verification gate

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

# two independent 5-simulated-minute runs, one tick per animation frame
& $node probes/e1-drive/tools/soak_browser.mjs --minutes 5 --runs 2 --ticks-per-frame 1
# same plan accelerated to four ticks per frame (optional fast path)
& $node probes/e1-drive/tools/soak_browser.mjs --minutes 5 --runs 2 --ticks-per-frame 4

# existing node gate must stay at 488/488
& $node probes/e1-drive/tools/verify_e1_drive.mjs

# browser restart path still clean after the buffer lifecycle change
& $node probes/e1-drive/tools/capture_browser.mjs --mode restart --port 8861
& "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe" `
      tools/verify_asset_probe.py --skip-build
```

`soak_browser.mjs` exits non-zero on any of: page status not `PASS`, a console
message, fewer than the requested simulated ticks, a page check failure, a
missing/extra checkpoint, a drive/sprint state sequence mismatch, a finish
mismatch, a telemetry metric/hash mismatch, or different checkpoint hashes
between the two runs. The Node-vs-Edge packet hash is reported informationally:
the browser camera or wheel matrix can differ in the last `Math.atan2`/`Math.sin`
bit (documented since P23); state sequences are the exact gate.

## Evidence

| path | content |
| --- | --- |
| `_work/e1-drive/browser-evidence-soak.json` | two runs, spec, frame/heap/pool/buffer summaries, transitions, comparisons, verdict |
| `_work/e1-drive/soak-run-1.json`, `soak-run-2.json` | the full per-run report, console log, CDP heap usage and screenshots |
| `_work/e1-drive/browser-soak-run{1,2}-{start,mid,end}.png` | 1600×900 headless Edge screenshots |
| `_work/logs/e1-drive/edge-soak.log` | Edge process log |
| `_work/logs/e1-drive/soak-5min-1tick.log` | tool stdout for the one-tick run |
| `_work/logs/e1-drive/soak-5min.log` | tool stdout for the accelerated run |
| `_work/logs/e1-drive/soak-summary-p42.json` | compact metric extract used for the tables |
| `_work/logs/e1-drive/edge-restart-p42.log` | browser restart regression after the consumer change |
| `_work/logs/e1-drive/verify-soak-run.log` | the 488/488 verifier run after the change |
| `_work/logs/e1-drive/verify-asset-probe-p42.log` | 29/29 portable suite after the change |

![soak end frame](../../../_work/e1-drive/browser-soak-run1-end.png)

*`browser-soak-run1-end.png`: the end of the 18,000-tick run. The HUD shows
`soak done · cycle 13 · 18000/18000 ticks · 8688 frames · PASS`, the measured
checkpoint 2/2 banner and the real Corvette on the drawn River segment. The final
sprint is the truncated one; the report and checkpoint record say so.*


## Limits

- **Headless proxy.** Headless Edge/WebGPU is not the user's browser or GPU. Frame
  intervals are measured, but they are not a display-cadence or retail-frame-rate
  claim.
- **Fixed dt is the simulation contract.** 18,000 ticks are 300 s of simulated
  time at 1/60 s. A run at one tick per animation frame still completes faster
  than 300 s here because headless rAF is not throttled to 60 Hz; the wall time is
  recorded and is not the simulated duration.
- **One car, one strip, no game.** The soak drives the same Corvette on the same
  measured River segment; it makes no claim about other cars, a full level, a
  lap, opponents, audio, streaming or retail race rules.
- **Synchronous telemetry is a mode-switch hitch.** The three telemetry
  manoeuvres run synchronously between frames; their duration is recorded in
  `transitions[]`/`telemetry.syncMs`, not hidden inside the frame-time percentile.
  A restart/respawn is still a full world rebuild (level import + 180-tick settle).
- **JS heap is noisy by nature.** V8 may retain packet timelines until a GC; the
  after-GC checkpoint values and the early/late drift are the leak signal, not the
  raw per-second samples.
- **GPU memory is counted, not queried.** The buffer lifecycle is tracked from the
  consumer's own create/destroy calls; WebGPU has no portable per-buffer byte
  query here. The gate is that live buffers stay at one packet's 8.
- **No native parity claim.** Native-vs-wasm numerical parity remains blocked by
  the DirectX SDK (`T-007-vehicle-physics.md` §7).
