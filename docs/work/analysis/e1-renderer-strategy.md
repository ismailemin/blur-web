# E1 renderer strategy — engine simulation + WebGPU backend

**Status:** accepted, 4 November 2026
**Scope:** single-player vertical slice (T-005). Multiplayer unaffected.
**Fallback:** E2 (port the DX11 renderer) if the decision gate below fails.

## Decision

Build the playable slice with **E1**:

- the engine (wasm32) owns world loading, scene traversal, culling, draw-list
  production, physics, race state and input semantics;
- a WebGPU backend in JavaScript consumes a versioned **render packet** and
  rasterises it;
- the existing `probes/asset-reader/web` WebGPU pipeline is the starting
  rasteriser, not a separate game.

E1 is **not** "skip the engine renderer". It replaces the GPU backend and the
DX11-specific state/shader layer while keeping the engine's scene and draw-list
front end. That keeps E2 a backend/fidelity upgrade rather than a rewrite.

## Why E1 first

1. The DX11/FX11 port is the largest unbounded task: device/swapchain, buffers,
   states, HLSL/FX → WGSL, shadows, post-processing, effects.
2. Vehicle physics fidelity does not depend on the renderer. A car that drives
   correctly on the real collision mesh can be validated with simple visuals.
3. The repository already renders real level/car geometry with WebGPU; the
   missing piece is the game state, not a rasteriser.
4. A playable slice exposes gameplay/feel problems earlier than a full renderer
   port would.

## Architecture

```
JS: fixed-step driver (1/60, 4-tick cap from T-005c)
      │ set_input(tick, throttle, brake, steer, ...)
      ▼
wasm: engine tick ──► simulation state (car, wheels, contacts, race)
      │
      └──► render packet (draw list, camera, lights, diagnostics)
      ▼
JS: WebGPU backend ──► frame
```

Rules:

- All game state comes from wasm. JS keeps no authoritative car/race state.
- The packet is versioned and engine-agnostic; the backend never reaches into
  engine internals.
- Missing material/texture is reported in the packet (`materialId: null`,
  `reason`), never silently replaced by a guessed colour.
- Fixed step only; render interpolation uses the scheduler alpha, not a second
  simulation.

### Render packet (v1 sketch)

```json
{
  "version": 1,
  "tick": 1234,
  "alpha": 0.42,
  "camera": {"view": [16], "projection": [16], "position": [3]},
  "lights": [{"type": "directional", "direction": [3], "colour": [4]}],
  "draws": [{
    "meshId": "river.block27.vb3.ib1",
    "vertexOffset": 0, "vertexCount": 13162,
    "indexOffset": 0, "indexCount": 30924,
    "world": [16],
    "materialId": null,
    "materialReason": "level materials not applied",
    "layer": "opaque",
    "bounds": {"min": [3], "max": [3]}
  }],
  "diagnostics": {"instancesEmitted": 22, "culled": 0}
}
```

Binary form is allowed later; v1 is JSON for reviewability. A hash of the
packet is recorded per tick for determinism tests.

## Fidelity matrix

| Area | E1 | E2 |
| --- | --- | --- |
| Vehicle physics / collision / fixed step | original engine code | same |
| Track topology and collision | original data | same |
| Draw list / culling | engine scene layer, simplified materials | full |
| Shaders / lighting | custom WGSL, approximated | original FX ported |
| Post-processing / effects | omitted or approximated | original |
| Particles / trails | omitted initially | original |
| Audio / UI | separate tasks | same |

E1 must label every approximation in the packet diagnostics and in the HUD
debug overlay. No claim of visual fidelity.

## Decision gate (when to switch to E2)

E1 is accepted for the slice only if all hold:

1. A full lap is drivable and finishable with a chase camera.
2. Collision and track boundaries are visually unambiguous.
3. 60 Hz simulation with a stable frame rate on the target machine; no console
   errors or warnings.
4. The remaining fidelity gaps are listed, bounded and do not hide gameplay
   bugs.

Triggers for E2:

- the engine scene/material layer needed by E1 grows into a second renderer;
- performance cannot reach the target without porting engine batching/state;
- visual ambiguity blocks verification of gameplay;
- the owner judges the result too far from the original.

## E2 migration path

The packet is the seam. E2 replaces the packet producer (engine DX11 scene →
draw list) and/or the backend (WebGPU states/shaders) without changing the JS
driver or game logic. Nothing in E1 may depend on the current asset-reader mesh
formats beyond the packet.

## Risks

- **Scene traversal pull-in:** producing draw lists may require engine render
  TUs that in turn expect DX11 types. The first task is to bound that closure;
  fail loudly if it cannot be separated.
- **Shader fidelity:** custom WGSL will not match the original look; that is
  accepted for E1 and recorded.
- **Memory:** wasm32 is 32-bit; level data must stream, not be copied whole.
- **Determinism:** no fast-math; `Normalise()` differs from retail
  (`rsqrt` + NR); the collision probe records this explicitly.

## Next steps

1. Level streaming through `C_OverlayFs` (P18, running).
2. Bound the scene/draw-list closure and freeze packet v1.
3. Minimal car step on the River collision mesh (physics only, debug draws).
4. WebGPU backend consumes packet v1 with the car + track.
5. Fixed-step driver + input + chase camera; first drivable lap.
