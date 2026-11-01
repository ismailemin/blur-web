# Baseline verification — 1 November 2026

**Commit:** `04276aa chore: baseline project docs, probes, and tools`
**Host:** Windows, MSVC 19.44 / Windows SDK 10.0.26100, bundled Python 3.12.14
**Working tree at start:** clean except ignored `_work/`, `game-data/`, `upstream/`.

## Commands and results

### Portable suite

```powershell
& 'C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' tools/verify_asset_probe.py --skip-build
```

Result: **25/25 PASS**, exit 0.
Log: `_work/logs/baseline-suite.log`
Machine output: `_work/verification/suite.json` (UTC `2026-11-01T16:42:15Z`)

### Native CTest

```powershell
ctest --test-dir _work/build/asset-reader-native -C Release --output-on-failure
```

Result: **13/13 PASS**, 0 failed.
Log: `_work/logs/baseline-ctest.log`

## What this establishes

- The previously reported 25-step portable suite and 13 native tests still pass
  at the baseline commit.
- Existing native/WASM fixtures and comparisons are present and reproducible.
- No browser/GPU visual check was repeated in this baseline run. Those remain
  manual and are recorded per task.

## What this does not establish

- Complete game, physics, audio or multiplayer behavior.
- Retail signature/authenticity of any payload.
- Visual parity with the original shaders.
- That older `_work/level-finish/audit.json` source hashes still match current
  code; that audit predates later material changes.
