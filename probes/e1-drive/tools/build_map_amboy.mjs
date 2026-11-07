// Build the E1 `usa_amboy` map artifacts from the committed map-slice packages.
//
//   node probes/e1-drive/tools/build_map_amboy.mjs
//   node probes/e1-drive/tools/build_map_amboy.mjs --check   (re-build and compare)
//
// This is the Amboy instantiation of the shared `map_package_builder.mjs`.
// Inputs are the MAP2/READ1 slice and the AMB1 render package, read-only. Outputs
// are `_work/e1-drive/amboy/{map,layout}.json` (generated game data, never
// committed). A changed package is a hard failure.

import { buildMapPackage } from './map_package_builder.mjs';

const CHECK = process.argv.includes('--check');
const result = buildMapPackage('amboy', { check: CHECK });
console.log(JSON.stringify(result, null, 2));
