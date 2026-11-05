// Extract the static half of the render packet for the E1 drive slice.
//
// Input:  _work/render-packet/packet.json — the committed, verified v1.1 spike
//         packet (T-007-render-packet.md): River block27/node253 instances in
//         world space plus the Corvette C3 race body in object space.
//         _work/car-parts/manifest.json — the committed Corvette part manifest
//         (probes/car-parts/tools/build_manifest.py): 29 parts / 80 draws and
//         four wheel groups. Read only; every draw range is cross-checked
//         against the packet's car draws before it is used.
// Output: _work/e1-drive/geometry.json — meshes, the 22 static level draws, the
//         80 car draw ranges (with their local AABBs), the part/wheel metadata
//         and diagnostic colours, the four material identities and the
//         diagnostic light. Nothing is re-derived from the game files here; the
//         packet and the manifest are the sources and their hashes are recorded.
//
// Usage: node probes/e1-drive/tools/build_geometry.mjs

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE = path.join(ROOT, '_work/render-packet/packet.json');
const TRACK = path.join(ROOT, '_work/e1-drive/track.json');
const PARTS = path.join(ROOT, '_work/car-parts/manifest.json');
const OUT = path.join(ROOT, '_work/e1-drive/geometry.json');

if (!existsSync(SOURCE)) {
  throw new Error('missing ' + path.relative(ROOT, SOURCE) +
    ' — run `node probes/render-packet/tools/build_packet.mjs` first');
}
if (!existsSync(TRACK)) {
  throw new Error('missing ' + path.relative(ROOT, TRACK) +
    ' — run `python probes/e1-drive/tools/extract_track.py` first');
}
if (!existsSync(PARTS)) {
  throw new Error('missing ' + path.relative(ROOT, PARTS) +
    ' — run `python probes/car-parts/tools/build_manifest.py` first (the part manifest is an input, not rebuilt here)');
}

const sha256 = (buffer) => 'sha256:' + createHash('sha256').update(buffer).digest('hex');
const sourceBytes = readFileSync(SOURCE);
const packet = JSON.parse(sourceBytes.toString('utf8'));
if (packet.kind !== 'blur.render-packet' || packet.version !== 1.1) {
  throw new Error('source packet is not a v1.1 blur.render-packet');
}

const levelMesh = packet.meshes.find((mesh) => mesh.id === 'river.block27.instances-all');
const carMesh = packet.meshes.find((mesh) => mesh.id === 'corvette.c3.race.body');
if (!levelMesh || !carMesh) throw new Error('source packet is missing the expected meshes');

const levelDraws = packet.draws.filter((draw) => draw.meshId === levelMesh.id);
const carDraws = packet.draws.filter((draw) => draw.meshId === carMesh.id);
if (levelDraws.length !== 22 || carDraws.length !== 80) {
  throw new Error('unexpected draw counts: ' + levelDraws.length + ' level, ' + carDraws.length + ' car');
}

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

const drawEntry = (draw) => ({
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

const track = JSON.parse(readFileSync(TRACK, 'utf8'));

// ---------------------------------------------------------------- part manifest
// The manifest is produced by probes/car-parts (another probe) and is read here
// as an input. It is never rebuilt or edited by this tool. Every draw range is
// matched against the packet's car draws by its index range; a mismatch is a
// hard failure, not a fallback.
const manifestBytes = readFileSync(PARTS);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const manifestSha256 = sha256(manifestBytes);
// The committed Corvette manifest (probes/car-parts README + verification doc).
// A different file is a hard failure: this slice must not silently consume a
// regenerated or hand-edited manifest.
const COMMITTED_MANIFEST_SHA256 =
  'sha256:24aa45f37cce2738b2f6b90bcd043aee736be6db8d7e2e855eb86048f7dbf602';
if (manifestSha256 !== COMMITTED_MANIFEST_SHA256) {
  throw new Error('part manifest is not the committed one: ' + manifestSha256 +
    ' (expected ' + COMMITTED_MANIFEST_SHA256 + ')');
}
if (manifest.kind !== 'blur.car-part-manifest' || manifest.version !== 1) {
  throw new Error('part manifest kind/version is not blur.car-part-manifest v1');
}
const hex = (value) => String(value ?? '').replace(/^sha256:/i, '').toLowerCase();
if (manifest.mesh.vertexCount !== carMesh.vertexCount || manifest.mesh.indexCount !== carMesh.indexCount) {
  throw new Error('part manifest mesh counts (' + manifest.mesh.vertexCount + ' vertices / ' +
    manifest.mesh.indexCount + ' indices) do not match the packet car mesh (' +
    carMesh.vertexCount + ' / ' + carMesh.indexCount + ')');
}
// Hash the mesh values exactly as they are serialized in the packet. We do not
// compare against packet.mesh.positionsSha256: that hash was taken before the
// packet was formatted as JSON, and JSON has no signed zero, so it can differ
// from a hash of the same values after a write/read round trip. The manifest's
// hash is defined over the values, so it is the right reference here.
const positionBuffer = Buffer.alloc(carMesh.positions.length * 4);
carMesh.positions.forEach((value, index) => positionBuffer.writeFloatLE(value, index * 4));
const indexBuffer = Buffer.alloc(carMesh.indices.length * 4);
carMesh.indices.forEach((value, index) => indexBuffer.writeUInt32LE(value, index * 4));
const packetPositionValueSha256 = sha256(positionBuffer);
const packetIndexValueSha256 = sha256(indexBuffer);
if (hex(manifest.mesh.positionsFloat32LESha256) !== hex(packetPositionValueSha256) ||
    hex(manifest.mesh.indicesUint32LESha256) !== hex(packetIndexValueSha256)) {
  throw new Error('part manifest mesh hashes do not match the packet car mesh values (' +
    packetPositionValueSha256 + ' / ' + packetIndexValueSha256 + ')');
}
if (manifest.draws.length !== carDraws.length) {
  throw new Error('part manifest has ' + manifest.draws.length + ' draws, the packet car mesh has ' + carDraws.length);
}
const manifestDrawByRange = new Map();
for (const draw of manifest.draws) {
  const key = draw.firstIndex + ':' + draw.indexCount;
  if (manifestDrawByRange.has(key)) throw new Error('duplicate manifest draw range ' + key);
  manifestDrawByRange.set(key, draw);
}

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
    spinAxis: group.spin.axis,
    axisSpace: group.spin.axisSpace,
    spinMembers: group.spin.spinMembers,
    staticMembers: group.spin.staticMembers,
    spinDraws,
    staticDraws,
    spinEvidence: group.spin.evidence,
    spinSource: group.spin.source
  };
});
if (wheelGroups.length !== 4) throw new Error('part manifest has ' + wheelGroups.length + ' wheel groups, expected 4');
const wheelByCorner = new Map(wheelGroups.map((group) => [group.corner, group]));

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

const carDrawsWithParts = carDraws.map((draw) => {
  const manifestDraw = manifestDrawByRange.get(draw.indexOffset + ':' + draw.indexCount);
  if (!manifestDraw) {
    throw new Error('packet car draw ' + draw.id + ' (' + draw.indexOffset + '+' + draw.indexCount +
      ') has no manifest draw; the manifest and the committed packet disagree');
  }
  const renderPartId = typeof manifestDraw.renderPartId === 'string' ? manifestDraw.renderPartId : null;
  const corner = renderPartId?.startsWith('wheel.') ? renderPartId.slice('wheel.'.length) : null;
  const group = corner ? wheelByCorner.get(corner) : null;
  if (corner && !group) throw new Error('car draw ' + draw.id + ' names unknown wheel corner ' + corner);
  const wheelPart = manifestDraw.evidence?.wheelPart ?? null;
  if (group && !wheelPart) throw new Error('wheel draw ' + draw.id + ' has no wheel member');
  const spins = Boolean(group && group.spinMembers.includes(wheelPart));
  const nodeId = group ? 'e1.car.wheel.' + group.corner + '.' + (spins ? 'spin' : 'static') : 'e1.car.body';
  return {
    ...drawEntry(draw),
    localBounds: localBoundsOf(carMesh, draw.indexOffset, draw.indexCount),
    partId: manifestDraw.partId,
    renderPartId,
    partKind: manifestDraw.partKind,
    partName: manifestDraw.partName,
    wheelPart,
    spins,
    nodeId,
    diagnosticColour: diagnosticColourFor(manifestDraw.partKind, renderPartId ?? manifestDraw.partId, wheelPart, group?.corner),
    colourReason: 'diagnostic per-part colour for visual debugging; not a game material (materialsApplied:false)'
  };
});

const carNodes = [];
const bodyDrawIds = carDrawsWithParts.filter((draw) => draw.nodeId === 'e1.car.body').map((draw) => draw.id);
carNodes.push({
  id: 'e1.car.body',
  meshId: carMesh.id,
  drawIds: bodyDrawIds,
  reason: 'the rigid body: every non-wheel part (body panels, glass, lights, interior) shares the engine chassis transform'
});
for (const group of wheelGroups) {
  const spinIds = carDrawsWithParts.filter((draw) => draw.nodeId === 'e1.car.wheel.' + group.corner + '.spin').map((draw) => draw.id);
  const staticIds = carDrawsWithParts.filter((draw) => draw.nodeId === 'e1.car.wheel.' + group.corner + '.static').map((draw) => draw.id);
  if (spinIds.length) {
    carNodes.push({
      id: 'e1.car.wheel.' + group.corner + '.spin',
      meshId: carMesh.id,
      drawIds: spinIds,
      reason: 'wheel group ' + group.name + ' (tyre/rim/brake disc): shares the wheel rest-pose translation and spins about ' +
        'element-local +X by the physics wheel angular velocity'
    });
  }
  if (staticIds.length) {
    carNodes.push({
      id: 'e1.car.wheel.' + group.corner + '.static',
      meshId: carMesh.id,
      drawIds: staticIds,
      reason: 'wheel group ' + group.name + ' brake caliper: same wheel rest-pose translation, deliberately not spun ' +
        '(VehicleActor.cpp:5198, "Brake calipers mustn\'t rotate")'
    });
  }
}

const carParts = manifest.parts.map((part) => ({
  id: part.id,
  partKind: part.partKind,
  name: part.name,
  draws: part.draws,
  provenDraws: part.provenDraws,
  ambiguousDraws: part.ambiguousDraws,
  spin: part.spin ? { axis: part.spin.axis, axisSpace: part.spin.axisSpace, spinMembers: part.spin.spinMembers, staticMembers: part.spin.staticMembers } : null
}));

const manifestProvenance = {
  path: path.relative(ROOT, PARTS).split(path.sep).join('/'),
  bytes: manifestBytes.length,
  sha256: manifestSha256,
  kind: manifest.kind,
  version: manifest.version,
  parts: manifest.parts.length,
  draws: manifest.draws.length,
  wheelGroups: manifest.wheelGroups.length,
  namedParts: manifest.diagnostics.namedPartCount,
  provenDraws: manifest.diagnostics.provenDrawCount,
  unclassifiedDraws: manifest.diagnostics.unclassifiedDrawCount,
  sourceModelSha256: manifest.source.modelSha256,
  sourceSceneReaderOutputSha256: manifest.source.sceneReaderOutputSha256,
  meshValueHashes: {
    positionsFloat32LESha256: packetPositionValueSha256,
    indicesUint32LESha256: packetIndexValueSha256,
    note: 'hashes of the packet car mesh values after its JSON round trip; they equal manifest.mesh hashes and prove the part draw ranges address the same vertex/index arrays'
  },
  packetDeclaredMeshHashes: {
    positionsSha256: carMesh.positionsSha256,
    indicesSha256: carMesh.indicesSha256,
    note: 'the packet declares these over pre-serialization values; JSON has no signed zero, so positions can differ after a round trip. Indices agree'
  },
  provenanceNote: 'read-only input produced by probes/car-parts/tools/build_manifest.py; this tool only validates and copies its part/draw/wheel records'
};

const trackMesh = {
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

const trackDraw = {
  id: 'river.collision.surface',
  meshId: track.id,
  vertexOffset: 0,
  vertexCount: track.vertexCount,
  indexOffset: 0,
  indexCount: track.indexCount,
  materialId: null,
  materialReason:
    'River collision geometry has no material binding in this slice; drawn with the diagnostic albedo. ' +
    'It is the surface the wheels trace (Level.levelphysics), not retail render geometry',
  layer: 'opaque',
  bounds: track.bounds,
  worldKind: 'baked-into-mesh',
  source: {
    tool: 'probes/e1-drive/tools/extract_track.py',
    levelSha256: track.source.sha256,
    selection: track.source.selection,
    note: track.source.note
  }
};

const geometry = {
  kind: 'e1-drive.geometry',
  version: 2,
  source: {
    packet: path.relative(ROOT, SOURCE).split(path.sep).join('/'),
    packetVersion: packet.version,
    packetHash: packet.hash,
    packetSha256: sha256(sourceBytes),
    generator: packet.generator,
    parts: manifestProvenance,
    track: {
      path: path.relative(ROOT, TRACK).split(path.sep).join('/'),
      bytes: readFileSync(TRACK).length,
      sha256: sha256(readFileSync(TRACK)),
      vertices: track.vertexCount,
      triangles: track.indexCount / 3,
      bounds: track.bounds,
      note: track.source.note
    },
    note:
      'static geometry copied verbatim from the committed render-packet spike; ' +
      'level draws are world-space (instances baked by the reader), car draws are object-local; ' +
      'part ids, wheel groups and rest-pose transforms are copied from the committed car-part manifest; ' +
      'the collision surface comes from the level physics file through the collision-oracle reference parser'
  },
  light: packet.lights[0],
  materials: packet.materials,
  meshes: [meshEntry(levelMesh), meshEntry(carMesh), trackMesh],
  levelDraws: levelDraws.map(drawEntry).concat([trackDraw]),
  manifest: manifestProvenance,
  carParts,
  wheelGroups,
  carNodes,
  carDraws: carDrawsWithParts,
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
  carDraws: geometry.carDraws.length,
  levelVertices: levelMesh.vertexCount,
  levelTriangles: levelMesh.indexCount / 3,
  carVertices: carMesh.vertexCount,
  carTriangles: carMesh.indexCount / 3,
  carParts: geometry.carParts.length,
  wheelGroups: geometry.wheelGroups.length,
  carNodes: geometry.carNodes.length,
  bodyDraws: bodyDrawIds.length,
  wheelSpinDraws: geometry.wheelGroups.reduce((sum, group) => sum + group.spinDraws.length, 0),
  wheelStaticDraws: geometry.wheelGroups.reduce((sum, group) => sum + group.staticDraws.length, 0),
  materials: geometry.materials.length,
  manifest: geometry.manifest,
  source: geometry.source
}, null, 2));
