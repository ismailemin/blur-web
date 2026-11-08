// Extract the static half of the render packet for the E1 drive slice.
//
// Input:  _work/render-packet/packet.json — the committed, verified v1.1 spike
//         packet (T-007-render-packet.md): River block27/node253 instances in
//         world space.
//         _work/car-parts/cars/index.json + one manifest/mesh pair per roster
//         car (probes/car-parts/tools/build_all_manifests.py): the real body
//         geometry of every car this slice drives, with 4 wheel groups each.
//         _work/level-candidates/probes/00-usa_la_river-g88-n283/reference.json
//         and .../08-usa_la_river-g56-n289/reference.json: the committed
//         level_inspect direct-draw references used as the real track visual.
//         _work/track-coverage/visual.json: the committed 46-section draw map
//         measured by track-coverage, which supplies the other five sections of
//         the 539.81 m corridor (block58/50/71/64/59) with their pinned
//         positions/indices hashes and source draw ranges.
//         _work/e1-drive/track-textures.json + track-uv.bin + textures/*.rgba:
//         the P45/P47 UV0 and static albedo export (build_track_textures.py).
//         _work/e1-drive/car-textures.json + car-uv-<slug>.bin: the P52 per-car
//         draw/material/texture resolution and the committed scene-report UV0
//         stream (build_car_textures.py), plus the committed P52 RGBA files.
//         Read only; every reference and manifest is pinned by SHA-256 and every
//         draw range is validated against its mesh before it is used.
// Output (chunked, see docs/plan/VEHICLE_CHUNKING.md):
//   _work/e1-drive/level.geometry.json    the level mesh, the real River track
//         visual (committed level_inspect direct draws) with its real P45 UV0
//         stream and static albedo textures, the level props, and the collision
//         surface kept as hidden physics provenance. No car bodies.
//   _work/e1-drive/base.geometry.json     the small map-mode base: materials,
//         light, camera intrinsics, roster and car-texture metadata only.
//   _work/e1-drive/cars/<slug>.geometry.json
//         one roster car body (mesh, real UV0, static albedo textures, draws,
//         parts, wheel groups and nodes) with its chunk header.
//   _work/e1-drive/car-bodies.index.json  per-chunk SHA-256, byte size, draw
//         counts, texture/UV references and the level/base file pins.
//   _work/e1-drive/geometry.json          debug-only combined document (the
//         pre-chunking artifact, kept byte-identical for the committed layout,
//         ghost and MP pins). The page never fetches it.
//         Nothing is re-derived from the game files here; the packet populates
//         the level half and the car-parts manifests the vehicle half, and every
//         input hash is recorded.
//
// Usage: node probes/e1-drive/tools/build_geometry.mjs

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE = path.join(ROOT, '_work/render-packet/packet.json');
const TRACK = path.join(ROOT, '_work/e1-drive/track.json');
const CAR_INDEX = path.join(ROOT, '_work/car-parts/cars/index.json');
const ROSTER = path.join(ROOT, 'probes/e1-drive/cars/roster.json');
const OUT = path.join(ROOT, '_work/e1-drive/geometry.json');
const LEVEL_OUT = path.join(ROOT, '_work/e1-drive/level.geometry.json');
const BASE_OUT = path.join(ROOT, '_work/e1-drive/base.geometry.json');
const INDEX_OUT = path.join(ROOT, '_work/e1-drive/car-bodies.index.json');
const CARS_OUT = path.join(ROOT, '_work/e1-drive/cars');

if (!existsSync(SOURCE)) {
  throw new Error('missing ' + path.relative(ROOT, SOURCE) +
    ' — run `node probes/render-packet/tools/build_packet.mjs` first');
}
if (!existsSync(TRACK)) {
  throw new Error('missing ' + path.relative(ROOT, TRACK) +
    ' — run `python probes/e1-drive/tools/extract_track.py` first');
}
if (!existsSync(CAR_INDEX)) {
  throw new Error('missing ' + path.relative(ROOT, CAR_INDEX) +
    ' — run `python probes/car-parts/tools/build_all_manifests.py` first ' +
    '(the per-car manifests are inputs, not rebuilt here)');
}

const sha256 = (buffer) => 'sha256:' + createHash('sha256').update(buffer).digest('hex');
const hex = (value) => String(value ?? '').replace(/^sha256:/i, '').toLowerCase();

// The committed per-car manifests. A different file is a hard failure: this
// slice must not silently consume a regenerated or hand-edited manifest.
// Update this table together with the analysis/verification documents when a
// manifest is intentionally rebuilt.
const COMMITTED_MANIFESTS = {
  'corvette-zr1-stock': 'sha256:7c51c738f121614ce8ab18262203bb5ce34b399854c09b8fc9a92929fde6c1a8',
  'lotus-exige-cup260-stock': 'sha256:4859e7b859097729b6c356e1615fa1652553957ef901f02eafa5b7a9b839f93e',
  'dodge-challenger-stock': 'sha256:53633d0f827cb72879c83f51a05e639b5210fba9298824e0d685c29662092d5e',
  'ford-focusrs-stock': 'sha256:8c7efb2ced9a89a607f12962c33c0237308866edad32ca47a2700091b3b3fb2f',
  'audi-r8v10-stock': 'sha256:63882c50ca679e79e1f472875094cb59dd87944c0c507960e754c35fcc2a7502',
  'audi-tt-stock': 'sha256:df2427a40aa814325092e1a507ee48acccf208110c3ce43ee671419f02e38a4f',
  'ford-f100-offroad': 'sha256:fb67ba7f2013f396dcf1689e7bbdb7e9c67878eba2346f525838f05101b32d7e',
  'ford-fr100-stock': 'sha256:c05d4d98f67dd712c725317d06cc9ecefa8078cefd286c35f97bbf8f4b88cfba',
  'volkswagen-golfw12650-stock': 'sha256:82089f47abc943675377398054084b2ef63dd6de10935e46b2165d81fe0b3bbd',
  'ford-mustanggtr-stock': 'sha256:edd00ffd9598d97e7d47ea82c9fcc5dc74a95e3a3148e1f76a98bd3a55144058',
  'dodge-viperacr-stock': 'sha256:88176fc585740e638a78d99826c40163e70c16983b0592ace55e9a6da48dadb9',
  'audi-s3-stock': 'sha256:9b0fcdd52bc1113760a37f65162ccb5423ae3e5bbe1a8aacbf6c76ccc96432b2',
  'ford-bronco-offroad': 'sha256:9d05caf3aad8d21d63d1b3dfd05e9b3a4820ea7d993d196cde5d1d388f79b4be',
  'nissan-skyliner34ztune-stock': 'sha256:c119bac367bb3f16a2384cea14c74d55ce174f6f4328bd0920adb4c6ae37f1a7',
  'chevrolet-socalhhr-stock': 'sha256:576a5711991e2f68842e51130a1c6d0548bf359e6f08876d7af8f03e8796c0d5',
  'dodge-challenger-tuner': 'sha256:b23ff848193d61f7dc6e26ac401b38f3692cad71ca9081684c3e30c3a3ff6ff6',
  'nissan-350znismo-stock': 'sha256:53eef9738eaad7cf9b0ef57a76dd8213ac06e79a03a7b4a60b2356fa05e4f045',
  'chevrolet-camaro-stocke3': 'sha256:810c5e003bb7a0fe6709671059292348b3f5282724e0a9d796ee032da9fc5f34',
  'volkswagen-beetle-offroad': 'sha256:2d1fed92ec68a1292798654acfb36a70e6bab2266be85e5e1bd9b7850b93dca8',
  'foose-stallion-stock': 'sha256:b71f4a8249159b2964601063821a79b14c2b285c4986a055f34dd7e1ce30a4d4',
  'chevrolet-camaro-ratdrift': 'sha256:39550354e5f76114a66893a5036a1fca1b20ec1252335445c16eeca264b11b6e',
  'corvette-c3-rat': 'sha256:ab49b97970f43f6d11ff820df5c0f4a4af43f79b59144a025bc818266b5f2691',
  'bmw-m3e92-tuner': 'sha256:405b58af11b87670135ae13f381b42fe164c731f6fd0b705a64b3c36122dc6f9',
  'koenigsegg-ccxr-stock': 'sha256:5513ae8cd72288664a54318b5ff4de7a87ce34e7f6fdf3da878cd530a351ea63',
  'toyota-supratrd-stock': 'sha256:3ec8411f751013be12e63d8500644bb7bc7f459daa540ecccad99f9c6dd2e46b',
  'opel-astraextreme-shannon': 'sha256:7880e58d68736e9e03875015e12f3c24b0ac16eb7ed02abe51bac78d007da66f',
  'bmw-1seriestii-race': 'sha256:97b4b0d8680374de3b2d9d04285f93e8c43b5d3b6c6fedae7b8cef82acf5db6d',
  'ford-focusrs-race': 'sha256:5f3389008e38285f4d42ae26e03ce65c759a4e389b355c13d682bc4f6087794c',
  'renault-meganesportr26-stockgrpc': 'sha256:6cdfeb5bc5509c67a7343042bccf08664668c3d6fe4365bd10858f7018caec66',
  'renault-meganetrophy-stock': 'sha256:9b88325cbd929a5451be2697efff5aa2144db9813650ae5ed345fe5df76b3b25',
  'bmw-135-stock': 'sha256:66b8b17c80f2bcda5c4914e1d70a99515a6cb79256e732a99422f6416bfb4749',
  'landrover-lrx-stock': 'sha256:77c033723160ebd16238ef24f762fca5feb7b59a4b1ec64854a36e71eb6d406e',
  'nissan-350z-drift': 'sha256:757f68dde5d55872ad8d92574185bf7b7eb027247991cd31349f387b36250062',
  'bmw-x548msport-stock': 'sha256:09a6f26f5c97fd866b20c85e06627efc47acc6036c007778ae7fc5b4bce3f282',
  'chevrolet-camaross-stock': 'sha256:8420726885680c683e6ff8004fbdf19f6aab6fa4005a55490f95a3a8434e24e0',
  'nissan-navara-rat': 'sha256:db8ceb56831cd2dc2dce0b97520372efc9d61374819bcf31afb93c7e264a06f2',
  'landrover-defendersvxgrpc': 'sha256:7248406816a806f98d99d1e919346ef665afc4e7d85405cc7544b392e024f3ab',
  'bowler-nemesis-stock': 'sha256:e939156c1f0fec2686612259a43b9b292743676befd01b04ae230703a5dab9e5',
  'vauxhall-monarovxr-drift': 'sha256:bb0a9fdc3007dce72b4851a34dc233ddd0c64867f5921bd3f71860c0bda50fd6',
  'ford-mustang-gt500-stock1stplay': 'sha256:daee62b9841b62b68af9523d2d3b28c21ad85e97a02358faddae34a5fef0172c',
  'foose-69-stock': 'sha256:574a9536f6883e62dedf6bbefc2bba1a3d942790684a8dec3c1abd6908c0a744',
  'corvette-c3-drag': 'sha256:f967ebb18d2ce35bbe530a35a954cec3c23ac10719a7cd4aeb7f8661042c59c6',
  'ford-f100-rat': 'sha256:8791779e24f0a9ce2cd575ea1190663d6a43d341713217580e65ec708134e427',
  'chevrolet-camaross-drag': 'sha256:38b1a2848e7a9d828ef440b67c0d0fa2c569cf3a8387b1fdc1fbce2fe2377867',
  'ford-f150-offroadheh': 'sha256:a0531f301a347fa00168596b875d4f2d8545ea3ddefa571ac101295b89e6c97f',
  'volkswagen-scirocco-24': 'sha256:708457f68d4e85e9cd64aa5a5df0f7abe9673b131bcc6baf04d0633dc3473b0a',
  'nissan-navara-offroad': 'sha256:8178bb345215025ebb5001f0a0f413cb999a844bb00c3c66b848cdf90316b332',
  'volkswagen-beetle-rat': 'sha256:85a8b34ba839830ab47647e98724335ab710586b40045dda8cd55cb1296fddaf',
  'bmw-m3e92-drift': 'sha256:42b174b36a07e92e4b35f6b0a76c8ab8447b40dc8bad7cf3072aa8097a48db85',
  'hummer-h2-offroad': 'sha256:33e03e77117da3af1afb3b1a2f38a4b176c0dd4fd782140f7a5e1dcd7c0670a3',
  'dodge-challenger-race': 'sha256:0698f5e260d5e9d8626ade79b2e0e235b93cb1bbfe06c3b37cb3cce86cf232a1',
  'acschnitzer-acs1coupe-stock': 'sha256:6820e7db0aff40b182cd11f004b4b3e82291b3e24721dc04af77917024717d07',
  'corvette-c3-race': 'sha256:3d200059e3f6782104d4262142122c9cdbd1e99f280f236c46b95c978433aba8',
  'hennessey-vipervenom1000coupe-stock': 'sha256:5856a01079dda8da7d4112389d55778ae78fa7acd29c0315d3f0ea63e47ddb55',
  'opel-astraextreme-stockgrippy': 'sha256:eb7f8dab45821c423c617002c4f61403740759b31ff140512b4d52ab99895c6b',
  'ford-gt-stock': 'sha256:4cc36c7239f04093590f7b54abf306f382cbfa091f343e6e26f6bd1da3cb0e08',
  'dodge-vipergtsr-stock': 'sha256:67ae8648e202bc21685e7c95865d5719088afa81ef62d2f7403c4fd98e0c7eef',
};
const COMMITTED_CAR_INDEX =
  'sha256:1fcee94ad9fe5f2b8073c2374d48605e29713e9f15216bcf8a1973afcea12bae';

// P52's per-car material/texture record plus its UV0 export. Committed output of
// `build_car_textures.py`; a different file is a hard failure, because the car
// textures and bindings may only change when that export is rebuilt and every
// consumer document is updated with it.
const CAR_TEXTURE_MANIFEST = path.join(ROOT, '_work/e1-drive/car-textures.json');
const COMMITTED_CAR_TEXTURES =
  'sha256:e0d540a1d842478ccf86e38377b5d0d22850b27c3e17203f54b202dc713804b7';

// P73b level-instance prop pack: the P73a UV0 export plus the four decoded BC1
// sources, emitted by `build_level_instance_textures.py`. Committed output of
// that tool; a different file is a hard failure, because the level-prop pixels
// and UV bindings may only change when the export is rebuilt and the consumer
// documents are updated with it.
const LEVEL_PROP_TEXTURE_MANIFEST = path.join(ROOT, '_work/e1-drive/level-instance-textures.json');
const COMMITTED_LEVEL_PROP_TEXTURES =
  'sha256:80857371e8aeb3cf2f0d50cd956b8c117825abec39dc2b7e31bc6adbc3bcb788';

const sourceBytes = readFileSync(SOURCE);
const packet = JSON.parse(sourceBytes.toString('utf8'));
if (packet.kind !== 'blur.render-packet' || packet.version !== 1.1) {
  throw new Error('source packet is not a v1.1 blur.render-packet');
}

const levelMesh = packet.meshes.find((mesh) => mesh.id === 'river.block27.instances-all');
if (!levelMesh) throw new Error('source packet is missing the River level mesh');

const levelDraws = packet.draws.filter((draw) => draw.meshId === levelMesh.id);
if (levelDraws.length !== 22) {
  throw new Error('expected 22 level draws, got ' + levelDraws.length);
}

const track = JSON.parse(readFileSync(TRACK, 'utf8'));

// ------------------------------------------------------------ per-car bodies
const indexBytes = readFileSync(CAR_INDEX);
const carIndexSha256 = sha256(indexBytes);
if (carIndexSha256 !== COMMITTED_CAR_INDEX) {
  throw new Error('per-car manifest index is not the committed one: ' + carIndexSha256 +
    ' (expected ' + COMMITTED_CAR_INDEX + ')');
}
const carIndex = JSON.parse(indexBytes.toString('utf8'));
if (carIndex.kind !== 'car-parts.car-model-index' || carIndex.version !== 1) {
  throw new Error('car model index kind/version is wrong');
}
const rosterBytes = readFileSync(ROSTER);
const roster = JSON.parse(rosterBytes.toString('utf8'));
const rosterSlugs = roster.cars.map((car) => car.slug);
if (rosterSlugs.join(',') !== carIndex.cars.map((car) => car.slug).join(',')) {
  throw new Error('car model index does not cover the e1-drive roster in order');
}

// ------------------------------------------------- P52 per-car textures + UV0
//
// `build_car_textures.py` exports, per roster car, the committed P52 material
// resolution (draw → texture id/name/hash), the committed scene-report UV0
// stream of the mesh, and the RGBA path/hash of every referenced image. The
// manifest is pinned, every RGBA file is re-hashed before it is embedded, and
// every draw range is required to equal the part manifest's.
if (!existsSync(CAR_TEXTURE_MANIFEST)) {
  throw new Error('missing ' + path.relative(ROOT, CAR_TEXTURE_MANIFEST) +
    ' — run `python probes/e1-drive/tools/build_car_textures.py` first');
}
const carTextureBytes = readFileSync(CAR_TEXTURE_MANIFEST);
const carTextureSha = sha256(carTextureBytes);
if (carTextureSha !== COMMITTED_CAR_TEXTURES) {
  throw new Error('car texture manifest is not the committed one: ' + carTextureSha +
    ' (expected ' + COMMITTED_CAR_TEXTURES + ')');
}
const carTextureDoc = JSON.parse(carTextureBytes.toString('utf8'));
if (carTextureDoc.kind !== 'e1-drive.car-textures' || carTextureDoc.version !== 1) {
  throw new Error('car texture manifest kind/version is not e1-drive.car-textures v1');
}
if (carTextureDoc.pins?.p52RosterIndex !==
    'sha256:9e63f81794c2d6dd682cf2c6d481ad8d39e4b88566c8591c911c2d3aa6bf4ea3' ||
    carTextureDoc.pins?.carPartsIndex !== COMMITTED_CAR_INDEX) {
  throw new Error('car texture manifest does not carry the committed P52 roster and car-parts indexes');
}
if (carTextureDoc.cars.length !== roster.cars.length) {
  throw new Error('car texture manifest covers ' + carTextureDoc.cars.length + ' cars, the roster has ' +
    roster.cars.length);
}
const carTextureBySlug = new Map(carTextureDoc.cars.map((record) => [record.slug, record]));
for (let index = 0; index < roster.cars.length; index++) {
  if (carTextureDoc.cars[index].slug !== roster.cars[index].slug) {
    throw new Error('car texture manifest car ' + index + ' is ' + carTextureDoc.cars[index].slug +
      ', the roster expects ' + roster.cars[index].slug);
  }
}

function loadCarTexturePack(slug, carTexture) {
  const uvPath = path.join(ROOT, carTexture.uvStream.path);
  const uvBytes = readFileSync(uvPath);
  if (uvBytes.length !== carTexture.uvStream.bytes || sha256(uvBytes) !== carTexture.uvStream.sha256) {
    throw new Error(slug + ': car UV stream is not the one the manifest pinned');
  }
  if (uvBytes.length !== carTexture.uvStream.vertexCount * 8) {
    throw new Error(slug + ': car UV stream length does not match its vertex count');
  }
  const values = new Float32Array(carTexture.uvStream.values);
  for (let index = 0; index < values.length; index++) {
    values[index] = uvBytes.readFloatLE(index * 4);
    if (!Number.isFinite(values[index])) throw new Error(slug + ': car UV stream has a non-finite component');
  }
  const textures = carTexture.textures.map((texture) => {
    const file = path.join(ROOT, texture.rgbaPath);
    const bytes = readFileSync(file);
    if (sha256(bytes) !== texture.rgbaSha256) {
      throw new Error(slug + ': ' + texture.id + ' RGBA file is not the one the manifest pinned');
    }
    if (bytes.length !== texture.rgbaBytes || bytes.length !== texture.width * texture.height * 4) {
      throw new Error(slug + ': ' + texture.id + ' RGBA length does not match its declared size');
    }
    return {
      id: texture.id,
      source: texture.p52Id,
      kind: texture.kind,
      block: texture.block,
      index: texture.index,
      sharedIndex: texture.sharedIndex,
      name: texture.name,
      textureHash: texture.textureHash,
      width: texture.width,
      height: texture.height,
      levels: texture.levels,
      formatName: texture.formatName,
      sourceLod: texture.sourceLod,
      rgbaPath: texture.rgbaPath,
      rgbaBytes: texture.rgbaBytes,
      rgbaSha256: texture.rgbaSha256,
      rgbaFnv1a64: texture.rgbaFnv1a64,
      drawCount: texture.drawCount,
      lightDrawCount: texture.lightDrawCount,
      referenceDrawCount: texture.referenceDrawCount,
      rgbaBase64: bytes.toString('base64')
    };
  });
  const ids = new Set(textures.map((texture) => texture.id));
  if (ids.size !== textures.length) throw new Error(slug + ': car texture ids are not unique');
  return {
    uv: {
      storage: 'base64-float32le',
      components: 2,
      vertexCount: carTexture.uvStream.vertexCount,
      values: values.length,
      bytes: uvBytes.length,
      sha256: carTexture.uvStream.sha256,
      bounds: carTexture.uvStream.bounds,
      data: uvBytes.toString('base64'),
      source: {
        manifest: path.relative(ROOT, CAR_TEXTURE_MANIFEST).split(path.sep).join('/'),
        manifestSha256: carTextureSha,
        stream: carTexture.uvStream.path,
        provenance: carTexture.sceneReport.uv0Source + ' (' + carTexture.sceneReport.path + ', ' +
          carTexture.sceneReport.sha256 + '); its positions are numerically the part manifest mesh, and the ' +
          'UV array is exported byte-exactly including the reader\'s signed zeros',
      }
    },
    uvValues: values,
    textures,
    textureById: new Map(textures.map((texture) => [texture.id, texture])),
    draws: carTexture.draws,
    coverage: carTexture.coverage,
    sampler: carTextureDoc.sampler,
    record: carTexture
  };
}

// The documented fallback: a roster car with no unambiguous model keeps the
// committed Corvette C3 body, labelled with the mapping reason. It is never a
// silent substitute - `fallback:true` travels into the packet diagnostics and the
// verifier fails if any car falls back.
const C3_MANIFEST = path.join(ROOT, '_work/car-parts/manifest.json');
const COMMITTED_C3_MANIFEST =
  'sha256:5df83a6b0fac6f24df642bcb742cfe798bd5ff5d154f097674d165d70ede5dbf';

/** Local AABB of one index range: derived from the mesh, never guessed. */
function localBoundsOf(mesh, indexOffset, indexCount) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let offset = indexOffset; offset < indexOffset + indexCount; offset++) {
    const vertex = mesh.indices[offset];
    for (let axis = 0; axis < 3; axis++) {
      const value = mesh.positions[vertex * 3 + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return { min, max };
}

const meshEntry = (mesh) => ({
  id: mesh.id,
  storage: mesh.storage,
  vertexCount: mesh.vertexCount,
  indexCount: mesh.indexCount,
  positions: mesh.positions,
  indices: mesh.indices,
  uv: mesh.uv ?? null,
  positionsSha256: mesh.positionsSha256,
  indicesSha256: mesh.indicesSha256,
  coordinateSpace: mesh.coordinateSpace,
  source: mesh.source
});

const LEVEL_DIAGNOSTIC_COLOUR = [0.8, 0.8, 0.8];
const levelDrawEntry = (draw, propBinding) => {
  const { binding, texture } = propBinding;
  const blocked = !binding.bindable;
  return {
    id: draw.id,
    meshId: draw.meshId,
    vertexOffset: draw.vertexOffset,
    vertexCount: draw.vertexCount,
    indexOffset: draw.indexOffset,
    indexCount: draw.indexCount,
    materialId: draw.materialId,
    materialReason: texture
      ? 'P73a resolved the source UV0 and static g_tAlbedo image ' + texture.id + ' (' +
        texture.name + ', ' + texture.width + 'x' + texture.height + '); it is sampled with the ' +
        'real instance UV0 stream. Material colour, blend, alpha, shader and sampler state remain unapplied'
      : 'P73a resolved the source UV0 and the g_tAlbedo identity ' + binding.albedoTexture +
        ', but the source is DXT5/BC3 and no alpha rule is declared (' + binding.blockedReason +
        '); the draw keeps the labelled neutral diagnostic albedo and is not bound',
    textureId: texture ? texture.id : null,
    textureBinding: {
      status: binding.status,
      reason: blocked
        ? 'cab01alphas_diff is DXT5/BC3; no alpha-test or blend rule is declared, so the draw is not bound'
        : 'P73a static g_tAlbedo identity resolved to a DXT1/BC1 image and the real UV0 was exported',
      source: binding.resourceBlock + ':' + binding.resourceIndex,
      name: binding.albedoTexture,
      uvProvenance: 'level-instance-uv0 (P73a export, parallel to level_inspect --instances-all positions)',
      uvHash: binding.uvHash,
      uvRange: binding.uvRange,
    },
    diagnosticColour: LEVEL_DIAGNOSTIC_COLOUR.slice(),
    diagnosticColourReason: blocked
      ? 'blocked-bc3-alpha: no alpha rule, texture not bound; neutral diagnostic albedo, not a material'
      : 'not used while the static albedo texture is bound (the consumer uses a white tint and the sampled texel)',
    layer: draw.layer,
    bounds: draw.bounds,
    worldKind: draw.worldKind,
    source: {
      ...draw.source,
      propTextureProvenance: {
        drawId: binding.drawId,
        section: binding.section,
        instanceIndex: binding.instanceIndex,
        basePrimitiveIndex: binding.basePrimitiveIndex,
        material: binding.material,
        materialRow: binding.materialRow,
        resourceBlock: binding.resourceBlock,
        resourceIndex: binding.resourceIndex,
        textureFormat: binding.textureFormat,
        status: binding.status,
        blockedReason: binding.blockedReason,
      }
    }
  };
};

// Diagnostic colours. These are debug colours, not materials: the packet keeps
// materialsApplied:false and every draw says so. Tyre colours identify the
// corner, rim/disc/caliper use the same scheme as the standalone car-parts
// preview, body classes use a stable per-part hue.
const WHEEL_COLOURS = {
  tyre: {
    frontleft: [0.24, 0.90, 0.44],
    frontright: [0.88, 0.34, 0.88],
    backleft: [0.20, 0.60, 0.96],
    backright: [0.96, 0.50, 0.20]
  },
  rim: [0.80, 0.82, 0.88],
  brakeDisc: [0.86, 0.22, 0.22],
  brakeCaliper: [1.0, 0.80, 0.20]
};
const KIND_BASE = {
  body: [0.34, 0.43, 0.55],
  interior: [0.60, 0.36, 0.22],
  glass: [0.24, 0.70, 0.82],
  light: [0.95, 0.82, 0.26],
  wheel: [0.45, 0.45, 0.45],
  unclassified: [0.90, 0.24, 0.24]
};
function stableHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}
function diagnosticColourFor(partKind, id, wheelPart, corner) {
  if (wheelPart) {
    if (wheelPart === 'tyre' && WHEEL_COLOURS.tyre[corner]) return WHEEL_COLOURS.tyre[corner].slice();
    if (WHEEL_COLOURS[wheelPart]) return WHEEL_COLOURS[wheelPart].slice();
  }
  const base = KIND_BASE[partKind] ?? KIND_BASE.unclassified;
  const hash = stableHash(String(id ?? partKind ?? 'unclassified'));
  const shift = ((hash >>> 8) % 9) / 100 - 0.04; // deterministic +-0.04 band
  return base.map((value) => Math.max(0, Math.min(1, value + shift)));
}

const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a 64 over raw bytes, as `build_car_textures.py` computes the UV0 hash. */
function fnv1a64Hex(buffer) {
  let value = FNV_OFFSET_64;
  for (const byte of buffer) {
    value ^= BigInt(byte);
    value = (value * FNV_PRIME_64) & MASK_64;
  }
  return value.toString(16).padStart(16, '0');
}

/**
 * Per-draw UV0 value hash: FNV-1a 64 over the little-endian float32 bits of every
 * UV pair the draw's index range references, in index order. Identical to the
 * exporter's hash, so the binding can only belong to the UVs that produced it.
 */
function drawUvHash(uvValues, indices, firstIndex, indexCount) {
  const buffer = Buffer.alloc(indexCount * 8);
  let offset = 0;
  for (let offsetIndex = firstIndex; offsetIndex < firstIndex + indexCount; offsetIndex++) {
    const vertex = indices[offsetIndex];
    buffer.writeFloatLE(uvValues[vertex * 2], offset);
    buffer.writeFloatLE(uvValues[vertex * 2 + 1], offset + 4);
    offset += 8;
  }
  return fnv1a64Hex(buffer);
}

function buildBody(entry, options = {}) {
  const fallback = options.fallback === true;
  const carTexturePack = options.carTextures ?? null;
  const manifestPath = fallback ? C3_MANIFEST : path.join(ROOT, entry.manifest);
  const manifestBytes = readFileSync(manifestPath);
  const manifestSha = sha256(manifestBytes);
  const expectedManifest = fallback ? COMMITTED_C3_MANIFEST : COMMITTED_MANIFESTS[entry.slug];
  if (manifestSha !== expectedManifest || (!fallback && manifestSha !== entry.manifestSha256)) {
    throw new Error('manifest for ' + entry.slug + ' is not the committed one: ' + manifestSha +
      ' (expected ' + expectedManifest + ')');
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.kind !== 'blur.car-part-manifest' || manifest.version !== 1) {
    throw new Error(entry.slug + ': manifest kind/version is not blur.car-part-manifest v1');
  }
  if (!fallback) {
    if (manifest.source.car?.slug !== entry.slug) {
      throw new Error(entry.slug + ': manifest does not name its car slug');
    }
    if (hex(manifest.source.modelSha256) !== hex(entry.modelSha256)) {
      throw new Error(entry.slug + ': manifest model hash differs from the mapping index');
    }
  }

  const meshPath = path.join(path.dirname(manifestPath), manifest.mesh.path);
  const meshBytes = readFileSync(meshPath);
  const meshSha = sha256(meshBytes);
  if (!fallback && meshSha !== entry.meshSha256) {
    throw new Error(entry.slug + ': mesh is not the one recorded in the mapping index: ' + meshSha);
  }
  const mesh = JSON.parse(meshBytes.toString('utf8'));
  if (mesh.kind !== 'blur.car-part-mesh' || mesh.version !== 1) {
    throw new Error(entry.slug + ': mesh kind/version is not blur.car-part-mesh v1');
  }
  if (mesh.vertexCount !== manifest.mesh.vertexCount || mesh.indexCount !== manifest.mesh.indexCount) {
    throw new Error(entry.slug + ': mesh counts differ from the manifest');
  }
  if (carTexturePack) {
    if (carTexturePack.uv.vertexCount !== mesh.vertexCount) {
      throw new Error(entry.slug + ': car UV stream has ' + carTexturePack.uv.vertexCount +
        ' vertices, the mesh has ' + mesh.vertexCount);
    }
    if (carTexturePack.draws.length !== manifest.draws.length) {
      throw new Error(entry.slug + ': P52 manifest has ' + carTexturePack.draws.length + ' draws, the part manifest has ' +
        manifest.draws.length);
    }
  }
  const positionBuffer = Buffer.alloc(mesh.positions.length * 4);
  mesh.positions.forEach((value, index) => positionBuffer.writeFloatLE(value, index * 4));
  const indexBuffer = Buffer.alloc(mesh.indices.length * 4);
  mesh.indices.forEach((value, index) => indexBuffer.writeUInt32LE(value, index * 4));
  const positionValueSha256 = sha256(positionBuffer);
  const indexValueSha256 = sha256(indexBuffer);
  if (hex(manifest.mesh.positionsFloat32LESha256) !== hex(positionValueSha256) ||
      hex(manifest.mesh.indicesUint32LESha256) !== hex(indexValueSha256)) {
    throw new Error(entry.slug + ': manifest mesh hashes do not match the mesh values');
  }
  if (!fallback && (mesh.vertexCount !== entry.vertexCount || mesh.indexCount !== entry.indexCount)) {
    throw new Error(entry.slug + ': mesh counts differ from the mapping index');
  }

  const meshId = 'car.' + entry.slug + '.body';
  const wheelGroups = manifest.wheelGroups.map((group) => {
    const groupDraws = group.previewDraws ?? group.provenDraws;
    const spinDraws = [];
    const staticDraws = [];
    for (const drawIndex of groupDraws) {
      const draw = manifest.draws[drawIndex];
      const wheelPart = draw?.evidence?.wheelPart ?? null;
      if (!wheelPart) throw new Error('wheel group ' + group.id + ' draw ' + drawIndex + ' has no wheel member');
      if (group.spin.spinMembers.includes(wheelPart)) spinDraws.push(draw.index);
      else if (group.spin.staticMembers.includes(wheelPart)) staticDraws.push(draw.index);
      else throw new Error('wheel group ' + group.id + ' draw ' + drawIndex + ' names unknown member ' + wheelPart);
    }
    return {
      id: group.id,
      corner: group.corner,
      name: group.name,
      translation: group.worldTransform.translation,
      matrixColumnMajor: group.worldTransform.matrixColumnMajor,
      localBounds: group.localBounds,
      memberLocalBounds: group.memberLocalBounds,
      spinAxis: group.spin.axis,
      axisSpace: group.spin.axisSpace,
      spinMembers: group.spin.spinMembers,
      staticMembers: group.spin.staticMembers,
      axisEvidence: group.spin.axisEvidence,
      spinDraws,
      staticDraws,
      provenDraws: group.provenDraws,
      previewDraws: group.previewDraws,
      ambiguousDraws: group.ambiguousDraws,
      spinEvidence: group.spin.evidence,
      spinSource: group.spin.source
    };
  });
  if (wheelGroups.length !== 4) {
    throw new Error(entry.slug + ': manifest has ' + wheelGroups.length + ' wheel groups, expected 4');
  }
  const wheelByCorner = new Map(wheelGroups.map((group) => [group.corner, group]));

  const draws = manifest.draws.map((manifestDraw) => {
    const key = manifestDraw.firstIndex + ':' + manifestDraw.indexCount;
    if (!Number.isInteger(manifestDraw.firstIndex) || !Number.isInteger(manifestDraw.indexCount) ||
        manifestDraw.indexCount <= 0 || manifestDraw.indexCount % 3 !== 0 ||
        manifestDraw.firstIndex + manifestDraw.indexCount > mesh.indexCount) {
      throw new Error(entry.slug + ': draw ' + manifestDraw.index + ' range ' + key + ' is invalid');
    }
    const localBounds = localBoundsOf(mesh, manifestDraw.firstIndex, manifestDraw.indexCount);
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(localBounds.min[axis] - manifestDraw.bounds.min[axis]) > 1e-6 ||
          Math.abs(localBounds.max[axis] - manifestDraw.bounds.max[axis]) > 1e-6) {
        throw new Error(entry.slug + ': draw ' + manifestDraw.index +
          ' bounds differ between manifest and mesh on axis ' + axis);
      }
    }
    const renderPartId = typeof manifestDraw.renderPartId === 'string' ? manifestDraw.renderPartId : null;
    const corner = renderPartId?.startsWith('wheel.') ? renderPartId.slice('wheel.'.length) : null;
    const group = corner ? wheelByCorner.get(corner) : null;
    if (corner && !group) throw new Error(entry.slug + ': draw ' + manifestDraw.index +
      ' names unknown wheel corner ' + corner);
    const wheelPart = manifestDraw.evidence?.wheelPart ?? null;
    if (group && !wheelPart) throw new Error(entry.slug + ': wheel draw ' + manifestDraw.index + ' has no member');
    const spins = Boolean(group && group.spinMembers.includes(wheelPart));
    const nodeId = group ? 'e1.car.wheel.' + group.corner + '.' + (spins ? 'spin' : 'static') : 'e1.car.body';
    const vertexOffset = manifestDraw.minIndex;
    const vertexCount = manifestDraw.maxIndex - manifestDraw.minIndex + 1;

    // P52 material resolution for this exact draw. Draw order is proven equal by
    // comparing the index range and part identity of every draw, and the per-draw
    // UV0 value hash is recomputed from the mesh stream, so a texture can only be
    // bound to the draw whose UVs produced it.
    const materialDraw = carTexturePack ? carTexturePack.draws[manifestDraw.index] : null;
    if (carTexturePack) {
      if (!materialDraw) throw new Error(entry.slug + ': draw ' + manifestDraw.index +
        ' is missing from the P52 car texture manifest');
      if (materialDraw.firstIndex !== manifestDraw.firstIndex ||
          materialDraw.indexCount !== manifestDraw.indexCount) {
        throw new Error(entry.slug + ': draw ' + manifestDraw.index +
          ' index range differs between the P52 manifest and the part manifest');
      }
      if ((materialDraw.partId ?? null) !== (manifestDraw.partId ?? null) ||
          (materialDraw.renderPartId ?? null) !== renderPartId) {
        throw new Error(entry.slug + ': draw ' + manifestDraw.index +
          ' part identity differs between the P52 manifest and the part manifest');
      }
      const recomputed = drawUvHash(carTexturePack.uvValues, mesh.indices,
        manifestDraw.firstIndex, manifestDraw.indexCount);
      if ('0x' + recomputed !== materialDraw.uvHash) {
        throw new Error(entry.slug + ': draw ' + manifestDraw.index + ' UV0 hash 0x' + recomputed +
          ' does not match the exported ' + materialDraw.uvHash);
      }
    }
    const texture = materialDraw?.textureId ? carTexturePack.textureById.get(materialDraw.textureId) : null;
    if (materialDraw?.textureId && !texture) {
      throw new Error(entry.slug + ': draw ' + manifestDraw.index + ' names unknown car texture ' +
        materialDraw.textureId);
    }
    return {
      id: entry.slug + '.draw.' + manifestDraw.index,
      meshId,
      vertexOffset,
      vertexCount,
      uniqueVertexCount: manifestDraw.uniqueVertexCount,
      indexOffset: manifestDraw.firstIndex,
      indexCount: manifestDraw.indexCount,
      materialId: null,
      materialReason: texture
        ? 'P52 resolved this draw to the static albedo image ' + texture.id + ' (' + texture.name + ', ' +
          texture.width + 'x' + texture.height + '); it is sampled with the mesh UV0 stream. Material colour, ' +
          'blend state, mips and sRGB are not applied (materialsApplied:false)'
        : 'no image is bound for this draw: ' +
          (materialDraw?.reason ?? 'the P52 material record does not cover this draw') +
          '; it is rendered with a diagnostic per-part colour',
      textureId: texture ? texture.id : null,
      uvFlipU: materialDraw?.uvFlipU === true,
      uvFlipV: materialDraw?.uvFlipV === true,
      textureBinding: {
        status: materialDraw?.bindingStatus ?? 'noMaterialRecord',
        reason: materialDraw?.reason ?? null,
        source: materialDraw?.textureSource ?? null,
        name: materialDraw?.textureName ?? null,
        drawClass: materialDraw?.drawClass ?? null,
        p52Status: materialDraw?.p52Status ?? null,
        uvProvenance: 'car-mesh-uv0 (committed scene-report stream)',
        uvHash: materialDraw?.uvHash ?? null,
        uvRange: materialDraw?.uvRange ?? null,
        uvConvention: texture ? 'sampled as (1 - u, v)' : null,
      },
      layer: 'opaque',
      bounds: manifestDraw.bounds,
      worldKind: 'packet-transform',
      source: {
        tool: 'probes/car-parts/tools/build_manifest.py',
        drawIndex: manifestDraw.index,
        indexRange: manifestDraw.indexRange,
        partId: manifestDraw.partId,
        match: manifestDraw.match ?? null,
        unclassifiedReason: manifestDraw.unclassifiedReason ?? null,
        material: {
          tool: 'probes/e1-drive/tools/build_car_textures.py (P52 resolution)',
          manifest: path.relative(ROOT, CAR_TEXTURE_MANIFEST).split(path.sep).join('/'),
          manifestSha256: carTextureSha,
          p52Status: materialDraw?.p52Status ?? null,
          materialId: materialDraw?.material?.id ?? null
        }
      },
      localBounds,
      partId: manifestDraw.partId,
      renderPartId,
      partKind: manifestDraw.partKind,
      partName: manifestDraw.partName,
      wheelPart,
      spins,
      nodeId,
      diagnosticColour: diagnosticColourFor(manifestDraw.partKind, renderPartId ?? manifestDraw.partId,
        wheelPart, group?.corner),
      colourReason: texture
        ? 'the diagnostic colour is carried for debugging but is not used: this draw samples its bound ' +
          'texture, and the colour is not a game material (materialsApplied:false)'
        : 'diagnostic per-part colour for visual debugging; not a game material (materialsApplied:false)'
    };
  });
  if (draws.length !== manifest.diagnostics.drawCount) {
    throw new Error(entry.slug + ': draw count differs from the manifest diagnostics');
  }

  const carNodes = [];
  const bodyDrawIds = draws.filter((draw) => draw.nodeId === 'e1.car.body').map((draw) => draw.id);
  if (bodyDrawIds.length) {
    carNodes.push({
      id: 'e1.car.body',
      meshId,
      drawIds: bodyDrawIds,
      reason: 'the rigid body of ' + entry.name + ': every non-wheel part (body panels, glass, lights, ' +
        'interior) shares the engine chassis transform'
    });
  }
  for (const group of wheelGroups) {
    const spinIds = draws.filter((draw) => draw.nodeId === 'e1.car.wheel.' + group.corner + '.spin')
      .map((draw) => draw.id);
    const staticIds = draws.filter((draw) => draw.nodeId === 'e1.car.wheel.' + group.corner + '.static')
      .map((draw) => draw.id);
    if (spinIds.length) {
      carNodes.push({
        id: 'e1.car.wheel.' + group.corner + '.spin',
        meshId,
        drawIds: spinIds,
        reason: 'wheel group ' + group.name + ' (tyre/rim/brake disc): shares the wheel rest-pose ' +
          'translation and spins about element-local +X by the physics wheel angular velocity'
      });
    }
    if (staticIds.length) {
      carNodes.push({
        id: 'e1.car.wheel.' + group.corner + '.static',
        meshId,
        drawIds: staticIds,
        reason: 'wheel group ' + group.name + ' brake caliper: same wheel rest-pose translation, ' +
          'deliberately not spun (VehicleActor.cpp:5198, "Brake calipers mustn\'t rotate")'
      });
    }
  }
  const owned = new Set(carNodes.flatMap((node) => node.drawIds));
  if (owned.size !== draws.length) {
    throw new Error(entry.slug + ': nodes cover ' + owned.size + ' of ' + draws.length + ' car draws');
  }

  const carParts = manifest.parts.map((part) => ({
    id: part.id,
    partKind: part.partKind,
    name: part.name,
    draws: part.draws,
    provenDraws: part.provenDraws,
    ambiguousDraws: part.ambiguousDraws,
    spin: part.spin
      ? { axis: part.spin.axis, axisSpace: part.spin.axisSpace, spinMembers: part.spin.spinMembers,
          staticMembers: part.spin.staticMembers }
      : null
  }));

  return {
    slug: entry.slug,
    name: entry.name,
    meshId,
    mesh: {
      id: meshId,
      storage: 'inline-json',
      vertexCount: mesh.vertexCount,
      indexCount: mesh.indexCount,
      positions: mesh.positions,
      indices: mesh.indices,
      uv: carTexturePack ? carTexturePack.uv : null,
      positionsSha256: positionValueSha256,
      indicesSha256: indexValueSha256,
      coordinateSpace: mesh.coordinateSpace,
      source: {
        tool: 'probes/car-parts/tools/build_manifest.py',
        model: manifest.source.model,
        modelPakPath: manifest.source.modelPakPath,
        modelSha256: manifest.source.modelSha256,
        manifest: path.relative(ROOT, manifestPath).split(path.sep).join('/'),
        manifestSha256: manifestSha
      }
    },
    textures: carTexturePack ? carTexturePack.textures : [],
    texturePack: carTexturePack
      ? {
          manifest: path.relative(ROOT, CAR_TEXTURE_MANIFEST).split(path.sep).join('/'),
          manifestSha256: carTextureSha,
          p52Manifest: carTexturePack.record.materials.path,
          p52ManifestSha256: carTexturePack.record.materials.sha256,
          sceneReport: carTexturePack.record.sceneReport.path,
          sceneReportSha256: carTexturePack.record.sceneReport.sha256,
          sampler: carTexturePack.sampler,
          uvConvention: carTextureDoc.uvConvention,
          scopeLabels: carTextureDoc.scopeLabels,
          coverage: carTexturePack.coverage,
          materialScope:
            'static g_MeshTexture pixels only: ' + carTexturePack.coverage.staticAlbedoDraws + ' of ' +
            carTexturePack.coverage.drawCount + ' draws sample a decoded static image with the ' +
            'committed UV0 stream sampled as (1-u, v) because the model U axis and the image reading ' +
            'direction are opposite; V stays raw. The ' +
            (carTexturePack.coverage.drawCount - carTexturePack.coverage.staticAlbedoDraws) +
            ' runtime-only draws keep the committed P52 ' +
            'reason and the diagnostic albedo. Material colour, blend state, shader stages, mip chain and ' +
            'sRGB interpretation are not applied',
        }
      : null,
    manifest: {
      path: path.relative(ROOT, manifestPath).split(path.sep).join('/'),
      bytes: manifestBytes.length,
      sha256: manifestSha,
      kind: manifest.kind,
      version: manifest.version,
      parts: manifest.parts.length,
      draws: manifest.draws.length,
      wheelGroups: manifest.wheelGroups.length,
      namedParts: manifest.diagnostics.namedPartCount,
      provenDraws: manifest.diagnostics.provenDrawCount,
      unclassifiedDraws: manifest.diagnostics.unclassifiedDrawCount,
      wheelDraws: manifest.diagnostics.wheelDrawCount,
      provenWheelDraws: manifest.diagnostics.provenWheelDrawCount,
      ambiguousWheelDraws: manifest.diagnostics.ambiguousWheelDrawCount,
      tyreProofTier: manifest.tyreProofTier,
      sourceModel: manifest.source.model,
      sourceModelPakPath: fallback
        ? '\\models\\vehicles\\corvette_c3_race.model'
        : manifest.source.modelPakPath,
      sourceModelSha256: fallback
        ? '77840511e5ca416ff9e7cbdc9ee9fc960fce0205f83c9be77e0803607c32cb9d'
        : manifest.source.modelSha256,
      mapping: fallback
        ? 'FALLBACK: no unambiguous model mapped for this roster car (' + options.reason + '); ' +
          'the committed Corvette C3 body is drawn and labelled'
        : manifest.source.car.mapping,
      fallback,
      fallbackReason: fallback ? options.reason : null,
      sourceSceneReaderOutputSha256: manifest.source.sceneReaderOutputSha256,
      meshPath: path.relative(ROOT, meshPath).split(path.sep).join('/'),
      meshValueHashes: {
        positionsFloat32LESha256: positionValueSha256,
        indicesUint32LESha256: indexValueSha256,
        note: 'recomputed from the mesh values; they equal the manifest and the mapping index'
      }
    },
    diagnostics: manifest.diagnostics,
    tyres: manifest.tyres,
    wheelKindCounts: manifest.wheelKindCounts,
    carParts,
    wheelGroups,
    carNodes,
    carDraws: draws
  };
}

const bodies = {};
const fallbackBodies = [];
for (const rosterCar of roster.cars) {
  const entry = carIndex.cars.find((candidate) => candidate.slug === rosterCar.slug);
  if (entry && entry.mapped) {
    const carTexture = carTextureBySlug.get(rosterCar.slug);
    if (!carTexture) throw new Error(rosterCar.slug + ': no P52 car texture record');
    const carTextures = loadCarTexturePack(rosterCar.slug, carTexture);
    const body = buildBody({ ...entry, name: rosterCar.name }, { carTextures });
    bodies[body.slug] = body;
  } else {
    const reason = entry?.reason ?? 'not present in the mapping index';
    const body = buildBody({ slug: rosterCar.slug, name: rosterCar.name },
      { fallback: true, reason });
    bodies[body.slug] = body;
    fallbackBodies.push({ slug: rosterCar.slug, reason });
  }
}

// The twenty-five bodies must reproduce the pinned per-car P52 coverage exactly:
// a silently dropped texture or draw is the failure mode this whole pass exists
// to prevent. The first five rows are the original anchors, the next ten are the
// V1-audited batch 1 and the last ten are batch 2 (seven C records + three B
// cars). Each row is the car's own value, so a roster addition cannot hide
// behind an aggregate total.
const COMMITTED_CAR_COVERAGE = {
  'corvette-zr1-stock': { draws: 100, textured: 50, paint: 10, light: 17, noAlbedo: 23, textures: 9, rgbaBytes: 4538368 },
  'lotus-exige-cup260-stock': { draws: 88, textured: 48, paint: 0, light: 14, noAlbedo: 26, textures: 9, rgbaBytes: 4997120 },
  'dodge-challenger-stock': { draws: 104, textured: 42, paint: 11, light: 13, noAlbedo: 38, textures: 7, rgbaBytes: 2637824 },
  'ford-focusrs-stock': { draws: 115, textured: 37, paint: 15, light: 13, noAlbedo: 50, textures: 7, rgbaBytes: 3424256 },
  'audi-r8v10-stock': { draws: 84, textured: 47, paint: 9, light: 9, noAlbedo: 19, textures: 8, rgbaBytes: 2580480 },
  'audi-tt-stock': { draws: 100, textured: 52, paint: 12, light: 13, noAlbedo: 23, textures: 7, rgbaBytes: 2637824 },
  'ford-f100-offroad': { draws: 78, textured: 34, paint: 8, light: 6, noAlbedo: 30, textures: 7, rgbaBytes: 2588672 },
  'ford-fr100-stock': { draws: 71, textured: 33, paint: 10, light: 7, noAlbedo: 21, textures: 8, rgbaBytes: 2576384 },
  'volkswagen-golfw12650-stock': { draws: 92, textured: 43, paint: 10, light: 8, noAlbedo: 31, textures: 8, rgbaBytes: 2580480 },
  'ford-mustanggtr-stock': { draws: 101, textured: 55, paint: 14, light: 8, noAlbedo: 24, textures: 7, rgbaBytes: 2637824 },
  'dodge-viperacr-stock': { draws: 83, textured: 48, paint: 12, light: 14, noAlbedo: 9, textures: 7, rgbaBytes: 3424256 },
  'audi-s3-stock': { draws: 99, textured: 49, paint: 11, light: 17, noAlbedo: 22, textures: 7, rgbaBytes: 3424256 },
  'ford-bronco-offroad': { draws: 82, textured: 25, paint: 10, light: 7, noAlbedo: 40, textures: 6, rgbaBytes: 2392064 },
  'nissan-skyliner34ztune-stock': { draws: 96, textured: 46, paint: 14, light: 13, noAlbedo: 23, textures: 7, rgbaBytes: 2379776 },
  'chevrolet-socalhhr-stock': { draws: 85, textured: 64, paint: 0, light: 10, noAlbedo: 11, textures: 8, rgbaBytes: 3686400 },
  'dodge-challenger-tuner': { draws: 93, textured: 50, paint: 0, light: 11, noAlbedo: 32, textures: 8, rgbaBytes: 4472832 },
  'nissan-350znismo-stock': { draws: 123, textured: 52, paint: 0, light: 14, noAlbedo: 57, textures: 8, rgbaBytes: 3686400 },
  'chevrolet-camaro-stocke3': { draws: 100, textured: 31, paint: 9, light: 12, noAlbedo: 48, textures: 7, rgbaBytes: 3424256 },
  'volkswagen-beetle-offroad': { draws: 85, textured: 29, paint: 13, light: 5, noAlbedo: 38, textures: 8, rgbaBytes: 3702784 },
  'foose-stallion-stock': { draws: 103, textured: 46, paint: 2, light: 10, noAlbedo: 45, textures: 8, rgbaBytes: 4472832 },
  'chevrolet-camaro-ratdrift': { draws: 99, textured: 37, paint: 0, light: 14, noAlbedo: 48, textures: 8, rgbaBytes: 4472832 },
  'corvette-c3-rat': { draws: 83, textured: 35, paint: 0, light: 10, noAlbedo: 38, textures: 8, rgbaBytes: 2768896 },
  'bmw-m3e92-tuner': { draws: 94, textured: 54, paint: 7, light: 10, noAlbedo: 23, textures: 8, rgbaBytes: 3432448 },
  'koenigsegg-ccxr-stock': { draws: 97, textured: 63, paint: 9, light: 17, noAlbedo: 8, textures: 9, rgbaBytes: 3563520 },
  'toyota-supratrd-stock': { draws: 88, textured: 53, paint: 11, light: 9, noAlbedo: 15, textures: 7, rgbaBytes: 3424256 },
  'opel-astraextreme-shannon': { draws: 86, textured: 72, paint: 0, light: 9, noAlbedo: 5, textures: 11, rgbaBytes: 4939776 },
  'bmw-1seriestii-race': { draws: 116, textured: 43, paint: 11, light: 9, noAlbedo: 53, textures: 7, rgbaBytes: 3358720 },
  'ford-focusrs-race': { draws: 110, textured: 36, paint: 12, light: 10, noAlbedo: 52, textures: 7, rgbaBytes: 2572288 },
  'renault-meganesportr26-stockgrpc': { draws: 125, textured: 47, paint: 0, light: 19, noAlbedo: 59, textures: 7, rgbaBytes: 4407296 },
  'renault-meganetrophy-stock': { draws: 93, textured: 47, paint: 8, light: 11, noAlbedo: 27, textures: 8, rgbaBytes: 3571712 },
  'bmw-135-stock': { draws: 111, textured: 49, paint: 1, light: 9, noAlbedo: 52, textures: 9, rgbaBytes: 4669440 },
  'landrover-lrx-stock': { draws: 135, textured: 40, paint: 8, light: 11, noAlbedo: 76, textures: 7, rgbaBytes: 3424256 },
  'nissan-350z-drift': { draws: 125, textured: 37, paint: 13, light: 13, noAlbedo: 62, textures: 10, rgbaBytes: 3449856 },
  'bmw-x548msport-stock': { draws: 91, textured: 46, paint: 11, light: 11, noAlbedo: 23, textures: 8, rgbaBytes: 2445312 },
  'chevrolet-camaross-stock': { draws: 122, textured: 35, paint: 14, light: 14, noAlbedo: 59, textures: 8, rgbaBytes: 3359744 },
  'nissan-navara-rat': { draws: 75, textured: 44, paint: 8, light: 10, noAlbedo: 13, textures: 8, rgbaBytes: 2646016 },
  'landrover-defendersvxgrpc': { draws: 85, textured: 30, paint: 7, light: 12, noAlbedo: 36, textures: 7, rgbaBytes: 2637824 },
  'bowler-nemesis-stock': { draws: 84, textured: 45, paint: 0, light: 11, noAlbedo: 28, textures: 9, rgbaBytes: 4481024 },
  'vauxhall-monarovxr-drift': { draws: 104, textured: 35, paint: 11, light: 6, noAlbedo: 52, textures: 7, rgbaBytes: 2318336 },
  'ford-mustang-gt500-stock1stplay': { draws: 110, textured: 52, paint: 10, light: 14, noAlbedo: 34, textures: 7, rgbaBytes: 3424256 },
  'foose-69-stock': { draws: 98, textured: 37, paint: 0, light: 14, noAlbedo: 47, textures: 8, rgbaBytes: 3686400 },
  'corvette-c3-drag': { draws: 65, textured: 24, paint: 6, light: 8, noAlbedo: 27, textures: 5, rgbaBytes: 2244608 },
  'ford-f100-rat': { draws: 74, textured: 44, paint: 0, light: 7, noAlbedo: 23, textures: 8, rgbaBytes: 3686400 },
  'chevrolet-camaross-drag': { draws: 107, textured: 36, paint: 13, light: 10, noAlbedo: 48, textures: 7, rgbaBytes: 3358720 },
  'ford-f150-offroadheh': { draws: 120, textured: 39, paint: 12, light: 14, noAlbedo: 55, textures: 7, rgbaBytes: 3440640 },
  'volkswagen-scirocco-24': { draws: 85, textured: 54, paint: 11, light: 8, noAlbedo: 12, textures: 9, rgbaBytes: 3436544 },
  'nissan-navara-offroad': { draws: 73, textured: 47, paint: 5, light: 13, noAlbedo: 8, textures: 8, rgbaBytes: 3686400 },
  'volkswagen-beetle-rat': { draws: 94, textured: 42, paint: 1, light: 5, noAlbedo: 46, textures: 6, rgbaBytes: 3358720 },
  'bmw-m3e92-drift': { draws: 101, textured: 48, paint: 11, light: 10, noAlbedo: 32, textures: 9, rgbaBytes: 3379200 },
  'hummer-h2-offroad': { draws: 98, textured: 23, paint: 5, light: 20, noAlbedo: 50, textures: 6, rgbaBytes: 2392064 },
  'dodge-challenger-race': { draws: 99, textured: 32, paint: 9, light: 12, noAlbedo: 46, textures: 7, rgbaBytes: 3358720 },
  'acschnitzer-acs1coupe-stock': { draws: 108, textured: 36, paint: 11, light: 11, noAlbedo: 50, textures: 7, rgbaBytes: 3424256 },
  'corvette-c3-race': { draws: 80, textured: 26, paint: 6, light: 10, noAlbedo: 38, textures: 6, rgbaBytes: 1327104 },
  'hennessey-vipervenom1000coupe-stock': { draws: 86, textured: 45, paint: 12, light: 14, noAlbedo: 15, textures: 9, rgbaBytes: 4538368 },
  'opel-astraextreme-stockgrippy': { draws: 86, textured: 63, paint: 9, light: 9, noAlbedo: 5, textures: 10, rgbaBytes: 3891200 },
  'ford-gt-stock': { draws: 114, textured: 95, paint: 0, light: 16, noAlbedo: 3, textures: 9, rgbaBytes: 3162112 },
  'dodge-vipergtsr-stock': { draws: 91, textured: 51, paint: 10, light: 13, noAlbedo: 17, textures: 8, rgbaBytes: 4472832 },
};
{
  const bodyList = Object.values(bodies);
  if (bodyList.length !== Object.keys(COMMITTED_CAR_COVERAGE).length) {
    throw new Error('car bodies: ' + bodyList.length + ' built, ' +
      Object.keys(COMMITTED_CAR_COVERAGE).length + ' pinned');
  }
  const totals = {
    draws: bodyList.reduce((sum, body) => sum + body.carDraws.length, 0),
    textured: bodyList.reduce((sum, body) =>
      sum + body.carDraws.filter((draw) => draw.textureId !== null).length, 0),
    paint: bodyList.reduce((sum, body) =>
      sum + body.carDraws.filter((draw) => draw.textureBinding?.status === 'runtimePaintLookup').length, 0),
    light: bodyList.reduce((sum, body) =>
      sum + body.carDraws.filter((draw) => draw.textureBinding?.status === 'runtimeLightBlend').length, 0),
    noAlbedo: bodyList.reduce((sum, body) =>
      sum + body.carDraws.filter((draw) => draw.textureBinding?.status === 'runtimeShaderNoAlbedo').length, 0),
    textures: bodyList.reduce((sum, body) => sum + body.textures.length, 0),
    rgbaBytes: bodyList.reduce((sum, body) =>
      sum + body.textures.reduce((inner, texture) => inner + texture.rgbaBytes, 0), 0),
    uvBytes: bodyList.reduce((sum, body) => sum + (body.mesh.uv?.bytes ?? 0), 0),
  };
  for (const body of bodyList) {
    const expected = COMMITTED_CAR_COVERAGE[body.slug];
    if (!expected) throw new Error(body.slug + ': no pinned P52 coverage');
    const actual = {
      draws: body.carDraws.length,
      textured: body.carDraws.filter((draw) => draw.textureId !== null).length,
      paint: body.carDraws.filter((draw) => draw.textureBinding?.status === 'runtimePaintLookup').length,
      light: body.carDraws.filter((draw) => draw.textureBinding?.status === 'runtimeLightBlend').length,
      noAlbedo: body.carDraws.filter((draw) => draw.textureBinding?.status === 'runtimeShaderNoAlbedo').length,
      textures: body.textures.length,
      rgbaBytes: body.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0)
    };
    for (const [key, value] of Object.entries(expected)) {
      if (actual[key] !== value) {
        throw new Error('car texture totals: ' + body.slug + ' ' + key + ' is ' + actual[key] +
          ', pinned ' + value);
      }
    }
  }
  if (totals.textured + totals.paint + totals.light + totals.noAlbedo !== totals.draws) {
    throw new Error('car draw classes do not cover every draw');
  }
}

// ------------------------------------------------------- real track visual
//
// The committed `level_inspect` direct-draw references (one JSON per block/node
// pair, produced by the read-only level reader and checked native/WASM/Python in
// docs/plan/level-candidates.md) are the real River render geometry. They are
// pinned by SHA-256 so a regenerated or hand-edited reference is a hard failure.
//
// Two sections are concatenated into one mesh (one upload, the same bounded
// upload count as before):
//   * block88/node283 — the instructed asset: 95 draws, 17,782 vertices,
//     9,343 triangles. Its source bounds (x 944..2478, z 2206..3237) do NOT
//     overlap the drive box (x -120..-10, z 1010..1090), so it is drawn at its
//     true world position and cannot be the ground under the scripted car;
//   * block56/node289 — the committed direct-draw section that DOES overlap the
//     drive box (9 of its 49 draws, and its road y at the spawn is 5.80685,
//     within 0.0006 m of the engine's 5.8074 ground probe). This is what makes
//     the drive screenshots show real road instead of the diagnostic slab.
// Both are source positions and indices, only concatenated: no transform, no
// clipping, no re-derivation.
// The measured 539.81 m corridor (docs/work/analysis/track-coverage.md) crosses six
// committed sections. Five of them have no per-section level_inspect reference; the
// committed measurement artifact `_work/track-coverage/visual.json` carries the same
// first-RenderList direct draws and draw ranges for all 46 sections. It is pinned by
// its recorded SHA-256 here and every used section is pinned again by the
// positions/indices hashes that track-coverage measured from it.
const TRACK_COVERAGE_VISUAL = {
  path: '_work/track-coverage/visual.json',
  sha256: 'sha256:877b4dc7e1f5ece197f0776239b33d23b0350f8cf77ef462c0c7a266a6abcb67',
  geometryVersion: { kind: 'track-coverage.visual-sections', version: 1 }
};

const TRACK_VISUAL_ID = 'river.track.visual';
const TRACK_VISUAL_SECTIONS = [
  {
    key: 'river.block88.node283',
    geometryBlock: 88,
    nodeBlock: 283,
    sourceKind: 'level-inspect',
    path: '_work/level-candidates/probes/00-usa_la_river-g88-n283/reference.json',
    sha256: 'sha256:e2a830f40af73ddcab928f719212c0bbdc77416b276b83c5a6e05ac48c887b89',
    role: 'instructed direct-draw set; 95 draws / 17,782 vertices / 9,343 triangles',
    driveBoxOverlap: false,
    courseOverlap: false,
    courseMetres: null
  },
  {
    key: 'river.block56.node289',
    geometryBlock: 56,
    nodeBlock: 289,
    sourceKind: 'level-inspect',
    path: '_work/level-candidates/probes/08-usa_la_river-g56-n289/reference.json',
    sha256: 'sha256:ac570f64be34a0e0480173c8c31f3784e28200e7a6ddfe14a7bf462a458dccaf',
    role: 'drive-covering direct-draw section (bounds cross the drive box; road y matches the collision probe at the spawn)',
    driveBoxOverlap: true,
    courseOverlap: true,
    courseMetres: 19.67
  },
  {
    key: 'river.block58.node265',
    geometryBlock: 58,
    nodeBlock: 265,
    sourceKind: 'track-coverage',
    sectionKey: 'g58-n265',
    vertexCount: 12227,
    triangleCount: 7393,
    drawCount: 41,
    positionsSha256: '2565265ddb1732d5259cff9f10e3633a3a572c30649f81792d6dc64ac69c7757',
    indicesSha256: '9578f1fb3688e4bab25f4cc80f429dc60228e1a1da98495ef854cadba8b2aca9',
    role: 'measured corridor section on the sprint course',
    driveBoxOverlap: false,
    courseOverlap: true,
    courseMetres: 45.01
  },
  {
    key: 'river.block50.node265',
    geometryBlock: 50,
    nodeBlock: 265,
    sourceKind: 'track-coverage',
    sectionKey: 'g50-n265',
    vertexCount: 13874,
    triangleCount: 7740,
    drawCount: 44,
    positionsSha256: 'd3b29f46fab533f049e2fa251e01c1b691063279d63a1a30f8b88ee93f4277bf',
    indicesSha256: '1ea461c94d13932425bf461f6200ec1b9fcbae3d2bb061de0267cc4a28f34b8f',
    role: 'measured corridor section on the sprint course',
    driveBoxOverlap: false,
    courseOverlap: true,
    courseMetres: 31.55
  },
  {
    key: 'river.block71.node209',
    geometryBlock: 71,
    nodeBlock: 209,
    sourceKind: 'track-coverage',
    sectionKey: 'g71-n209',
    vertexCount: 11524,
    triangleCount: 6736,
    drawCount: 56,
    positionsSha256: '2ed051dd16c25868d9816671f331b0b6f83fb2b68a04736635cc731f1874013c',
    indicesSha256: 'bffa2f5d40ec5b684af6d8d52e9b863c0a69825c6720971d27c3963ff33ebe35',
    role: 'measured corridor section on the sprint course (longest share: 303.23 m)',
    driveBoxOverlap: false,
    courseOverlap: true,
    courseMetres: 303.23
  },
  {
    key: 'river.block64.node209',
    geometryBlock: 64,
    nodeBlock: 209,
    sourceKind: 'track-coverage',
    sectionKey: 'g64-n209',
    vertexCount: 11145,
    triangleCount: 6688,
    drawCount: 40,
    positionsSha256: '9fa0646e5b0c100c185f5ddf9824bbcf1b89b63d8014d512e293e1ec6bd04661',
    indicesSha256: 'e42076fbaaf425e6621115a27462708eb9ef73739a47f87d1d914e1e107ba525',
    role: 'measured corridor section on the sprint course (contains the finish)',
    driveBoxOverlap: false,
    courseOverlap: true,
    courseMetres: 130.9
  },
  {
    key: 'river.block59.node265',
    geometryBlock: 59,
    nodeBlock: 265,
    sourceKind: 'track-coverage',
    sectionKey: 'g59-n265',
    vertexCount: 15434,
    triangleCount: 9409,
    drawCount: 69,
    positionsSha256: '5baaefc87d08cdd2ec6311cdbcc51ad6ec0ddf64b920a6bd81c7f4f3eefb2660',
    indicesSha256: '346df7d2f0c0f1ba4b4ddfb54e76d6cd5b7a4e0cadf3d48600a033abfc5f9b47',
    role: 'measured corridor section on the sprint course (short 8.04 m share before the end seam)',
    driveBoxOverlap: false,
    courseOverlap: true,
    courseMetres: 8.04
  }
];

const IDENTITY_WORLD = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function float32Hash(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return createHash('sha256').update(buffer).digest('hex');
}
function uint32Hash(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeUInt32LE(value, index * 4));
  return createHash('sha256').update(buffer).digest('hex');
}

function loadLevelInspectSection(spec) {
  const file = path.join(ROOT, spec.path);
  if (!existsSync(file)) {
    throw new Error('missing ' + spec.path + ' — the committed level_inspect direct-draw reference is an input');
  }
  const bytes = readFileSync(file);
  const fileSha = sha256(bytes);
  if (fileSha !== spec.sha256) {
    throw new Error(spec.key + ': reference is not the pinned level_inspect output: ' + fileSha +
      ' (expected ' + spec.sha256 + ')');
  }
  const doc = JSON.parse(bytes.toString('utf8'));
  if (doc.vertexCount !== doc.positions.length / 3) {
    throw new Error(spec.key + ': vertexCount does not match positions');
  }
  if (doc.triangleCount * 3 !== doc.indices.length) {
    throw new Error(spec.key + ': triangleCount does not match indices');
  }
  if (float32Hash(doc.positions) !== doc.positionsFloat32LESha256 ||
      uint32Hash(doc.indices) !== doc.indicesUint32LESha256) {
    throw new Error(spec.key + ': reference value hashes do not match its own positions/indices');
  }
  return { ...spec, doc, bytes, sourceFile: spec.path, sourceSha256: spec.sha256 };
}

// The 46-section measurement artifact is loaded once and pinned by the hash the
// track-coverage analysis recorded. A different file is a hard failure: the
// sections below must not silently consume a regenerated or hand-edited map.
let trackCoverageSource = null;
function loadTrackCoverageDocument() {
  if (trackCoverageSource) return trackCoverageSource;
  const file = path.join(ROOT, TRACK_COVERAGE_VISUAL.path);
  if (!existsSync(file)) {
    throw new Error('missing ' + TRACK_COVERAGE_VISUAL.path + ' — the committed track-coverage draw map is an ' +
      'input for the corridor sections; run `python probes/track-coverage/tools/build_reference.py` first');
  }
  const bytes = readFileSync(file);
  const fileSha = sha256(bytes);
  if (fileSha !== TRACK_COVERAGE_VISUAL.sha256) {
    throw new Error(TRACK_COVERAGE_VISUAL.path + ' is not the pinned track-coverage output: ' + fileSha +
      ' (expected ' + TRACK_COVERAGE_VISUAL.sha256 + ')');
  }
  const doc = JSON.parse(bytes.toString('utf8'));
  if (doc.kind !== TRACK_COVERAGE_VISUAL.geometryVersion.kind ||
      doc.version !== TRACK_COVERAGE_VISUAL.geometryVersion.version) {
    throw new Error(TRACK_COVERAGE_VISUAL.path + ': kind/version is not ' +
      TRACK_COVERAGE_VISUAL.geometryVersion.kind + ' v' + TRACK_COVERAGE_VISUAL.geometryVersion.version);
  }
  trackCoverageSource = { doc, bytes, file: TRACK_COVERAGE_VISUAL.path, sha256: TRACK_COVERAGE_VISUAL.sha256 };
  return trackCoverageSource;
}

function loadTrackCoverageSection(spec) {
  const source = loadTrackCoverageDocument();
  const doc = source.doc.sections.find((section) => section.key === spec.sectionKey);
  if (!doc) throw new Error(spec.key + ': section ' + spec.sectionKey + ' is missing from the track-coverage map');
  if (doc.status !== 'ok') throw new Error(spec.key + ': section ' + spec.sectionKey + ' is not ok in the track-coverage map');
  if (doc.vertexCount !== spec.vertexCount || doc.triangleCount !== spec.triangleCount ||
      doc.drawCount !== spec.drawCount) {
    throw new Error(spec.key + ': counts differ from the pinned track-coverage record (' +
      doc.vertexCount + '/' + doc.triangleCount + '/' + doc.drawCount + ')');
  }
  if (doc.positions.length / 3 !== doc.vertexCount || doc.indices.length / 3 !== doc.triangleCount) {
    throw new Error(spec.key + ': track-coverage section arrays do not match its own counts');
  }
  const positionsSha = float32Hash(doc.positions);
  const indicesSha = uint32Hash(doc.indices);
  if (positionsSha !== spec.positionsSha256 || indicesSha !== spec.indicesSha256) {
    throw new Error(spec.key + ': track-coverage section values are not the pinned draws (' +
      positionsSha + ' / ' + indicesSha + ')');
  }
  for (const draw of doc.draws) {
    if (!Number.isInteger(draw.firstIndex) || !Number.isInteger(draw.indexCount) ||
        draw.indexCount <= 0 || draw.indexCount % 3 !== 0 ||
        draw.firstIndex < 0 || draw.firstIndex + draw.indexCount > doc.indices.length) {
      throw new Error(spec.key + ': draw ' + draw.primitiveIndex + ' has an invalid index range');
    }
  }
  return { ...spec, doc, bytes: null, sourceFile: source.file, sourceSha256: source.sha256,
    sourceSection: spec.sectionKey };
}

function loadTrackVisualSection(spec) {
  return spec.sourceKind === 'track-coverage'
    ? loadTrackCoverageSection(spec)
    : loadLevelInspectSection(spec);
}

const trackSections = TRACK_VISUAL_SECTIONS.map(loadTrackVisualSection);

// The committed level_inspect reference and the track-coverage map are two
// independent readers of the same source. For the one section that has both
// (block56/node289) they must agree exactly; that equality is asserted, not
// assumed, before the merged mesh is built.
{
  const reference = trackSections.find((section) => section.sourceKind === 'level-inspect' &&
    section.key === 'river.block56.node289');
  const measured = trackCoverageSource?.doc.sections.find((section) => section.key === 'g56-n289');
  if (reference && measured) {
    if (float32Hash(measured.positions) !== reference.doc.positionsFloat32LESha256 ||
        uint32Hash(measured.indices) !== reference.doc.indicesUint32LESha256) {
      throw new Error('river.block56.node289: the level_inspect reference and the track-coverage map disagree');
    }
  }
}

// ------------------------------------------------- real UV0 + albedo textures
//
// `build_track_textures.py` exports the P45/P47 measurements as data: the UV0
// array of every merged vertex (the committed `level_inspect` mesh stream P45
// proved equal to the engine stream draw by draw) and one RGBA bitmap per
// distinct static `g_tAlbedo` source (the committed BC1 decode of the P34/P47
// blob). Nothing here is derived again: the manifest pins every texture and UV
// value by hash, the RGBA files are re-hashed before they are embedded, and a
// draw without a P45/P47 row keeps `textureId:null` with a labelled reason.
const TRACK_TEXTURE_MANIFEST = path.join(ROOT, '_work/e1-drive/track-textures.json');
if (!existsSync(TRACK_TEXTURE_MANIFEST)) {
  throw new Error('missing ' + path.relative(ROOT, TRACK_TEXTURE_MANIFEST) +
    ' — run `python probes/e1-drive/tools/build_track_textures.py` first');
}
const textureManifestBytes = readFileSync(TRACK_TEXTURE_MANIFEST);
const textureManifest = JSON.parse(textureManifestBytes.toString('utf8'));
if (textureManifest.kind !== 'e1-drive.track-textures' || textureManifest.version !== 1) {
  throw new Error('track texture manifest kind/version is not e1-drive.track-textures v1');
}
if (textureManifest.pins?.uvAggregate !== '2ed1f4b0b3c9148e' ||
    textureManifest.pins?.bindingAggregate !== '9cc08756505dd497') {
  throw new Error('track texture manifest does not carry the P45/P47 aggregates');
}
if (textureManifest.sections.length !== TRACK_VISUAL_SECTIONS.length) {
  throw new Error('track texture manifest has ' + textureManifest.sections.length +
    ' sections, the visual has ' + TRACK_VISUAL_SECTIONS.length);
}
for (let index = 0; index < TRACK_VISUAL_SECTIONS.length; index++) {
  if (textureManifest.sections[index].key !== TRACK_VISUAL_SECTIONS[index].key) {
    throw new Error('track texture manifest section ' + index + ' is ' +
      textureManifest.sections[index].key + ', the visual expects ' + TRACK_VISUAL_SECTIONS[index].key);
  }
}

const uvPath = path.join(ROOT, textureManifest.uvStream.path);
const uvBuffer = readFileSync(uvPath);
if (uvBuffer.length !== textureManifest.uvStream.bytes ||
    sha256(uvBuffer) !== textureManifest.uvStream.sha256) {
  throw new Error('track UV stream is not the one the manifest pinned: ' + sha256(uvBuffer));
}
if (uvBuffer.length !== textureManifest.uvStream.vertexCount * 8) {
  throw new Error('track UV stream length does not match its vertex count');
}
const trackUvs = new Float32Array(textureManifest.uvStream.vertexCount * 2);
for (let index = 0; index < trackUvs.length; index++) {
  trackUvs[index] = uvBuffer.readFloatLE(index * 4);
  if (!Number.isFinite(trackUvs[index])) throw new Error('track UV stream has a non-finite component at ' + index);
}

const textureRecords = textureManifest.textures.map((texture) => {
  const file = path.join(ROOT, texture.rgbaPath);
  const bytes = readFileSync(file);
  if (sha256(bytes) !== texture.rgbaSha256) {
    throw new Error(texture.id + ': RGBA file is not the one the manifest pinned');
  }
  if (bytes.length !== texture.rgbaBytes || bytes.length !== texture.width * texture.height * 4) {
    throw new Error(texture.id + ': RGBA length does not match its declared size');
  }
  return {
    id: texture.id,
    source: texture.block + ':' + texture.index,
    block: texture.block,
    index: texture.index,
    name: texture.name,
    textureHash: texture.textureHash,
    width: texture.width,
    height: texture.height,
    levels: texture.levels,
    format: texture.format,
    formatName: texture.formatName,
    payloadBytes: texture.payloadBytes,
    rgbaBytes: texture.rgbaBytes,
    rgbaSha256: texture.rgbaSha256,
    rgbaFnv1a64: texture.rgbaFnv1a64,
    decodeRegistry: texture.registry,
    drawCount: texture.drawCount,
    blob: texture.blob,
    blobSha256: texture.blobSha256,
    rgbaBase64: bytes.toString('base64')
  };
});
if (new Set(textureRecords.map((texture) => texture.id)).size !== textureRecords.length) {
  throw new Error('track texture ids are not unique');
}
const textureById = new Map(textureRecords.map((texture) => [texture.id, texture]));
const textureDrawByKey = new Map(textureManifest.draws.map((draw) => [
  draw.sectionKey + ':' + draw.sectionDrawIndex, draw
]));
if (textureDrawByKey.size !== textureManifest.draws.length) {
  throw new Error('track texture manifest draw keys are not unique');
}

// ------------------------------------------- level-instance prop UV0 + albedo
//
// P73a exports the real UV0 stream and the resolved static `g_tAlbedo` identity
// for the 22 River block27/node253 instance draws. `build_level_instance_textures.py`
// joins that identity to the P34 registry and the committed BC decoder, and pins
// the 18 BC1 draws / 4 BC3-alpha draws. The mesh positions/indices are the same
// committed reader output the render packet carries, so the UV stream is parallel
// by construction; every hash and draw range is re-checked here.
if (!existsSync(LEVEL_PROP_TEXTURE_MANIFEST)) {
  throw new Error('missing ' + path.relative(ROOT, LEVEL_PROP_TEXTURE_MANIFEST) +
    ' — run `python probes/e1-drive/tools/build_level_instance_textures.py` first');
}
const levelPropManifestBytes = readFileSync(LEVEL_PROP_TEXTURE_MANIFEST);
const levelPropManifestSha = sha256(levelPropManifestBytes);
if (levelPropManifestSha !== COMMITTED_LEVEL_PROP_TEXTURES) {
  throw new Error('level-instance prop manifest is not the committed one: ' + levelPropManifestSha +
    ' (expected ' + COMMITTED_LEVEL_PROP_TEXTURES + ')');
}
const levelPropDoc = JSON.parse(levelPropManifestBytes.toString('utf8'));
if (levelPropDoc.kind !== 'e1-drive.level-instance-textures' || levelPropDoc.version !== 1) {
  throw new Error('level-instance prop manifest kind/version is not e1-drive.level-instance-textures v1');
}
if (levelPropDoc.mesh?.id !== levelMesh.id ||
    levelPropDoc.mesh?.vertexCount !== levelMesh.vertexCount ||
    levelPropDoc.mesh?.triangleCount !== levelMesh.indexCount / 3) {
  throw new Error('level-instance prop manifest does not describe the render-packet level mesh');
}
if (hex(levelPropDoc.mesh.positionsSha256) !== hex(levelMesh.positionsSha256) ||
    hex(levelPropDoc.mesh.indicesSha256) !== hex(levelMesh.indicesSha256)) {
  throw new Error('level-instance prop manifest mesh hashes differ from the render-packet level mesh');
}

const levelPropUvPath = path.join(ROOT, levelPropDoc.uvStream.path);
const levelPropUvBytes = readFileSync(levelPropUvPath);
if (levelPropUvBytes.length !== levelPropDoc.uvStream.bytes ||
    sha256(levelPropUvBytes) !== levelPropDoc.uvStream.sha256) {
  throw new Error('level-instance prop UV stream is not the one the manifest pinned: ' +
    sha256(levelPropUvBytes));
}
if (levelPropUvBytes.length !== levelMesh.vertexCount * 8) {
  throw new Error('level-instance prop UV stream length does not match the level mesh vertex count');
}
const levelPropUvs = new Float32Array(levelMesh.vertexCount * 2);
for (let index = 0; index < levelPropUvs.length; index++) {
  levelPropUvs[index] = levelPropUvBytes.readFloatLE(index * 4);
  if (!Number.isFinite(levelPropUvs[index])) {
    throw new Error('level-instance prop UV stream has a non-finite component at ' + index);
  }
}
const levelPropUv = {
  storage: 'base64-float32le',
  components: 2,
  vertexCount: levelMesh.vertexCount,
  values: levelPropUvs.length,
  bytes: levelPropUvBytes.length,
  sha256: levelPropDoc.uvStream.sha256,
  data: levelPropUvBytes.toString('base64'),
  source: {
    manifest: path.relative(ROOT, LEVEL_PROP_TEXTURE_MANIFEST).split(path.sep).join('/'),
    manifestSha256: levelPropManifestSha,
    stream: levelPropDoc.uvStream.path,
    aggregate: levelPropDoc.uvStream.aggregate,
    provenance:
      'P73a asset-reader UV0 export (F16_2 -> float32le), parallel to the committed ' +
      'level_inspect --instances-all positions; every per-draw hash is re-derived here',
  },
};

const levelPropTextures = levelPropDoc.textures.map((texture) => {
  const file = path.join(ROOT, texture.rgbaPath);
  if (!existsSync(file)) {
    throw new Error(texture.id + ': missing decoded RGBA file ' + texture.rgbaPath);
  }
  const bytes = readFileSync(file);
  if (sha256(bytes) !== texture.rgbaSha256) {
    throw new Error(texture.id + ': RGBA file is not the one the manifest pinned');
  }
  if (bytes.length !== texture.rgbaBytes || bytes.length !== texture.width * texture.height * 4) {
    throw new Error(texture.id + ': RGBA length does not match its declared size');
  }
  return {
    id: texture.id,
    source: texture.source,
    block: texture.block,
    index: texture.index,
    name: texture.name,
    textureHash: texture.textureHash,
    width: texture.width,
    height: texture.height,
    levels: texture.levels,
    format: texture.format,
    formatName: texture.formatName,
    payloadBytes: texture.payloadBytes,
    rgbaPath: texture.rgbaPath,
    rgbaBytes: texture.rgbaBytes,
    rgbaSha256: texture.rgbaSha256,
    rgbaFnv1a64: texture.rgbaFnv1a64,
    rgbaBase64: bytes.toString('base64'),
    decodeRegistry: 'engine-textures.json',
    drawCount: texture.bindableDraws,
    triangles: texture.triangles,
    blob: texture.blob,
    blobSha256: texture.blobSha256,
  };
});
if (new Set(levelPropTextures.map((texture) => texture.id)).size !== levelPropTextures.length) {
  throw new Error('level-instance prop texture ids are not unique');
}
const levelPropTextureById = new Map(levelPropTextures.map((texture) => [texture.id, texture]));
if (levelPropDoc.draws.length !== levelDraws.length) {
  throw new Error('level-instance prop manifest covers ' + levelPropDoc.draws.length +
    ' draws, the render packet has ' + levelDraws.length);
}
const levelBindings = levelDraws.map((draw) => {
  const instanceIndex = draw.source?.instanceIndex;
  const binding = levelPropDoc.draws.find((entry) => entry.instanceIndex === instanceIndex);
  if (!binding) {
    throw new Error('level draw ' + draw.id + ' has no instance ' + instanceIndex + ' in the prop manifest');
  }
  if (binding.basePrimitiveIndex !== draw.source.basePrimitiveIndex ||
      binding.firstIndex !== draw.indexOffset || binding.indexCount !== draw.indexCount) {
    throw new Error('level draw ' + draw.id + ' index range/primitive differs from the prop manifest');
  }
  const recomputed = '0x' + drawUvHash(levelPropUvs, levelMesh.indices,
    draw.indexOffset, draw.indexCount);
  if (recomputed !== binding.uvHash) {
    throw new Error('level draw ' + draw.id + ' UV0 hash ' + recomputed +
      ' does not match the exported ' + binding.uvHash);
  }
  const texture = binding.textureId === null ? null : levelPropTextureById.get(binding.textureId);
  if (binding.textureId !== null && !texture) {
    throw new Error('level draw ' + draw.id + ' names unknown texture ' + binding.textureId);
  }
  if (binding.bindable && !texture) {
    throw new Error('level draw ' + draw.id + ' is bindable but has no BC1 texture');
  }
  if (!binding.bindable && (texture || binding.blockedReason !== 'bc3-alpha-rule-missing')) {
    throw new Error('level draw ' + draw.id + ' is not blocked with bc3-alpha-rule-missing as declared');
  }
  return { binding, texture };
});
const levelBindable = levelBindings.filter((entry) => entry.binding.bindable);
const levelBlocked = levelBindings.filter((entry) => !entry.binding.bindable);
if (levelBindable.length !== 18 || levelBlocked.length !== 4) {
  throw new Error('level-instance prop split is ' + levelBindable.length + '/' +
    levelBlocked.length + ', expected 18/4');
}
if (levelBindable.reduce((sum, entry) => sum + entry.binding.triangleCount, 0) !== 10212 ||
    levelBlocked.reduce((sum, entry) => sum + entry.binding.triangleCount, 0) !== 96) {
  throw new Error('level-instance prop triangle split changed');
}

const trackPositions = [];
const trackIndices = [];
const trackDraws = [];
const trackSectionRecords = [];
let trackVertexBase = 0;
let trackIndexBase = 0;

for (const section of trackSections) {
  const doc = section.doc;
  for (const value of doc.positions) trackPositions.push(value);
  for (const value of doc.indices) trackIndices.push(value + trackVertexBase);

  const drawStartCount = trackDraws.length;
  let sectionDrawIndex = 0;
  for (const draw of doc.draws) {
    if (!Number.isInteger(draw.firstIndex) || !Number.isInteger(draw.indexCount) ||
        draw.indexCount <= 0 || draw.indexCount % 3 !== 0 ||
        draw.firstIndex < 0 || draw.firstIndex + draw.indexCount > doc.indices.length) {
      throw new Error(section.key + ': draw ' + draw.primitiveIndex + ' has an invalid index range');
    }
    const binding = textureDrawByKey.get(section.key + ':' + sectionDrawIndex);
    if (!binding || binding.mergedDrawIndex !== trackDraws.length) {
      throw new Error(section.key + ': draw ' + sectionDrawIndex + ' is missing from the texture manifest ' +
        '(or its merged index moved)');
    }
    if (binding.primitiveIndex !== draw.primitiveIndex) {
      throw new Error(section.key + ': draw ' + sectionDrawIndex + ' primitive index differs from the manifest');
    }
    const texture = binding.textureId === null ? null : textureById.get(binding.textureId);
    if (binding.textureId !== null && !texture) {
      throw new Error(section.key + ': draw ' + sectionDrawIndex + ' names unknown texture ' + binding.textureId);
    }
    sectionDrawIndex++;
    let minIndex = Infinity;
    let maxIndex = -Infinity;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let offset = draw.firstIndex; offset < draw.firstIndex + draw.indexCount; offset++) {
      const vertex = doc.indices[offset];
      if (!Number.isInteger(vertex) || vertex < 0 || vertex >= doc.vertexCount) {
        throw new Error(section.key + ': draw ' + draw.primitiveIndex + ' index ' + vertex + ' is outside the source mesh');
      }
      if (vertex < minIndex) minIndex = vertex;
      if (vertex > maxIndex) maxIndex = vertex;
      for (let axis = 0; axis < 3; axis++) {
        const value = doc.positions[vertex * 3 + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
    trackDraws.push({
      id: section.key + '.draw.' + trackDraws.length,
      meshId: TRACK_VISUAL_ID,
      vertexOffset: trackVertexBase + minIndex,
      vertexCount: maxIndex - minIndex + 1,
      indexOffset: trackIndexBase + draw.firstIndex,
      indexCount: draw.indexCount,
      materialId: null,
      materialReason: texture
        ? 'asset-reader direct draw: the static g_tAlbedo texture ' + texture.id + ' (' + texture.name +
          ', ' + texture.width + 'x' + texture.height + ') is bound and sampled with the real UV0 stream; the ' +
          'rest of the material (colour, blend state, shader stages) is not applied (materialsApplied:false)'
        : 'asset-reader direct draw: no static albedo texture is bound (' + binding.bindingStatus + ': ' +
          binding.bindingReason + '); the draw keeps its source index range and the diagnostic albedo',
      textureId: texture ? texture.id : null,
      textureBinding: {
        status: binding.bindingStatus,
        reason: binding.bindingReason,
        source: binding.textureSource,
        name: binding.textureName ?? null,
        uvProvenance: binding.uvProvenance,
        uvHash: binding.uvHash
      },
      layer: 'opaque',
      bounds: { min: min.map((value) => Number(value.toFixed(6))), max: max.map((value) => Number(value.toFixed(6))) },
      worldKind: 'baked-into-mesh',
      trackVisual: 'asset-reader-direct-draws',
      source: {
        tool: section.sourceKind === 'track-coverage'
          ? 'track-coverage build_reference.py direct draws (46-section draw map)'
          : 'level_inspect (committed direct-draw reference)',
        reference: section.sourceFile,
        referenceSha256: section.sourceSha256,
        sourceSection: section.sourceSection ?? null,
        geometryBlock: section.geometryBlock,
        nodeBlock: section.nodeBlock,
        drawIndex: trackDraws.length,
        primitiveIndex: draw.primitiveIndex,
        primitiveOffset: draw.primitiveOffset,
        declaration: draw.declaration,
        topology: draw.topology,
        sourceVertexBuffer: draw.sourceVertexBuffer,
        sourceIndexBuffer: draw.sourceIndexBuffer,
        sourceFirstIndex: draw.firstIndex,
        sourceIndexCount: draw.indexCount,
        world: IDENTITY_WORLD,
        worldReason: 'noInstanceTransform: direct draw, no instance placement; identity is the source world'
      }
    });
  }

  if (sectionDrawIndex !== doc.draws.length) {
    throw new Error(section.key + ': texture manifest covers ' + sectionDrawIndex + ' of ' + doc.draws.length + ' draws');
  }

  const manifestSection = textureManifest.sections.find((entry) => entry.key === section.key);
  trackSectionRecords.push({
    key: section.key,
    geometryBlock: section.geometryBlock,
    nodeBlock: section.nodeBlock,
    role: section.role,
    sourceKind: section.sourceKind,
    driveBoxOverlap: section.driveBoxOverlap,
    courseOverlap: section.courseOverlap,
    courseMetres: section.courseMetres,
    reference: section.sourceFile,
    referenceSha256: section.sourceSha256,
    referenceBytes: section.bytes ? section.bytes.length : null,
    sourceSection: section.sourceSection ?? null,
    vertexCount: doc.vertexCount,
    triangleCount: doc.triangleCount,
    drawCount: doc.draws.length,
    drawIndexRange: [drawStartCount, trackDraws.length - 1],
    uv: {
      source: 'level_inspect reference-mesh uv0 (P45-verified)',
      values: manifestSection.uvValues,
      sha256: manifestSection.uvSha256,
      texturedDraws: manifestSection.texturedDraws
    },
    bounds: {
      min: doc.bounds.min.map((value) => Number(value.toFixed(6))),
      max: doc.bounds.max.map((value) => Number(value.toFixed(6)))
    },
    positionsFloat32LESha256: doc.positionsFloat32LESha256 ?? section.positionsSha256,
    indicesUint32LESha256: doc.indicesUint32LESha256 ?? section.indicesSha256,
    usedVertexBuffers: doc.usedVertexBuffers ?? null
  });

  trackVertexBase += doc.vertexCount;
  trackIndexBase += doc.indices.length;
}

const trackMin = [Infinity, Infinity, Infinity];
const trackMax = [-Infinity, -Infinity, -Infinity];
for (let index = 0; index < trackPositions.length; index += 3) {
  for (let axis = 0; axis < 3; axis++) {
    const value = trackPositions[index + axis];
    if (value < trackMin[axis]) trackMin[axis] = value;
    if (value > trackMax[axis]) trackMax[axis] = value;
  }
}

const trackVisualMesh = {
  id: TRACK_VISUAL_ID,
  storage: 'inline-json',
  vertexCount: trackPositions.length / 3,
  indexCount: trackIndices.length,
  positions: trackPositions,
  indices: trackIndices,
  positionsSha256: 'sha256:' + float32Hash(trackPositions),
  indicesSha256: 'sha256:' + uint32Hash(trackIndices),
  uv: {
    storage: 'base64-float32le',
    components: 2,
    vertexCount: textureManifest.uvStream.vertexCount,
    values: trackUvs.length,
    bytes: uvBuffer.length,
    sha256: textureManifest.uvStream.sha256,
    data: uvBuffer.toString('base64'),
    source: {
      manifest: path.relative(ROOT, TRACK_TEXTURE_MANIFEST).split(path.sep).join('/'),
      manifestSha256: sha256(textureManifestBytes),
      stream: textureManifest.uvStream.path,
      provenance: 'level_inspect reference-mesh uv0; P45 compared every draw against the engine UV0 stream bit-exactly',
      aggregate: textureManifest.pins.uvAggregate
    }
  },
  coordinateSpace: 'world',
  source: {
    tool: 'level_inspect (committed direct-draw references)',
    trackVisual: 'asset-reader-direct-draws',
    sections: trackSectionRecords,
    note:
      'real River levelrender direct draws, concatenated without transform or clipping; ' +
      'the per-draw source index ranges are preserved; each draw carries the real UV0 stream and, where ' +
      'P44/P45/P47 measured a static albedo binding, its texture id; the rest of the material is diagnostic'
  }
};

const trackVisual = {
  label: 'asset-reader-direct-draws',
  meshId: TRACK_VISUAL_ID,
  draws: trackDraws,
  sections: trackSectionRecords,
  vertexCount: trackVisualMesh.vertexCount,
  triangleCount: trackVisualMesh.indexCount / 3,
  drawCount: trackDraws.length,
  texturedDrawCount: trackDraws.filter((draw) => draw.textureId !== null).length,
  bounds: {
    min: trackMin.map((value) => Number(value.toFixed(6))),
    max: trackMax.map((value) => Number(value.toFixed(6)))
  },
  note:
    'drawn instead of the diagnostic collision slab; the six measured corridor sections of the 539.81 m course ' +
    'are merged with the instructed block88/node283 section, each at its source world position with its own ' +
    'draw ranges; block88/node283 lies three kilometres from the course and cannot cover it'
};

// Collision triangles that have no committed real render geometry above them are
// kept as an explicitly labelled physics fallback. The test is data-derived: a
// collision triangle is "covered" when its centroid lies inside a committed
// corridor triangle in XZ and the collision height is within 1.0 m of that
// triangle's height (the spawn road matches to 0.0006 m). The covered part is not
// drawn (the real road is there); the rest is the part of the old drive box with no
// committed real draw. No triangle is moved or invented.
const COVER_Y_TOLERANCE = 1.0;
const corridorSections = trackSections.filter((section) => section.courseOverlap);
if (corridorSections.length !== 6) {
  throw new Error('expected six measured corridor sections, got ' + corridorSections.length);
}

// The corridor triangles are bucketed in XZ so the coverage test does not scan
// 47,790 triangles for every collision triangle. Deterministic: insertion order.
const ROAD_BUCKET_METRES = 4;
const roadBuckets = new Map();
for (const section of corridorSections) {
  const positions = section.doc.positions;
  const indices = section.doc.indices;
  for (const draw of section.doc.draws) {
    for (let offset = draw.firstIndex; offset < draw.firstIndex + draw.indexCount; offset += 3) {
      const triangle = [indices[offset], indices[offset + 1], indices[offset + 2]].map((vertex) => [
        positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]
      ]);
      const firstX = Math.floor(Math.min(triangle[0][0], triangle[1][0], triangle[2][0]) / ROAD_BUCKET_METRES);
      const lastX = Math.floor(Math.max(triangle[0][0], triangle[1][0], triangle[2][0]) / ROAD_BUCKET_METRES);
      const firstZ = Math.floor(Math.min(triangle[0][2], triangle[1][2], triangle[2][2]) / ROAD_BUCKET_METRES);
      const lastZ = Math.floor(Math.max(triangle[0][2], triangle[1][2], triangle[2][2]) / ROAD_BUCKET_METRES);
      for (let bucketX = firstX; bucketX <= lastX; bucketX++) {
        for (let bucketZ = firstZ; bucketZ <= lastZ; bucketZ++) {
          const key = bucketX + ':' + bucketZ;
          let list = roadBuckets.get(key);
          if (!list) { list = []; roadBuckets.set(key, list); }
          list.push(triangle);
        }
      }
    }
  }
}

function roadHeightAt(px, pz) {
  const list = roadBuckets.get(Math.floor(px / ROAD_BUCKET_METRES) + ':' + Math.floor(pz / ROAD_BUCKET_METRES));
  if (!list) return null;
  let best = null;
  for (const [a, b, c] of list) {
    const ax = a[0], ay = a[1], az = a[2];
    const bx = b[0], by = b[1], bz = b[2];
    const cx = c[0], cy = c[1], cz = c[2];
    const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(den) < 1e-12) continue;
    const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den;
    const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    const y = l1 * ay + l2 * by + l3 * cy;
    if (best === null || y > best) best = y;
  }
  return best;
}

let coveredTriangles = 0;
let fallbackTriangles = 0;
for (let triangle = 0; triangle < track.indices.length; triangle += 3) {
  const a = track.indices[triangle];
  const b = track.indices[triangle + 1];
  const c = track.indices[triangle + 2];
  const vertices = [a, b, c];
  let cx = 0, cy = 0, cz = 0;
  for (const vertex of vertices) {
    cx += track.positions[vertex * 3];
    cy += track.positions[vertex * 3 + 1];
    cz += track.positions[vertex * 3 + 2];
  }
  cx /= 3; cy /= 3; cz /= 3;
  const road = roadHeightAt(cx, cz);
  if (road !== null && Math.abs(cy - road) <= COVER_Y_TOLERANCE) {
    coveredTriangles++;
    continue;
  }
  fallbackTriangles++;
}
const collisionCoverage = {
  rule: 'a collision triangle is covered when its centroid is inside a real measured-corridor triangle in XZ and ' +
    'its y is within ' + COVER_Y_TOLERANCE + ' m of that triangle',
  reference: TRACK_COVERAGE_VISUAL.path,
  referenceSha256: TRACK_COVERAGE_VISUAL.sha256,
  corridorSections: corridorSections.map((section) => section.key),
  coveredTriangles,
  fallbackTriangles,
  reason:
    'measured coverage only: the covered collision triangles are not drawn because the real track visual sits ' +
    'there; the uncovered triangles are the part of the old drive box with no committed real draw and are also not ' +
    'drawn (the collision surface is physics-only in this slice)'
};

// The collision surface stays in the packet as explicit physics provenance, but
// it is not a render draw: the wheels still trace Level.levelphysics, and no
// collision triangle is re-derived or moved. `visible:false` is carried by both
// the surface record and its draw when a consumer chooses to inspect it.
const collisionMesh = {
  id: track.id,
  storage: 'inline-json',
  vertexCount: track.vertexCount,
  indexCount: track.indexCount,
  positions: track.positions,
  indices: track.indices,
  positionsSha256: track.positionsSha256,
  indicesSha256: track.indicesSha256,
  coordinateSpace: track.coordinateSpace,
  source: track.source
};

const collisionDraw = {
  id: 'river.collision.surface',
  meshId: track.id,
  vertexOffset: 0,
  vertexCount: track.vertexCount,
  indexOffset: 0,
  indexCount: track.indexCount,
  materialId: null,
  materialReason:
    'River collision geometry has no material binding in this slice. It is the surface the wheels trace ' +
    '(Level.levelphysics), kept as physics provenance and NOT drawn (visible:false)',
  layer: 'opaque',
  visible: false,
  physicsOnly: true,
  bounds: track.bounds,
  worldKind: 'baked-into-mesh',
  source: {
    tool: 'probes/e1-drive/tools/extract_track.py',
    levelSha256: track.source.sha256,
    selection: track.source.selection,
    note: track.source.note
  }
};

const collisionSurface = {
  id: 'river.collision.surface',
  meshId: track.id,
  visible: false,
  physicsOnly: true,
  vertexCount: track.vertexCount,
  triangleCount: track.indexCount / 3,
  coverage: collisionCoverage,
  draw: collisionDraw,
  mesh: collisionMesh,
  bounds: track.bounds,
  source: track.source,
  reason:
    'the simulated wheels trace usa_la_river/Level.levelphysics through the wasm physics; this collision ' +
    'mesh is kept in the packet for provenance, is not in packet.meshes and is not uploaded or drawn'
};

const defaultSlug = roster.default;
if (!bodies[defaultSlug]) throw new Error('roster default car has no body: ' + defaultSlug);

const geometry = {
  kind: 'e1-drive.geometry',
  // The level-prop pack is additive to the v6 document: keeping the version
  // keeps every committed layout/ghost pin (which include `geometryVersion`)
  // valid for the unchanged sprint geometry. The P73b pack is validated by its
  // own manifest pin and checks, not by a version bump.
  version: 6,
  source: {
    packet: path.relative(ROOT, SOURCE).split(path.sep).join('/'),
    packetVersion: packet.version,
    packetHash: packet.hash,
    packetSha256: sha256(sourceBytes),
    generator: packet.generator,
    cars: {
      index: path.relative(ROOT, CAR_INDEX).split(path.sep).join('/'),
      indexSha256: carIndexSha256,
      mappingRule: carIndex.mappingRule,
      pak: carIndex.pak,
      roster: carIndex.roster,
      textures: {
        manifest: path.relative(ROOT, CAR_TEXTURE_MANIFEST).split(path.sep).join('/'),
        manifestSha256: carTextureSha,
        p52RosterIndex: carTextureDoc.pins.p52RosterIndex,
        drawClasses: carTextureDoc.coverage.drawClasses,
        textures: carTextureDoc.totals.textures,
        rgbaBytes: carTextureDoc.totals.rgbaBytes,
        uvBytes: carTextureDoc.totals.uvBytes,
        sampler: carTextureDoc.sampler,
        uvConvention: carTextureDoc.uvConvention,
        scopeLabels: carTextureDoc.scopeLabels,
      },
      note:
        'one real body/wheel mesh per roster car from its own root.pak .model; every manifest and mesh ' +
        'is pinned by SHA-256 above and its draw ranges are re-derived from the mesh before use. The ' +
        'per-draw material resolution and decoded albedo images are P52 data, the UV0 stream is the ' +
        'committed scene_inspect mesh stream the part mesh was built from',
    },
    track: {
      trackVisual: 'asset-reader-direct-draws',
      corridor: {
        rule: 'the six measured sections of the 539.81 m usa_la_river corridor ' +
          '(docs/work/analysis/track-coverage.md §4.3), merged verbatim at their source world positions',
        lengthMetres: 539.808,
        source: {
          levelInspector: 'level_inspect direct draws',
          trackCoverageMap: TRACK_COVERAGE_VISUAL.path,
          trackCoverageMapSha256: TRACK_COVERAGE_VISUAL.sha256,
          note: 'block56/node289 comes from its pinned level_inspect reference; the other five sections come ' +
            'from the pinned 46-section track-coverage draw map, and their positions/indices hashes are ' +
            'checked against the track-coverage record before use'
        },
        sections: trackSectionRecords.filter((section) => section.courseOverlap).map((section) => ({
          key: section.key,
          metres: section.courseMetres,
          draws: section.drawCount,
          triangles: section.triangleCount,
          vertices: section.vertexCount
        })),
        drawCount: corridorSections.reduce((sum, section) => sum + section.doc.draws.length, 0),
        triangleCount: corridorSections.reduce((sum, section) => sum + section.doc.triangleCount, 0),
        vertexCount: corridorSections.reduce((sum, section) => sum + section.doc.vertexCount, 0)
      },
      visual: {
        meshId: TRACK_VISUAL_ID,
        bytes: trackVisualMesh.vertexCount * 12 + trackVisualMesh.indexCount * 4,
        vertices: trackVisualMesh.vertexCount,
        triangles: trackVisualMesh.indexCount / 3,
        draws: trackDraws.length,
        bounds: trackVisual.bounds,
        uv: {
          bytes: trackVisualMesh.uv.bytes,
          vertexCount: trackVisualMesh.uv.vertexCount,
          sha256: trackVisualMesh.uv.sha256,
          aggregate: textureManifest.pins.uvAggregate
        },
        textures: {
          manifest: path.relative(ROOT, TRACK_TEXTURE_MANIFEST).split(path.sep).join('/'),
          manifestSha256: sha256(textureManifestBytes),
          count: textureRecords.length,
          rgbaBytes: textureRecords.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
          texturedDraws: trackVisual.texturedDrawCount,
          fallbackRuntimeOnly: textureManifest.coverage.fallbackRuntimeOnly,
          fallbackNoBindingRow: textureManifest.coverage.fallbackNoBindingRow,
          sampler: textureManifest.sampler
        },
        sections: trackSectionRecords
      },
      collision: {
        path: path.relative(ROOT, TRACK).split(path.sep).join('/'),
        bytes: readFileSync(TRACK).length,
        sha256: sha256(readFileSync(TRACK)),
        vertices: track.vertexCount,
        triangles: track.indexCount / 3,
        bounds: track.bounds,
        visible: false,
        physicsOnly: true,
        coverage: collisionCoverage,
        note: track.source.note
      }
    },
    levelProps: {
      meshId: levelMesh.id,
      vertexCount: levelMesh.vertexCount,
      triangleCount: levelMesh.indexCount / 3,
      draws: levelDraws.length,
      uv: {
        path: levelPropDoc.uvStream.path,
        sha256: levelPropDoc.uvStream.sha256,
        values: levelPropDoc.uvStream.values,
        bytes: levelPropDoc.uvStream.bytes,
        aggregate: levelPropDoc.uvStream.aggregate,
        declaration: levelPropDoc.uvStream.declaration,
      },
      textures: {
        manifest: path.relative(ROOT, LEVEL_PROP_TEXTURE_MANIFEST).split(path.sep).join('/'),
        manifestSha256: levelPropManifestSha,
        contentHash: levelPropDoc.contentHash,
        count: levelPropTextures.length,
        rgbaBytes: levelPropTextures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
        texturedDraws: levelBindable.length,
        texturedTriangles: levelBindable.reduce((sum, entry) => sum + entry.binding.triangleCount, 0),
        diagnosticDraws: levelBlocked.length,
        diagnosticTriangles: levelBlocked.reduce((sum, entry) => sum + entry.binding.triangleCount, 0),
        blockedInstances: levelBlocked.map((entry) => entry.binding.instanceIndex),
        blockedReason: 'bc3-alpha-rule-missing',
        sampler: levelPropDoc.sampler,
      },
      note:
        'P73a asset-reader UV0 + static g_tAlbedo identity; the four BC1 images are decoded by the ' +
        'committed BC reader and the four BC3-alpha cab draws stay diagnostic (bc3-alpha-rule-missing)',
    },
    note:
      'static geometry copied verbatim from the committed render-packet spike; ' +
      'level draws are world-space (instances baked by the reader), car draws are object-local; ' +
      'level prop draws sample the P73a instance UV0 stream and a decoded BC1 static g_tAlbedo image on 18 ' +
      'of 22 draws, while the 4 BC3-alpha cab draws keep the labelled neutral diagnostic albedo; ' +
      'track draws are the real River levelrender direct draws from the committed level_inspect references, ' +
      'with the real UV0 stream and the P44/P45/P47 static albedo texture where one was measured; ' +
      'car draws keep their committed part manifest ranges and sample the P52 static albedo image with the ' +
      'committed scene-report UV0 stream where P52 resolved one, and stay diagnostic otherwise; ' +
      'part ids, wheel groups and rest-pose transforms are copied from each car\'s committed part manifest; ' +
      'the collision surface comes from the level physics file through the collision-oracle reference parser ' +
      'and is kept as hidden physics provenance, not drawn'
  },
  light: packet.lights[0],
  materials: packet.materials,
  meshes: [meshEntry({ ...levelMesh, uv: levelPropUv, source: levelMesh.source }), trackVisualMesh],
  levelDraws: levelDraws.map((draw, index) => levelDrawEntry(draw, levelBindings[index])),
  levelTextures: levelPropTextures,
  levelPropTexturePack: {
    kind: levelPropDoc.kind,
    version: levelPropDoc.version,
    manifest: path.relative(ROOT, LEVEL_PROP_TEXTURE_MANIFEST).split(path.sep).join('/'),
    manifestSha256: levelPropManifestSha,
    contentHash: levelPropDoc.contentHash,
    scope: levelPropDoc.scope,
    sampler: levelPropDoc.sampler,
    coverage: levelPropDoc.coverage,
    uvStream: {
      path: levelPropDoc.uvStream.path,
      sha256: levelPropDoc.uvStream.sha256,
      values: levelPropDoc.uvStream.values,
      vertexCount: levelPropDoc.uvStream.vertexCount,
      bytes: levelPropDoc.uvStream.bytes,
      aggregate: levelPropDoc.uvStream.aggregate,
      declaration: levelPropDoc.uvStream.declaration,
    },
    materialScope:
      'static g_tAlbedo texture pixels only: the engine material colour, blend state, alpha rule, ' +
      'shader stages, mip chain and sRGB interpretation are not applied, so this is not retail ' +
      'material fidelity',
    note:
      'pixels are the committed BC1 decode of the P34 blobs, mapped by the P73a instance UV0 stream; ' +
      'wrap/filter/mip are the explicit PoC sampler, not recovered engine state; the 4 BC3-alpha ' +
      'cab draws are not bound',
  },
  trackVisual,
  textures: textureRecords,
  carTextures: {
    kind: carTextureDoc.kind,
    version: carTextureDoc.version,
    manifest: path.relative(ROOT, CAR_TEXTURE_MANIFEST).split(path.sep).join('/'),
    manifestSha256: carTextureSha,
    p52RosterIndex: carTextureDoc.pins.p52RosterIndex,
    carPartsIndex: carTextureDoc.pins.carPartsIndex,
    sampler: carTextureDoc.sampler,
    uvConvention: carTextureDoc.uvConvention,
    scopeLabels: carTextureDoc.scopeLabels,
    totals: carTextureDoc.totals,
    coverage: carTextureDoc.coverage,
    note:
      'per-car P52 material resolution and decoded static albedo images. Each packet carries the static ' +
      'level/track pack plus only the driven car\'s own textures, so the upload stays bounded by one car',
  },
  texturePack: {
    kind: textureManifest.kind,
    version: textureManifest.version,
    manifest: path.relative(ROOT, TRACK_TEXTURE_MANIFEST).split(path.sep).join('/'),
    manifestSha256: sha256(textureManifestBytes),
    sampler: textureManifest.sampler,
    coverage: textureManifest.coverage,
    uvStream: {
      storage: textureManifest.uvStream.storage,
      path: textureManifest.uvStream.path,
      sha256: textureManifest.uvStream.sha256,
      values: textureManifest.uvStream.values,
      vertexCount: textureManifest.uvStream.vertexCount,
      bytes: textureManifest.uvStream.bytes
    },
    materialScope:
      'static g_tAlbedo texture pixels only: the engine material colour, blend state, shader stages, mip chain ' +
      'and sRGB interpretation are not applied, so this is not retail material fidelity',
    note:
      'pixels are the committed BC1 decode of the P34/P47 blobs, mapped by the real P45 UV0 stream; ' +
      'wrap/filter/mip are the explicit PoC sampler in texturePack.sampler, not recovered engine state'
  },
  collisionSurface,
  carBodies: bodies,
  defaultCar: defaultSlug,
  fallbackBodies,
  fallbackBodyCount: fallbackBodies.length,
  roster: {
    path: path.relative(ROOT, ROSTER).split(path.sep).join('/'),
    sha256: sha256(rosterBytes),
    cars: roster.cars.map((car) => ({ slug: car.slug, name: car.name, drivetrain: car.drivetrain }))
  },
  cameraIntrinsics: {
    verticalFovRadians: packet.camera.verticalFovRadians,
    near: packet.camera.near,
    far: packet.camera.far,
    aspect: packet.camera.aspect,
    up: packet.camera.up
  },
  levelInstances: {
    emitted: packet.diagnostics.instancesEmitted,
    omitted: packet.diagnostics.instancesOmitted,
    culled: packet.diagnostics.culled
  }
};

mkdirSync(path.dirname(OUT), { recursive: true });
mkdirSync(CARS_OUT, { recursive: true });

// The combined document is the pre-chunking artifact and stays byte-identical so
// every committed layout, ghost and MP pin (which hash it) remains valid. It is
// a debug/verification artifact only; the page fetches the chunks below.
const text = JSON.stringify(geometry);
writeFileSync(OUT, text, 'utf8');

// ---------------------------------------------------------------- level chunk
const levelDoc = {
  ...geometry,
  carBodies: {},
  fallbackBodies: [],
  fallbackBodyCount: 0,
  chunk: {
    kind: 'level',
    version: 1,
    role: 'always loaded: collision provenance, track visual, level props, materials/light/camera',
    carBodies: 0,
    carChunkPattern: 'cars/<slug>.geometry.json',
    index: 'car-bodies.index.json',
    note: 'the selected car body is merged from its own chunk; the packet schema is unchanged'
  }
};
const levelText = JSON.stringify(levelDoc);
writeFileSync(LEVEL_OUT, levelText, 'utf8');
const levelSha = sha256(Buffer.from(levelText, 'utf8'));
const levelBytes = Buffer.byteLength(levelText, 'utf8');

// ------------------------------------------------------------- base (map mode)
// Map packages replace the River level half, so they only need the car body,
// materials, light, camera intrinsics and roster metadata. This keeps the map
// load path on the same chunk policy instead of re-fetching the full level.
const baseDoc = {
  kind: geometry.kind,
  version: geometry.version,
  source: {
    note: 'map-mode base document: materials, light, camera intrinsics, roster and car-texture metadata; ' +
      'the level is the selected map package and the body is the selected car chunk',
    packet: geometry.source.packet,
    packetVersion: geometry.source.packetVersion,
    packetHash: geometry.source.packetHash,
    packetSha256: geometry.source.packetSha256,
    cars: geometry.source.cars
  },
  chunk: {
    kind: 'base',
    version: 1,
    role: 'map-package geometry base; the map package supplies meshes/draws/textures/collision',
    carChunkPattern: 'cars/<slug>.geometry.json',
    index: 'car-bodies.index.json'
  },
  light: geometry.light,
  materials: geometry.materials,
  cameraIntrinsics: geometry.cameraIntrinsics,
  roster: geometry.roster,
  defaultCar: geometry.defaultCar,
  carTextures: geometry.carTextures,
  carBodies: {},
  fallbackBodies: [],
  fallbackBodyCount: 0,
  levelInstances: geometry.levelInstances
};
const baseText = JSON.stringify(baseDoc);
writeFileSync(BASE_OUT, baseText, 'utf8');
const baseSha = sha256(Buffer.from(baseText, 'utf8'));
const baseBytes = Buffer.byteLength(baseText, 'utf8');

// ---------------------------------------------------------------- car chunks
const indexCars = {};
const summaryBodies = [];
for (const body of Object.values(bodies)) {
  const carDoc = {
    kind: 'e1-drive.car-chunk',
    version: 1,
    geometryVersion: geometry.version,
    slug: body.slug,
    name: body.name,
    chunk: {
      kind: 'car',
      version: 1,
      slug: body.slug,
      level: 'level.geometry.json',
      levelSha256: levelSha,
      index: 'car-bodies.index.json',
      note: 'one roster car body/wheels/parts; merged into the level document by packet-adapter consumers'
    },
    ...body
  };
  const carText = JSON.stringify(carDoc);
  const file = 'cars/' + body.slug + '.geometry.json';
  writeFileSync(path.join(CARS_OUT, body.slug + '.geometry.json'), carText, 'utf8');
  const bytes = Buffer.byteLength(carText, 'utf8');
  indexCars[body.slug] = {
    file,
    sha256: sha256(Buffer.from(carText, 'utf8')),
    bytes,
    geometryVersion: geometry.version,
    meshId: body.meshId,
    vertices: body.mesh.vertexCount,
    triangles: body.mesh.indexCount / 3,
    positionsSha256: body.manifest.meshValueHashes.positionsFloat32LESha256,
    indicesSha256: body.manifest.meshValueHashes.indicesUint32LESha256,
    draws: body.carDraws.length,
    parts: body.carParts.length,
    nodes: body.carNodes.length,
    wheelGroups: body.wheelGroups.length,
    texturedDraws: body.carDraws.filter((draw) => draw.textureId !== null).length,
    textures: body.textures.length,
    rgbaBytes: body.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
    uv: body.mesh.uv
      ? {
          bytes: body.mesh.uv.bytes,
          values: body.mesh.uv.values,
          vertexCount: body.mesh.uv.vertexCount,
          sha256: body.mesh.uv.sha256
        }
      : null,
    manifestSha256: body.manifest.sha256,
    sourceModelPakPath: body.manifest.sourceModelPakPath,
    sourceModelSha256: body.manifest.sourceModelSha256,
    fallback: body.manifest.fallback === true
  };
  summaryBodies.push({
    slug: body.slug,
    file,
    bytes,
    sha256: indexCars[body.slug].sha256,
    draws: body.carDraws.length,
    texturedDraws: indexCars[body.slug].texturedDraws,
    textures: body.textures.length,
    textureBytes: indexCars[body.slug].rgbaBytes,
    uvBytes: body.mesh.uv?.bytes ?? 0
  });
}

const indexDoc = {
  kind: 'e1-drive.car-bodies-index',
  version: 1,
  generator: 'probes/e1-drive/tools/build_geometry.mjs',
  geometryVersion: geometry.version,
  policy: {
    levelChunksLoaded: 1,
    carChunksResident: 2,
    carChunks: 'the selected car is loaded on demand and cached; MP loads the remote car once',
    missingChunk: 'typed load error; never substitute another car body',
    streaming: 'none in this pass: one level + one/two cars resident'
  },
  level: {
    file: 'level.geometry.json',
    sha256: levelSha,
    bytes: levelBytes,
    meshes: levelDoc.meshes.length,
    levelDraws: levelDoc.levelDraws.length,
    trackDraws: levelDoc.trackVisual.draws.length,
    textures: levelDoc.textures.length + levelDoc.levelTextures.length,
    rgbaBytes:
      levelDoc.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0) +
      levelDoc.levelTextures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
    uvBytes:
      (levelDoc.meshes[0]?.uv?.bytes ?? 0) +
      (levelDoc.meshes.find((mesh) => mesh.id === levelDoc.trackVisual.meshId)?.uv?.bytes ?? 0)
  },
  base: {
    file: 'base.geometry.json',
    sha256: baseSha,
    bytes: baseBytes,
    role: 'map-package base (materials/light/camera/roster); never fetched for the River map'
  },
  debug: {
    file: 'geometry.json',
    sha256: sha256(Buffer.from(text, 'utf8')),
    bytes: Buffer.byteLength(text, 'utf8'),
    role: 'combined pre-chunking artifact, kept for the committed layout/ghost/MP pins and verification; not fetched by the page'
  },
  packet: {
    emitted: false,
    policy: 'composed by web/packet-adapter.js from the level chunk + one car chunk',
    note: 'no packet/level.json is shipped: the chase camera, occluder and per-tick updates are built at runtime, ' +
      'and the packet schema/hash must stay identical to the single-file producer'
  },
  roster: {
    path: path.relative(ROOT, ROSTER).split(path.sep).join('/'),
    sha256: sha256(rosterBytes),
    cars: roster.cars.map((car) => ({ slug: car.slug, name: car.name, drivetrain: car.drivetrain }))
  },
  defaultCar: defaultSlug,
  cars: indexCars
};
const indexText = JSON.stringify(indexDoc);
writeFileSync(INDEX_OUT, indexText, 'utf8');

console.log(JSON.stringify({
  output: path.relative(ROOT, OUT).split(path.sep).join('/'),
  bytes: Buffer.byteLength(text, 'utf8'),
  sha256: sha256(Buffer.from(text, 'utf8')),
  chunks: {
    index: {
      file: path.relative(ROOT, INDEX_OUT).split(path.sep).join('/'),
      bytes: Buffer.byteLength(indexText, 'utf8'),
      sha256: sha256(Buffer.from(indexText, 'utf8'))
    },
    level: { file: path.relative(ROOT, LEVEL_OUT).split(path.sep).join('/'), bytes: levelBytes, sha256: levelSha },
    base: { file: path.relative(ROOT, BASE_OUT).split(path.sep).join('/'), bytes: baseBytes, sha256: baseSha },
    cars: summaryBodies
  },
  levelDraws: geometry.levelDraws.length,
  levelVertices: levelMesh.vertexCount,
  levelTriangles: levelMesh.indexCount / 3,
  levelProps: {
    manifest: path.relative(ROOT, LEVEL_PROP_TEXTURE_MANIFEST).split(path.sep).join('/'),
    manifestSha256: levelPropManifestSha,
    contentHash: levelPropDoc.contentHash,
    texturedDraws: levelBindable.length,
    texturedTriangles: levelBindable.reduce((sum, entry) => sum + entry.binding.triangleCount, 0),
    diagnosticDraws: levelBlocked.length,
    diagnosticTriangles: levelBlocked.reduce((sum, entry) => sum + entry.binding.triangleCount, 0),
    blockedInstances: levelBlocked.map((entry) => entry.binding.instanceIndex),
    blockedReason: 'bc3-alpha-rule-missing',
    textures: levelPropTextures.length,
    textureBytes: levelPropTextures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
    uv: {
      values: levelPropUv.values,
      bytes: levelPropUv.bytes,
      sha256: levelPropUv.sha256,
      aggregate: levelPropUv.source.aggregate,
    },
  },
  trackVisual: {
    label: trackVisual.label,
    meshId: TRACK_VISUAL_ID,
    vertices: trackVisualMesh.vertexCount,
    triangles: trackVisualMesh.indexCount / 3,
    draws: trackDraws.length,
    texturedDraws: trackVisual.texturedDrawCount,
    textures: textureRecords.length,
    textureBytes: textureRecords.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
    uv: {
      values: trackVisualMesh.uv.values,
      bytes: trackVisualMesh.uv.bytes,
      sha256: trackVisualMesh.uv.sha256
    },
    bounds: trackVisual.bounds,
    corridor: geometry.source.track.corridor,
    sections: trackSectionRecords.map((section) => ({
      key: section.key,
      sourceKind: section.sourceKind,
      vertices: section.vertexCount,
      triangles: section.triangleCount,
      draws: section.drawCount,
      courseOverlap: section.courseOverlap,
      courseMetres: section.courseMetres,
      driveBoxOverlap: section.driveBoxOverlap,
      referenceSha256: section.referenceSha256
    }))
  },
  collisionSurface: {
    meshId: track.id,
    vertices: track.vertexCount,
    triangles: track.indexCount / 3,
    visible: false,
    physicsOnly: true,
    coveredTriangles,
    fallbackTriangles
  },
  meshes: geometry.meshes.length,
  carTextures: {
    manifest: path.relative(ROOT, CAR_TEXTURE_MANIFEST).split(path.sep).join('/'),
    manifestSha256: carTextureSha,
    totals: carTextureDoc.totals,
  },
  bodies: Object.values(bodies).map((body) => ({
    slug: body.slug,
    meshId: body.meshId,
    vertices: body.mesh.vertexCount,
    triangles: body.mesh.indexCount / 3,
    draws: body.carDraws.length,
    parts: body.carParts.length,
    nodes: body.carNodes.length,
    wheelGroups: body.wheelGroups.length,
    wheelSpinDraws: body.wheelGroups.reduce((sum, group) => sum + group.spinDraws.length, 0),
    wheelStaticDraws: body.wheelGroups.reduce((sum, group) => sum + group.staticDraws.length, 0),
    texturedDraws: body.carDraws.filter((draw) => draw.textureId !== null).length,
    textures: body.textures.length,
    textureBytes: body.textures.reduce((sum, texture) => sum + texture.rgbaBytes, 0),
    uvBytes: body.mesh.uv?.bytes ?? 0,
    uvValues: body.mesh.uv?.values ?? 0,
    positionsSha256: body.manifest.meshValueHashes.positionsFloat32LESha256,
    manifestSha256: body.manifest.sha256
  })),
  defaultCar: defaultSlug,
  fallbackBodyCount: fallbackBodies.length,
  fallbackBodies,
  source: geometry.source
}, null, 2));


