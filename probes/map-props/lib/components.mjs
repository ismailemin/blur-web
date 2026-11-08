/*
 * components.mjs — deterministic vertex-connected triangle components of one
 * draw range, plus the area-weighted normal census used by the P74 V2 rules.
 *
 * This mirrors the committed prop-collision `drawComponents()` semantics
 * exactly: union-find with the smaller root as parent, components sorted by
 * triangle count descending then by lowest global vertex index.  It is
 * re-implemented here with a per-draw local vertex map so the 2,627-draw Gracia
 * package does not allocate a 738k-entry parent array per draw.
 *
 * The verifier cross-checks this implementation against the committed
 * drawComponents() on a deterministic sample of draws.
 */

export function drawComponents(positions, indices, firstIndex, indexCount) {
  if (indexCount % 3 !== 0) throw new Error(`indexCount ${indexCount} is not a triangle list`);
  const triCount = indexCount / 3;
  if (triCount <= 0) throw new Error("empty draw");

  // local vertex ids in first-appearance order (deterministic)
  const localOf = new Map();
  const tri = new Uint32Array(indexCount);
  for (let i = 0; i < indexCount; i++) {
    const g = indices[firstIndex + i];
    let l = localOf.get(g);
    if (l === undefined) {
      l = localOf.size;
      localOf.set(g, l);
    }
    tri[i] = l;
  }
  const n = localOf.size;
  const globalOf = new Uint32Array(n);
  for (const [g, l] of localOf) globalOf[l] = g;

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a) => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) {
      const next = parent[a];
      parent[a] = r;
      a = next;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };
  for (let t = 0; t < triCount; t++) {
    const a = tri[3 * t];
    const b = tri[3 * t + 1];
    const c = tri[3 * t + 2];
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
        const l = tri[3 * t + k];
        vertexSet.add(l);
        const g = globalOf[l];
        const x = positions[3 * g];
        const y = positions[3 * g + 1];
        const z = positions[3 * g + 2];
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
      }
    }
    let area = 0;
    let upArea = 0;
    let verticalArea = 0;
    let slopedArea = 0;
    for (const t of triList) {
      const ga = globalOf[tri[3 * t]];
      const gb = globalOf[tri[3 * t + 1]];
      const gc = globalOf[tri[3 * t + 2]];
      const ax = positions[3 * ga], ay = positions[3 * ga + 1], az = positions[3 * ga + 2];
      const bx = positions[3 * gb], by = positions[3 * gb + 1], bz = positions[3 * gb + 2];
      const cx = positions[3 * gc], cy = positions[3 * gc + 1], cz = positions[3 * gc + 2];
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
    const globalVertices = [...vertexSet].map((l) => globalOf[l]).sort((a, b) => a - b);
    comps.push({
      triangles: triList.length,
      min,
      max,
      vertices: globalVertices,
      vertexCount: globalVertices.length,
      firstTriangle: firstIndex / 3 + triList[0],
      area,
      upArea,
      verticalArea,
      slopedArea,
      upRatio: area > 0 ? upArea / area : null,
      verticalRatio: area > 0 ? verticalArea / area : null,
      slopedRatio: area > 0 ? slopedArea / area : null,
      // XZ hull points, unique per vertex (used only for the box fit).
      xz: globalVertices.map((g) => [positions[3 * g], positions[3 * g + 2]]),
    });
  }
  comps.sort((a, b) => {
    if (b.triangles !== a.triangles) return b.triangles - a.triangles;
    return a.vertices[0] - b.vertices[0];
  });
  return comps;
}
