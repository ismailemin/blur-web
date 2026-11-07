#!/usr/bin/env node
/*
 * measure_v2.mjs — measure the two V2 manifests against the playable regions.
 *
 * Output: _work/prop-collision/measure-v2.json
 *
 * For each manifest/profile:
 *   - 310 m course centreline blocked poses and arcs;
 *   - loop-01 centreline and lateral-band blocked poses;
 *   - free-roam spawn clearance and free route blocked poses;
 *   - collider counts and the new/removed ids versus the committed manifest.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createWorld } from "../lib/resolver.mjs";
import { makeGroundSampler } from "../lib/geometry.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const GEOMETRY = path.join(ROOT, "_work", "e1-drive", "geometry.json");
const PATH_JSON = path.join(ROOT, "_work", "drivable-path", "path.json");
const LOOPS = path.join(ROOT, "_work", "lap-search", "loops.json");
const BASE_V2 = path.join(ROOT, "_work", "prop-collision", "colliders-v2.json");
const R04_V2 = path.join(ROOT, "_work", "free-roam-prop", "colliders-r04-v2.json");
const COMMITTED = path.join(ROOT, "_work", "prop-collision", "colliders.json");
const COMMITTED_R04 = path.join(ROOT, "_work", "free-roam-prop", "colliders-r04.json");
const FREE_ROUTE = path.join(ROOT, "_work", "prop-collision", "free-v2", "route.json");
const FREE_PROPS = path.join(ROOT, "_work", "prop-collision", "free-v2", "props.json");
const OUT = path.join(ROOT, "_work", "prop-collision", "measure-v2.json");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

const geometry = JSON.parse(fs.readFileSync(GEOMETRY, "utf8"));
const pathData = JSON.parse(fs.readFileSync(PATH_JSON, "utf8"));
const loops = JSON.parse(fs.readFileSync(LOOPS, "utf8"));
const base = JSON.parse(fs.readFileSync(BASE_V2, "utf8"));
const r04 = JSON.parse(fs.readFileSync(R04_V2, "utf8"));
const committed = JSON.parse(fs.readFileSync(COMMITTED, "utf8"));
const committedR04 = JSON.parse(fs.readFileSync(COMMITTED_R04, "utf8"));
const freeRoute = JSON.parse(fs.readFileSync(FREE_ROUTE, "utf8"));
const freeProps = JSON.parse(fs.readFileSync(FREE_PROPS, "utf8"));
const groundAt = makeGroundSampler(geometry.collisionSurface.mesh);
const envelope = base.carEnvelope;
const course = pathData.course.points;
const loop01 = loops.loops.find((l) => l.id === "loop-01").points;

// ---------------------------------------------------------------------------
// geometry helpers (exact 2D rectangle distance for spawn/route clearance)
// ---------------------------------------------------------------------------
function corners(cx, cz, ux, uz, vx, vz, hu, hv) {
  return [
    [cx + ux * hu + vx * hv, cz + uz * hu + vz * hv],
    [cx + ux * hu - vx * hv, cz + uz * hu - vz * hv],
    [cx - ux * hu - vx * hv, cz - uz * hu - vz * hv],
    [cx - ux * hu + vx * hv, cz - uz * hu + vz * hv],
  ];
}
function carCorners(x, z, yaw, env) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return corners(x, z, c, s, -s, c, env.length / 2, env.width / 2);
}
function segDist(a, b, c, d) {
  const ux = b[0] - a[0], uz = b[1] - a[1];
  const vx = d[0] - c[0], vz = d[1] - c[1];
  const wx = a[0] - c[0], wz = a[1] - c[1];
  const a1 = ux * ux + uz * uz;
  const b1 = ux * vx + uz * vz;
  const c1 = vx * vx + vz * vz;
  const d1 = ux * wx + uz * wz;
  const e1 = vx * wx + vz * wz;
  const den = a1 * c1 - b1 * b1;
  let s1, t1;
  if (den < 1e-12) {
    s1 = 0;
    t1 = c1 > 1e-12 ? e1 / c1 : 0;
  } else {
    s1 = (b1 * e1 - c1 * d1) / den;
    t1 = (a1 * e1 - b1 * d1) / den;
  }
  s1 = Math.max(0, Math.min(1, s1));
  t1 = Math.max(0, Math.min(1, t1));
  const px = a[0] + s1 * ux, pz = a[1] + s1 * uz;
  const qx = c[0] + t1 * vx, qz = c[1] + t1 * vz;
  return Math.hypot(px - qx, pz - qz);
}
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > p[1]) !== (zj > p[1]) && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function polyDistance(a, b) {
  for (const p of a) if (pointInPoly(p, b)) return 0;
  for (const p of b) if (pointInPoly(p, a)) return 0;
  let best = Infinity;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const d = segDist(a1, a2, b[j], b[(j + 1) % b.length]);
      if (d < best) best = d;
    }
  }
  return best;
}
function colliderCorners(c) {
  return corners(
    c.center[0], c.center[2],
    c.axes[0][0], c.axes[0][2],
    c.axes[2][0], c.axes[2][2],
    c.half[0], c.half[2],
  );
}
function clearanceAt(world, x, z, yaw, baseY) {
  const car = carCorners(x, z, yaw, envelope);
  let best = Infinity;
  let id = null;
  for (const c of world.colliders) {
    if (c.top <= baseY || c.bottom >= baseY + envelope.height) continue;
    const poly = corners(c.cx, c.cz, c.ux, c.uz, c.vx, c.vz, c.hu, c.hv);
    const d = polyDistance(car, poly);
    if (d < best) {
      best = d;
      id = c.id;
    }
  }
  return { clearanceM: best, nearestCollider: id };
}

// ---------------------------------------------------------------------------
// sweeps
// ---------------------------------------------------------------------------
function yawOpen(points, i) {
  const a = points[Math.max(0, i - 1)];
  const b = points[Math.min(points.length - 1, i + 1)];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}
function yawClosed(points, i) {
  const a = points[(i - 1 + points.length) % points.length];
  const b = points[(i + 1) % points.length];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}
function arcsFromBlocked(blocked, arcOf) {
  const arcs = [];
  for (const i of blocked) {
    const arc = arcOf(i);
    const last = arcs[arcs.length - 1];
    if (last && i === last.lastSample + 1) {
      last.lastSample = i;
      last.arcEnd = arc;
      last.samples += 1;
    } else {
      arcs.push({ firstSample: i, lastSample: i, arcStart: arc, arcEnd: arc, samples: 1 });
    }
  }
  return arcs.map((a) => ({ ...a, arcStart: +a.arcStart.toFixed(6), arcEnd: +a.arcEnd.toFixed(6) }));
}
function centrelineSweep(world, points, closed) {
  const blocked = [];
  let minClearance = Infinity;
  let minAt = null;
  for (let i = 0; i < points.length; i++) {
    const [x, z] = points[i];
    const yaw = closed ? yawClosed(points, i) : yawOpen(points, i);
    const g = groundAt(x, z);
    const hit = world.deepestContact(x, z, yaw, g.y, envelope);
    if (hit) blocked.push(i);
    const cl = clearanceAt(world, x, z, yaw, g.y);
    if (cl.clearanceM < minClearance) {
      minClearance = cl.clearanceM;
      minAt = { sample: i, x, z, nearestCollider: cl.nearestCollider };
    }
  }
  const arcOf = closed
    ? (() => {
        const cum = [0];
        for (let i = 1; i < points.length; i++) {
          cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
        }
        const total = cum[cum.length - 1] + Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]);
        return (i) => (i * total) / points.length;
      })()
    : (() => {
        const cum = [0];
        for (let i = 1; i < points.length; i++) {
          cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
        }
        return (i) => cum[i];
      })();
  return {
    samples: points.length,
    blockedSamples: blocked.length,
    blockedArcs: arcsFromBlocked(blocked, arcOf),
    minClearanceM: +minClearance.toFixed(4),
    minClearanceAt: minAt,
  };
}
function lateralSweep(world, points, closed, halfWidth) {
  const offsets = [];
  for (let v = -halfWidth; v <= halfWidth + 1e-9; v += 0.5) offsets.push(+v.toFixed(3));
  const rows = [];
  for (let i = 0; i < points.length; i++) {
    const [x, z] = points[i];
    const yaw = closed ? yawClosed(points, i) : yawOpen(points, i);
    const nx = -Math.sin(yaw), nz = Math.cos(yaw);
    const g = groundAt(x, z);
    let clear = 0;
    for (const off of offsets) {
      if (!world.deepestContact(x + nx * off, z + nz * off, yaw, g.y, envelope)) clear += 1;
    }
    rows.push(clear);
  }
  return {
    bandHalfWidthM: halfWidth,
    lateralStepM: 0.5,
    rows: rows.length,
    fullyBlockedRows: rows.filter((c) => c === 0).length,
    minClearOffsets: Math.min(...rows),
    maxClearOffsets: Math.max(...rows),
    meanClearOffsets: +(rows.reduce((a, b) => a + b, 0) / rows.length).toFixed(3),
  };
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------
function run(manifest, profile) {
  const world = createWorld(manifest, { profile });
  const routeRows = [];
  let routeBlocked = 0;
  let routeMin = Infinity;
  for (const p of freeRoute.points) {
    const g = groundAt(p.x, p.z);
    const hit = world.deepestContact(p.x, p.z, p.heading, g.y, envelope);
    const cl = clearanceAt(world, p.x, p.z, p.heading, g.y);
    if (hit) routeBlocked += 1;
    if (cl.clearanceM < routeMin) routeMin = cl.clearanceM;
    routeRows.push({
      x: p.x, z: p.z, heading: p.heading,
      blocked: !!hit,
      clearanceM: +cl.clearanceM.toFixed(4),
      nearestCollider: cl.nearestCollider,
    });
  }
  const spawn = freeRoute.points[0];
  const spawnGround = groundAt(spawn.x, spawn.z);
  const spawnClear = clearanceAt(world, spawn.x, spawn.z, spawn.heading, spawnGround.y);
  const spawnHit = world.deepestContact(spawn.x, spawn.z, spawn.heading, spawnGround.y, envelope);
  return {
    profile,
    colliders: world.colliders.length,
    course: centrelineSweep(world, course, false),
    lap: centrelineSweep(world, loop01, true),
    lapBand: lateralSweep(world, loop01, true, 5.0),
    free: {
      spawn: {
        x: spawn.x, z: spawn.z, heading: spawn.heading,
        blocked: !!spawnHit,
        clearanceM: +spawnClear.clearanceM.toFixed(4),
        nearestCollider: spawnClear.nearestCollider,
      },
      routeSamples: routeRows.length,
      routeBlockedSamples: routeBlocked,
      routeMinClearanceM: +routeMin.toFixed(4),
      routeRows,
    },
  };
}

const baseRoadside = run(base, "roadside");
const baseAll = run(base, "all-visible");
const r04All = run(r04, "all-visible");

function idDiff(current, previous) {
  const cur = new Set(current.colliders.map((c) => c.id));
  const old = new Set(previous.colliders.map((c) => c.id));
  return {
    newIds: [...cur].filter((id) => !old.has(id)).sort(),
    removedIds: [...old].filter((id) => !cur.has(id)).sort(),
  };
}
const baseDiff = idDiff(base, committed);
const r04Diff = idDiff(r04, committedR04);

const freeComponents = {
  spawnComponentM2: freeProps.free.spawnComponentM2,
  componentCount: freeProps.free.componentCount,
  pocketCount: freeProps.free.pocketCount,
  pockets: freeProps.free.pockets.map((p) => ({
    areaM2: p.areaM2,
    bboxMetres: p.bboxMetres,
    containsSpawn: p.containsSpawn,
    enclosedByProps: p.enclosedByProps,
  })),
  reachableAreaM2: freeProps.reachability.reachableAreaM2,
  reachableCells: freeProps.reachability.reachableCells,
  routeLengthM: freeProps.route.lengthM,
  routeSamples: freeProps.route.samples,
  routeMinPropClearanceM: freeProps.route.minPropClearanceM,
};

const out = {
  kind: "prop-collision-measure-v2",
  version: 1,
  inputs: {
    geometrySha256: sha256(fs.readFileSync(GEOMETRY)),
    pathSha256: sha256(fs.readFileSync(PATH_JSON)),
    loopsSha256: sha256(fs.readFileSync(LOOPS)),
    baseV2Sha256: sha256(fs.readFileSync(BASE_V2)),
    r04V2Sha256: sha256(fs.readFileSync(R04_V2)),
    committedSha256: sha256(fs.readFileSync(COMMITTED)),
    committedR04Sha256: sha256(fs.readFileSync(COMMITTED_R04)),
  },
  counts: {
    base: { colliders: base.counts.colliders, active: base.counts.active, onCourse: base.counts.inactiveOnMeasuredCourse },
    r04: { colliders: r04.counts.colliders, active: r04.counts.active, onCourse: r04.counts.inactiveOnMeasuredCourse },
    baseDiff: { newIds: baseDiff.newIds.length, removedIds: baseDiff.removedIds.length },
    r04Diff: { newIds: r04Diff.newIds.length, removedIds: r04Diff.removedIds.length },
  },
  base: { roadside: baseRoadside, allVisible: baseAll },
  r04: { allVisible: r04All },
  freeComponents,
  diff: { base: baseDiff, r04: r04Diff },
};
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);

for (const [label, r] of [
  ["base roadside", baseRoadside],
  ["base all-visible", baseAll],
  ["r04-v2 all-visible", r04All],
]) {
  console.log(`${label}: colliders ${r.colliders}`);
  console.log(`  course blocked ${r.course.blockedSamples}/${r.course.samples}, arcs ${r.course.blockedArcs.length}, min clearance ${r.course.minClearanceM}`);
  console.log(`  lap blocked ${r.lap.blockedSamples}/${r.lap.samples}, arcs ${r.lap.blockedArcs.length}, min clearance ${r.lap.minClearanceM}, band fully-blocked rows ${r.lapBand.fullyBlockedRows}, min clear offsets ${r.lapBand.minClearOffsets}`);
  console.log(`  free spawn blocked ${r.free.spawn.blocked}, clearance ${r.free.spawn.clearanceM} m (${r.free.spawn.nearestCollider})`);
  console.log(`  free route blocked ${r.free.routeBlockedSamples}/${r.free.routeSamples}, min clearance ${r.free.routeMinClearanceM}`);
}
console.log(`base new/removed ${baseDiff.newIds.length}/${baseDiff.removedIds.length}`);
console.log(`r04  new/removed ${r04Diff.newIds.length}/${r04Diff.removedIds.length}`);
console.log(`wrote ${OUT}`);
