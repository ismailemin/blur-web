# Vehicle expansion plan — from 5 proven cars to the full roster

Status: design, 7 November 2026. Based on the V1 audit
(`docs/work/analysis/vehicle-pipeline.md`, 542/542 checks).

## What the audit proved

| Class | Count | Meaning |
|---|---:|---|
| A | 5 | fully proven (model + fields + UV + textures + drive run) |
| B | 42 | exact `.model`, Scene/MdlDat read, materials, physics gate pass; not in the drive slice |
| C | 15 | no exact model entry; nearest pak names recorded, no alias applied |

All 62 physics field sets pass the schema gate. The 42 B cars have 51–135 Scene
draws, 22–95 static-albedo draws, 5–10 textures and 4 wheel groups.

## Why B cars are not playable yet

Four main-agent-owned guards still assume exactly five cars:

1. `probes/car-materials/tools/build_roster_materials.py` —
   `len(index.get('mapped', [])) != 5`.
2. `probes/car-materials/tools/verify_roster_materials.py` — `carCount != 5`.
3. `probes/e1-drive/tools/build_car_textures.py` — `COMMITTED_ROSTER_INDEX`
   five-car hash.
4. `probes/e1-drive/tools/build_geometry.mjs` — `COMMITTED_MANIFESTS`,
   `COMMITTED_CAR_INDEX`, `COMMITTED_CAR_TEXTURES`.

Plus the ghost set (5 cars × 310 m/short) and the verifier's per-car anchors.

## Increment plan

**Batch 1 (10 cars):** Audi TT, Ford F100 OffRoad, Ford FR100, VW Golf W12,
Ford Mustang GTR, Dodge Viper ACR, Audi S3, Ford Bronco, Nissan Skyline R34,
Chevrolet SoCal HHR. These have high confidence manifests and modest draw
counts.

**Batch 2 (next 10):** the remaining high-confidence B cars.

**Batch 3 (rest):** remaining B cars, then decide the C aliases only where the
record provably references the same model (no nearest-name guessing).

## Required changes per batch

1. `probes/e1-drive/cars/roster.json`: append `{slug, name, recordId,
   recordIndex, layout, why}` from `_work/vehicle-pipeline/cars.json`.
2. Generalize the four guards from a fixed count to the roster length and pin
   the new manifest hashes.
3. `python probes/e1-drive/tools/car_roster.py`
4. `python probes/car-parts/tools/build_all_manifests.py`
5. `python probes/car-materials/tools/build_roster_materials.py` +
   `verify_roster_materials.py` (batch count must match)
6. `python probes/e1-drive/tools/build_car_textures.py`
7. `node probes/e1-drive/tools/build_geometry.mjs` (geometry grows; record size)
8. `node probes/e1-drive/tools/verify_e1_drive.mjs --write-ghosts` (new
   reference ghosts for the batch)
9. `node probes/e1-drive/tools/verify_e1_drive.mjs` (all anchors)
10. `python tools/verify_asset_probe.py --skip-build`
11. Browser capture: sprint + lap + free for a sample of the batch; car select
    includes them; console 0.

## Acceptance

- Every added car: own `.model` body/wheels, own textures or an explicit
  diagnostic reason, a completed scripted 310 m run, ghost record, and a
  restart in the same instance.
- The five original anchors do not move.
- Geometry/page-load growth is recorded; if it exceeds a practical budget,
  split the roster into per-car asset chunks instead of one giant geometry.
- No C car is claimed drivable without an exact model path.

## Risks

- Geometry/texture bytes grow roughly 5–6 MB per car; 47 B cars would be
  ~250 MB. A content-package split (one car mesh at a time) is likely required
  before "all cars"; decide after batch 1 measurements.
- The ghost set doubles per car per course; keep it compact (base64 float32).
- Some B cars have ambiguous wheel groups (20/20 preview-paired); a driven
  screenshot must confirm the wheel placement before the car is called
  complete.

## Batch 1 result (15 cars) and batch 2 composition

Batch 1 shipped 10 B cars; all 15 cars are proven (browser 60/60, 2254 checks).
The single 106.9 MB geometry is 101.9 MiB, so **chunking is mandatory before
batch 2** (`VEHICLE_CHUNKING.md`).

V3 (8 Nov) proved **14 of the 15 C records** with a record-level chain
(`AmaxVehicle.dynamics` handle → XT refs → `RP_CarDynamics` id → engine
`models/vehicles/%s.model`), validated on 47/47 existing records:

- 7 high-confidence C (proven wheel draws): records 18, 22, 25, 47, 63, 65, 75.
- 7 medium C (all 20 wheel draws preview-paired): 1, 7, 23, 31, 39, 48, 71.
- `DefaultCar` stays unsupported (no dynamics handle; fallback only).

V4 resolved the Hummer H2 blocker: the model genuinely has no brake caliper
(`cali_01` is a license-plate texture); the builder accepts a typed
`caliper:"absent"` with a staged manifest. It can join batch 2 as medium.

Total provable: **61 / 62** records.

Recommended batch 2 (10 cars): the 7 high-confidence C + 3 high-confidence B,
then batch 3 = the 7 medium C + remaining B + Hummer. The exact roster is
chosen after chunking lands so the per-car byte budget is measured.
