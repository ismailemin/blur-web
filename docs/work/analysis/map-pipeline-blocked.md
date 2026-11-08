# Blocked maps: 19-map inventory, C-map proof and Longbeach gap

**Date:** 8 November 2026
**Owner:** MAPC1 (sub-agent)
**Scope:** `probes/map-pipeline/**`, `_work/map-pipeline/**`,
`_work/logs/map-pipeline/**` and this document. No change to `probes/e1-drive`,
`probes/map-slice`, `probes/asset-reader`, `tools/`, `upstream/`, `game-data/` or
the engine. `probes/e1-drive/web/map-registry.js` is read only to determine which
maps are integrated. No renderer, GPU, browser, engine-physics or playable-game
claim is made for any blocked map.

## Result

All 19 levels have collision and draw data. **No blocked map is missing a
drawable stream.** The two C maps are blocked by the committed extractor's chunk
association policy, not by missing data: a read-only extraction that also reads
non-first chunk items and chunks with declared prerequisites recovers
**100 % draw coverage of the measured collision path** on both.

| map | committed draw path | recovered draw path | coverage | verdict |
|---|---:|---:|---:|---|
| `spa_barcelona_bowl_multiplayer` | 0.0 m | **406.889 m** | **1.000** | extractor-limited |
| `usa_la_multiplayer_highrise` | 6.243 m | **208.948 m** | **1.000** | extractor-limited |
| `usa_la_longbeachdocks` | 818.372 m (47.3 %) | **1,730.511 m** | **1.000** | extractor-limited |

The same pass explains Longbeach's 47.3 %: **149 additional direct sections
(606,213 triangles)** exist in chunks the committed extractor skips. The
7,476 skipped instance descriptions are visual props and are **not required for
the drivable path**.

Distance to a working `?map=<id>&script=sprint`:

| distance | maps |
|---:|---|
| 0 items (already playable) | `usa_la_river`, `usa_amboy`, `spa_barcelona_gracia` |
| 2 items | `usa_la_longbeachdocks` (package exists; E1 map entry + verify) |
| 6 items | 12 remaining race/multiplayer B maps (slice, textures, render, layout, E1 map, verify) |
| 7 items | the two C maps (extended extractor + the six above), `showroom` (plus showroom mode) |

**Next three:** `usa_la_longbeachdocks` → `usa_la_observatory` →
`usa_la_downtown`. Brighton and Russian Hill are the low-section-debt
alternates.

## 1. Question and method

The E1 slice drives three maps. This audit answers, for every shipped level:

1. what the committed manifests measure (draws, sections, instances, collision,
   path, grade);
2. the single blocking reason and whether a better **producer** (more data) or a
   better **consumer** (reader/extractor) would fix it;
3. for the two C maps, whether drawable geometry for the measured collision path
   already exists in a stream the repository can parse;
4. what exactly Longbeach is missing;
5. how many distinct engineering items separate each map from a working sprint.

Inputs are read-only: `maps.json`, `inventory.json`, `draw-probes-all.json` /
`draw-probes-extra.json`, `node-inventory.json`, the committed Python level
readers (`render_layout`, `read_render_lists`, `geometry`), the committed native
`level_inspect.exe` output for cross-validation, and the three map-slice render
packages for texture counts. Every measured table field names its source in
`_work/map-pipeline/blocked/inventory-19.json`; the distance item counts are the
engineering model in §6.1, not a measured value.

The audit does **not** claim a frame, a drive, a lap or a retail start line.

## 2. 19-map inventory

`sections` is supported / probed first-RenderList direct sections. `draws/tris`
is the supported draw count / triangle count (not bindable draws). `textures` is
bindable draws / all draws in a committed map-slice render package; `-` means no
package exists for that level, not zero textures in the game data. `instances`
is documented skipped descriptions / sections where a blockers manifest exists,
otherwise the measured first-RenderList instance description count. `recovered`
is the extended-probe coverage, measured for three levels only.

| # | level | kind | grade | playable | collision tris | sections | draws/tris | textures | instances | col path m | draw path m | cover | recovered | items |
|---:|---|---|---|---|---:|---|---|---|---|---:|---:|---:|---:|---:|
| 1 | `spa_barcelona_gracia` | race | B | yes | 113,270 | 88/92 | 3,580 / 550,632 | 2,627/3,580 | 2,714/14 | 627.4 | 624.9 | 0.996 | - | 0 |
| 2 | `usa_amboy` | race | B | yes | 63,708 | 48/75 | 1,606 / 348,948 | 1,201/1,606 | 366/3 | 2,110.8 | 2,060.6 | 0.976 | - | 0 |
| 3 | `usa_la_river` | race | A | yes | 44,244 | 32/46 | 1,117 / 190,386 | - | 9,341 | 365.3 | 246.8 | 0.675 | - | 0 |
| 4 | `usa_la_longbeachdocks` | race | B | no | 25,183 | 74/76 | 1,141 / 537,294 | 1,039/1,141 | 7,476/33 | 1,730.5 | 818.4 | 0.473 | 1.000 | 2 |
| 5 | `usa_la_observatory` | race | B | no | 111,496 | 23/53 | 1,201 / 145,090 | - | 17,399 | 562.3 | 562.4 | 1.000 | - | 6 |
| 6 | `usa_la_downtown` | race | B | no | 118,351 | 109/113 | 2,312 / 329,007 | - | 23,145 | 161.7 | 160.0 | 0.990 | - | 6 |
| 7 | `jpn_mharuna` | race | B | no | 42,038 | 39/73 | 1,783 / 287,783 | - | 22,966 | 417.2 | 345.8 | 0.829 | - | 6 |
| 8 | `usa_sanfran_russianhill` | race | B | no | 32,709 | 41/42 | 1,488 / 255,430 | - | 8,424 | 275.2 | 186.8 | 0.679 | - | 6 |
| 9 | `uk_london_hackney` | race | B | no | 76,820 | 71/82 | 2,659 / 445,853 | - | 12,279 | 1,185.7 | 776.4 | 0.655 | - | 6 |
| 10 | `spa_barcelona_oval` | race | B | no | 39,532 | 31/56 | 1,242 / 233,020 | - | 11,992 | 1,352.1 | 786.1 | 0.581 | - | 6 |
| 11 | `usa_ny_dumbo` | race | B | no | 46,243 | 94/105 | 2,443 / 362,825 | - | 17,017 | 2,373.5 | 1,292.5 | 0.545 | - | 6 |
| 12 | `uk_brighton` | race | B | no | 86,528 | 82/84 | 2,045 / 441,204 | - | 13,851 | 2,007.9 | 975.0 | 0.486 | - | 6 |
| 13 | `usa_sanfran_sausalito` | race | B | no | 93,591 | 65/96 | 1,683 / 452,148 | - | 16,980 | 3,985.6 | 1,046.8 | 0.263 | - | 6 |
| 14 | `jpn_tokyo_shutoko` | race | B | no | 58,330 | 66/70 | 2,709 / 245,466 | - | 10,349 | 1,617.9 | 290.9 | 0.180 | - | 6 |
| 15 | `usa_amboy_multiplayer` | multiplayer | B | no | 22,208 | 10/16 | 148 / 80,778 | - | 687 | 770.8 | 136.1 | 0.177 | - | 6 |
| 16 | `usa_la_downtown_multiplayer` | multiplayer | B | no | 12,706 | 4/4 | 230 / 23,334 | - | 6,046 | 982.1 | 154.9 | 0.158 | - | 6 |
| 17 | `usa_la_multiplayer_highrise` | multiplayer | C | no | 2,522 | 7/7 | 113 / 15,187 | - | 187 | 208.9 | 6.2 | 0.030 | 1.000 | 7 |
| 18 | `showroom` | showroom | B | no | 3,358 | 1/1 | 95 / 7,987 | - | 138 | 116.5 | 116.5 | 1.000 | - | 7 |
| 19 | `spa_barcelona_bowl_multiplayer` | multiplayer | C | no | 4,352 | 3/6 | 128 / 20,646 | - | 114 | 406.9 | 0.0 | 0.000 | 1.000 | 7 |

Two manifest labels need care:

- **Grade is the map-pipeline audit, not integration state.** The audit grades
  only River A and leaves Amboy/Gracia B although both are integrated in
  `map-registry.js`. `playableToday` is therefore read from the registry, and the
  three playable maps are River, Amboy and Gracia.
- **Instance counts are not comparable across rows.** For Amboy/Gracia/Longbeach
  the count is the documented *skipped other-block* set; for other levels it is
  every first-RenderList instance description measured by
  `node_inventory.py`. River's 9,341 is the total measured description count and
  is not a gap by itself; the older River-specific path applies a different
  subset.

## 3. Per-map blocking reason and limiter

### 3.1 Data-limited vs consumer-limited

| category | meaning | examples |
|---|---|---|
| **data-limited** | the information is not in the level files | retail spawn/start line, retail checkpoint/lap rules, prop colliders and race rules |
| **consumer-limited** | the bytes are present and documented; the reader/extractor does not consume them | non-first chunk items, chunks with prerequisites, instances, level material/texture identity, normals, POSITION type 7 |
| **integration-limited** | the data exists and is measured; E1 has no per-map package | layout, map packet, registry entry, verifier, browser check |

No level is data-limited for **drawable road geometry**. Every B level has a
measured draw-covered path ≥ 25 m. The missing retail start line is data-limited
for all 18 non-River maps, which is why every candidate spawn is a derived
endpoint and every course is documented as point-to-point.

### 3.2 The 16 B maps

Of the 16 B-graded maps, `usa_amboy` and `spa_barcelona_gracia` are already
integrated and playable. The other 14 are not. Apart from Longbeach, their single
blocker is **integration**: no committed retail spawn/course and no E1 map
package. The shared secondary gaps are:

- level material/texture binding is not applied by map-pipeline; only the three
  map-slice packages have a binding split;
- `instancesApplied:false`; instance-only geometry can add or change surfaces;
- unsupported first-RenderList sections are visual gaps under the measured
  coverage, not proof that the road is missing. For example Observatory is
  100 % covered with 23/53 sections supported, while Amboy is 97.6 % covered
  with 48/75 supported.

Per-level additional facts:

| level | sections unsupported | notable |
|---|---:|---|
| `usa_la_longbeachdocks` | 2 | package exists; full coverage recoverable; see §5 |
| `usa_la_observatory` | 30 | 100 % coverage already; large terrain mesh (111k tri) |
| `usa_la_downtown` | 4 | 99.0 % coverage but only 160 m path |
| `jpn_mharuna` | 34 | 82.9 % coverage; 42k tri |
| `usa_sanfran_russianhill` | 1 | lowest section debt; 186.8 m path |
| `uk_london_hackney` | 11 | 776.4 m path; 76.8k tri |
| `spa_barcelona_oval` | 25 | 786.1 m; simple oval; 39.5k tri |
| `usa_ny_dumbo` | 11 | 1,292.5 m; 46.2k tri |
| `uk_brighton` | 2 | 975.0 m; 86.5k tri; low section debt |
| `usa_sanfran_sausalito` | 31 | longest collision path (3,985.6 m) but 26.3 % coverage |
| `jpn_tokyo_shutoko` | 4 | 290.9 m; 18.0 % coverage |
| `usa_amboy_multiplayer` | 6 | 136.1 m; 22.2k tri |
| `usa_la_downtown_multiplayer` | 0 | all 4 sections readable; only 154.9 m covered |
| `showroom` | 0 | not a race; needs a showroom mode, not a sprint |

### 3.3 The two C maps

The committed classification rule is “no draw-covered collision path ≥ 25 m”.
Both maps meet it. The cause is not the data:

- the extractor only associates a node's declared block with a chunk when that
  block is the **first item** of a chunk and the chunk has **no prerequisites**;
- the native direct reader (`selected_chunk`) enforces the same two conditions;
- both levels reference the road geometry through **non-first items** and/or
  chunks that declare prerequisites.

The committed C grade is retained because the committed extraction has not been
changed. The measured recoverable class is B.

## 4. C-map proof

### 4.1 Method

`probes/map-pipeline/tools/c_map_probe.py`:

1. enumerates every first-RenderList node chunk, not only the committed
   correlated pairs;
2. for every declared geometry block, finds its unique LOD0 stream item in the
   Scene `ChunkInfo`;
3. walks stream items with the committed item framing (VB list, IB list, node
   list, texture list), including non-first items and chunks with prerequisites;
4. decodes geometry with the committed Python `geometry()` reference (the same
   primitive/declaration/LOD logic used by the native reader);
5. cross-checks every section that the committed extractor already staged
   against `native.json` — positions and indices must be byte-identical;
6. runs the committed 0.25 m coverage rule (collision passable + declared draw
   triangle within 0.5 m), plus a stricter up-facing-only view, and measures the
   largest draw-covered collision component.

Prerequisites are **not applied** (no extra texture/source resolution); they are
only used to locate the geometry item. This is a geometry proof, not a material
proof.

### 4.2 Results

| measure | bowl | highrise |
|---|---:|---:|
| committed draw-covered path | 0.000 m | 6.243 m |
| recovered draw-covered path | **406.889 m** | **208.948 m** |
| collision path (diameter) | 406.889 m | 208.948 m |
| recovered / collision | **100 %** | **100 %** |
| recovered sections | 25 | 45 |
| recovered triangles | 185,267 | 161,464 |
| recovered vertices | 313,655 | 179,992 |
| recovered draws | 899 | 912 |
| new sections vs committed | 22 | 38 |
| new triangles vs committed | 164,621 | 146,277 |
| coverage, all triangles | 1.000 | 1.000 |
| coverage, up-facing only | 1.000 | 1.000 |
| covered passable cells | 19,494 / 19,494 | 19,179 / 19,196 |
| native cross-validation | 3/3 sections, byte-identical | 7/7 sections, byte-identical |
| component endpoints | (49,445) → (22,373) | (242,−159) → (342,−290) |

The recovered component endpoints equal the collision diameter endpoints
exactly, so this is the same drivable component, not a different patch.

### 4.3 Byte evidence

The geometry is in chunks the committed extractor skips. Offsets and sizes are
from the levelrender Scene `ChunkInfo`; item indices are zero-based within the
chunk.

**Bowl** — node chunk 1 (block 27, 136 primitives) declares blocks 15, 18 and 26:

| block | chunk | item | first item | chunk offset | stored bytes | row prerequisites |
|---|---:|---:|---|---:|---:|---|
| 26 | 11 | 2 | no | 7,376,896 | 1,441,792 | `[10, 9]` |
| 18 | 12 | 1 | no | 8,818,688 | 1,605,632 | `[10, 11, 9]` |
| 15 | 24 | 0 | yes | 21,970,944 | 878,592 | `[5, 13, 12, 22, 23]` |

**Highrise** — node chunk 20 (block 63, 168 primitives) declares blocks 7, 10,
11, 14 and 15; it also declares blocks 1 and 2, which have no LOD0 item. Nodes 22
and 24 add the rest:

| block | chunk | item | first item | chunk offset | stored bytes | row prerequisites |
|---|---:|---:|---|---:|---:|---|
| 7 | 51 | 0 | yes | 22,679,552 | 1,011,712 | `[50]` |
| 10 | 47 | 0 | yes | 18,569,216 | 1,183,744 | `[46, 44, 45]` |
| 11 | 51 | 1 | no | 22,679,552 | 1,011,712 | `[50]` |
| 14 | 47 | 1 | no | 18,569,216 | 1,183,744 | `[46, 44, 45]` |
| 15 | 44 | 0 | yes | 16,009,216 | 956,416 | `[32, 31, 35]` |

The committed corridor extractor reports `missingOrAmbiguousGeometry` for these
references because `geometry_records` is keyed by the **first item's block**
only, and the native `selected_chunk` refuses the prerequisite chunks. The bytes
are present; no new stream or format is needed.

### 4.4 Verdict

**Renderer/extractor-limited, not data-limited.** A consumer change — associate
every LOD0 item, not only the first, and read the geometry item of a chunk with
declared prerequisites — recovers a complete drivable draw path on both maps
without touching game data. It does not require the 3 unsupported bowl sections
or the 5 plane-like highrise sections.

## 5. Longbeach gap list

### 5.1 What the committed package has

- 74/76 first-RenderList sections supported, 1,141 draws, 537,294 triangles;
- 1,039 bindable draws / 511,782 bindable triangles, 164 texture blobs;
- measured draw-covered path 818.372 m = 47.3 % of the 1,730.511 m collision
  diameter;
- 2 unsupported sections (POSITION type 7);
- 33 skipped instance sections with 7,476 descriptions.

### 5.2 Missing drawable direct sections

The extended pass finds **223 unique sections, 1,143,507 triangles** and a
**1,730.511 m** draw-covered component covering **100 %** of the collision
diameter. Compared with the committed 74 sections / 537,294 triangles:

| measure | value |
|---|---:|
| new sections | **149** |
| new triangles | **606,213** |
| new vertices | 891,754 |
| new draws | 2,469 |
| new sections that are non-first items | 134 |
| new sections in chunks with prerequisites | 64 |
| native cross-validation of committed sections | 74/74 byte-identical |

The largest new sections (node → block → chunk/item → triangles):

| node | block | chunk/item | triangles |
|---:|---:|---|---:|
| 25 | 114 | 157/1 | 9,872 |
| 39 | 124 | 153/2 | 9,854 |
| 69 | 158 | 155/0 | 9,832 |
| 82 | 207 | 158/4 | 9,722 |
| 86 | 130 | 141/1 | 9,645 |
| 55 | 68 | 138/1 | 9,420 |
| 54 | 175 | 175/1 | 9,372 |
| 84 | 169 | 200/1 | 9,224 |
| 66 | 94 | 174/1 | 9,186 |
| 88 | 194 | 90/1 | 9,128 |

The full 149-row list with offsets, prerequisites, hashes and bounds is
`_work/map-pipeline/usa_la_longbeachdocks-probe/probe.json`.

The missing **912.139 m** of committed route is therefore drawn by direct
geometry in skipped sections. It is not instance-only and not absent.

### 5.3 The 2 unsupported sections

Both stop on POSITION0 `type=7`, `method=0`; neither carries drivable road under
the measured coverage.

| id | geometry/node block | native byte offset | in-scope primitives | triangles decoded | effect |
|---|---|---:|---:|---:|---|
| `g199-n346` | 199 / 346 | 362,668 | 1 | 0 | `FoliageBillBoard_LN` |
| `g204-n418` | 204 / 418 | 241,712 | 18 | 0 | `LightFlare_LN` |

These are a geometry-reader gap (POSITION type 7), not a missing texture stream:
both resolve a static albedo on the texture side.

### 5.4 What the 7,476 instances add

From the committed blockers manifest:

| measure | value |
|---|---:|
| sections | 33 |
| instance descriptions | 7,476 |
| static albedo resolved | 7,476 / 7,476 |
| UV0 declaration present | 7,476 / 7,476 |
| referenced geometry blocks | 588 (all available) |
| first-item-of-record blocks | 116 |
| upper-bound LOD0 triangles | 5,948,518 |
| bundled prerequisite errors | 29 / 33 |

They add docks props and props with static albedo/UV0 already resolved. They
**do not add the missing road**: the direct extended pass covers 100 % of the
collision path without applying a single instance. They are visual/completeness
work, plus 10 `InstancedTriangleMesh` collision shapes that are excluded from the
static collision package. For a drivable 818 m sprint, the committed package is
already sufficient; for a full 1,730 m course, the **149 direct sections** are
the requirement, not the instances.

### 5.5 Verdict

Longbeach is **not** a 47.3 % data package. It is a 47.3 % *extraction-policy*
package with a valid 818 m sprint today. The full course needs one consumer
change (non-first items + prerequisite chunks) and the existing texture/render
pipeline; instances are optional visual work.

## 6. Distance to playable and the next three

### 6.1 Item model

A “distinct engineering item” is a concrete step, not a day estimate:

1. **extended-extractor** — associate all LOD0 chunk items and read geometry
   from chunks with declared prerequisites (one producer change);
2. **slice-package** — `extract_slice.py` + `verify_slice.py` for the level;
3. **texture-bindings** — material/albedo/UV0 binding split + decoded RGBA;
4. **render-package** — opaque draw list + texture blobs + upload contract;
5. **layout** — measured spawn/checkpoints/finish from the covered path;
6. **e1-map-package** — `MAP_BUILDS` entry, `map.json`, registry id/courses/pins;
7. **e1-verify-browser** — `verify_e1_drive.mjs` + browser screenshot and clean
   console;
8. **showroom-mode** — a non-race presentation mode (showroom only).

The primary ordering is the item count. Ties are broken by committed/recovered
draw coverage, then unsupported sections, then collision triangles.

### 6.2 Ranking

| rank | level | items | coverage used | unsupported sections | collision tris |
|---:|---|---:|---:|---:|---:|
| 1 | `spa_barcelona_gracia` | 0 | 0.996 (playable) | 4 | 113,270 |
| 2 | `usa_amboy` | 0 | 0.976 (playable) | 27 | 63,708 |
| 3 | `usa_la_river` | 0 | 0.675 (playable) | 14 | 44,244 |
| 4 | `usa_la_longbeachdocks` | 2 | 1.000 recovered | 2 | 25,183 |
| 5 | `usa_la_observatory` | 6 | 1.000 committed | 30 | 111,496 |
| 6 | `usa_la_downtown` | 6 | 0.990 committed | 4 | 118,351 |
| 7 | `jpn_mharuna` | 6 | 0.829 | 34 | 42,038 |
| 8 | `usa_sanfran_russianhill` | 6 | 0.679 | 1 | 32,709 |
| 9 | `uk_london_hackney` | 6 | 0.655 | 11 | 76,820 |
| 10 | `spa_barcelona_oval` | 6 | 0.581 | 25 | 39,532 |
| 11 | `usa_ny_dumbo` | 6 | 0.545 | 11 | 46,243 |
| 12 | `uk_brighton` | 6 | 0.486 | 2 | 86,528 |
| 13 | `usa_sanfran_sausalito` | 6 | 0.263 | 31 | 93,591 |
| 14 | `jpn_tokyo_shutoko` | 6 | 0.180 | 4 | 58,330 |
| 15 | `usa_amboy_multiplayer` | 6 | 0.177 | 6 | 22,208 |
| 16 | `usa_la_downtown_multiplayer` | 6 | 0.158 | 0 | 12,706 |
| 17 | `usa_la_multiplayer_highrise` | 7 | 1.000 recovered | 0 | 2,522 |
| 18 | `showroom` | 7 | 1.000 | 0 | 3,358 |
| 19 | `spa_barcelona_bowl_multiplayer` | 7 | 1.000 recovered | 3 | 4,352 |

The C maps rank below all B maps only because they need the extra extractor
item. Their recovered coverage is complete. Showroom is seventh-item work because
it is not a sprint map.

### 6.3 Next three

**1. `usa_la_longbeachdocks` — 2 items.** The slice, texture and render packages
exist and pass their verifiers. Concrete steps:
1. add a `longbeach` `MAP_BUILDS` entry and build `_work/e1-drive/longbeach/map.json`
   + `layout.json` from the committed packages;
2. add the registry id/course/pins and run `verify_e1_drive.mjs`, then capture a
   browser screenshot with a clean console.
Optional third item: consume the 149 new direct sections to extend the course
from 818 m to 1,730 m. Do not gate the first sprint on this.

**2. `usa_la_observatory` — 6 items.** Best committed coverage (100 %) and a
562 m path. Steps: slice package → texture bindings → render package → layout →
E1 map package/registry → verifier/browser. The 30 unsupported sections are
visual-only under the measured coverage; fix them after the sprint works.

**3. `usa_la_downtown` — 6 items.** 99.0 % coverage and only 4 unsupported
sections, but a short 160 m path. Same six steps. Prefer it over Brighton when
section-debt risk matters more than route length.

Alternates: `uk_brighton` (975 m, 2 unsupported) and
`usa_sanfran_russianhill` (186.8 m, 1 unsupported) are the lowest-section-debt
B maps; `spa_barcelona_oval` is the best simple oval (786 m) but has 25
unsupported sections.

## 7. Verification

`python probes/map-pipeline/tools/verify_blocked.py` →
**PASS, 897 checks, 0 failures**.

The verifier independently:

- re-parses all 19 `Level.levelphysics` files and re-extracts every static
  triangle, comparing counts and bounds;
- re-hashes the four level files per map;
- reconciles every inventory row with `maps.json`, `inventory.json`,
  `draw-probes-all.json`/`draw-probes-extra.json` and `node-inventory.json`;
- recomputes the A/B/C rule and the playable flag from the registry;
- re-reads every path/covered artifact and its pinned samples/bbox;
- re-sums the three extended probes, checks 100 % coverage, the recovered
  component endpoints, and every native byte-identity validation;
- re-checks the Longbeach gap: 2 unsupported ids and byte offsets, 33 instance
  sections, 7,476 descriptions, 5,948,518 upper-bound triangles, 588 blocks,
  116 first-item blocks, 29 prerequisite errors, 149 new sections / 606,213
  triangles.

Determinism: the three probes, `inventory-19.json` and `verify.json` were rebuilt
and compared byte-for-byte (hashes in §9).

### 7.1 Manifest drift found (not changed here)

`maps.json` `pathArtifact.sha256` does not match the current
`_work/map-pipeline/paths/<level>.json` bytes for any of the 19 levels, while
the sample count and bbox do match. The inventory records both the declared hash
and the actual hash (`pathArtifact.declaredSha256` / `actualSha256`); the
verifier checks the actual hash and the sample/bbox agreement instead of
repeating the stale pin. This is pre-existing manifest drift, not a change made
by this task.

## 8. Limits

1. **No renderer, GPU, browser or frame.** Coverage is a geometric test of
   declared draw triangles against the collision surface, not a rendered image.
2. **Draw scope is first RenderList direct LOD0 only.** Instance descriptions
   are not applied; instance-only geometry can add or change surfaces.
3. **The extended probe covers three levels only** (Longbeach, highrise, bowl).
   Other B maps may also have recoverable coverage; this document reports their
   committed coverage and does not claim a recovered value.
4. **The item walker reads chunks with declared prerequisites without applying
   the prerequisite resources.** It uses them only to locate the geometry item.
   No material, texture LOD, sampler or shader state is resolved.
5. **No POSITION type-7 decode.** The 2 Longbeach, 4 Gracia and 3 bowl sections
   that use it remain unsupported.
6. **1 m collision audit grid, 0.5 m vertical coverage tolerance, three lateral
   stations (0, ±1 m).** This is coarser than the 0.25 m committed course proof.
7. **Spawn/course is derived, not retail.** No level file contains a spawn
   record; all candidate spawns are path endpoints and all courses are
   point-to-point, not laps.
8. **No materials, textures, normals, culling or GPU state** are applied by this
   probe. Texture counts come from the three committed map-slice packages only.
9. **No full-game claim.** Three maps are playable in E1; this document adds
   evidence for the next wave, not a playable map.

## 9. Evidence and hashes

| path | content |
|---|---|
| `_work/map-pipeline/blocked/inventory-19.json` | ranked 19-map inventory with source references |
| `_work/map-pipeline/blocked/verify.json` | 897-check deterministic verifier |
| `_work/map-pipeline/node-inventory.json` | per-level node/instance counts and skipped block refs |
| `_work/map-pipeline/usa_la_longbeachdocks-probe/` | 223-section extraction, coverage, package prototype |
| `_work/map-pipeline/spa_barcelona_bowl_multiplayer-probe/` | 25-section extraction, coverage, package prototype |
| `_work/map-pipeline/usa_la_multiplayer_highrise-probe/` | 45-section extraction, coverage, package prototype |
| `_work/logs/map-pipeline/*-probe.log` | extraction logs |
| `_work/logs/map-pipeline/node-inventory.log` | node/instance scan |
| `_work/logs/map-pipeline/blocked-inventory.log` | inventory build |
| `probes/map-pipeline/tools/c_map_probe.py` | read-only extended extraction |
| `probes/map-pipeline/tools/node_inventory.py` | node/instance inventory |
| `probes/map-pipeline/tools/blocked_inventory.py` | inventory merge/rank |
| `probes/map-pipeline/tools/verify_blocked.py` | independent verifier |

Hashes are recorded after the final deterministic rebuild in
`_work/map-pipeline/blocked/hashes.json`. The probe package prototypes contain
`draws.positions.f32.bin` and `draws.indices.u32.bin` plus `probe.json`; they are
generated game-derived data and are not committed.

| artifact | SHA-256 |
|---|---|
| `blocked/inventory-19.json` | `2ad5a60c0498a04669052b55f30a8be9df670635dbcc8da9630a6130259b44a1` |
| `blocked/verify.json` | `ab771927434b1860a87726f32f7a858fc278cf7542b94acef65a9eb2e1f7d486` |
| `node-inventory.json` | `01d354b42275c2dd1798f29d31fb01eec132da82d42bd6c8a66f75d6c5d9cce8` |
| `maps.json` (input) | `40878a997c7411c27bb8edbdaf091d3fe1bbf33b8d7b25224dd54d881f16e0ea` |
| `inventory.json` (input) | `6ed6b1c2fa0590d6abce567c27b030eb93704e7f0c29eb22022644ed93bf96bd` |
| `draw-probes-all.json` (input) | `00c86204c0485ca269da5e120bce8ed10232cb7f8fac172e11a339a0f4b61c55` |
| `draw-probes-extra.json` (input) | `9e9bce2b8f65b491340fb8a60ef135601259f3bba2a005f5bd4f7d6e87d5286d` |
| `usa_la_longbeachdocks-probe/probe.json` | `e8ed185b34a4701133f953d26534ae52a662b55fc3c05938435f5022802e28f7` |
| Longbeach prototype positions | `823fd75960689b9a09b60852761e7993dd97191a5c24a089555ac5362ce9ce0f` |
| Longbeach prototype indices | `5b4eb40ef7938251074fbe19b21554d1bd4a2caf092e772c322f54742cfdaaa9` |
| `spa_barcelona_bowl_multiplayer-probe/probe.json` | `5df1fb3198e491dec55a3558a42aa61dfb355fb74cf94cdad52f54af326534f1` |
| Bowl prototype positions | `b31446719392aa7e0aff6597e4ab59115df4561f131620464af42334a2e2cc3b` |
| Bowl prototype indices | `fcbf13be244b17d3ce65d7e526ebcad8407d3d31448b417facdd04b75a617fc6` |
| `usa_la_multiplayer_highrise-probe/probe.json` | `b01eef8f7428722d9723c58366236dd5f4b6ded942bbdb3b45cec44c77bad94c` |
| Highrise prototype positions | `368d5f85d941dd338e824a49d287e2a40aa9860a5266aff0357ddc707c77ab1d` |
| Highrise prototype indices | `c852f12672111e11c06d90f5834de0cff0fa26d1978180fd6cc7e7ff59827006` |
| `tools/c_map_probe.py` | `50102102f50b8cdeaabd7f93bd535c8cbb1cb6c59b403da4963927f9380fefe3` |
| `tools/node_inventory.py` | `6bb1dc5ddacf8aff0c02e55952b597c2b52372822de928b4a503d074943ccd5d` |
| `tools/blocked_inventory.py` | `6078f1dc5d130c12f70a5e949b301eae49f793ce2153d99f4afb587f3c66c5a2` |
| `tools/verify_blocked.py` | `3ca1dcad464befce12382f926682e0fa5fc9e65aae468aa2cd0bd7f6bd537c2f` |

## 10. Recommended next step

1. Integrate **Longbeach** on the existing 818 m package (2 items); record the
   browser screenshot and console.
2. Add the **extended extractor item** to the map-slice producer, then re-run the
   Longbeach package to make the full 1,730 m course available.
3. Integrate **Observatory**, then **Downtown**, on the six-item chain.
4. Re-run the `--skip-build` suite and the E1 verifier after each map.

Do not promote either C map on the strength of this document alone: the proof
is a read-only extraction and coverage result. The C maps still need a
map-slice package, texture binding, render package, layout, E1 map entry and a
browser frame before they count as playable.
