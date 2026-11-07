# M3 — map integration plan (from the 19-level audit and the Amboy slice)

Status: design, 7 November 2026. Inputs: M1 audit
(`docs/work/analysis/map-pipeline.md`), MAP2 slice
(`docs/work/analysis/map-slice-amboy.md`).

## Current state

- `usa_la_river` is the only integrated map (A).
- 16 B maps have collision + direct draws; 2 C maps (multiplayer bowl/highrise)
  have almost no draw coverage.
- `usa_amboy` has a complete data slice:
  - 63,708 collision triangles, spawn `(230, 1128)`, 2,060.6 m path;
  - 48/75 draw sections, 1,606 draws / 348,948 triangles, **1,606/1,606 UV0**;
  - **0 textures bound** (direct draws return `albedoTexture:null`);
  - 27 unsupported sections, 366 instances skipped, no normals;
  - physics settles on the collision (61/61 ticks, 4/4 contacts).

## Integration shape

The e1 page is River-specific (`LEVEL` path, geometry, spawn, packet). M3 needs
a **map registry**:

```
?map=river (default) | amboy | gracia | ...
```

Each map package provides:

| field | source |
|---|---|
| `physics` | `Level.levelphysics` bytes |
| `collision` | triangles/vertices + simple shapes (Box/Cylinder) |
| `draws` | sections, positions, UV0, normals if available, indices, material refs |
| `textures` | decoded RGBA + sampler hints (sRGB/mips) |
| `layout` | spawn, gates, checkpoints, finish, length, coverage |
| `props` | prop collider manifest for that map |
| `hashes` | file/content pins |

The producer builds a render packet v1.1 for the map; the consumer uploads the
map's geometry/textures once. No per-map shader fork.

## Blockers per candidate

| Map | Path | Sections | Blockers |
|---|---:|---:|---|
| **usa_amboy** | 2,060.6 m | 48/75 | 0 textures, 27 unsupported sections, 366 instances, no normals, simple collision shapes |
| spa_barcelona_gracia | 624.9 m | 88/92 | 4 unsupported sections, textures/materials, spawn |
| usa_la_longbeachdocks | 818.4 m | 74/76 | 2 unsupported sections, fluid mesh, textures |

## Step order

1. **Amboy render slice**: bind materials/textures for the direct draws. If the
   source has no static albedo (MAP2 found none), keep the draws diagnostic with
   the exact reason and add a labelled fallback; do not invent textures.
2. **Map packet**: generalize `build_geometry`/packet producer to take a map
   package; add `?map=amboy`; spawn/physics from the slice; render + console 0.
3. **Map rules**: use the slice layout with R1; add map selection to the lobby.
4. **Second map**: gracia (88/92 sections) after Amboy; then longbeachdocks.
5. **C maps**: require instance traversal or a different draw pass; keep them
   unsupported until measured.

## Acceptance per map

- Physics settle on the map collision at the package spawn.
- Playable path (measured) with ordered gates and a finish.
- Real draws/textures or a documented diagnostic fallback; no invented data.
- `verify_e1_map` (new) + browser capture console 0.
- The River gates stay unchanged.

## Limits

- Direct LOD0 draws only; no instances, shaders, normals, simple collision
  shapes, retail start line or lap rules.
- Map asset packages are local game data; not committed.
