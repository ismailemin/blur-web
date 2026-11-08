# probes/retail-parity — current-state audit and fixed-pose reference harness

**Owner:** PARITY1. **Status:** audit + harness, no renderer change.

The audit itself is `docs/work/analysis/retail-parity.md`. This directory holds
the read-only tooling that produced the numbers and the four reference frames.

| file | role |
|---|---|
| `tools/inventory.py` | measures the car and the 0–100 m band from the committed geometry chunks/path; writes `_work/retail-parity/inventory.json` |
| `tools/serve_parity.mjs` | read-only static server for the reference page (no writes, path allow-list) |
| `tools/capture_parity.mjs` | headless Edge/WebGPU capture of four fixed poses; writes `_work/retail-parity/screenshots/*.png`, `capture.json`, `camera-poses.json`; console gate |
| `web/index.html` | fixed-pose page; imports the committed packet consumer/adapter and assembles the committed level + Corvette chunks. `?tag=0` hides the pose label |
| `retail-capture-template.json` | per-session metadata template for the retail capture protocol |

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

& $py   probes/retail-parity/tools/inventory.py
& $node probes/retail-parity/tools/capture_parity.mjs
```

The page renders a **reconstructed** car pose (recorded sprint position/axisZ,
world-up basis, manifest rest wheel translations); it never steps the engine.
FOV is the committed 45° PoC camera, not a retail value. The harness makes no
retail-parity or full-game claim.
