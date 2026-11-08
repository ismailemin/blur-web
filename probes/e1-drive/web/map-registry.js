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
export const MAP_IDS = Object.freeze(['river', 'amboy', 'gracia', 'longbeach', 'observatory', 'downtown', 'mharuna']);

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
      mapFileSha256: 'sha256:49821fef820989435ec6c6078351bf9d45313a69fef8e454e650e8695bb1a1c4',
      mapContentHash: 'sha256:a6a8c0eb387d1979107e47019aba0d725f8d11c7c4205535056516b6079adf1f',
      layoutFileSha256: 'sha256:75e7c586b4b47488d995b8e800a9c65c071f9d57520f4b7a9ef0666413aa1de8',
      layoutContentHash: 'sha256:3eeaf7a1ca488d4475d52bc3aa6cce4eb01a3acc18d4b96d5710e04690d1973b',
      renderFileSha256: 'sha256:2bb867bfd74b2a8bb8d9f1e2d2b83c7cac28eef5987a75edde5908eb265b9564',
      renderContentHash: 'sha256:2bb867bfd74b2a8bb8d9f1e2d2b83c7cac28eef5987a75edde5908eb265b9564',
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
      packageHash: 'sha256:a6a8c0eb387d1979107e47019aba0d725f8d11c7c4205535056516b6079adf1f',
      layoutHash: 'sha256:3eeaf7a1ca488d4475d52bc3aa6cce4eb01a3acc18d4b96d5710e04690d1973b',
      physicsHash: 'sha256:070874eedc63eac99f9a586b3581c2b8c9d396a433b7ee0bc4e3e16663c034d6',
      packageFileSha256: 'sha256:49821fef820989435ec6c6078351bf9d45313a69fef8e454e650e8695bb1a1c4',
      layoutFileSha256: 'sha256:7896c434d7ac8490cb0f0eaae8f0dca07cd05312c31f7f8371aa414d374dfb7a',
      physicsFileSha256: 'sha256:070874eedc63eac99f9a586b3581c2b8c9d396a433b7ee0bc4e3e16663c034d6',
      packageBytes: 22941483,
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
      mapFileSha256: 'sha256:8ca46733b7d0299035384e4a427222063492a6e49eb836a862696d5651d134d9',
      mapContentHash: 'sha256:ee058a257b423b82fd356240ddfdb200d0de866986ad5fa600700270bb478e59',
      layoutFileSha256: 'sha256:bf1046d400b8de67adbd9326073706c6a84e5ff6680353a6fc76c4772bb31872',
      layoutContentHash: 'sha256:24b398a0b20e9f442f02b916332a04b340ec758c30684eebdbdc5ad6c8ed25b6',
      renderFileSha256: 'sha256:1a25ebec01303c93d51ebaeaea9632f5f0483ac1d39c4acf141601942f92cdd8',
      renderContentHash: 'sha256:1a25ebec01303c93d51ebaeaea9632f5f0483ac1d39c4acf141601942f92cdd8',
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
      packageHash: 'sha256:ee058a257b423b82fd356240ddfdb200d0de866986ad5fa600700270bb478e59',
      layoutHash: 'sha256:24b398a0b20e9f442f02b916332a04b340ec758c30684eebdbdc5ad6c8ed25b6',
      physicsHash: 'sha256:06f2e5222dbb8cfcc8fe4493f62161fb11d64310a09603502484dee8040c9fd1',
      packageFileSha256: 'sha256:8ca46733b7d0299035384e4a427222063492a6e49eb836a862696d5651d134d9',
      layoutFileSha256: 'sha256:2b3d11f4a2334182fa44a539aef4fc2a4405f3cb2a0a62672647fe67f4689da6',
      physicsFileSha256: 'sha256:06f2e5222dbb8cfcc8fe4493f62161fb11d64310a09603502484dee8040c9fd1',
      packageBytes: 53389346,
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
      mapFileSha256: 'sha256:4bd9b7d32459d15b8a6173465bb9f631d17a86be783d4428cf6bbf865b66cb03',
      mapContentHash: 'sha256:2918e6d6e374d4315926f6336a0b5399a81f9b267bb5b395cc2e908f8ea80ec3',
      layoutFileSha256: 'sha256:4af1acf9eb454f1eabc47eec45c62873487d11fba21200d446530e794c364e6b',
      layoutContentHash: 'sha256:21a2a30c94d46ad1905bd379138dcdce60ba550b25542201da58f5024e13b70e',
      renderFileSha256: 'sha256:862f7c991a44db5888e468894fcfa0b364e889b0eb3d1016fed792fafd60765d',
      renderContentHash: 'sha256:862f7c991a44db5888e468894fcfa0b364e889b0eb3d1016fed792fafd60765d',
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
      packageHash: 'sha256:2918e6d6e374d4315926f6336a0b5399a81f9b267bb5b395cc2e908f8ea80ec3',
      layoutHash: 'sha256:21a2a30c94d46ad1905bd379138dcdce60ba550b25542201da58f5024e13b70e',
      physicsHash: 'sha256:c47d71aadc45f6c1e568c32054398e65f5341e7e0c69d70f91a85e967da87612',
      packageFileSha256: 'sha256:4bd9b7d32459d15b8a6173465bb9f631d17a86be783d4428cf6bbf865b66cb03',
      layoutFileSha256: 'sha256:cfadaf1656f2e20640a09b075bd5b16dd17a15c840d3bc4bf058812a97915af3',
      physicsFileSha256: 'sha256:c47d71aadc45f6c1e568c32054398e65f5341e7e0c69d70f91a85e967da87612',
      packageBytes: 39645432,
      layoutBytes: 171808,
      physicsBytes: 3542863
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










