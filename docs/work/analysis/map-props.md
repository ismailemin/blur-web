# `usa_amboy` / `spa_barcelona_gracia` — static prop colliders from the visible render packages

**Date:** 8 November 2026
**Owner:** PM1 (sub-agent)
**Scope:** `probes/map-props/**`, `_work/map-props/**`,
`_work/logs/map-props/**` and this document. No change to `probes/e1-drive`,
`probes/map-slice`, `probes/prop-collision`, `probes/free-roam*`, `tools/`,
`upstream/` or `game-data/`. The committed render packages, slice collision and
the P66/P74 helpers are consumed read-only.

**Result: 1,457 static OBB colliders (484 Amboy / 973 Gracia) derived from the
visible opaque draws of the committed render packages, a 40 m band around each
measured path, two explicit profiles (`roadside`, `all-visible`), a 233-check
verifier with 0 errors, and byte-identical rebuilds. Amboy's measured path is
clear of every prop collider; Gracia's is blocked at two arcs by real visible
props (a road wall/tunnel-gate cluster and four parked scene vehicles), which are
recorded and excluded under the default profile.**

**No renderer, GPU, browser, e1-drive integration, playable-map or full-game
claim is made.** This is data only.

---

## 0. Result

| item | `usa_amboy` | `spa_barcelona_gracia` |
|---|---:|---:|
| visible opaque draws (source) | 1,201 | 2,627 |
| diagnostic draws (not source) | 405 / 79,648 tri | 953 / 185,181 tri |
| vertex-connected components (whole map) | 90,183 | 106,599 |
| components in the 40 m band | **5,993** | **5,460** |
| components that became colliders | **484** | **973** |
| collider triangles | 1,126 | 4,954 |
| colliders active (`roadside`) | **484** | **965** |
| colliders on measured path (`active:false`) | **0** | **8** |
| vertical structures in band | 917 | 2,004 |
| vertical structures with a collider | 340 | 653 |
| ground-band vertical structures | 497 | 656 |
| ground-band structures with a collider | **340 (68.4 %)** | **653 (99.5 %)** |
| measured path | 2,060.59538 m / 8,673 samples | 624.91378 m / 2,571 samples |
| all-visible blocked samples / arcs | **0 / 0** | **56 / 2** |
| `roadside` blocked samples | **0** | **0** |
| minimum clearance (`roadside`) | **0.635 m** | **0.432 m** |
| manifest file | `sha256:49996c44…dc1b4b` | `sha256:040bc96f…c6d5b8a` |
| manifest content hash | `sha256:a8edf42c…f4018d6` | `sha256:b3dedf1e…d1694249` |
| verifier | **233 checks, 0 errors, PASS** | |
| deterministic rebuilds | **2/2 byte-identical**, aggregate `sha256:df502e3c…fe4c49` | |

Cross-map totals: **1,457 colliders / 1,449 active / 6,080 triangles**;
993 of 2,921 vertical structures in the bands are prop colliders; 56 blocked
samples in 2 arcs, both on Gracia.

The ground-band row is the meaningful coverage figure: it counts only structures
whose own vertical geometry starts below `ground + 2.5 m`, i.e. structures the
car can actually reach. The remaining vertical structures are upper-storey walls
and roofs (true overhead) or natural scenery (out of scope), and both are listed
per component, not dropped.

---

## 1. Inputs and provenance

| input | role | SHA-256 |
|---|---|---|
| `_work/map-slice/amboy-render/render.json` | 1,201 visible opaque draws, buffers, layout | `0f73b248a58fe8b650b0f862898ad8b9affdcb61f0f6e70f9637d24d96231117` |
| `_work/map-slice/amboy-render/diagnostics.json` | 405 diagnostic/decal draws | `b8696505fe46ff82cfcc69a771a9ad313a95e543139eb03f6cf3a75ef1e821c4` |
| `_work/map-slice/amboy/draws.positions.f32.bin` | shared positions | `5d85409b9b838227907eca2d53b34a4d7f37cb6d67158dc596b70bc24dbb2755` |
| `_work/map-slice/amboy/draws.indices.u32.bin` | shared indices | `f4d77438b7ce99a809280e71b6cd356dedef784f613faf0147bd447c50b41e66` |
| `_work/map-slice/amboy-render/layout.points.f32.bin` | 8,673 `x,z,ground` points | `935e73575354f993a325e87ba41d4da63892cb21805a2f05ee706071c27f8754` |
| `_work/map-slice/amboy/slice.json` | slice manifest | `8f5e07d681353b47abb799fdcd69b716fecca225d7a2f76dab48bf14b501b3d7` |
| `_work/map-slice/amboy/collision.positions.f32.bin` | ground reference only | `0604bb8ef9062a241fa75dcc5f5bd94456f092efd74d339e3f28d776b147462d` |
| `_work/map-slice/amboy/collision.indices.u32.bin` | ground reference only | `46f998b321907abac53e71c5f417b35f48ca9361615ede5132ad29793a9765b3` |
| `_work/map-slice/gracia-render/render.json` | 2,627 visible opaque draws | `fd6266501fedb8eada56a0bc2e0b166eb3baff0345e1548786c8bcf4e2b3f514` |
| `_work/map-slice/gracia-render/diagnostics.json` | 953 diagnostic/decal draws | `4188b56a0bce108d250b2cb7fd165c715bc5e571a469913b7fc5b7d7289352b6` |
| `_work/map-slice/gracia/draws.positions.f32.bin` | shared positions | `f6edf5720a7399665e83018fee83de97a21b9f3cdc7fde7fcf310caca971ba11` |
| `_work/map-slice/gracia/draws.indices.u32.bin` | shared indices | `dea21ba6dcb38b88ac0d303f4346c12f781d7998e2c0e4e525f033c6964e789f` |
| `_work/map-slice/gracia-render/layout.points.f32.bin` | 2,571 `x,z,ground` points | `c4cd21db2781acd87ebcda822d8233a1c2ecb4f434bba89bd4fe7faf9f9c845f` |
| `_work/map-slice/gracia/slice.json` | slice manifest | `e1e1fe62c6e36d8ea71a7b82303b4ff4b6abafcb9fad2810e019be1292652534` |
| `_work/map-slice/gracia/collision.positions.f32.bin` | ground reference only | `8a70a122a0e8792c3d407fdede0f8a3a02f6fe777d4ae5800d953c8e0dab4829` |
| `_work/map-slice/gracia/collision.indices.u32.bin` | ground reference only | `6a72ebd65175c619bf2076f236082f3e5379689913eca18b9de5ecac21ed1bf2` |

The loader re-checks every buffer size and SHA-256 against the package manifest.
The opaque draw list plus the diagnostics draw list must tile the shared index
buffer exactly once (1,606/1,606 ranges Amboy, 3,580/3,580 Gracia, 0 gaps,
0 overlaps). The render packages' own verifiers report PASS (17,813 and 45,590
checks).

**Collider source is the visible opaque draw list only.** The 405 / 953
diagnostic draws are the additive `Racification*` decal layer, decoder-size
sources, BC3-alpha sources and runtime-albedo draws. They are not rendered as
opaque geometry in the package, so making them solid would create invisible
walls. They are counted in `measure.json → diagnosticExcluded` and are not
silently mixed in.

### 1.1 Code reused read-only

| module | use |
|---|---|
| `probes/prop-collision/lib/collider-build.mjs` | `classifyTexture`, `isGeometryGround`, `CAR_ENVELOPE`, `stableStringify`, `sha256` |
| `probes/prop-collision/lib/geom2d.mjs` | `convexHull2D`, `minAreaRect2D` (rotating calipers) |
| `probes/prop-collision/lib/resolver.mjs` | the committed P66/P74 resolver, used unchanged for every measurement and test |
| `probes/prop-collision/lib/geometry.mjs` | `meshAccessor` + committed `drawComponents` for the verifier cross-check |

---

## 2. Method

### 2.1 Component split and box fit

One collider per vertex-connected component of a visible opaque draw
(deterministic union-find; 90,183 components Amboy, 106,599 Gracia). The XZ box
is the **minimum-area enclosing rectangle** of the component convex hull
(rotating calipers); Y is the collision column. The verifier re-runs the
committed `drawComponents()` on up to 60 collider-bearing draws plus evenly
spaced draws per map and compares component count, bounds, vertex lists,
triangles, box half extents and box angle — all match.

### 2.2 Inclusion and exclusion rules

The P74 V2 rules are restated in each manifest (`rules`) and applied as code:

| rule | threshold |
|---|---|
| vertical extent of the component | `>= 0.25 m` |
| top above sampled ground | `> +0.20 m` (not flush) |
| bottom above sampled ground | `< +2.50 m` (a true overhead is excluded) |
| non-overhead obstacle | ground-to-top collision column |
| footprint distance to the measured path | `<= 40 m` |
| minimum collider half thickness | `0.01 m` (inflated, flagged) |

Material independence is kept: a vertical structure stays collidable even when
its texture name matches a terrain pattern, and a terrain-textured component is
excluded only when its geometry is ground (`upRatio >= 0.5`, or neither vertical
nor horizontal).

Two map-specific name rules are added, both documented in the manifest and
provenance:

1. **Road/ground surface names** the committed classifier does not know
   (`desertroad*`, `rg_tarmac*`, `airfieldconcrete*`, `kerb*`, `pavement*`, …)
   are classified as terrain, then the geometry ground test decides: a road
   surface is excluded, a vertical road-cut wall is kept.
2. **Natural terrain scenery** (rock formations, natural barriers, sand, cliffs,
   vegetation) is out of scope for a *prop* layer. It is excluded with reason
   `natural-terrain-scenery` and every component is listed in `excluded[]`.
   `Level.levelphysics` remains the physical terrain collision; this layer does
   not claim to replace it.

The natural-scenery rule is what prevents a single 420 m × 104 m low-poly rock
ridge (`rocks01_diff`, 29 triangles, 3.08 m tall) from becoming a box that
covers a 300 m section of road. That row is in `excluded[]`, not hidden.

### 2.3 Ground reference

`collision.positions/indices` are used **only** to sample ground height. The
sampler takes the nearest measured layout point's recorded ground as reference
and returns the collision triangle whose Y is closest to it inside ±8 m. This
avoids picking a bridge deck or tunnel roof above the road. If the component
centre is over a hole in the collision mesh (e.g. inside a building footprint),
eight deterministic perimeter points are tried and the exact in-window hit
closest to the layout ground is used. If no triangle is inside the window, the
layout ground is used and `groundExact:false` is recorded on the collider. Every
collider records `groundY`, `groundExact`, `groundHits`, `groundSamplePoint`,
`groundOffsetFromRefM` and `groundSource`.

Of the final colliders, the ground came from the centre window for 361 Amboy /
420 Gracia, from the footprint perimeter for 3 / 112, and from the documented
layout-ground fallback (`groundExact:false`) for 120 / 441.

### 2.4 Region and profiles

The region is **40 m** from the measured layout polyline (task range 30–50 m).
`counts.outOfRegionByClass` counts every visible component outside it; it is not
a silent drop.

| profile | Amboy | Gracia |
|---|---:|---:|
| `roadside` (default) | 484 | 965 |
| `all-visible` | 484 | 973 |

`active:false` marks a collider that overlaps the car envelope on the measured
path. It keeps its geometry, hash, provenance and
`exclusion {rule:"on-measured-path", firstArc, lastArc, samples,
maxPenetration}`. The default resolver profile skips exactly those.

### 2.5 Hashes

Every collider has `hash = sha256(canonical key-sorted record)`. The manifest
content hash is the SHA-256 of the canonical collider array. File hashes are in
`hashes.json`. Two independent builds are byte-identical.

---

## 3. Coverage

### 3.1 Amboy

| measure | value |
|---|---:|
| components in the whole map | 90,183 |
| components in the 40 m band | 5,993 |
| components with a collider | 484 |
| components excluded in band | 5,509 |
| components outside band | 84,190 |
| draws in band / with collider | 162 / 24 |
| triangles in band / in colliders | 16,676 / 1,126 |
| vertical structures in band | 917 |
| — with a collider | 340 |
| — true overhead (upper walls/roofs) | 420 |
| — natural terrain scenery | 157 |
| ground-band structures (bottom < +2.5 m) | 497 |
| — with a collider | **340** |
| — excluded natural scenery | 157 |

Exclusion census: `flat` 1,640, `natural-terrain-scenery` 834, `overhead` 1,154,
`road-terrain` 1,881. Out-of-region by class: building 2,336, structure 35,989,
terrain 7,336, unclassified 37,759, vehicle 770.

Structure classes of the colliders: building 114, pole-tower 316,
container-vehicle 16, pipe-structure 29, other 9. The map has no in-band
silo/tank/fence component that passes the rules; Amboy's verticals are mostly
`pylon01legs&frame_diff` and `steelpole_diff` legs (316 boxes, up to 14.47 m
tall), warehouse/hangar parts and a few containers.

### 3.2 Gracia

| measure | value |
|---|---:|
| components in the whole map | 106,599 |
| components in the 40 m band | 5,460 |
| components with a collider | 973 |
| components excluded in band | 4,487 |
| components outside band | 101,139 |
| draws in band / with collider | 188 / 85 |
| triangles in band / in colliders | 20,660 / 4,954 |
| vertical structures in band | 2,004 |
| — with a collider | 653 |
| — true overhead | 1,348 |
| — road-terrain (road-cut faces) | 3 |
| ground-band structures | 656 |
| — with a collider | **653** |
| — excluded road-terrain | 3 |

Exclusion census: `flat` 1,626, `flush` 1, `natural-terrain-scenery` 13,
`overhead` 1,746, `road-terrain` 1,101.

Structure classes: wall 327, building 453, container-vehicle 89, pipe-structure
64, fence-barrier 16, pole-tower 8, other 16. This is the expected Barcelona
street mix: facades/walls line the road, parked scene vehicles and street
furniture sit on it.

### 3.3 What the coverage numbers do and do not say

- Every non-scenery vertical structure whose own geometry starts in the car
  height band is a collider (340/340 on Amboy outside natural scenery, 653/656
  on Gracia outside 3 road-cut faces).
- 420 / 1,348 "vertical structures" are upper-storey walls and roofs above
  `ground + 2.5 m`. They are true overhead and are not separate colliders; the
  ground-level component beneath them is. A building whose ground floor is only
  a doorway is therefore not filled in — that is a stated limit.
- Natural rock/vegetation is not covered by this prop layer. It is physical
  terrain and is expected to be handled by the map collision, which this task
  does not re-verify.

---

## 4. Measured-path clearance

The car envelope is the documented `2.98 × 1.68 × 1.35 m` rectangle at the local
tangent, with `baseY` = the layout ground of each 0.25 m sample. "Blocked" means
a real SAT overlap with a collider whose vertical span intersects the body band.

![Amboy colliders against the measured path](../../../_work/map-props/map-amboy.png)

![Gracia colliders against the measured path](../../../_work/map-props/map-gracia.png)

*Top-down: grey = 40 m region band, black = measured path, red = all-visible
blocked arc, coloured boxes = colliders by structure class, purple = on-path
colliders inactive under `roadside`.*

The declared layout length is `2,060.59538 m` (Amboy) and `624.91378 m`
(Gracia). The clearance test uses the committed `layout.points.f32.bin`
`(x,z)` points; their double-precision length is `2,060.595408 m` and
`624.913781 m` (`path.polylineLengthM`). The render package also records its own
`pointsFloat32.lengthM` (`2,060.610596 m` / `624.911865 m`), which is a float32
cumulative sum and therefore drifts from the double-precision length of the same
points. All three values are recorded; none of them changes the collider or the
blocked set.

### 4.1 Amboy — clear

| profile | blocked samples / 8,673 | arcs | minimum clearance |
|---|---:|---|---:|
| `all-visible` | **0** | none | **0.635 m** |
| `roadside` | **0** | none | 0.635 m |

Minimum clearance is **0.635292 m** at `amboy.g124-n234#13.component.056`
(arc 1753.307 m). The measured line is clear of every mapped prop collider. The
20 m/s path drive confirms 0 contacts in 6,183 poses under both profiles.

### 4.2 Gracia — blocked at two arcs

| profile | blocked samples / 2,571 | arcs |
|---|---:|---|
| `all-visible` | **56** | **2** |
| `roadside` | **0** | none (the 8 on-path colliders are inactive) |

**Arc 1 — 16.406854 … 23.571068 m (7.16 m of path), 4 colliders**

| collider | texture | class | size (m) | dist. to path | blocked samples | max penetration |
|---|---|---|---:|---:|---:|---:|
| `gracia.g150-n292#4.component.001` | `roadwallc_diff` | wall | 56.49 × 1.48 × 1.94 | 2.390 m | 29 | 0.774 m |
| `gracia.g150-n292#53.component.002` | `b43_wire06_diff` | building | 56.59 × 1.54 × 1.91 | 2.994 m | 3 | 0.122 m |
| `gracia.g150-n292#61.component.003` | `tunnelgate_diff` | pipe-structure | 52.18 × 2.20 × 1.79 | 2.969 m | 5 | 0.266 m |
| `gracia.g150-n292#61.component.004` | `tunnelgate_diff` | pipe-structure | 52.24 × 2.20 × 1.86 | 2.807 m | 12 | 0.545 m |

The spawn road is walled on both sides; the measured line runs within
0.84 m of the wall boxes, so the car envelope overlaps them. The wire and gate
components are the same wall/gate cluster.

**Arc 2 — 179.237590 … 185.480231 m (6.24 m of path), 4 colliders**

| collider | texture | class | size (m) | dist. to path | blocked samples | max penetration |
|---|---|---|---:|---:|---:|---:|
| `gracia.g355-n356#7.component.002` | `scene_vehicle_d_diff` | container-vehicle | 4.81 × 1.50 × 0.30 | 0.105 m | 21 | 1.306 m |
| `gracia.g355-n356#7.component.006` | `scene_vehicle_d_diff` | container-vehicle | 4.81 × 1.50 × 0.30 | 0.0015 m | 20 | 1.719 m |
| `gracia.g355-n356#7.component.007` | `scene_vehicle_d_diff` | container-vehicle | 1.61 × 1.50 × 4.16 | 0.105 m | 25 | 2.175 m |
| `gracia.g355-n356#7.component.014` | `scene_vehicle_d_diff` | container-vehicle | 1.74 × 1.50 × 0.63 | 0.105 m | 17 | 0.950 m |

These are **four parked scene vehicles on the measured line** (the texture is a
scene-vehicle atlas). The measured path was derived from draw-covered geometry
before scene props were colliders, so it runs through them. This is real data,
not a resolver failure.

Minimum `roadside` clearance is **0.432364 m** at
`gracia.g355-n356#13.component.006` (arc 179.002 m) — another vehicle-shell
component in the same parked cluster, just outside the blocked set.

The 20 m/s path drive under `all-visible` reports 78 contacts at 41 / 1,876
poses, 9 distinct colliders, arcs 16.667–23.667 m and 179.333–185.333 m,
max penetration 2.175 m. The extra colliders beyond the four `onMeasuredPath`
rows are neighbouring components in the same vehicle cluster that are only
touched after push-out from the first one. Under `roadside` the drive reports
**0 contacts in 1,876 poses**.

No collider is silently removed. The 8 on-path colliders are in the manifest
with geometry, hash, provenance and exclusion arcs.

---

## 5. Committed-resolver tests

The committed resolver (`probes/prop-collision/lib/resolver.mjs`) is used as-is:
2D SAT, positional push-out, zero restitution, Coulomb friction 0.45, fixed
6 iterations, substeps sized to 8 cm of travel (7 substeps at 31 m/s).

| test | Amboy | Gracia |
|---|---|---|
| spawn pose clear (`roadside` / `all-visible`) | yes / yes | yes / yes |
| head-on 31 m/s, isolated, target face | **2/2 stop**, gap 0.001 m, speed 0 | **2/2 stop**, gap 0.001 m, speed 0 |
| head-on max penetration / substeps | 0.0381 m / 7 | 0.0381 m / 7 |
| head-on full manifest, no pass-through | target contacted, blocked by neighbour, 0.844 m short | target contacted, blocked by neighbour, 0.704 m short |
| 5° glance at 20 m/s | 58.28 % speed retained, 1 contact, pen 0.0046 m, residual 0 | 95.70 % retained, 1 contact, pen 0.0031 m, residual 0 |
| 31 m/s no-tunnelling, 8 thinnest | **8/8** | **8/8** |
| path drive 20 m/s, `roadside` | **0 contacts / 6,183 poses** | **0 contacts / 1,876 poses** |
| path drive 20 m/s, `all-visible` | 0 contacts | 78 contacts / 41 poses at the two arcs |
| two-run determinism | identical `sha256:b2bef15c…b88aa` | identical `sha256:a8ca0d75…926e8` |

Targets are chosen deterministically:

- **Amboy head-on:** `amboy.g100-n234#1.component.002` (`complex01_diff`,
  60.09 × 2.65 × 29.47 m, 4.12 m from the path), the largest active footprint
  with a clear 10 m approach on both normal sides.
- **Amboy glance:** `amboy.g105-n234#22.component.002` (`container01_diff`,
  9.44 m long).
- **Gracia head-on:** `gracia.g143-n266#3.component.000` (71.95 × 3.27 ×
  21.27 m).
- **Gracia glance:** `gracia.g127-n276#51.component.000`
  (`sw_town_facade_24a_diff`, 92.41 m long).
- **No-tunnelling:** the 8 active colliders with the smallest footprint
  dimension per map (0.02 m boxes, i.e. inflated thin faces).

The "full manifest" head-on does not stop at the target face: the first contact
is a neighbouring component in the same building cluster, so the car stops
0.70–0.84 m short of the target while still contacting it. That is the honest
cluster result; `passedTarget` is false in both maps.

The Amboy glance retains only 58 % because the 9.4 m container is short and the
car leaves its face; it contacts the target once with 4.6 mm penetration and
ends clear (residual 0). The Gracia 92 m facade is the long-wall slide case
(95.7 %).

---

## 6. Manifest contract and e1 integration

### 6.1 Files

| file | content |
|---|---|
| `_work/map-props/colliders-amboy.json` | 4,026,615 B, `sha256:49996c44…dc1b4b`, content `a8edf42c…f4018d6` |
| `_work/map-props/colliders-gracia.json` | 5,035,790 B, `sha256:040bc96f…c6d5b8a`, content `b3dedf1e…d1694249` |
| `_work/map-props/manifest-amboy.json` | 4,370 B, `sha256:fb5c0f1d…bf7b72` |
| `_work/map-props/manifest-gracia.json` | 4,992 B, `sha256:ca15e4c8…f8e5636` |

Top-level manifest fields: `schema`, `kind:"map-props-colliders"`, `version`,
`variant`, `mapKey`, `level`, `scope`, `carEnvelope`, `region`, `rules`,
`classification`, `inputs`, `path`, `profiles`, `counts`, `coverage`,
`unclassified`, `onMeasuredPath`, `colliders[]`, `excluded[]`,
`contentSha256`.

A collider record is schema-compatible with the P66/P74 resolver:

```json
{
  "id": "gracia.g150-n292#4.component.001",
  "type": "obb",
  "source": "track-visual",
  "center": [x, y, z],
  "axes": [[ux,0,uz],[0,1,0],[vx,0,vz]],
  "half": [hu, hy, hv],
  "size": [2hu, 2hy, 2hv],
  "worldAabb": {"min": [...], "max": [...]},      // OBB AABB, not the raw component AABB
  "vertical": {"bottom","top","height","geometryBottom","geometryTop",
                "groundY","groundExact","groundHits","groundSamplePoint","groundSource",
                "groundOffsetFromRefM","bottomAboveGround","topAboveGround"},
  "classification": "structure|building|unclassified|vehicle|...",
  "structureClass": "building|silo-tank|wall|pole-tower|fence-barrier|container-vehicle|pipe-structure|other",
  "distanceToPath": 2.39,
  "triangles": 20,
  "provenance": {"drawId","section","texture","textureId","indexRange",
                  "componentIndex","componentMin/Max","boxAngleRad",
                  "upRatio","verticalRatio","minimumThicknessInflated","..."},
  "active": false,
  "exclusion": {"rule":"on-measured-path","firstArc":16.4,"lastArc":23.6,"samples":29},
  "hash": "sha256:..."
}
```

`classification` is the committed P74 texture classification used for
comparability; `structureClass` is a diagnostic-only name grouping (documented
regular expressions, never an inclusion rule).

### 6.2 Recommended loading

1. **Per-map manifest.** Load `manifest-<map>.json` first. It carries the
   collider file name, byte size, file SHA-256, content SHA-256, profile names,
   counts and the path record. Verify the hash before upload; refuse to load a
   mismatched file.
2. **Timed/measured line.** Build the resolver world with
   `profile:"roadside"` (the default). The measured path is clear on both maps
   (0/8,673 and 0/2,571). Do not use `all-visible` on the committed lines: it
   closes Gracia at 16.41–23.57 m and 179.24–185.48 m.
3. **`all-visible` is available** in the same file for free roam, and it is the
   honest layer for every visible structure. If it is enabled on the Gracia
   course, the HUD must show that the line is blocked at the two recorded arcs;
   do not silently widen the car envelope or drop colliders.
4. **Explicit exclusions.** The 8 Gracia `active:false` colliders are the
   `onMeasuredPath` rows. If a future task re-measures the path or moves the
   scene vehicles/wall, flip them active (or rebuild with a new path) rather
   than editing the array by hand.
5. **Do not cross-load.** Each manifest covers one map's 40 m band. Amboy's
   props are not in Gracia's file and vice versa.
6. **Record the choice.** Packet/HUD diagnostics must state `map`, manifest file
   hash, content hash, profile and collider count. No silent profile fallback.
7. **Resolver placement.** Keep the engine vehicle state authoritative and apply
   the static resolver as an additive pose/velocity correction after the engine
   tick (P66 recommendation). This task does not change e1-drive.

### 6.3 What is still unclassified / uncovered

- **Natural terrain scenery** (rock ridges, natural barriers, sand, vegetation):
  834 Amboy / 13 Gracia components in the bands, plus everything out of band.
  Not prop colliders by scope.
- **Upper-storey walls and roofs** above `ground + 2.5 m`: 420 / 1,348
  structures. Not separate colliders (true overhead).
- **Diagnostic geometry**: 405 / 953 draws (decal layer, decoder-size, alpha-rule,
  runtime albedo) are not visible opaque geometry in the package and are not
  collider source. Invisible walls were deliberately not created.
- **Out-of-band structures**: 84,190 / 101,139 components outside the 40 m band.
- **Instances** (`instancesApplied:false`, 366 / 2,714 descriptions): still not
  traversed by the render package, so any instance-only structure is not in this
  layer.
- **Low pads** 0.25–0.5 m above ground (58 Amboy, 5 Gracia) are walls in the
  2.5D resolver; there is no climbing/suspension model.
- **No interior collision**: a building is one or more boxes on its visible
  shell; driving through an open doorway into the footprint is not prevented.
- **No renderer, GPU, browser or full-game claim.** There is no screenshot, no
  console capture and no GPU timing.

---

## 7. Verification

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $node probes/map-props/tools/build_colliders.mjs --map all
& $node probes/map-props/tools/resolve.mjs
& $node probes/map-props/tools/measure.mjs
& $py   probes/map-props/tools/map_topdown.py
& $node probes/map-props/tools/verify.mjs
& $node probes/map-props/tools/emit_hashes.mjs
```

`verify.mjs` re-reads every input and re-checks the package pins, validates every
collider (finite numbers, positive half extents, unit/orthogonal axes,
`size == 2 × half`, vertical consistency, OBB AABB containment, region distance,
hash, provenance/index join, exclusion shape), recomputes the blocked samples
and arcs with the committed resolver, re-derives the minimum clearance, runs the
committed `drawComponents()` cross-check on 60+ draws per map, validates the
loader manifests, re-reads the resolver suite, and rebuilds both manifests twice
into temporary directories to compare bytes.

**Result: 233 checks, 0 errors, PASS** (`_work/map-props/verify.json`,
`sha256:b7cbc891…e56ef808`). Rebuild aggregate:
`sha256:df502e3c2b13febdd60f8550290d8cdc2c71b9cacd5112dfd82bc493fefe4c49`
for both builds, identical to the committed artifacts.

Top-down diagnostics: `_work/map-props/map-amboy.png` and
`map-gracia.png` (measured path black, 40 m band grey, all-visible blocked arcs
red, colliders by structure class, on-path colliders purple).

---

## 8. Limits

1. **Visible-mesh approximation**, not retail collision and not
   `Level.levelphysics`. The collision mesh is a ground sampler only.
2. **One OBB per connected component.** A hollow or L-shaped structure is
   over-approximated by one rectangle. Amboy's `complex01_diff` is a 60 × 29 m
   box; a corner of it can be closer to the path than the visible triangles.
3. **40 m region.** Visible structures farther than 40 m are counted but not
   collidable.
4. **The Gracia measured line conflicts with visible props.** 4 wall/gate
   components at 16.41–23.57 m and 4 parked scene vehicles at 179.24–185.48 m.
   They are mapped but inactive under `roadside`; `all-visible` closes the line.
   This is data, not a resolver failure.
5. **Static only.** No moving scene vehicles, opponents, destructibles or
   traffic. The four parked Gracia vehicles are static boxes.
6. **2.5D resolver.** No suspension, tyre forces, climbing, vertical dynamics or
   car-to-car collision. Low pads are walls.
7. **Car envelope** is the documented maximum `2.98 × 1.68 × 1.35 m`, not a
   per-car hull.
8. **No e1-drive integration, no browser, no screenshot, no frame-rate claim.**
9. **Scene-vehicle proxies** are texture-name and geometry boxes, not decoded
   vehicle models with wheels/glass separated.
10. **The map packages themselves** are generated game data under `_work/` and
    are not committed.

---

## 9. Evidence

| path | content |
|---|---|
| `_work/map-props/colliders-amboy.json` | 484 colliders, profiles, coverage, path, excluded rows |
| `_work/map-props/colliders-gracia.json` | 973 colliders, 8 on-path exclusions |
| `_work/map-props/manifest-amboy.json` / `manifest-gracia.json` | loader manifests for e1 |
| `_work/map-props/measure.json` | cross-map measurement report and blocked-arc structures |
| `_work/map-props/resolve.json` | committed-resolver suite, two-run determinism |
| `_work/map-props/verify.json` | 233-check verifier, PASS |
| `_work/map-props/hashes.json` | SHA-256 of every artifact and probe source |
| `_work/map-props/build-summary.json` | build summary |
| `_work/map-props/map-amboy.png` / `map-gracia.png` | top-down diagnostics |
| `_work/logs/map-props/{build,resolve,measure,map,verify,hashes}.log` | run logs |
| `probes/map-props/lib/*.mjs` | loader, path index, component split, ground sampler, builder |
| `probes/map-props/tools/*` | build / resolve / measure / map / verify / hashes |

The task text spells the artifact `collliders-amboy.json` /
`collliders-gracia.json`; the emitted names are the correctly spelled
`colliders-amboy.json` / `colliders-gracia.json`. No other file under
`probes/e1-drive`, `probes/map-slice`, `probes/prop-collision`, `tools/`,
`upstream/` or `game-data/` was modified.
