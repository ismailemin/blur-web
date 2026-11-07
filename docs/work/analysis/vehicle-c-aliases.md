# C vehicle records — record-level alias resolution

**Date:** 8 November 2026
**Owner:** V3 (sub-agent), data/analysis only
**Scope:** `probes/vehicle-pipeline/**`, `_work/vehicle-pipeline/**`,
`_work/logs/vehicle-pipeline/**`, this document, and the §4.1 addendum in
[`vehicle-pipeline.md`](vehicle-pipeline.md). No change to `probes/e1-drive`,
`probes/car-parts`, `probes/car-materials`, `probes/asset-reader`, `tools/`,
`upstream/` or `game-data/`.

**Result:** **14 of the 15 C records are provable**, each by an exact
`AmaxVehicle.dynamics` handle to its `RP_CarDynamics` record id, and each maps to
a body model that already exists in `root.pak`. **1 record (`DefaultCar`) remains
unsupported** with exact missing evidence. All 14 provable body models and the 12
unique referenced wheel models stage-load through the committed car-parts
builder, Scene reader and material traversal. **No car was added to the E1
roster and no drive or full-game claim is made.**

## 0. Summary

| metric | value |
| --- | ---: |
| C records | **15** |
| provable | **14** |
| unsupported | **1** (`DefaultCar`) |
| unique intended body models | **14** |
| intended body logical bytes | **65,543,055** |
| unique referenced wheel models | **12** |
| wheel logical bytes | **1,711,766** |
| additional explicit models on shared records | **3** |
| staged body draws | **1,409** |
| staged parts | **412** |
| staged wheel draws | **280** |
| staged UV0 valid vertices | **289,239** |
| staged unique textures | **113** |
| staged texture source bytes | **9,685,764** |
| staging loads / partial / error | **14 / 0 / 0** |
| verifier | **PASS**, 438/438 checks, 0 failures |

## 1. Why V1 was blocked

V1's rule was model-file-name equality: the record name lowercased plus
`.model` must equal one `\models\vehicles\*.model` entry. None of the 15 C
record names satisfies it (typos, suffixes such as `grpc`/`heh`/`1stplay`/
`grippy`, the `Nissan_350ZNismo_Stock grpc` space, `DefaultCar`, and genuine
naming splits such as `BMW_135_Stock`). V1 recorded the nearest names as
evidence and deliberately did not alias them.

The new question is not "which file name looks closest", but "which shipped
vehicle carries this physics record, and which body model does the engine load
for that vehicle". That is a record-level identity, and the shipped data plus
the shipped engine answer it.

## 2. Authority chain

| step | authority | evidence |
| --- | --- | --- |
| 1. C record ids | `_work/vehicle-pipeline/cars.json` | 15 records, ids as listed below |
| 2. vehicle table | `\gamedata\xt\amax.bin` decoded with the committed `car_xt.py` | 4,518 records, 81 `AmaxVehicle` records |
| 3. handle semantics | `probes/asset-reader/FORMAT-xt.md:27` | `FlaskHandle` = 4 bytes, U32 id |
| 4. handle resolution | XT `refs` table: `refs[handle] -> (record id, type)` | every resolved type is `RP_CarDynamics` |
| 5. body model rule | `upstream/BlurRebuilt/code/amax/game/GameLogic/Structures/LevelState.cpp:334` | `models/vehicles/%s.model` from `veh->tag` |
| 6. same rule, spawn path | `.../GameLogic/RaceLogicCore/Core/RaceLogicCore.cpp:1489` | `models/vehicles/%s.model` from `pAmaxVehicle->tag` |
| 7. wheel model rule | `LevelState.cpp:360` | `models/vehicles/wheels/%s.model` from `veh->wheelModel->fileName` |
| 8. unused/missing fallback | `LevelState.cpp:339-345` | body becomes `shelby_mustanggt500_stock.model`; `use=false` is never a proof |
| 9. `DefaultCar` semantics | `LevelState.cpp:408` | `mDynamicsFilename = "DefaultCar"` is the physics fallback name |

The rule is independently validated by the 47 already-proven A/B records:
**47/47** have an `AmaxVehicle` whose tag equals their exact model stem (for
example record `Dodge_Challenger_Stock` -> vehicle tag
`Dodge_Challenger_Stock` -> `dodge_challenger_stock.model`). The same
tag-to-model relation applied to the C records yields the mappings below.

A record is `provable` only when **all** of these hold:

1. exactly one base `AmaxVehicle` (or one explicit vehicle when the record has
   no base) has a `dynamics` handle whose `refs[h]` id equals the record id, and
   the resolved type is `RP_CarDynamics`;
2. the vehicle tag lowercased plus `.model` exists under `\models\vehicles\`;
3. the referenced `wheelModel.fileName` plus `.model` exists under
   `\models\vehicles\wheels\`;
4. the vehicle has `use=true`.

String similarity is computed for comparison only and is never used as the
mapping. `nameSimilarityUsed` is `false` on every record.

## 3. Per-record resolution

`handle ref` is the index into the XT `refs` table stored in
`AmaxVehicle.dynamics`; the resolved id is the `RP_CarDynamics` record id.

| # | record | status | AmaxVehicle identity (handle ref) | intended model | bytes | model SHA-256 | wheel model | wheel bytes | name sim |
|--:|---|---|---|---|---:|---|---|---:|---:|
| 1 | Opel_AstraExtreme_shannon | **provable** | `Opel_AstraExtreme_Stock_Shannon` (201) | `\models\vehicles\opel_astraextreme_stock_shannon.model` | 6,040,888 | `07970898aa5135b48d1b21fbb140f610a92c52df4d231f433b83f2c1c354d024` | `\models\vehicles\wheels\opel_astraextreme_stock.model` | 48,998 | 0.8929 |
| 7 | Renault_MeganeSportR26_Stockgrpc | **provable** | `Renault_MeganeSportR26_Stock` (552) | `\models\vehicles\renault_meganesportr26_stock.model` | 4,848,425 | `e2e990da3c5fb0eb842c2a48c86220b452ea0d1666c8b5c8c619c8553f6d419c` | `\models\vehicles\wheels\renault_meganesportr26.model` | 101,746 | 0.9333 |
| 8 | DefaultCar | **unsupported** | none | **none** | — | — | — | — | — |
| 18 | Dodge_Challanger_Tuner1stplay | **provable** | `Dodge_Challenger_Tuner` (1211) | `\models\vehicles\dodge_challenger_tuner.model` | 4,894,763 | `7042ff517957a17d9555d2490512971e67703ab8fa6501c1f7647b8a011947fb` | `\models\vehicles\wheels\dodge_challenger_tuner.model` | 94,255 | 0.8235 |
| 22 | Nissan_350ZNismo_Stock grpc | **provable** | `Nissan_350ZNismo_Stock` (1332) | `\models\vehicles\nissan_350znismo_stock.model` | 4,852,718 | `dcb49dce101ea768eaadd334c910a4b7520ef48004c4ac6d5e998f5330041da8` | `\models\vehicles\wheels\nissan_350znismo_stock.model` | 170,925 | 0.8980 |
| 23 | BMW_135_Stock | **provable** | `BMW_1SeriesTii_Stock` (1358) | `\models\vehicles\bmw_1seriestii_stock.model` | 4,767,553 | `ccaf31c4d80749d0f5c4dde65c7beaf3243503d82f8b3e7201e17938a432c94d` | `\models\vehicles\wheels\bmw_1seriestii.model` | 408,795 | 0.6667 |
| 25 | Chevrolet_Camaro_StockE3 | **provable** | `Chevrolet_Camaro_Stock` (1569) | `\models\vehicles\chevrolet_camaro_stock.model` | 4,442,558 | `c74b06ce38028fa9f272d0eab347405d47218b25c8641bfb62d07da50129b42d` | `\models\vehicles\wheels\chevrolet_camaro_stock.model` | 119,698 | 0.9565 |
| 31 | LandRover_DefenderSVXgrpc | **provable** | `LandRover_DefenderSVX_Stock` (1732) | `\models\vehicles\landrover_defendersvx_stock.model` | 3,971,721 | `780e8ce1b5a5cbe770790aabf7c3b00d544992607438f9a1799807cf04664830` | `\models\vehicles\wheels\landrover_defendersvx_stock.model` | 72,550 | 0.8462 |
| 39 | Ford_Mustang_GT500_Stock1stplay | **provable** | `Shelby_MustangGT500_Stock` (2333) | `\models\vehicles\shelby_mustanggt500_stock.model` | 4,570,011 | `f452c7714261db78cc84c87e97ede76d09cd21cd5685495057cbb1f59fd9fdb8` | `\models\vehicles\wheels\shelby_mustanggt500.model` | 80,585 | 0.6786 |
| 47 | VW_Beetle_Offroad | **provable** | `Volkswagen_Beetle_OffRoad` (2931) | `\models\vehicles\volkswagen_beetle_offroad.model` | 4,006,842 | `2d5062c147d2711467c2d604e917ea0cdbba02fd918e0349ef9ed7bbebf3330f` | `\models\vehicles\wheels\volkswagen_beetle_offroad.model` | 82,896 | 0.8095 |
| 48 | Ford_F150_OffRoadheh | **provable** | `Ford_F150_OffRoad` (3042) | `\models\vehicles\ford_f150_offroad.model` | 4,290,935 | `8dd7f8a7ca0b17d532c98a22da008e99142c5745d25a66f06f0cad790461cfb0` | `\models\vehicles\wheels\ford_f150_offroad.model` | 52,642 | 0.9189 |
| 63 | Foose_Stallion_Stockgrpc | **provable** | `Foose_Stallion_Stock` (4357) | `\models\vehicles\foose_stallion_stock.model` | 5,896,194 | `07f101c1de858a959e4ccf62eb4f92e81ca657105ef2a2c25ee5f322a6f1429f` | `\models\vehicles\wheels\foose_stallion.model` | 86,429 | 0.9091 |
| 65 | Chevrolet_Camaro_Ratdrift | **provable** | `Chevrolet_Camaro_Rat` (4491) | `\models\vehicles\chevrolet_camaro_rat.model` | 4,968,321 | `785857f076b7010579624f327cbade78972442e2037d1f18160a568179117aff` | `\models\vehicles\wheels\chevrolet_camaro_stock.model` | 119,698 | 0.8889 |
| 71 | Opel_AstraExtreme_Stockgrippy | **provable** | `Opel_AstraExtreme_Stock` (4716) | `\models\vehicles\opel_astraextreme_stock.model` | 4,642,094 | `18b6d475806675e9cc45e32fba904abd6d77d8181ec6334793a6440b4d0535cd` | `\models\vehicles\wheels\opel_astraextreme_stock.model` | 48,998 | 0.8846 |
| 75 | Covette_C3_Rat | **provable** | `Corvette_C3_Rat` (4963) | `\models\vehicles\corvette_c3_rat.model` | 3,350,032 | `deb19c66b73682fb36a4e9d3663fee3790548b8df32841c0f21a32c93f60b1d1` | `\models\vehicles\wheels\corvette_c3_rat.model` | 392,247 | 0.9655 |

### 3.1 Shared physics records

Three C records are referenced by more than one explicit `AmaxVehicle`. The
handle identity is still exact; the extra vehicles are recorded, not guessed:

| record | explicit vehicles | selection |
| --- | --- | --- |
| 7 `Renault_MeganeSportR26_Stockgrpc` | `Renault_MeganeSportR26_Stock` (base), `Renault_MeganeSportR26_Stock_Shannon` (parent = base) | base `..._Stock`; alternate model `renault_meganesportr26_stock_shannon.model` exists |
| 63 `Foose_Stallion_Stockgrpc` | `Foose_Stallion_Stock` (base), `Foose_Stallion_Stock_Khan` (parent = base) | base `..._Stock`; alternate model `foose_stallion_stock_khan.model` exists |
| 71 `Opel_AstraExtreme_Stockgrippy` | `Opel_AstraExtreme_Stock` (base), `Opel_Astra_Extreme_Legend_VIII` (parent = base) | both vehicles resolve to the same `opel_astraextreme_stock.model` |

The base is chosen because it is the parent and the record name carries the
`Stockgrpc`/`Stockgrippy` suffix. The alternate is a shipped variant of the same
physics, not an unresolved alias. `c-aliases.json` records every explicit
vehicle and the alternate model path.

### 3.2 Why name similarity is rejected

| record | top name-similarity candidate | record-level answer | consequence of aliasing by name |
| --- | --- | --- | --- |
| 39 `Ford_Mustang_GT500_Stock1stplay` | `ford_mustanggtr_stock.model` (0.769) | `Shelby_MustangGT500_Stock` -> `shelby_mustanggt500_stock.model` (0.679) | wrong car (Mustang GTR instead of Shelby GT500) |
| 23 `BMW_135_Stock` | `bmw_1seriestii_stock.model` and `bmw_x548msport_stock.model` (both 0.667) | `BMW_1SeriesTii_Stock` -> `bmw_1seriestii_stock.model` | similarity cannot choose between two different BMWs |
| 8 `DefaultCar` | `default.model` (0.824) | no `AmaxVehicle`; unsupported | a 78,602-byte placeholder would become a fake car |
| 7 `Renault_MeganeSportR26_Stockgrpc` | stock (0.933) vs Shannon (0.824) | both vehicles share the record; base stock selected | a name score does not show the shared physics |
| 63 `Foose_Stallion_Stockgrpc` | stock (0.909) vs Khan (0.816) | both vehicles share the record; base stock selected | same |

All **15** C record names differ from their `AmaxVehicle` tag when a tag exists
(`recordsWhereRecordNameEqualsAmaxTag = 0`). The mapping is therefore never a
spelling correction.

### 3.3 The unsupported record

`DefaultCar` (index 8, id `515172551`, RWD, 1195 kg) remains **unsupported**:

- no `AmaxVehicle.dynamics` handle in `amax.bin` resolves to id `515172551`;
- no `AmaxVehicle.aiDynamics` handle resolves to it either (0 AI references);
- the shipped engine only assigns a body from an `AmaxVehicle` tag
  (`LevelState.cpp:334`); `DefaultCar` is the physics fallback name
  (`LevelState.cpp:408`);
- the nearest file `\models\vehicles\default.model` exists but is only
  **78,602 bytes** versus a median real car body of **4,615,848 bytes**. It is a
  placeholder, not a body reference; using it would be a guess.

Exact missing evidence: an `AmaxVehicle` record with a `dynamics` handle to
`515172551` (or an explicit body/model reference for that record).

## 4. Staging load results

Each provable record was loaded read-only into
`_work/vehicle-pipeline/c-staging/<slug>/` with
`probes/car-parts/tools/build_manifest.py`, then the body Scene report and the
independent material traversal were read from the same staging directory. The
referenced wheel model was decoded and parsed separately with
`scene_inspect.exe` / `model_inspect.exe`. No committed car-parts, P52, E1 or web
file was written.

| # | record | body draws | parts | WG | wheel draws | proven / ambiguous | tyre tier | UV0 valid | textures | tex source bytes | wheel asset draws |
|--:|---|---:|---:|---:|---:|---|---|---:|---:|---:|---:|
| 1 | Opel_AstraExtreme_shannon | 86 | 28 | 4 | 20 | 0 / 20 | containment | 30,800 | 11 | 900,276 | 2 |
| 7 | Renault_MeganeSportR26_Stockgrpc | 125 | 38 | 4 | 20 | 0 / 20 | union | 23,128 | 7 | 844,132 | 3 |
| 18 | Dodge_Challanger_Tuner1stplay | 93 | 30 | 4 | 20 | 2 / 18 | union | 20,541 | 8 | 724,024 | 4 |
| 22 | Nissan_350ZNismo_Stock grpc | 123 | 32 | 4 | 20 | 8 / 12 | union | 19,172 | 8 | 887,864 | 3 |
| 23 | BMW_135_Stock | 111 | 26 | 4 | 20 | 0 / 20 | union | 13,374 | 9 | 866,068 | 5 |
| 25 | Chevrolet_Camaro_StockE3 | 100 | 30 | 4 | 20 | 8 / 12 | union | 19,569 | 7 | 592,924 | 3 |
| 31 | LandRover_DefenderSVXgrpc | 85 | 30 | 4 | 20 | 0 / 20 | union | 21,288 | 7 | 396,316 | 2 |
| 39 | Ford_Mustang_GT500_Stock1stplay | 110 | 32 | 4 | 20 | 0 / 20 | union | 19,677 | 7 | 592,924 | 3 |
| 47 | VW_Beetle_Offroad | 85 | 18 | 4 | 20 | 6 / 14 | union | 21,991 | 8 | 661,208 | 1 |
| 48 | Ford_F150_OffRoadheh | 120 | 34 | 4 | 20 | 0 / 20 | union | 15,578 | 7 | 595,644 | 2 |
| 63 | Foose_Stallion_Stockgrpc | 103 | 27 | 4 | 20 | 6 / 14 | union | 19,012 | 8 | 855,096 | 4 |
| 65 | Chevrolet_Camaro_Ratdrift | 99 | 32 | 4 | 20 | 2 / 18 | union | 17,622 | 8 | 718,456 | 3 |
| 71 | Opel_AstraExtreme_Stockgrippy | 86 | 28 | 4 | 20 | 0 / 20 | containment | 30,800 | 10 | 638,104 | 2 |
| 75 | Covette_C3_Rat | 83 | 27 | 4 | 20 | 12 / 8 | union | 16,687 | 8 | 412,728 | 2 |

Every staged record has a body draw set, four wheel groups, 20 wheel draws, a
valid UV0 stream and at least 7 static-albedo textures; every referenced wheel
model parses and draws. `proven / ambiguous` is the builder's wheel-corner proof
count; `ambiguous` wheel draws are still paired for preview only, exactly as the
builder documents.

Totals: **1,409 body draws / 412 parts / 280 wheel draws / 289,239 UV0 valid
vertices / 113 unique textures / 9,685,764 texture source bytes**. Texture bytes
are per staged record, so textures shared by different cars are counted more
than once here; this is not a deduplicated roster total.

## 5. Recommendation and quantification

**All 14 provable C records can join batch 2.** `DefaultCar` stays unsupported.
A practical split by the staging wheel proof:

| wave | records | count | evidence |
| --- | --- | ---: | --- |
| A — proven wheel identity | 18, 22, 25, 47, 63, 65, 75 | **7** | at least 2 proven wheel draws each (2 / 8 / 8 / 6 / 6 / 2 / 12) |
| B — preview-paired wheels | 1, 7, 23, 31, 39, 48, 71 | **7** | all 20 wheel draws preview-paired; same tier as the three medium B cars already integrated in batch 1 |
| unsupported | 8 `DefaultCar` | **1** | no vehicle/body reference; placeholder only |

Quantities if all 14 are added:

- **14** new body models, **65,543,055** logical bytes (all new; none is one of
  the 47 exact-mapped A/B models);
- **12** unique wheel models, **1,711,766** logical bytes (records 25/65 share
  the Chevrolet wheel, records 1/71 share the Opel wheel);
- **3** additional explicit variant models on the shared records (Renault
  Shannon, Foose Khan, Opel Legend VIII), all present in `root.pak`;
- staged geometry: **1,409** draws / **412** parts / **280** wheel draws /
  **289,239** valid UV0 vertices;
- staged materials: **113** unique referenced textures / **9,685,764** source
  bytes (per-record sum).

The main-agent steps are unchanged: roster entry, `car_roster.py` field export,
car-parts manifest, P52 material/texture pass, geometry pins/ghosts, and the
existing chunking policy. The C resolution adds only the model mapping that the
roster needs; it does not change a reader or a codec.

## 6. Verification, hashes and evidence

`probes/vehicle-pipeline/tools/verify_c_aliases.py` re-derives the resolution
from `cars.json` + `amax.bin` + `root.pak`, compares it byte-for-byte with
`c-aliases.json`, re-checks every model/wheel hash, and checks every staging
manifest and mesh hash. It reports **PASS, 438/438 checks, 0 failures**.

| artifact | bytes | SHA-256 |
| --- | ---: | --- |
| `_work/vehicle-pipeline/c-aliases.json` | 46,847 | `f40027ca785fec168b994b8a5f69e337869ba372b5da668a7c77424330822ae9` |
| `_work/vehicle-pipeline/c-staging-results.json` | 55,506 | `a25c995d064e3cdbd1182da344612c25e0e30db71d541b280b12bca10ca908ab` |
| `_work/vehicle-pipeline/c-aliases-verify.json` | 39,808 | `9b64970c084edffd2ae83bebf93f2f19f437091079f988d6cca8182e9e0515b8` |
| `probes/vehicle-pipeline/tools/audit_c_aliases.py` | 24,411 | `93da8aab1d2d94f681450397ec62e2d470858b6c4cfc2b230ab3f7da95a96995` |
| `probes/vehicle-pipeline/tools/verify_c_aliases.py` | 14,139 | `d2b1b5b39e433f035a70ca3c56871b7a741f302ccc5248956ad55edceca71c4b` |
| `probes/vehicle-pipeline/tools/stage_c_models.py` | 14,001 | `6ffa41b7cc1297dac5842f19a0f45ce540fd09f44a623540993e30f9d9305077` |

| input / dependency | SHA-256 |
| --- | --- |
| `_work/vehicle-pipeline/cars.json` | `0fb3f56753ab12c56062ba559843f527081cbed354ac2cc61b71fe3c507e3e4d` |
| `\gamedata\xt\amax.bin` (decoded) | `a833487bd66552ecf61b1f13790ee228b18ca8f4d76c524dcd94e44c63d1e3c7` (1,078,940 bytes, 4,518 records; recorded in `c-aliases.json`) |
| `probes/car-parts/tools/build_manifest.py` | `9a5bf621d101e332c20a037c9e171381e98019822ef2afd80520b7480827a53f` |
| `tools/inspect_car_materials.py` | `2678bf835780a303bbb83619294596f6d6f70b34089c09d1108d3e57103da4fd` |
| `scene_inspect.exe` | `d542db8e9ad0da670756734930cbdf7ffbe47fd71db5b9e4d6e0d78d194621a1` |
| `model_inspect.exe` | `b55ebce653100b00f4a0b26a5c6f7f2afd6ef6e6547bcb844d55fc86bf0d9d04` |

> The `build_manifest.py` hash above is the **working-tree** file at staging
> time; it contains a concurrent, uncommitted brake-caliper-absence change by
> another agent. The committed builder hash can differ. The C audit itself does
> not depend on the builder.

Determinism: the alias document is re-derived byte-identically on a second run
(`regen.identical`), and a repeat staging build of record 23 (`BMW_135_Stock`)
produced the same manifest SHA-256 `195a887d…cadeb3` before and after the
repeat.

Evidence paths:

| path | content |
| --- | --- |
| `_work/vehicle-pipeline/c-aliases.json` | 15 per-record statuses, identity, handle ref, intended/wheel model, hashes, missing evidence |
| `_work/vehicle-pipeline/c-staging-results.json` | 14 staging loads: manifest/mesh hashes, draws, parts, wheels, UV0, textures, wheel model |
| `_work/vehicle-pipeline/c-staging/<slug>/` | staged `manifest.json`, `mesh.json`, `scene-report.json`, material traversal |
| `_work/vehicle-pipeline/c-models/body/` | 14 decoded body models used for the audit |
| `_work/vehicle-pipeline/c-models/wheels/` | 12 decoded wheel models |
| `_work/vehicle-pipeline/c-aliases-verify.json` | 438-check verifier output |
| `_work/logs/vehicle-pipeline/c-alias-audit.log` | audit stdout |
| `_work/logs/vehicle-pipeline/c-alias-verify.log` | verifier stdout |
| `_work/logs/vehicle-pipeline/c-staging.log` | staging stdout |
| `_work/logs/vehicle-pipeline/c-staging-repeat-bmw.log` | repeat-run determinism check |

Reproduction (from the repository root, bundled Python):

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
& $py probes/vehicle-pipeline/tools/audit_c_aliases.py
& $py probes/vehicle-pipeline/tools/stage_c_models.py
& $py probes/vehicle-pipeline/tools/verify_c_aliases.py
```

## 7. Limits

- Data/analysis only: no e1-drive, roster, geometry, material or web change.
- `provable` means "this is the body the shipped engine would load for the
  vehicle that carries this exact physics record". It does not claim the paint,
  damage, LOD, runtime materials, handling or race balance are final.
- Staging proves the body and wheel assets parse and have draws/UV/textures; it
  is **not** a drive, renderer, browser or multiplayer claim.
- Three records (7, 63, 71) share their physics with an explicit variant; the
  base model is selected and the variant is recorded, not discarded.
- `DefaultCar` remains unsupported until an explicit body/vehicle reference is
  found.
- `No full-game claim.`
