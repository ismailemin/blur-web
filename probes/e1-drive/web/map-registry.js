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
export const MAP_IDS = Object.freeze(['river', 'amboy', 'gracia', 'longbeach', 'observatory', 'downtown', 'mharuna',
  'highrise', 'shutoko', 'oval', 'amboy-mp']);

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
      packageHash: 'sha256:7522a7bdc1b7464a39f07021e807b90909b82b53bd76b88dd8d9e9b86bbec3ea',
      layoutHash: 'sha256:9240e9c136059ccd209992999b8570860f99f1bedd4b4ec9ff0a56d5cf8cad53',
      physicsHash: 'sha256:1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28',
      packageFileSha256: 'sha256:7522a7bdc1b7464a39f07021e807b90909b82b53bd76b88dd8d9e9b86bbec3ea',
      layoutFileSha256: 'sha256:516647664f7ff3590db457f8685a3d4308b030b86fbf962f0e9bfa708da89e49',
      physicsFileSha256: 'sha256:1e678b2dff61b6d3a3d5d95a5160c3f713290251667cb27c55e262175efe4e28',
      packageBytes: 9665779,
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
    // The measured closed lap (probes/map-laps loop-01, 284.4524 m, three laps).
    // It is a different document from the point-to-point layout, so it carries
    // its own pin and skips the package layout validator.
    lapLayoutUrl: '/map-laps/data/amboy-loop01-lap.json',
    lapLayoutFileSha256: 'sha256:06e4cc1fad32c0450a3c1eaefbf66dc02bb45d8f7e4a9c89bde5b577de834519',
    lapLayoutContentHash: 'sha256:c878ba69f959ca7b4bdbd14faf4904b896ec8ea082b261eb2627068a7f9018a4',
    bestKey: 'e1-drive.sprint.best.v3.amboy',
    courses: Object.freeze(['310', 'lap']),
    multiplayer: true,
    propLayer: true,
    // The Amboy prop colliders (roadside profile: 484 active, the measured line
    // stays clear). The loader manifest names the colliders document; both files
    // are pinned by SHA-256.
    propPins: Object.freeze({
      label: 'amboy-roadside',
      profile: 'roadside',
      manifest: '_work/map-props/manifest-amboy.json',
      manifestFileSha256: 'sha256:c0bc83f575268ab70b45490fb07248d4e446fb2e2b1dfe25e42c325d7d6cfb44',
      collidersFile: 'colliders-amboy.json',
      collidersFileSha256: 'sha256:7007b72afea3a315f04cb02cad92002801fdd733463f25e7e7797c9aaa40d05b',
      manifestContentSha256: 'sha256:a8edf42cd879f7d029bdd1e1380b1776740371bb767da43a7c7279d22f4018d6',
      manifestColliders: 484,
      colliders: 484,
      variant: null
    }),
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
    propLayer: true,
    // Gracia prop colliders (roadside: 965 active; the 8 colliders that sit on
    // the measured path stay inactive, so the line is clear).
    propPins: Object.freeze({
      label: 'gracia-roadside',
      profile: 'roadside',
      manifest: '_work/map-props/manifest-gracia.json',
      manifestFileSha256: 'sha256:9b9826a39387d41267473dd4f467b972b8cb9afe954b263088ea2b991143a828',
      collidersFile: 'colliders-gracia.json',
      collidersFileSha256: 'sha256:57da056dfc523cf590c952bd003de780b734a64ee5ee18fa2618e760739381e0',
      manifestContentSha256: 'sha256:b3dedf1e22421dce6cad1ed7770fa54ec1f0dc074ccd9bb7f8ad5d0fd1694249',
      manifestColliders: 973,
      colliders: 965,
      variant: null
    }),
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
  }),
  longbeach: Object.freeze({
    id: 'longbeach',
    label: 'Long Beach',
    level: 'usa_la_longbeachdocks',
    kind: 'map-package',
    // Built by `probes/e1-drive/tools/build_map_longbeach.mjs`. The layout is
    // the committed collision-derived path (`probes/map-laps/data/longbeach-path.json`):
    // the draw-covered path crosses a 10 cm curb at arc 226.8 m.
    geometryUrl: '/_work/e1-drive/longbeach/map.json',
    baseGeometryUrl: '/_work/e1-drive/base.geometry.json',
    carIndexUrl: '/_work/e1-drive/car-bodies.index.json',
    physicsUrl: '/map-data/usa_la_longbeachdocks/Level.levelphysics',
    spawnUrl: null,
    layoutUrl: '/_work/e1-drive/longbeach/layout.json',
    bestKey: 'e1-drive.sprint.best.v3.longbeach',
    courses: Object.freeze(['310']),
    multiplayer: true,
    propLayer: false,
    ghost: false,
    pins: Object.freeze({
      mapFileSha256: 'sha256:3c1a47f5a368c1992a49196b72b69c4790cbbd4a9ad3222f26f93ea292dc0062',
      mapContentHash: 'sha256:a3bd36858ba6a58ac5d607a0a51ced4053294eaf6d94b871f8272dda373312e5',
      layoutFileSha256: 'sha256:3474fd006d35a96a4810f2c6235fbacaee5ace9b18671e0528169983c70889e6',
      layoutContentHash: 'sha256:4449ed75b1344e29a3d5b8c920a412d54a57eb14bfabdc9bca6ab66ce2fc8366',
      renderFileSha256: 'sha256:c79d5ea8653aa8c88fa115d7a048b91b308d85ca6502582f0605a7220086ec3a',
      renderContentHash: 'sha256:c8bfff56018c059efdf31ae749c353435aab25d8359577b307606d378c032199',
      sliceFileSha256: 'sha256:7525436d662d230cd4244dfb7821b1f41ed586ce0bb950b2ae3478199cf084b7',
      sliceContentHash: 'sha256:c800503f986e94bd84fc16295f424a779e965cd9c499affdeb65edcf0d008f39',
      physicsFileSha256: 'sha256:ce22c1cadbcff96074ff4d84741137162d2fe0697a5c354053e181944d6cca0d',
      physicsBytes: 2214990,
      draws: 1039,
      drawTriangles: 511782,
      textures: 164,
      textureBytes: 1239168,
      vertices: 864473,
      indices: 1611882,
      decalDraws: 0,
      diagnosticDraws: 101,
      blockedDraws: 102,
      unsupportedSections: 2,
      instanceDescriptions: 7476,
      collisionTriangles: 25183,
      pathLengthMetres: 785.82323,
      checkpointArcs: Object.freeze([262.055868, 523.76805]),
      sampleCount: 3159,
      renderLabel: 'longbeach-direct-draws',
      courseId: 'longbeach'
    }),
    mpPins: Object.freeze({
      packageHash: 'sha256:a3bd36858ba6a58ac5d607a0a51ced4053294eaf6d94b871f8272dda373312e5',
      layoutHash: 'sha256:4449ed75b1344e29a3d5b8c920a412d54a57eb14bfabdc9bca6ab66ce2fc8366',
      physicsHash: 'sha256:ce22c1cadbcff96074ff4d84741137162d2fe0697a5c354053e181944d6cca0d',
      packageFileSha256: 'sha256:3c1a47f5a368c1992a49196b72b69c4790cbbd4a9ad3222f26f93ea292dc0062',
      layoutFileSha256: 'sha256:3474fd006d35a96a4810f2c6235fbacaee5ace9b18671e0528169983c70889e6',
      physicsFileSha256: 'sha256:ce22c1cadbcff96074ff4d84741137162d2fe0697a5c354053e181944d6cca0d',
      packageBytes: 72494393,
      layoutBytes: 388000,
      physicsBytes: 2214990
    })
  }),

  observatory: Object.freeze({
    id: 'observatory',
    label: 'Hollywood Hills',
    level: 'usa_la_observatory',
    kind: 'map-package',
    geometryUrl: '/_work/e1-drive/observatory/map.json',
    baseGeometryUrl: '/_work/e1-drive/base.geometry.json',
    carIndexUrl: '/_work/e1-drive/car-bodies.index.json',
    physicsUrl: '/map-data/usa_la_observatory/Level.levelphysics',
    spawnUrl: null,
    layoutUrl: '/_work/e1-drive/observatory/layout.json',
    bestKey: 'e1-drive.sprint.best.v3.observatory',
    courses: Object.freeze(['310']),
    multiplayer: true,
    propLayer: false,
    ghost: false,
    pins: Object.freeze({
      mapFileSha256: 'sha256:d0caed5da99ccff2d549c5b14077221b7f38b9fd2ccbe8de3649d28f34ffb4b0',
      mapContentHash: 'sha256:50ddbd3b72a3a638cc55d2da1588c5a9585672d87af3af9459cbe371d47734de',
      layoutFileSha256: 'sha256:b056934fee143038110f3edee9873d5eaf33c95c565a18db4714c9f70902ee63',
      layoutContentHash: 'sha256:30b3867cd9367a50b4209841e9fcfa4f33bed757695b15bc8b1e3b1df6c94b61',
      renderFileSha256: 'sha256:6ba97664c9d9edda3e914a88d7d92546ed00aa966a9ebd0c82c8e26ec405a787',
      renderContentHash: 'sha256:6ba97664c9d9edda3e914a88d7d92546ed00aa966a9ebd0c82c8e26ec405a787',
      sliceFileSha256: 'sha256:15566ff24ae1ce55e70b52361ba43a2e2cc525d80ddc4030eda5546c48a2fabd',
      sliceContentHash: 'sha256:15566ff24ae1ce55e70b52361ba43a2e2cc525d80ddc4030eda5546c48a2fabd',
      physicsFileSha256: 'sha256:070874eedc63eac99f9a586b3581c2b8c9d396a433b7ee0bc4e3e16663c034d6',
      physicsBytes: 4715868,
      draws: 1061,
      drawTriangles: 124430,
      textures: 97,
      textureBytes: 1588288,
      vertices: 178083,
      indices: 435270,
      decalDraws: 89,
      diagnosticDraws: 51,
      blockedDraws: 140,
      unsupportedSections: 30,
      instanceDescriptions: 0,
      collisionTriangles: 111496,
      pathLengthMetres: 536.621709,
      checkpointArcs: Object.freeze([114.838678, 308.628092]),
      sampleCount: 2161,
      renderLabel: 'observatory-direct-draws',
      courseId: 'observatory'
    }),
    mpPins: Object.freeze({
      packageHash: 'sha256:50ddbd3b72a3a638cc55d2da1588c5a9585672d87af3af9459cbe371d47734de',
      layoutHash: 'sha256:30b3867cd9367a50b4209841e9fcfa4f33bed757695b15bc8b1e3b1df6c94b61',
      physicsHash: 'sha256:070874eedc63eac99f9a586b3581c2b8c9d396a433b7ee0bc4e3e16663c034d6',
      packageFileSha256: 'sha256:d0caed5da99ccff2d549c5b14077221b7f38b9fd2ccbe8de3649d28f34ffb4b0',
      layoutFileSha256: 'sha256:75e7c586b4b47488d995b8e800a9c65c071f9d57520f4b7a9ef0666413aa1de8',
      physicsFileSha256: 'sha256:070874eedc63eac99f9a586b3581c2b8c9d396a433b7ee0bc4e3e16663c034d6',
      packageBytes: 24900897,
      layoutBytes: 270521,
      physicsBytes: 4715868
    })
  }),

  downtown: Object.freeze({
    id: 'downtown',
    label: 'LA Downtown',
    level: 'usa_la_downtown',
    kind: 'map-package',
    geometryUrl: '/_work/e1-drive/downtown/map.json',
    baseGeometryUrl: '/_work/e1-drive/base.geometry.json',
    carIndexUrl: '/_work/e1-drive/car-bodies.index.json',
    physicsUrl: '/map-data/usa_la_downtown/Level.levelphysics',
    spawnUrl: null,
    layoutUrl: '/_work/e1-drive/downtown/layout.json',
    bestKey: 'e1-drive.sprint.best.v3.downtown',
    courses: Object.freeze(['310']),
    multiplayer: true,
    propLayer: false,
    ghost: false,
    pins: Object.freeze({
      mapFileSha256: 'sha256:1d2310fffc3547692d3b9337ba6f46ed9dd733994539422552b9586c6f8154a2',
      mapContentHash: 'sha256:772e5e2d1f572c7399832b56c32852b5360847a7d5f93101d07e2c5b4c335666',
      layoutFileSha256: 'sha256:51f57512a3d92b69ba4887ec7c52b0fd713f21b597f7c86c9d5c08ae6aeec1d6',
      layoutContentHash: 'sha256:fd1df25f4ae7cbd8a679c21cbbe34ce62d4ab9f9d90355104e1f4c3b790b69a5',
      renderFileSha256: 'sha256:4efdaaafd41dedbe9a56a6c1f35101787022775967733f96fb34ace775b7c1a4',
      renderContentHash: 'sha256:4efdaaafd41dedbe9a56a6c1f35101787022775967733f96fb34ace775b7c1a4',
      sliceFileSha256: 'sha256:51613cd7395abc2072091079af8a0e2738b400e6edc30d8ee5e4383b44adf17b',
      sliceContentHash: 'sha256:51613cd7395abc2072091079af8a0e2738b400e6edc30d8ee5e4383b44adf17b',
      physicsFileSha256: 'sha256:06f2e5222dbb8cfcc8fe4493f62161fb11d64310a09603502484dee8040c9fd1',
      physicsBytes: 6637886,
      draws: 1668,
      drawTriangles: 195589,
      textures: 736,
      textureBytes: 7529152,
      vertices: 440144,
      indices: 987021,
      decalDraws: 428,
      diagnosticDraws: 216,
      blockedDraws: 644,
      unsupportedSections: 4,
      instanceDescriptions: 15002,
      collisionTriangles: 118351,
      pathLengthMetres: 153.860674,
      checkpointArcs: Object.freeze([32.931883, 84.117373]),
      sampleCount: 620,
      renderLabel: 'downtown-direct-draws',
      courseId: 'downtown'
    }),
    mpPins: Object.freeze({
      packageHash: 'sha256:772e5e2d1f572c7399832b56c32852b5360847a7d5f93101d07e2c5b4c335666',
      layoutHash: 'sha256:fd1df25f4ae7cbd8a679c21cbbe34ce62d4ab9f9d90355104e1f4c3b790b69a5',
      physicsHash: 'sha256:06f2e5222dbb8cfcc8fe4493f62161fb11d64310a09603502484dee8040c9fd1',
      packageFileSha256: 'sha256:1d2310fffc3547692d3b9337ba6f46ed9dd733994539422552b9586c6f8154a2',
      layoutFileSha256: 'sha256:bf1046d400b8de67adbd9326073706c6a84e5ff6680353a6fc76c4772bb31872',
      physicsFileSha256: 'sha256:06f2e5222dbb8cfcc8fe4493f62161fb11d64310a09603502484dee8040c9fd1',
      packageBytes: 58171482,
      layoutBytes: 88659,
      physicsBytes: 6637886
    })
  }),

  mharuna: Object.freeze({
    id: 'mharuna',
    label: 'Mount Haruna',
    level: 'jpn_mharuna',
    kind: 'map-package',
    geometryUrl: '/_work/e1-drive/mharuna/map.json',
    baseGeometryUrl: '/_work/e1-drive/base.geometry.json',
    carIndexUrl: '/_work/e1-drive/car-bodies.index.json',
    physicsUrl: '/map-data/jpn_mharuna/Level.levelphysics',
    spawnUrl: null,
    layoutUrl: '/_work/e1-drive/mharuna/layout.json',
    bestKey: 'e1-drive.sprint.best.v3.mharuna',
    courses: Object.freeze(['310']),
    multiplayer: true,
    propLayer: false,
    ghost: false,
    pins: Object.freeze({
      mapFileSha256: 'sha256:c1260d079891fd18c43c7348476197dc9b239ba4e9114ffe538f35106a5eb0a0',
      mapContentHash: 'sha256:e5ce1c6cbfad9213e6c075a2551cca9ab10346771ec975b5aea7d14a3deb7221',
      layoutFileSha256: 'sha256:7ce8a47ca64742f8fbb1ab2670c4e8214c3e05b327555a9a2246a48dc46cdd6a',
      layoutContentHash: 'sha256:91b6db19d7e42247dc79fac770c6c367f54577fcd9c73597ca915b39d7107f07',
      renderFileSha256: 'sha256:c68e0af739e84cb455a88eb4531024307ec6e7b7583c7bfcbd0afa618e0d15ce',
      renderContentHash: 'sha256:c68e0af739e84cb455a88eb4531024307ec6e7b7583c7bfcbd0afa618e0d15ce',
      sliceFileSha256: 'sha256:25897dcd3ab4e48796c72d981bc44ebfe1852530872d8b3abf27722fdfad3eef',
      sliceContentHash: 'sha256:25897dcd3ab4e48796c72d981bc44ebfe1852530872d8b3abf27722fdfad3eef',
      physicsFileSha256: 'sha256:c47d71aadc45f6c1e568c32054398e65f5341e7e0c69d70f91a85e967da87612',
      physicsBytes: 3542863,
      draws: 1581,
      drawTriangles: 247355,
      textures: 234,
      textureBytes: 1332288,
      vertices: 439562,
      indices: 863349,
      decalDraws: 0,
      diagnosticDraws: 202,
      blockedDraws: 202,
      unsupportedSections: 34,
      instanceDescriptions: 416,
      collisionTriangles: 42038,
      pathLengthMetres: 309.170196,
      checkpointArcs: Object.freeze([67.304498, 171.944569]),
      sampleCount: 1248,
      renderLabel: 'mharuna-direct-draws',
      courseId: 'mharuna'
    }),
    mpPins: Object.freeze({
      packageHash: 'sha256:e5ce1c6cbfad9213e6c075a2551cca9ab10346771ec975b5aea7d14a3deb7221',
      layoutHash: 'sha256:91b6db19d7e42247dc79fac770c6c367f54577fcd9c73597ca915b39d7107f07',
      physicsHash: 'sha256:c47d71aadc45f6c1e568c32054398e65f5341e7e0c69d70f91a85e967da87612',
      packageFileSha256: 'sha256:c1260d079891fd18c43c7348476197dc9b239ba4e9114ffe538f35106a5eb0a0',
      layoutFileSha256: 'sha256:4af1acf9eb454f1eabc47eec45c62873487d11fba21200d446530e794c364e6b',
      physicsFileSha256: 'sha256:c47d71aadc45f6c1e568c32054398e65f5341e7e0c69d70f91a85e967da87612',
      packageBytes: 44422991,
      layoutBytes: 171808,
      physicsBytes: 3542863
    })
  }),

  'highrise': Object.freeze({
    id: 'highrise',
    label: 'Highrise',
    level: 'usa_la_multiplayer_highrise',
    kind: 'map-package',
    geometryUrl: '/_work/e1-drive/highrise/map.json',
    baseGeometryUrl: '/_work/e1-drive/base.geometry.json',
    carIndexUrl: '/_work/e1-drive/car-bodies.index.json',
    physicsUrl: '/map-data/usa_la_multiplayer_highrise/Level.levelphysics',
    spawnUrl: null,
    layoutUrl: '/_work/e1-drive/highrise/layout.json',
    bestKey: 'e1-drive.sprint.best.v3.highrise',
    courses: Object.freeze(['310']),
    multiplayer: true,
    propLayer: false,
    ghost: false,
    pins: Object.freeze({
      mapFileSha256: 'sha256:06a7fcaccdc75a75ad4d4638211c5766d24a4a9ebb794e339948affc8f2be8a7',
      mapContentHash: 'sha256:55af642f7de49dcf506086a995471aed69ba5291ca131bfdba05622664a34185',
      layoutFileSha256: 'sha256:5fadef90714ab31be04f6f1a802829e294b0eb691b6bb15cbc829808ac02111c',
      layoutContentHash: 'sha256:bc0c69187d2c4048d1e8dc65bdfbe4dd822b7cbe49ce28dbb167cdc115746a5a',
      renderFileSha256: 'sha256:37876a70a847c135d0523dd41bf7fcaf16fa0358ea6b43455159f9ee9a522a64',
      renderContentHash: 'sha256:37876a70a847c135d0523dd41bf7fcaf16fa0358ea6b43455159f9ee9a522a64',
      sliceFileSha256: 'sha256:60d38dbecb27163ee192869b1a7ee1c26344c0c29823bed7d7e37a7c336014e0',
      sliceContentHash: 'sha256:60d38dbecb27163ee192869b1a7ee1c26344c0c29823bed7d7e37a7c336014e0',
      physicsFileSha256: 'sha256:de95aca0edf1b89b0168860bcf733def41e1874b721a853de69f5e675f156703',
      physicsBytes: 136451,
      draws: 69,
      drawTriangles: 6630,
      textures: 53,
      textureBytes: 764736,
      vertices: 16956,
      indices: 45561,
      decalDraws: 31,
      diagnosticDraws: 13,
      blockedDraws: 44,
      unsupportedSections: 0,
      instanceDescriptions: 0,
      collisionTriangles: 2522,
      pathLengthMetres: 14.26866,
      checkpointArcs: Object.freeze([6.457107, 8.207107]),
      sampleCount: 59,
      renderLabel: 'highrise-direct-draws',
      courseId: 'highrise'
    }),
    mpPins: Object.freeze({
      packageHash: 'sha256:55af642f7de49dcf506086a995471aed69ba5291ca131bfdba05622664a34185',
      layoutHash: 'sha256:bc0c69187d2c4048d1e8dc65bdfbe4dd822b7cbe49ce28dbb167cdc115746a5a',
      physicsHash: 'sha256:de95aca0edf1b89b0168860bcf733def41e1874b721a853de69f5e675f156703',
      packageFileSha256: 'sha256:06a7fcaccdc75a75ad4d4638211c5766d24a4a9ebb794e339948affc8f2be8a7',
      layoutFileSha256: 'sha256:fe5c4e035fd3f26ed9095e69137154e14b76ded90e9a37253fb9716012d38b48',
      physicsFileSha256: 'sha256:de95aca0edf1b89b0168860bcf733def41e1874b721a853de69f5e675f156703',
      packageBytes: 2806188,
      layoutBytes: 23383,
      physicsBytes: 136451
    })
  }),

  'shutoko': Object.freeze({
    id: 'shutoko',
    label: 'Tokyo Shutoko',
    level: 'jpn_tokyo_shutoko',
    kind: 'map-package',
    geometryUrl: '/_work/e1-drive/shutoko/map.json',
    baseGeometryUrl: '/_work/e1-drive/base.geometry.json',
    carIndexUrl: '/_work/e1-drive/car-bodies.index.json',
    physicsUrl: '/map-data/jpn_tokyo_shutoko/Level.levelphysics',
    spawnUrl: null,
    layoutUrl: '/_work/e1-drive/shutoko/layout.json',
    bestKey: 'e1-drive.sprint.best.v3.shutoko',
    courses: Object.freeze(['310']),
    multiplayer: true,
    propLayer: false,
    ghost: false,
    pins: Object.freeze({
      mapFileSha256: 'sha256:a5903e0951e6e8c99a116ca2187c9ede30d4596a94069c9a0e4d991aa12d654e',
      mapContentHash: 'sha256:56125a6f599f392df59cd537d1b9c666fe34a2406291f23fc2a466db7b32fcf3',
      layoutFileSha256: 'sha256:33356b85572b2347464fc37e833c507cca931913d48bb396d30acf3e01676f4f',
      layoutContentHash: 'sha256:32429da2f0a105ff1aabd3dceea7d6598b44108b3dad0b670ab5b770a6736fe4',
      renderFileSha256: 'sha256:9ad4d0841e72177dcc209b2a65e6974b6d9f3f967b9aae7a344fb54e0a4e5e48',
      renderContentHash: 'sha256:9ad4d0841e72177dcc209b2a65e6974b6d9f3f967b9aae7a344fb54e0a4e5e48',
      sliceFileSha256: 'sha256:863ba82b6ee68de0c8058e29ce32c6e875ea2ad783ca8ed0c90fba6d51a627fb',
      sliceContentHash: 'sha256:863ba82b6ee68de0c8058e29ce32c6e875ea2ad783ca8ed0c90fba6d51a627fb',
      physicsFileSha256: 'sha256:5604766d7d3f2928ff59d9f1edd9aa1e7c128f468c0b76fd6a642131c7947ce4',
      physicsBytes: 3150265,
      draws: 2318,
      drawTriangles: 194069,
      textures: 1086,
      textureBytes: 8748928,
      vertices: 380408,
      indices: 736398,
      decalDraws: 190,
      diagnosticDraws: 201,
      blockedDraws: 391,
      unsupportedSections: 4,
      instanceDescriptions: 6762,
      collisionTriangles: 58330,
      pathLengthMetres: 279.005135,
      checkpointArcs: Object.freeze([62.633926, 152.974197]),
      sampleCount: 1129,
      renderLabel: 'shutoko-direct-draws',
      courseId: 'shutoko'
    }),
    mpPins: Object.freeze({
      packageHash: 'sha256:56125a6f599f392df59cd537d1b9c666fe34a2406291f23fc2a466db7b32fcf3',
      layoutHash: 'sha256:32429da2f0a105ff1aabd3dceea7d6598b44108b3dad0b670ab5b770a6736fe4',
      physicsHash: 'sha256:5604766d7d3f2928ff59d9f1edd9aa1e7c128f468c0b76fd6a642131c7947ce4',
      packageFileSha256: 'sha256:a5903e0951e6e8c99a116ca2187c9ede30d4596a94069c9a0e4d991aa12d654e',
      layoutFileSha256: 'sha256:b020121777e93b764288a68f4c6af52b641f0a52ecbf037c9d3e427735a2f622',
      physicsFileSha256: 'sha256:5604766d7d3f2928ff59d9f1edd9aa1e7c128f468c0b76fd6a642131c7947ce4',
      packageBytes: 51278589,
      layoutBytes: 150908,
      physicsBytes: 3150265
    })
  }),

  'oval': Object.freeze({
    id: 'oval',
    label: 'Barcelona Oval',
    level: 'spa_barcelona_oval',
    kind: 'map-package',
    geometryUrl: '/_work/e1-drive/oval/map.json',
    baseGeometryUrl: '/_work/e1-drive/base.geometry.json',
    carIndexUrl: '/_work/e1-drive/car-bodies.index.json',
    physicsUrl: '/map-data/spa_barcelona_oval/Level.levelphysics',
    spawnUrl: null,
    layoutUrl: '/_work/e1-drive/oval/layout.json',
    bestKey: 'e1-drive.sprint.best.v3.oval',
    courses: Object.freeze(['310']),
    multiplayer: true,
    propLayer: false,
    ghost: false,
    pins: Object.freeze({
      mapFileSha256: 'sha256:77255a9635ef10af24e7224c26d396ea56f3001386f6cf110f732b308233f514',
      mapContentHash: 'sha256:3de3d209b24074d0dfb410a901f02c688cb3471f559836d3db80f0aff5528326',
      layoutFileSha256: 'sha256:86e3389d2e1a773a7893992f7edeae93ee4fa7b954ec5bc17929406aeb38ce37',
      layoutContentHash: 'sha256:051109571da870b75bbaac5648c789a45060c129f6e33f9233b598a7e02060a3',
      renderFileSha256: 'sha256:3d2384c427764ba5f805aa0b784de446fceda64f990b3e7b2f65b30178dbb9ba',
      renderContentHash: 'sha256:3d2384c427764ba5f805aa0b784de446fceda64f990b3e7b2f65b30178dbb9ba',
      sliceFileSha256: 'sha256:8cd1a4e6c5a205cdc7f084a72f745a6257cd9f32840cf8a2b618bb64b1116616',
      sliceContentHash: 'sha256:8cd1a4e6c5a205cdc7f084a72f745a6257cd9f32840cf8a2b618bb64b1116616',
      physicsFileSha256: 'sha256:43a3a044e803e8e864032949db7d32bc5f7f4f93201384a46c59632d7b744f46',
      physicsBytes: 3260059,
      draws: 1032,
      drawTriangles: 186717,
      textures: 218,
      textureBytes: 2753600,
      vertices: 337915,
      indices: 699060,
      decalDraws: 123,
      diagnosticDraws: 87,
      blockedDraws: 210,
      unsupportedSections: 25,
      instanceDescriptions: 756,
      collisionTriangles: 39532,
      pathLengthMetres: 753.021127,
      checkpointArcs: Object.freeze([160.668873, 411.801432]),
      sampleCount: 3018,
      renderLabel: 'oval-direct-draws',
      courseId: 'oval'
    }),
    mpPins: Object.freeze({
      packageHash: 'sha256:3de3d209b24074d0dfb410a901f02c688cb3471f559836d3db80f0aff5528326',
      layoutHash: 'sha256:051109571da870b75bbaac5648c789a45060c129f6e33f9233b598a7e02060a3',
      physicsHash: 'sha256:43a3a044e803e8e864032949db7d32bc5f7f4f93201384a46c59632d7b744f46',
      packageFileSha256: 'sha256:77255a9635ef10af24e7224c26d396ea56f3001386f6cf110f732b308233f514',
      layoutFileSha256: 'sha256:8d65b6b09d910b7c1cc8d3d773481af6fb5566c05a1e83497b202ab08a0f7c45',
      physicsFileSha256: 'sha256:43a3a044e803e8e864032949db7d32bc5f7f4f93201384a46c59632d7b744f46',
      packageBytes: 37355832,
      layoutBytes: 368588,
      physicsBytes: 3260059
    })
  }),

  'amboy-mp': Object.freeze({
    id: 'amboy-mp',
    label: 'Amboy MP',
    level: 'usa_amboy_multiplayer',
    kind: 'map-package',
    geometryUrl: '/_work/e1-drive/amboy-mp/map.json',
    baseGeometryUrl: '/_work/e1-drive/base.geometry.json',
    carIndexUrl: '/_work/e1-drive/car-bodies.index.json',
    physicsUrl: '/map-data/usa_amboy_multiplayer/Level.levelphysics',
    spawnUrl: null,
    layoutUrl: '/_work/e1-drive/amboy-mp/layout.json',
    bestKey: 'e1-drive.sprint.best.v3.amboy-mp',
    courses: Object.freeze(['310']),
    multiplayer: true,
    propLayer: false,
    ghost: false,
    pins: Object.freeze({
      mapFileSha256: 'sha256:f3a606db8d4d50bbd7c7da4053cdf014c2528b5bb694049d79b184cf10be0f0b',
      mapContentHash: 'sha256:636318fccc27649be20f7fb7840f10a1865db551c7ab977bedabde885ded4b18',
      layoutFileSha256: 'sha256:52f49453bae55abb00658a128d48cb24d71b69b7540fee7e4c2230b9fba88ca5',
      layoutContentHash: 'sha256:372a222388f1e5e60a11fdf66d0742f4dadde0daf4597b5f12adbd12b077fef5',
      renderFileSha256: 'sha256:696f5a56c591099f340694548b40155e2c4b4f269a980ee57da34a66312614af',
      renderContentHash: 'sha256:696f5a56c591099f340694548b40155e2c4b4f269a980ee57da34a66312614af',
      sliceFileSha256: 'sha256:2864129e450dba60ab59e2aeed1a5a1a15a40d336ba54ee7783c6a84f462cb0e',
      sliceContentHash: 'sha256:2864129e450dba60ab59e2aeed1a5a1a15a40d336ba54ee7783c6a84f462cb0e',
      physicsFileSha256: 'sha256:44003637440f4b53f2396d2d64779599d0ccee02b5ff2cc430b815935736b25d',
      physicsBytes: 1414477,
      draws: 140,
      drawTriangles: 67554,
      textures: 37,
      textureBytes: 1920064,
      vertices: 133215,
      indices: 242334,
      decalDraws: 0,
      diagnosticDraws: 8,
      blockedDraws: 8,
      unsupportedSections: 6,
      instanceDescriptions: 213,
      collisionTriangles: 22208,
      pathLengthMetres: 122.293808,
      checkpointArcs: Object.freeze([26.551563, 66.991298]),
      sampleCount: 495,
      renderLabel: 'amboy-mp-direct-draws',
      courseId: 'amboy-mp'
    }),
    mpPins: Object.freeze({
      packageHash: 'sha256:636318fccc27649be20f7fb7840f10a1865db551c7ab977bedabde885ded4b18',
      layoutHash: 'sha256:372a222388f1e5e60a11fdf66d0742f4dadde0daf4597b5f12adbd12b077fef5',
      physicsHash: 'sha256:44003637440f4b53f2396d2d64779599d0ccee02b5ff2cc430b815935736b25d',
      packageFileSha256: 'sha256:f3a606db8d4d50bbd7c7da4053cdf014c2528b5bb694049d79b184cf10be0f0b',
      layoutFileSha256: 'sha256:26a95d7bf33406ce2c9f8c476fa31bacbe8b5d1933fd8c7e88a84f3d9f96a294',
      physicsFileSha256: 'sha256:44003637440f4b53f2396d2d64779599d0ccee02b5ff2cc430b815935736b25d',
      packageBytes: 15453416,
      layoutBytes: 74242,
      physicsBytes: 1414477
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










