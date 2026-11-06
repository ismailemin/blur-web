# probes/free-roam-prop — can the P66 prop layer be enabled on the free-roam basin?

Data-only probe on the committed E1 spawn basin (`R04`, `usa_la_river`): rasterise
the P66 `all-visible` colliders over the P65 drivable mask at 0.5 m, measure what
stays reachable at car clearance, identify the colliders that seal the basin, and
run the P66 resolver on the R04 edge cases.

Not a renderer, engine, browser, vehicle-physics or playable-game claim. Nothing
in `probes/e1-drive/`, `probes/free-roam/`, `probes/prop-collision/`, `tools/`,
`upstream/` or `game-data/` is modified; the P65 rasters and the P66 manifest are
consumed read-only and pinned by hash.

**Result:** the spawn cell is free with **5.803 m** clearance. Under
`profile:"all-visible"` the basin does **not** stay one component: the spawn
keeps a **7,702.25 m²** component (79.5 % of R04), and the eastern channel
(**1,321.25 m²**, 13.6 %) becomes a pocket sealed by the **C03 construction
cluster** (concrete pipes / steel poles / construction fences) at the neck
`(3.0, 1137.25)`. The prop footprint alone leaves a **1.0 m** band there, narrower
than the 1.68 m car. Every other cluster is an isolated obstacle the car drives
around (removing one gains at most 107.25 m²).

**Extended manifest (follow-up):** `_work/free-roam-prop/colliders-r04.json`,
431 colliders over the reachable component + 30 m. It covers **100 %** of the
basin (was 64.6 %), adds 24 prop records inside R04 (two new pockets,
90.75 m²) and narrows the reachable component to **7,415.00 m²**. It is a
region replacement for `?course=free`, not a superset of P66.

## Inputs (read-only, pinned)

| input | role | hash |
| --- | --- | --- |
| `_work/free-roam/grid.npz` | P65 rasters (`labels_p48`, `height`, `base_pass`) | arrays `64a19347…`, `55378567…`, `4683403d…` |
| `_work/prop-collision/colliders.json` | P66 manifest, 468 colliders | `a98fb8eb…317af4` |
| `_work/drivable-path/path.json` | P48 310.395 m course | `81eac0ce…230e7f` |
| `_work/e1-drive/spawn.json` | committed spawn `(-88, 1050)` | — |
| `probes/prop-collision/lib/resolver.mjs` | P66 resolver, imported | — |

## Commands

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py   probes/free-roam-prop/tools/build_props.py        # props.json, route.json, ground.json, region.json, mask.npz, map.png
& $node probes/free-roam-prop/tools/resolve_r04.mjs       # 12 resolver checks -> resolver.json
& $py   probes/free-roam-prop/tools/verify_props.py       # 25 independent checks -> verify.json
& $py   probes/free-roam-prop/tools/check_determinism.py  # two builds + two resolver runs -> determinism.json

# extended manifest: P66 builder + a region filter (reachable component + 30 m)
& $node probes/free-roam-prop/tools/build_colliders_r04.mjs   # colliders-r04.json
& $py   probes/free-roam-prop/tools/build_props.py --manifest _work/free-roam-prop/colliders-r04.json --out _work/free-roam-prop/extended --no-region
& $node probes/free-roam-prop/tools/resolve_r04.mjs --manifest _work/free-roam-prop/colliders-r04.json --dir _work/free-roam-prop/extended
& $py   probes/free-roam-prop/tools/verify_props.py --dir _work/free-roam-prop/extended --manifest _work/free-roam-prop/colliders-r04.json
& $py   probes/free-roam-prop/tools/check_determinism.py --extended
```

Outputs go to `_work/free-roam-prop/`, logs to `_work/logs/free-roam-prop/`.
Nothing is committed from `_work/`.

## Model

* **Raster:** the P65 2-cell P48 mask for R04 (`labels_p48 == 21`), 0.5 m cells,
  38,758 cells = 9,689.5 m², bbox x −108.5…104.0, z 1012.5…1293.0.
* **Obstacle:** a cell is marked when its 0.5 m square intersects a collider XZ
  footprint (2D SAT) **and** the collider span crosses that cell's
  `[ground, ground + 1.35 m]` car-body band. Four colliders lie entirely above
  the band and contribute no footprint.
* **Free mask:** `erode(base_pass AND NOT obstacle, 2 cells)` — the same 1.0 m
  clearance the P48 mask gives the collision walls. Sensitivities: 3-cell
  (1.5 m), zero extra clearance, and a props-only car-envelope heading test.
* **Car envelope:** 2.98 × 1.68 × 1.35 m, the documented P66 envelope.
* **Components:** 8-connected, no corner cutting. Pockets are components that do
  not contain the spawn; the gap to the spawn component is measured by dilating
  both until they touch.
* **Route:** clearance-weighted 8-connected Dijkstra (no corner cutting),
  resampled at 1.0 m, then driven by the P66 resolver with a 20 m/s kinematic
  follower (8 m lookahead).

## Results

| metric | value |
| --- | --- |
| R04 area | 9,689.5 m² |
| prop footprint inside R04 | 295.5 m² (1,182 cells) |
| free, P48 2-cell | **9,042.5 m²** (93.3 %) |
| lost to props (footprint + clearance) | 647.0 m² |
| free, strict 1.5 m | 8,407.75 m² |
| free, zero extra clearance | 9,394.0 m² |
| components | 4 (spawn **7,702.25 m²**, pocket **1,321.25 m²**, 17.25 m², 1.75 m²) |
| pockets | **3** — not one connected component |
| spawn clearance | **5.803 m** to `draw.140.component.001` |
| R04 beyond the 30 m collider region | 2,768.5 m² (28.6 %); reachable subset 2,726.0 m² (35.4 %) |
| extended manifest | **431 colliders**, region = reachable component + 30 m |
| extended coverage | **100 %** of the reachable component (0 m² outside the region) |
| extended reachable component | **7,415.00 m²**, 5 pockets (1,411.5 / 59.0 / 31.75 / 14.5 / 1.75) |

### Which colliders block R04

179 colliders have footprint cells inside R04 (87 active, 92 on-course):
171 `structure`, 6 `vehicle-sized-wreck` (`level.instance.00/01/02/04/06/07`),
2 `building-sized` (`level.instance.03/05`). They form 15 clusters; only **C03**
is a wall:

| cluster | members in R04 | union footprint | arc | effect of removing it |
| --- | ---: | ---: | --- | --- |
| **C03** pipes/poles/fences | 86 (49 active + 37 on-course) | 78 cells / 19.50 m² | 117.9–126.4 m | **+1,364.25 m²**, 3 → 2 pockets |
| C04 wrecks | 3 | 210 cells / 52.50 m² | 43.7–51.6 m | +107.25 m² |
| C01 metal rack | 28 (all on-course) | 282 cells / 70.50 m² | 63.3–65.0 m | +106.0 m² |
| C05 building + wreck | 2 | 191 cells / 47.75 m² | 26.9–32.6 m | +90.25 m² |
| C06 building + wall | 3 | 113 cells / 28.25 m² | 8.9–12.8 m | +73.0 m² |
| C08, C07 wrecks | 1 each | 48, 55 cells | 0 m | +40.25, +29.0 m² |
| other 8 clusters | — | ≤ 17 cells | — | 0 – 4.5 m² |

`union footprint` is the union of the cluster's cells inside R04; the sum over
members double counts the overlapping boxes in the rack/pipes clusters.

Removing all 95 on-course components (i.e. the `roadside` profile) gives
7,825 m² and still leaves 3 pockets: the eastern channel is sealed by **active**
props too. Removing all 468 gives back exactly R04 (9,689.5 m², one component).

### Resolver tests (`profile:"all-visible"`)

| test | result |
| --- | --- |
| spawn clearance | 5.803 m, no contact, `resolvePose` residual 0 |
| 31 m/s head-on into `draw.99.component.006` (C03) | stops at gap **0.001 m**, 39 ticks, max penetration 0.046 m, end penetration 0, 7 substeps; empty-world baseline travels 206.667 m |
| 5° glance along the C01 rack | **92.51 %** tangential speed retained (18.50 / 20 m/s), max penetration 0.0034 m |
| 31 m/s into three 0.02 m panels | all 3 contacted, **0 passed** their plane, max penetration 0.0357 m |
| 20 m/s route across the basin | 135.619 m in 394 ticks, **0 contacts**, 0 penetration, min tick clearance 4.282 m |
| deterministic replay | identical head-on, glancing, tunnelling and route hashes on two runs |

## Verification

* `verify_props.py` shares no raster, labelling, distance or component code with
  the builder: Minkowski-sum + even-odd raster, a single 5×5 erosion, union-find
  components, edge-segment distances. **25 checks, 0 failures.** It reproduces
  the obstacle mask and free mask with **0 mismatches**, the component sizes,
  the spawn clearance, the course classification and the C03 ablation exactly.
* `check_determinism.py`: two builds are byte-identical (`props.json`
  `a97e6601…030091a`, `map.png` `00892444…13c9771`, mask content
  `b7b10555…e86c91f`); two resolver runs produce identical replay hashes.

## Limits

* **Visible-mesh boxes.** Colliders are minimum-area boxes fitted to visible
  components (P66), not retail collision and not `Level.levelphysics`. Long or
  L-shaped components are over-approximated by one rectangle; the C03 cluster is
  86 overlapping boxes, so its face is a box face, not a decoded pipe surface.
* **0.5 m raster.** A gap narrower than ~0.5 m can vanish; the reported areas are
  whole cell counts. The 2-cell (1.0 m) clearance and the 3-cell (1.5 m)
  sensitivity are models, not a driven lap.
* **30 m collider region.** The P66 manifest stops 30 m from the course;
  2,726.0 m² (35.4 %) of the reachable basin lies outside it, so visible props
  there are drawn but are not colliders in any profile. That is a hole in the
  layer, stated rather than hidden.
* **No engine, no browser, no e1-drive integration.** Resolver results come from
  the P66 kinematic 2.5D prototype; no screenshot or console claim is made.
* **No full-game claim.** One basin, one spawn, one prop manifest.

## Recommendation (short form)

Enable `profile:"all-visible"` for `?course=free` **bounded to the reachable
component**. Load the extended manifest
`_work/free-roam-prop/colliders-r04.json` (`variant:"free-roam-r04"`), not the
committed one: it is the only file that covers the whole reachable basin. It is
a region replacement, so `?course=310` must keep
`_work/prop-collision/colliders.json` on `roadside`. Treat the eastern channel
(1,411.5 m²) and the two new north-edge pockets (90.75 m²) as out of bounds.
Do not drop C03 to re-open the channel: that would make 86 visible 3.6 m-tall
pipes/poles/fences non-solid. Full reasoning in
`docs/work/analysis/free-roam-props.md`.

## Extended manifest

| | |
| --- | --- |
| file | `_work/free-roam-prop/colliders-r04.json`, 2,590,403 B |
| file sha256 | `5c7bba74fd9c978b4ff9e729287c9a7935d827f4d353c2c918da9d1788a49805` |
| content sha256 | `932e0f871e46b073d359c7a9549477e136fb56e58202b477ebc11fac53915b42` |
| colliders | 431 (358 active / 73 on-course), 8 level + 423 track |
| region | reachable component (30,809 cells / 7,702.25 m²) + 30 m ring |
| membership | 62 inside the component, 369 in the ring |
| coverage | 7,702.25 m² of the reference component covered (100 %), 0 m² uncovered |
| new props inside R04 | 24 records (+27.0 m² footprint): `draw.117` metal rails, `draw.143` cargo containers |
| effect | spawn component 7,702.25 → 7,415.00 m², pockets 3 → 5 |

The wrapper imports `probes/prop-collision/lib/collider-build.mjs` unchanged and
filters the collider array against `region.json`; every kept record keeps its
P66 per-collider hash (431/431 recomputed equal). Blocked course arcs drop from
4 to 3 because the arc 181–207 m props lie outside the region.

## Files

```
probes/free-roam-prop/tools/
  build_props.py        raster, free mask, components, pockets, clusters, ablation, route, map, region
  build_colliders_r04.mjs  extended manifest (P66 builder + region filter)
  resolve_r04.mjs       spawn / head-on / glance / no-tunnelling / route (P66 resolver)
  verify_props.py       independent gate (25 base / 29 extended checks)
  check_determinism.py  two builds + two resolver runs, both chains
_work/free-roam-prop/
  props.json            every measurement and the collider/cluster tables (committed manifest)
  route.json            1 m route samples with headings and clearances
  ground.json           1 m ground lattice for the resolver vertical band
  region.json           run-length rows of the reachable component (extended-manifest region)
  mask.npz              r04 / obstacle / free2 / free3 / fits / anyRotation / labels
  map.png               top-down map: reachable, pocket, blocked, footprints, spawn, route
  colliders-r04.json    extended 431-collider manifest (variant free-roam-r04)
  resolver.json         12 resolver checks
  verify.json           25 independent checks
  hashes.json           input and output hashes
  determinism.json      two-run hash comparison
  extended/             the same pipeline against colliders-r04.json
_work/logs/free-roam-prop/
  build.log, build-colliders-r04.log, build-extended.log, resolver.log,
  resolver-extended.log, verify.log, verify-extended.log, determinism.log,
  determinism-extended.log, session.md
```
