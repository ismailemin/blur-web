# `usa_amboy` map slice package

**Date:** 7 November 2026
**Owner:** MAP2 (sub-agent); package refreshed by MAP4 after READ1 (§11)
**Scope:** `probes/map-slice/**`, `_work/map-slice/**`,
`_work/logs/map-slice/**` and this document. No change to `probes/e1-drive`,
`probes/map-pipeline`, `probes/asset-reader`, the engine, `tools/`, `upstream/`
or `game-data/`. The map-pipeline and asset-reader outputs are consumed
read-only. No renderer, GPU, browser, playable-game or full-game claim is made.

## Result

`usa_amboy` now has a self-describing, deterministic data package:

| item | measured value |
|---|---|
| collision triangles | **63,708** (55,812 up-facing, 2,482 steep, 5,414 other, 0 degenerate) |
| collision unique vertices | 34,057 (191,124 triangle-soup indices) |
| first-RenderList direct sections | **48 supported / 75 probed**; 27 unsupported |
| draw geometry | 529,624 vertices, 348,948 triangles, 1,606 draws |
| UV0 | 1,606/1,606 draws; 0 missing; 0 placeholder vertices |
| textured vs diagnostic | **0 textured / 1,606 diagnostic**; 0 texture bytes |
| measured draw-covered path | **2,060.59538 m** point-to-point (declared 2,060.595) |
| path coverage of collision diameter | 97.62 % (2,060.595 / 2,110.801) |
| checkpoints | 686.8623 m and 1,373.6673 m |
| spawn | (230, 1128), ground −0.094210 m, heading −2.35619449 rad |
| spawn band | 25/25 hits, all up-facing, 1 m × 5 m, height spread 0.10073 m |
| physics settle | 60 ticks, zero input, 4/4 wheel contacts on 61/61 states, finite |
| physics state sequence | `sha256:d25c4592…53491b38` (two independent modules identical) |
| native reader (refreshed) | `level_inspect.exe` 249,856 B, `sha256:a633a030…6965b` |
| reader replay | 48/48 supported sections; positions/UV0/indices/draw ranges identical |
| material identity | 1,268/1,606 resolved (1,163 resource + 105 shared), 338 blocked; 1,201 bindable after MAP3 join |
| package bytes | 17,625,578 (payload + `slice.json`); 17,627,626 incl. `verify.json` |
| verifier | **12,367 checks, 0 errors, PASS**; byte-identical on repeat runs |

The package is a **playable-slice input**, not a playable slice: it has no
renderer, no e1-drive integration, no UI and no retail start-line record.

## 1. Sources and extraction

| input | bytes | SHA-256 |
|---|---:|---|
| `game-data/Blur/levels/usa_amboy/Level.levelphysics` | 4,442,528 | `18c73e1cca6f13c5bbd4937454f25ec3163a67553fea6842a7797400af2175f2` |
| `game-data/Blur/levels/usa_amboy/level.levelrender` | 11,263,032 | `796c9289e224a6c15aff75b929eca875ef03d4d91b015f67aba704de1f9a3ea7` |
| `_work/map-pipeline/candidates/usa_amboy.layout.json` | 597,150 | `b4b063bcd5da456841cef25db3c8094de0b392a6173490b9ea17533fba780f5f` |
| `_work/map-pipeline/covered/usa_amboy-path.json` | 52,784 | `41f95a5dd54c2969d79ff6cdfe3b6bdac9de8f7a397f0ec9757ae6ba8802a831` |
| `_work/map-pipeline/covered/usa_amboy.json` | 4,244 | `c5b49fcc2807c0d8c0a27e7f16735e19a40273c4eeff1b6d27199daa05bf9a62` |
| `_work/map-pipeline/draw-probes-all.json` | 1,267,866 | `00c86204c0485ca269da5e120bce8ed10232cb7f8fac172e11a339a0f4b61c55` |
| `_work/map-pipeline/grids/usa_amboy.npz` | 4,030,113 | `4c6f3ef761cbf391c91a56599c2910be506158dd7402b4f8d83aa5366e0283d3` |
| `_work/map-pipeline/maps.json` | 205,652 | `40878a997c7411c27bb8edbdaf091d3fe1bbf33b8d7b25224dd54d881f16e0ea` |
| `_work/map-pipeline/inventory.json` | 159,627 | `6ed6b1c2fa0590d6abce567c27b030eb93704e7f0c29eb22022644ed93bf96bd` |
| native reader `level_inspect.exe` (current, READ1) | 249,856 | `a633a030f530b9939991b4fc5c67aebe60d00cd22d59a6fffb3f74b0fbf6965b` |
| collision scanner `physics_scan.py` | 18,100 | `a98e699ad43d4cf6b44064870973c3921847cfa2f7e091cefd36a00586776b72` |
| collision oracle `reference_oracle.py` | 48,842 | `2d7e5aecbff57f2d119e4ca0aa9d6904194ce6c7080ef5c546edb944e75f438a` |
| E1 module `e1_drive.mjs` | 11,368 | `31bcd0febcb1cca66fc47703cd63dbbb46e9c35a6f425f2f5d5cf358660f957a` |
| E1 wasm `e1_drive.wasm` | 1,006,289 | `eb9efc0064f0d871d70b31b335aa478faacc4b4ff4c78e4df193a094c1b53409` |
| E1 build `build.json` | 3,356 | `e7d4f5be130044a49d83e9d71164d3e31f9a62217842e8971a62e53b10718b02` |
| car fields `_work/e1-drive/car.fields` | 7,489 | `1c24bbd7f055f904062d1f1b7b377be727a7cf9f64e8ca2c72dff5b138a55381` |

Collision uses the committed map-pipeline scanner, which follows the upstream
serializer (`BodyHelper.h`, `ShapeDescriptors.h`, `CompositeDescriptor.h`,
`Importer.cpp`). The committed collision oracle alone rejects this level because
its first import shape is a Box; the scanner parses types `2, 6, 6, 6, 6, 0, 11,
10` and the triangle-tree payload is decoded by the committed oracle routines.
No format, offset or triangle is guessed.

Draw geometry is the committed native `level_inspect` output already recorded by
the map pipeline (`_work/map-pipeline/probes/usa_amboy-g*/native.json`). The
package reuses those values byte-for-byte; the verifier re-reads every
`native.json` and compares the merged buffers. Extraction additionally replays
the current reader on the same staged chunks to record static material identity
(§11); the replay must match the committed geometry or extraction aborts.

## 2. Collision

`Level.levelphysics` stream version 10, file version 0. Shapes:

| index | type | name | shipped as triangles | reason |
|---:|---:|---|---|---|
| 0 | 2 | Box | no | simple collision shape |
| 1–4 | 6 | Cylinder (4) | no | simple collision shapes |
| 5 | 0 | TriangleMesh | yes | 90,130 vertices, 63,683 triangles |
| 6 | 11 | TriangleMeshBase | yes | 31 vertices, 25 triangles |
| 7 | 10 | InstancedTriangleMesh | no | instance geometry not decoded; instances not applied |

The static triangle meshes give 63,708 triangles and 34,057 unique vertices
after exact-position deduplication. Surface classification recomputes the
geometric normal: 55,812 triangles have `normal.y > 0.94`, 2,482 are steep
(`|normal.y| < 0.5`), 5,414 are other, 0 degenerate. Vertex bounds:
`[-1039.792, -9.826, 155.560] … [966.154, 27.872, 1571.664]`. These are the
actual triangle-vertex bounds; the tree root bounds differ by a small amount.

## 3. Draws

48 of 75 first-RenderList direct sections are readable. They contain 529,624
vertices, 348,948 triangles and 1,606 draws. Every draw has original UV0; the
merged UV0 buffer is 529,624 pairs. No draw has a placeholder UV.

### 3.1 Materials, textures and normals

- **Materials (packaged v1 draw records):** every draw reports
  `albedoTexture:null` and
  `binding:"Level materials not applied in diagnostic preview"`, because the
  package draw records are built from the committed **pre-fix** probe doc. The
  fixed reader replay records identity separately (§11):
  **1,268/1,606 resolved, 338 blocked**.
- **Textures bound:** **0**. Texture bytes: **0**. Static albedo identity is
  not a binding: no format, alpha, blend, shader stage, sampler state or pixel
  is applied. Attempts recorded in `slice.json.textures.attempts`:
  - fixed `level_inspect` replay on 48/48 supported sections: 1,268 identities
    (1,163 resource-block + 105 shared), 338 blocked, 1,606/1,606 UV0 hashes,
    38 shared texture identities per section, no image bytes
    (`slice.json.draws.nativeReaderRefresh`).
  - pre-fix `level_inspect` direct draws (source of the packaged draw records):
    1,606/1,606 `albedoTexture:null`, `sharedTextures:[]`.
  - `level_inspect --instances-all` on `g100-n234`: error
    `First RenderList contains no instances`.
  - `level_inspect --instances-all` on `g54-n184`: status ok but 0 in-scope
    draws; 261 instances are `other-block`.
  - `scene_inspect --resources` on the levelrender: error
    `Expected Model container at byte 20` (it accepts model containers, not a
    levelrender archive).
- **Normals:** not exported by the committed direct-draw reader. The package
  contains no normals and does not invent geometric normals. The format carries
  normal indices, but no decoded normal vector stream is exposed.

> **MAP3 correction and follow-up (7 November 2026).** The original §3.1
> sentence “the direct-draw reader has no committed material-binding path for
> base primitives” was inaccurate (superseded by the fixed-reader replay above
> and §11). `scene_reader.cpp` `geometry()` calls
> `bind_albedo()` for every direct primitive and resolves the ordered
> instance/base/stream material stack, the static `g_tAlbedo`, and the node
> texture-source identity. At the time of that check the *export* hard-coded
> `albedoTexture:null` at `scene_reader.cpp:753-754` and did not print
> `draw.albedo`, `draw.resource_block`, `draw.resource_index`,
> `draw.material_row` or `draw.material`; READ1 fixed that export (§11). A
> source-shaped binding pass over all 48 supported sections
> resolves a static albedo for **1,268 / 1,606 draws**, of which **1,201 /
> 1,606 draws (269,300 / 348,948 triangles)** are bindable today with real UV0
> and the committed BC decoder; the other 405 are blocked by labelled effect,
> 512-px decoder-bound, BC3-alpha and runtime-parameter cases. The 27
> unsupported sections stop on `BillBoard_LN` `POSITION0` type 7 (geometry
> blocker) while their texture side resolves 27/27; the 366 instances resolve
> static albedo 366/366 and UV0 declarations 366/366 but are other-block
> geometry. Details, manifest and verifier:
> `docs/work/analysis/map-slice-amboy-textures.md`,
> `_work/map-slice/amboy-textures/bindings.json`,
> `_work/map-slice/amboy-textures/blockers.json`.

### 3.2 Unsupported sections (27)

All 27 stop in the committed native reader on an unsupported position vertex
format. The byte offset is the native offset in the extracted geometry chunk.

| geometry block | node block | byte offset | reason |
|---:|---:|---:|---|
| 35 | 272 | 373564 | Unsupported position vertex format |
| 38 | 270 | 600828 | Unsupported position vertex format |
| 39 | 204 | 615776 | Unsupported position vertex format |
| 45 | 226 | 465020 | Unsupported position vertex format |
| 46 | 272 | 571740 | Unsupported position vertex format |
| 50 | 270 | 543752 | Unsupported position vertex format |
| 55 | 272 | 485620 | Unsupported position vertex format |
| 57 | 274 | 516644 | Unsupported position vertex format |
| 59 | 274 | 511476 | Unsupported position vertex format |
| 66 | 220 | 413162 | Unsupported position vertex format |
| 67 | 276 | 605048 | Unsupported position vertex format |
| 68 | 214 | 438384 | Unsupported position vertex format |
| 70 | 228 | 354064 | Unsupported position vertex format |
| 76 | 282 | 514952 | Unsupported position vertex format |
| 78 | 204 | 419818 | Unsupported position vertex format |
| 88 | 214 | 412410 | Unsupported position vertex format |
| 94 | 258 | 372136 | Unsupported position vertex format |
| 96 | 282 | 526486 | Unsupported position vertex format |
| 102 | 282 | 523736 | Unsupported position vertex format |
| 103 | 276 | 595074 | Unsupported position vertex format |
| 107 | 272 | 380774 | Unsupported position vertex format |
| 115 | 258 | 568908 | Unsupported position vertex format |
| 126 | 280 | 543216 | Unsupported position vertex format |
| 135 | 270 | 432352 | Unsupported position vertex format |
| 136 | 224 | 418020 | Unsupported position vertex format |
| 138 | 256 | 409136 | Unsupported position vertex format |
| 145 | 226 | 417080 | Unsupported position vertex format |

Three supported sections carry skipped instance descriptions:
`g54-n184` (262 instance descriptions, 164 base primitives),
`g237-n238` (40 / 38) and `g251-n252` (64 / 48); 366 descriptions total.
They are not applied. Instance-only geometry can add surfaces.

## 4. Layout, spawn and path

The candidate layout is adopted only after re-measuring it:

- 8,673 points at 0.25 m nominal spacing; polyline length
  **2,060.595380 m** (declared 2,060.595; error 0.000380 m, i.e. the declared
  value is rounded to millimetres).
- Every layout point lies on the measured draw-covered polyline
  (max deviation **1.42e-14 m**). All **1,543** measured covered samples are
  embedded in the dense layout.
- The path sits on a **1/12 m** coordinate lattice (0.25 m and √2/6 m steps);
  maximum coordinate error 0.0004 m.
- All 1,543 covered samples are passable on the 1 m audit grid. The dense
  layout's nearest 1 m cells are passable for 8,302/8,673 points; the remaining
  371 are a nearest-cell artifact of the 1 m audit grid versus the 1/12 m path
  lattice. The package does not claim every 0.25 m point is a passable 1 m cell.
- Direction: spawn → checkpoint 1 → checkpoint 2 → finish. No lap is claimed.

| station | x | z | ground (m) | cumulative (m) |
|---|---:|---:|---:|---:|
| spawn | 230.0 | 1128.0 | −0.0942 | 0.0 |
| checkpoint 1 | −281.1687 | 1478.1687 | 0.1562 | 686.8623 |
| checkpoint 2 | −1.0445 | 1041.9555 | −0.3008 | 1,373.6673 |
| finish | −356.0 | 860.0 | −0.6046 | 2,060.59538 |

The checkpoint coordinates are the candidate values; their nearest layout points
are 0.0028 m and 0.0629 m away respectively (recorded in `slice.json`). The
station distances above are measured along the 8,673-point polyline.

Spawn heading is −2.35619449 rad, the first-2 m tangent; measured heading error
1.92e-10 rad. The spawn is the first layout point (delta 0.0 m).

### 4.1 Spawn ground and 1 m band

A vertical collision ray at (230, 1128) hits at **−0.094210 m** with normal
`[0.002882, 0.999378, −0.035152]`. The layout records −0.0942 (delta
−1.04e-5 m); the E1 engine ground probe returns −0.094223 m.

Twenty-five rays cover 5 stations (0–4 m) × 5 lateral offsets (−0.5, −0.25, 0,
+0.25, +0.5 m): **25/25 hits, all up-facing**, height spread **0.10073 m**,
maximum absolute deviation from the centre 0.08727 m. At the spawn station the
1 m band runs from −0.107666 m to −0.080765 m (spread 0.026911 m). The engine
probe agrees with the triangle ray at the centre within 1.3e-5 m.

## 5. Physics proof

The E1 wasm module is **not hard-coded to River**. `_e1_create` copies the
supplied level buffer and imports it through Gravity's
`C_ImportScene::Import`; the only River-specific input in the existing slice is
the car record (here `_work/e1-drive/car.fields`, Corvette ZR1), not the level.
Amboy's Box + 4 Cylinders + TriangleMesh + TriangleMeshBase import stream
parsed successfully (`create = 1`).

Inputs: `Level.levelphysics` (above hash), `car.fields` (above hash), spawn
(230, 1128), heading −2.35619449. The module performs its 180-tick warm-up, then
the probe runs **60 ticks with zero input** and samples state at ticks 0…60.

| field | value |
|---|---|
| create | ok, `car=Corvette_ZR1_Stock`, `physicsParametersHandle=76` |
| warm-up | 180 ticks |
| tick-0 position | `[229.977142, 0.261210144, 1127.96802]` |
| tick-60 position | `[229.972549, 0.261353701, 1127.96411]` |
| ground / start Y | −0.094223 / 0.431777 |
| ride height (tick 0 origin above ground) | 0.355433 m |
| wheel contacts | 4/4 on all 61 states |
| finite | true on all 61 states |
| `anyContact` | true on all 61 states |
| max / final speed | 0.034216 / 0.008887 m/s |
| drift over 60 ticks | 0.006032 m |
| vertical delta | 0.000144 m |
| state sequence | `sha256:d25c4592df994e6a90ca362ebdbdea33c7a247f36b05395b9f786f6d53491b38` |
| tick-0 state hash | `sha256:d09314c6c789622202ab3ed5a87c02d8275786a11d1108e9b1e59d6f3dfde363` |
| tick-60 state hash | `sha256:898d271104598e361bd1067a16354321b7459c3cbfed5ecfac70718bf868120b` |

Two independent module instances produced identical per-tick hashes and the same
sequence hash (`determinism.identical=true`). This proves the car sits on the
Amboy collision at the candidate spawn; it does **not** prove a driven line, a
lap, a race or a rendered frame.

## 6. Package

`_work/map-slice/amboy/`:

| file | bytes | SHA-256 |
|---|---:|---|
| `slice.json` | 1,632,556 | `d34a33d9a77ccd1eaca34b03b89216a6d0b70b6d8f8c8a555e717ed7796c94f7` |
| `collision.positions.f32.bin` | 408,684 | `0604bb8ef9062a241fa75dcc5f5bd94456f092efd74d339e3f28d776b147462d` |
| `collision.indices.u32.bin` | 764,496 | `46f998b321907abac53e71c5f417b35f48ca9361615ede5132ad29793a9765b3` |
| `draws.positions.f32.bin` | 6,355,488 | `5d85409b9b838227907eca2d53b34a4d7f37cb6d67158dc596b70bc24dbb2755` |
| `draws.uv0.f32.bin` | 4,236,992 | `200ae62a7c4a3b20c0a0052e5034121c089aa8e52770cb054a22f01f29bffdff` |
| `draws.indices.u32.bin` | 4,187,376 | `f4d77438b7ce99a809280e71b6cd356dedef784f613faf0147bd447c50b41e66` |
| `physics-settle.json` | 39,986 | `27a8ec91bdfa0444de2cabc7a31d25a09ce583960381860ebab49c3eb548506b` |
| `verify.json` | 2,048 | `906dd8845949a2794345913f1f0804826081e11b7f38933dec232c4eafd46392` |

`slice.json` content hash (canonical body excluding `hashes`):
`bbd03a26205ded04ff905b4538d3f9fe15f78ebc895cf39eb1e17c0bb34c14d2`.

All six payload files are **byte-identical** to the pre-refresh package; only
`slice.json` grew (+3,081 B) for the reader-identity/replay record and the
corrected texture identity text. Totals: payload + manifest **17,625,578 B**;
including `verify.json` **17,627,626 B**. `slice.json` pins every payload file's
size and SHA-256; the verifier recomputes both and the content hash.

## 7. Verification

`python probes/map-slice/tools/verify_slice.py --package _work/map-slice/amboy`
→ **PASS, 12,367 checks, 0 errors**. It independently:

- re-parses `Level.levelphysics`, re-extracts all 63,708 triangles, re-classifies
  surface/steep/other, and compares the collision binaries;
- re-reads all 48 supported `native.json` files, rebuilds the merged
  position/UV0/index buffers and the 1,606 draw records, and compares them and
  all 27 unsupported byte offsets;
- re-measures the 2,060.59538 m layout, checkpoint distances, covered-polyline
  deviation, embedded samples and spawn heading;
- re-raycasts the 25-ray spawn band;
- re-hashes the E1 module/wasm/build, re-reads all 61 physics states, and
  recomputes the state sequence and determinism claims.

Extraction also replays the current reader on all 48 supported staged chunks
and aborts unless positions, UV0 bits, indices and draw ranges match the
committed probe doc; the replay writes
`_work/logs/map-slice/reader-refresh/usa_amboy/` (48 files, 49,790,010 B) and
feeds `draws.nativeReaderRefresh`. Two full extraction runs with the final code
produced byte-identical payload, manifest **and** replay files; repeated verifier runs
produced a byte-identical `verify.json`. The repository suite
`python tools/verify_asset_probe.py --skip-build` reported **40/40 PASS** in this
tree, including `map-slice-amboy` and `amboy-textures` (the task text said 41;
the committed suite in this checkout defines 40 steps). No browser, GPU or
renderer gate was run for this task.

## 8. What the E1 page still needs (integration gaps)

1. **Per-map geometry packet.** The package has buffers, section ranges and
   draw records, but `e1-drive` still builds its packet and sprint layout from
   River. This needs a map id, per-map geometry upload and a packet v1.1
   producer; `build_sprint.mjs` / `sprint-layout.js` are River-specific and were
   not pointed at this layout.
2. **Materials and textures.** 0 albedo images are bound, so every draw remains
   diagnostic for rendering. Static albedo identity is resolved for
   1,268/1,606 draws (1,201 bindable after MAP3's decoder/alpha join), but the
   page still needs texture upload/decoding and GPU state before Amboy is more
   than diagnostic geometry. No texture was invented.
3. **Normals.** The package has no decoded normals; shading needs a reader
   change or an explicit, documented geometric-normal fallback. A silent
   fallback is not acceptable.
4. **Instances.** `instancesApplied:false`; 366 instance descriptions in 3
   sections are skipped, and the InstancedTriangleMesh collision shape is not in
   the package. Instance-only geometry can add surfaces.
5. **Simple collision shapes.** The Box and four Cylinders are not in the
   triangle package. The engine still loads the complete physics file, but a
   package-only consumer would miss them.
6. **Spawn/layout.** The spawn is derived from the measured path, not a retail
   start line. The course is point-to-point; no lap, respawn or race-director
   integration exists.
7. **Props/rules/UI.** No Amboy prop colliders, power-ups, race rules, map
   select entry or results screen.
8. **Browser/GPU evidence.** No frame, screenshot or console capture exists for
   Amboy. This is a data/probe result only.

## 9. Limits

- Draw coverage is first-RenderList direct LOD0 only. `instancesApplied:false`;
  a missing section means “not under these extracted draws”, not “no draw
  exists”.
- Materials, textures, shaders, samplers, alpha/blend and GPU state are not
  applied.
- No decoded vertex normals.
- The 1 m audit grid is coarser than the 1/12 m path lattice; the passable
  nearest-cell count is recorded, not turned into a road-width claim.
- Collision triangles exclude simple shapes and instance geometry.
- Physics is a 60-tick zero-input settle with one car; no throttle, steering,
  braking, lap, prop collision or respawn test.
- No renderer, GPU, playable-game or full-game claim.

## 10. Commands and evidence

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/map-slice/tools/extract_slice.py --level usa_amboy --out _work/map-slice/amboy
node probes/map-slice/tools/physics_settle.mjs --package _work/map-slice/amboy
& $py probes/map-slice/tools/verify_slice.py --package _work/map-slice/amboy
```

| path | content |
|---|---|
| `_work/map-slice/amboy/slice.json` | manifest, layout, draws, textures, spawn, hashes |
| `_work/map-slice/amboy/*.bin` | collision and draw buffers |
| `_work/map-slice/amboy/physics-settle.json` | 61 states, 25 ground probes, determinism |
| `_work/map-slice/amboy/verify.json` | 12,367-check independent verifier |
| `_work/map-slice/hashes-final.json` | refreshed package hash manifest |
| `_work/logs/map-slice/reader-refresh/usa_amboy/*.json` | 48 fixed-reader replays (identity evidence) |
| `_work/logs/map-slice/extract-read1-refresh.log` | refreshed extraction log |
| `_work/logs/map-slice/verify-read1-refresh.log` | 12,367-check verifier log |
| `_work/logs/map-slice/amboy-textures-verify-read1-refresh.log` | 13,090-check binding verifier log |
| `_work/logs/map-slice/asset-probe-read1-refresh.log` | 40/40 repository suite log |
| `_work/logs/map-slice/extract-final4.log` | original MAP2 extraction log (historical) |
| `_work/logs/map-slice/physics-settle.log` | physics settle log |
| `_work/logs/map-slice/verify-final4.log` | original MAP2 verifier log (historical) |
| `probes/map-slice/tools/extract_slice.py` | package builder |
| `probes/map-slice/tools/physics_settle.mjs` | E1 wasm settle probe |
| `probes/map-slice/tools/verify_slice.py` | deterministic verifier |
| `probes/map-slice/README.md` | probe usage and limits |

No file under `probes/map-pipeline`, `probes/e1-drive`, `probes/asset-reader`,
the engine, `tools/`, `upstream/` or `game-data/` was modified by this task.

## 11. READ1 reader refresh (7 November 2026)

**Owner:** MAP4. Scope: `probes/map-slice/**`, `_work/map-slice/**`,
`_work/logs/map-slice/**` and this document. No asset-reader, map-pipeline,
e1-drive, tools, upstream or game-data file was modified. No renderer, GPU,
browser, playable-game or full-game claim is made.

### 11.1 Why the package was refreshed

READ1 changed `level_mesh` to export static albedo identity, material rows,
UV0 hashes and the level Scene shared-texture list. The committed Amboy package
still pinned the **pre-fix** reader (`247,808` B / `63ee2801…`), so
`map-slice-amboy` failed on `source.nativeReader.bytes` and
`source.nativeReader.sha256` although every content value was valid.

The committed map-pipeline probe doc (`draw-probes-all.json`) was also built by
the pre-fix reader (`nativeReaderSha256 63ee2801…`); its `native.json` files
have no identity fields. Map-pipeline is read-only for this task, so the
extractor now **replays the current reader** on the same staged `geometry.chunk`
/ `node.chunk` inputs and records the additive fields without replacing the
committed geometry.

### 11.2 Reader identity and replay

| item | before refresh | after refresh |
|---|---|---|
| `level_inspect.exe` | 247,808 B, `63ee2801ac10…` | **249,856 B, `a633a030f530…`** |
| replay sections | not run | **48/48 supported** |
| positions / indices / UV0 bits / draw ranges | — | **identical to committed probe doc** |
| `uvHash` printed | 0 | **1,606/1,606** (all compared to MAP3's manifest, 0 mismatches) |
| `sharedTextures` list | `[]` | **38 identities per section** |
| `metadata.material` | `diagnostic-only` | `static-albedo-identity-only` |

Invocation per section:

```text
level_inspect.exe <levelrender> <geometry.chunk> <node.chunk> <geometryBlock> <nodeBlock>
```

The replay aborts extraction if any of the four geometry checks fails. The
exported JSON is parsed with the same negative-zero rule as the committed probe
builder (`-0` → `-0.0`); without that rule a naive JSON parse collapses 391
negative-zero UV components to `+0.0`, which is numerically equal but not
byte-identical. Evidence: `_work/logs/map-slice/reader-refresh/usa_amboy/`
(48 files, 49,790,010 B, aggregate SHA-256
`54337e29e1d21f5e86587bff11ad48d35b35d186b3c746573417d9b5c52bf325`).

### 11.3 Additive fields (and what they do not mean)

| field (draw) | observed | meaning |
|---|---|---|
| `resourceBlock` / `resourceIndex` | 1,268 draws | static resource-block albedo identity |
| `material` / `materialRow` | 1,272 named | committed effect name and material row |
| `uvHash` | 1,606 | FNV-1a 64 over referenced UV0 bits |
| `bindingStatus` | 1,163 `static-resource-albedo-resolved`, 105 `static-shared-albedo-resolved`, 338 `blocked` | identity resolution only |
| `bindingReason` | 338 | existing blocked reason text |
| `albedoTexture` | non-null on **105** draws | **shared-texture index**, not a bound image |
| `sharedTextures` (section) | 38 per section (1,824 entries) | level Scene identities |

`metadata.materialAlbedoResolved=true`; `materialColourApplied`,
`blendStateApplied`, `alphaRuleApplied`, `shaderStagesApplied` and
`samplerStateApplied` are all `false`. MAP3 joins this identity to decoder/alpha
evidence: **1,201 bindable / 405 blocked** draws, 1,606/1,606 UV0 hashes
(`docs/work/analysis/map-slice-amboy-textures.md` §11).

The package's own draw records keep the v1 schema (`albedoTexture:null`,
diagnostic `binding`) because they come from the committed pre-fix probe doc.
The fixed reader's `albedoTexture` shared-texture index is deliberately **not**
merged into that schema; blending the two meanings would silently turn identity
into a false texture-bound claim.

### 11.4 Before / after package diff

| file | before (bytes / sha256) | after (bytes / sha256) |
|---|---|---|
| `slice.json` | 1,629,475 / `f6f8ae85…` | **1,632,556 / `d34a33d9…`** |
| `verify.json` | 2,048 / `136c28a5…` | **2,048 / `906dd884…`** |
| `collision.positions.f32.bin` | 408,684 / `0604bb8e…` | identical |
| `collision.indices.u32.bin` | 764,496 / `46f998b3…` | identical |
| `draws.positions.f32.bin` | 6,355,488 / `5d85409b…` | identical |
| `draws.uv0.f32.bin` | 4,236,992 / `200ae62a…` | identical |
| `draws.indices.u32.bin` | 4,187,376 / `f4d77438…` | identical |
| `physics-settle.json` | 39,986 / `27a8ec91…` | identical |

`slice.json` content hash: `4cd85cd8…` → **`bbd03a26205ded04ff905b4538d3f9fe15f78ebc895cf39eb1e17c0bb34c14d2`**.
The +3,081 B is the `draws.nativeReaderRefresh` block and the corrected
`textures` identity text; no geometry, UV, path, spawn or physics byte changed.

### 11.5 Verification

| gate | result |
|---|---|
| `verify_slice.py --package _work/map-slice/amboy` | **12,367 checks, 0 errors, PASS** |
| `verify_amboy_texture_bindings.py` | **13,090 checks, 0 failures, PASS** |
| binding split / UV hashes | **1,201 bindable / 405 blocked**, **1,606/1,606** |
| `verify_asset_probe.py --skip-build` | **40/40 PASS**, incl. `map-slice-amboy`, `amboy-textures` |
| deterministic re-extraction | package **and** 48 replay files byte-identical across two final-code runs |
| native CTest / `/W4` build | not rebuilt by MAP4 (no asset-reader change in this task) |

The suite in this checkout defines 40 steps, not 41; all 40 pass. The browser/GPU
visual gates remain separate and were not run.

### 11.6 Limits

1. Identity is not binding: 0 albedo images, 0 texture bytes, no format, alpha,
   blend, shader stage, sampler wrap/filter, mips, sRGB or pixel.
2. The 338 reader-blocked draws and the 405 MAP3-blocked draws remain blocked;
   no fallback texture was invented.
3. The 27 unsupported sections and 366 skipped instances remain geometry
   blockers, not texture blockers.
4. The package draws still come from the committed pre-fix probe doc; the
   current reader's additive fields are recorded in
   `draws.nativeReaderRefresh` + the MAP3 manifest, not merged into the draw
   schema.
5. No renderer, GPU, browser frame, driven lap, playable-game or full-game
   claim.

## 12. Behavior-based module pin refresh (7 November 2026 follow-up)

The E1 module pin is now **behavior-based**. `verify_slice.py` re-runs the
current `_work/e1-drive/module/e1_drive.mjs` on this package's physics bytes at
the recorded spawn and accepts module/build/wasm hash drift only when all 61
per-tick state hashes and the sequence hash match `physics-settle.json`. The
current identity is recorded informationally; geometry, draws, layout, spawn,
textures and manifests stay hard-pinned.

| item | refreshed value |
|---|---|
| module | 11,480 B / `5177ea975151fb085a44b8b960e384913d36a7e225078a1783f90e1f0b1bff2a` |
| build | 3,466 B / `8493193cb8aacc5a9d108874318c612298b46edb5fe28b12c8558b7f0d5c7577` |
| wasm | `bcdc2d994a499cc399333b44cfc418d6594f8b5182a668c3a9df761d891de265` |
| sequence | `sha256:d25c4592…53491b38`, 61/61 ticks identical |
| `slice.json` | 1,632,556 B / `8f5e07d681353b47abb799fdcd69b716fecca225d7a2f76dab48bf14b501b3d7`, content `61915aed…43ec8` |
| `physics-settle.json` | 40,213 B / `79f1a2bcc944e7bdb13d3860206496e4dc7910050f15d3827a4e64ffe7427a97` |
| `verify.json` | **12,367 checks, PASS**, `c24d7acf…de910` |

Payload geometry, collision, draws, layout and spawn are unchanged. The
binding/blocker/summary input pins were updated to the new slice hash and the
render package was rebuilt; the texture verifier repeat build proves the
data rows are unchanged. Policy and full hashes:
[`map-slice-module-pin-policy.md`](map-slice-module-pin-policy.md).
