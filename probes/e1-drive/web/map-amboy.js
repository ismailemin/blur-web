// Backwards-compatible Amboy import surface.
//
// The map package loader/validator was generalized for the M3 second map; the
// implementation lives in `map-package.js`. This module keeps the original
// Amboy names for existing callers.

export {
  bytesSha256,
  mergeMapGeometry,
  textSha256,
  validateMapPackage as validateAmboyPackage
} from './map-package.js';
