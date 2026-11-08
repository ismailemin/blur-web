// Build the E1 `usa_la_longbeachdocks` map artifacts from the committed
// map-slice packages (MAP8).
//
//   node probes/e1-drive/tools/build_map_longbeach.mjs
//   node probes/e1-drive/tools/build_map_longbeach.mjs --check   (re-build and compare)
//
// This is the Longbeach instantiation of the shared `map_package_builder.mjs`.
// Inputs (read-only): `_work/map-slice/longbeach/` (slice + collision + physics
// settle) and `_work/map-slice/longbeach-render/` (1,039 opaque draws, 164
// textures, 102 labelled blocked draws, no effect/decal draws), plus the
// installed `game-data/Blur/levels/usa_la_longbeachdocks/Level.levelphysics`.
//
// Outputs (generated game data, never committed):
//   _work/e1-drive/longbeach/map.json
//   _work/e1-drive/longbeach/layout.json
// A changed package is a hard failure: the file and content hashes are also the
// page's pin set.

import { buildMapPackage } from './map_package_builder.mjs';

const CHECK = process.argv.includes('--check');
const result = buildMapPackage('longbeach', { check: CHECK });
console.log(JSON.stringify(result, null, 2));
