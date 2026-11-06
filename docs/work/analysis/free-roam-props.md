# Free-roam prop collision — can `all-visible` be enabled on the spawn basin R04?

**Date:** 6 November 2026
**Owner:** P68a (sub-agent)
**Scope:** `probes/free-roam-prop/**`, `_work/free-roam-prop/**`,
`_work/logs/free-roam-prop/**` and this document. No change to `probes/e1-drive`,
`probes/free-roam`, `probes/prop-collision`, `tools/`, `upstream/` or
`game-data/`. The P65 rasters and the P66 collider manifest are consumed
read-only and pinned by hash. No engine, renderer, browser, vehicle-physics or
playable-game claim is made.

---

## 0. Answer

**Yes — enable `profile:"all-visible"` for `?course=free`, but bound the mode to
the reachable component, not to R04's full mask.** The evidence:

| question | measured answer |
| --- | --- |
| is the committed spawn cell free? | **yes**, and the car rectangle is **5.803 m** from the nearest collider (`draw.140.component.001`) |
| free area on R04 with props, P48 2-cell | **9,042.5 m²** of 9,689.5 m² (93.3 %) |
| is the free area one connected component? | **no — 4 components, 3 pockets** |
| largest / spawn component | **7,702.25 m²** (79.5 % of R04) — it contains the spawn |
| cut-off pocket | **1,321.25 m²** (13.6 %), the eastern channel, x 1.0…104.0, z 1135.0…1293.0 |
| small pockets | 17.25 m² at (−103.2, 1019.6) and 1.75 m² at (−57.3, 1061.1) |
| do the props form a wall? | **one cluster does**: **C03** (concrete pipes, steel poles, construction fences) plugs the neck at **(3.0, 1137.25)**; every other cluster is an isolated obstacle |
| is the wall an artefact of the clearance rule? | **no**: the P48 passable mask minus the prop footprints disconnects the east end even with **zero erosion** (`eastDiameterEndConnectedToSpawn:false`) |
| resolver | spawn clear, head-on stop at gap **0.001 m**, 92.5 % tangential speed on a 5° glance, **0/3** tunnelling through 0.02 m panels, 135.6 m route at 20 m/s with **0 contacts** |
| verification | **25/25** independent checks, resolver **12/12**, two builds byte-identical |
| extended manifest (follow-up) | **431 colliders** over the reachable component + 30 m ring: **100 %** of the reachable basin is now inside the collider region (was 64.6 %), file `_work/free-roam-prop/colliders-r04.json` `sha256:5c7bba74…a49805` |

What this does **not** say: it is a box approximation of visible props on a
0.5 m raster, not retail collision, and no vehicle, engine or browser was run.

> **Revision note (same day, follow-up).** The 35.4 % of the reachable basin
> that lay outside the committed 30 m course band has been closed by an
> extended manifest; see §11. That manifest adds 24 prop records inside R04
> (two new pockets, 90.75 m²) and narrows the reachable component from
> 7,702.25 to 7,415.00 m². It is a *region replacement* for `?course=free`, not
> a superset of P66: the timed 310 m course must keep the committed file.

---

## 1. Question

P66 produced a documented `all-visible` layer of 468 oriented colliders from the
visible E1 props and measured that it blocks the committed 310 m course at four
arcs. P65 measured a 9,689.5 m² car-clearance basin (`R04`) around the committed
spawn `(−88, 1050)` and recommended a free-roam mode on it.

The open question: **can the `all-visible` layer be switched on for
`?course=free` so that trucks/buildings become solid without sealing the
drivable basin?** Answering it needs three measurements — where the car envelope
is blocked, whether the remaining free area is still one component at car width,
and which colliders cause any split — plus a resolver run on the R04 edge cases.

---

## 2. Inputs and provenance

| input | role | bytes / hash |
| --- | --- | --- |
| `_work/free-roam/grid.npz` | P65 rasters `labels_p48`, `height`, `base_pass` | arrays `64a19347…e70c5`, `55378567…d8d56`, `4683403d…ace36` |
| `_work/prop-collision/colliders.json` | P66 manifest, 468 colliders | 1,250,368 B, `sha256:a98fb8eb7e7a6f6851e0c6b5671d40be2c346d0c28a2442df0fe6ab497317af4` |
| `_work/drivable-path/path.json` | P48 310.395 m course | `sha256:81eac0ce…230e7f` |
| `_work/e1-drive/spawn.json` | committed spawn `(−88, 1050)`, heading π/2 | — |
| `probes/prop-collision/lib/resolver.mjs` | P66 resolver, imported unchanged | — |

The builder re-hashes every input at start-up and refuses a changed raster
array, manifest or spawn. Both the builder and the verifier fail hard rather
than falling back.

---

## 3. Model and method

### 3.1 Raster

The same P48 2-cell model as P65: 0.5 m cells, `R04 = labels_p48 == 21`
(38,758 cells = 9,689.5 m², bbox x −108.5…104.0, z 1012.5…1293.0). The crop is
the R04 bounding box padded by 3 cells; a full-grid recomputation of the erosion
matches the crop exactly (`cropErosionMatchesFullGrid:true`).

### 3.2 Prop footprint

For each of the 468 colliders, a cell is marked when

1. its **0.5 m square intersects** the collider's XZ oriented box (2D SAT —
   cell-centre sampling would drop the 293 components that are 0.02 m thick), and
2. the collider's vertical span crosses the cell's
   `[ground, ground + 1.35 m]` car-body band, sampled from the P65 height raster.

Four colliders are entirely above the band and contribute no footprint:
`draw.116.component.043`, `draw.116.component.044`, `draw.96.component.032`,
`draw.96.component.034` — recorded, not silently dropped.

### 3.3 Free mask and the P48 analogue

`free = erode(base_pass AND NOT obstacle, 2 cells)`. The prop obstacle therefore
gets exactly the same **1.0 m clearance** that the P48 mask gives the collision
walls, and `free ⊆ R04`. Sensitivities:

* 3-cell = 1.5 m strict clearance;
* zero extra clearance (`passable AND NOT obstacle`, the footprint only);
* a props-only car-envelope test: the 2.98 × 1.68 m rectangle at the cell centre
  clears every collider in at least one of 24 headings (terrain ignored).

### 3.4 Components, pockets, gates

Components are 8-connected with no corner cutting. A pocket is a component that
does not contain the spawn. The separation between a pocket and the spawn
component is measured by dilating both by `k` cells until they first intersect;
`2k` is the width of the band between them. The clusters are union-find groups
of colliders whose XZ boxes touch within 1 m; their effect is measured by
**ablation** — remove the cluster, rebuild the obstacle mask and the free mask,
and re-measure the spawn component.

### 3.5 Route and resolver

The route is a clearance-weighted 8-connected Dijkstra through the spawn
component (no corner cutting), resampled at 1.0 m with the local tangent
heading, and driven by the P66 resolver with a 20 m/s kinematic follower (8 m
lookahead, 1/60 s steps). Test targets are chosen by marching the car pose until
the **first collider overlap**, so the reported target is the component the car
actually hits — the R04 props are clusters of overlapping boxes, and naming a
component up front would report a gap to a box behind the contact face.

---

## 4. Result: areas

| quantity | value | note |
| --- | ---: | --- |
| R04 (P65, no props) | 9,689.5 m² | 38,758 cells |
| prop footprint inside R04 | **295.5 m²** | 1,182 cells |
| free, P48 2-cell | **9,042.5 m²** | 93.32 % of R04, 36,170 cells |
| lost to props | **647.0 m²** | 295.5 footprint + 351.5 clearance ring |
| free, strict 1.5 m | 8,407.75 m² | 86.8 % |
| free, zero extra clearance | 9,394.0 m² | 96.95 % |
| free, props-only envelope test | 9,224.25 m² | terrain boundary ignored |
| pessimistic disc bound | 718.5 m² blocked | collider + 1.71 m, not a drivable set |

The two independent implementations (builder SAT vs verifier Minkowski +
ray-cast) agree on the obstacle mask and the free mask with **0 cell
mismatches**, so the 9,042.5 m² and the 647.0 m² are not a coding artefact.

### 4.1 Components

| component | cells | area | bbox | enclosed by props? |
| --- | ---: | ---: | --- | --- |
| **spawn** | 30,809 | **7,702.25 m²** | x −108.5…5.0, z 1027.5…1164.0 | — |
| **eastern channel (pocket)** | 5,285 | **1,321.25 m²** | x 1.0…104.0, z 1135.0…1293.0 | no — it is bounded by the basin edge on 981 of 1,090 perimeter cells |
| south-west pocket | 69 | 17.25 m² | x −104.5…−101.0, z 1014.5…1022.5 | no |
| north pocket | 7 | 1.75 m² | x −58.0…−56.5, z 1060.5…1061.5 | no |

**The free area is not one connected component.** At 1.0 m clearance the spawn
keeps **7,702.25 m² (79.5 %)**, and **1,321.25 m² (13.6 %)** of the eastern
channel plus 19.0 m² of slivers are cut off. At the 1.5 m strict clearance the
spawn component is 7,333.25 m² with 4 pockets.

The reachable component is large enough to matter: 7,702.25 m² is **1.8×** a
12 m-wide corridor around the 310 m course (4,207.75 m²), its farthest point from
the spawn is **(−1.5, 1139.5)** at **127.673 m** geodesic, and the P65
`suggestedSpawn` (−66.0, 1108.5) is inside it at 67.613 m.

### 4.2 The P48 course

Every committed 0.25 m course sample, classified against the all-visible mask:

| class | samples | arc |
| --- | ---: | --- |
| reachable | 436 | 0.0 – 124.573 m |
| blocked | 175 | 53.174 – 207.061 m |
| free but in a pocket | **624** | **128.318 – 310.395 m** |
| outside R04 | 10 | — |

So under `all-visible` the committed course is drivable only to arc ≈124.6 m;
half of it (624 of 1,245 samples) lies in the cut-off eastern channel. This is
the same data conflict P66 reported at four arcs, seen from the basin side.

---

## 5. Which colliders block R04, and do they form a wall?

### 5.1 Inventory

179 of the 468 colliders have footprint cells inside R04: **87 active** and
**92 on-course (`active:false`)**; 171 `structure`, 6 `vehicle-sized-wreck`
(`level.instance.00/01/02/04/06/07`), 2 `building-sized`
(`level.instance.03/05`). They form 15 clusters (union-find, boxes touching
within 1 m).

### 5.2 The wall

| cluster | members in R04 | union footprint | arc | removing it |
| --- | ---: | ---: | --- | --- |
| **C03** | 86 (49 active + 37 on-course) | 78 cells / 19.50 m² | 117.9–126.4 m | **spawn 9,066.5 m² (+1,364.25), 3 → 2 pockets** |
| C04 wrecks | 3 | 210 cells / 52.50 m² | 43.7–51.6 m | +107.25 m² |
| C01 metal rack | 28 (all on-course) | 282 cells / 70.50 m² | 63.3–65.0 m | +106.0 m² |
| C05 building + wreck | 2 | 191 cells / 47.75 m² | 26.9–32.6 m | +90.25 m² |
| C06 building + wall | 3 | 113 cells / 28.25 m² | 8.9–12.8 m | +73.0 m² |
| C08 / C07 wrecks | 1 / 1 | 48 / 55 cells | 0 m | +40.25 / +29.0 m² |
| C09–C15 | — | ≤ 17 cells | 111–205 m | 0 – 4.5 m² |

**C03 is the wall.** It is the construction site P66 classified as
`concretepipe_diff` (27 components), `steelpole_diff` (20),
`constructionfence01_diff` (20), `woodenfence_diff` (11) and
`constructionfence03_diff` (8) — heights up to 3.6 m above the ground. Its union
footprint is only 19.5 m² because the boxes overlap heavily, but it sits exactly
in the 7.0 m neck of the basin at **(3.0, 1137.25)** (gate bbox x −0.5…6.5,
z 1133.5…1141.0), where 21 obstacle cells plug the last passage.

**Nothing else is a wall.** The next largest effect is +107.25 m² (three
wrecks), and every other cluster can be driven around. The C01 metal rack is the
largest single obstacle by footprint (70.5 m², 21.7 m long) but removing it
reconnects nothing: the car passes on both sides.

### 5.3 Is the split an artefact of the clearance rule?

No. Ablating the extra clearance entirely — the P48 passable mask minus the prop
footprints, with **zero erosion** — still disconnects the east diameter end from
the spawn (`rawPassableNoErosion.eastDiameterEndConnectedToSpawn:false`). The
narrowest band between the spawn component and the 1,321.25 m² pocket is
**1.0 m** with no extra clearance and **3.0 m** with the P48 clearance, i.e. the
prop footprint itself closes the neck in a 0.5 m raster.

Two honest caveats: a 0.5 m raster cannot resolve a sub-cell slot, and the C03
boxes over-approximate the props (86 components → one cluster of rectangles), so
the real gap between the pipe/fence faces and the terrain may be up to ~2 m —
narrower than a comfortable lane but not zero. The claim is therefore "sealed
in the measured model", not "physically welded".

### 5.4 Roadside does not help

| profile | spawn component | pockets | on-course props solid |
| --- | ---: | ---: | --- |
| `all-visible` (468) | 7,702.25 m² | 3 | yes (all 468) |
| `roadside` (373, = all on-course removed) | 7,825.0 m² (+122.75) | **3** | **no** (95 components) |
| all active props removed | 9,432.5 m² | 0 | — |
| all props removed (= R04) | 9,689.5 m² | 0 | — |

The eastern channel is **also** sealed under `roadside`, by the 49 active
members of C03: removing only the 95 on-course components buys 122.75 m² and
changes nothing about the pocket structure. Choosing the subset would therefore
lose solid pipes/fences (the committed course passes through them at arc
114.3–127.8 m) without re-opening the channel.

---

## 6. Resolver tests (`profile:"all-visible"`)

`resolve_r04.mjs` imports `probes/prop-collision/lib/resolver.mjs` unchanged and
builds the world from the same manifest with `{profile:"all-visible"}`.

| test | recorded result |
| --- | --- |
| spawn clearance | no contact; car rectangle **5.803 m** from `draw.140.component.001`; `resolvePose` residual 0; matches the builder distance to 0.001 m |
| 31 m/s head-on into C03 (`draw.99.component.006`) | stops at **gap 0.001 m** after 39 ticks; max penetration **0.0460 m** (one substep), end penetration 0; 7 substeps; final speed 0; empty-world baseline travels **206.667 m** at 31 m/s |
| 5° glance along the C01 rack | **92.51 %** of the tangential speed retained (18.502 / 20 m/s), max penetration 0.0034 m, end penetration 0 |
| 31 m/s into 0.02 m panels | 3 runs (`draw.115.component.026`, `draw.116.component.026`, `draw.116.component.042`); all 3 contacted, **0 passed** the target plane, max penetration 0.0357 m, final speed 0 |
| route across the basin at 20 m/s | **135.619 m in 394 ticks, 0 contacts, 0 penetration**; min tick clearance 4.282 m (min route-sample clearance 3.786 m); reaches the target |
| determinism | identical head-on, glancing, tunnelling and route state hashes on a second run |

45 thin components were **skipped** as no-tunnelling targets because a thicker
box is the first contact (recorded in `resolver.json.tunnellingSkipped`); the
three that were hit first are 0.02 m panels, the strongest case available in
R04.

Resolver limits: the P66 prototype is a kinematic 2.5D response layer (no
rotation sweep, suspension, tyre forces or vertical dynamics), and box
penetration is bounded by one substep (0.08 m at 31 m/s).

---

## 7. Recommendation

> **Superseded in part by §11.** The profile choice and the mode split stand.
> The manifest and the numeric bound below are the committed-manifest
> measurement; the extended manifest in §11 covers the whole reachable basin and
> gives the bound to ship (**7,415.00 m²**, not 7,702.25 m²).

### 7.1 Profile

**Enable `profile:"all-visible"` for `?course=free`.** It is the honest layer:
every one of the 468 visible-prop colliders becomes solid, and the measured cost
relative to `roadside` is 122.75 m² (1.3 % of R04). The spawn is clear and the
basin's main bowl stays a single 7,702.25 m² component.

### 7.2 Bounds — and what stays reachable

Do **not** use R04's full 9,689.5 m² mask as the free-roam bound. Use the
**spawn component**:

| item | value |
| --- | --- |
| reachable area | **7,702.25 m²** (79.5 % of R04), one component |
| bbox | x **−108.5…5.0**, z **1027.5…1164.0** |
| spawn | `(−88, 1050)` — free, 5.803 m clearance |
| P65 `suggestedSpawn` | `(−66, 1108.5)` — inside, 67.613 m from the spawn |
| farthest reachable point | `(−1.5, 1139.5)`, 127.673 m geodesic from the spawn |
| committed course inside the mode | arc **0 – 124.573 m** only |
| **not reachable** | the eastern channel **1,321.25 m²** (x 1.0…104.0, z 1135.0…1293.0), the east diameter end `(103.5, 1292.5)`, and the 17.25 / 1.75 m² slivers |
| west diameter end | `(−103.5, 1012.5)` is not even a free cell under `all-visible` (C07/C08 wrecks) |

Respawn and out-of-region rules must use this component, not the R04 hull and
not a bbox: the hull contains the pocket.

### 7.3 What is solid

All 468 manifest colliders are solid under `all-visible`. Inside R04 that is 179
colliders: the 6 vehicle-sized wrecks (`level.instance.00/01/02/04/06/07`,
5.386 × 2.219 m), the 2 building-sized props (`level.instance.03/05`,
2.882 × 8.194 m), and 171 structural components — the C01 metal rack, the C02
and C03 pipe/fence sites, the `greybrickwall01` walls, and the roadside clutter.
Four components are above the 1.35 m body band and are not collided.

### 7.4 If the eastern channel must stay drivable

The only lever that works is **moving or removing the C03 construction site**
(pipes, poles, fences at arc 118–126 m). Excluding C03 from the profile buys
1,364.25 m² (9,066.5 m², 93.6 %) but makes 86 visible components up to 3.6 m
tall non-solid, including the concrete pipes the committed 310 m course passes
through. That trades a real, visible wall for a hole; it is not recommended for
a mode that promises "trucks/buildings are solid". A later task could move the
props or cut a gate through the site and re-measure — the pipeline here
(`build_props.py` + `verify_props.py`) would pick up the new manifest directly.

### 7.5 Required follow-up before shipping

> **Done in §11.** The extended manifest `_work/free-roam-prop/colliders-r04.json`
> covers the reachable component + 30 m. Remaining limit: it is a single-region
> manifest for `?course=free`; the timed course keeps the committed file.

The P66 manifest is bounded to **30 m around the measured course**. Inside the
reachable component, **2,726.0 m² (35.4 %)** lies beyond that band, so visible
props there are drawn but are **not** colliders in any profile. Two options:

1. re-run the P66 builder with the region extended from "30 m around the course"
   to "R04 ∪ 30 m" and regenerate the manifest (recommended — it makes the
   "all visible props are solid" claim true for the whole mode), or
2. ship with the hole labelled in the HUD/packet diagnostics: the outer 35.4 %
   of the basin has no prop collision coverage.

### 7.6 Mode split

* `?course=310` keeps `profile:"roadside"` (P66): the 95 on-course components
  (including C02's second rack and C03's pipes at arc 114–128 m) must stay
  non-solid for the timed line.
* `?course=free` uses `profile:"all-visible"`, the reachable component as bound,
  no corridor respawn, no finish gate.
* Record the profile and the bound in the packet/HUD diagnostics, never
  silently.

---

## 8. Limits

1. **Visible-mesh approximation.** Colliders are minimum-area boxes fitted to
   visible components. They are not retail collision, not `Level.levelphysics`,
   and carry no material or surface semantics. Overlapping boxes in a cluster are
   resolved one at a time; the C03 face is a box face.
2. **0.5 m raster.** Whole-cell counts, a cell-square footprint raster, a 5×5
   (Chebyshev) erosion and no corner cutting. A sub-cell slot cannot be resolved;
   the 1.0 m clearance and the 1.5 m sensitivity are models, not a driven lap.
3. **30 m collider region.** 35.4 % of the reachable basin has no collider
   coverage (section 7.5).
4. **Vertical filter is one band.** Colliders are tested against
   `[ground, ground + 1.35 m]` per cell; a car that could climb a prop is not
   modelled.
5. **No engine, no browser, no e1-drive integration.** The resolver is the P66
   kinematic prototype; no screenshot, console or frame-rate claim is made.
6. **No full-game claim.** One basin, one spawn, one prop manifest, one level.

---

## 9. Verification and determinism

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py   probes/free-roam-prop/tools/build_props.py          # committed P66 manifest chain
& $node probes/free-roam-prop/tools/resolve_r04.mjs
& $py   probes/free-roam-prop/tools/verify_props.py
& $py   probes/free-roam-prop/tools/check_determinism.py

# extended manifest chain (same tools, region switched)
& $node probes/free-roam-prop/tools/build_colliders_r04.mjs
& $py   probes/free-roam-prop/tools/build_props.py --manifest _work/free-roam-prop/colliders-r04.json --out _work/free-roam-prop/extended --no-region
& $node probes/free-roam-prop/tools/resolve_r04.mjs --manifest _work/free-roam-prop/colliders-r04.json --dir _work/free-roam-prop/extended
& $py   probes/free-roam-prop/tools/verify_props.py --dir _work/free-roam-prop/extended --manifest _work/free-roam-prop/colliders-r04.json
& $py   probes/free-roam-prop/tools/check_determinism.py --extended
```

`verify_props.py` shares no raster, labelling, distance or component code with
the builder: the footprint is the Minkowski sum of the OBB and the cell square
tested by even-odd ray casting, the erosion is one 5×5 window test, components
are union-find, and clearances use edge-segment distances. It reproduces the
obstacle mask and the free mask with **0 mismatches**, the four component sizes,
the spawn clearance (5.8032 m), the course classification and the C03 ablation
(9,066.50 m²) exactly. **25 checks, 0 failures**
(`_work/free-roam-prop/verify.json`); **29 checks, 0 failures** on the extended
manifest (`_work/free-roam-prop/extended/verify.json`), including a check that
all 29,660 reachable cells lie inside the extended collider region.

`resolve_r04.mjs`: **12 checks, PASS** (`resolver.json`), and **12/12 PASS** on
the extended manifest (`extended/resolver.json`).
`check_determinism.py`: two builds and two resolver runs are identical for both
chains (`determinism.json`, `extended/determinism-extended.json`).

| artifact | sha256 |
| --- | --- |
| `props.json` | `6e14b48d57c89deefaf25311635d40189165b3157b5ca9821c8e9ee4df92d5be` |
| `props.json` canonical | `sha256:7f6b99feeb00917a4f5e03abdd8d4a347d49267dcbe77d1236ddb4677791592f` |
| `route.json` | `e84ac5839b2c3a4cb399b0c3fb79d8407f0354f086eaf517644b2e8962638cfa` |
| `ground.json` | `e4054b06332bfcd89e6408f24895354969f69daa1da5dd0ff9b2f17051612e0d` |
| `map.png` | `00892444041ba2cadcfd12c424e3079e75eea8b1a7b19282923b4015713c9771` |
| `region.json` | `669e3ba37b6ba6a88204a8d7d0fc4079fd83d6000275c4bdb7eea5fbf6f1118b` |
| `mask.npz` content | `b7b1055517c12e9010e40689c4b37e195a8772bae6ece042ed1bd5825e86c91f` |
| `colliders-r04.json` | `5c7bba74fd9c978b4ff9e729287c9a7935d827f4d353c2c918da9d1788a49805` |
| `colliders-r04.json` content | `932e0f871e46b073d359c7a9549477e136fb56e58202b477ebc11fac53915b42` |
| `extended/props.json` | `f3e0446402fc8596cc6a02a3aebda6145ba4e55a2192a78e32ffb6e281adc8a7` |
| `extended/map.png` | `915be59b032943183fc3aea8536e509f24740dc2236acf6698bf1459c37e991b` |
| `extended/mask.npz` content | `a452682dd4db20ca3dd3769e5abe0d74c7b500504a23abc0e9bbd1ba19328163` |
| resolver head-on replay | `sha256:096ddd76b3a35e0f0572b2f853c0a7d1774b3e71f5e3624c38334f551666b2aa` |
| resolver route replay | `sha256:69149175f6c881190864e3dc6a965fe02326049b71cc0ea72f5370e1955a7aab` |

`mask.npz` is hashed by array content; the ZIP container carries timestamps.

---

## 10. Evidence

| path | content |
| --- | --- |
| `_work/free-roam-prop/props.json` | R04, footprint, free areas, components, pockets with gates and adjacent clusters, clusters, ablation, reachability, course classification, sensitivities, route summary |
| `_work/free-roam-prop/route.json` | 121 route samples (x, z, heading, clearance, nearest collider) across the reachable basin |
| `_work/free-roam-prop/ground.json` | 1 m ground lattice for the resolver vertical band |
| `_work/free-roam-prop/mask.npz` | `r04`, `obstacle`, `free2`, `free3`, `fitsSomeHeading`, `anyRotationBlocked`, `labels2` |
| `_work/free-roam-prop/map.png` | top-down: reachable, pocket, clearance-only, prop footprint, course, route, spawn, C03 gate |
| `_work/free-roam-prop/resolver.json` | spawn / head-on / glance / no-tunnelling / route results |
| `_work/free-roam-prop/verify.json` | 25 independent checks |
| `_work/free-roam-prop/hashes.json` | input and output hashes |
| `_work/free-roam-prop/determinism.json` | two-run comparison |
| `_work/free-roam-prop/colliders-r04.json` | extended 431-collider manifest (region: reachable component + 30 m) |
| `_work/free-roam-prop/region.json` | run-length rows of the reachable component used as the extended region |
| `_work/free-roam-prop/extended/` | the same pipeline re-run against the extended manifest (props, mask, route, map, resolver, verify, hashes, determinism) |
| `_work/logs/free-roam-prop/` | build, resolver, verify, determinism logs, including `build-colliders-r04.log` and the `-extended` logs |
| `probes/free-roam-prop/tools/build_props.py` | raster, free mask, components, pockets, clusters, ablation, route, map, region export |
| `probes/free-roam-prop/tools/build_colliders_r04.mjs` | extended manifest: P66 builder + region filter |
| `probes/free-roam-prop/tools/resolve_r04.mjs` | resolver tests on the R04 poses |
| `probes/free-roam-prop/tools/verify_props.py` | independent re-measure |
| `probes/free-roam-prop/tools/check_determinism.py` | determinism gate for both chains |

---

## 11. Extended manifest — closing the 35.4 % coverage gap

### 11.1 Build

The committed P66 builder (`probes/prop-collision/lib/collider-build.mjs` and
`geometry.mjs`) is **imported unchanged and read-only**. The extension is a
wrapper in `probes/free-roam-prop/tools/build_colliders_r04.mjs`:

1. the candidate pass runs `buildColliderManifest(geometry, pathData, {regionDistance: 120})`
   — 120 m around the measured course is a strict superset of the free-roam
   region, because the farthest reachable cell is 81.31 m from the course;
2. a collider is kept when its XZ world AABB is inside the reachable spawn
   component or within **30 m** of it (`region.json`, run-length rows of the
   component, 274 rows / 30,809 cells);
3. every kept record is kept **verbatim**, so the schema, the per-collider
   hashes (431/431 recomputed and equal), the car envelope and the
   `roadside`/`all-visible` semantics are identical to P66;
4. the summary blocks are recomputed for the filtered set: `region`, `counts`,
   `profiles`, `road` (same measured-course conflict rule), `onMeasuredCourse`.

The manifest declares `variant: "free-roam-r04"` and a `region.kind:
"free-roam-component-ring"` that names the committed file it differs from.

### 11.2 Result

| field | value |
| --- | --- |
| file | `_work/free-roam-prop/colliders-r04.json`, 2,590,403 B |
| file sha256 | `5c7bba74fd9c978b4ff9e729287c9a7935d827f4d353c2c918da9d1788a49805` |
| content sha256 (collider array) | `932e0f871e46b073d359c7a9549477e136fb56e58202b477ebc11fac53915b42` |
| colliders | **431** (358 active / 73 on-course) |
| level instances / track components | 8 / 423 |
| triangles | 11,636 (11,238 active) |
| region membership | **62 inside** the reachable component, **369 in the 30 m ring** |
| candidate pass | 1,632 colliders within 120 m of the course; 1,201 outside the region |
| excluded (candidate band) | 4,052 rows: terrain 1,722, flat 1,632, overhead 440, ground-surface 173, flush 85 |
| bounds | (−112.02, 4.21, 984.49) … (79.21, 11.03, 1172.64) |
| blocked course arcs (all-visible) | 3: 52.9–61.1, 114.3–121.8, 124.8–127.8 m |

### 11.3 Coverage before and after

The reference area is the reachable component measured with the committed
manifest, **7,702.25 m²** :

| | covered | uncovered | covered % |
| --- | ---: | ---: | ---: |
| committed P66 manifest (30 m around the course) | 4,976.25 m² | **2,726.0 m²** | 64.6 % |
| extended manifest (component + 30 m) | **7,702.25 m²** | **0.0 m²** | **100 %** |

Under the extended manifest the reachable component itself is **7,415.00 m²**
and it is **100 %** inside the region: the verifier checks every one of the
29,660 reachable cells against `region.json` and finds **0 missing**
(`region.coversReachable`).

The 32.9 % of the extended reachable component that is more than 30 m from the
measured course (35.4 % of the committed one) is now *inside the collider
region* — that distance no longer means "no coverage". It is the reason the
committed manifest missed those props.

### 11.4 What changed

| metric | committed manifest | extended manifest |
| --- | ---: | ---: |
| free, P48 2-cell | 9,042.5 m² | **8,933.5 m²** |
| prop footprint inside R04 | 295.5 m² | **322.5 m²** |
| spawn component | 7,702.25 m² | **7,415.00 m²** |
| components / pockets | 4 / 3 | **6 / 5** |
| pockets | 1,321.25 / 17.25 / 1.75 | **1,411.5 / 59.0 / 31.75 / 14.5 / 1.75** |
| free, strict 1.5 m | 8,407.75 m² | 8,275.00 m² |
| spawn clearance | 5.803 m | 5.803 m |
| route | 135.619 m, 0 contacts | 135.619 m, 0 contacts |

Two effects are mixed in that table and must be separated:

* **New coverage (+24 records inside R04, +27.0 m² footprint).** The extended
  region reaches props the committed one did not:
  `draw.117` — 20 `metalstructure02` rails (21.73 m × 0.02 m, 0.28 m tall) at
  z ≈ 1155.5, x −94.7…−71.7 — and `draw.143` — `cargocontainer_red` walls
  (14.82 × 2.69 m) at z ≈ 1146.5, x −94.5…−79.7. They cut two new pockets,
  **59.0 m²** (x −92.0…−76.0, z 1157.5…1164.0) and **31.75 m²**
  (x −94.5…−85.0, z 1147.0…1153.0), and take the rest of the northern
  clearance strip: the spawn component loses **287.25 m²** net, of which
  90.75 m² is those two pockets and ~196.5 m² is the 1.0 m band along the
  north edge.
* **Region replacement (−41 records inside R04).** The extended region stops
  30 m from the *reachable* component, so props in the far eastern pocket are
  no longer included. The channel pocket grows 1,321.25 → **1,411.5 m²** and
  the 17.25 m² sliver shrinks to 14.5 m². The fourth P66 arc (181.4–206.8 m)
  disappears for the same reason.

The extra 90.75 m² of new pockets have 5.0 m separation bands; they are small
corners behind the rails/containers, not a second basin.

### 11.5 Resolver on the extended manifest

`extended/resolver.json`, same tests, `profile:"all-visible"`, 12/12 PASS:

| test | result |
| --- | --- |
| spawn clearance | **5.803 m**, no contact |
| 31 m/s head-on into `draw.99.component.006` (C03) | stops at gap **0.001 m**, max penetration 0.0460 m, 7 substeps, final speed 0 |
| 5° glance along the C01 rack | **92.51 %** tangential speed retained, max penetration 0.0034 m |
| 31 m/s into 0.02 m panels | **4 runs** (`draw.115.c026`, `draw.143.c072`, `draw.143.c076`, `draw.143.c077`), all contacted, **0 passed**, max penetration 0.0357 m |
| 20 m/s route | **135.619 m in 394 ticks, 0 contacts, 0 penetration**, min tick clearance 4.282 m |
| determinism | identical build file (two runs) and identical replay hashes |

### 11.6 Recommendation for the free-roam mode

| item | value |
| --- | --- |
| manifest to load | **`_work/free-roam-prop/colliders-r04.json`** (`variant:"free-roam-r04"`) |
| profile | **`all-visible`** (431 colliders; `roadside` = 358 if the measured-line rule is ever needed) |
| bounds | the reachable component in `_work/free-roam-prop/extended/props.json`: **7,415.00 m²**, one component, bbox x −108.5…5.0, z 1027.5…1153.5 |
| spawn | `(−88, 1050)`, free, 5.803 m clearance |
| not in the mode | the eastern channel **1,411.5 m²**, the two new pockets **90.75 m²**, the 14.5 / 1.75 m² slivers |
| timed course | keep `?course=310` on the committed `_work/prop-collision/colliders.json` with `roadside`; the extended file does not model the arc 181–207 m props |

### 11.7 Limits that remain

1. **Not a superset of P66.** `colliders-r04.json` is a region replacement for
   the free-roam mode. Loading it for the timed 310 m course would leave the
   props at arc 181.4–206.8 m non-solid, because they are outside the region.
2. **Visible-mesh boxes.** The newly solid north-edge props are 0.02 m rails and
   container walls fitted as rectangles; the 5.0 m gate bands are the measured
   separation between these boxes, so the real gaps may differ.
3. **0.5 m raster / 1.0 m clearance.** The component shrank by 287.25 m², of
   which 90.75 m² is the two new pockets and the rest is the clearance strip
   along the north edge; a finer raster would change the split, not the props.
4. **Ring, not the pocket.** The eastern channel beyond 30 m from the reachable
   component is outside the manifest by design; its props are not colliders.
5. **`excluded[]` covers the 120 m candidate band.** It is a superset of the
   region (no in-region rejection is missing), but the rows carry no position,
   so a consumer cannot filter them to the region.
6. **No engine, browser, e1-drive integration or full-game claim.**
