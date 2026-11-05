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
//         Read only; every reference and manifest is pinned by SHA-256 and every
//         draw range is validated against its mesh before it is used.
// Output: _work/e1-drive/geometry.json — the level mesh, the real River track
//         visual (committed level_inspect direct draws), one body per roster car
//         (mesh, draws, parts, wheel groups and nodes), and the collision surface
//         kept as hidden physics provenance.
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
  'audi-r8v10-stock': 'sha256:63882c50ca679e79e1f472875094cb59dd87944c0c507960e754c35fcc2a7502'
};
const COMMITTED_CAR_INDEX =
  'sha256:5042e714a309e28e19498a0d35e18fef941c0fac850e87bc0f986117bb9bc315';

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
  positionsSha256: mesh.positionsSha256,
  indicesSha256: mesh.indicesSha256,
  coordinateSpace: mesh.coordinateSpace,
  source: mesh.source
});

const levelDrawEntry = (draw) => ({
  id: draw.id,
  meshId: draw.meshId,
  vertexOffset: draw.vertexOffset,
  vertexCount: draw.vertexCount,
  indexOffset: draw.indexOffset,
  indexCount: draw.indexCount,
  materialId: draw.materialId,
  materialReason: draw.materialReason,
  layer: draw.layer,
  bounds: draw.bounds,
  worldKind: draw.worldKind,
  source: draw.source
});

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

function buildBody(entry, options = {}) {
  const fallback = options.fallback === true;
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
    return {
      id: entry.slug + '.draw.' + manifestDraw.index,
      meshId,
      vertexOffset,
      vertexCount,
      uniqueVertexCount: manifestDraw.uniqueVertexCount,
      indexOffset: manifestDraw.firstIndex,
      indexCount: manifestDraw.indexCount,
      materialId: null,
      materialReason:
        'no material is bound in this slice: the draw keeps the manifest albedoTexture id ' +
        (manifestDraw.albedoTexture ?? 'none') + ' and is rendered with a diagnostic per-part colour',
      layer: 'opaque',
      bounds: manifestDraw.bounds,
      worldKind: 'packet-transform',
      source: {
        tool: 'probes/car-parts/tools/build_manifest.py',
        drawIndex: manifestDraw.index,
        indexRange: manifestDraw.indexRange,
        partId: manifestDraw.partId,
        match: manifestDraw.match ?? null,
        unclassifiedReason: manifestDraw.unclassifiedReason ?? null
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
      colourReason: 'diagnostic per-part colour for visual debugging; not a game material (materialsApplied:false)'
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
    const body = buildBody({ ...entry, name: rosterCar.name });
    bodies[body.slug] = body;
  } else {
    const reason = entry?.reason ?? 'not present in the mapping index';
    const body = buildBody({ slug: rosterCar.slug, name: rosterCar.name },
      { fallback: true, reason });
    bodies[body.slug] = body;
    fallbackBodies.push({ slug: rosterCar.slug, reason });
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
const TRACK_VISUAL_ID = 'river.track.visual';
const TRACK_VISUAL_SECTIONS = [
  {
    key: 'river.block88.node283',
    geometryBlock: 88,
    nodeBlock: 283,
    path: '_work/level-candidates/probes/00-usa_la_river-g88-n283/reference.json',
    sha256: 'sha256:e2a830f40af73ddcab928f719212c0bbdc77416b276b83c5a6e05ac48c887b89',
    role: 'instructed direct-draw set; 95 draws / 17,782 vertices / 9,343 triangles',
    driveBoxOverlap: false
  },
  {
    key: 'river.block56.node289',
    geometryBlock: 56,
    nodeBlock: 289,
    path: '_work/level-candidates/probes/08-usa_la_river-g56-n289/reference.json',
    sha256: 'sha256:ac570f64be34a0e0480173c8c31f3784e28200e7a6ddfe14a7bf462a458dccaf',
    role: 'drive-covering direct-draw section (bounds cross the drive box; road y matches the collision probe at the spawn)',
    driveBoxOverlap: true
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

function loadTrackVisualSection(spec) {
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
  return { ...spec, doc, bytes };
}

const trackSections = TRACK_VISUAL_SECTIONS.map(loadTrackVisualSection);
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
  for (const draw of doc.draws) {
    if (!Number.isInteger(draw.firstIndex) || !Number.isInteger(draw.indexCount) ||
        draw.indexCount <= 0 || draw.indexCount % 3 !== 0 ||
        draw.firstIndex < 0 || draw.firstIndex + draw.indexCount > doc.indices.length) {
      throw new Error(section.key + ': draw ' + draw.primitiveIndex + ' has an invalid index range');
    }
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
      materialReason:
        'asset-reader direct draw: the level material list is decoded but not applied by this slice; ' +
        'the draw keeps its source index range and is rendered with the diagnostic albedo (materialsApplied:false)',
      layer: 'opaque',
      bounds: { min: min.map((value) => Number(value.toFixed(6))), max: max.map((value) => Number(value.toFixed(6))) },
      worldKind: 'baked-into-mesh',
      trackVisual: 'asset-reader-direct-draws',
      source: {
        tool: 'level_inspect (committed direct-draw reference)',
        reference: section.path,
        referenceSha256: section.sha256,
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

  trackSectionRecords.push({
    key: section.key,
    geometryBlock: section.geometryBlock,
    nodeBlock: section.nodeBlock,
    role: section.role,
    driveBoxOverlap: section.driveBoxOverlap,
    reference: section.path,
    referenceSha256: section.sha256,
    referenceBytes: section.bytes.length,
    vertexCount: doc.vertexCount,
    triangleCount: doc.triangleCount,
    drawCount: doc.draws.length,
    drawIndexRange: [drawStartCount, trackDraws.length - 1],
    bounds: {
      min: doc.bounds.min.map((value) => Number(value.toFixed(6))),
      max: doc.bounds.max.map((value) => Number(value.toFixed(6)))
    },
    positionsFloat32LESha256: doc.positionsFloat32LESha256,
    indicesUint32LESha256: doc.indicesUint32LESha256,
    usedVertexBuffers: doc.usedVertexBuffers
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
  coordinateSpace: 'world',
  source: {
    tool: 'level_inspect (committed direct-draw references)',
    trackVisual: 'asset-reader-direct-draws',
    sections: trackSectionRecords,
    note:
      'real River levelrender direct draws, concatenated without transform or clipping; ' +
      'the per-draw source index ranges are preserved; materials are diagnostic, no texture is bound'
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
  bounds: {
    min: trackMin.map((value) => Number(value.toFixed(6))),
    max: trackMax.map((value) => Number(value.toFixed(6)))
  },
  note:
    'drawn instead of the diagnostic collision slab; block88/node283 is included verbatim but does not ' +
    'overlap the drive box, block56/node289 is the committed section that does'
};

// Collision triangles that have no committed real render geometry above them are
// kept as an explicitly labelled physics fallback. The test is data-derived: a
// collision triangle is "covered" when its centroid lies inside a committed
// block56/node289 triangle in XZ and the collision height is within 1.0 m of that
// triangle's height (the spawn road matches to 0.0006 m). The covered part is not
// drawn (the real road is there); the rest is drawn only so the drive does not
// fall into a void where no real draw exists. No triangle is moved or invented.
const COVER_Y_TOLERANCE = 1.0;
const g56Section = trackSections.find((section) => section.key === 'river.block56.node289');
if (!g56Section) throw new Error('the drive-covering block56/node289 reference is missing');
const g56Doc = g56Section.doc;
function g56HeightAt(px, pz) {
  let best = null;
  const positions = g56Doc.positions;
  const indices = g56Doc.indices;
  for (const draw of g56Doc.draws) {
    for (let offset = draw.firstIndex; offset < draw.firstIndex + draw.indexCount; offset += 3) {
      const a = indices[offset], b = indices[offset + 1], c = indices[offset + 2];
      const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
      const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
      const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(den) < 1e-12) continue;
      const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den;
      const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const y = l1 * ay + l2 * by + l3 * cy;
      if (best === null || y > best) best = y;
    }
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
  const road = g56HeightAt(cx, cz);
  if (road !== null && Math.abs(cy - road) <= COVER_Y_TOLERANCE) {
    coveredTriangles++;
    continue;
  }
  fallbackTriangles++;
}
const collisionCoverage = {
  rule: 'a collision triangle is covered when its centroid is inside a real block56/node289 triangle in XZ and its y is within ' + COVER_Y_TOLERANCE + ' m of that triangle',
  reference: g56Section.path,
  referenceSha256: g56Section.sha256,
  coveredTriangles,
  fallbackTriangles,
  reason:
    'measured coverage only: the covered collision triangles are not drawn because the real track visual sits ' +
    'there; the uncovered triangles are the part of the drive box with no committed real draw and are also not ' +
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
  version: 4,
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
      note:
        'one real body/wheel mesh per roster car from its own root.pak .model; every manifest and mesh ' +
        'is pinned by SHA-256 above and its draw ranges are re-derived from the mesh before use'
    },
    track: {
      trackVisual: 'asset-reader-direct-draws',
      visual: {
        meshId: TRACK_VISUAL_ID,
        bytes: trackVisualMesh.vertexCount * 12 + trackVisualMesh.indexCount * 4,
        vertices: trackVisualMesh.vertexCount,
        triangles: trackVisualMesh.indexCount / 3,
        draws: trackDraws.length,
        bounds: trackVisual.bounds,
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
    note:
      'static geometry copied verbatim from the committed render-packet spike; ' +
      'level draws are world-space (instances baked by the reader), car draws are object-local; ' +
      'track draws are the real River levelrender direct draws from the committed level_inspect references; ' +
      'part ids, wheel groups and rest-pose transforms are copied from each car\'s committed part manifest; ' +
      'the collision surface comes from the level physics file through the collision-oracle reference parser ' +
      'and is kept as hidden physics provenance, not drawn'
  },
  light: packet.lights[0],
  materials: packet.materials,
  meshes: [meshEntry({ ...levelMesh, source: levelMesh.source }), trackVisualMesh],
  levelDraws: levelDraws.map(levelDrawEntry),
  trackVisual,
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
const text = JSON.stringify(geometry);
writeFileSync(OUT, text, 'utf8');

console.log(JSON.stringify({
  output: path.relative(ROOT, OUT).split(path.sep).join('/'),
  bytes: Buffer.byteLength(text, 'utf8'),
  sha256: sha256(Buffer.from(text, 'utf8')),
  levelDraws: geometry.levelDraws.length,
  levelVertices: levelMesh.vertexCount,
  levelTriangles: levelMesh.indexCount / 3,
  trackVisual: {
    label: trackVisual.label,
    meshId: TRACK_VISUAL_ID,
    vertices: trackVisualMesh.vertexCount,
    triangles: trackVisualMesh.indexCount / 3,
    draws: trackDraws.length,
    bounds: trackVisual.bounds,
    sections: trackSectionRecords.map((section) => ({
      key: section.key,
      vertices: section.vertexCount,
      triangles: section.triangleCount,
      draws: section.drawCount,
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
    positionsSha256: body.manifest.meshValueHashes.positionsFloat32LESha256,
    manifestSha256: body.manifest.sha256
  })),
  defaultCar: defaultSlug,
  fallbackBodyCount: fallbackBodies.length,
  fallbackBodies,
  source: geometry.source
}, null, 2));
