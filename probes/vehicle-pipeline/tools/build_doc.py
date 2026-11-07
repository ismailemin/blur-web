"""Build `docs/work/analysis/vehicle-pipeline.md` from the verified audit.

The document is data-driven so its tables and hashes cannot drift from
`_work/vehicle-pipeline/cars.json` / `verify.json`.

Usage:
  python probes/vehicle-pipeline/tools/build_doc.py
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "_work/vehicle-pipeline"
DOC = ROOT / "docs/work/analysis/vehicle-pipeline.md"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fmt_int(value) -> str:
    return "—" if value is None else f"{int(value):,}"


def main() -> int:
    d = json.loads((OUT / "cars.json").read_text(encoding="utf-8"))
    verify = json.loads((OUT / "verify.json").read_text(encoding="utf-8"))
    hashes = json.loads((OUT / "hashes.json").read_text(encoding="utf-8"))
    records = sorted(d["records"], key=lambda r: r["index"])
    counts = d["counts"]
    next_slugs = {c["slug"] for c in d["nextCars"]}

    lines: list[str] = []
    add = lines.append

    add("# Vehicle pipeline audit — all 62 `RP_CarDynamics` records")
    add("")
    add("**Date:** 7 November 2026")
    add("**Owner:** V1 (sub-agent), data audit only")
    add("**Scope:** new `probes/vehicle-pipeline/`, outputs under `_work/vehicle-pipeline/`, "
        "logs under `_work/logs/vehicle-pipeline/`, and this document. No change to `probes/e1-drive`, "
        "`probes/asset-reader`, `probes/car-parts`, `probes/car-materials`, the engine, `tools/`, "
        "`upstream/` or `game-data/`.")
    add("")
    add("**Result:** all **62** vehicle records are classified. **5 are class A** (the committed "
        "E1 drive reference cars), **42 are class B** (exact model + Scene reader + MdlDat + physics "
        "gate + independent material traversal; not yet integrated into the drive slice), and **15 are "
        "class C** (no exact normalised model entry; the exact missing path and nearest pak entries are "
        "recorded, never guessed). The ten highest-confidence B cars have a real part manifest built "
        "outside the committed tree; no B or C car is claimed to drive. This is not a full-game claim.")
    add("")
    add("## 0. Summary")
    add("")
    add("| metric | value |")
    add("| --- | --- |")
    add(f"| records | **{counts['records']}** |")
    add(f"| physics gate pass | **{counts['physicsGatePass']} / {counts['records']}** |")
    add(f"| exact model mapped | **{counts['exactModelMapped']}** (`\\models\\vehicles\\<name>.model`) |")
    add(f"| Scene reader parsed | **{counts['sceneParsed']}** |")
    add(f"| MdlDat part layer parsed | **{counts['mdlDatParsed']}** |")
    add(f"| independent material traversal | **{counts['materialsTraversed']}** |")
    add(f"| class A | **{counts['classA']}** |")
    add(f"| class B | **{counts['classB']}** |")
    add(f"| class C | **{counts['classC']}** |")
    add(f"| next-car shortlist | **{counts['nextCarCount']}** "
        f"({counts['nextCarsHighConfidence']} high confidence) |")
    add(f"| verifier | **{verify['status']}**, {verify['passed']}/{verify['checks']} checks, "
        f"{verify['failed']} failures |")
    add("")
    add("The only proven playable content remains the five reference cars: "
        "`corvette-zr1-stock`, `lotus-exige-cup260-stock`, `dodge-challenger-stock`, "
        "`ford-focusrs-stock`, `audi-r8v10-stock`.")
    add("")

    add("## 1. Method and authority")
    add("")
    add("The audit reuses committed readers and extractors; it does not re-derive any format:")
    add("")
    add("| role | authority |")
    add("| --- | --- |")
    add("| record list, ids, physics values, gate | `_work/e1-drive/cars.json` + "
        "`engine/harness/t005d-vehicle/car_xt.py` (through `probes/e1-drive/tools/car_roster.py`) |")
    add("| pak entries / model bytes | `tools/inspect_asset_layout.pak_index` + "
        "`tools/prepare_asset_fixture.decode_packet_zlib` |")
    add("| model chunk tree | `_work/build/asset-reader-native/Release/model_inspect.exe` |")
    add("| first RenderList LOD0 geometry, draws, UV0 | "
        "`_work/build/asset-reader-native/Release/scene_inspect.exe` |")
    add("| part layer (MdlDat names, bounds, wheel groups) | "
        "`probes/car-parts/tools/build_manifest.py` (`parse_mdldat`) |")
    add("| draw/material/texture bindings | `tools/inspect_car_materials.py` (independent traversal) |")
    add("| proven five-car materials | `_work/car-materials/roster/` (P52 committed index) |")
    add("| proven five-car part manifests | `_work/car-parts/cars/index.json` (P29 committed index) |")
    add("")
    add("A model is mapped only by the committed rule: the record name lowercased plus `.model` must "
        "match exactly one `\\models\\vehicles\\*.model` pak entry. A near name (typo, suffix, alias) "
        "is recorded as evidence in `nearCandidates`, never used as a mapping.")
    add("")
    add("### 1.1 Class definitions")
    add("")
    add("| class | rule | current extraction path |")
    add("| --- | --- | --- |")
    add("| **A** | all data present and proven by the current pipeline | RP_CarDynamics → `.fields`; "
        "`.model` → car-parts manifest; P52 material/texture manifest; E1 geometry, verifier and drive captures |")
    add("| **B** | exact model, Scene reader, MdlDat and physics gate pass, and the independent "
        "material traversal resolves static albedo; not yet integrated | decoded model + Scene report + "
        "part manifest candidate + material traversal; needs roster entry, P52 committed materials, "
        "geometry pins and drive verification |")
    add("| **C** | blocked before extraction: no exact model entry (or a reader failure) | nothing is "
        "extracted or guessed; the exact expected path and nearest pak candidates are recorded |")
    add("")
    add("### 1.2 Byte definitions")
    add("")
    add("- **model bytes** — pak `logical_bytes` of the decoded `.model` (47 mapped records).")
    add("- **mesh bytes** — first RenderList LOD0 positions as float32 (3 × 4 B/vertex).")
    add("- **index bytes** — LOD0 U32 triangle-list indices (3 × 4 B/triangle).")
    add("- **UV0 bytes** — the full UV0 stream (2 × 4 B/vertex, including zero placeholders); "
        "**valid UV0 bytes** count only vertices the reader marks valid.")
    add("- **texture source bytes** — unique referenced shared/resource textures (descriptor + complete "
        "mip chain at the highest populated LOD within the committed 512×512 bound).")
    add("- **texture RGBA bytes** — for A, the exact P52 decoded RGBA total; for B, an upper-bound "
        "estimate (`width × height × 4`) for the same bounded LOD. It is not a decoded artifact.")
    add("")

    add("## 2. The 62-record matrix")
    add("")
    add("`draws` / `static` / `tex` / `WG` are the committed Scene draw count, independently resolved "
        "static-albedo draws, unique referenced textures, and MdlDat wheel-group count. C records have "
        "no model, so those cells are `—`. `next` marks the ten shortlisted B cars.")
    add("")
    add("| # | record | class | drive | mass (kg) | model (short) | draws | static | tex | WG | next |")
    add("|--:|---|---|---|---:|---|---:|---:|---:|---:|---|")
    for r in records:
        model = r["model"].get("pakPath")
        model = model.replace("\\models\\vehicles\\", "") if model else "**missing**"
        static = None if r["class"] == "C" else r["materials"].get("staticAlbedoDraws")
        add(f"| {r['index']} | {r['name']} | {r['class']} | {r['drivetrain']} | {r['mass']:.0f} | "
            f"{model} | {fmt_int(r['scene'].get('drawCount'))} | "
            f"{fmt_int(static)} | "
            f"{fmt_int(r['materials'].get('uniqueTextureCount'))} | "
            f"{fmt_int(r['mdlDat'].get('wheelGroupCount'))} | "
            f"{'yes' if r['slug'] in next_slugs else ''} |")
    add("")

    add("## 3. Class A — the five proven reference cars")
    add("")
    add("These are the only cars with the full chain: committed `.fields`, committed car-parts "
        "manifest/mesh, P52 material/texture manifest, E1 geometry pins, scripted sprint/lap/free-roam "
        "runs and browser captures. Their hashes are the reference for any new car.")
    add("")
    add("| slug | record (index/id) | drivetrain | mass | draws | static | textures | RGBA bytes | P52 manifest SHA-256 |")
    add("|---|---|---|---:|---:|---:|---:|---:|---|")
    for r in records:
        if r["class"] != "A":
            continue
        m = r["materials"]
        add(f"| `{r['slug']}` | {r['index']} / {r['id']} | {r['drivetrain']} | {r['mass']:.0f} | "
            f"{m.get('drawCount')} | {m.get('staticAlbedoDraws')} | {m.get('uniqueTextureCount')} | "
            f"{m.get('rgbaBytes'):,} | `{m.get('manifestSha256')}` |")
    add("")
    add("The committed car-parts index is `_work/car-parts/cars/index.json` "
        f"(`sha256:{d['source']['carPartsIndex']['sha256']}`); the P52 index is "
        f"`_work/car-materials/roster/index.json` (`sha256:{d['source']['materialsIndex']['sha256']}`).")
    add("")

    add("## 4. Class C — blocked records and exact missing data")
    add("")
    add("Each C record has **zero** exact matches for `\\models\\vehicles\\<normalised name>.model`. "
        "The nearest pak models are listed only to show what a future, documented alias rule could "
        "consider; they are not mappings and no bytes were extracted for these records.")
    add("")
    add("| # | record | drive | mass | exact path expected (missing) | nearest pak models (evidence only) |")
    add("|--:|---|---|---:|---|---|")
    for r in records:
        if r["class"] != "C":
            continue
        near = ", ".join(f"`{c['model']}` ({c['similarity']:.3f})"
                         for c in r["model"]["nearCandidates"][:3])
        add(f"| {r['index']} | {r['name']} | {r['drivetrain']} | {r['mass']:.0f} | "
            f"`{r['model']['expectedPath']}` | {near} |")
    add("")
    add("Notable naming splits: `Covette_C3_Rat` is a one-letter typo for `corvette_c3_rat.model`; "
        "`Chevrolet_Camaro_StockE3` vs `chevrolet_camaro_stock.model`; "
        "`Ford_Mustang_GT500_Stock1stplay` vs `shelby_mustanggt500_stock.model`; "
        "`Nissan_350ZNismo_Stock grpc` contains a space; `DefaultCar` vs `default.model`. "
        "`BMW_135_Stock` has no close pak model at all (best similarity 0.667, a different BMW). "
        "Resolving any of these is a content/naming decision for the main agent, not a reader change.")
    add("")

    add("## 5. Physics fields — what differs per car")
    add("")
    add("All **62** records decode with the committed `car_xt.py` extractor and pass the completeness "
        "gate (positive mass/wheelbase/track/tyre radius/limiter/torque/gear/final/brake; ≥2 gears, "
        "torque points and grip points; valid top gear; drive type 0/1/2; all values finite). "
        "There are **no missing or extra schema field names** versus the reference Corvette ZR1 record.")
    add("")
    add("| property | distribution |")
    add("| --- | --- |")
    add("| field lines | 181 (19), 182 (7), 183 (9), 184 (7), 185 (11), 186 (7), 188 (2) |")
    add("| gear ratios | 6 gears (59 records), 7 gears (3: `BMW_M3E92_Tuner`, `Nissan_350Z_Drift`, "
        "`BMW_M3E92_Drift`) |")
    add("| torque points | 10 on all 62 |")
    add("| front / rear grip points | 3 / 3 on all 62 |")
    add("| drivetrains | RWD 43, AWD 15, FWD 4 |")
    add("| mass | 660–2,500 kg (median 1,462) |")
    add("| wheelbase | 2.000–3.584 m (median 2.694) |")
    add("| torque scale | 355–1,550 Nm (median 630) |")
    add("| limiter | 4,500–14,000 RPM (median 7,000) |")
    add("| final drive | 2.115–5.000 (median 3.500) |")
    add("| front / rear brake force | 1.0 / 0.725–1.5 |")
    add("")
    add("Every record's full physics vector (mass, inertia scales, track, tyre radii, gear ratios, "
        "torque curve, limiter, brakes, grip counts) is in `_work/vehicle-pipeline/cars.json` → "
        "`records[].physics.values`; the `.fields` copies are the exact T-005d field lists.")
    add("")
    add("The line-count spread is therefore the per-record gear-ratio cardinality (and the resulting "
        "expanded indices), not a missing field. The three 7-gear cars are the only physics outliers; "
        "all other arrays are constant.")
    add("")

    add("## 6. What 'all cars' needs")
    add("")
    add("| quantity | value |")
    add("| --- | ---: |")
    add(f"| records | {counts['records']} |")
    add(f"| A / B / C | {counts['classA']} / {counts['classB']} / {counts['classC']} |")
    add(f"| exact models (A+B) | {counts['exactModelMapped']} |")
    add(f"| model logical bytes (47) | {counts['modelLogicalBytes']:,} |")
    add(f"| LOD0 position bytes (47) | {counts['meshBytes']:,} |")
    add(f"| LOD0 index bytes (47) | {counts['indexBytes']:,} |")
    add(f"| UV0 stream bytes (47) | {counts['uv0Bytes']:,} |")
    add(f"| UV0 valid bytes (47) | {counts['uv0ValidBytes']:,} |")
    add(f"| referenced texture source bytes (47) | {counts['textureSourceBytes']:,} |")
    add(f"| referenced texture RGBA bytes (A exact + B bounded estimate) | {counts['textureRgbaBytes']:,} |")
    add("")
    add("Interpretation: **47 of 62** records can enter the existing geometry/material path today "
        "with no format work; **15** are blocked by the exact model-name rule. One of the 42 B cars "
        "(`Hummer_H2_OffRoad`) additionally needs a vehicle-specific part-layer exception (missing "
        "front brake-caliper member), so its manifest is not on the shortlist. The totals above are for "
        "the 47 exact-mapped models; the 15 C records contribute zero bytes because nothing is extracted "
        "for them. Reaching 62/62 therefore needs 15 documented alias/record decisions plus 42 B "
        "integrations, not new binary readers.")
    add("")

    add("## 7. Next cars, ranked by confidence")
    add("")
    add("The shortlist is the top of the B set after building a real part manifest with the committed "
        "builder into `_work/vehicle-pipeline/manifests/`. A **high** car has at least one proven wheel "
        "draw; a **medium** car has all 20 wheel draws preview-paired (the manifest is still complete "
        "and every draw is owned once). No drive claim is made until the integration commands in §8 run.")
    add("")
    add("| # | car | drive | mass | model bytes | draws | static | tex | parts | proven / ambiguous wheel draws | tier | conf | manifest SHA-256 |")
    add("|--:|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---|")
    for c in d["nextCars"]:
        nm = c["nextManifest"]
        add(f"| {c['index']} | `{c['slug']}` | {c['drivetrain']} | {c['mass']:.0f} | "
            f"{c['modelBytes']:,} | {c['sceneDraws']} | {c['staticAlbedoDraws']} | "
            f"{c['uniqueTextures']} | {nm.get('parts')} | "
            f"{nm.get('provenWheelDraws')} / {nm.get('ambiguousWheelDraws')} | "
            f"{nm.get('tyreProofTier')} | {c['confidence']} | "
            f"`{nm.get('manifestSha256')}` |")
    add("")
    add("Expected addition per car: one decoded body model and one part manifest/mesh; one "
        "RP_CarDynamics field list from the same record; one P52-style material/texture pass (the "
        "independent traversal already resolves the static-albedo and texture counts above); one body "
        "entry in `geometry.json` with the main-agent pins. The full per-car list is in "
        "`_work/vehicle-pipeline/cars.json` → `nextCars`.")
    add("")
    add("One B car is **not** on the shortlist: `Hummer_H2_OffRoad` (record 60) passes the model, "
        "Scene, MdlDat, physics and material checks, but the committed part builder rejects its front "
        "wheel because the group has `['brakeDisc','rim','tyre']` and no `brakeCaliper` element. "
        "Exact blocker: `part manifest: build_manifest: unsupported: wheel frontleft members are "
        "['brakeDisc', 'rim', 'tyre'], expected ['brakeCaliper', 'brakeDisc', 'rim', 'tyre']`. "
        "It stays class B with that vehicle-specific step; it is not a C record and nothing was guessed.")
    add("")

    add("## 8. Exact pipeline to add one B car")
    add("")
    add("The data commands are generic, but four integration points are still hard-coded to the current "
        "five cars and are **main-agent owned**. They must be updated in the same change or the gate "
        "will reject the enlarged roster:")
    add("")
    add("- `probes/car-materials/tools/build_roster_materials.py` line ~359: "
        "`len(index.get('mapped', [])) != 5` → the new car count.")
    add("- `probes/car-materials/tools/verify_roster_materials.py` line ~274: "
        "`carCount != 5` → the new car count.")
    add("- `probes/e1-drive/tools/build_car_textures.py`: `COMMITTED_ROSTER_INDEX` is the P52 five-car "
        "index hash; update it to the new P52 index hash.")
    add("- `probes/e1-drive/tools/build_geometry.mjs`: `COMMITTED_MANIFESTS` (one SHA-256 per car), "
        "`COMMITTED_CAR_INDEX` and `COMMITTED_CAR_TEXTURES` must be extended to the new committed "
        "artifacts.")
    add("")
    add("Then run, from the repository root, using the bundled Python/Node:")
    add("")
    add("```powershell")
    add('$py   = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"')
    add('$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"')
    add("")
    add("# 1. main-agent owned: append the B car to probes/e1-drive/cars/roster.json")
    add("#    { slug, name, recordId, recordIndex, layout, why }")
    add("#    recordId/recordIndex and the model path come from this audit (cars.json).")
    add("")
    add("# 2. decode the record into _work/e1-drive/cars/<slug>.fields + refresh cars.json")
    add("& $py probes/e1-drive/tools/car_roster.py")
    add("")
    add("# 3. build the real body manifest/mesh for every roster car")
    add("& $py probes/car-parts/tools/build_all_manifests.py")
    add("")
    add("# 4. rebuild the P52 material/texture manifests for the enlarged roster")
    add("& $py probes/car-materials/tools/build_roster_materials.py")
    add("& $py probes/car-materials/tools/verify_roster_materials.py")
    add("")
    add("# 5. export the E1 car textures/UV0 for the enlarged roster")
    add("& $py probes/e1-drive/tools/build_car_textures.py")
    add("")
    add("# 6. main-agent owned pins updated, then rebuild geometry and regenerate ghosts")
    add("& $node probes/e1-drive/tools/build_geometry.mjs")
    add("& $node probes/e1-drive/tools/verify_e1_drive.mjs --write-ghosts")
    add("& $node probes/e1-drive/tools/verify_e1_drive.mjs")
    add("")
    add("# 7. portable gate + browser capture")
    add("& $py tools/verify_asset_probe.py --skip-build")
    add("& $node probes/e1-drive/tools/capture_browser.mjs --mode sprint")
    add("```")
    add("")
    add("The ghost step matters: `verify_e1_drive.mjs` compares `ghosts/index.json` and the ten "
        "committed reference files (5 cars × 310 m / 29 m). Adding a car requires `--write-ghosts` "
        "and the resulting committed files for the new car. The browser car selector reads the "
        "generated roster, so no `web/cars.js` edit is needed once the roster is enlarged.")
    add("")

    add("## 9. Verification, hashes and evidence")
    add("")
    add(f"`probes/vehicle-pipeline/tools/verify_vehicle_pipeline.py` re-runs the committed readers "
        f"against the artifact and reports **{verify['status']}** with "
        f"**{verify['passed']}/{verify['checks']}** checks and **{verify['failed']}** failures. It "
        "re-decodes every `.fields` file byte-identically, re-hashes every decoded model, reproduces "
        "the Scene report and chunk tree for all 47 mapped models, re-runs three sample material "
        "traversals, and checks all ten next-car manifests and the CSV/hash documents.")
    add("")
    add("| artifact | bytes | SHA-256 |")
    add("| --- | ---: | --- |")
    for name in ("cars.json", "summary.csv"):
        entry = hashes["outputs"][name]
        add(f"| `_work/vehicle-pipeline/{name}` | {entry['bytes']:,} | `{entry['sha256']}` |")
    add(f"| `_work/vehicle-pipeline/hashes.json` | {Path(OUT / 'hashes.json').stat().st_size:,} | "
        f"`{sha256(OUT / 'hashes.json')}` |")
    add(f"| `_work/vehicle-pipeline/verify.json` | {Path(OUT / 'verify.json').stat().st_size:,} | "
        f"`{sha256(OUT / 'verify.json')}` |")
    add("")
    add("| input | SHA-256 |")
    add("| --- | --- |")
    add(f"| `_work/e1-drive/cars.json` | `{d['source']['cars']['sha256']}` |")
    add(f"| `probes/e1-drive/cars/roster.json` | `{d['source']['roster']['sha256']}` |")
    add(f"| `_work/car-parts/cars/index.json` | `{d['source']['carPartsIndex']['sha256']}` |")
    add(f"| `_work/car-materials/roster/index.json` | `{d['source']['materialsIndex']['sha256']}` |")
    add("")
    add("| evidence | content |")
    add("| --- | --- |")
    add("| `probes/vehicle-pipeline/tools/audit_cars.py` | the audit builder |")
    add("| `probes/vehicle-pipeline/tools/verify_vehicle_pipeline.py` | the gate |")
    add("| `probes/vehicle-pipeline/tools/build_doc.py` | this document's generator |")
    add("| `_work/vehicle-pipeline/cars.json` | full 62-record matrix, mapping, physics, scene, MdlDat, materials, next list |")
    add("| `_work/vehicle-pipeline/summary.csv` | one flat row per record |")
    add("| `_work/vehicle-pipeline/fields/` | 62 decoded `.fields` copies (`name<TAB>value`, CRLF) |")
    add("| `_work/vehicle-pipeline/models/` | 47 decoded models + content hashes |")
    add("| `_work/vehicle-pipeline/scene/` | 47 compact committed-Scene reports (draws, UV0, metadata) |")
    add("| `_work/vehicle-pipeline/materials/<slug>/` | 47 independent material traversals |")
    add("| `_work/vehicle-pipeline/manifests/<slug>/` | 10 next-car part manifests/meshes |")
    add("| `_work/logs/vehicle-pipeline/audit.log` | builder stdout |")
    add("| `_work/logs/vehicle-pipeline/verify.log` | gate stdout |")
    add("")

    add("## 10. Limits")
    add("")
    for limit in d["limits"]:
        add("- " + limit)
    add("")
    add("Additional audit limits:")
    add("")
    add("- Material traversal is the independent `tools/inspect_car_materials.py` pass, not the P52 "
        "committed C++-cross-checked manifest; a B car's static/texture counts are evidence of "
        "available data, not a P52 proof.")
    add("- The A cars use the committed P52 numbers; the B texture RGBA total is an upper-bound "
        "estimate from descriptor dimensions, not decoded pixels.")
    add("- The 15 C records were not extracted at all. Their nearest-model lists are similarity "
        "evidence only; adding an alias is a content decision that must be documented separately.")
    add("- The `Hummer_H2_OffRoad` part-layer exception is recorded, not patched.")
    add("- No renderer, driver, browser, multiplayer or full-game claim is made for any B or C car.")
    add("")

    DOC.parent.mkdir(parents=True, exist_ok=True)
    DOC.write_bytes(("\n".join(lines) + "\n").encode("utf-8"))
    print(json.dumps({"doc": str(DOC), "bytes": DOC.stat().st_size,
                      "sha256": sha256(DOC)}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
