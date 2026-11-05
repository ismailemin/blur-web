/*
 * geom2d.mjs — deterministic 2D helpers for the prop-collision probe.
 *
 * Everything here is pure: no input is mutated, no randomness, no floating
 * point iteration whose order depends on a hash-map traversal.  The collider
 * builder relies on that so two runs produce byte-identical JSON.
 */

/** Monotone-chain convex hull of [x,z] points. Returns CCW hull, first point lowest-x. */
export function convexHull2D(points) {
  if (points.length <= 1) return points.slice();
  const pts = points
    .map((p) => [p[0], p[1]])
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Minimum-area enclosing rectangle of a 2D point set (rotating calipers over
 * the convex hull). Deterministic tie-break: area, then edge angle, then the
 * hull edge index.  This is an exact geometric fit, not a guessed transform.
 *
 * Returns { center:[x,z], u:[ux,uz], v:[vx,uz], half:[hu,hv], angle, area }.
 */
export function minAreaRect2D(points) {
  const hull = convexHull2D(points);
  if (hull.length === 0) throw new Error("minAreaRect2D: empty point set");
  if (hull.length === 1) {
    return {
      center: [hull[0][0], hull[0][1]],
      u: [1, 0],
      v: [0, 1],
      half: [0, 0],
      angle: 0,
      area: 0,
    };
  }
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len === 0) continue;
    const ux = dx / len;
    const uz = dz / len;
    const vx = -uz;
    const vz = ux;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const pu = p[0] * ux + p[1] * uz;
      const pv = p[0] * vx + p[1] * vz;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv;
      if (pv > maxV) maxV = pv;
    }
    const area = (maxU - minU) * (maxV - minV);
    const angle = Math.atan2(uz, ux);
    const candidate = {
      center: [
        ux * ((minU + maxU) / 2) + vx * ((minV + maxV) / 2),
        uz * ((minU + maxU) / 2) + vz * ((minV + maxV) / 2),
      ],
      u: [ux, uz],
      v: [vx, vz],
      half: [(maxU - minU) / 2, (maxV - minV) / 2],
      angle,
      area,
    };
    if (
      best === null ||
      area < best.area - 1e-12 ||
      (Math.abs(area - best.area) <= 1e-12 &&
        (angle < best.angle - 1e-12 ||
          (Math.abs(angle - best.angle) <= 1e-12 && i < best.edgeIndex)))
    ) {
      candidate.edgeIndex = i;
      best = candidate;
    }
  }
  return best;
}

/** Squared distance from a point to a segment [a,b] in 2D. */
export function pointSegmentDistanceSq2D(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const ex = ax + dx * t - px;
  const ez = az + dz * t - pz;
  return ex * ex + ez * ez;
}

/** Shortest distance from [x,z] to a 2D polyline (no closed loop). */
export function pointPolylineDistance2D(px, pz, polyline) {
  let best = Infinity;
  for (let i = 0; i + 1 < polyline.length; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const d = pointSegmentDistanceSq2D(px, pz, a[0], a[1], b[0], b[1]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Corners of a 2D OBB as [x,z] in CCW order. */
export function obbCorners2D(center, u, v, half) {
  const [cx, cz] = center;
  const [ux, uz] = u;
  const [vx, vz] = v;
  const [hu, hv] = half;
  return [
    [cx + ux * hu + vx * hv, cz + uz * hu + vz * hv],
    [cx - ux * hu + vx * hv, cz - uz * hu + vz * hv],
    [cx - ux * hu - vx * hv, cz - uz * hu - vz * hv],
    [cx + ux * hu - vx * hv, cz + uz * hu - vz * hv],
  ];
}
