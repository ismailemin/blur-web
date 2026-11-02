# T-004 verification — trail slot stride fix

**Date:** 2 November 2026
**Scope:** native x64 diagnostic build only; no project source, `upstream/` or
game data changed.

## Root cause

`C_Manager` sized the particle trail slot manager with a literal:

```cpp
m_ParticleTrailBlockManager.SetElementSize(8);
```

`C_Particle_E` is `{C_Emitter* pEmitter; U32 iSalt;}`. The retail PC build was
32-bit, where `sizeof(C_Particle_E) == 8`, so the literal matched. In this x64
build `sizeof(C_Particle_E) == 16`: every `iSalt` write lands in the neighbouring
slot's `pEmitter`, and the 16-byte copy-last in `SuperEffect::FreeParticle`
writes over an 8-byte stride. The trace showed 8-byte slot spacing, `iSalt`
reading pointer fragments, and salt `0 == 0` on a stale slot.

## Change

```cpp
m_ParticleTrailBlockManager.SetElementSize(sizeof(C_Particle_E));
```

`Manager.cpp:151`. Patch: `_work/build/engine-reference/native-slotstride-fix.patch`.
Built as `Amax-slotstride.exe`; canonical `Amax.exe` untouched.

## Paired result

Same automation script (`scripts/race-native/smoke.txt`), same settings/save,
60 fps limit, 3 runs each, alternating sessions.

| Build | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| baseline `Amax.exe` | `0x80000003` 16 s | `0xC0000005` 23 s | `0x80000003` 17 s |
| stride fix (triple A) | exit 0, 24 s | exit 0, 23 s | exit 0, 23 s |
| stride fix (triple B) | exit 0, 23 s | exit 0, 23 s | exit 0, 23 s |

Baseline: **3/3 crash**. Fix: **6/6 clean** across two triples; one further
evidence run brings the total to **7/7 clean**.

One additional evidence run reached `Blur2PC.RaceState() == "Racing"` at 10.21 s,
`NATIVE_RACE_AFTER_THROTTLE` at 20.22 s, and `quit` at 22.22 s with exit 0 — so
the clean runs completed the throttle window instead of exiting early.

Evidence:

- `_work/native-source/Blur1PCDX11/_work/run/scripts/race-native/slotstride-runs-a.json`
- `_work/native-source/Blur1PCDX11/_work/run/scripts/race-native/slotstride-runs-b.json`
- `_work/native-source/Blur1PCDX11/_work/run/scripts/race-native/slotstride-baseline-runs.json`
- `_work/logs/slotstride-runs.log`, `_work/logs/slotstride-runs2.log`,
  `_work/logs/slotstride-baseline.log`
- `_work/logs/slotstride-evidence/{result.json,automation.log,race.png}`
- `_work/logs/amax-slotstride-build.log`, `_work/build/engine-reference/amax-x64-slotstride-result.json`

## Limits

- This is a paired diagnostic, not a formal proof. Three clean runs do not rule
  out rarer timing-dependent paths.
- The slot-ownership invariant in `emitter-slot-ownership.md` is still the correct
  contract for the web port; it was not applied and is not claimed here.
- **wasm32 is 32-bit**, so `sizeof(C_Particle_E) == 8` there and the fix is a
  no-op, matching retail semantics.
- `Atomic.h:315-316` assert is untouched.
