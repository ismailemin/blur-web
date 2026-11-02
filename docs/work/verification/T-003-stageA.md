# T-003 verification — Stage A bounds grouping

**Date:** 2 November 2026
**Scope:** `level_instances_all_inspect` all-instance path; Stage A only.

## Change

Contiguous instances are grouped by an identical archived CullNode bounds record
and identical VB/IB resource blocks. The union of the group's transformed draw
AABBs is compared to the shared record at `1e-4`. A rejected group is rolled back
as a whole and counted in `unsupportedBoundsInstances`. Metadata adds
`boundsGrouping` and `boundsGroups`; `emittedInstanceCount` remains an instance
count.

This matches `renderlistbuild.cpp:579`: one object record is written for each of
its draws, so single-draw comparison against the object record was wrong.

## Results

| Block | Emitted | Unsupported | Vertices | Triangles | Max error |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 27 | 22 | 0 | 13,162 | 10,308 | 6.02444e-05 |
| 15 | 12 | 0 | 7,234 | 5,181 | 5.75171e-05 |
| 17 | 2 | 0 | 2,528 | 1,812 | 5.35334e-05 |
| 26 | 0 | 10 | — | — | — |
| 32 | 0 | 10 | — | — | — |

Stage A total: **36 instances / 22,924 vertices / 17,301 triangles**, matching the
predicted values. Blocks 26/32 need cross-chunk group assembly (Stage B); block31
needs its extra ChunkInfo prerequisite.

## Gates

```powershell
python tools/verify_asset_probe.py
ctest --test-dir _work/build/asset-reader-native -C Release --output-on-failure
```

- Native `/W4` build clean.
- Suite: **29/29 PASS** (new `scheduler-probe` step included).
- CTest: **14/14 PASS**.
- Native/WASM all-instance JSON deep-equal.
- Deterministic: repeated native runs identical.

## Browser visual check

Headless Edge with WebGPU (`--enable-unsafe-webgpu`), CDP-driven preset click.

- `River · 22 instance`: **22 instance çizildi · 0 sınır uyuşmazlığı · 35 başka
  blok · 10308 üçgen**; WebGPU **13.162 vertex / 10.308 üçgen**; console empty.
- `River · tüm desteklenen`: **36 instance çizildi · 20 sınır uyuşmazlığı · 1 blok
  atlandı · 17301 üçgen**; console empty.

Evidence: `_work/logs/t003-stageA-river-instances.png`,
`_work/logs/t003-stageA-river-all-blocks.png`,
`_work/logs/t003-stageA-browser-river-instances.json`,
`_work/logs/t003-stageA-browser-river-all-blocks.json`,
`_work/verification/level-instances-native-wasm.json`.

## Limits

- Stage B (blocks 26/32) and block31 prerequisites are not implemented.
- Materials, visibility and higher LODs remain omitted.
- Headless Edge is a proxy; the user's physical Chrome/Brave check should confirm
  the same counts.
