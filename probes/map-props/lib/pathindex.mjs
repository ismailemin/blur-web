/*
 * pathindex.mjs — deterministic 2D index over the measured layout polyline.
 *
 * The layout polyline has one point every 0.25 m (2,571 points for Gracia,
 * 8,673 for Amboy).  A brute-force point-to-segment scan per component would be
 * O(points x segments); this index stores each segment in the 40 m grid cells
 * its XZ bounding box touches, so a bounded query only visits a 3 x 3 cell
 * neighbourhood.  With a 40 m cell, the 3 x 3 neighbourhood is a strict
 * superset of every segment within 40 m of the query point.
 *
 * The result is used for (a) region membership at 40 m, (b) the reported
 * distance to the path, (c) the ground reference height and (d) the arc
 * position of a blocked sample.  It never modifies the path.
 */

const CELL = 40;

export function buildPathIndex(path) {
  if (!Array.isArray(path) || path.length < 2) throw new Error("path index needs >= 2 points");
  const segments = [];
  const cumulative = new Float64Array(path.length);
  for (let i = 1; i < path.length; i++) {
    const dx = path[i][0] - path[i - 1][0];
    const dz = path[i][1] - path[i - 1][1];
    cumulative[i] = cumulative[i - 1] + Math.hypot(dx, dz);
  }
  const grid = new Map();
  const key = (ix, iz) => `${ix},${iz}`;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const seg = {
      index: i,
      ax: a[0], az: a[1], bx: b[0], bz: b[1],
      minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]),
      minZ: Math.min(a[1], b[1]), maxZ: Math.max(a[1], b[1]),
      arcStart: cumulative[i],
    };
    segments.push(seg);
    for (let ix = Math.floor(seg.minX / CELL); ix <= Math.floor(seg.maxX / CELL); ix++) {
      for (let iz = Math.floor(seg.minZ / CELL); iz <= Math.floor(seg.maxZ / CELL); iz++) {
        const k = key(ix, iz);
        let list = grid.get(k);
        if (!list) {
          list = [];
          grid.set(k, list);
        }
        list.push(i);
      }
    }
  }

  const lengthM = cumulative[path.length - 1];

  /**
   * Nearest segment to (x,z) within the 3x3 cell neighbourhood.
   * Returns null when no segment is registered there (the query point is more
   * than the queried-band distance away; callers treat null as out of band).
   */
  function nearest(x, z) {
    const ix = Math.floor(x / CELL);
    const iz = Math.floor(z / CELL);
    let best = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = grid.get(key(ix + dx, iz + dz));
        if (!list) continue;
        for (const si of list) {
          const s = segments[si];
          const vx = s.bx - s.ax;
          const vz = s.bz - s.az;
          const len2 = vx * vx + vz * vz;
          let t = len2 > 0 ? ((x - s.ax) * vx + (z - s.az) * vz) / len2 : 0;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          const px = s.ax + vx * t;
          const pz = s.az + vz * t;
          const d = Math.hypot(px - x, pz - z);
          if (best === null || d < best.distance - 1e-12) {
            best = {
              distance: d,
              segmentIndex: si,
              t,
              arcM: s.arcStart + t * Math.hypot(vx, vz),
              pointIndex: t < 0.5 ? si : si + 1,
              nearestPoint: [px, pz],
            };
          }
        }
      }
    }
    return best;
  }

  /** Distance to the polyline, or null when farther than the indexed band. */
  function distance(x, z) {
    const hit = nearest(x, z);
    return hit ? hit.distance : null;
  }

  function nearestPointIndex(x, z) {
    const hit = nearest(x, z);
    return hit ? hit.pointIndex : null;
  }

  function arcAt(x, z) {
    const hit = nearest(x, z);
    return hit ? hit.arcM : null;
  }

  /** Pose (position, tangent yaw) at arc length s, clamped to the polyline. */
  function poseAt(s) {
    if (s <= 0) {
      const a = path[0];
      const b = path[1];
      return { x: a[0], z: a[1], yaw: Math.atan2(b[1] - a[1], b[0] - a[0]), arcM: 0, index: 0 };
    }
    if (s >= lengthM) {
      const a = path[path.length - 2];
      const b = path[path.length - 1];
      return { x: b[0], z: b[1], yaw: Math.atan2(b[1] - a[1], b[0] - a[0]), arcM: lengthM, index: path.length - 1 };
    }
    // cumulative[] is sorted; binary search for the segment containing s.
    let lo = 0;
    let hi = path.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] <= s) lo = mid;
      else hi = mid;
    }
    const a = path[lo];
    const b = path[lo + 1];
    const segLen = cumulative[lo + 1] - cumulative[lo];
    const t = segLen > 0 ? (s - cumulative[lo]) / segLen : 0;
    return {
      x: a[0] + (b[0] - a[0]) * t,
      z: a[1] + (b[1] - a[1]) * t,
      yaw: Math.atan2(b[1] - a[1], b[0] - a[0]),
      arcM: s,
      index: lo,
    };
  }

  return { segments, points: path, cumulative, lengthM, cellSize: CELL, nearest, distance, nearestPointIndex, arcAt, poseAt };
}
