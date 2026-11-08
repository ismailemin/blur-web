/*
 * ground.mjs — windowed ground reference over the slice collision mesh.
 *
 * The committed `makeGroundSampler()` returns the HIGHEST triangle under (x,z).
 * That is right for a road surface, but a map can carry a bridge deck or a
 * tunnel roof above the road; picking the highest hit would then classify a
 * roadside wall against the wrong ground.
 *
 * This sampler therefore takes an explicit reference height (the recorded ground
 * of the nearest measured layout point) and a ±window, and returns the exact
 * collision-mesh triangle whose Y is closest to that reference inside the
 * window.  If no triangle intersects inside the window, it falls back to the
 * reference height and marks `exact:false`; nothing is invented.  Every query
 * result is recorded on the collider, so a reader can see which ground was used.
 */

export function makeWindowedGround(mesh, cellSize = 8) {
  const { positions, indices, indexCount } = mesh;
  const triCount = indexCount / 3;
  const grid = new Map();
  const key = (ix, iz) => `${ix},${iz}`;
  const triMin = new Float64Array(triCount * 2);
  const triMax = new Float64Array(triCount * 2);
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
    triMin[2 * t] = minX;
    triMin[2 * t + 1] = minZ;
    triMax[2 * t] = maxX;
    triMax[2 * t + 1] = maxZ;
    for (let ix = Math.floor(minX / cellSize); ix <= Math.floor(maxX / cellSize); ix++) {
      for (let iz = Math.floor(minZ / cellSize); iz <= Math.floor(maxZ / cellSize); iz++) {
        const k = key(ix, iz);
        let list = grid.get(k);
        if (!list) {
          list = [];
          grid.set(k, list);
        }
        list.push(t);
      }
    }
  }

  /** Intersection heights of every collision triangle under (x,z). */
  function hitsAt(x, z) {
    const list = grid.get(key(Math.floor(x / cellSize), Math.floor(z / cellSize)));
    if (!list) return [];
    const out = [];
    for (const t of list) {
      if (x < triMin[2 * t] - 1e-9 || x > triMax[2 * t] + 1e-9) continue;
      if (z < triMin[2 * t + 1] - 1e-9 || z > triMax[2 * t + 1] + 1e-9) continue;
      const ia = indices[3 * t];
      const ib = indices[3 * t + 1];
      const ic = indices[3 * t + 2];
      const ax = positions[3 * ia], ay = positions[3 * ia + 1], az = positions[3 * ia + 2];
      const bx = positions[3 * ib], by = positions[3 * ib + 1], bz = positions[3 * ib + 2];
      const cx = positions[3 * ic], cy = positions[3 * ic + 1], cz = positions[3 * ic + 2];
      const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(den) < 1e-12) continue; // vertical in XZ
      const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den;
      const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den;
      const wc = 1 - wa - wb;
      if (wa < -1e-7 || wb < -1e-7 || wc < -1e-7) continue;
      out.push({ triangleIndex: t, y: wa * ay + wb * by + wc * cy });
    }
    return out;
  }

  /**
   * Sample the ground near (x,z) using `refY` and `windowM`.
   * Returns { y, exact, hits, offset, windowM, source }.
   */
  function sample(x, z, refY, windowM = 8) {
    const hits = hitsAt(x, z);
    let best = null;
    for (const h of hits) {
      const offset = h.y - refY;
      if (Math.abs(offset) > windowM) continue;
      if (best === null || Math.abs(offset) < Math.abs(best.offset) - 1e-12) {
        best = { y: h.y, offset, triangleIndex: h.triangleIndex };
      }
    }
    if (best) {
      return {
        y: best.y,
        exact: true,
        hits: hits.length,
        offset: best.offset,
        triangleIndex: best.triangleIndex,
        windowM,
        source: "collision-mesh-window",
      };
    }
    return {
      y: refY,
      exact: false,
      hits: hits.length,
      offset: 0,
      triangleIndex: null,
      windowM,
      source: "nearest-path-ground-fallback",
    };
  }

  /** Highest hit, for diagnostics only (never used to place a collider). */
  function highest(x, z) {
    const hits = hitsAt(x, z);
    if (!hits.length) return null;
    let best = hits[0];
    for (const h of hits) if (h.y > best.y) best = h;
    return best;
  }

  return { sample, highest, hitsAt, cellSize, triangleCount: triCount };
}
