# `probes/textures` — map texture coverage (decoder limits, alpha, runtime, decal)

Owner: TEX1. Data/analysis only. **No renderer, GPU, browser, e1-drive or
reader change is made or claimed.** The committed `texture_inspect.exe` /
`scene_reader.cpp` and every file under `probes/e1-drive`, `probes/map-slice`,
`probes/asset-reader`, `tools/`, `upstream/` and `game-data/` are read-only here.

## Why this probe exists

The map-slice studies (`docs/work/analysis/map-slice-amboy-textures.md`,
`map-slice-gracia.md`) bind 1,201 / 1,606 Amboy and 2,627 / 3,580 Gracia draws to
a real static albedo and label the rest with four typed blockers. This probe
answers, per blocker: is it **decoder-limited** or **data-limited**, what exactly
fails, what decode path is correct, and how many draws/bytes each fix unlocks.

## Tools

| file | role |
|---|---|
| `bc_decode.py` | Standalone dependency-free PC `.texture` decoder. Same texel algebra as `probes/asset-reader/src/texture_reader.cpp` with the two *validator* bounds (`≤512 px`, `≤10 mips`) lifted to `≤8192 px` / natural mip count. Everything else (16-bit expansion, BC1 three-colour mode, BC3 alpha rounding, edge crop, non-BC channel order) is unchanged. |
| `extract.py` | Decodes every committed source (195 Amboy + 846 Gracia), plus the `g_tTexture` blobs behind the `Racification*` decal draws, plus the exact `g_tAlbedo` material element of the runtime-only draws. Writes `_work/textures/<map>/decode.json` and the RGBA files. |
| `coverage.py` | Joins the committed per-draw binding manifest with the decode and writes `_work/textures/coverage.json`: coverage now, draw/triangle/byte delta per fix, remaining typed blockers. Asserts the status arithmetic and the reader identity-resolved anchor. |
| `verify.py` | Independent verifier: re-reads/re-decodes/re-hashes every source, cross-checks the committed native decoder, cross-checks Pillow for the oversized sources, re-derives the coverage arithmetic and the runtime proof, and rebuilds the decode twice for determinism. |
| `report.py` | Prints the Markdown tables used in the analysis document. |

## Reproduce

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/textures/extract.py --level usa_amboy
& $py probes/textures/extract.py --level spa_barcelona_gracia
& $py probes/textures/coverage.py
& $py probes/textures/verify.py
& $py probes/textures/report.py
```

Logs: `_work/logs/textures/{coverage,verify}.log`.
Outputs: `_work/textures/**` (generated game data, not committed).

## Status vocabulary

| status (from the committed manifests) | meaning here |
|---|---|
| `bindable-static-albedo` | decoded opaque image + UV0; unblocked today |
| `blocked-decoder-size-limit` | source exceeds the committed 512 px / 10 mip validator bound |
| `blocked-alpha-rule-missing` | source alpha is not opaque and no per-draw alpha rule is applied |
| `blocked-effect-not-static-albedo` | `Racification*` additive decal: `g_tTexture`, not `g_tAlbedo` |
| `blocked-runtime-albedo-parameter` | `g_tAlbedo` is a type-9 `DATA_INDEX` runtime reference |

## Scope of the claim

The probe proves **decodability and byte-level identity**, not a frame. It does
not upload a texture, does not apply an alpha rule, and does not integrate into
e1-drive. `docs/work/analysis/texture-coverage.md` states the integration
contract and what a screenshot gate would still have to prove.
