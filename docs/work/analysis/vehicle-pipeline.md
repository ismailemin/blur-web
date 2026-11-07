# Vehicle pipeline audit — all 62 `RP_CarDynamics` records

**Date:** 7 November 2026
**Owner:** V1 (sub-agent), data audit only
**Scope:** new `probes/vehicle-pipeline/`, outputs under `_work/vehicle-pipeline/`, logs under `_work/logs/vehicle-pipeline/`, and this document. No change to `probes/e1-drive`, `probes/asset-reader`, `probes/car-parts`, `probes/car-materials`, the engine, `tools/`, `upstream/` or `game-data/`.

**Result:** all **62** vehicle records are classified. **5 are class A** (the committed E1 drive reference cars), **42 are class B** (exact model + Scene reader + MdlDat + physics gate + independent material traversal; not yet integrated into the drive slice), and **15 are class C** (no exact normalised model entry; the exact missing path and nearest pak entries are recorded, never guessed). The ten highest-confidence B cars have a real part manifest built outside the committed tree; no B or C car is claimed to drive. This is not a full-game claim.

## 0. Summary

| metric | value |
| --- | --- |
| records | **62** |
| physics gate pass | **62 / 62** |
| exact model mapped | **47** (`\models\vehicles\<name>.model`) |
| Scene reader parsed | **47** |
| MdlDat part layer parsed | **47** |
| independent material traversal | **47** |
| class A | **5** |
| class B | **42** |
| class C | **15** |
| next-car shortlist | **10** (7 high confidence) |
| verifier | **PASS**, 542/542 checks, 0 failures |

The only proven playable content remains the five reference cars: `corvette-zr1-stock`, `lotus-exige-cup260-stock`, `dodge-challenger-stock`, `ford-focusrs-stock`, `audi-r8v10-stock`.

## 1. Method and authority

The audit reuses committed readers and extractors; it does not re-derive any format:

| role | authority |
| --- | --- |
| record list, ids, physics values, gate | `_work/e1-drive/cars.json` + `engine/harness/t005d-vehicle/car_xt.py` (through `probes/e1-drive/tools/car_roster.py`) |
| pak entries / model bytes | `tools/inspect_asset_layout.pak_index` + `tools/prepare_asset_fixture.decode_packet_zlib` |
| model chunk tree | `_work/build/asset-reader-native/Release/model_inspect.exe` |
| first RenderList LOD0 geometry, draws, UV0 | `_work/build/asset-reader-native/Release/scene_inspect.exe` |
| part layer (MdlDat names, bounds, wheel groups) | `probes/car-parts/tools/build_manifest.py` (`parse_mdldat`) |
| draw/material/texture bindings | `tools/inspect_car_materials.py` (independent traversal) |
| proven five-car materials | `_work/car-materials/roster/` (P52 committed index) |
| proven five-car part manifests | `_work/car-parts/cars/index.json` (P29 committed index) |

A model is mapped only by the committed rule: the record name lowercased plus `.model` must match exactly one `\models\vehicles\*.model` pak entry. A near name (typo, suffix, alias) is recorded as evidence in `nearCandidates`, never used as a mapping.

### 1.1 Class definitions

| class | rule | current extraction path |
| --- | --- | --- |
| **A** | all data present and proven by the current pipeline | RP_CarDynamics → `.fields`; `.model` → car-parts manifest; P52 material/texture manifest; E1 geometry, verifier and drive captures |
| **B** | exact model, Scene reader, MdlDat and physics gate pass, and the independent material traversal resolves static albedo; not yet integrated | decoded model + Scene report + part manifest candidate + material traversal; needs roster entry, P52 committed materials, geometry pins and drive verification |
| **C** | blocked before extraction: no exact model entry (or a reader failure) | nothing is extracted or guessed; the exact expected path and nearest pak candidates are recorded |

### 1.2 Byte definitions

- **model bytes** — pak `logical_bytes` of the decoded `.model` (47 mapped records).
- **mesh bytes** — first RenderList LOD0 positions as float32 (3 × 4 B/vertex).
- **index bytes** — LOD0 U32 triangle-list indices (3 × 4 B/triangle).
- **UV0 bytes** — the full UV0 stream (2 × 4 B/vertex, including zero placeholders); **valid UV0 bytes** count only vertices the reader marks valid.
- **texture source bytes** — unique referenced shared/resource textures (descriptor + complete mip chain at the highest populated LOD within the committed 512×512 bound).
- **texture RGBA bytes** — for A, the exact P52 decoded RGBA total; for B, an upper-bound estimate (`width × height × 4`) for the same bounded LOD. It is not a decoded artifact.

## 2. The 62-record matrix

`draws` / `static` / `tex` / `WG` are the committed Scene draw count, independently resolved static-albedo draws, unique referenced textures, and MdlDat wheel-group count. C records have no model, so those cells are `—`. `next` marks the ten shortlisted B cars.

| # | record | class | drive | mass (kg) | model (short) | draws | static | tex | WG | next |
|--:|---|---|---|---:|---|---:|---:|---:|---:|---|
| 1 | Opel_AstraExtreme_shannon | C | RWD | 1100 | **missing** | — | — | — | — |  |
| 2 | Audi_S3_Stock | B | AWD | 1400 | audi_s3_stock.model | 99 | 49 | 7 | 4 | yes |
| 5 | BMW_1SeriesTii_Race | B | RWD | 900 | bmw_1seriestii_race.model | 116 | 43 | 7 | 4 |  |
| 6 | Ford_FocusRS_Race | B | FWD | 1100 | ford_focusrs_race.model | 110 | 36 | 7 | 4 |  |
| 7 | Renault_MeganeSportR26_Stockgrpc | C | FWD | 1300 | **missing** | — | — | — | — |  |
| 8 | DefaultCar | C | RWD | 1195 | **missing** | — | — | — | — |  |
| 9 | Dodge_Challenger_Stock | A | RWD | 1700 | dodge_challenger_stock.model | 104 | 42 | 7 | 4 |  |
| 10 | Audi_TT_Stock | B | AWD | 1400 | audi_tt_stock.model | 100 | 52 | 7 | 4 | yes |
| 13 | Ford_F100_OffRoad | B | AWD | 1600 | ford_f100_offroad.model | 78 | 34 | 7 | 4 | yes |
| 15 | Lotus_ExigeCup260_Stock | A | RWD | 890 | lotus_exigecup260_stock.model | 88 | 48 | 9 | 4 |  |
| 16 | BMW_M3E92_Tuner | B | RWD | 1462 | bmw_m3e92_tuner.model | 94 | 54 | 8 | 4 |  |
| 17 | Volkswagen_GolfW12650_Stock | B | RWD | 1600 | volkswagen_golfw12650_stock.model | 92 | 43 | 8 | 4 | yes |
| 18 | Dodge_Challanger_Tuner1stplay | C | RWD | 1600 | **missing** | — | — | — | — |  |
| 19 | Ford_Bronco_OffRoad | B | AWD | 1650 | ford_bronco_offroad.model | 82 | 25 | 6 | 4 | yes |
| 20 | Koenigsegg_CCXR_Stock | B | RWD | 1179 | koenigsegg_ccxr_stock.model | 97 | 63 | 9 | 4 |  |
| 21 | Renault_MeganeTrophy_Stock | B | RWD | 900 | renault_meganetrophy_stock.model | 93 | 47 | 8 | 4 |  |
| 22 | Nissan_350ZNismo_Stock grpc | C | RWD | 1462 | **missing** | — | — | — | — |  |
| 23 | BMW_135_Stock | C | RWD | 1480 | **missing** | — | — | — | — |  |
| 24 | LandRover_LRX_Stock | B | AWD | 1750 | landrover_lrx_stock.model | 135 | 40 | 7 | 4 |  |
| 25 | Chevrolet_Camaro_StockE3 | C | RWD | 1462 | **missing** | — | — | — | — |  |
| 26 | Nissan_350Z_Drift | B | RWD | 1462 | nissan_350z_drift.model | 125 | 37 | 10 | 4 |  |
| 27 | BMW_X548MSport_Stock | B | AWD | 2200 | bmw_x548msport_stock.model | 91 | 46 | 8 | 4 |  |
| 28 | Chevrolet_CamaroSS_Stock | B | RWD | 1700 | chevrolet_camaross_stock.model | 122 | 35 | 8 | 4 |  |
| 29 | Nissan_Navara_Rat | B | AWD | 1850 | nissan_navara_rat.model | 75 | 44 | 8 | 4 |  |
| 30 | Toyota_SupraTRD_Stock | B | RWD | 1565 | toyota_supratrd_stock.model | 88 | 53 | 7 | 4 |  |
| 31 | LandRover_DefenderSVXgrpc | C | AWD | 1750 | **missing** | — | — | — | — |  |
| 33 | Dodge_ViperACR_Stock | B | RWD | 1500 | dodge_viperacr_stock.model | 83 | 48 | 7 | 4 | yes |
| 35 | Bowler_Nemesis_Stock | B | AWD | 1300 | bowler_nemesis_stock.model | 84 | 45 | 9 | 4 |  |
| 36 | Vauxhall_MonaroVXR_Drift | B | RWD | 1600 | vauxhall_monarovxr_drift.model | 104 | 35 | 7 | 4 |  |
| 37 | Corvette_ZR1_Stock | A | RWD | 1600 | corvette_zr1_stock.model | 100 | 50 | 9 | 4 |  |
| 38 | RatRod_NA_Stock | B | RWD | 1462 | ratrod_na_stock.model | 51 | 23 | 6 | 4 |  |
| 39 | Ford_Mustang_GT500_Stock1stplay | C | RWD | 1495 | **missing** | — | — | — | — |  |
| 40 | Foose_69_Stock | B | RWD | 1395 | foose_69_stock.model | 98 | 37 | 8 | 4 |  |
| 41 | Corvette_C3_Drag | B | RWD | 1300 | corvette_c3_drag.model | 65 | 24 | 5 | 4 |  |
| 42 | Ford_F100_Rat | B | RWD | 1650 | ford_f100_rat.model | 74 | 44 | 8 | 4 |  |
| 43 | Chevrolet_CamaroSS_Drag | B | RWD | 1300 | chevrolet_camaross_drag.model | 107 | 36 | 7 | 4 |  |
| 46 | Nissan_SkylineR34ZTune_Stock | B | AWD | 1600 | nissan_skyliner34ztune_stock.model | 96 | 46 | 7 | 4 | yes |
| 47 | VW_Beetle_Offroad | C | RWD | 660 | **missing** | — | — | — | — |  |
| 48 | Ford_F150_OffRoadheh | C | AWD | 1900 | **missing** | — | — | — | — |  |
| 50 | Ford_FocusRS_Stock | A | FWD | 1400 | ford_focusrs_stock.model | 115 | 37 | 7 | 4 |  |
| 51 | Volkswagen_Scirocco_24 | B | FWD | 1100 | volkswagen_scirocco_24.model | 85 | 54 | 9 | 4 |  |
| 52 | Nissan_Navara_OffRoad | B | AWD | 1750 | nissan_navara_offroad.model | 73 | 47 | 8 | 4 |  |
| 55 | Audi_R8V10_Stock | A | AWD | 1600 | audi_r8v10_stock.model | 84 | 47 | 8 | 4 |  |
| 57 | Volkswagen_Beetle_Rat | B | RWD | 700 | volkswagen_beetle_rat.model | 94 | 42 | 6 | 4 |  |
| 58 | Hummer_H2_Rat | B | AWD | 2500 | hummer_h2_rat.model | 82 | 22 | 7 | 4 |  |
| 59 | BMW_M3E92_Drift | B | RWD | 1462 | bmw_m3e92_drift.model | 101 | 48 | 9 | 4 |  |
| 60 | Hummer_H2_OffRoad | B† | AWD | 2500 | hummer_h2_offroad.model | 98 | 23 | 6 | 4 | staged |
| 61 | Dodge_Challenger_Race | B | RWD | 1450 | dodge_challenger_race.model | 99 | 32 | 7 | 4 |  |
| 62 | ACSchnitzer_ACS1Coupe_Stock | B | RWD | 1480 | acschnitzer_acs1coupe_stock.model | 108 | 36 | 7 | 4 |  |
| 63 | Foose_Stallion_Stockgrpc | C | RWD | 1495 | **missing** | — | — | — | — |  |
| 65 | Chevrolet_Camaro_Ratdrift | C | RWD | 1395 | **missing** | — | — | — | — |  |
| 67 | Ford_Supervan_Stock | B | RWD | 890 | ford_supervan_stock.model | 79 | 65 | 9 | 4 |  |
| 68 | Corvette_C3_Race | B | RWD | 1400 | corvette_c3_race.model | 80 | 26 | 6 | 4 |  |
| 69 | Hennessey_ViperVenom1000Coupe_Stock | B | RWD | 1500 | hennessey_vipervenom1000coupe_stock.model | 86 | 45 | 9 | 4 |  |
| 71 | Opel_AstraExtreme_Stockgrippy | C | RWD | 1100 | **missing** | — | — | — | — |  |
| 73 | Ford_GT_Stock | B | RWD | 1573 | ford_gt_stock.model | 114 | 95 | 9 | 4 |  |
| 74 | Chevrolet_SoCalHHR_Stock | B | RWD | 1350 | chevrolet_socalhhr_stock.model | 85 | 64 | 8 | 4 | yes |
| 75 | Covette_C3_Rat | C | RWD | 1300 | **missing** | — | — | — | — |  |
| 77 | Ford_FR100_Stock | B | RWD | 1350 | ford_fr100_stock.model | 71 | 33 | 8 | 4 | yes |
| 78 | Dodge_ViperGTSR_Stock | B | RWD | 1400 | dodge_vipergtsr_stock.model | 91 | 51 | 8 | 4 |  |
| 79 | Toyota_Supra_Smooth | B | RWD | 1400 | toyota_supra_smooth.model | 84 | 49 | 7 | 4 |  |
| 80 | Ford_MustangGTR_Stock | B | RWD | 1300 | ford_mustanggtr_stock.model | 101 | 55 | 7 | 4 | yes |

† `Hummer_H2_OffRoad` has no brake-caliper element. The part builder now records
a typed `caliper:"absent"` per wheel group (three proven members, no invented
mesh) and a staged manifest exists outside the E1 roster; `staged` is not a
shortlist entry. See §7.1 and `docs/work/analysis/vehicle-hummer-parts.md`.

## 3. Class A — the five proven reference cars

These are the only cars with the full chain: committed `.fields`, committed car-parts manifest/mesh, P52 material/texture manifest, E1 geometry pins, scripted sprint/lap/free-roam runs and browser captures. Their hashes are the reference for any new car.

| slug | record (index/id) | drivetrain | mass | draws | static | textures | RGBA bytes | P52 manifest SHA-256 |
|---|---|---|---:|---:|---:|---:|---:|---|
| `dodge-challenger-stock` | 9 / 528964602 | RWD | 1700 | 104 | 42 | 7 | 2,637,824 | `cf9f6480b7443b4fa64d9f439974a886e9934857121dc979585f22f66f0b7d26` |
| `lotus-exige-cup260-stock` | 15 / 805568925 | RWD | 890 | 88 | 48 | 9 | 4,997,120 | `0d1dc5af17f214ebe5500b4104c7354d14cf5c53c0ca75f4eb9f044351a404ee` |
| `corvette-zr1-stock` | 37 / 1554942492 | RWD | 1600 | 100 | 50 | 9 | 4,538,368 | `c658a587a7e6b3d0a0ea89ac47257e0c175d0323f19c0e4173ba5cdcb140a512` |
| `ford-focusrs-stock` | 50 / 2563977008 | FWD | 1400 | 115 | 37 | 7 | 3,424,256 | `2ca91ffd8b3ceb746f26e31aef6a3795757b6c99260f9a92ba00b7bbd8bacb0c` |
| `audi-r8v10-stock` | 55 / 2936683857 | AWD | 1600 | 84 | 47 | 8 | 2,580,480 | `4ee7b76184049293a320825719ed039f49cd16cd238f0b39ea4a6166834ab2e4` |

The committed car-parts index is `_work/car-parts/cars/index.json` (`sha256:5042e714a309e28e19498a0d35e18fef941c0fac850e87bc0f986117bb9bc315`); the P52 index is `_work/car-materials/roster/index.json` (`sha256:77e73bfff8e324459d337f9ec1817f717e39aabfe0134433ca886c2a1774cd76`).

## 4. Class C — blocked records and exact missing data

Each C record has **zero** exact matches for `\models\vehicles\<normalised name>.model`. The nearest pak models are listed only to show what a future, documented alias rule could consider; they are not mappings and no bytes were extracted for these records.

| # | record | drive | mass | exact path expected (missing) | nearest pak models (evidence only) |
|--:|---|---|---:|---|---|
| 1 | Opel_AstraExtreme_shannon | RWD | 1100 | `\models\vehicles\opel_astraextreme_shannon.model` | `opel_astraextreme_stock_shannon.model` (0.893), `opel_astraextreme_stock.model` (0.833), `opel_astra_extreme_legend_viii.model` (0.691) |
| 7 | Renault_MeganeSportR26_Stockgrpc | FWD | 1300 | `\models\vehicles\renault_meganesportr26_stockgrpc.model` | `renault_meganesportr26_stock.model` (0.933), `renault_meganesportr26_stock_shannon.model` (0.824), `renault_meganetrophy_stock.model` (0.759) |
| 8 | DefaultCar | RWD | 1195 | `\models\vehicles\defaultcar.model` | `default.model` (0.824), `chevrolet_camaro_rat.model` (0.400), `chevrolet_camaro_stock.model` (0.375) |
| 18 | Dodge_Challanger_Tuner1stplay | RWD | 1600 | `\models\vehicles\dodge_challanger_tuner1stplay.model` | `dodge_challenger_tuner.model` (0.824), `dodge_challenger_stock.model` (0.706), `dodge_challenger_race.model` (0.680) |
| 22 | Nissan_350ZNismo_Stock grpc | RWD | 1462 | `\models\vehicles\nissan_350znismo_stock grpc.model` | `nissan_350znismo_stock.model` (0.898), `nissan_350z_drift.model` (0.591), `nissan_skyliner34ztune_stock.model` (0.582) |
| 23 | BMW_135_Stock | RWD | 1480 | `\models\vehicles\bmw_135_stock.model` | `bmw_1seriestii_stock.model` (0.667), `bmw_x548msport_stock.model` (0.667), `audi_s3_stock.model` (0.615) |
| 25 | Chevrolet_Camaro_StockE3 | RWD | 1462 | `\models\vehicles\chevrolet_camaro_stocke3.model` | `chevrolet_camaro_stock.model` (0.957), `chevrolet_camaross_stock.model` (0.917), `chevrolet_camaross_stock_rymer.model` (0.852) |
| 31 | LandRover_DefenderSVXgrpc | AWD | 1750 | `\models\vehicles\landrover_defendersvxgrpc.model` | `landrover_defendersvx_stock.model` (0.846), `landrover_lrx_stock.model` (0.591), `vauxhall_monarovxr_legend_iv.model` (0.453) |
| 39 | Ford_Mustang_GT500_Stock1stplay | RWD | 1495 | `\models\vehicles\ford_mustang_gt500_stock1stplay.model` | `ford_mustanggtr_stock.model` (0.769), `shelby_mustanggt500_stock.model` (0.679), `ford_gt_stock.model` (0.591) |
| 47 | VW_Beetle_Offroad | RWD | 660 | `\models\vehicles\vw_beetle_offroad.model` | `volkswagen_beetle_offroad.model` (0.809), `volkswagen_beetle_rat.model` (0.632), `ford_bronco_offroad.model` (0.556) |
| 48 | Ford_F150_OffRoadheh | AWD | 1900 | `\models\vehicles\ford_f150_offroadheh.model` | `ford_f150_offroad.model` (0.919), `ford_f100_offroad.model` (0.865), `ford_bronco_offroad.model` (0.667) |
| 63 | Foose_Stallion_Stockgrpc | RWD | 1495 | `\models\vehicles\foose_stallion_stockgrpc.model` | `foose_stallion_stock.model` (0.909), `foose_stallion_stock_khan.model` (0.816), `foose_69_stock.model` (0.632) |
| 65 | Chevrolet_Camaro_Ratdrift | RWD | 1395 | `\models\vehicles\chevrolet_camaro_ratdrift.model` | `chevrolet_camaro_rat.model` (0.889), `chevrolet_camaross_drag.model` (0.792), `chevrolet_camaro_stock.model` (0.766) |
| 71 | Opel_AstraExtreme_Stockgrippy | RWD | 1100 | `\models\vehicles\opel_astraextreme_stockgrippy.model` | `opel_astraextreme_stock.model` (0.885), `opel_astraextreme_stock_shannon.model` (0.767), `opel_astra_extreme_legend_viii.model` (0.678) |
| 75 | Covette_C3_Rat | RWD | 1300 | `\models\vehicles\covette_c3_rat.model` | `corvette_c3_rat.model` (0.966), `corvette_c3_drag.model` (0.867), `corvette_c3_race.model` (0.867) |

Notable naming splits: `Covette_C3_Rat` is a one-letter typo for `corvette_c3_rat.model`; `Chevrolet_Camaro_StockE3` vs `chevrolet_camaro_stock.model`; `Ford_Mustang_GT500_Stock1stplay` vs `shelby_mustanggt500_stock.model`; `Nissan_350ZNismo_Stock grpc` contains a space; `DefaultCar` vs `default.model`. `BMW_135_Stock` has no close pak model at all (best similarity 0.667, a different BMW). Resolving any of these is a content/naming decision for the main agent, not a reader change.

### 4.1 C alias resolution (V3, 8 November 2026)

Of the **15** C records, **14 are provable** and **1 remains unsupported**. The rule is not name similarity: `AmaxVehicle.dynamics` in `\gamedata\xt\amax.bin` is a `FlaskHandle` that resolves through the XT `refs` table to the exact `RP_CarDynamics` record id. The shipped engine builds the body path from that vehicle's tag (`LevelState.cpp:334`, `RaceLogicCore.cpp:1489`) and the wheel path from `wheelModel->fileName` (`LevelState.cpp:360`). A record is `provable` only when the handle id matches, the tag model and wheel model exist in `root.pak`, and the vehicle is `use=true` (an unused/missing body is replaced by the Shelby fallback, `LevelState.cpp:339-345`).

| # | record | status | AmaxVehicle identity (ref) | intended body model | name sim | staging |
|--:|---|---|---|---|---:|---|
| 1 | Opel_AstraExtreme_shannon | **provable** | `Opel_AstraExtreme_Stock_Shannon` (201) | `\models\vehicles\opel_astraextreme_stock_shannon.model` | 0.8929 | loads 86d / 28p / 4 WG / 30800 UV0 / 11 tex |
| 7 | Renault_MeganeSportR26_Stockgrpc | **provable** | `Renault_MeganeSportR26_Stock` (552) | `\models\vehicles\renault_meganesportr26_stock.model` | 0.9333 | loads 125d / 38p / 4 WG / 23128 UV0 / 7 tex |
| 8 | DefaultCar | **unsupported** | none | **none** | — | unsupported |
| 18 | Dodge_Challanger_Tuner1stplay | **provable** | `Dodge_Challenger_Tuner` (1211) | `\models\vehicles\dodge_challenger_tuner.model` | 0.8235 | loads 93d / 30p / 4 WG / 20541 UV0 / 8 tex |
| 22 | Nissan_350ZNismo_Stock grpc | **provable** | `Nissan_350ZNismo_Stock` (1332) | `\models\vehicles\nissan_350znismo_stock.model` | 0.8980 | loads 123d / 32p / 4 WG / 19172 UV0 / 8 tex |
| 23 | BMW_135_Stock | **provable** | `BMW_1SeriesTii_Stock` (1358) | `\models\vehicles\bmw_1seriestii_stock.model` | 0.6667 | loads 111d / 26p / 4 WG / 13374 UV0 / 9 tex |
| 25 | Chevrolet_Camaro_StockE3 | **provable** | `Chevrolet_Camaro_Stock` (1569) | `\models\vehicles\chevrolet_camaro_stock.model` | 0.9565 | loads 100d / 30p / 4 WG / 19569 UV0 / 7 tex |
| 31 | LandRover_DefenderSVXgrpc | **provable** | `LandRover_DefenderSVX_Stock` (1732) | `\models\vehicles\landrover_defendersvx_stock.model` | 0.8462 | loads 85d / 30p / 4 WG / 21288 UV0 / 7 tex |
| 39 | Ford_Mustang_GT500_Stock1stplay | **provable** | `Shelby_MustangGT500_Stock` (2333) | `\models\vehicles\shelby_mustanggt500_stock.model` | 0.6786 | loads 110d / 32p / 4 WG / 19677 UV0 / 7 tex |
| 47 | VW_Beetle_Offroad | **provable** | `Volkswagen_Beetle_OffRoad` (2931) | `\models\vehicles\volkswagen_beetle_offroad.model` | 0.8095 | loads 85d / 18p / 4 WG / 21991 UV0 / 8 tex |
| 48 | Ford_F150_OffRoadheh | **provable** | `Ford_F150_OffRoad` (3042) | `\models\vehicles\ford_f150_offroad.model` | 0.9189 | loads 120d / 34p / 4 WG / 15578 UV0 / 7 tex |
| 63 | Foose_Stallion_Stockgrpc | **provable** | `Foose_Stallion_Stock` (4357) | `\models\vehicles\foose_stallion_stock.model` | 0.9091 | loads 103d / 27p / 4 WG / 19012 UV0 / 8 tex |
| 65 | Chevrolet_Camaro_Ratdrift | **provable** | `Chevrolet_Camaro_Rat` (4491) | `\models\vehicles\chevrolet_camaro_rat.model` | 0.8889 | loads 99d / 32p / 4 WG / 17622 UV0 / 8 tex |
| 71 | Opel_AstraExtreme_Stockgrippy | **provable** | `Opel_AstraExtreme_Stock` (4716) | `\models\vehicles\opel_astraextreme_stock.model` | 0.8846 | loads 86d / 28p / 4 WG / 30800 UV0 / 10 tex |
| 75 | Covette_C3_Rat | **provable** | `Corvette_C3_Rat` (4963) | `\models\vehicles\corvette_c3_rat.model` | 0.9655 | loads 83d / 27p / 4 WG / 16687 UV0 / 8 tex |

**DefaultCar** is the only unsupported C record: no `AmaxVehicle` handle in `amax.bin` resolves to its id `515172551`; the nearest file `\models\vehicles\default.model` is a 78,602-byte placeholder (median real car body 4,615,848 bytes) and is not a body reference.

The 14 provable records stage-load through the committed car-parts builder, Scene and material passes; results are in `_work/vehicle-pipeline/c-staging-results.json`. Detail, per-record evidence, source citations and the 438-check verifier: [`vehicle-c-aliases.md`](vehicle-c-aliases.md). No C car is in the drive roster.

## 5. Physics fields — what differs per car

All **62** records decode with the committed `car_xt.py` extractor and pass the completeness gate (positive mass/wheelbase/track/tyre radius/limiter/torque/gear/final/brake; ≥2 gears, torque points and grip points; valid top gear; drive type 0/1/2; all values finite). There are **no missing or extra schema field names** versus the reference Corvette ZR1 record.

| property | distribution |
| --- | --- |
| field lines | 181 (19), 182 (7), 183 (9), 184 (7), 185 (11), 186 (7), 188 (2) |
| gear ratios | 6 gears (59 records), 7 gears (3: `BMW_M3E92_Tuner`, `Nissan_350Z_Drift`, `BMW_M3E92_Drift`) |
| torque points | 10 on all 62 |
| front / rear grip points | 3 / 3 on all 62 |
| drivetrains | RWD 43, AWD 15, FWD 4 |
| mass | 660–2,500 kg (median 1,462) |
| wheelbase | 2.000–3.584 m (median 2.694) |
| torque scale | 355–1,550 Nm (median 630) |
| limiter | 4,500–14,000 RPM (median 7,000) |
| final drive | 2.115–5.000 (median 3.500) |
| front / rear brake force | 1.0 / 0.725–1.5 |

Every record's full physics vector (mass, inertia scales, track, tyre radii, gear ratios, torque curve, limiter, brakes, grip counts) is in `_work/vehicle-pipeline/cars.json` → `records[].physics.values`; the `.fields` copies are the exact T-005d field lists.

The line-count spread is therefore the per-record gear-ratio cardinality (and the resulting expanded indices), not a missing field. The three 7-gear cars are the only physics outliers; all other arrays are constant.

## 6. What 'all cars' needs

| quantity | value |
| --- | ---: |
| records | 62 |
| A / B / C | 5 / 42 / 15 |
| exact models (A+B) | 47 |
| model logical bytes (47) | 211,607,775 |
| LOD0 position bytes (47) | 18,598,152 |
| LOD0 index bytes (47) | 19,155,228 |
| UV0 stream bytes (47) | 12,398,768 |
| UV0 valid bytes (47) | 8,265,592 |
| referenced texture source bytes (47) | 26,855,696 |
| referenced texture RGBA bytes (A exact + B bounded estimate) | 139,327,488 |

Interpretation: **47 of 62** records can enter the existing geometry/material path today with no format work; **15** are C records under the exact model-name rule (V3's §4.1 resolves 14 of them by record-level identity; see that addendum). The `Hummer_H2_OffRoad` part-layer blocker is resolved as a typed absent brake caliper: the builder keeps each wheel group valid with its three proven members and records `caliper:"absent"`; its staged manifest is outside the E1 roster and outside the ten-car shortlist. The totals above are for the 47 exact-mapped models; the 15 C records contribute zero bytes because nothing is extracted for them. Reaching 62/62 therefore needs the documented alias/record decisions plus 42 B integrations, not new binary readers.

## 7. Next cars, ranked by confidence

The shortlist is the top of the B set after building a real part manifest with the committed builder into `_work/vehicle-pipeline/manifests/`. A **high** car has at least one proven wheel draw; a **medium** car has all 20 wheel draws preview-paired (the manifest is still complete and every draw is owned once). No drive claim is made until the integration commands in §8 run.

| # | car | drive | mass | model bytes | draws | static | tex | parts | proven / ambiguous wheel draws | tier | conf | manifest SHA-256 |
|--:|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---|
| 10 | `audi-tt-stock` | AWD | 1400 | 4,013,370 | 100 | 52 | 7 | 39 | 6 / 14 | union | high | `sha256:35f8fd2b65c163aaddfdc82316ec49b295e2644c16032b162dc5208289e760a9` |
| 13 | `ford-f100-offroad` | AWD | 1600 | 4,140,539 | 78 | 34 | 7 | 24 | 4 / 16 | union | high | `sha256:b3dd04cfeec35863566844639ed99e2ca532c4f039c8acab13d38a326d9748b5` |
| 77 | `ford-fr100-stock` | RWD | 1350 | 4,208,696 | 71 | 33 | 8 | 23 | 4 / 16 | union | high | `sha256:f488ee91b05cb43e5de264a044a1f0e951615ba86b05293589681f8e57746903` |
| 17 | `volkswagen-golfw12650-stock` | RWD | 1600 | 4,174,366 | 92 | 43 | 8 | 26 | 12 / 8 | union | high | `sha256:d20011b972f0fca21f97e98abf0eb25948c232703f2a5ba0f1b819b29882a344` |
| 80 | `ford-mustanggtr-stock` | RWD | 1300 | 4,182,608 | 101 | 55 | 7 | 21 | 6 / 14 | union | high | `sha256:b43bd39f627596ec710c743c5a90f352705077bd67c511818cf73d7a240f263c` |
| 33 | `dodge-viperacr-stock` | RWD | 1500 | 4,413,638 | 83 | 48 | 7 | 30 | 16 / 4 | union | high | `sha256:2188f58cb16e5e7e6fc6f1160d9cdd1ad62b5d71ee809790125cdc9ac0f6de08` |
| 2 | `audi-s3-stock` | AWD | 1400 | 4,343,421 | 99 | 49 | 7 | 37 | 4 / 16 | union | high | `sha256:9cbbe10800ce78d83af6f22c5340b7a5f7fc0e1f451a6d054f2da6bcf26406e4` |
| 19 | `ford-bronco-offroad` | AWD | 1650 | 4,201,546 | 82 | 25 | 6 | 23 | 0 / 20 | union | medium | `sha256:8a08be108409cc7da45015126fae6be0978aa7bd091aaf53578a42cee12ffd77` |
| 46 | `nissan-skyliner34ztune-stock` | AWD | 1600 | 4,299,980 | 96 | 46 | 7 | 32 | 0 / 20 | union | medium | `sha256:deb7dc6d238e52f811a38e7e3a77c4940fc95e1ab72218cc0beb0bec425fcda5` |
| 74 | `chevrolet-socalhhr-stock` | RWD | 1350 | 4,356,399 | 85 | 64 | 8 | 26 | 0 / 20 | union | medium | `sha256:6b498cd155c7de349a0248b157446fcce6ef090ea3b144280b3162c53ef05beb` |

Expected addition per car: one decoded body model and one part manifest/mesh; one RP_CarDynamics field list from the same record; one P52-style material/texture pass (the independent traversal already resolves the static-albedo and texture counts above); one body entry in `geometry.json` with the main-agent pins. The full per-car list is in `_work/vehicle-pipeline/cars.json` → `nextCars`.

One B car is **not** on the shortlist: `Hummer_H2_OffRoad` (record 60) passes the model, Scene, MdlDat, physics and material checks, but its front wheel group lacked a `brakeCaliper` member. That blocker is now resolved as a typed absence; its staged manifest is complete but it is not an E1 roster entry and is not counted in the ten-car shortlist above.

### 7.1 Hummer H2 OffRoad — typed absent brake caliper (staged resolution)

The asset genuinely has no caliper node. `hummer_h2_offroad.model` (SHA-256
`0e7f968b…d29869`) has 80 MdlDat elements and 21 models; model 0 `DefaultModel`
has 58 elements, 4 `e_wheel_*` parents and only 12 wheel members: 4 `e_tyre_*`,
4 `e_alloyRim_*` and 4 `E_BrakeDisc_*` (three per corner). No element name
contains `caliper`, and no caliper is hidden under another parent or model. The
separate `\models\vehicles\wheels\hummer_h2_offroad.model` resource has only
`m_Alloy`/`e_alloyblur` rim geometry; no caliper model exists in the pak.

The `cali_01` texture in the material traversal is **not** caliper evidence: its
two draws (42 and 87, 10 triangles each) are fully contained by
`e_licenseplate_back` and `e_licenseplate_front`, at Z ≈ −2.35 and +2.38. It is a
license-plate texture. The four `breakdisc` draws (35–38) are thin symmetric
discs inside the four `E_BrakeDisc_*` elements; no draw is attributable to a
caliper.

For comparison, the five proven reference cars each have 16 wheel elements:
4 tyre + 4 rim + 4 disc + 4 caliper, with every caliper a direct child of its
`e_wheel_*` parent. The sibling `hummer_h2_rat.model` also contains
`E_BrakeCaliper_*` elements (four by name, though one is a `DefaultElement`
child and its front-left corner lacks disc/caliper), proving the vehicle family
can carry caliper nodes. The OffRoad asset is therefore missing them, not
renaming them.

The committed builder now accepts exactly this case: when model 0 has **zero**
`e_brakecaliper_*` elements, a three-member wheel group is valid and records
`caliper:"absent"` plus `absentMembers:[{wheelPart:"brakeCaliper", …}]` and
`diagnostics.absentWheelParts`. No caliper mesh is invented, borrowed or
substituted; a renamed or differently parented caliper still fails.

Staged result (`_work/vehicle-pipeline/manifests/hummer-h2-offroad/`):
98 draws, 36 parts (4 wheel groups + 32 non-wheel), 4 wheel groups, 16 wheel
draws (8 tyre, 4 rim, 4 disc, 0 caliper), 82 proven draws and 16 preview-only
wheel draws. UV0 is available on 7 of 11 global vertex buffers (11,783 valid
vertices; 58/98 draws with UV0), and the independent material traversal resolves
6 unique textures and 23 static-albedo draws. Manifest SHA-256
`7f4166c5…a56d`, mesh SHA-256 `7d593ceb…954f`.

Verification: the staged verifier passes with 0 failures; two independent builds
are byte-identical; a present-caliper regression rebuild (Audi R8) reproduces its
committed manifest hash exactly. The vehicle-pipeline verifier still reports
PASS 542/542. Full detail and hashes: `docs/work/analysis/vehicle-hummer-parts.md`.

Batch 2 may take this car (manifest complete, typed absence, deterministic), but
the wheel corner identity is preview-only (16 ambiguous, 0 proven, the same
medium-confidence tier as Bronco/Skyline/SoCalHHR). It still needs the roster
entry, P52 committed materials, geometry pins, ghosts and browser capture; no
drive or full-game claim is made.

## 8. Exact pipeline to add one B car

The data commands are generic, but four integration points are still hard-coded to the current five cars and are **main-agent owned**. They must be updated in the same change or the gate will reject the enlarged roster:

- `probes/car-materials/tools/build_roster_materials.py` line ~359: `len(index.get('mapped', [])) != 5` → the new car count.
- `probes/car-materials/tools/verify_roster_materials.py` line ~274: `carCount != 5` → the new car count.
- `probes/e1-drive/tools/build_car_textures.py`: `COMMITTED_ROSTER_INDEX` is the P52 five-car index hash; update it to the new P52 index hash.
- `probes/e1-drive/tools/build_geometry.mjs`: `COMMITTED_MANIFESTS` (one SHA-256 per car), `COMMITTED_CAR_INDEX` and `COMMITTED_CAR_TEXTURES` must be extended to the new committed artifacts.

Then run, from the repository root, using the bundled Python/Node:

```powershell
$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

# 1. main-agent owned: append the B car to probes/e1-drive/cars/roster.json
#    { slug, name, recordId, recordIndex, layout, why }
#    recordId/recordIndex and the model path come from this audit (cars.json).

# 2. decode the record into _work/e1-drive/cars/<slug>.fields + refresh cars.json
& $py probes/e1-drive/tools/car_roster.py

# 3. build the real body manifest/mesh for every roster car
& $py probes/car-parts/tools/build_all_manifests.py

# 4. rebuild the P52 material/texture manifests for the enlarged roster
& $py probes/car-materials/tools/build_roster_materials.py
& $py probes/car-materials/tools/verify_roster_materials.py

# 5. export the E1 car textures/UV0 for the enlarged roster
& $py probes/e1-drive/tools/build_car_textures.py

# 6. main-agent owned pins updated, then rebuild geometry and regenerate ghosts
& $node probes/e1-drive/tools/build_geometry.mjs
& $node probes/e1-drive/tools/verify_e1_drive.mjs --write-ghosts
& $node probes/e1-drive/tools/verify_e1_drive.mjs

# 7. portable gate + browser capture
& $py tools/verify_asset_probe.py --skip-build
& $node probes/e1-drive/tools/capture_browser.mjs --mode sprint
```

The ghost step matters: `verify_e1_drive.mjs` compares `ghosts/index.json` and the ten committed reference files (5 cars × 310 m / 29 m). Adding a car requires `--write-ghosts` and the resulting committed files for the new car. The browser car selector reads the generated roster, so no `web/cars.js` edit is needed once the roster is enlarged.

## 9. Verification, hashes and evidence

`probes/vehicle-pipeline/tools/verify_vehicle_pipeline.py` re-runs the committed readers against the artifact and reports **PASS** with **542/542** checks and **0** failures. It re-decodes every `.fields` file byte-identically, re-hashes every decoded model, reproduces the Scene report and chunk tree for all 47 mapped models, re-runs three sample material traversals, and checks all ten next-car manifests and the CSV/hash documents.

| artifact | bytes | SHA-256 |
| --- | ---: | --- |
| `_work/vehicle-pipeline/cars.json` | 503,096 | `0fb3f56753ab12c56062ba559843f527081cbed354ac2cc61b71fe3c507e3e4d` |
| `_work/vehicle-pipeline/summary.csv` | 16,199 | `1082f4feb6f7776bfa5071c7c0f0afb5463bea46cd6001f2fd4fd238f063d5cb` |
| `_work/vehicle-pipeline/hashes.json` | 19,777 | `abd5e7a78fad0cbc913360d754a0623f0769d0d1225ce4fba6d06c8a529bf1e1` |
| `_work/vehicle-pipeline/verify.json` | 62,858 | `938f3aae57f79ec52bfb7618d847d6848d78b7e5dad80f23bb10e52caed87066` |
| `_work/vehicle-pipeline/manifests/hummer-h2-offroad/manifest.json` (staged) | 331,188 | `7f4166c5a91a103fc0f69c400a0098d63bfdf5a4a85683e7c4562f47a2b9a56d` |
| `_work/vehicle-pipeline/hummer-h2-offroad/staging-verify.json` | 3,298 | `6b70b3df5125cba01b8f4a2497ae243d4383da7456617f6275a3ddf0d7472722` |

| input | SHA-256 |
| --- | --- |
| `_work/e1-drive/cars.json` | `be8843030ce86983f42d6addf05ef5653481037d0f9ec16c30f2b802706aa97f` |
| `probes/e1-drive/cars/roster.json` | `199bd8d774b8bffd9106d0b47e44c946953440a351045c2d13e833a98827ec16` |
| `_work/car-parts/cars/index.json` | `5042e714a309e28e19498a0d35e18fef941c0fac850e87bc0f986117bb9bc315` |
| `_work/car-materials/roster/index.json` | `77e73bfff8e324459d337f9ec1817f717e39aabfe0134433ca886c2a1774cd76` |

| evidence | content |
| --- | --- |
| `probes/vehicle-pipeline/tools/audit_cars.py` | the audit builder |
| `probes/vehicle-pipeline/tools/verify_vehicle_pipeline.py` | the gate |
| `probes/vehicle-pipeline/tools/build_doc.py` | this document's generator |
| `_work/vehicle-pipeline/cars.json` | full 62-record matrix, mapping, physics, scene, MdlDat, materials, next list |
| `_work/vehicle-pipeline/summary.csv` | one flat row per record |
| `_work/vehicle-pipeline/fields/` | 62 decoded `.fields` copies (`name<TAB>value`, CRLF) |
| `_work/vehicle-pipeline/models/` | 47 decoded models + content hashes |
| `_work/vehicle-pipeline/scene/` | 47 compact committed-Scene reports (draws, UV0, metadata) |
| `_work/vehicle-pipeline/materials/<slug>/` | 47 independent material traversals |
| `_work/vehicle-pipeline/manifests/<slug>/` | 10 next-car part manifests/meshes |
| `_work/logs/vehicle-pipeline/audit.log` | builder stdout |
| `_work/logs/vehicle-pipeline/verify.log` | gate stdout |

## 10. Limits

- Data audit only; no car was added to the E1 drive slice and no drive claim is made.
- A = the five committed reference cars (fields + part manifest + P52 materials + drive verification).
- B = exact model + Scene reader + MdlDat + physics gate + independent material traversal, but not yet integrated into the E1 roster, P52 committed materials, geometry pins or drive verifier.
- C = no exact normalised model entry (or a reader failure); the missing file/format is recorded and near-name candidates are evidence only, never a mapping.
- Texture source bytes are per unique referenced texture; RGBA bytes use the highest populated LOD within the committed 512x512 decoder bound and are an upper-bound estimate, not a decoded artifact.
- Mesh/index/UV bytes are the committed Scene reader's first RenderList LOD0 output, not the whole model.
- The current five-car drive path remains the only proven playable content.

Additional audit limits:

- Material traversal is the independent `tools/inspect_car_materials.py` pass, not the P52 committed C++-cross-checked manifest; a B car's static/texture counts are evidence of available data, not a P52 proof.
- The A cars use the committed P52 numbers; the B texture RGBA total is an upper-bound estimate from descriptor dimensions, not decoded pixels.
- V1 did not extract the 15 C records. The V3 addendum (4.1) resolves 14 of them by record-level `AmaxVehicle` identity and stages their body/wheel assets; `DefaultCar` remains unsupported. No C car is in the drive roster.
- The `Hummer_H2_OffRoad` missing caliper is a typed absence in the builder and a staged manifest only; no roster, P52 material, geometry-pin, ghost or drive integration is claimed. The V1 audit artifact (`cars.json`/`summary.csv`/`hashes.json`) was not regenerated: §7.1 and `docs/work/analysis/vehicle-hummer-parts.md` carry the staged resolution.
- No renderer, driver, browser, multiplayer or full-game claim is made for any B or C car.

