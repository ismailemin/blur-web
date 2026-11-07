# Vehicle batch 3 preparation — staged data and HUD identity

**Date:** 8 November 2026
**Owner:** V6 (sub-agent), data/tooling only
**Scope:** new `probes/vehicle-pipeline/tools/{hud_catalog,render_preview,stage_batch3,verify_batch3}.py`,
outputs under `_work/vehicle-pipeline/batch3/` and `_work/logs/vehicle-pipeline/`, and this
document. No `probes/e1-drive`, `probes/car-materials`, `probes/asset-reader`,
`probes/map-slice`, `probes/car-parts`, `tools/`, web, engine, `upstream/` or `game-data/`
file is changed.

**Result:** the next ten cars are staged and verified: **7 medium class-C** records
(1, 7, 23, 31, 39, 48, 71) and **3 high-confidence class-B** cars (21 Renault Mégane
Trophy, 24 LandRover LRX, 26 Nissan 350Z Drift). Every car has a body manifest/mesh,
scene report, independent material traversal, wheel asset report, HUD name/icon identity
and three deterministic geometry previews. The batch-3 gate is **PASS 912/912**, and two
independent builds are byte-identical. No e1 roster, P52, geometry-pin, ghost or browser
change is claimed.

## 0. Summary

| metric | value |
| --- | ---: |
| records staged | **10** (7 C + 3 B) |
| body draws | **1,076** |
| parts | **307** |
| wheel draws | **200** (188 preview-paired, 12 proven) |
| LOD0 vertices | **213,062** with valid UV0 |
| static-albedo draws (independent traversal) | **476** |
| unique referenced textures | **83** |
| texture source bytes | **6,617,940** |
| preview PNGs | **30** (3 views × 10 cars) |
| batch gate | **PASS 912/912**, 0 failures |
| two-build determinism | **identical** (manifest/mesh/positions/indices/scene/previews/materials/HUD) |
| existing vehicle verifier | **PASS 542/542** |
| C-alias verifier | **PASS 438/438** |

The only proven playable content is still the five A anchors plus whatever batch 2 lands.
Batch 3 is staged data for V7, not an integration.

## 1. Candidate selection

The batch-2 split (V3/V5) takes the 7 C records with at least one proven wheel draw
(18, 22, 25, 47, 63, 65, 75) plus 3 high-confidence B cars. The working tree on
8 November shows batch 2's B picks as records **16, 20, 30** (`bmw-m3e92-tuner`,
`koenigsegg-ccxr-stock`, `toyota-supratrd-stock`) in
`probes/e1-drive/cars/roster.json`. Batch 3 therefore takes the complementary medium-C
tier and three B cars with no batch-1/2 overlap.

| # | record | class | drivetrain / mass / gears | AmaxVehicle tag | intended body model | draws / static / tex |
| --: | --- | --- | --- | --- | --- | --- |
| 1 | `Opel_AstraExtreme_shannon` | C | RWD, 1100 kg, 6 | `Opel_AstraExtreme_Stock_Shannon` | `opel_astraextreme_stock_shannon.model` | 86 / 72 / 11 |
| 7 | `Renault_MeganeSportR26_Stockgrpc` | C | FWD, 1300 kg, 6 | `Renault_MeganeSportR26_Stock` | `renault_meganesportr26_stock.model` | 125 / 47 / 7 |
| 23 | `BMW_135_Stock` | C | RWD, 1480 kg, 6 | `BMW_1SeriesTii_Stock` | `bmw_1seriestii_stock.model` | 111 / 49 / 9 |
| 31 | `LandRover_DefenderSVXgrpc` | C | AWD, 1750 kg, 6 | `LandRover_DefenderSVX_Stock` | `landrover_defendersvx_stock.model` | 85 / 30 / 7 |
| 39 | `Ford_Mustang_GT500_Stock1stplay` | C | RWD, 1495 kg, 6 | `Shelby_MustangGT500_Stock` | `shelby_mustanggt500_stock.model` | 110 / 52 / 7 |
| 48 | `Ford_F150_OffRoadheh` | C | AWD, 1900 kg, 6 | `Ford_F150_OffRoad` | `ford_f150_offroad.model` | 120 / 39 / 7 |
| 71 | `Opel_AstraExtreme_Stockgrippy` | C | RWD, 1100 kg, 6 | `Opel_AstraExtreme_Stock` | `opel_astraextreme_stock.model` | 86 / 63 / 10 |
| 21 | `Renault_MeganeTrophy_Stock` | B | RWD, 900 kg, 6 | `Renault_MeganeTrophy_Stock` | `renault_meganetrophy_stock.model` | 93 / 47 / 8 |
| 24 | `LandRover_LRX_Stock` | B | AWD, 1750 kg, 6 | `LandRover_LRX_Stock` | `landrover_lrx_stock.model` | 135 / 40 / 7 |
| 26 | `Nissan_350Z_Drift` | B | RWD, 1462 kg, 7 | `Nissan_350Z_Drift` | `nissan_350z_drift.model` | 125 / 37 / 10 |

Why these three B cars, from the 62-record matrix:

- **24 LandRover LRX** has the highest draw count of the remaining B set (**135**) and
  40 static-albedo draws; its staged wheel set also contains **4 proven** wheel draws.
- **26 Nissan 350Z Drift** has the joint-highest texture count among B cars (**10**) and
  **8 proven** wheel draws, plus a 7-speed gearbox (only 3 records have 7 gears).
- **21 Renault Mégane Trophy** is the lightest remaining RWD B car (**900 kg**) with
  47 static draws / 8 textures and a distinct drivetrain/weight point.

None of 21/24/26 is in batch 1 (records 2, 10, 13, 17, 19, 33, 46, 74, 77, 80) or in the
observed batch-2 B set (16, 20, 30). If the batch-2 roster changes before it is committed,
re-check this overlap first; the staged artifacts themselves remain valid.

## 2. Staging method

`probes/vehicle-pipeline/tools/stage_batch3.py`:

1. resolves each record's body and wheel assets:
   - C records use the exact `AmaxVehicle.dynamics` alias evidence in `c-aliases.json`;
   - B records use the exact `\models\vehicles\<tag>.model` rule plus
     `AmaxVehicle.wheelModel.fileName` for the wheel path;
2. re-hashes the decoded body model and (for B) decodes the wheel model from `root.pak`;
3. runs the committed `probes/car-parts/tools/build_manifest.py` into
   `_work/vehicle-pipeline/batch3/<slug>/` (manifest + `mesh.json` + `scene-report.json`);
4. runs `tools/inspect_car_materials.py` into `<slug>/materials/` (independent traversal:
   static albedo, textures, UV0 buffers, runtime material reasons);
5. reads the referenced wheel model with `scene_inspect.exe` and `model_inspect.exe`;
6. renders three deterministic CPU previews of the staged LOD0 mesh
   (`render_preview.py`, 480×270, geometry only);
7. writes `<slug>` summaries, `summary.json`, `roster.json` and a structured blocker list.

`probes/vehicle-pipeline/tools/hud_catalog.py` independently resolves the HUD identity
(§4) from `AmaxVehicle.LocString` / `locStringFull`, `UiIconName`, `Manufacturer`,
`vehicles.loc` and `car_icons*.ipf`.

The output root is disposable: `_work/vehicle-pipeline/batch3/` is the primary build and
`_work/vehicle-pipeline/batch3-repeat/` is the byte-comparison build.

## 3. Staged results and typed blockers

| # | slug | body draws | parts | wheel draws | proven / preview | tyre tier | UV0 valid | textures | static | caliper draws | status |
| --: | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | `opel-astraextreme-shannon` | 86 | 28 | 20 | 0 / 20 | containment | 30,800 | 11 | 72 | 4 | staged |
| 7 | `renault-meganesportr26-stockgrpc` | 125 | 38 | 20 | 0 / 20 | union | 23,128 | 7 | 47 | 4 | staged |
| 23 | `bmw-135-stock` | 111 | 26 | 20 | 0 / 20 | union | 13,374 | 9 | 49 | 4 | staged |
| 31 | `landrover-defendersvxgrpc` | 85 | 30 | 20 | 0 / 20 | union | 21,288 | 7 | 30 | 4 | staged |
| 39 | `ford-mustang-gt500-stock1stplay` | 110 | 32 | 20 | 0 / 20 | union | 19,677 | 7 | 52 | 4 | staged |
| 48 | `ford-f150-offroadheh` | 120 | 34 | 20 | 0 / 20 | union | 15,578 | 7 | 39 | 4 | staged |
| 71 | `opel-astraextreme-stockgrippy` | 86 | 28 | 20 | 0 / 20 | containment | 30,800 | 10 | 63 | 4 | staged |
| 21 | `renault-meganetrophy-stock` | 93 | 32 | 20 | 0 / 20 | union | 26,381 | 8 | 47 | 8 | staged |
| 24 | `landrover-lrx-stock` | 135 | 27 | 20 | 4 / 16 | union | 14,423 | 7 | 40 | 4 | staged |
| 26 | `nissan-350z-drift` | 125 | 32 | 20 | 8 / 12 | union | 17,613 | 10 | 37 | 4 | staged |

Every staged wheel group has **five unique wheel draws** (preview ∪ proven) and the four
groups never share a draw. `proven` is a corner proof; `preview` is a deterministic pairing
that is **not** a corner proof. The 7 medium-C cars have **0 proven / 20 preview** draws,
the same tier as the batch-1 medium B cars.

Per-car typed blockers (stored in each record's `blockers[]`):

| blocker | cars | meaning |
| --- | --- | --- |
| `wheel-corner-preview-only` | all 10 | wheel corner identity is preview-paired; no corner is guessed |
| `uv0-placeholder-vertices` | all 10 | placeholder UVs stay zero; those draws cannot bind albedo |
| `partial-scene-traversal` | all 10 | first resource block / first RenderList LOD0 only; no high LODs, visibility or runtime materials |
| `hud-icon-vector-decode-unsupported` | all 10 | IPF sprite names resolve; vector icon pixels/shapes are not decoded |
| `icon-declared-parent` | 1 | `AmaxVehicle.UiIconName` declares the base `opel_astraextreme_stock` icon; no Shannon-specific sprite exists |
| `e1-integration-pending` | all 10 | roster, P52, geometry pins, ghosts, captures are V7 work |

Additional limits, not blockers:

- `material` in every `scene-report.json` is `diagnostic-only`; runtime paint/light
  materials are not applied (`runtimeMaterialsApplied:false`).
- Records 1 and 71 (both Opel Astra Extreme) share **identical position streams**
  (`e5a0338a…`) but different index streams and body model hashes; their previews are
  therefore identical. The two records are not merged.
- The Mégane Trophy caliper has **8 draws over 4 caliper elements** (two draws per
  element); the other cars have 4 draws over 4 elements. The builder's typed group model
  handles both; no mesh is invented.
- Hummer H2 OffRoad is not in this batch; its typed absent caliper remains as V4 left it.

## 4. HUD name / icon / manufacturer list

`AmaxVehicle.LocString` and `locStringFull` are 32-bit LocIds; the batch tool resolves them
through the actual `vehicles.loc` hash table (197 keys, 5 locales; all 81 vehicle LocIds
resolve, 0 unresolved). `UiIconName` is a car tag; its sprite key is the lowercase tag.
All ten sprite keys exist in `car_icons.ipf` (65 sprites) and in one of the four page files.

| # | slug | HUD name key | HUD name (en) | icon sprite | atlas pages | manufacturer texture |
| --: | --- | --- | --- | --- | --- | --- |
| 1 | `opel-astraextreme-shannon` | `VEH_FULL_ASTRA_SHANNON` | Shannon's Opel Astra Extreme | `opel_astraextreme_stock` | `car_icons.ipf` + `car_icons_a.ipf` | `man_opel` |
| 7 | `renault-meganesportr26-stockgrpc` | `VEH_MOD_MEGANESPORTR26_NOVICE` | R230 F1 Team R26 | `renault_meganesportr26_stock` | `car_icons.ipf` + `car_icons_d.ipf` | `man_renault` |
| 23 | `bmw-135-stock` | `VEH_MOD_1SERIESTII_MEDIUM` | Concept 1 Series tii | `bmw_1seriestii_stock` | `car_icons.ipf` + `car_icons_d.ipf` | `man_bmw` |
| 31 | `landrover-defendersvxgrpc` | `VEH_MOD_DEFENDERSVX` | Defender SVX | `landrover_defendersvx_stock` | `car_icons.ipf` + `car_icons_d.ipf` | `man_land_rover` |
| 39 | `ford-mustang-gt500-stock1stplay` | `VEH_MOD_MUSTANGGT500_EXPERT` | Ford Shelby GT500 | `shelby_mustanggt500_stock` | `car_icons.ipf` + `car_icons_c.ipf` | `man_ford` |
| 48 | `ford-f150-offroadheh` | `VEH_MOD_F150` | F-150 SVT Raptor R (Off-Road) | `ford_f150_offroad` | `car_icons.ipf` + `car_icons_c.ipf` | `man_ford` |
| 71 | `opel-astraextreme-stockgrippy` | `VEH_MOD_ASTRAEXTREME` | Astra Extreme | `opel_astraextreme_stock` | `car_icons.ipf` + `car_icons_a.ipf` | `man_opel` |
| 21 | `renault-meganetrophy-stock` | `VEH_MOD_MEGANETROPHY` | Mégane Trophy | `renault_meganetrophy_stock` | `car_icons.ipf` + `car_icons_a.ipf` | `man_renault` |
| 24 | `landrover-lrx-stock` | `VEH_MOD_LRX` | LRX | `landrover_lrx_stock` | `car_icons.ipf` + `car_icons_c.ipf` | `man_land_rover` |
| 26 | `nissan-350z-drift` | `VEH_MOD_350Z` | 350Z (Drift) | `nissan_350z_drift` | `car_icons.ipf` + `car_icons_c.ipf` | `man_nissan` |

`hud.loc` (18,914 bytes, 101 keys) is decoded and preserved in the catalog sources but no
batch-3-specific HUD string depends on it; it is available for the V7 HUD work.

**Icon limit:** `car_icons*.ipf` is a vector package, not a DDS/PNG atlas. The tool
validates each sprite name's length prefix and records its exact byte offset in
`hud-catalog.json`; it does **not** decode or rasterise the icon. A HUD icon screenshot
therefore remains a browser/UI task.

## 5. Exact e1 roster entries for V7

Append these ten objects to `probes/e1-drive/cars/roster.json` after the batch-2 entries.
Do not edit or reorder the five A anchors. `recordId`, `recordIndex`, `layout` and `why`
come from `_work/vehicle-pipeline/cars.json` / `c-aliases.json`; the same objects are in
`_work/vehicle-pipeline/batch3/roster.json`.

```json
[
  {
    "slug": "opel-astraextreme-shannon",
    "name": "Opel_AstraExtreme_shannon",
    "recordId": 158205018,
    "recordIndex": 1,
    "layout": "RWD, 1100 kg, 6-speed",
    "why": "V3/V6 batch 3 (medium C): record 1/158205018 resolves through AmaxVehicle Opel_AstraExtreme_Stock_Shannon to \\models\\vehicles\\opel_astraextreme_stock_shannon.model; 86 draws, all 20 wheel draws preview-paired (no corner guessed)."
  },
  {
    "slug": "renault-meganesportr26-stockgrpc",
    "name": "Renault_MeganeSportR26_Stockgrpc",
    "recordId": 449674719,
    "recordIndex": 7,
    "layout": "FWD, 1300 kg, 6-speed",
    "why": "V3/V6 batch 3 (medium C): record 7/449674719 resolves through AmaxVehicle Renault_MeganeSportR26_Stock to \\models\\vehicles\\renault_meganesportr26_stock.model; 125 draws, all 20 wheel draws preview-paired (no corner guessed)."
  },
  {
    "slug": "bmw-135-stock",
    "name": "BMW_135_Stock",
    "recordId": 1100768679,
    "recordIndex": 23,
    "layout": "RWD, 1480 kg, 6-speed",
    "why": "V3/V6 batch 3 (medium C): record 23/1100768679 resolves through AmaxVehicle BMW_1SeriesTii_Stock to \\models\\vehicles\\bmw_1seriestii_stock.model; 111 draws, all 20 wheel draws preview-paired (no corner guessed)."
  },
  {
    "slug": "landrover-defendersvxgrpc",
    "name": "LandRover_DefenderSVXgrpc",
    "recordId": 1396764797,
    "recordIndex": 31,
    "layout": "AWD, 1750 kg, 6-speed",
    "why": "V3/V6 batch 3 (medium C): record 31/1396764797 resolves through AmaxVehicle LandRover_DefenderSVX_Stock to \\models\\vehicles\\landrover_defendersvx_stock.model; 85 draws, all 20 wheel draws preview-paired (no corner guessed)."
  },
  {
    "slug": "ford-mustang-gt500-stock1stplay",
    "name": "Ford_Mustang_GT500_Stock1stplay",
    "recordId": 1882476745,
    "recordIndex": 39,
    "layout": "RWD, 1495 kg, 6-speed",
    "why": "V3/V6 batch 3 (medium C): record 39/1882476745 resolves through AmaxVehicle Shelby_MustangGT500_Stock to \\models\\vehicles\\shelby_mustanggt500_stock.model; 110 draws, all 20 wheel draws preview-paired (no corner guessed)."
  },
  {
    "slug": "ford-f150-offroadheh",
    "name": "Ford_F150_OffRoadheh",
    "recordId": 2456008726,
    "recordIndex": 48,
    "layout": "AWD, 1900 kg, 6-speed",
    "why": "V3/V6 batch 3 (medium C): record 48/2456008726 resolves through AmaxVehicle Ford_F150_OffRoad to \\models\\vehicles\\ford_f150_offroad.model; 120 draws, all 20 wheel draws preview-paired (no corner guessed)."
  },
  {
    "slug": "opel-astraextreme-stockgrippy",
    "name": "Opel_AstraExtreme_Stockgrippy",
    "recordId": 3819658074,
    "recordIndex": 71,
    "layout": "RWD, 1100 kg, 6-speed",
    "why": "V3/V6 batch 3 (medium C): record 71/3819658074 resolves through AmaxVehicle Opel_AstraExtreme_Stock to \\models\\vehicles\\opel_astraextreme_stock.model; 86 draws, all 20 wheel draws preview-paired (no corner guessed)."
  },
  {
    "slug": "renault-meganetrophy-stock",
    "name": "Renault_MeganeTrophy_Stock",
    "recordId": 1036981365,
    "recordIndex": 21,
    "layout": "RWD, 900 kg, 6-speed",
    "why": "V1/V6 batch 3 (high-confidence B): exact \\models\\vehicles\\renault_meganetrophy_stock.model, 93 draws / 47 static, 8 textures, RWD."
  },
  {
    "slug": "landrover-lrx-stock",
    "name": "LandRover_LRX_Stock",
    "recordId": 1205168483,
    "recordIndex": 24,
    "layout": "AWD, 1750 kg, 6-speed",
    "why": "V1/V6 batch 3 (high-confidence B): exact \\models\\vehicles\\landrover_lrx_stock.model, 135 draws / 40 static, 7 textures, AWD."
  },
  {
    "slug": "nissan-350z-drift",
    "name": "Nissan_350Z_Drift",
    "recordId": 1289841624,
    "recordIndex": 26,
    "layout": "RWD, 1462 kg, 7-speed",
    "why": "V1/V6 batch 3 (high-confidence B): exact \\models\\vehicles\\nissan_350z_drift.model, 125 draws / 37 static, 10 textures, RWD."
  }
]
```

The four main-agent-owned integration points (roster material builder/verifier, car-texture
export and geometry pinning) must include batch 3 in the same change that lands it. Batch 2
already changes some of these files in the working tree; V7 should extend the landed form
rather than re-apply a fixed five-car count (`build_roster_materials.py`,
`verify_roster_materials.py`, `build_car_textures.py`, `build_geometry.mjs`).

## 6. Ghost and capture requirements

**Ghosts.** Batch 3 needs **20** new committed ghost files, two per car, exactly:

```text
probes/e1-drive/ghosts/<slug>-310m.json
probes/e1-drive/ghosts/<slug>-short.json
```

for the ten slugs above. They are produced by
`node probes/e1-drive/tools/verify_e1_drive.mjs --write-ghosts` from the same 310 m and
29 m scripted runs whose `stateSequenceHash` is pinned in `run.json`, and must be entered
in `probes/e1-drive/ghosts/index.json` with the existing shape (`slug`, `course`, `file`,
`bytes`, `sha256`, `ghostHash`, `timeSeconds`, `finishTick`, `tickCount`,
`countdownTicks`, `layoutHash`, `stateSequenceHash`, `source`, `sourceLabel`).

The staged plan records them as `pending-V7`; no ghost file is written or claimed by this
probe (the verifier also checks that none exists yet).

**Captures.** Minimum per car:

- `--mode sprint` on the 310 m course (finish + state hash), and on the 29 m course;
- 1600×900 screenshot, console messages **0**, no warnings;
- two runs of the same car produce the same `stateSequenceHash`.

Sampled across the batch: `--mode lap` (loop-01, 3 laps), `--mode free`, `--mode restart`,
and `--mode chunk` for the per-car package/page budget after the roster grows. The five A
anchors must not move.

## 7. Verification and hashes

Commands (bundled Python):

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/vehicle-pipeline/tools/hud_catalog.py
& $py probes/vehicle-pipeline/tools/stage_batch3.py
& $py probes/vehicle-pipeline/tools/stage_batch3.py --out-root _work/vehicle-pipeline/batch3-repeat
& $py probes/vehicle-pipeline/tools/verify_batch3.py
& $py probes/vehicle-pipeline/tools/verify_vehicle_pipeline.py
& $py probes/vehicle-pipeline/tools/verify_c_aliases.py
& $py tools/verify_asset_probe.py --skip-build
```

`verify_batch3.py` re-derives, for every car: body/wheel model hashes, manifest/mesh/
scene-report hashes, draw ownership, four wheel groups, five unique draws per group,
UV0, `scene_inspect`/`model_inspect` output, the independent material traversal,
`verify_staged_manifest.py` (with the MdlDat part dump), the HUD catalog rebuild, all 30
preview hashes, the roster/ghost/capture plan, and the second build's hashes. Result:
**PASS 912/912, 0 failures, determinism identical**.

| artifact | bytes | SHA-256 |
| --- | ---: | --- |
| `_work/vehicle-pipeline/batch3/summary.json` | 102,833 | `987b2cd220696b4d9026b4a4188e579bdde899512838c120f5c1fbd82295f2ce` |
| `_work/vehicle-pipeline/batch3/roster.json` | 10,489 | `1cd1b6b820f57690d499e42210bf00669d9c41438e52857f959892ed622c36fa` |
| `_work/vehicle-pipeline/batch3/verify.json` | 106,325 | `6c2906ee1e02094c583018beb33fe30d6b9b16cec91894207823139bcf8e03f1` |
| `_work/vehicle-pipeline/batch3/hud/hud-catalog.json` | 15,173 | `e18c48d83ba2c937ce3b2b793a85fe1753f6405d681215d125c06a59204ef9b2` |
| `_work/vehicle-pipeline/batch3-repeat/summary.json` | 103,337 | `d407f010258964a9b33912eb27e06187b266f2684e7d9aec2fd23f63e7fc9fb5` |
| `_work/logs/vehicle-pipeline/batch3-staging.log` | 3,904 | `566bc948808336a0f16593fbe50dff231c2f23b75badf5bfa0c2ca0d4e6b82f3` |
| `_work/logs/vehicle-pipeline/batch3-staging-repeat.log` | 3,932 | `46aa751a539e7e8424a89c0e895a563c84748d5208b8e671e79cca573df0f639` |
| `_work/logs/vehicle-pipeline/batch3-verify.log` | 122,346 | `65ce72e0c6768024d23746944e302945fdeefb03f62b0162571a71fcf56f80bd` |

Per-car pins for V7:

| # | slug | manifest SHA-256 | mesh SHA-256 | scene report SHA-256 |
| --: | --- | --- | --- | --- |
| 1 | `opel-astraextreme-shannon` | `96dee1f9cf00d3e62bbd5e76553be607a8b96c5bf4bdf303c58aca345a98e271` | `be5da8fbcfa43f503ca6973384449463682de2bed6c89a8c4c7b2c09dd73758e` | `221f86632244319943041512b932df57210d7ac423e264cbf7a03a3b9751a635` |
| 7 | `renault-meganesportr26-stockgrpc` | `dcb90e82b80c5424d3621a0f3c5b21f93b564cb63a24da86f0615b6ba276ea6f` | `4520292700132a6e44edf533ca21ec738aadc9dfb1e9a3a0c94d042e3555304e` | `84592cec0b27ae26620b0d96e587f711aa98e2c0ea373fd3d11ec9c92fcfb452` |
| 23 | `bmw-135-stock` | `9060fffe733faf113f3b40e1faf1f647c5a996841853142cfb182f958a5f9667` | `9d0d480adc4221602c32e1381568bae338700df780d86f86b111049b4b4415a7` | `1b85494c8475c6f9448a50765024b7c45b4a9ff05b59e4b152d9440ac3590cbf` |
| 31 | `landrover-defendersvxgrpc` | `9a256ced4e8fb400c1856a2bf51e23392b4482d09d392feb7c8039087ff248f9` | `f533d1512a31ddb8c6fe52c18ffab484af1e5e2230f63e2067b54b3c4a0163e3` | `b1f9069b4e6547c0705871dbf3b5dd9f64cfac15cdaf2bb10730edbf6e4bfd2f` |
| 39 | `ford-mustang-gt500-stock1stplay` | `d6337cac1926ead9a055da85a992fa1234dc8837bbe62a3f963d5cd57eebefb3` | `7f0faa5c592a3b58dfd7b9955737d2e2ea95c08fa501b91caa4ea576b80a5aa3` | `ddc2cb8a68312333987afbb6eef566b3c80bc298445a13842b958bf1985bfa6b` |
| 48 | `ford-f150-offroadheh` | `43ec3848e6b17c1a29c98424add8ff2e38097a3bf7bd1deb2655f8f1f1787261` | `06d4db62929a3f19aaa9d23e22fdbc7a6b0b43131217bbfc05460b8c1fd56359` | `35e88a7b058e7bb2295494339e817c7371329f576910b131f39b63eafbefea2d` |
| 71 | `opel-astraextreme-stockgrippy` | `b688ef222422f699526a4c12cdce31a5fb2c6dcd25bc11084c4e178228071741` | `2044ff32af01e5aa3faf4d856b75ffb5ed965db5f5d0cab2b02bed40115feb12` | `f5ae7944efb1d5a4d6ee7334e5c506d94e5bb0bd438e78c2a64c4ba111001d9b` |
| 21 | `renault-meganetrophy-stock` | `62b23d2ca9d50741361f4469a1bb9f7cda61e6f066c60052d63fe053af84da0d` | `e9c71b023386b5b5a7898af95951f7301671be66e239c4957f8a3360b0c808c5` | `fefc4a20e7d325d05d3163d128df14b4e55617de8561f62b5b4e0654ea147591` |
| 24 | `landrover-lrx-stock` | `14456558d3d4486cd5512ade9f63604432692b82c245bd18dd090f857306c9e5` | `84b2d71df28fbfb9da4c04cff2a9e4d1e62ccd7101a19c86bb9528eac9404821` | `c171941a1835fce1c0df3df0e2516d511fa4ce5c777179e92ef73f1fd69611c9` |
| 26 | `nissan-350z-drift` | `fd51e1271c752a6364d1d38621e34ef929b38efeaca9fa82290314a550dc71a7` | `d9e9383122fbc0391060886a1be67271176f062665c693ef42ee3973df535cd6` | `91dc9778427fa69d06b19a93d62e4c2ab9e557618155dc0b73d56b360f8319c7` |

Inputs pinned by the staging summary: `cars.json` `0fb3f567…`, `c-aliases.json`
`f40027ca…`, `amax-vehicles.jsonl` `b90879af…`, `hud-catalog.json` `e18c48d8…`,
`build_manifest.py` `9a5bf621…`, `inspect_car_materials.py` `2678bf83…`,
`scene_inspect.exe` `d542db8e…`, `model_inspect.exe` `b55ebce6…` and
`render_preview.py` `6db304b5…`. Each is re-hashed by the gate.

### 7.1 Existing gates

- `verify_vehicle_pipeline.py`: **PASS 542/542** (A 5 / B 42 / C 15 unchanged).
- `verify_c_aliases.py`: **PASS 438/438**, document hash `f40027ca…` unchanged.

### 7.2 `--skip-build` suite status

On 8 November the suite reached **44/45** in `prop-collision-v2` and stopped. The single
failure is:

```text
FAIL base input geometry current
  input drifted after the additive car batch; V1 collider replay identical
```

This is **not** a batch-3 regression. `probes/prop-collision` pins the
`_work/e1-drive/geometry.json` hash from before the additive car batch:

| value | SHA-256 |
| --- | --- |
| pinned in `_work/prop-collision/colliders-v2.json` | `a64530094750503e53e7ddfc74d0a173377bb5bb9b9a77cca3f4da3681021aab` |
| current `_work/e1-drive/geometry.json` (V5's uncommitted batch-2 build) | `2f570655bbbdb974114eb6a90de3da8a7c0a13c4193b40d7e747d98e31fcc718` |

The working tree at that moment had uncommitted batch-2 changes in
`probes/e1-drive/{cars/roster.json,ghosts/index.json,tools/*.py,web/*.js}` (records
16/18/20/22/25/30/47/63/65/75 and their ghosts). Those files are outside this task's
ownership and were not touched. All steps before the prop-collision stop, including
`vehicle-pipeline` and `vehicle-c-aliases`, passed. The suite must be re-run after V5
updates the prop-collision pins / commits batch 2; batch 3 adds no prop-collision input.

## 8. Limits

- Staged data only: no e1 roster, P52 committed materials, geometry pins, ghosts, web
  selector, chunk package or browser capture. No car is claimed drivable and no full-game
  claim is made.
- A `staged` record proves the body/wheel asset, MdlDat part layer, LOD0 mesh, scene
  report, UV0 and the independent material traversal parse and agree. It does not prove
  the runtime paint/light materials, high LODs, visibility, suspension, steering, camber
  or wheel corner identity.
- The three previews are deterministic CPU rasterisations of the staged LOD0 mesh
  (geometry only, no textures). They are not browser/GPU captures.
- IPF car icons are vector packages; only sprite names and byte offsets are proven.
- `hud.loc` is decoded and available, but batch 3's names come from `vehicles.loc` via
  exact LocIds; no UI screen layout is reverse-engineered.
- Batch 2's B set was read from the uncommitted working tree (16, 20, 30). If it changes,
  the batch-3 overlap must be re-checked.
- The `--skip-build` suite is blocked by V5's concurrent batch-2 geometry regeneration,
  as recorded in §7.2; the vehicle-pipeline and C-alias gates pass unchanged.
