# probes/perf — performance budget from artifacts

Measures the browser slice's resource budget without a browser:

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
& $node probes/perf/tools/perf_budget.mjs measure   # writes _work/perf/measurements.json, _work/perf/budget-model.json
& $node probes/perf/tools/perf_budget.mjs verify    # writes _work/perf/verify.json, _work/logs/perf/verify.log
```

What is measured, from committed/generated artifacts:

- per-car chunk bytes, vertices, triangles, indices, UV/RGBA bytes, draw count and the exact GPU buffer bytes the consumer uploads (position f32x3 + UV0 f32x2 + index u32);
- the level chunk and the three page map packages (Amboy/Gracia render packages, Longbeach render package) with package bytes, GPU geometry, texture mip-chain bytes and JSON/package overhead;
- page totals using the page's own byte formula (`app.js` map byte record);
- the 50 committed ghost records (payload, base64 inflation, metadata);
- the wasm module, JS module, build record and the soak heap/frame/draw/upload measurements;
- 20 Hz state-message bytes from the real packet body matrices and drive states, plus measured delta/quantized binary estimators;
- an explicit 8-player budget model with worst case (Gracia/Longbeach), best case (River) and the current M4 residency.

It does not start Edge, does not touch `probes/e1-drive/**`, `probes/net-mvp/**`, `tools/`, `game-data/` or `upstream/`, and writes only to `_work/perf/**` and `_work/logs/perf/**`.

The model's assumptions, risk list and limits are in
[`docs/work/analysis/performance-budget.md`](../../docs/work/analysis/performance-budget.md).
