// Extract the static half of the render packet for the E1 drive slice.
//
// Input:  _work/render-packet/packet.json — the committed, verified v1.1 spike
//         packet (T-007-render-packet.md): River block27/node253 instances in
//         world space plus the Corvette C3 race body in object space.
// Output: _work/e1-drive/geometry.json — meshes, the 22 static level draws, the
//         80 car draw ranges (with their local AABBs), the four material
//         identities and the diagnostic light. Nothing is re-derived from the
//         game files here and no colour is invented: every value is copied from
//         the committed packet, and the source hashes are recorded.
//
// Usage: node probes/e1-drive/tools/build_geometry.mjs

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE = path.join(ROOT, '_work/render-packet/packet.json');
const TRACK = path.join(ROOT, '_work/e1-drive/track.json');
const OUT = path.join(ROOT, '_work/e1-drive/geometry.json');

if (!existsSync(SOURCE)) {
  throw new Error('missing ' + path.relative(ROOT, SOURCE) +
    ' — run `node probes/render-packet/tools/build_packet.mjs` first');
}
if (!existsSync(TRACK)) {
  throw new Error('missing ' + path.relative(ROOT, TRACK) +
    ' — run `python probes/e1-drive/tools/extract_track.py` first');
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
  version: 1,
  source: {
    packet: path.relative(ROOT, SOURCE).split(path.sep).join('/'),
    packetVersion: packet.version,
    packetHash: packet.hash,
    packetSha256: sha256(sourceBytes),
    generator: packet.generator,
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
      'the collision surface comes from the level physics file through the collision-oracle reference parser'
  },
  light: packet.lights[0],
  materials: packet.materials,
  meshes: [meshEntry(levelMesh), meshEntry(carMesh), trackMesh],
  levelDraws: levelDraws.map(drawEntry).concat([trackDraw]),
  carDraws: carDraws.map((draw) => ({
    ...drawEntry(draw),
    localBounds: localBoundsOf(carMesh, draw.indexOffset, draw.indexCount)
  })),
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
  materials: geometry.materials.length,
  source: geometry.source
}, null, 2));
