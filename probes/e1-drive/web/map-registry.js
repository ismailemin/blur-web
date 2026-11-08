// Map registry for the E1 drive page.
//
// `?map=river` (the default) is the existing M1 single-player route: its paths,
// pins, layouts and best-time keys are byte-for-byte the values the page used
// before this registry existed. `?map=amboy` selects the M3 usa_amboy map
// package built by `tools/build_map_amboy.mjs`, and `?map=gracia` selects the
// M3 spa_barcelona_gracia package built by `tools/build_map_gracia.mjs`, both
// from their committed map-slice render packages.
//
// The pins are hard failures, not hints: a different package, a regenerated
// layout or a hand-edited map document must fail loudly instead of silently
// rendering a different map.

export const MAP_DEFAULT = 'river';

/** Map ids accepted by `?map=`. */
export const MAP_IDS = Object.freeze(['river', 'amboy', 'gracia']);

export const MAPS = Object.freeze({
  river: Object.freeze({
    id: 'river',
    label: 'River',
    level: 'usa_la_river',
    kind: 'single-map',
    geometryUrl: '/_work/e1-drive/geometry.json',
    // Chunked load path (docs/plan/VEHICLE_CHUNKING.md): the page fetches the
    // level document + the selected car chunk, never the combined debug file.
    levelGeometryUrl: '/_work/e1-drive/level.geometry.json',
    carIndexUrl: '/_work/e1-drive/car-bodies.index.json',
    baseGeometryUrl: null,
    physicsUrl: '/_work/e1-drive/Level.levelphysics',
    spawnUrl: '/_work/e1-drive/spawn.json',
    layoutUrl: null,
    bestKey: null,
    courses: Object.freeze(['310', 'short', 'lap', 'free']),
    multiplayer: true,
    propLayer: true,
    ghost: true,
    pins: null,
    // Multiplayer map record pins (M3/M1.1). The River route has no separate
    // package document, so its record pins the always-loaded level chunk, the
    // 310 m layout and the Level.levelphysics file. The combined debug geometry
    // is not part of the wire identity.
    mpPins: Object.freeze({
      packageHash: 'sha256:838d33408c23f2d8a9c3911cc92a9a4b3fcc3b5eeb53276c59db09efcf88483d',
      layoutHash: 'sha256:9240e9c136059ccd209992999b8570860f99f1bedd4b4ec9ff0a56d5cf8cad53',
      physicsHash: 'sha256:1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28',
      packageFileSha256: 'sha256:838d33408c23f2d8a9c3911cc92a9a4b3fcc3b5eeb53276c59db09efcf88483d',
      layoutFileSha256: 'sha256:516647664f7ff3590db457f8685a3d4308b030b86fbf962f0e9bfa708da89e49',
      physicsFileSha256: 'sha256:1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28',
      packageBytes: 9663610,
      layoutBytes: 386521,
      physicsBytes: 1945409
    })
  }),
  amboy: Object.freeze({
    id: 'amboy',
    label: 'Amboy',
    level: 'usa_amboy',
    kind: 'map-package',
    // Generated from the read-only packages; served from `_work/e1-drive/amboy/`.
    geometryUrl: '/_work/e1-drive/amboy/map.json',
    // The car bodies, materials, light and camera intrinsics stay in the small
    // committed base document; the Amboy package replaces only the map half and
    // the selected car comes from its own chunk.
    baseGeometryUrl: '/_work/e1-drive/base.geometry.json',
    carIndexUrl: '/_work/e1-drive/car-bodies.index.json',
    physicsUrl: '/map-data/usa_amboy/Level.levelphysics',
    spawnUrl: null,
    layoutUrl: '/_work/e1-drive/amboy/layout.json',
    bestKey: 'e1-drive.sprint.best.v3.amboy',
    courses: Object.freeze(['310']),
    multiplayer: true,
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
      checkpointArcs: Object.freeze([686.862337, 1373.667341]),
      sampleCount: 8673,
      renderLabel: 'amboy-direct-draws',
      courseId: 'amboy'
    }),
    mpPins: Object.freeze({
      packageHash: 'sha256:9290bd3f91160f232d14e5fea14ed9253721fd91c2f3bb49daf0ca307244ffd4',
      layoutHash: 'sha256:bccb6bed853827099e5efb55381cb638fda83690201ade40d80fbb095b08f644',
      physicsHash: 'sha256:18c73e1cca6f13c5bbd4937454f25ec3163a67553fea6842a7797400af2175f2',
      packageFileSha256: 'sha256:52acd10348ab1e747461eae3f5ec9854de1300910096dc50bc8ab7f06850e01a',
      layoutFileSha256: 'sha256:b89ae430dff3aaea3511abc6244687430ec66433055bfbcb4eb63b3a1d364f8d',
      physicsFileSha256: 'sha256:18c73e1cca6f13c5bbd4937454f25ec3163a67553fea6842a7797400af2175f2',
      packageBytes: 49524812,
      layoutBytes: 1198445,
      physicsBytes: 4442528
    })
  }),
  gracia: Object.freeze({
    id: 'gracia',
    label: 'Gracia',
    level: 'spa_barcelona_gracia',
    kind: 'map-package',
    // Generated from the read-only MAP5 packages; served from `_work/e1-drive/gracia/`.
    geometryUrl: '/_work/e1-drive/gracia/map.json',
    // Car bodies, materials, light and camera intrinsics stay in the small
    // committed base document; the Gracia package replaces only the map half.
    baseGeometryUrl: '/_work/e1-drive/base.geometry.json',
    carIndexUrl: '/_work/e1-drive/car-bodies.index.json',
    physicsUrl: '/map-data/spa_barcelona_gracia/Level.levelphysics',
    spawnUrl: null,
    layoutUrl: '/_work/e1-drive/gracia/layout.json',
    bestKey: 'e1-drive.sprint.best.v3.gracia',
    courses: Object.freeze(['310']),
    multiplayer: true,
    propLayer: false,
    ghost: false,
    pins: Object.freeze({
      mapFileSha256: 'sha256:562b56889b80d3368d5a1f08f009d6f351b6d3de33b3539df51c666a737a6a0d',
      mapContentHash: 'sha256:dc60abe8527d28d659af1dbed2098928214f31dc3b62d0984369b40238b1b831',
      layoutFileSha256: 'sha256:e2f9a1114c283ca84838db96286c5482e9b7b6c4fec779b34bbb4a579991a3b8',
      layoutContentHash: 'sha256:1aa622fd77a4637d5b2ddfd9292cc8cd3afd61df197db581db078826133faf30',
      renderFileSha256: 'sha256:fd6266501fedb8eada56a0bc2e0b166eb3baff0345e1548786c8bcf4e2b3f514',
      renderContentHash: 'sha256:1fae82cf504afd9e3a88f55a0f310d7b09c8d42e494d23d775e80ef8b8516280',
      sliceFileSha256: 'sha256:e1e1fe62c6e36d8ea71a7b82303b4ff4b6abafcb9fad2810e019be1292652534',
      sliceContentHash: 'sha256:c1bdf1a7c91d0cd0d1866e28ab9140975401e9927f8466facded2cc5d6e89fef',
      physicsFileSha256: 'sha256:acfb58a20ff7adced0b2424dc39474509e6b4c4c805729fd9463bdd310a173c0',
      physicsBytes: 5569121,
      draws: 2627,
      drawTriangles: 365451,
      textures: 734,
      textureBytes: 3247360,
      vertices: 738905,
      indices: 1651896,
      decalDraws: 518,
      diagnosticDraws: 435,
      blockedDraws: 953,
      unsupportedSections: 4,
      instanceDescriptions: 2714,
      collisionTriangles: 113270,
      pathLengthMetres: 624.913781,
      checkpointArcs: Object.freeze([208.343397, 416.652055]),
      sampleCount: 2571,
      renderLabel: 'gracia-direct-draws',
      courseId: 'gracia'
    }),
    mpPins: Object.freeze({
      packageHash: 'sha256:dc60abe8527d28d659af1dbed2098928214f31dc3b62d0984369b40238b1b831',
      layoutHash: 'sha256:1aa622fd77a4637d5b2ddfd9292cc8cd3afd61df197db581db078826133faf30',
      physicsHash: 'sha256:acfb58a20ff7adced0b2424dc39474509e6b4c4c805729fd9463bdd310a173c0',
      packageFileSha256: 'sha256:562b56889b80d3368d5a1f08f009d6f351b6d3de33b3539df51c666a737a6a0d',
      layoutFileSha256: 'sha256:e2f9a1114c283ca84838db96286c5482e9b7b6c4fec779b34bbb4a579991a3b8',
      physicsFileSha256: 'sha256:acfb58a20ff7adced0b2424dc39474509e6b4c4c805729fd9463bdd310a173c0',
      packageBytes: 72616715,
      layoutBytes: 312569,
      physicsBytes: 5569121
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

/** Map ids the online room may select. All three are MP-capable in M3. */
export const MP_MAP_IDS = Object.freeze(MAP_IDS.filter((id) => MAPS[id].multiplayer === true));

/** The pinned multiplayer record for a map id (null if the id is unknown). */
export function mpPinsForMap(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!MAP_IDS.includes(value)) return null;
  return MAPS[value].mpPins ?? null;
}
