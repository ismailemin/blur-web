# Prop collision — static colliders from visible E1 props

**Date:** 6 November 2026
**Owner:** P66 (sub-agent)
**Scope:** `probes/prop-collision/**`, `_work/prop-collision/**`,
`_work/logs/prop-collision/**` and this document. No change to
`probes/e1-drive/`, `probes/car-parts/`, `probes/car-materials/`,
`probes/drivable-path/`, the engine, tools, `upstream/` or `game-data/`.
**Result: 468 documented oriented colliders derived from the visible E1 props,
a deterministic 52/52 verification gate, and a working 60 Hz car-OBB resolver —
with one measured data conflict: the committed 310 m course passes through four
visible prop clusters, so those 95 components are mapped but inactive in the
default profile.**

---

## 0. Summary

| | |
| --- | --- |
| input geometry | `_work/e1-drive/geometry.json`, **v6**, SHA-256 `85a32100…0445` |
| input course | `_work/drivable-path/path.json`, 310.3952 m, SHA-256 `81eac0ce…0e7f` |
| colliders | **468** OBBs = 8 level instances + 460 track-visual components |
| active default (`roadside`) | **373** colliders / **12,606** triangles |
| mapped, on measured line | **95** colliders / **448** triangles |
| collider bounds | `(-110.38, -1.77, 994.45) … (102.09, 11.03, 1311.26)` |
| manifest | `_work/prop-collision/colliders.json`, 1,250,368 B, `sha256:a98fb8eb…317af4` |
| content hash | `sha256:8f09d12d2fcd6ea1…ffd174` |
| verification | **52 / 52 PASS**, 0 failures (`_work/prop-collision/verify.json`) |
| 310 m line, default | **0 / 1,245** car poses blocked |
| 310 m line, all-visible | **181 / 1,245** blocked at **4** arcs |
| map | `_work/prop-collision/map.png` |

![Prop colliders against the 310 m course](../../../_work/prop-collision/map.png)

*Top-down diagnostic: black is the measured course, green the 6 m gate band,
orange the measured gates, grey the 95 mapped-but-inactive on-course components,
and the coloured boxes the active roadside colliders. Red bars mark the four
arcs where the all-visible profile blocks the line.*

---

## 1. What was asked, and what the data allows

The task asks for a documented static collision layer for visible props
(trucks/buildings/structures) so the car cannot drive through them, while the
310 m road stays drivable. The visible data contains a real conflict between
those two requirements:

- **Visible props exist near the course and can be collided.** 468 oriented
  boxes cover the visible level props and the structural track-visual
  components within 30 m of the measured line.
- **The measured course is not clear of them.** The P48 course was measured on
  `Level.levelphysics` before visible props were colliders. Four prop clusters
  overlap the car envelope on that exact line: a metal rack at **52.90–61.13 m**,
  concrete pipes at **114.28–121.76 m**, construction fences at
  **124.76–127.75 m** and a second metal rack at **181.40–206.85 m**. 181 of
  1,245 centreline poses are blocked, and no lateral corridor exists inside a
  ±6 m band because the long components cross the whole road width.

The response is explicit, not silent:

- the manifest contains **every** mapped visible-prop collider;
- `active:true` (default `roadside`) excludes only the components that overlap
  the measured line;
- `active:false` components carry `exclusion.rule:"on-measured-course"`, their
  first/last blocked arc and sample count;
- the `all-visible` profile includes all 468 and is measured to block the
  committed line;
- the verifier passes both the drivability test under `roadside` and the
  collision tests, and records the all-visible conflict as evidence.

This is a **visible-mesh approximation**, not retail collision and not the
engine's collision mesh. No full-game claim is made.

---

## 2. Inputs and provenance

| input | role | SHA-256 |
| --- | --- | --- |
| `_work/e1-drive/geometry.json` v6 | visible level + track visual + hidden collision surface + car meshes | `85a321000868042a11ccabffeb65feaa16e36d35220f1843ea46b48244eb0445` |
| `_work/drivable-path/path.json` | measured 310.3952 m course, 1,245 samples | `81eac0ce413075de33e2b3c0e1c077412b35002420b199d9f05d2fdeef230e7f` |

`build_colliders.mjs` re-hashes both files, requires geometry version 6 and the
310.395 m course. The manifest records the hashes, byte sizes and course length.

### 2.1 Visible sources

| source | draws | triangles | use |
| --- | ---: | ---: | --- |
| `river.block27.instances-all` | 22 | 10,308 | 8 source instances, world-baked |
| `river.track.visual` | 394 | 57,133 | vertex-connected components |
| `river.collision.surface` | — | 5,933 | ground-height reference only, never a collider |

The 22 level draws are **not** 22 instances: they group by their recorded
`instanceMatrix` into 8 placements (6 vehicle-sized, 2 building-sized). All 22
draws and the source matrix of each placement are recorded in the collider's
provenance.

### 2.2 Excluded sources

| source | reason |
| --- | --- |
| `river.collision.surface` | hidden physics geometry; sampled for ground height only |
| `car.<slug>.body` ×5 | player car, not a prop |
| road/kerb/tarmac/mud/grass/pavement components | terrain class or ground-surface class |
| flat / flush / overhead components | geometry rules below |
| components > 30 m from the course | outside the documented play area |

`rules.excludedMeshes` lists the collision surface and all five car meshes by
mesh id. `excluded[]` lists each rejected component inside the 30 m region with
its draw id, texture, class, size, distance and reason.

---

## 3. Classification

Texture names are classified by explicit pattern sets (the exact JavaScript
regular expressions are in `lib/collider-build.mjs` and the census is in the
manifest):

| class | draws | triangles | distinct textures |
| --- | ---: | ---: | ---: |
| building | 83 | 7,518 | 59 |
| structure | 109 | 28,300 | 43 |
| vehicle | 7 | 1,064 | 2 |
| terrain | 79 | 8,974 | 21 |
| ground-surface | 15 | 1,357 | 4 |
| no-material | 97 | 9,347 | 0 |
| unclassified | 4 | 573 | 2 |

The four unclassified draws are `DefaultColour` (3 draws / 155 tri) and
`greyrocks01_diff` (1 / 418). **None is inside the 30 m region**, so no
unclassified component became a collider; the manifest emits the census and
names them rather than dropping them silently.

The 97 no-material draws are far outside the region (`outOfRegionByClass` counts
4,273 components). The 8 level instances have no material binding at all, so
they are classified by a documented **shape rule**:

| shape | rule | count |
| --- | --- | ---: |
| `vehicle-sized-wreck` | height ≤ 2.1 m and footprint ≤ 40 m² | 6 |
| `building-sized` | height > 2.1 m | 2 |
| `unclassified` | neither | 0 |

The six vehicle-sized props are 5.386 × 1.531 × 2.219 m; the two building-sized
props are 2.882 × 4.719 × 8.194 m. The vehicle-sized prop is the truck/wreck
proxy used by the head-on test; it is a shape class, not a decoded model name.

---

## 4. Collider derivation

### 4.1 Level instances

The source `instanceMatrix` (column-major, recorded by `level_inspect`) provides
the orientation. The builder normalises the three columns, checks orthogonality
and determinant (residual and determinant are stored per collider), projects the
baked world vertices onto the axes, and emits the oriented box. No transform is
invented; the vertices are already world-baked, and the matrix is only the
source placement.

### 4.2 Track-visual components

Each draw is split into vertex-connected triangle components. For each
component:

1. distance from its convex-hull footprint to the measured course polyline;
2. texture classification;
3. vertical extent and local ground height (sampled from the hidden collision
   surface);
4. geometry rules:
   - vertical extent ≥ 0.25 m;
   - top > ground + 0.20 m (not flush);
   - bottom < ground + 1.50 m (not overhead);
5. box fit: **minimum-area enclosing rectangle** over the XZ convex hull
   (rotating calipers), Y from the component extent. Half extents below 1 cm are
   inflated to 1 cm and labelled `minimumThicknessInflated`.

This produces one collider per connected component, not one per draw. A building
can therefore be several boxes (walls, roof, pipes), and a long L-shape is
over-approximated by one rectangle. That is stated in `rules.boxFit` and in the
limits.

### 4.3 Hashes

Every collider has its own `hash` = SHA-256 of the canonical, key-sorted JSON of
that record. `contentSha256` is the SHA-256 of the canonical collider array.
Two independent builder runs produce the **same** file (1,250,368 B,
`sha256:a98fb8eb…317af4`).

---

## 5. Manifest contract

`_work/prop-collision/colliders.json` is `kind:"prop-collision-colliders"`,
`version:1`. Top-level fields:

| field | content |
| --- | --- |
| `scope` | visible-mesh approximation, `retailCollision:false`, `collisionSurfaceUsedAsCollider:false`, `gameClaim:false` |
| `carEnvelope` | 2.98 × 1.68 × 1.35 m and its source note |
| `region` | 30 m from the measured course polyline |
| `rules` | sources, exclusions, excluded mesh ids, inclusion thresholds, box-fit method |
| `classification` | texture census, unclassified textures, unclassified counts |
| `road` | course length/samples, default/all-visible blocked samples, 4 blocked arcs |
| `profiles` | `roadside` (373 active) and `all-visible` (468) |
| `inputs` | paths, SHA-256, byte sizes, geometry version |
| `counts` | totals, active/inactive, classes, triangles, bounds, exclusions, out-of-region census |
| `unclassified` | explicit unclassified collider list (empty) |
| `onMeasuredCourse` | 95 rows: collider id, class, first/last arc, samples |
| `colliders[]` | one OBB record each |
| `excluded[]` | in-region rejected components with reason |
| `contentSha256` | canonical collider-array hash |

A collider record carries:

```json
{
  "id": "river.block56.node289.draw.102.component.005",
  "type": "obb",
  "source": "track-visual",
  "center": [x, y, z],
  "axes": [[...], [...], [...]],
  "half": [hx, hy, hz],
  "size": [sx, sy, sz],
  "worldAabb": { "min": [...], "max": [...] },
  "vertical": { "bottom": ..., "top": ..., "height": ..., "groundY": ...,
                "bottomAboveGround": ..., "topAboveGround": ... },
  "classification": "structure",
  "classificationReason": "texture name matches the structure pattern set",
  "distanceToCourse": 27.01,
  "triangles": 4,
  "provenance": {
    "meshId": "river.track.visual", "drawId": "...",
    "section": ..., "texture": "wall03_diff",
    "drawIndexRange": [...], "drawTriangleRange": [...],
    "componentIndex": 5, "componentTriangles": 4,
    "boxFit": "minimum-area rectangle over the component convex hull in XZ + vertical extent",
    "boxAngleRad": ..., "minimumThicknessInflated": false, "identityWorld": true
  },
  "active": true,
  "hash": "sha256:…"
}
```

An inactive record adds `exclusion: { rule, reason, firstArc, lastArc, samples }`.
A level record's provenance carries the source `instanceMatrix`, the draw ids,
the archived instance bounds and the orthogonality/determinant checks.

---

## 6. Resolver prototype

`lib/resolver.mjs` is standalone ESM with no dependencies.

### 6.1 Geometry and broadphase

- Car OBB: 2.98 m long × 1.68 m wide (documented maximum XT envelope; the
  largest roster wheelbase is 2.981 m), plus a 1.35 m body band for the vertical
  filter. This is a PoC envelope, not a recovered retail hull.
- Collider OBB: `center`, `axes[0]`/`axes[2]` for XZ, `center[1] ± half[1]` for
  the vertical span.
- Deterministic 4 m uniform grid; candidate indices are sorted before use.

### 6.2 Contact and response

- 2D SAT over the four box axes; minimum penetration axis; normal from collider
  to car.
- Positional push-out by `penetration + slop`.
- Normal velocity removed (restitution 0 by default), then Coulomb friction
  (`μ = 0.45`) on the tangential component. Nothing else changes velocity.
- Fixed maximum of 6 contact iterations per substep.

### 6.3 CCD

`substeps = ceil(speed × dt / 0.08 m)`, capped at 64. At 31 m/s and 1/60 s that
is **7 substeps** (8 cm of travel each). The car is 2.98 m long, so even discrete
60 Hz motion would usually overlap a wall; the substeps remove the thin-post
case and make the guarantee explicit. Max overlap observed before push-out is
bounded by one substep (0.0448 m head-on, 0.0662 m into a 0.02 m post), and the
end-of-step pose is always penetration-free.

### 6.4 Determinism

Fixed axis order, sorted broadphase candidates, no hash-map iteration order, no
randomness, and a substep count derived only from the speed. A 120-tick head-on
replay reproduces the same state/contact sequence hash
`sha256:73caedebeaab7d32897ebd6f131afc1245c05c151611b96667c4abdf7bc3f0fa`.

---

## 7. Verification

### 7.1 Commands

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $node probes/prop-collision/tools/build_colliders.mjs    # manifest
& $node probes/prop-collision/tools/verify_colliders.mjs   # 52 checks
& $node probes/prop-collision/tools/probe_road.mjs         # road diagnostics
& $py   probes/prop-collision/tools/map_colliders.py       # map.png
```

Logs: `_work/logs/prop-collision/{build,verify,road-probe,map}.log`.
Evidence: `_work/prop-collision/{colliders.json,verify.json,road-probe.json,map.png}`.

### 7.2 Recorded results

**Manifest and determinism**

- 468 colliders, 373 active, 95 inactive; 13,054 triangles total, 12,606 active.
- Bounds `(-110.38147, -1.765316, 994.45343) … (102.090698, 11.025528, 1311.262451)`;
  active bounds are identical because the level props span the extremes.
- 468/468 collider records pass: finite numbers, positive extents, orthonormal
  axes, hash match, `size == 2 × half`, classification reason and provenance.
- Recomputing the manifest in memory reproduces the collider array byte-for-byte
  and the same content hash `sha256:8f09d12d…ffd174`.
- Two builder runs produce the identical file SHA-256
  `a98fb8eb7e7a6f6851e0c6b5671d40be2c346d0c28a2442df0fe6ab497317af4`.

**Course**

| profile | blocked poses / 1,245 | arcs |
| --- | ---: | --- |
| `roadside` (default) | **0** | none |
| `all-visible` | **181** | 52.90–61.13 m (32 colliders), 114.28–121.76 m (28), 124.76–127.75 m (13), 181.40–206.85 m (22) |

The 6 m gate corridor test (car centre ±2.16 m, 623 rows at 0.5 m) finds at least
one clear pose at every row (minimum 2 of 37 offsets). A 20 m/s kinematic
path-following drive through the active layer completes **310.15 m in 931 ticks
with 0 contacts and 0 penetration**.

**Resolver**

| test | result |
| --- | --- |
| head-on into `level.instance.00` (5.386 m vehicle-sized prop) at 31 m/s | stops at gap **0.001 m**, final speed **0.000 m/s**, max penetration **0.0448 m**, no residual overlap |
| no-collision baseline, same start | travels **155 m** and ends on the far side of the target |
| all-visible head-on into the on-course concrete pipe at arc ~114 m | stops at gap **0.001 m**, no residual overlap; the 95 inactive components are real colliders when enabled |
| glancing along a 44.7 m wall (`draw.102.component.005`) at 5° | **96.1 %** tangential speed retained (19.14 / 19.92 m/s), max penetration **0.0033 m**, no residual overlap |
| 31 m/s into 12 thin (0.02 m) fence components | **11** target contacts, **0** tunnelled, **7** substeps; all 12 no-collision baselines pass through |
| 120-tick deterministic replay | identical hash in both runs |

The head-on target is a level instance with no material binding; it is called a
vehicle-sized wreck/truck proxy, not a decoded truck. The glancing target is a
`wall03_diff` structure, chosen deterministically as the longest active
geometry; it demonstrates slide/friction, not a vehicle-handling result.

### 7.3 Performance (diagnostic only)

4,980 broadphase+SAT queries took **~2.5 ms** in Node (~0.50 µs/query). This is a
prototype measurement, not a browser frame-rate claim.

---

## 8. Limits

1. **Visible-mesh approximation.** Boxes are fitted to visible components; they
   are not retail collision, not `Level.levelphysics` and carry no material,
   friction or surface semantics. A component that is L-shaped or hollow is
   over-approximated by one oriented rectangle.
2. **One collider per connected component.** A building can be several boxes;
   overlapping boxes are resolved one at a time. No compound shape or mesh
   collision is implemented.
3. **30 m region.** Visible props farther than 30 m are counted but not
   collided. Leaving the play area leaves the layer.
4. **The committed course conflicts with visible props.** 95 components are
   mapped but inactive in the default profile. Enabling `all-visible` blocks the
   measured line at four arcs; this needs a new course or moved props, not a
   resolver change.
5. **2.5D kinematic resolver.** No rotational sweep, suspension, tyre forces,
   vertical dynamics or car-to-car collision. Rotation per tick is not swept;
   the car yaw follows the current velocity. It is not a replacement for the
   engine's vehicle physics.
6. **Car envelope is an envelope.** 2.98 × 1.68 × 1.35 m is the documented
   maximum, not a per-car hull. The same box is used for every roster car.
7. **No e1-drive integration and no browser change.** The page, packet, module
   and screenshots are untouched; the map is the only visual evidence.
8. **No full-game claim.** One level, one measured course, one static layer;
   no opponents, traffic, race rules, audio or multiplayer.

---

## 9. Integration recommendation

1. **Consume the manifest as data.** A future `e1-drive` task can read
   `colliders.json`, select `profile:"roadside"` and build the resolver world
   without re-deriving anything.
2. **Run the resolver as an additive layer.** Apply it to the car body pose
   after the engine tick; keep the engine state authoritative and only correct
   pose/velocity when `world.deepestContact(...)` returns a hit. Do not replace
   the vehicle physics.
3. **Keep the profile switch explicit.** `all-visible` is the honest collision
   layer for the visible props; `roadside` is the only profile that keeps the
   committed 310 m line passable. Ship `roadside` until the course is
   re-measured or the four on-course clusters are moved. Record the choice in
   the packet/HUD diagnostics, never silently.
4. **Widen or stream later.** The 30 m region is a PoC bound. If the car can
   leave the measured band, produce colliders for a larger region or a streamed
   set derived from the same visible meshes.
5. **Add a browser gate when integrated.** A visual collision test needs a
   screenshot and a clean console; this task explicitly makes no such claim.

No full-game, retail-collision or retail-handling claim is made.
