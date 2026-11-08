# `probes/map-props` — static prop colliders from the map-slice render packages

Derives static oriented-box (OBB) prop colliders for the visible man-made
structures of `usa_amboy` and `spa_barcelona_gracia`, using the committed
map-slice render packages as the only geometry source.

**Data only.** No renderer, GPU, browser, e1-drive integration, playable-map or
full-game claim is made. This probe does not modify `probes/e1-drive`,
`probes/map-slice`, `probes/prop-collision`, `tools/`, `upstream/` or
`game-data/`; it imports the committed P74 helpers and resolver read-only.

## Inputs

| input | role |
| --- | --- |
| `_work/map-slice/amboy-render/` | visible opaque draws, shared position/index buffers, layout points, diagnostics |
| `_work/map-slice/gracia-render/` | same for Gracia |
| `_work/map-slice/{amboy,gracia}/slice.json` + `collision.*.bin` | collision triangle mesh, used **only** as a ground-height reference |
| `probes/prop-collision/lib/{collider-build,geometry,geom2d,resolver}.mjs` | committed classification, component split, box fit and resolver |

Buffer sizes and SHA-256 are re-checked on load; a mismatch throws. The opaque
draw list plus the diagnostics draw list must tile the shared index buffer
exactly once.

## Rules (summary)

- Source is the **visible opaque draw list** (`render.json#draws`). The 405
  Amboy / 953 Gracia diagnostic draws (additive decal layer, decoder-size,
  alpha-rule, runtime albedo) are not visible opaque geometry and are not
  collider source; they are counted in `measure.json` and typed in
  `unsupported[]` with their source byte position.
- One OBB per vertex-connected component; minimum-area XZ rectangle over the
  component convex hull (rotating calipers); Y from the collision column.
- Material-independent: a vertical structure stays collidable even when its
  texture name matches a terrain pattern. Terrain/ground-surface components are
  excluded only when the geometry is actually ground (`upRatio >= 0.5`, or not
  vertical).
- Natural rock/barrier/sand/vegetation scenery is **out of scope** for a prop
  layer. It is excluded with reason `natural-terrain-scenery` and listed, never
  silently dropped.
- `vertical extent >= 0.25 m`, `top > ground + 0.20 m` (not flush),
  `bottom < ground + 2.50 m` (not overhead); a non-overhead obstacle occupies a
  ground-to-top collision column.
- Region: component footprint within **40 m** of the measured layout polyline.
- Ground: windowed collision-mesh sample (±8 m around the nearest layout-point
  ground). Fallback to the layout ground is recorded as `groundExact:false`.
- Car envelope: the documented P66/P74
  `2.98 × 1.68 × 1.35 m` maximum.

## Profiles

| profile | meaning |
| --- | --- |
| `roadside` (default) | every collider except the components that overlap the measured path; the committed line stays clear |
| `all-visible` | every mapped collider; the measured path is blocked at the recorded arcs |

`active:false` marks an on-path collider. It is kept in the data with
`exclusion.rule = "on-measured-path"`, first/last arc and sample count. Nothing
is dropped from the manifest.

## Result

| | Amboy | Gracia |
| --- | ---: | ---: |
| visible prop colliders | **484** | **973** |
| active in `roadside` | **484** | **965** |
| mapped but on the measured line (`active:false`) | 0 | 8 |
| collider triangles | 1,126 | 4,954 |
| all-visible blocked samples / arcs | 0 / 0 | 56 / 2 |
| roadside blocked samples | **0** | **0** |
| minimum roadside clearance | 0.635 m | 0.432 m |
| collider manifest | `_work/map-props/colliders-amboy.json` | `_work/map-props/colliders-gracia.json` |
| manifest bytes / SHA-256 | 5,857,794 B / `7007b72a…40d05b` | 6,856,223 B / `57da056d…9381e0` |
| loader manifest | `_work/map-props/manifest-amboy.json` | `_work/map-props/manifest-gracia.json` |
| content SHA-256 | `a8edf42c…f4018d6` | `b3dedf1e…f1694249` |

The two Gracia blocked arcs are `16.407–23.571 m` (a road wall and the tunnel
gate) and `179.238–185.480 m` (four `scene_vehicle_d_diff` vehicles). They are
kept as mapped, inactive colliders under `roadside`; the measured line stays
clear. Amboy has no visible prop on the measured line.

## Manifest schema

Top level (`kind:"map-props-colliders"`, `version:1`, `schema:"blur.map-props/1"`):

```text
schema, kind, version, variant, mapKey, level,
scope { dataOnly, visibleMeshApproximation, retailCollision:false,
        collisionSurfaceUsedAsCollider:false, rendererChanged:false,
        e1DriveIntegrated:false, gpuUploaded:false, browserFrameProduced:false,
        gameClaim:false, instancesApplied:false, normalsIncluded:false,
        partialSceneTraversal:true, coordinateSpace, statement },
carEnvelope { length:2.98, width:1.68, height:1.35, source },
region { method, distanceM:40, pathSource, pathLengthM, pathPoints, pathSpacingM },
rules { sources, groundSource, excludedSources, inclusion, boxFit, thresholds },
classification { textureCensus, unclassifiedTextures, structureClassCensus, ... },
inputs { render, diagnostics, positions, indices, layout, slice,
         collisionPositions, collisionIndices },   // path + bytes + sha256
path { lengthM, polylineLengthM, samples, spacingM, spawn, checkpoints, finish,
       allVisibleBlockedSamples, allVisibleBlockedArcs,
       defaultProfileBlockedSamples, minClearanceM, minClearanceColliderId },
profiles { roadside {active:true, colliders}, "all-visible" {active:false, colliders} },
counts { colliders, active, inactiveOnMeasuredPath, triangles, byClass,
         byStructureClass, excluded, outOfRegionByClass, unsupported, bounds },
coverage { componentsTotal, componentsInRegion, componentsCollider,
           componentsExcluded, componentsOutOfRegion, drawsTotal, drawsInRegion,
           drawsWithCollider, trianglesInRegion, trianglesCollider,
           verticalStructuresInRegion, verticalStructuresWithCollider,
           passThroughVerticalStructures, passThroughByReason, ... },
unclassified[], onMeasuredPath[], colliders[], excluded[], unsupported[],
contentSha256
```

Each `colliders[]` record:

```text
id, type:"obb", source:"track-visual",
center:[x,y,z], axes:[[ux,0,uz],[0,1,0],[vx,0,vz]],
half:[hu,hy,hv], size:[2hu,2hy,2hv], worldAabb:{min,max},
vertical { bottom, top, height, geometryBottom, geometryTop, groundY,
           groundExact, groundHits, groundSource, groundSamplePoint,
           bottomAboveGround, topAboveGround },
classification, classificationReason, structureClass, structureClassReason,
distanceToPath, triangles,
provenance { package, packageLevel, drawId, section, sectionDrawIndex, texture,
             textureId, textureFormat, drawStatus, indexRange:[first,last],
             indexCount, componentIndex, componentTriangles, componentVertexCount,
             componentMin, componentMax, boxFit, boxAngleRad,
             minimumThicknessInflated, identityWorld, textureClassification,
             upRatio, verticalRatio, slopedRatio, verticalRule, region,
             regionDistanceM, groundReference },
active, hash            // hash = sha256(stableStringify(record without hash))
```

`axes[0]`/`axes[2]` are the XZ box axes; `yaw = atan2(axes[0][2], axes[0][0])`.
`vertical.bottom/top` is the collision column. This is the same OBB contract the
committed `probes/prop-collision/lib/resolver.mjs` consumes, so a map manifest
can be passed to `createWorld(manifest, {profile})` unchanged. The manifest
`kind` is `map-props-colliders` (not `prop-collision-colliders`); an integration
must accept that kind explicitly.

## Unsupported (typed, with source byte position)

Every case that did **not** become a collider is named in `unsupported[]` and,
for in-region components, in `excluded[]`. Each record is
`type:"unsupported"` and carries a `source` object:

```text
source { package, file:"draws.indices.u32.bin",
         byteOffset: firstIndex * 4, byteLength: indexCount * 4,
         indexRange:[firstIndex, firstIndex+indexCount],
         drawId, componentIndex }
```

Aggregate records use `byteOffsetMin`/`byteOffsetMax` instead of a single
offset. Reasons:

| reason | meaning |
| --- | --- |
| `diagnostic-not-visible-opaque` | one record per diagnostic draw (405 Amboy / 953 Gracia); not visible opaque geometry, never collider source |
| `flat` | vertical extent < 0.25 m |
| `flush` | top <= ground + 0.20 m |
| `overhead` | bottom >= ground + 2.50 m |
| `road-terrain` / `ground-surface` | terrain-textured component whose geometry is actually ground |
| `natural-terrain-scenery` | natural rock/barrier/sand/vegetation scenery, out of scope for a prop layer |
| `out-of-region` | one aggregate per texture class; farther than 40 m from the measured path |

Counts: Amboy `total:414` (405 diagnostic draws + 4 excluded-reason aggregates
+ 5 out-of-region aggregates; 5,509 in-region components excluded, 84,190
out-of-region); Gracia `total:963` (953 + 5 + 5; 4,487 excluded, 101,139
out-of-region). No collider is invented: every collider has a `provenance`
index range that resolves to a committed draw.

## Commands

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $node probes/map-props/tools/build_colliders.mjs --map all   # manifests
& $node probes/map-props/tools/resolve.mjs                     # resolver suite
& $node probes/map-props/tools/measure.mjs                     # measurement report
& $py   probes/map-props/tools/map_topdown.py                  # top-down PNGs
& $node probes/map-props/tools/verify.mjs                      # verifier (259 checks)
& $node probes/map-props/tools/emit_hashes.mjs                 # hash index
```

`verify.mjs` re-reads every committed input, re-checks the package pins,
validates every collider record (schema, finite numbers, OBB orthonormality,
per-record hash, provenance index range), independently recomputes the
component split and box fit against the committed P74 helpers, recomputes the
path clearance with the committed resolver, checks the start grid is clear
under both profiles, checks every collider is inside the 40 m drivable band,
checks the typed `unsupported[]` byte positions, and rebuilds both manifests
twice to prove byte-identical determinism. It prints
`checks N, errors 0, status PASS` and exits 1 on any failure.

## Outputs (`_work/map-props/`)

Outputs stay in `_work/` (AGENTS.md: build outputs are not committed). A future
integration that needs a committed copy must copy the file and record its
SHA-256; the loader manifest already carries the file and content hashes.

| file | content |
| --- | --- |
| `colliders-amboy.json` / `colliders-gracia.json` | full collider manifest: profiles, per-collider hash + provenance, path measurements, coverage, typed `unsupported[]` with source byte positions |
| `manifest-amboy.json` / `manifest-gracia.json` | small per-map loader manifest for e1 (file/content hashes, counts, profile names, path) |
| `measure.json` | compact cross-map measurement report, blocked arcs with the exact structures |
| `resolve.json` | committed-resolver tests (spawn, head-on, glance, no-tunnelling, path drive, determinism) |
| `map-amboy.png` / `map-gracia.png` | top-down diagnostic |
| `verify.json` | independent verifier (259 checks, status PASS/FAIL) |
| `hashes.json` | SHA-256 of every artifact and probe source |
| `build-summary.json` | build log summary |

Logs are written under `_work/logs/map-props/`.

## Integration (recommended)

Load `manifest-<map>.json`, then `colliders-<map>.json`, and construct the
committed resolver world with `profile:"roadside"`. Use `all-visible` only when
the course is re-measured or the on-path props are moved. Record the manifest
file hash, content hash, profile and collider count in the packet/HUD; never
fall back to a different profile silently.

The manifest `kind` is `map-props-colliders`; `prop-layer.js` currently accepts
`prop-collision-colliders` only. An integration must either accept both kinds or
adapt the record shape (the OBB fields are already identical). The loader
manifest's `colliders.file` is relative to `_work/map-props/`, so the dev server
needs a `/_work/map-props/` route (the existing `serve.mjs` routes
`/_work/prop-collision/` and `/_work/free-roam-prop/`).

## Scope labels

- `dataOnly:true`, `visibleMeshApproximation:true`, `retailCollision:false`
- `collisionSurfaceUsedAsCollider:false` (ground reference only)
- `rendererChanged:false`, `e1DriveIntegrated:false`, `gpuUploaded:false`,
  `browserFrameProduced:false`, `gameClaim:false`
- `instancesApplied:false`, `normalsIncluded:false`, `partialSceneTraversal:true`
- `coordinateSpace:"source level coordinates, unchanged"`
- `profiles.roadside` is the default; `all-visible` is opt-in and blocked at the
  recorded arcs.

## Limits

- Visible-mesh approximation, not retail collision and not `Level.levelphysics`.
- One box per connected component; a hollow or L-shaped structure is
  over-approximated by one rectangle.
- Upper-storey walls and roofs above `ground + 2.5 m` are true overhead and are
  not separate colliders; the ground-level component below them is.
- Natural terrain scenery (rock ridges, natural barriers, sand, vegetation) is
  not a prop collider in this layer.
- 40 m band only; components farther away are counted but not collidable.
- No rendered frame, browser screenshot, GPU upload or full-game claim.
