# T-005d verification — static collision oracle

**Date:** 2 November 2026
**Scope:** first T-005d slice (D1); standalone probe, no engine integration.

## Format proof

`Level.levelphysics` is a `Sys::C_FileBlock` stream: PC fourcc, `Physic` root,
`Header`/`Main`/`Routes`. `Main` is a Gravity `C_ImportScene` v10 with two
triangle-mesh shapes. The probe decodes block framing, descriptor prefix,
`OptimisedAABBTree` v10, per-leaf quantisation and the leaf-ordered triangle
stream from source-cited rules. Parse is validated by consumption: both meshes
and terminators end exactly at `Main` (1,896,928 B), zero unread bytes.

Parsed: 62,641 vertices, 44,244 triangles, 5,915 leaves, 11,828 nodes.

## Gate

```powershell
python probes/collision-oracle/tests/run_collision_oracle.py
```

Result: **23/23 PASS**.

- Native MSVC `/W4 /permissive-`: 0 warnings; CTest 2/2.
- wasm32 via Emscripten 6.0.13; native = wasm32 = independent Python.
- `queryHash f87365b79fc1217da4280d6d5748ca6dc6808b89382b87de43ddcbfe6c9b5d6e`,
  7,768 canonical bytes.
- 24 rays + 24 spheres + 8 line-cache queries.
- Native and wasm byte-identical across two runs; whole document identical
  except `build`/`input.label`.
- 13/13 malformed/truncated inputs rejected with explicit codes and offsets.

Main suite:

```powershell
python tools/verify_asset_probe.py --skip-build
```

Result: **29/29 PASS** (new `collision-oracle` step).

## Findings carried forward

- Retail `Normalise()` is `_mm_rsqrt_ps` + one Newton–Raphson step, not correctly
  rounded; the probe uses exact `1/sqrtf` and labels the deviation. A bit-faithful
  D2 needs emulation or a recorded difference.
- Function-argument evaluation order differs between MSVC and clang; all seed
  draws are now sequenced explicitly.
- The 4-entry line-cache makes query order part of the answer; the probe models it.

## Limits (explicit)

- Fat/swept-sphere ray is **unsupported** (needs the wheel radius from XT data);
  `rayRadius:0`, `fatTrace:"unsupported"`.
- Constraints: only an empty list is accepted; otherwise `unsupported_constraint`
  at the type word.
- Shapes other than triangle mesh stop with `unsupported_shape_type`.
- `Routes` validated structurally only. No instance transforms, vehicle physics,
  engine link or playable-game claim.

Evidence: `_work/collision-oracle/{summary,native,native2,wasm,wasm2,reference}.json`,
`_work/collision-oracle/logs/`.
