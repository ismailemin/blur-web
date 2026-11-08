# `probes/split-screen` — 1–4 local viewports, design and arithmetic

Design study only: no renderer, no page, no browser capture. It answers whether
the current WebGPU consumer can draw 2–4 viewports at 60 Hz on the measured
River packet, and fixes the layout, FOV, camera, HUD, input, ownership and pass
contract before a renderer task starts.

## Commands

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

& $node probes/split-screen/build-plan.mjs    # writes _work/split-screen/plan.json
& $node probes/split-screen/verify.mjs        # 251 checks, writes _work/logs/split-screen/verify.log
& $node probes/split-screen/print-tables.mjs  # Markdown tables for the analysis doc
```

## Files

| file | role |
|---|---|
| `layout.mjs` | 5 layouts (`solo`, `split-h`, `split-v`, `three`, `quad`), aspect and FOV rule |
| `budget.mjs` | map/car counts, two frame-time bounds, texture/geometry memory, feasibility |
| `build-plan.mjs` | deterministic `plan.json` with a canonical `planHash` |
| `verify.mjs` | independent recomputation of every plan value |
| `print-tables.mjs` | read-only Markdown tables |

## Result

- 60 Hz: **2 players on River** with the 100-draw reference car (13.95 ms linear,
  16.58 ms conservative draw bound); the 123-draw roster envelope is marginal
  (17.82 ms) and needs remote-car LOD (14.83 ms). 3–4 players do not fit.
- 30 Hz: 3 players full-draw; **4 players with the 12-draw remote-car LOD**
  (29.72 ms reference, 30.96 ms envelope).
- Amboy/Gracia/Longbeach: no measured frame; not certified at 60 Hz.

The one measured frame is `_work/e1-drive/browser-evidence-soak.json` (516
draws, 6.945/6.975/7.09 ms p50/p95/max, 1600×900, nvidia/blackwell). The frame
interval is a headless rAF cadence, not a GPU timestamp; both time bounds are
labelled in the plan.

See `docs/work/analysis/split-screen.md` for the full record and limits.
