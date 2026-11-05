# probes/prop-collision — static visible-prop colliders for the E1 PoC

A **data + resolver prototype**, not an integration. It derives oriented static
colliders from the visible E1 prop meshes near the measured 310.395 m course,
writes a deterministic manifest, and proves a car-sized OBB can be stopped by
them at 60 Hz without tunnelling — while the committed course remains drivable
under the default (roadside) profile.

Nothing in `probes/e1-drive/`, `probes/car-parts/`, `probes/drivable-path/`, the
engine or the render packet is modified. The output is a manifest and a
standalone JS resolver that a later task can consume.

## Result

| | |
| --- | --- |
| visible prop colliders | **468** oriented boxes (8 level instances + 460 track-visual components) |
| active in the default `roadside` profile | **373** (12,606 triangles) |
| mapped but on the measured line (`active:false`) | **95** (448 triangles) |
| collider bounds | `(-110.38, -1.77, 994.45) … (102.09, 11.03, 1311.26)` |
| 310 m line under `roadside` | **0 / 1,245** car poses blocked |
| 310 m line under `all-visible` | **181 / 1,245** blocked at **4** measured arcs |
| resolver tests | **52 / 52 PASS**, 0 failures |
| collider manifest (deterministic) | `_work/prop-collision/colliders.json`, 1,250,368 B, `sha256:a98fb8eb…317af4` |
| collider content hash | `sha256:8f09d12d2fcd6ea1…ffd174` |
| top-down map | `_work/prop-collision/map.png`, `sha256:09f49eed…2cc04` |

The 310 m line is **not** free of visible props: the committed P48 course was
measured on the collision-only surface, before visible props existed as
colliders. Four prop clusters (a metal rack at arc 52.9–61.1 m, concrete pipes at
114.3–121.8 m, construction fences at 124.8–127.8 m, and a second metal rack at
181.4–206.8 m) sit on that line. The default profile keeps them in the manifest
as mapped, inactive colliders and labels the conflict; the `all-visible` profile
enables them and makes the committed line impassable. That is a data conflict,
not a resolver failure, and it is the main integration finding.

## Files

```
probes/prop-collision/
  lib/
    geom2d.mjs          convex hull, minimum-area rectangle, polyline distance
    geometry.mjs        mesh access, connected components, instance OBB, ground sampler
    collider-build.mjs  classification, collider derivation, profiles, hashing
    resolver.mjs        car OBB vs static OBB, SAT, substeps/CCD, friction response
  tools/
    build_colliders.mjs writes _work/prop-collision/colliders.json
    verify_colliders.mjs 52-check gate -> _work/prop-collision/verify.json
    probe_road.mjs      centreline + lateral-corridor measurement (diagnostic)
    map_colliders.py    top-down PNG (PIL, diagnostic)
    diagnose_draws.mjs  texture/component census used to choose the rules
    explore_props.mjs   original read-only exploration (kept for provenance)
```

## Inputs (pinned by SHA-256)

| input | SHA-256 |
| --- | --- |
| `_work/e1-drive/geometry.json` (geometry **v6**) | `85a321000868042a11ccabffeb65feaa16e36d35220f1843ea46b48244eb0445` |
| `_work/drivable-path/path.json` (310.3952 m P48 course) | `81eac0ce413075de33e2b3c0e1c077412b35002420b199d9f05d2fdeef230e7f` |

The builder re-hashes both files and refuses any other geometry version or
course length. The manifest records both hashes.

## Commands

Use the bundled runtimes:

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# 1. manifest (deterministic; rerun produces the same file SHA-256)
& $node probes/prop-collision/tools/build_colliders.mjs

# 2. 52-check gate: schema, hashes, active/inactive consistency, road sweep,
#    head-on, glancing, 31 m/s no-tunnelling, 310 m drive, determinism
& $node probes/prop-collision/tools/verify_colliders.mjs

# 3. road diagnostics (both profiles, corridor widths)
& $node probes/prop-collision/tools/probe_road.mjs

# 4. top-down map
& $py probes/prop-collision/tools/map_colliders.py

# optional: texture/component census
& $node probes/prop-collision/tools/diagnose_draws.mjs
```

Outputs go to `_work/prop-collision/` and logs to `_work/logs/prop-collision/`.
Nothing is committed from `_work/`.

## Method

### Sources

- **Level props:** `river.block27.instances-all`, 22 world-baked draws forming
  **8 source instances** (grouped by their `instanceMatrix`, not by draw index).
  Six are 5.386 × 1.531 × 2.219 m vehicle-sized shapes and two are
  2.882 × 4.719 × 8.194 m building-sized shapes. They have no material or
  texture binding, so their class is a documented **shape rule**, not a name.
- **Track visual:** `river.track.visual`, 394 direct draws / 57,133 triangles.
  Each draw is split into **vertex-connected components**; each component is a
  candidate prop. Components use the draw's texture name to classify into
  terrain, ground surface, vehicle, building, structure or unclassified.
- **Ground reference:** `river.collision.surface` (hidden, physics-only) is
  sampled for local ground height only; it is never a collider.
- **Excluded:** the player car bodies (5), the road/kerb/tarmac/mud/grass/
  pavement components, flat/flush/overhead components, and everything farther
  than 30 m from the measured course.

The `excluded` list in the manifest records 220 flat, 37 flush, 31 overhead and
378 road/terrain components inside the region, each with its source draw,
texture class and reason. A texture census names every class, including the four
unclassified draws (`DefaultColour` ×3, `greyrocks01_diff` ×1); zero
unclassified components are inside the 30 m region, so they never become
colliders.

### Box fit

- **Level instance:** oriented box from the source instance matrix columns
  (rigid rotation checked: orthogonality residual and determinant are recorded),
  extents measured from the baked world vertices.
- **Track component:** **minimum-area enclosing rectangle** over the component's
  convex hull in XZ (rotating calipers), Y from the component's vertical extent.
  This is a deterministic geometric fit, not a guessed transform. Half extents
  below 1 cm are inflated to 1 cm and labelled `minimumThicknessInflated`.

### Profiles

`colliders.json` holds every mapped collider. `active` is true for the default
`roadside` profile; `active:false` marks a collider that overlaps the car
envelope on the measured line and carries `exclusion.rule:
"on-measured-course"`. The manifest records the 4 blocked arcs and the collider
ids. `createWorld(manifest, {profile:"all-visible"})` includes all 468.

## Resolver

`lib/resolver.mjs` is standalone ESM (no dependencies, no DOM).

- Car: **2.98 × 1.68 m** OBB (documented maximum XT envelope; largest roster
  wheelbase 2.981 m) and a 1.35 m body band for the vertical filter. This is not
  a recovered retail hull.
- Static collider: OBB; XZ axes from `axes[0]`/`axes[2]`, vertical span from
  `center[1] ± half[1]`.
- Broadphase: deterministic uniform grid (4 m cells).
- Contact: 2D SAT over the four box axes; minimum penetration axis; normal from
  collider to car.
- Step: fixed caller `dt`; substeps = `ceil(speed × dt / 0.08 m)`, capped at 64,
  so 31 m/s uses 7 substeps. Each substep resolves the deepest contact first for
  a fixed maximum of 6 iterations.
- Response: positional push-out + `slop`; normal velocity removed
  (restitution 0 by default), then Coulomb friction (`μ = 0.45`) on the
  tangential component. No acceleration, suspension or tyre model is simulated —
  the resolver is a kinematic response layer, not the vehicle physics.
- Deterministic: fixed axis order, no hash-map iteration order, fixed substep
  count from the actual speed. A 120-tick replay hashes identically.

## Tests (`verify_colliders.mjs`, 52/52 PASS)

| test | recorded result |
| --- | --- |
| manifest schema / per-collider hashes / finite numbers / OBB orthonormality | 468 / 468 valid |
| recompute manifest from inputs | byte-identical collider array and content hash |
| rerun builder | identical file SHA-256 across two runs (`a98fb8eb…317af4`) |
| default profile on the 310 m line | **0 / 1,245** poses blocked |
| all-visible profile on the 310 m line | **181 / 1,245** blocked, 4 arcs |
| 6 m gate corridor (car centre ±2.16 m) | clear pose at every 0.5 m row; min 2 / 37 offsets |
| head-on into `level.instance.00` (5.39 m vehicle-sized prop) at 31 m/s | stops with gap **0.001 m**, final speed **0.000 m/s**, max penetration 0.0448 m (one substep), no residual overlap; baseline passes through (155 m travelled) |
| all-visible head-on into the on-course concrete pipe at arc ~114 m | stops at gap **0.001 m**, no residual overlap — the 95 inactive components are real colliders, not decoration |
| glancing along a 44.7 m wall at 5° incidence | **96.1 %** tangential speed retained (19.14 / 19.92 m/s), max penetration 0.0033 m |
| 31 m/s into 12 thin (0.02 m) fence components | **0** tunnelled, **11** target contacts, substeps ≥ 7; all 12 no-collision baselines pass through |
| 120-tick head-on replay | identical state/contact hash `sha256:73caedeb…3f0fa` |
| 310 m kinematic drive at 20 m/s through the active layer | completes 310.15 m in 931 ticks, **0 contacts**, 0 penetration |
| broadphase cost | 4,980 queries in ~2.5 ms (~0.50 µs/query, Node, diagnostic only) |

## Limits

- **Visible-mesh approximation.** Colliders are boxes fitted to visible
  components near the course. They are not retail collision data, not the
  engine's `Level.levelphysics`, and carry no material/friction/surface claim.
  One building may be several boxes; long or L-shaped components are
  over-approximated by one oriented rectangle.
- **30 m region.** Visible props farther than 30 m from the course are counted
  in `outOfRegionByClass` but not collided. A car that leaves the area can drive
  through them.
- **On-course props are inactive by default.** 95 components (448 triangles)
  overlap the measured line. Enabling them blocks four arcs. The committed
  course should be re-measured (or the props moved) before a mode with
  `all-visible` is shipped.
- **2.5D kinematic resolver.** No rotation sweep, no suspension, no wheel
  forces, no car-to-car collision and no vertical dynamics. Rotation per tick is
  not swept; the car yaw follows the actual velocity direction.
- **No e1-drive integration.** No page, module or packet change; no browser
  screenshot claim for a collider visual. The map is a top-down diagnostic.
- **No full-game claim.** One level, one measured course, one car envelope.

## Integration recommendation

1. Consume `_work/prop-collision/colliders.json` from a future `e1-drive` task;
   it is deterministic, self-describing and versioned (`kind`, `version`).
2. Start with `profile:"roadside"` (373 colliders). Apply the resolver to the
   car's body pose **after** the engine tick, as an additive response layer:
   keep the engine's state authoritative and adjust the body pose/velocity only
   when a contact exists. Do not replace the vehicle physics.
3. Before enabling `profile:"all-visible"`, re-measure the course or relocate
   the four on-course prop clusters; otherwise the sprint line is blocked at
   arc 52.9–61.1, 114.3–121.8, 124.8–127.8 and 181.4–206.8 m.
4. If the car can leave the 6 m gate band, widen the region or add a streamed
   collider set; the current manifest is bounded to 30 m.
5. Add a browser check when the layer is actually integrated (screenshot +
   clean console); this task deliberately makes no browser change.
