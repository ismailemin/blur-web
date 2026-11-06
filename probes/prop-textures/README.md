# prop-textures — read-only feasibility study for texturing the visible E1 props

**P72a. Data/analysis only.** No renderer, packet, e1-drive, asset-reader, texture
or game-data file was modified. All outputs live under `_work/prop-textures/` and
`_work/logs/prop-textures/`; the only committed document is
`docs/work/analysis/prop-textures.md`.

## Question

The E1 track visual draws 394 real River direct draws in one merged mesh, but only
297 sample a static albedo texture; 97 are diagnostic. Separately, the 22 level
instance draws (the start-area wrecks and the two large trucks) are drawn with the
diagnostic albedo. This probe asks:

1. Which of the 97 diagnostic track draws are props, terrain, road or unknown?
2. Why is each diagnostic group untextured (exact field, not a guess)?
3. Do the P66/P68 visible props carry a usable albedo + UV0 in their source stream?
4. How many draws/triangles and how much screen area would gain real albedo, and
   what cannot be textured with the proven readers?
5. What is the smallest, provable next implementation step?

## Answer in one line

The 97 diagnostic **track** draws are not the visible structural props: 95 are the
far `block88/node283` section with no P44/P45/P47 binding row (≥1,468 m from the
drive box, beyond the 230.04 m camera far plane) and 2 are tiny runtime-only albedo
parameters. All 460 P66 / 423 P68 track-visual prop components (fences, pipes,
racks, walls, containers) are already `bound-static-albedo`. The visible
**diagnostic props are the 22 level instance draws** (8 placements, 10,308
triangles). Their source node253 stream declares UV0 at byte offset 16 and its
material chain resolves five static `g_tAlbedo` images (9,216 decoded RGBA bytes),
but the committed instance reader emits `uv0Available:false` and
`material:"diagnostic-only"`. A bounded reader extension can therefore texture
**18 draws / 10,212 triangles** (+ **4 BC3 alpha draws / 96 triangles** pending an
alpha rule) — not the 97 track diagnostics.

## Tools

| tool | role |
| --- | --- |
| `tools/extract_level_props.py` | Parses `game-data/.../level.levelrender` + `level.levelstream`, node chunk 53 (block253), geometry chunk 88 item 7 (block27); emits `_work/prop-textures/level-props.json`, the 5 decoded level albedo RGBA files, the block27/node253 chunk slices, and the committed `level_inspect --instances-all` output. |
| `tools/build_candidates.py` | Builds `_work/prop-textures/candidates.json` and `summary.json`: 416 draw records, 119 candidates, per-draw hashes, provenance, measured screen proxy. |
| `tools/verify_candidates.py` | Independent verifier: re-hashes the 136 track RGBA files, recomputes 299 track UV0 hashes, re-decodes the 5 level textures, cross-checks the level material chain against the pre-existing node253 report, checks P66/P68 classification, hashes every record, recomputes the screen proxy, and rebuilds the manifest to prove byte-identical determinism. |
| `tools/report_numbers.py` | Prints the tables used in the analysis document. |

## Reproduce

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/prop-textures/tools/extract_level_props.py
& $py probes/prop-textures/tools/build_candidates.py
& $py probes/prop-textures/tools/verify_candidates.py
```

The verifier's second build is written to
`_work/prop-textures/repeat-candidates.json`; its bytes must equal
`candidates.json`. Logs: `_work/logs/prop-textures/{extract,build,verify,numbers}.log`.

## Outputs

| path | content |
| --- | --- |
| `_work/prop-textures/candidates.json` | 416 draw records + 119 candidates, per-draw SHA-256, provenance, status, screen proxy; `contentSha256` |
| `_work/prop-textures/summary.json` | counts, status table, screen curve, texture table, manifest hash |
| `_work/prop-textures/level-props.json` | 22 level draws → material stack → `g_tAlbedo` → source, 5 textures, UV0 declaration, current-reader fields |
| `_work/prop-textures/level-instances-all.json` | the committed `level_inspect --instances-all` output (22 draws, `uv0Available:false`, `albedoTexture:null`) |
| `_work/prop-textures/level-textures/*.rgba` | the 5 decoded static albedo images (4×BC1, 1×BC3) |
| `_work/prop-textures/block27-geometry.chunk`, `node253.chunk` | the two retail chunk slices the committed reader consumes |
| `_work/prop-textures/verify.json` | 49 checks, PASS |

## Status vocabulary

| status | meaning |
| --- | --- |
| `already-textured` | the draw samples a committed static albedo with the real UV0 |
| `candidate-static-albedo-not-exported` | level prop: source material chain resolves a static `g_tAlbedo`; the reader must export UV0 + the binding; BC1, no alpha |
| `blocked-alpha-source` | level prop: the only albedo is a BC3 alpha image; the proven consumer has no blend/alpha-test state |
| `blocked-runtime-only-albedo` | track draw whose P47 row is `runtimeOnly` (`albedo=-1:-1`, `texture=null`) |
| `blocked-unmeasured-albedo` | block88/node283 draw with no P44/P45/P47 binding row; UV0 exists, albedo was never measured, so nothing is bound |

## Limits

- The screen metrics are a geometric projection through the committed 301-tick
  packet cameras at 1600×900. They are **not** a GPU render: no depth test, no
  occlusion, no backface cull (the consumer uses `cullMode:'none'`), and the
  triangle-area sum double-counts overlapping geometry. The unique-coverage raster
  (320×180) is the primary proxy; the triangle-area sum is an upper bound.
- Level-prop UV0 is declared by the source stream but **not exported or hashed**
  by the committed reader. No per-vertex UV value or per-draw UV hash is claimed.
- Material colour, `g_tMaterial` lookup, blend state, shader stages, sampler,
  mip chain and sRGB are not resolved for any draw (same limits as P49/P55).
- No full-game, retail-fidelity, GPU or browser claim is made.

See `docs/work/analysis/prop-textures.md` for the full tables, evidence paths and
the recommended next step.
