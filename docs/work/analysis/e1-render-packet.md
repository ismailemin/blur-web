# E1 render packet v1 — frozen contract and spike evidence

**Status:** frozen for the E1 vertical slice (spike evidence, 4 November 2026)
**Scope:** the packet seam between an engine-side draw-list producer and a WebGPU
backend. Implemented in `probes/render-packet/`. Not an engine integration.
**Related:** `docs/work/analysis/e1-renderer-strategy.md` (packet sketch), `probes/render-packet/README.md`.

## Why this exists

`e1-renderer-strategy.md` chose E1: the engine keeps world loading, scene
traversal and draw-list production, and JavaScript replaces the GPU backend with
a WebGPU rasteriser that consumes a **versioned render packet**. That decision is
only credible once the seam exists as a concrete contract and something has drawn
from it.

This spike freezes packet v1, produces one from real Blur geometry, and draws it
with a standalone WebGPU consumer. It answers three questions:

1. Is the packet a complete enough description to rasterise, or is it a sketch?
2. Can it be produced from today's verified readers without inventing anything?
3. Is the output deterministic, so the hash is usable as a regression signal?

The answer to all three is yes, for the bounded scope recorded below.

## Contract

Schema: `probes/render-packet/schema/render-packet.v1.schema.json` (JSON Schema
2020-12). Structural and semantic checks live in
`probes/render-packet/tools/packet-format.mjs`; the two are kept in sync by an
explicit drift check in `tools/verify_render_packet.mjs`.

### Top level

| Member | Meaning |
| --- | --- |
| `kind` | Fixed string `blur.render-packet`. Rejects "some JSON with draws". |
| `version` | `1`. A consumer must refuse an unknown version rather than guess. |
| `hash` | `sha256:<hex>` of the canonical body (see *Hash*). |
| `tick` | Simulation tick that produced the packet. |
| `alpha` | Scheduler interpolation alpha 0..1. Render interpolation only. |
| `generator` | Producer name/version and, per input, the tool, arguments and output SHA-256. |
| `camera` | `view`, `projection`, `position`, `target`, `up`, `near`, `far`, `verticalFovRadians`, `aspect`, `matrixConvention`. |
| `lights` | Array; v1 defines `directional` only, each with a `source` string. |
| `meshes` | Geometry the draws index into, with hashes. |
| `materials` | Material identities, provenance, and an explicit "no pixels" flag. |
| `draws` | The draw list. |
| `placedObjects` | Objects positioned by the packet rather than by recovered engine data, each with a reason. |
| `diagnostics` | Counts plus declared approximations, missing data and limits. |

### Camera convention (normative)

`matrixConvention` is the literal string

```
column-major 16-float array; column-vector; right-handed view; WebGPU clip depth 0..1
```

Elements are laid out so that WGSL `m * v` with `mat4x4f` and `vec4f` is correct
without transposition. The projection maps view depth to `0..1` (the same form
`probes/asset-reader/web/mesh-viewer.js` already uses). The consumer rejects a
packet whose convention string differs, so a future producer cannot silently
flip an axis.

### Mesh

| Member | Meaning |
| --- | --- |
| `id` | Stable mesh identity used by draws. |
| `storage` | `inline-json` in v1. A later version may reference engine buffers; the consumer fails on anything else. |
| `vertexCount` / `indexCount` | Declared sizes, cross-checked against the arrays. |
| `positions` | `vertexCount * 3` floats, xyz. |
| `indices` | `indexCount` uint32 indices, absolute within this mesh. |
| `positionsSha256` / `indicesSha256` | SHA-256 of the little-endian float32 / uint32 byte images, so geometry provenance is checkable independently of the reader. |
| `coordinateSpace` | `world` or `object-local`, as reported by the reader. |
| `source` | Tool, arguments and the reader metadata that produced it. |

Geometry is inline because the spike has no engine buffer to reference. E2 or the
engine-backed producer replaces `storage` with buffer handles and changes nothing
else in the draw list.

### Draw

| Member | Meaning |
| --- | --- |
| `id` | Stable draw identity (level: `instance<i>.primitive<p>`, car: `primitive<n>`). |
| `meshId` | Mesh the ranges refer to. |
| `vertexOffset`, `vertexCount` | The touched vertex range. Diagnostic and culling information: indices are absolute, so the consumer does not need it to rasterise. It is validated to fall inside the mesh. |
| `indexOffset`, `indexCount` | Range passed to `drawIndexed`; `indexCount` must be a multiple of 3. |
| `world` | 16 floats. |
| `worldKind` | `baked-into-mesh` (positions already include the transform; `world` is identity by contract) or `packet-transform` (the consumer must apply `world`). |
| `materialId` | Material identity or `null`. Never a colour. |
| `materialReason` | Non-empty string. Always says why a material is or is not bound. |
| `layer` | `opaque` or `transparent`. |
| `bounds` | World-space AABB of the draw. |
| `source` | Tool, `instanceIndex`, `basePrimitiveIndex`, plus the reader's own binding text. |

`worldKind` is the one addition to the strategy sketch, and it exists to remove
an ambiguity that would otherwise cause double transforms: the level reader bakes
each instance's affine `g_mWorld` into world-space positions, while the Corvette
is object-local and needs a per-draw transform. Both are now explicit.

### Hash

The hash is SHA-256 over the UTF-8 **canonical body**: the packet object with the
`hash` member removed, keys sorted recursively, compact `JSON.stringify` number
formatting. Two consequences:

- key order and pretty-printing are irrelevant to the hash;
- a packet can be reformatted for review without invalidating it.

The producer computes the hash with the same function the validator uses, and the
validator independently recomputes it, so a hand-edited packet fails the gate.

## Producer

`probes/render-packet/tools/build_packet.mjs`.

Inputs are existing verified reader outputs, invoked as tools rather than
re-parsed by hand:

| Source | Invocation | Result used |
| --- | --- | --- |
| River level | `level_inspect.exe --instances-all … 27 253` | 22 instances, 13,162 vertices, 10,308 triangles, world space |
| Corvette C3 race body | `scene_inspect.exe corvette_c3_race.model.decoded` | 80 draws, 30,591 vertices, 36,193 triangles, object-local |

Derived, not guessed:

- per-draw `vertexOffset`/`vertexCount` — min/max index of the draw's index range;
- per-draw `bounds` — min/max of the positions the draw's indices reference,
  transformed by the draw matrix when one applies;
- camera — orbit yaw/pitch fixed by the producer, distance fitted so every vertex
  of both meshes stays inside the frustum, near/far derived from that distance;
- mesh hashes — computed from the exact float32/uint32 bytes.

Declared rather than derived:

- the light is labelled `diagnostic: no original level or vehicle light is
  recovered by this spike`;
- the vehicle placement. No engine spawn transform is in scope, so the producer
  translates the car's local origin to the centre of the level draw bounds and
  records it in `placedObjects` with `placement: "level-draw-bounds-center"` and
  a reason string. It is auditable and reproducible. It is not a spawn point, and
  it is why the car intersects a level prop in the screenshots.

Absent rather than invented:

- every level draw has `materialId: null` and the reader's own reason
  (`Level instance diagnostic; materials not applied`);
- car draws with no albedo image have `materialId: null` and the reader's binding
  text; the 14 draws that do bind a shared albedo image get
  `corvette.albedo.sharedTexture.<n>`, and the matching `materials[]` entry says
  `pixelsIncluded: false`;
- no vertex normal, UV, texture or colour is carried in v1.

## Consumer

`probes/render-packet/web/packet-consumer.js` (pipeline), `web/app.js` (bootstrap
and HUD). Adapted from `mesh-viewer.js`; the asset viewer is untouched.

- validates `kind`, `version` and the camera convention string before upload;
- one vertex buffer and one index buffer per mesh, one `drawIndexed` per draw;
- per-draw uniform (256-byte stride, dynamic offset): `viewProjection`, `world`,
  albedo;
- one scene uniform: light direction, light colour × intensity, ambient;
- fragment shading: face normal from `dpdx`/`dpdy` of the world position, Lambert
  against the packet light, neutral albedo `0.8`, gamma-encoded output;
- the first frame uses the packet's `view`/`projection` **verbatim**, so the
  screenshot tests the packet camera rather than a local reconstruction;
- pointer orbit and `?focus=<meshId>` are consumer-side debug cameras and are
  labelled as such in the HUD.

The consumer never reports success on its own: the capture harness reads state
from the page and `_work/render-packet/browser-evidence.json`.

## Evidence

### Packet gate

```
node probes/render-packet/tools/verify_render_packet.mjs
```

| Item | Value |
| --- | --- |
| Packet | `_work/render-packet/packet.json` |
| Packet hash | `sha256:7ede3abd6264d8275a508260772345300e718961700b46ad68374f8ec4a0e0d1` |
| File size | 2,906,496 bytes |
| Canonical hashed body | 2,432,052 bytes |
| Draws | 102 |
| Meshes | 2 |
| Vertices | 43,753 |
| Triangles | 46,501 |
| Instances emitted / omitted | 22 / 35 |
| Culled | 0 |
| Materials declared / applied | 4 / `false` |
| Determinism | run1 and run2 files both `sha256:14774a4971ee1d5be39ae1a218e149b90144344fdbec333c053b23b54fc536d5` |
| Conformance | pass — no errors, all 102 draw ranges inside their meshes, every index inside its vertex count, hash recomputed, all draw AABBs inside the packet camera clip volume |

Per mesh:

| Mesh | Vertices | Triangles | Draws | Position hash | Index hash |
| --- | ---: | ---: | ---: | --- | --- |
| `river.block27.instances-all` | 13,162 | 10,308 | 22 | `sha256:88829ddc…8216b7c1` | `sha256:28c7bdf3…03721757` |
| `corvette.c3.race.body` | 30,591 | 36,193 | 80 | `sha256:318260f0…67697ff8` | `sha256:dcf98521…994cdd1d` |

`_work/render-packet/verify.json` is the machine-readable record.

### Browser

```
node probes/render-packet/tools/capture_browser.mjs
```

Headless Edge (`--headless=new --enable-unsafe-webgpu`) driven over CDP at
1600×900, device scale 1. Three page loads, each waiting for the page's own
`renderState` to reach `ready`, then four animation frames before capture.

| Run | URL | Screenshot | Draws | Frames | Console |
| --- | --- | --- | ---: | ---: | --- |
| packet camera | `/` | `_work/render-packet/browser-packet-camera.png` | 102 | 1 | empty |
| level debug camera | `/?focus=river.block27.instances-all` | `_work/render-packet/browser-level-focus.png` | 102 | 2 | empty |
| car debug camera | `/?focus=corvette.c3.race.body` | `_work/render-packet/browser-car-focus.png` | 102 | 2 | empty |

- Adapter reported by the page: `nvidia / blackwell`.
- Canvas 1600×900, aspect 1.7778, equal to the packet camera aspect within 0.01.
- **Console: zero messages of any kind** — no errors, no warnings, not even a
  log line. `favicon.ico` is suppressed with an inline data URI so the 404 does
  not pollute the log.
- What the screenshots show:
  - packet camera: the River block27 prop row — platforms, a billboard/sign, and
    parked-car props — drawn from the packet's 22 level draws.
  - level debug camera: the same frame without the vehicle influence; it is
    nearly identical to the packet camera frame because the placed car is
    occluded, see below.
  - car debug camera: the Corvette C3 race body in full — front clip, fenders,
    cockpit surround and rear wing — drawn from the packet's 80 car draws.
- **Occlusion, recorded rather than hidden:** the vehicle's declared anchor is the
  centre of the level draw bounds, and a tall level prop (instance 12) occupies
  the same footprint, so the car is not visible in the wide frame.
  `_work/render-packet/browser-packet-camera-middle-zoom.png` is a 3× crop of the
  middle of `browser-packet-camera.png` showing that prop in front of the anchor.
  All 102 draws are submitted in every frame; the car-focus screenshot is how the
  vehicle is shown.
- `_work/render-packet/browser-evidence.json` records the browser, flags,
  viewport, per-run probe state and the complete console log.

A real GPU rendering 46,501 triangles from a packet with an empty console is the
claim. Nothing about material or lighting fidelity is claimed.

## Limits

Recorded in the packet itself (`diagnostics.approximations`, `.notRecovered`,
`.limits`) so a consumer cannot mistake the spike for a product:

- packet v1 is JSON with inline geometry; `tick` is 0 and `alpha` is 0 because no
  engine tick loop produced it;
- materials are identity only — no texture pixels, no shader binding, no vehicle
  paint or runtime light blend;
- lighting is one diagnostic directional light; normals are screen-space
  derivatives, not original vertex normals;
- no shadow, post-process, particle or effect pass;
- the vehicle placement is a declared presentation anchor, not a spawn transform;
  its anchor coincides with a tall level prop, so the car is occluded in the wide
  frame and is shown through the car debug camera instead;
- level blocks 26/32 (cross-chunk group assembly) and 31 (ChunkInfo prerequisite)
  are missing, as are higher LODs, damage states and wheel placement;
- headless Edge is a proxy; the same page should be opened in the user's physical
  browser for confirmation.

## What this does not claim

- No game integration. The packet is produced by a tool, not by the wasm engine.
- No engine scene/material integration. No DX11/FX11 surface is touched.
- No visual fidelity to retail Blur. The shading is explicit and diagnostic.
- No complete level. This is one geometry block's supported instances plus one
  vehicle body.

## Next steps this unblocks

1. Point the producer at the engine's draw-list builder instead of
   `level_inspect.exe`, keeping the same JSON contract and hash.
2. Add `storage: "engine-buffer"` so the packet can reference wasm memory instead
   of inlining geometry, and keep the v1 fields unchanged.
3. Add a `materials` extension that carries texture payload references (block,
   index, mip, offset) once the level material path is decoded, with
   `pixelsIncluded` flipping to `true` only for payloads that are actually read.
4. Extend the browser gate from "console empty + screenshot" to a per-frame hash
   comparison against the deterministic packet, so renderer regressions are
   caught the same way reader regressions are.
