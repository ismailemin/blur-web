// Build the E1 `spa_barcelona_gracia` map artifacts from the committed map-slice
// packages (MAP5).
//
//   node probes/e1-drive/tools/build_map_gracia.mjs
//   node probes/e1-drive/tools/build_map_gracia.mjs --check   (re-build and compare)
//
// This is the Gracia instantiation of the shared `map_package_builder.mjs`.
// Inputs (read-only): `_work/map-slice/gracia/` (slice + collision + physics
// settle) and `_work/map-slice/gracia-render/` (2,627 opaque draws, 734 textures,
// 953 labelled blocked draws), plus the installed
// `game-data/Blur/levels/spa_barcelona_gracia/Level.levelphysics`.
//
// Outputs (generated game data, never committed):
//   _work/e1-drive/gracia/map.json
//   _work/e1-drive/gracia/layout.json
// A changed package is a hard failure: the file and content hashes are also the
// page's pin set.

import { buildMapPackage } from './map_package_builder.mjs';

const CHECK = process.argv.includes('--check');
const result = buildMapPackage('gracia', { check: CHECK });
console.log(JSON.stringify(result, null, 2));
