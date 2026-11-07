# Vehicle asset chunking (required before batch 2)

Status: design, 7 November 2026. The 15-car batch ships one 106,864,802 B
`geometry.json` (101.91 MiB). The declared batch-1 budget was 128 MiB; batch 2
would be roughly 168 MB, so the single-file geometry must be split before
adding more cars.

## 1. Current shape

```
_work/e1-drive/
  geometry.json           # level + track visual + all 15 car bodies
  car-textures.json       # 673 textured draws / 112 textures / 46.5 MB RGBA
  car-uv-<slug>.bin       # per-car UV0
  module/e1_drive.wasm    # physics
```

`packet-adapter` loads the whole geometry, builds one packet and uploads the
selected car's draws; the other car bodies are already in memory.

## 2. Target chunks

```
_work/e1-drive/
  level.geometry.json          # collision, track visual, level props, layout refs
  car-bodies.index.json        # slug -> chunk file + hashes + draw ranges
  cars/<slug>.geometry.json    # body + wheels + parts for one car
  cars/<slug>.uv0.bin
  car-textures/<slug>.json     # per-car texture manifest + RGBA
  packet/level.json            # level packet v1.1 (shared)
```

Rules:

- The level chunk is always loaded.
- The selected car chunk is loaded on demand (and cached).
- In MP, the remote car chunk is loaded once when the guest/host car differs;
  if it cannot be loaded, fall back to the same car with a labelled notice.
- Ghosts store only pose data, not meshes.

## 3. Build changes

`build_geometry.mjs` becomes a chunk writer:

1. Build the level document as today (collision/track visual/level props).
2. Build each car body/parts/textures separately and write
   `cars/<slug>.geometry.json` + `cars/<slug>.uv0.bin`.
3. Write the index with per-chunk SHA-256, byte size, draw counts and texture
   ids.
4. Keep the full combined file only as a debug artifact (not shipped to the
   page).

`packet-adapter` takes `{levelChunk, carChunk}` and produces the same packet
schema; per-car anchors must not move.

## 4. Acceptance

1. Page load fetches level + selected car only; measured bytes and time are
   recorded.
2. Car switching works without a reload; the second car is fetched once.
3. MP with two different cars loads both chunks; a missing chunk shows a typed
   error, no silent wrong body.
4. All existing per-car anchors/ghosts/hashes unchanged.
5. Batch 2 (next 10 cars) lands with a measured page load inside the budget.
6. `verify_e1_drive` + asset suite + captures stay green.

## 5. Limits

- Texture RGBA is still the dominant size (46.5 MB for 15 cars); per-car
  texture packs are required for the same reason.
- Chunking changes the packet producer/consumer, not physics or the roster.
- No streaming/lazy eviction in the first chunking pass; one level + one/two
  cars resident.
