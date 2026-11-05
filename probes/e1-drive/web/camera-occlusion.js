// Camera occlusion for the E1 drive slice.
//
// The chase camera is a presentation camera, but the static scene it is placed in
// is real: the start-area props (the level mesh) and the River embankment (the
// real track visual) are visible geometry, and a fixed orbit puts the eye inside
// them. This module builds a deterministic triangle BVH from the packet's
// **visible world-space meshes** and answers one question per tick:
//
//   where does the segment from the camera aim point to the desired eye first
//   meet visible geometry?
//
// Only drawn geometry is an occluder. The hidden physics surface
// (`packet.physicsSurfaces`, `visible:false`) and the car body are deliberately
// excluded: pulling the camera for a surface that is not rendered would produce a
// close-up with no visible cause, and the car body sits on the segment itself.
//
// The BVH is built once per geometry object (cached by identity) so the browser
// pays for it once and the node verifier reuses it across every car and run.
// The build is a median split on the widest axis: deterministic, no randomness,
// no wall clock, so the same geometry yields the same tree and the same hits.

const LEAF_SIZE = 8;
const AABB_PADDING = 1e-4;
const HIT_EPSILON = 1e-6;

const OCCLUDER_CACHE = new WeakMap();

/** A display label for one source mesh, used by the diagnostics and evidence. */
function meshLabel(mesh, index) {
  return {
    index,
    id: mesh.id,
    vertexCount: mesh.vertexCount,
    triangleCount: mesh.indexCount / 3,
    coordinateSpace: mesh.coordinateSpace
  };
}

/**
 * Flatten the world-space triangles of every mesh in `geometry.meshes`.
 *
 * The E1 geometry only carries meshes whose positions are already world-space
 * (`coordinateSpace:'world'`, every level/track draw is `baked-into-mesh`). A
 * mesh in any other space would need its draw matrices, so it is a hard error
 * instead of a silent skip: an occluder that quietly ignores geometry would let
 * the camera sit inside it again.
 */
export function collectOccluderTriangles(geometry) {
  if (!geometry || !Array.isArray(geometry.meshes) || geometry.meshes.length === 0) {
    throw new Error('camera occlusion needs geometry.meshes (level + track visual)');
  }
  const sources = [];
  const triangleData = [];
  const triangleMesh = [];
  geometry.meshes.forEach((mesh, meshIndex) => {
    if (mesh.coordinateSpace !== 'world') {
      throw new Error('camera occlusion: mesh ' + mesh.id + " is '" + mesh.coordinateSpace +
        "', not 'world'; a non-world mesh needs its draw matrices and is not supported");
    }
    if (mesh.positions.length !== mesh.vertexCount * 3 ||
        mesh.indices.length !== mesh.indexCount ||
        mesh.indices.length % 3 !== 0) {
      throw new Error('camera occlusion: mesh ' + mesh.id + ' has inconsistent counts');
    }
    for (let index = 0; index < mesh.indices.length; index += 3) {
      const a = mesh.indices[index] * 3;
      const b = mesh.indices[index + 1] * 3;
      const c = mesh.indices[index + 2] * 3;
      triangleData.push(
        mesh.positions[a], mesh.positions[a + 1], mesh.positions[a + 2],
        mesh.positions[b], mesh.positions[b + 1], mesh.positions[b + 2],
        mesh.positions[c], mesh.positions[c + 1], mesh.positions[c + 2]
      );
      triangleMesh.push(meshIndex);
    }
    sources.push(meshLabel(mesh, meshIndex));
  });
  return {
    triangleData: Float64Array.from(triangleData),
    triangleMesh: Int32Array.from(triangleMesh),
    sources
  };
}

function segmentHitsBox(ox, oy, oz, dx, dy, dz, minx, miny, minz, maxx, maxy, maxz, maxT) {
  let tMin = 0;
  let tMax = maxT;
  for (let axis = 0; axis < 3; axis++) {
    const origin = axis === 0 ? ox : axis === 1 ? oy : oz;
    const direction = axis === 0 ? dx : axis === 1 ? dy : dz;
    const low = axis === 0 ? minx : axis === 1 ? miny : minz;
    const high = axis === 0 ? maxx : axis === 1 ? maxy : maxz;
    if (Math.abs(direction) < 1e-12) {
      if (origin < low || origin > high) return false;
      continue;
    }
    let t1 = (low - origin) / direction;
    let t2 = (high - origin) / direction;
    if (t1 > t2) { const swap = t1; t1 = t2; t2 = swap; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return false;
  }
  return true;
}

/**
 * Möller–Trumbore, two-sided. The camera segment has no winding convention: a
 * prop's inside face must block just like its outside face.
 * `direction` is a unit vector, so the returned t is a distance in metres.
 */
function segmentTriangleDistance(ox, oy, oz, dx, dy, dz, data, offset, maxT) {
  const ax = data[offset], ay = data[offset + 1], az = data[offset + 2];
  const e1x = data[offset + 3] - ax, e1y = data[offset + 4] - ay, e1z = data[offset + 5] - az;
  const e2x = data[offset + 6] - ax, e2y = data[offset + 7] - ay, e2z = data[offset + 8] - az;
  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;
  const determinant = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(determinant) < 1e-12) return -1;
  const inverse = 1 / determinant;
  const sx = ox - ax, sy = oy - ay, sz = oz - az;
  const u = (sx * hx + sy * hy + sz * hz) * inverse;
  if (u < -HIT_EPSILON || u > 1 + HIT_EPSILON) return -1;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inverse;
  if (v < -HIT_EPSILON || u + v > 1 + HIT_EPSILON) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inverse;
  if (t <= HIT_EPSILON || t > maxT) return -1;
  return t;
}

export class CameraOccluder {
  constructor(collected) {
    const { triangleData, triangleMesh, sources } = collected;
    const triangleCount = triangleMesh.length;
    if (triangleCount === 0) throw new Error('camera occlusion: geometry has no triangles');
    this.sources = sources;
    this.triangleCount = triangleCount;
    this.triangleData = triangleData;
    this.triangleMesh = triangleMesh;

    const centroids = new Float64Array(triangleCount * 3);
    const triangleBounds = new Float64Array(triangleCount * 6);
    const order = new Int32Array(triangleCount);
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      order[triangle] = triangle;
      const offset = triangle * 9;
      let minx = Infinity, miny = Infinity, minz = Infinity;
      let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
      for (let corner = 0; corner < 3; corner++) {
        const x = triangleData[offset + corner * 3];
        const y = triangleData[offset + corner * 3 + 1];
        const z = triangleData[offset + corner * 3 + 2];
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (z < minz) minz = z;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
        if (z > maxz) maxz = z;
      }
      triangleBounds[triangle * 6] = minx;
      triangleBounds[triangle * 6 + 1] = miny;
      triangleBounds[triangle * 6 + 2] = minz;
      triangleBounds[triangle * 6 + 3] = maxx;
      triangleBounds[triangle * 6 + 4] = maxy;
      triangleBounds[triangle * 6 + 5] = maxz;
      centroids[triangle * 3] = (minx + maxx) / 2;
      centroids[triangle * 3 + 1] = (miny + maxy) / 2;
      centroids[triangle * 3 + 2] = (minz + maxz) / 2;
    }

    const capacity = triangleCount * 2 + 1;
    const nodeBounds = new Float64Array(capacity * 6);
    const nodeLeft = new Int32Array(capacity).fill(-1);
    const nodeRight = new Int32Array(capacity).fill(-1);
    const nodeStart = new Int32Array(capacity);
    const nodeCount = new Int32Array(capacity);
    let used = 0;

    const stack = [{ start: 0, end: triangleCount, node: used++ }];
    while (stack.length) {
      const entry = stack.pop();
      const { start, end, node } = entry;
      let minx = Infinity, miny = Infinity, minz = Infinity;
      let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
      let cxMin = Infinity, cyMin = Infinity, czMin = Infinity;
      let cxMax = -Infinity, cyMax = -Infinity, czMax = -Infinity;
      for (let slot = start; slot < end; slot++) {
        const triangle = order[slot];
        const bounds = triangle * 6;
        if (triangleBounds[bounds] < minx) minx = triangleBounds[bounds];
        if (triangleBounds[bounds + 1] < miny) miny = triangleBounds[bounds + 1];
        if (triangleBounds[bounds + 2] < minz) minz = triangleBounds[bounds + 2];
        if (triangleBounds[bounds + 3] > maxx) maxx = triangleBounds[bounds + 3];
        if (triangleBounds[bounds + 4] > maxy) maxy = triangleBounds[bounds + 4];
        if (triangleBounds[bounds + 5] > maxz) maxz = triangleBounds[bounds + 5];
        const centroid = triangle * 3;
        if (centroids[centroid] < cxMin) cxMin = centroids[centroid];
        if (centroids[centroid + 1] < cyMin) cyMin = centroids[centroid + 1];
        if (centroids[centroid + 2] < czMin) czMin = centroids[centroid + 2];
        if (centroids[centroid] > cxMax) cxMax = centroids[centroid];
        if (centroids[centroid + 1] > cyMax) cyMax = centroids[centroid + 1];
        if (centroids[centroid + 2] > czMax) czMax = centroids[centroid + 2];
      }
      nodeBounds[node * 6] = minx - AABB_PADDING;
      nodeBounds[node * 6 + 1] = miny - AABB_PADDING;
      nodeBounds[node * 6 + 2] = minz - AABB_PADDING;
      nodeBounds[node * 6 + 3] = maxx + AABB_PADDING;
      nodeBounds[node * 6 + 4] = maxy + AABB_PADDING;
      nodeBounds[node * 6 + 5] = maxz + AABB_PADDING;

      const count = end - start;
      const extentX = cxMax - cxMin;
      const extentY = cyMax - cyMin;
      const extentZ = czMax - czMin;
      const widest = Math.max(extentX, extentY, extentZ);
      if (count <= LEAF_SIZE || !(widest > 0)) {
        nodeStart[node] = start;
        nodeCount[node] = count;
        continue;
      }
      const axis = widest === extentX ? 0 : widest === extentY ? 1 : 2;
      const slice = order.subarray(start, end);
      Array.prototype.sort.call(slice, (a, b) => centroids[a * 3 + axis] - centroids[b * 3 + axis]);
      const middle = start + (count >> 1);
      const left = used++;
      const right = used++;
      nodeLeft[node] = left;
      nodeRight[node] = right;
      stack.push({ start, end: middle, node: left });
      stack.push({ start: middle, end, node: right });
    }

    this.nodeCount = used;
    this.nodeBounds = nodeBounds;
    this.nodeLeft = nodeLeft;
    this.nodeRight = nodeRight;
    this.nodeStart = nodeStart;
    this.nodeTriangles = nodeCount;
    this.order = order;
    this.stack = new Int32Array(Math.max(64, used + 8));
  }

  /**
   * First intersection of the segment `origin -> target`. Returns null when the
   * segment is clear, otherwise the hit distance (metres), point and source mesh.
   */
  castSegment(origin, target) {
    const ox = origin[0], oy = origin[1], oz = origin[2];
    let vx = target[0] - ox, vy = target[1] - oy, vz = target[2] - oz;
    const length = Math.hypot(vx, vy, vz);
    if (!(length > 0)) return null;
    vx /= length;
    vy /= length;
    vz /= length;

    let best = length;
    let bestTriangle = -1;
    const stack = this.stack;
    let top = 0;
    stack[top++] = 0;
    while (top > 0) {
      const node = stack[--top];
      const bounds = node * 6;
      const nodeBox = this.nodeBounds;
      const left = this.nodeLeft[node];
      if (left < 0) {
        const start = this.nodeStart[node];
        const end = start + this.nodeTriangles[node];
        for (let slot = start; slot < end; slot++) {
          const triangle = this.order[slot];
          const hit = segmentTriangleDistance(ox, oy, oz, vx, vy, vz, this.triangleData,
            triangle * 9, best);
          if (hit > 0 && hit < best) {
            best = hit;
            bestTriangle = triangle;
          }
        }
        continue;
      }
      const right = this.nodeRight[node];
      const leftHit = segmentHitsBox(ox, oy, oz, vx, vy, vz,
        nodeBox[left * 6], nodeBox[left * 6 + 1], nodeBox[left * 6 + 2],
        nodeBox[left * 6 + 3], nodeBox[left * 6 + 4], nodeBox[left * 6 + 5], best);
      const rightHit = segmentHitsBox(ox, oy, oz, vx, vy, vz,
        nodeBox[right * 6], nodeBox[right * 6 + 1], nodeBox[right * 6 + 2],
        nodeBox[right * 6 + 3], nodeBox[right * 6 + 4], nodeBox[right * 6 + 5], best);
      // Push the farther box first so the nearer one is visited first and can
      // tighten `best` before the farther one is tested.
      const leftDistance = leftHit
        ? Math.hypot((nodeBox[left * 6] + nodeBox[left * 6 + 3]) / 2 - ox,
          (nodeBox[left * 6 + 1] + nodeBox[left * 6 + 4]) / 2 - oy,
          (nodeBox[left * 6 + 2] + nodeBox[left * 6 + 5]) / 2 - oz) : Infinity;
      const rightDistance = rightHit
        ? Math.hypot((nodeBox[right * 6] + nodeBox[right * 6 + 3]) / 2 - ox,
          (nodeBox[right * 6 + 1] + nodeBox[right * 6 + 4]) / 2 - oy,
          (nodeBox[right * 6 + 2] + nodeBox[right * 6 + 5]) / 2 - oz) : Infinity;
      if (leftHit && rightHit) {
        if (leftDistance <= rightDistance) {
          stack[top++] = right;
          stack[top++] = left;
        } else {
          stack[top++] = left;
          stack[top++] = right;
        }
      } else if (leftHit) {
        stack[top++] = left;
      } else if (rightHit) {
        stack[top++] = right;
      }
    }
    if (bestTriangle < 0) return null;
    return {
      distance: best,
      point: [ox + vx * best, oy + vy * best, oz + vz * best],
      triangle: bestTriangle,
      meshIndex: this.triangleMesh[bestTriangle],
      meshId: this.sources[this.triangleMesh[bestTriangle]]?.id ?? null
    };
  }

  /** Packing-friendly description for diagnostics/evidence. */
  describe() {
    return {
      meshes: this.sources.map((source) => ({ ...source })),
      triangles: this.triangleCount,
      nodes: this.nodeCount,
      leafSize: LEAF_SIZE
    };
  }
}

/** Build (or reuse) the occluder for one geometry object. */
export function buildOccluder(geometry) {
  const cached = OCCLUDER_CACHE.get(geometry);
  if (cached) return cached;
  const occluder = new CameraOccluder(collectOccluderTriangles(geometry));
  OCCLUDER_CACHE.set(geometry, occluder);
  return occluder;
}
