/*
 * geometry.mjs — read-only geometry access for the prop-collision probe.
 *
 * Works on the committed E1 geometry v6 record.  The only transform applied is
 * the one the geometry itself carries:
 *   - level draws are baked into the mesh in world space, and their source
 *     instanceMatrix is a rigid placement recorded by level_inspect;
 *   - track-visual draws are direct draws with identity world.
 *
 * No vertex, triangle, matrix or colour is invented here.
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Index accessor over a geometry mesh record. */
export function meshAccessor(mesh) {
  const { positions, indices, vertexCount, indexCount } = mesh;
  return {
    mesh,
    positions,
    indices,
    vertexCount,
    indexCount,
    vertex(i) {
      return [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
    },
  };
}

/**
 * Vertex-connected triangle components of one draw range.
 * Returns components sorted by triangle count desc, then by lowest vertex index
 * (deterministic). Each component keeps the unique vertex indices so callers can
 * fit a box without re-walking triangles.
 */
export function drawComponents(accessor, draw) {
  const { indices, positions } = accessor;
  const first = draw.indexOffset;
  const triCount = draw.indexCount / 3;
  if (!Number.isInteger(triCount) || triCount <= 0) {
    throw new Error(`draw ${draw.id}: indexCount ${draw.indexCount} is not a triangle list`);
  }
  const parent = new Int32Array(accessor.vertexCount).fill(-1);
  const find = (a) => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) {
      const n = parent[a];
      parent[a] = r;
      a = n;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      if (ra < rb) parent[rb] = ra;
      else parent[ra] = rb;
    }
  };
  const tri = new Int32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const a = indices[first + 3 * t];
    const b = indices[first + 3 * t + 1];
    const c = indices[first + 3 * t + 2];
    tri[3 * t] = a;
    tri[3 * t + 1] = b;
    tri[3 * t + 2] = c;
    for (const v of [a, b, c]) if (parent[v] === -1) parent[v] = v;
    union(a, b);
    union(b, c);
  }
  const groups = new Map();
  for (let t = 0; t < triCount; t++) {
    const root = find(tri[3 * t]);
    let list = groups.get(root);
    if (!list) {
      list = [];
      groups.set(root, list);
    }
    list.push(t);
  }
  const comps = [];
  for (const triList of groups.values()) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const vertexSet = new Set();
    for (const t of triList) {
      for (let k = 0; k < 3; k++) {
        const v = tri[3 * t + k];
        vertexSet.add(v);
        const x = positions[3 * v];
        const y = positions[3 * v + 1];
        const z = positions[3 * v + 2];
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
      }
    }
    // Area-weighted normal census.  The V2 builder uses this to tell a true
    // ground/terrain surface (mostly horizontal or sloped) from a vertical
    // structure whose texture happens to match a terrain pattern.  It is
    // diagnostic metadata only; the V1 manifest ignores it.
    let area = 0;
    let upArea = 0;
    let verticalArea = 0;
    let slopedArea = 0;
    for (const t of triList) {
      const ia = tri[3 * t];
      const ib = tri[3 * t + 1];
      const ic = tri[3 * t + 2];
      const ax = positions[3 * ia], ay = positions[3 * ia + 1], az = positions[3 * ia + 2];
      const bx = positions[3 * ib], by = positions[3 * ib + 1], bz = positions[3 * ib + 2];
      const cx = positions[3 * ic], cy = positions[3 * ic + 1], cz = positions[3 * ic + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (!(len > 1e-12)) continue;
      const a = len / 2;
      const u = Math.abs(ny) / len;
      area += a;
      if (u >= 0.7) upArea += a;
      else if (u <= 0.3) verticalArea += a;
      else slopedArea += a;
    }
    comps.push({
      triangles: triList.length,
      min,
      max,
      vertices: [...vertexSet].sort((a, b) => a - b),
      vertexCount: vertexSet.size,
      firstTriangle: draw.indexOffset / 3 + triList[0],
      area,
      upArea,
      verticalArea,
      slopedArea,
      upRatio: area > 0 ? upArea / area : null,
      verticalRatio: area > 0 ? verticalArea / area : null,
      slopedRatio: area > 0 ? slopedArea / area : null,
    });
  }
  comps.sort((a, b) => {
    if (b.triangles !== a.triangles) return b.triangles - a.triangles;
    return a.vertices[0] - b.vertices[0];
  });
  return comps;
}

/** Collect unique vertex indices and bounds over a draw group. */
export function groupVertices(accessor, draws) {
  const set = new Set();
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const d of draws) {
    const first = d.indexOffset;
    const count = d.indexCount;
    for (let i = 0; i < count; i++) set.add(accessor.indices[first + i]);
  }
  for (const v of set) {
    const x = accessor.positions[3 * v];
    const y = accessor.positions[3 * v + 1];
    const z = accessor.positions[3 * v + 2];
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return { vertices: [...set].sort((a, b) => a - b), min, max };
}

/**
 * Oriented box from a source instance matrix and the world-baked vertices.
 * Column-major 4x4, as recorded by level_inspect.  The axes are normalised but
 * not re-derived: an orthogonality check must pass or the caller must fall back.
 */
export function instanceObb(accessor, vertices, matrix) {
  const axes = [
    [matrix[0], matrix[1], matrix[2]],
    [matrix[4], matrix[5], matrix[6]],
    [matrix[8], matrix[9], matrix[10]],
  ].map((a) => {
    const len = Math.hypot(a[0], a[1], a[2]);
    if (!(len > 1e-8)) throw new Error("instance matrix has a degenerate axis");
    return [a[0] / len, a[1] / len, a[2] / len];
  });
  const ortho =
    Math.abs(axes[0][0] * axes[1][0] + axes[0][1] * axes[1][1] + axes[0][2] * axes[1][2]) +
    Math.abs(axes[0][0] * axes[2][0] + axes[0][1] * axes[2][1] + axes[0][2] * axes[2][2]) +
    Math.abs(axes[1][0] * axes[2][0] + axes[1][1] * axes[2][1] + axes[1][2] * axes[2][2]);
  const det =
    axes[0][0] * (axes[1][1] * axes[2][2] - axes[1][2] * axes[2][1]) -
    axes[0][1] * (axes[1][0] * axes[2][2] - axes[1][2] * axes[2][0]) +
    axes[0][2] * (axes[1][0] * axes[2][1] - axes[1][1] * axes[2][0]);
  if (ortho > 1e-4 || Math.abs(Math.abs(det) - 1) > 1e-4) {
    return { ok: false, reason: `instance matrix is not a rigid rotation (ortho ${ortho}, det ${det})` };
  }
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  let minW = Infinity;
  let maxW = -Infinity;
  for (const v of vertices) {
    const p = [accessor.positions[3 * v], accessor.positions[3 * v + 1], accessor.positions[3 * v + 2]];
    const u = p[0] * axes[0][0] + p[1] * axes[0][1] + p[2] * axes[0][2];
    const w = p[0] * axes[1][0] + p[1] * axes[1][1] + p[2] * axes[1][2];
    const q = p[0] * axes[2][0] + p[1] * axes[2][1] + p[2] * axes[2][2];
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (w < minW) minW = w;
    if (w > maxW) maxW = w;
    if (q < minV) minV = q;
    if (q > maxV) maxV = q;
  }
  const midU = (minU + maxU) / 2;
  const midW = (minW + maxW) / 2;
  const midV = (minV + maxV) / 2;
  const center = [
    axes[0][0] * midU + axes[1][0] * midW + axes[2][0] * midV,
    axes[0][1] * midU + axes[1][1] * midW + axes[2][1] * midV,
    axes[0][2] * midU + axes[1][2] * midW + axes[2][2] * midV,
  ];
  return {
    ok: true,
    center,
    axes,
    half: [(maxU - minU) / 2, (maxW - minW) / 2, (maxV - minV) / 2],
    orthoResidual: ortho,
    determinant: det,
  };
}

/**
 * Ground height sampler over the hidden River collision surface.
 * A query returns the highest triangle under (x,z) (the drivable side) and
 * whether the sample was exact or a nearest-vertex fallback.
 */
export function makeGroundSampler(mesh, cellSize = 4) {
  const { positions, indices, indexCount } = mesh;
  const triCount = indexCount / 3;
  const grid = new Map();
  const key = (ix, iz) => `${ix},${iz}`;
  const add = (ix, iz, t) => {
    const k = key(ix, iz);
    let list = grid.get(k);
    if (!list) {
      list = [];
      grid.set(k, list);
    }
    list.push(t);
  };
  const triMin = [];
  const triMax = [];
  for (let t = 0; t < triCount; t++) {
    const ia = indices[3 * t];
    const ib = indices[3 * t + 1];
    const ic = indices[3 * t + 2];
    const xs = [positions[3 * ia], positions[3 * ib], positions[3 * ic]];
    const zs = [positions[3 * ia + 2], positions[3 * ib + 2], positions[3 * ic + 2]];
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    triMin.push([minX, minZ]);
    triMax.push([maxX, maxZ]);
    for (let ix = Math.floor(minX / cellSize); ix <= Math.floor(maxX / cellSize); ix++) {
      for (let iz = Math.floor(minZ / cellSize); iz <= Math.floor(maxZ / cellSize); iz++) {
        add(ix, iz, t);
      }
    }
  }
  const vertexCount = mesh.vertexCount;
  return function groundAt(x, z) {
    let bestY = -Infinity;
    const ix = Math.floor(x / cellSize);
    const iz = Math.floor(z / cellSize);
    const list = grid.get(key(ix, iz));
    if (list) {
      for (const t of list) {
        if (x < triMin[t][0] - 2 || x > triMax[t][0] + 2) continue;
        if (z < triMin[t][1] - 2 || z > triMax[t][1] + 2) continue;
        const ia = indices[3 * t];
        const ib = indices[3 * t + 1];
        const ic = indices[3 * t + 2];
        const ax = positions[3 * ia];
        const az = positions[3 * ia + 2];
        const ay = positions[3 * ia + 1];
        const bx = positions[3 * ib];
        const bz = positions[3 * ib + 2];
        const by = positions[3 * ib + 1];
        const cx = positions[3 * ic];
        const cz = positions[3 * ic + 2];
        const cy = positions[3 * ic + 1];
        const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(den) < 1e-12) continue; // vertical in XZ
        const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den;
        const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den;
        const wc = 1 - wa - wb;
        if (wa < -1e-7 || wb < -1e-7 || wc < -1e-7) continue;
        const y = wa * ay + wb * by + wc * cy;
        if (y > bestY) bestY = y;
      }
    }
    if (bestY > -Infinity) return { y: bestY, exact: true };
    // nearest vertex fallback (documented, never used for a collider box)
    let ny = 0;
    let best = Infinity;
    for (let v = 0; v < vertexCount; v++) {
      const dx = positions[3 * v] - x;
      const dz = positions[3 * v + 2] - z;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        ny = positions[3 * v + 1];
      }
    }
    return { y: ny, exact: false, distance: Math.sqrt(best) };
  };
}

export { clamp01 };
