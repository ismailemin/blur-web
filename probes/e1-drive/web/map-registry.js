// Map registry for the E1 drive page.
//
// `?map=river` (the default) is the existing M1 single-player route: its paths,
// pins, layouts and best-time keys are byte-for-byte the values the page used
// before this registry existed. `?map=amboy` selects the M3 usa_amboy map
// package built by `tools/build_map_amboy.mjs` from the committed map-slice
// render package.
//
// The pins are hard failures, not hints: a different package, a regenerated
// layout or a hand-edited map document must fail loudly instead of silently
// rendering a different map.

export const MAP_DEFAULT = 'river';

/** Map ids accepted by `?map=`. */
export const MAP_IDS = Object.freeze(['river', 'amboy']);

export const MAPS = Object.freeze({
  river: Object.freeze({
    id: 'river',
    label: 'River',
    level: 'usa_la_river',
    kind: 'single-map',
    geometryUrl: '/_work/e1-drive/geometry.json',
    physicsUrl: '/_work/e1-drive/Level.levelphysics',
    spawnUrl: '/_work/e1-drive/spawn.json',
    layoutUrl: null,
    bestKey: null,
    courses: Object.freeze(['310', 'short', 'lap', 'free']),
    multiplayer: true,
    propLayer: true,
    ghost: true,
    pins: null
  }),
  amboy: Object.freeze({
    id: 'amboy',
    label: 'Amboy',
    level: 'usa_amboy',
    kind: 'map-package',
    // Generated from the read-only packages; served from `_work/e1-drive/amboy/`.
    geometryUrl: '/_work/e1-drive/amboy/map.json',
    // The car bodies, materials, light and camera intrinsics stay in the
    // existing committed geometry document; the Amboy package replaces only the
    // map half. This avoids copying the 15-car body meshes into a second file.
    baseGeometryUrl: '/_work/e1-drive/geometry.json',
    physicsUrl: '/map-data/usa_amboy/Level.levelphysics',
    spawnUrl: null,
    layoutUrl: '/_work/e1-drive/amboy/layout.json',
    bestKey: 'e1-drive.sprint.best.v3.amboy',
    courses: Object.freeze(['310']),
    multiplayer: false,
    propLayer: false,
    ghost: false,
    pins: Object.freeze({
      mapFileSha256: 'sha256:52acd10348ab1e747461eae3f5ec9854de1300910096dc50bc8ab7f06850e01a',
      mapContentHash: 'sha256:9290bd3f91160f232d14e5fea14ed9253721fd91c2f3bb49daf0ca307244ffd4',
      layoutFileSha256: 'sha256:b89ae430dff3aaea3511abc6244687430ec66433055bfbcb4eb63b3a1d364f8d',
      layoutContentHash: 'sha256:bccb6bed853827099e5efb55381cb638fda83690201ade40d80fbb095b08f644',
      renderFileSha256: 'sha256:0f73b248a58fe8b650b0f862898ad8b9affdcb61f0f6e70f9637d24d96231117',
      renderContentHash: 'sha256:626d39534bc3a37e5878c6801443c580aba576e45f3cba10ddb73a7edc50bf71',
      sliceFileSha256: 'sha256:8f5e07d681353b47abb799fdcd69b716fecca225d7a2f76dab48bf14b501b3d7',
      sliceContentHash: 'sha256:61915aedfaab43b6b327c3ef803c896ea55397bc7dc7a4d2757f340632043ec8',
      physicsFileSha256: 'sha256:18c73e1cca6f13c5bbd4937454f25ec3163a67553fea6842a7797400af2175f2',
      physicsBytes: 4442528,
      draws: 1201,
      drawTriangles: 269300,
      textures: 179,
      textureBytes: 2654272,
      vertices: 529624,
      indices: 1046844,
      decalDraws: 334,
      diagnosticDraws: 71,
      blockedDraws: 405,
      unsupportedSections: 27,
      instanceDescriptions: 366,
      collisionTriangles: 63708,
      pathLengthMetres: 2060.595408,
      checkpointArcs: Object.freeze([686.862337, 1373.667341])
    })
  })
});

/** Resolve a `?map=` value, defaulting to River and rejecting unknown ids. */
export function resolveMap(value) {
  if (value === null || value === undefined || value === '') return MAPS[MAP_DEFAULT];
  if (!MAP_IDS.includes(value)) {
    throw new Error('unknown map ' + JSON.stringify(value) + ' (use ' + MAP_IDS.join(', ') + ')');
  }
  return MAPS[value];
}
