# T-005c fixed-step scheduler probe

Standalone, engine-free proof of the decoupled update/render time rule that the
browser port must use. It is a **reference model and test harness**, not engine
code: no engine header is included, no `Scheduler::` call site is touched, and
nothing here is wired into the game.

Scope label: `engineIntegration:false`, `schedulerBackend:notStarted`,
`browserSmoke:notRun`.

---

## 1. What the probe implements

The rule is not invented. It is the loop in
`upstream/BlurRebuilt/code/mercury/library/gamesys/framework/source/application/ApplicationPC.cpp:480-590`
re-expressed over an exact integer time base, plus the pause policy proposed in
`docs/work/analysis/t005-scheduler-design.md` §4.3.

Per rendered frame:

```text
delta = now - last                          # integer microseconds
if delta < 0:             flag rewind; delta = 0
if delta > pauseThreshold: flag pause; accumulator = 0   # tab gap, not a fast-forward
else:                     accumulator += delta * stepHz   # exact au
inserted  = accumulator / usPerSecond        # floor, in ticks
ticks     = min(inserted, 4)
if ticks > 0:
    accumulator -= ticks * usPerSecond
    if accumulator >= usPerSecond:           # ApplicationPC.cpp:521-522
        accumulator = 0                       # backlog clamp, measured as droppedTicks
alpha = accumulator / usPerSecond            # exact fraction, clamped to [0,1]
```

### Time base

| Quantity | Unit | Value |
| --- | --- | --- |
| Clock input | microsecond, integer, monotonic | `nowUs` |
| Accumulator | "au" = 1/stepHz µs | `stepHz = 60` |
| One tick | au | `auPerStep = usPerSecond = 1 000 000` |
| Tick duration | s | `1/60` exactly |

One microsecond is 60 au and one tick is 1 000 000 au, so the accumulator holds
the fractional tick remainder **exactly**. There is no floating point anywhere in
the accumulation, the tick count, the remainder, the alpha numerator or the
state. Floating point appears once, when alpha is reported as an IEEE-754 bit
pattern.

### Deliberate deviations from the PC loop, all explicit

1. **Pause threshold.** `ApplicationPC.cpp` has no pause rule; it relies on the
   backlog clamp alone. The 0.25 s threshold is the design's proposal and is
   implemented as its own branch so it can be tested (and removed) independently.
2. **`dropBacklog`.** The PC loop *does* clamp (`accum >= tick → 0`), contrary to
   the "leftover kept" wording in design §4.2. The probe defaults to the
   source behaviour and ships a `dropBacklog=false` scenario to measure the
   alternative rather than describe it.
3. **Alpha precision.** The engine stores `renderAlpha` as `F32`; the probe keeps
   the exact integer fraction and reports its `double` bit pattern. The F32
   conversion is a separate rounding that the probe does **not** model.
4. **First frame.** `ApplicationPC.cpp:477` seeds the accumulator with `1.0 s` as
   a warm-up hack. The probe starts at zero and treats the first timestamp as a
   baseline, so the first sample consumes no delta.
5. **State model.** `SimState` is a small unsigned integer integrator defined
   here. It exists only to give "same state after the same ticks" a concrete,
   comparable value. It is not physics.

### Frame flags (emitted per frame)

| Bit | Name | Meaning |
| --- | --- | --- |
| 1 | `kFrameTick` | at least one tick ran |
| 2 | `kFrameZeroTick` | no tick ran |
| 4 | `kFrameCapped` | inserted ticks exceeded `maxTicksPerFrame` |
| 8 | `kFrameBacklogDrop` | the post-cap clamp cleared the accumulator |
| 16 | `kFramePaused` | delta exceeded the pause threshold |
| 32 | `kFrameDtRewind` | negative delta; treated as zero |
| 64 | `kFrameDeltaZero` | delta was exactly zero |
| 128 | `kFrameBaseline` | first sample; baseline only (not used by the traces) |

---

## 2. Layout

```text
probes/scheduler-probe/
  CMakeLists.txt              native build (MSVC /W4 or -Wall -Wextra -Wpedantic)
  src/fixed_step.h|.cpp       the driver (config, flags, exact alpha)
  src/sim_state.h|.cpp        integer state + FNV-1a 64 hash (explicit LE bytes)
  src/scenarios.h|.cpp        traces, suite runner, JSON/CSV, self test
  src/json_out.h              deterministic JSON emitter (no dependencies)
  src/build_info.h            build identity recorded next to every hash
  src/probe_main.cpp          native CLI
  src/wasm_entry.cpp          wasm32 exports: sched_probe_json, sched_probe_selftest
  tests/fixed_step_tests.cpp  unit tests (CTest: scheduler_fixed_step)
  tests/reference_scheduler.py    independent Python model (shares no code)
  tests/verify_scheduler_wasm.mjs node driver for the wasm32 module
  tests/run_scheduler_probe.py    builds everything, runs everything, compares
```

All build output goes to `_work/`; nothing generated is written under `probes/`.

---

## 3. Build and run

Use the bundled Python if `python` is a Store alias:
`C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`.

### One command (native + wasm32 + Python + determinism)

```powershell
python probes/scheduler-probe/tests/run_scheduler_probe.py
```

It configures/builds the native target with the VS 2022 Build Tools CMake, runs
CTest, builds wasm32 with the pinned emsdk at `_work/toolchains/emsdk`, runs the
module in node, runs the Python reference, and compares all four. Logs and
artefacts land in `_work/scheduler-probe/`.

Reuse existing binaries (no compile):

```powershell
python probes/scheduler-probe/tests/run_scheduler_probe.py --skip-build
```

Native only (no wasm32):

```powershell
python probes/scheduler-probe/tests/run_scheduler_probe.py --native-only
```

### Manual native build

```powershell
$cmake = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
& $cmake -S probes/scheduler-probe -B _work/build/scheduler-probe-native -G "Visual Studio 17 2022" -A x64
& $cmake --build _work/build/scheduler-probe-native --config Release
& "_work/build/scheduler-probe-native/Release/scheduler_probe_tests.exe"
& "_work/build/scheduler-probe-native/Release/scheduler_probe.exe" --out _work/scheduler-probe/native.json --csv _work/scheduler-probe/csv
& "_work/build/scheduler-probe-native/Release/scheduler_probe.exe" --selftest
```

CTest:

```powershell
ctest --test-dir _work/build/scheduler-probe-native -C Release --output-on-failure
```

### Manual wasm32 build and run

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py _work/toolchains/emsdk/upstream/emscripten/em++.py `
  probes/scheduler-probe/src/fixed_step.cpp probes/scheduler-probe/src/sim_state.cpp `
  probes/scheduler-probe/src/scenarios.cpp probes/scheduler-probe/src/wasm_entry.cpp `
  -std=c++17 -O2 -fno-fast-math -ffp-contract=off `
  '-DPROBE_FLAGS_STRING="-O2 -fno-fast-math -ffp-contract=off"' `
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node,web `
  -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=16777216 --no-entry `
  -sEXPORTED_FUNCTIONS=_sched_probe_json,_sched_probe_selftest `
  -sEXPORTED_RUNTIME_METHODS=UTF8ToString `
  -o _work/scheduler-probe/build/scheduler_probe.mjs
node probes/scheduler-probe/tests/verify_scheduler_wasm.mjs `
  _work/scheduler-probe/build/scheduler_probe.mjs _work/scheduler-probe/wasm.json
```

### Python reference only

```powershell
python probes/scheduler-probe/tests/reference_scheduler.py --out _work/scheduler-probe/reference.json
```

### CLI

```text
scheduler_probe [--out <json>] [--csv <dir>] [--no-frames] [--quiet]
scheduler_probe --selftest
```

Exit codes: `0` ok, `1` self-test failures, `2` bad argument, `3` write failure.

---

## 4. Scenarios

All timestamps are integer microseconds generated by `ts[i] = i * 1e6 / hz`
(integer division). The Python model regenerates the same arrays from the same
formula; neither side reads the other's numbers.

| Scenario | What it exercises |
| --- | --- |
| `hz144-600f` | 600 frames at 144 Hz. 249 ticks, alpha 0.99996; no cap, no pause |
| `hz30-300f` | 300 frames at 30 Hz. 600 ticks over 10 s, remainder exactly 0 |
| `hitch-250ms-400f` | one frame delta of exactly 250 000 µs: cap fires (15 requested → 4 run, 11 clamped), pause does **not** fire |
| `tabgap-5s-400f` | one frame delta of 5 000 000 µs: pause fires, 0 ticks, accumulator cleared |
| `jitter-8ms-500f` | fixed 16-entry delta table, 3 999 000 µs total, 239 ticks |
| `equal5s-600f` | 5 s as 600 frames (120 Hz) |
| `equal5s-150f` | 5 s as 150 frames (30 Hz) |
| `equal5s-100f` | 5 s as 100 frames (20 Hz) |
| `capboundary-15hz-75f` | 5 s at 15 Hz; sees the 4-tick cap at its exact boundary (see §6) |
| `keepbacklog-200ms-5f` | `dropBacklog=false` comparison: backlog kept, alpha saturates at 1 |

`equal5s-*` must produce **300 ticks, one state hash, one alpha**; that is the
frame-rate-independence gate (A6).

---

## 5. Tests

`scheduler_probe_tests.exe` (registered in CTest as `scheduler_fixed_step`) covers:

- baseline frame semantics, and that `advanceTo` resynchronises after a clock rewind;
- accumulator unit boundaries: 16 666 µs → 0 ticks / 999 960 au, +1 µs → 1 tick;
- the 4-tick boundary at 66 667 µs (4.00002 ticks) without a cap flag;
- cap enforcement and the post-cap clamp (100 000 µs → 4 run, 2 clamped);
- `dropBacklog=false` catch-up across two frames, with alpha clamped to 1;
- pause threshold strictness: 250 000 µs is not a pause, 250 001 µs is;
- pause clearing a pending fraction, and the next frame advancing normally;
- zero delta, negative delta, timestamp rewind;
- frame-rate independence (600 / 150 / 100 frames over 5 s);
- frame count is not an input (2 × 50 ms vs 10 × 10 ms → same 6 ticks, same hash);
- one tick per frame matches the 600-frame cadence (same hash);
- five capped frames account for 40 clamped ticks;
- alpha ∈ [0,1] over 500 jittered frames;
- hitch and tab-gap frame-level detail (requested/executed/clamped, accumulator);
- bitwise determinism of two full suite serialisations;
- config validation;
- pinned state hash for the 300-tick reference run.

`scheduler_probe --selftest` (CTest `scheduler_probe_selftest`) re-checks the
suite-level invariants and is the same code the wasm module exports.

---

## 6. Results (2 November 2026, this machine)

Command: `python probes/scheduler-probe/tests/run_scheduler_probe.py`

```text
configure-native: PASS        build-native: PASS        ctest: PASS
build-wasm: PASS              run-native: PASS          run-native-selftest: PASS
run-native-repeat: PASS       run-reference: PASS       run-wasm: PASS
determinism-native: PASS      native-vs-python: PASS    native-vs-wasm: PASS
frame-rate-independence: PASS cap-boundary-accounting: PASS
cap-enforcement: PASS         pause-rule: PASS
alpha-bounds: PASS            accumulator-bounds: PASS   cap-bounds: PASS
21/21 checks passed
```

- Native MSVC `/W4 /permissive-`: **0 warnings**.
- CTest: 2/2 test executables, 2 130 assertions in the unit binary.
- wasm32: Emscripten 6.0.13, 53 263 B `.wasm`, runs in node.
- Native vs wasm32 vs Python: **identical** for every scenario field, every
  per-frame tick/accumulator/flags array, every alpha bit pattern and every hash.
  Only the `build` object differs (target/compiler/flags).
- Two native runs are byte-identical.

Per-scenario evidence (from `_work/scheduler-probe/native.json`):

| Scenario | frames | ticks | requested | capped | paused | clamped | final acc (au) | state hash |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `hz144-600f` | 600 | 249 | 249 | 0 | 0 | 0 | 999 960 | `0x4a6cb0fd168ba293` |
| `hz30-300f` | 300 | 600 | 600 | 0 | 0 | 0 | 0 | `0xc2c1cdea74568343` |
| `hitch-250ms-400f` | 400 | 169 | 180 | 1 | 0 | 11 | 916 640 | `0x25506156ee0e070e` |
| `tabgap-5s-400f` | 400 | 165 | 165 | 0 | 1 | 0 | 916 640 | `0x4187fa84c975885b` |
| `jitter-8ms-500f` | 500 | 239 | 239 | 0 | 0 | 0 | 940 000 | `0x0b1459a0bc2c9714` |
| `equal5s-600f` | 600 | 300 | 300 | 0 | 0 | 0 | 0 | `0x7e04f9a197e01d8a` |
| `equal5s-150f` | 150 | 300 | 300 | 0 | 0 | 0 | 0 | `0x7e04f9a197e01d8a` |
| `equal5s-100f` | 100 | 300 | 300 | 0 | 0 | 0 | 0 | `0x7e04f9a197e01d8a` |
| `capboundary-15hz-75f` | 75 | 275 | 300 | 25 | 0 | 25 | 0 | `0xd47636f8d7ca5fdf` |
| `keepbacklog-200ms-5f` | 5 | 20 | 140 | 5 | 0 | 0 | 40 000 000 | `0x047a235e9354d391` |

Artifact hashes are recorded in `_work/scheduler-probe/summary.json`.

---

## 7. Findings that affect the design document

1. **The PC loop already clamps the backlog.** Design §4.2 says "capped at 4,
   leftover kept". `ApplicationPC.cpp:518-522` caps at 4, subtracts, and then
   sets the accumulator to 0 when it still holds a full tick. The probe therefore
   implements the clamp as the default and reports the alternative as a separate
   scenario. The design wording should be corrected before implementation.
2. **The 4-tick cap has a measurable cost at its boundary.** At 15 Hz the four
   ticks are 66 666.67 µs, so millisecond-quantised deltas of 66 666/66 667 µs
   accumulate a near-full-tick carry; every third frame requests 5 ticks, the cap
   runs 4 and the clamp discards 1. Over 5 s that is 275 executed of 300
   requested ticks (91.7 % speed). The PC double loop hides the same boundary in
   floating-point error. This is not a probe bug: it is what "cap 4 + clamp"
   means in exact arithmetic, and it is why the design's pause rule (make lost
   time visible) matters. A 60 Hz minimum and a stable 60 Hz display report
   (design §4.4) avoid the case entirely.
3. **A paused frame must consume nothing, not even its own delta.** The probe
   asserts this (tab gap: 0 ticks, accumulator 0) so a resume cannot fast-forward.

---

## 8. Known limits — not claimed

- **No engine integration.** `Scheduler::`, `jobqueue_web.cpp`, policy
  flattening, `tl_*` and the `MT::` primitives are not touched here. This slice
  proves the time rule only.
- **No browser run.** A8/A7 browser smoke (page load, `requestAnimationFrame`,
  screenshot, clean console) was not attempted; `performance.now()` granularity
  and rAF throttling are unmeasured. The wasm module is exercised in node only.
- **No `F32` alpha.** The engine feeds `F32`; the probe reports the exact
  fraction and its `double` pattern. A port that must match engine-visible values
  has to add the `F32` rounding step.
- **No scheduler budget pump.** `jqRunPending(budget)` (design §3.4) is a
  different deliverable and is not modelled.
- **The state model is not physics.** Hash equality means "same number of ticks
  in the same order", not "correct simulation".
- **Not wired into `tools/verify_asset_probe.py`.** The main agent owns that
  file. A single step is enough:
  `('scheduler-probe', [sys.executable, 'probes/scheduler-probe/tests/run_scheduler_probe.py'])`.
- **wasm32 atomics were not exercised.** The module is single-context, no
  `Atomics`, no `SharedArrayBuffer`, no COOP/COEP.

---

## 9. Source citations

| Claim | Source |
| --- | --- |
| accumulator, 1/60 tick, 4-tick cap, backlog clamp, alpha | `upstream/.../framework/source/application/ApplicationPC.cpp:480-590`, especially `:508-529`, `:543-546` |
| accumulator warm-up `1.0` | same file, `:477` |
| decoupled loop rationale and old 1/60 floor bug | `.../framework/source/timer/Timer.cpp:68-112` |
| frame-rate independence rule | `upstream/BlurRebuilt/AGENTS.md:24` |
| pause policy, pump placement, alpha clamp | `docs/work/analysis/t005-scheduler-design.md` §4.3 |
| A5/A6 acceptance wording | `docs/work/analysis/t005-scheduler-design.md` §5.2 |
