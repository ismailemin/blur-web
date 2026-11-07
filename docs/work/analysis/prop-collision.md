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

*P74 note: rerunning the same verifier after the P73 level-texture change gives
51/52 because the committed manifest records the pre-P73 geometry hash. All
collider, road, resolver and determinism checks still pass, and
`check_v1_regression.mjs` reproduces the 468/373 collider array byte-for-byte;
see §10.9.*
| 310 m line, default | **0 / 1,245** car poses blocked |
| 310 m line, all-visible | **181 / 1,245** blocked at **4** arcs |
| map | `_work/prop-collision/map.png` |

> **P74 revision (7 November 2026).** The P66/P68 layers were extended for the
> playable PoC. Their region coverage was measurable but incomplete: the lap
> corridor had no visible-prop colliders at all, the free-roam box had pipe and
> rail components excluded as "overhead", and terrain-textured walls could be
> dropped by the material classifier. The V2 manifests and the measurements are
> in **§10**. The committed `colliders.json` / `colliders-r04.json` are not
> modified; V1 derivation is re-checked byte-for-byte in §10.9.

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

---

## 10. P74 — visible-structure coverage in the playable regions

**Date:** 7 November 2026. **Owner:** P74. **Scope:** `probes/prop-collision/**`,
`_work/prop-collision/**`, `_work/logs/prop-collision/**`,
`_work/free-roam-prop/colliders-r04-v2.json` and this document. No change to
`probes/e1-drive/`, `probes/free-roam*`, `asset-reader`, `tools/`, `upstream/`
or `game-data/`.

### 10.1 Result

The playable PoC could drive through visible structures in all three modes. V2
fixes the lap and the reachable free-roam basin, and it fixes every vertical
structure in the 310 m band that is **not already on the measured line**. The
310 m line itself still passes through four prop clusters; making those solid
would close the only committed route, so they remain explicit exclusions under
the `roadside` profile (the same choice P66 documented).

| question | answer |
| --- | --- |
| visible structures with no collider in the three regions (V1) | **1,199 components**, of which **247 are vertical** and **68 are ≥2 m tall** |
| of those, true region-coverage gaps rather than flat/flush/overhead/terrain | **152 components** ("included" in the V1 rule but outside the 30 m course band) |
| no-material components in the playable regions | **0** (the 97 no-material draws are outside the regions) |
| unclassified components in the playable regions | **3 `DefaultColour` components**, all flat horizontal faces in the lap corridor; no vertical unclassified structure |
| lap pass-through groups (V1) | **56 components / 5 draws** — building wall, garage, balcony, no-parking sign, low grey wall |
| free-roam pass-through components (V1, `colliders-r04`) | **6** — 3 concrete pipes (overhead), 2 low grey walls, 1 terrain-face mud component |
| 310 m pass-through components (V1 `roadside`) | **79 vertical components**, 61 of them on the measured line (the four known arcs) |
| after V2: lap / free / 310 | **0 / 2 (not reachable) / 61 on-course exclusions** |
| V2 manifests | **651** colliders (base) and **447** (free-roam), both schema-compatible with P66 |
| resolver | **8/8** candidates solid, **8/8** through-rays blocked, **8/8** no tunnelling, **95.7 %** tangential speed on a 5° glance |
| verification | **45/45** V2 checks, V1 derivation byte-identical (`468/373`, `sha256:8f09d12d…ffd174`) |

No silo or tank geometry exists inside the three playable regions. The large
verticals are concrete pipes, cargo containers, building/garage walls, a
no-parking sign, steel poles, fences and rails. `extractor_diff`,
`pylon01/02`, `crane01`, `channelbridge*` and `decor_hopper` are all outside the
regions (`outOfRegion`).

### 10.2 Regions and inventory

| region | definition | components | vertical (raw) | V1 colliders in the mode manifest | V1 missing in that manifest |
| --- | --- | ---: | ---: | ---: | ---: |
| free box | x −108.5…5.0, z 1027.5…1164.0 | 739 | 259 | 263 (`colliders-r04.json`) | 476 |
| lap corridor | within **8 m** of the 902-point loop-01 polyline | 186 | 56 | 0 (`colliders.json`) | 186 |
| 310 m band | within **30 m** of the 1,245-sample course | 1,126 | 484 | 460 (`colliders.json`) | 666 |
| union | any of the above | **1,659** | **631** | **460** (P66 track components) | **1,199** |

The V1 missing reasons over the union:

| reason | components | note |
| --- | ---: | --- |
| `road-terrain` | 549 | terrain-textured components, most genuinely ground |
| `flat` | 407 | vertical extent < 0.25 m (caps, road paint, slabs) |
| `included` | 152 | would pass the V1 geometry rule but is **outside the 30 m course band** — the region-coverage gap |
| `flush` | 41 | top ≤ ground + 0.20 m |
| `overhead` | 39 | bottom ≥ ground + 1.50 m under V1 |
| `ground-surface` | 11 | pavement/floor textures |
| `no-material` | 0 | none in the three regions |
| `unclassified` | 0 vertical | the 3 `DefaultColour` components are flat |
| `outOfRegion` | 836 (r04 join) | components in the lap/course regions or beyond the free-roam component + 30 m ring; they are not part of the free-roam mode |

The "included" rows are the concrete gap: **96 free-box components and 56 lap
components** were drawn but outside the 30 m course band, so no V1 manifest
covered them. The lap corridor had **zero** mapped colliders.

### 10.3 Pass-through list (draws / ids / positions)

**Lap corridor (`?course=lap`, V1 `colliders.json` `all-visible`)** — 56
vertical components, no collider at all:

| draw | texture | n | height above ground | world AABB x / z | tri | id sample |
| --- | --- | ---: | --- | --- | ---: | --- |
| `river.block59.node265.draw.355` | `b16_wallmaintilesml_diff` | 16 | 4.12–6.25 m | 169.3…196.2 / 1206.2…1242.0 | 68 | `…draw.355.component.000` |
| `river.block64.node209.draw.299` | `b16_btmside04garager_lic_diff` | 12 | 3.78 m | 168.6…186.1 / 1210.8…1231.5 | 24 | `…draw.299.component.009` |
| `river.block71.node209.draw.233` | `b16_btmside04entrancebalc_diff` | 6 | 0.57–1.29 m | 162.6…191.2 / 1203.7…1239.2 | 12 | `…draw.233.component.009` |
| `river.block71.node209.draw.257` | `b41_noparkingsign_diff` | 9 | 1.18–2.46 m | 120.1…121.8 / 1171.2…1173.0 | 44 | `…draw.257.component.000` |
| `river.block71.node209.draw.276` | `greywall_diff` | 13 | 0.70–0.79 m | 119.6…178.6 / 1170.8…1241.8 | 104 | `…draw.276.component.002` |

The building wall is **1.96–2.54 m** from the loop-01 centreline at its closest
(the garage component); the wall `draw.355` is 5.59–7.89 m away. The loop's
recorded collision-wall clearance is 2.06 m, so this is a real visible facade
beside the lap, not an invisible obstacle.

**Free box (`?course=free`, V1 `colliders-r04.json` `all-visible`)** — 6
vertical components:

| draw | texture | n | height | AABB x / z | V1 reason |
| --- | --- | ---: | --- | --- | --- |
| `river.block56.node289.draw.95` | `concretepipe_diff` | 3 | 3.47–3.63 m | −12.1…−3.7 / 1133.5…1144.3 | `overhead` (bottom 1.55–1.71 m) |
| `river.block58.node265.draw.177` | `greywall_diff` | 2 | 0.81–0.84 m | −9.9…8.5 / 1010.5…1033.1 | `included` (outside the r04 ring) |
| `river.block56.node289.draw.137` | `mudfloorbaked01_diff` | 1 | 2.25 m | −10.4…4.4 / 1149.2…1165.0 | `road-terrain` (vertical face) |

The two grey-wall components are inside the free **bbox** but outside the
reachable spawn component + 30 m ring; the free-roam mode cannot reach them.
The base V2 manifest covers them, so they are solid if the base file is loaded.

**310 m band (`?course=310`, V1 `colliders.json` `roadside`)** — 79 vertical
components in 11 draws. The ones that matter:

| draw | texture | n | height | AABB x / z | status |
| --- | --- | ---: | --- | --- | --- |
| `…draw.95` | `concretepipe_diff` | 30 | 0.54–3.63 m | −12.1…−3.7 / 1133.5…1144.3 | on measured line, arc 114.3–121.8 |
| `…draw.96` | `concretepipe_diff` | 8 | 2.20–3.65 m | 62.1…86.5 / 1273.2…1289.3 | V1 overhead; V2 active (not on line) |
| `…draw.143` | `cargocontainer_red` | 4 | 4.19–4.23 m | 71.6…80.4 / 1291.5…1305.9 | V1 overhead; V2 active |
| `…draw.393` | `cargocontainer_green` | 3 | 4.26 m | 4.8…19.6 / 1203.6…1206.0 | V1 overhead; V2 active |
| `…draw.115` | `metalstructure02_diff` | 15 | 0.69–1.98 m | −50.9…−46.1 / 1089.5…1111.0 | on line, arc 52.9–61.1 |
| `…draw.97/99/120` | fences | 9 | 2.00–2.36 m | −4.2…100.9 / 1131.9…1305.6 | partly on line, arc 124.8–127.8 |
| `…draw.119` | `steelpole_diff` | 4 | 1.88–1.88 m | −4.3…7.6 / 1132.1…1145.7 | part of the C03 cluster |
| `…draw.116` | `metalstructure02_diff` | 4 | 0.65–0.72 m | 31.7…32.4 / 1186.7…1187.2 | on line, arc 181.4–206.8 |

V2 adds only **3** new on-course colliders — `draw.115.component.043`,
`draw.95.component.005`, `draw.95.component.008` — all inside the existing four
arcs, so the blocked-arc set does not grow.

### 10.4 Large vertical structures

`_work/prop-collision/large-structures.json` has the full grouped inventory.
The ≥2 m groups in the playable regions:

| draw | section | texture | parts | AABB x / z | height above ground | tri | reachable from |
| --- | --- | --- | ---: | --- | --- | ---: | --- |
| `…draw.95` | `g56-n289` | `concretepipe_diff` | 16 | −12.1…−3.7 / 1133.5…1144.3 | 2.03–3.85 | 276 | free spawn (C03 face), 310 line |
| `…draw.96` | `g56-n289` | `concretepipe_diff` | 17 | 62.1…86.5 / 1273.2…1289.3 | 2.01–3.65 | 328 | 310 course only |
| `…draw.143` | `g56-n289` | `cargocontainer_red` | 14 | −94.6…80.4 / 1142.3…1305.9 | 2.23–4.23 | 28 | free north edge, 310 course |
| `…draw.355` | `g59-n265` | `b16_wallmaintilesml` | 21 | 169.3…196.2 / 1206.2…1242.0 | 4.12–6.25 | 68 | loop-01 |
| `…draw.299` | `g64-n209` | `b16_btmside04garager` | 12 | 168.6…186.1 / 1210.8…1231.5 | 3.78 | 24 | loop-01 |
| `…draw.257` | `g71-n209` | `b41_noparkingsign` | 9 | 120.1…121.8 / 1171.2…1173.0 | 2.40–2.46 | 44 | loop-01 |
| `…draw.270` | `g71-n209` | `steelpole_diff` | 40 | −19.2…1.6 / 1067.4…1072.9 | 2.00–2.29 | 80 | free spawn bowl |
| `…draw.283` | `g71-n209` | `steelpole_diff` | 60 | −13.9…6.6 / 1068.7…1074.7 | 2.01–2.29 | 120 | free spawn bowl |
| `…draw.117` | `g56-n289` | `metalstructure02` | 4 | −94.3…−72.6 / 1154.6…1156.4 | 2.00–2.01 | 8 | free north edge |
| `…draw.98` | `g56-n289` | `constructionfence01` | 58 | 80.8…92.8 / 1283.6…1305.2 | 2.00–2.30 | 116 | 310 course |
| `…draw.120` | `g56-n289` | `woodenfence_diff` | 53 | −3.1…100.9 / 1132.9…1305.6 | 2.03–2.36 | 106 | free neck, 310 course |
| `…draw.171` | `g58-n265` | `steelpole_diff` | 35 | −99.7…−94.2 / 1021.7…1031.5 | 2.60–2.76 | 70 | free west edge |
| `…draw.137/138` | `g56-n289` | `mudfloor` / `offroad` | 3 | −29.9…4.4 / 1149.2…1188.8 | 2.25–4.03 | 7 | free north edge (terrain face) |

### 10.5 V2 build rules

`probes/prop-collision/tools/build_colliders_v2.mjs` calls the committed
`buildColliderManifest()` with V2 options. V1 defaults are unchanged.

1. **Material-independent structures.** A component is no longer dropped
   because its texture name matches a terrain/ground-surface pattern, or
   because it has no material. Terrain/ground-surface textures are excluded
   only when the component geometry is actually ground: area-weighted
   `upRatio ≥ 0.5`, or neither vertical nor horizontal (a slope). A component
   with `verticalRatio ≥ 0.5` and height ≥ 1.0 m is a structure and gets a
   collider. No-material and unclassified components use the geometry rules
   directly (they always did; there are none in these regions).
2. **True overhead only.** V2 uses `overheadClearance = 2.5 m` instead of 1.5 m.
   A pipe or container whose shell starts below 2.5 m is not overhead.
3. **Ground-to-top 2.5D column.** A non-overhead obstacle is collided from the
   local ground to its geometric top, so a pipe whose visible shell starts at
   1.6 m cannot be driven under. The component's geometric vertical bounds are
   kept in `provenance.geometryVertical`; the collision column is
   `vertical.bottom/top`.
4. **Flat/flush are unchanged.** Vertical extent < 0.25 m and top ≤ ground +
   0.20 m are still excluded. A horizontal cap or roof plate is not a wall.
5. **Region union.** The base V2 file covers the 310 m band (30 m), the free
   box and the loop-01 corridor (8 m). The free-roam V2 file is a region
   replacement: P68a reachable component + 30 m ring (`region.json`).

Every collider keeps the P66 schema, `carEnvelope` (2.98 × 1.68 × 1.35 m),
per-collider canonical hash, provenance, `roadside` / `all-visible` profiles
and `onMeasuredCourse` rows. The only added provenance fields are
`region`, `regionDistances`, `textureClassification`, `upRatio`,
`verticalRatio`, `verticalRule` and `geometryVertical`.

### 10.6 Manifest counts

| field | `colliders-v2.json` | `colliders-r04-v2.json` |
| --- | ---: | ---: |
| colliders | **651** | **447** |
| active (`roadside`) | **553** | **371** |
| on measured course | **98** | **76** |
| level instances | 8 | 8 |
| track components | 643 | 439 |
| triangles | 13,793 | 11,768 |
| new vs committed | **+183 / −0** (all mapped) | **+16 / −0** |
| bounds | (−110.38, −1.77, 994.45)…(196.21, 12.76, 1311.26) | (−136.00, −0.95, 984.49)…(79.21, 18.01, 1173.90) |
| file size | 2,012,899 B | 2,854,551 B |
| file SHA-256 | `33488752…751d7` | `b1b8f2c9…18211` |
| content SHA-256 | `73620739…db9ee` | `663e2570…20b38` |

The base file adds 183 colliders relative to the committed P66 file. 152 of
them are the region-coverage gap (free box + lap); the rest are V2 rule changes
(overhead below 2.5 m, ground column, terrain-vertical structures). The
free-roam file adds 16 because most of the free box was already covered by
P68a; the new ones are the pipe/fence/rail components that V1 called overhead
or left outside a cluster.

### 10.7 Measurements

**310 m line**

| manifest / profile | blocked poses / 1,245 | arcs | lateral corridor |
| --- | ---: | --- | --- |
| base V2 `roadside` | **0** | none | ±2.6, ±3.0, ±3.5 m all reachable; min clear offsets 1 at the pinch |
| base V2 `all-visible` | **181** | 52.897–61.131 (33), 114.277–121.763 (30), 124.757–127.751 (13), 181.397–206.847 (22) | ±2.6 m not reachable (15 fully blocked rows) |
| r04 V2 `all-visible` | 78 | 52.9–61.1, 114.3–121.8, 124.8–127.8 | not the timed mode; the 181–207 m props are outside its region |

The tightest `roadside` pose is **0.0657 m** from
`river.block56.node289.draw.99.component.047` at arc ≈127.5 m, a 0.10 × 0.04 m
fence post. The corridor still has a clear 0.2 m offset at every row, but this
is a genuine pinch: a wider car envelope or a line-following controller with
lateral error would contact it. It is not silently closed and it is not
invented as an on-course exclusion.

**Lap (loop-01, 902 samples)**

| manifest / profile | blocked | min clearance | ±5 m band fully blocked rows | min clear offsets |
| --- | ---: | ---: | ---: | ---: |
| base V2 `all-visible` | **0 / 902** | **3.044 m** at `draw.276.component.005` | **0** | 17 / 21 |
| base V2 `roadside` | 0 / 902 | 3.044 m | 0 | 17 / 21 |

The 56 lap components are now solid and the lap remains drivable. The minimum
clearance is 3.044 m at the grey wall on the eastern loop edge; the building
wall is 5.59–7.89 m from the centreline. The ±5 m band keeps at least 17 of 21
0.5 m offsets clear at every sample.

**Free roam**

| quantity | r04 V2 `all-visible` |
| --- | --- |
| spawn pose | clear; **6.165 m** exact polygon distance to `draw.140.component.001` (P68a recorded 5.803 m with its own routine; both clear) |
| free route (121 samples, 135.619 m) | **0 blocked**, min clearance **3.793 m** |
| spawn component | **7,415.00 m²**, one component |
| components / pockets | **6 / 5** |
| pockets | 1,411.5, 59.0, 31.75, 14.5, 1.75 m²; gate widths 3–5 m |
| reachable area | 7,414.25 m²; farthest point (−1.5, 1139.5), 127.673 m geodesic |
| free box coverage | 100 % of reachable component + 30 m ring in the manifest |

The base V2 manifest gives the **same free connectivity** when measured with
the P68 tool through a temporary variant copy: spawn component 7,415.00 m²,
6 components, 5 pockets, route 135.619 m, min prop clearance 3.786 m
(`_work/prop-collision/free-base-v2/props.json`). The base file also contains
the two grey-wall components outside the reachable component; they do not
change the reachable area.

Free-roam connectivity is unchanged from P68b: the C03 construction site still
seals the 1,411.5 m² eastern channel at `(3.0, 1137.25)`, and the two V2
grey-wall segments at z 1010–1033 are outside the reachable component. No new
pocket is created by the V2 pipes.

### 10.8 Resolver tests

`_work/prop-collision/resolve-v2.json`, `profile:"all-visible"`. Eight
candidates cover every pass-through type:

| candidate | label | isolated stops (of 4 cardinal) | full-cluster stop | first contact | gap |
| --- | --- | ---: | --- | --- | ---: |
| `…draw.95.component.004` | concrete pipe, free C03 | 4 / 4 | yes | `…draw.95.component.001` (neighbour) | 11.458 m |
| `…draw.95.component.005` | pipe on 310 line | 4 / 4 | yes | **target** | 0.0014 m |
| `…draw.96.component.004` | pipe, 310 band | 4 / 4 | yes | `…draw.96.component.002` | 0.652 m |
| `…draw.143.component.060` | container wall | 4 / 4 | yes | `…draw.143.component.065` | 0.011 m |
| `…draw.355.component.000` | building wall, loop | 2 / 2 normal | yes | **target** | 0.001 m |
| `…draw.257.component.000` | no-parking sign, loop | 4 / 4 | yes | `…draw.276.component.041` | 1.102 m |
| `…draw.283.component.327` | steel pole, free | 4 / 4 normal | yes | **target** | 0.001 m |
| `…draw.117.component.029` | metalstructure rail | 4 / 4 | yes | `…draw.117.component.035` | 0.0097 m |

- **Head-on at 31 m/s:** candidate-only world **8/8** stop on the near face
  with residual 0 and 7–8 substeps. In the full manifest **8/8** stop without
  passing the target; 3/8 hit the target first, the other 5 hit a neighbour in
  the same C01/C02/C03/cluster and stop 0.65–11.46 m before the target. That is
  the honest cluster result: the visible cluster is solid, and a thin face
  inside it is not the first contact.
- **Four-direction ray at 20 m/s:** **8/8** blocked across the target normal.
  All four directions are blocked for 7/8; the 44 m building wall lets a ray
  along its long axis pass around the end (not through the wall), which is
  reported rather than hidden.
- **No tunnelling at 31 m/s:** **8/8** isolated and **8/8** full-manifest runs
  stay on the start side of the target's near face. The 0.02 m rail is not
  tunnelled; a full-world run can be deflected by a container and reach the
  rail's far side by going around it, recorded as `fullWorldTunnelDeflected`.
- **5° glance along `draw.355`:** **95.7 %** tangential speed retained
  (19.139 / 20 m/s), max penetration **0.114 m**, residual **0**.
- **Determinism:** two complete suites reproduce
  `sha256:ea9bb36a92778012975b117f5c4292c8976c8d95622dd7293ce859f80578696b`;
  the glance replay is identical.

### 10.9 Verification, V1 regression and hashes

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $node probes/prop-collision/tools/build_colliders_v2.mjs
& $node probes/prop-collision/tools/diagnose_gaps.mjs
& $node probes/prop-collision/tools/normal_census.mjs
& $node probes/prop-collision/tools/verify_v2_gaps.mjs
& $node probes/prop-collision/tools/pass_through_list.mjs
& $node probes/prop-collision/tools/measure_v2.mjs
& $node probes/prop-collision/tools/corridor_v2.mjs
& $node probes/prop-collision/tools/resolve_v2.mjs
& $node probes/prop-collision/tools/verify_v2.mjs
& $node probes/prop-collision/tools/check_v1_regression.mjs
& $py   probes/free-roam-prop/tools/build_props.py --manifest _work/free-roam-prop/colliders-r04-v2.json --out _work/prop-collision/free-v2 --no-region
& $py   probes/prop-collision/tools/map_v2.py
```

Recorded: **45/45** V2 checks (`_work/prop-collision/verify-v2.json`). The
gap join reports **0 unresolved** vertical structures in the base region and
**0 unresolved in the free box** for the free-roam file
(`_work/prop-collision/gap-v2.json`).

**V1 regression.** The committed `colliders.json` was derived from geometry
SHA-256 `85a32100…0445`; the current file is `a6453009…1aab` after the P73
level-instance texture work. `check_v1_regression.mjs` rebuilds V1 from the
current file and reproduces the collider array byte-for-byte: 468 colliders,
373 active, `contentSha256:8f09d12d2fcd6ea1…ffd174`. The track-visual geometry
is unchanged. The committed `verify_colliders.mjs` therefore reports **51/52**,
failing only its `geometry input pinned` check against the pre-P73 hash; every
collider, road, resolver and determinism check in it still passes. This is a
stale input pin, not a geometry regression.

| artifact | SHA-256 |
| --- | --- |
| `_work/prop-collision/colliders-v2.json` | `3348875297fdb79699410069548c724840761c61b3386e3d5bbb5974448751d7` |
| `colliders-v2.json` content | `736207391f8efc0457a652c126c7d3beaa51e3a4ca55619be84f2f02be4db9ee` |
| `_work/free-roam-prop/colliders-r04-v2.json` | `b1b8f2c9c833f452c1df98f870b281349a6a29a9db2492462190ccf39fd18211` |
| `colliders-r04-v2.json` content | `663e2570d1949e9bde155ec872e9fccfc09117833b5d3a663a275e686ef20b38` |
| `_work/prop-collision/measure-v2.json` | `941595f5735d9c0abf1c90745cb016de99925a00bb6a57dfc961bb4a09075e29` |
| `_work/prop-collision/resolve-v2.json` | `f238e46671cedf3720899d0a8d88355dc9fe6733cb1c20f5554e08c470f848f3` |
| `_work/prop-collision/gap-v2.json` | `e341a66ca22383fd607af4d9f9b9d6601937d82fd843392bf35468c38ba3cef1` |
| `_work/prop-collision/pass-through-list.json` | `77ee9a9bb4ba47fe2e4069c3f31ce464dc145aa945383e135b5f1ae57794cae3` |
| `_work/prop-collision/corridor-v2.json` | `63a629ba307cf96e125a7ee7635cda769a7af8d56b03fe34841cdf74eafe90d7` |
| `_work/prop-collision/verify-v2.json` | `1ca16f206c568867e3259b5b39773ddd39a869e558138c5cd23d96546b18be1b` |
| `_work/prop-collision/map-v2.png` | `f584df2c938e2d42890b4603bff6926c533e99cedfcf3bc0f31b6314d0f55331` |
| `_work/prop-collision/free-v2/props.json` | `aee2ed9c3b4dcaa988797cb60d27773dbb5d0557dab2d596aa83da7f257d9cd2` |
| `_work/prop-collision/free-v2/route.json` | `dc378488cf73d0a10764f2bf029ef12e87a98da73db63eb951cf1259393aed15` |
| geometry input | `a64530094750503e53e7ddfc74d0a173377bb5bb9b9a77cca3f4da3681021aab` |
| path input | `81eac0ce413075de33e2b3c0e1c077412b35002420b199d9f05d2fdeef230e7f` |
| loops input | `2aabf0cd04fc96b2e2cf903a392fc86fc5b2cd6e85772b9d0e8b523a0826a59c` |
| region input | `669e3ba37b6ba6a88204a8d7d0fc4079fd83d6000275c4bdb7eea5fbf6f1118b` |

Two consecutive V2 builds produced byte-identical manifest files. `_work/
prop-collision/map-v2.png` shows the committed (grey), new base (orange), new
free-roam (red) and on-course-inactive (purple) colliders against the course
(black), loop-01 (blue) and free box (green).

### 10.10 Integration instruction

| mode | manifest | profile | pins |
| --- | --- | --- | --- |
| `?course=310` | `_work/prop-collision/colliders-v2.json` | **`roadside`** (553) | file `33488752…`, content `73620739…` |
| `?course=lap` | `_work/prop-collision/colliders-v2.json` | **`all-visible`** (651) | same file |
| `?course=free` | `_work/free-roam-prop/colliders-r04-v2.json` | **`all-visible`** (447) | file `b1b8f2c9…`, content `663e2570…` |

1. **Timed 310 m course.** Load the base V2 file with `roadside`. The measured
   line remains clear (0/1,245) and a ±2.6 m corridor is reachable. The
   following arcs **must stay excluded** (they are the `onMeasuredCourse` rows
   with `active:false`): **52.897–61.131 m** (C01 metal rack), **114.277–121.763
   m** (C03 concrete pipes), **124.757–127.751 m** (C02 fences), **181.397–
   206.847 m** (C02/C04 rack). Those 98 colliders / 61 vertical components
   cannot be made solid without closing the only committed 310 m line. That is
   the explicit "visible structure cannot be collidable without closing the
   route" case. A future course re-measurement or moving the four clusters
   would remove the conflict; the V2 manifest already contains every collider
   needed for the `all-visible` variant.
2. **Lap.** Load the base V2 file with `all-visible`. The lap is clear
   (0/902, min 3.044 m) and the 56 previously missing lap components are
   solid. Keep the profile and manifest hash in the HUD/packet diagnostics.
3. **Free roam.** Load `colliders-r04-v2.json` with `all-visible`. The spawn is
   clear, the 7,415 m² spawn component and its five pockets are unchanged, and
   the free route is clear. Use the reachable component (not the free box bbox)
   for respawn/containment, as P68a recommended. The two low grey-wall
   components at z 1010–1033 are outside the reachable component; they are
   solid only if the **base** V2 file is loaded, and they are not reachable
   from the free spawn.
4. **Do not cross-load.** `colliders-r04-v2.json` is a region replacement: it
   omits the 310 m props outside the free-roam region (including the 181–207 m
   arc). Do not load it for the timed course. Conversely, the base file does
   not contain the free-roam 30 m ring outside the free box; use the r04 file
   for `?course=free`.
5. **Record the choice.** The packet/HUD must state `manifest`, `profile`,
   file hash, content hash and collider count. Never fall back silently to a
   different profile.
6. **No e1-drive change in this stage.** The page still points at the committed
   files; integration is a separate task. The manifests are additive data and
   the committed files were not overwritten.

### 10.11 Limits

1. **Visible-mesh approximation.** Boxes are fitted to visible connected
   components; they are not retail collision, not `Level.levelphysics`, and
   carry no material/friction semantics. Overlapping boxes in a cluster are
   separate colliders; a thin wall face is a 0.02 m box.
2. **2.5D ground column.** A non-overhead obstacle blocks from the ground to
   its top. This is conservative for low pipes/containers but does not model
   climbing, suspension or vertical dynamics.
3. **Region definitions.** The free box is a bbox, not the reachable
   component; the lap corridor is 8 m from the loop polyline; the 310 band is
   30 m from the course. A structure outside those bands is not covered.
4. **The 310 m conflict is data, not a resolver failure.** 61 vertical
   components remain non-solid under `roadside`; enabling them closes the line
   at four arcs. Do not "fix" this by silently widening the car envelope or
   dropping colliders.
5. **Free-roam coverage is the reachable component + ring.** The two
   grey-wall segments inside the free bbox but outside the component are not
   covered by the free-roam manifest. They are covered by the base manifest.
6. **No engine, browser, screenshot, frame-rate or full-game claim.** The
   resolver is the P66 kinematic prototype. The V2 data is ready to consume;
   the browser integration and a visual gate are a separate task.
7. **One level, one spawn, one lap, one measured course.** No opponents,
   traffic, race rules, audio or multiplayer were exercised.
