# T-005c verification — fixed-step scheduler probe

**Date:** 2 November 2026
**Scope:** first T-005c code slice; standalone probe, no engine integration.

## Gate

```powershell
python probes/scheduler-probe/tests/run_scheduler_probe.py
```

Result: **21/21 PASS**, MSVC `/W4 /permissive-` 0 warnings, CTest 2/2,
2130 assertions, Emscripten 6.0.13 wasm32 53 263 B.

```powershell
python probes/scheduler-probe/tests/run_scheduler_probe.py --skip-build
```

Result: **17/17 PASS**.

Main suite integration:

```powershell
python tools/verify_asset_probe.py --skip-build
```

Result: **28/28 PASS** (new `scheduler-probe` step).

## Parity

- Native vs wasm32 vs independent Python model: **0 differences** on every
  scenario field, per-frame tick/accumulator/flag array, alpha bit pattern and
  state hash. Only build identity differs.
- 144 Hz × 600 frames = 249 ticks, accumulator 999 960.
- 30 Hz × 300 frames = 600 ticks.
- 250 ms hitch: 15 requested, 4 executed, 11 clamped, 0 paused.
- 5 s tab gap: 1 pause, 0 ticks, accumulator 0.
- Frame-rate independence: 600/150/100 frames over 5 s → 300 ticks, one state
  hash `0x7e04f9a197e01d8a`, one alpha.
- Two native runs byte-identical.

## Findings carried back to the design

1. `ApplicationPC.cpp:518-522` caps at 4, subtracts, then zeroes the accumulator
   if a tick still remains. The probe implements this clamp as default.
2. The 4-tick cap has a measurable boundary cost: at 15 Hz four ticks are
   66 666.67 µs, so 66 666/66 667 µs frames request 5, run 4, clamp 1; 275 of
   300 ticks execute in 5 s (91.7 %). Executed + clamped == requested is
   asserted, so loss is recorded, not hidden.

## Limits

Time driver only: no `Scheduler::`, `jobqueue_web.cpp`, policy flattening or
`jqRunPending`. No browser smoke test, no screenshot/console claim;
`performance.now()` granularity and rAF throttling are unmeasured. Alpha is the
exact integer fraction with `double` bits; the engine's `F32` rounding step is
not modelled. `SimState` is a probe integrator, not physics.

Evidence: `_work/scheduler-probe/{native,wasm,reference,summary}.json`, `csv/`,
`logs/`.
