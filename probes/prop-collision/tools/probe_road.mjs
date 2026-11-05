#!/usr/bin/env node
/*
 * probe_road.mjs — measure what the static layer does to the measured 310 m
 * course under both profiles.
 *
 *   roadside    — default: visible props that do not overlap the measured line
 *   all-visible — every mapped visible prop (proves the on-course conflict)
 *
 * The tool writes _work/prop-collision/road-probe.json.  Diagnostic only.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createWorld } from "../lib/resolver.mjs";
import { makeGroundSampler } from "../lib/geometry.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const MANIFEST = path.join(ROOT, "_work", "prop-collision", "colliders.json");
const GEOMETRY = path.join(ROOT, "_work", "e1-drive", "geometry.json");
const PATH_JSON = path.join(ROOT, "_work", "drivable-path", "path.json");
const OUT = path.join(ROOT, "_work", "prop-collision", "road-probe.json");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const geometry = JSON.parse(fs.readFileSync(GEOMETRY, "utf8"));
const pathData = JSON.parse(fs.readFileSync(PATH_JSON, "utf8"));
const points = pathData.course.points;
const envelope = manifest.carEnvelope;
const groundAt = makeGroundSampler(geometry.collisionSurface.mesh);
const arcPerSample = pathData.course.length / (points.length - 1);

function yawAt(i) {
  const a = points[Math.max(0, i - 1)];
  const b = points[Math.min(points.length - 1, i + 1)];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

function lateralAt(i) {
  const yaw = yawAt(i);
  return [-Math.sin(yaw), Math.cos(yaw)];
}

function centrelineSweep(world) {
  const rows = [];
  for (let i = 0; i < points.length; i++) {
    const [x, z] = points[i];
    const yaw = yawAt(i);
    const g = groundAt(x, z);
    const hit = world.deepestContact(x, z, yaw, g.y, envelope);
    if (hit) {
      rows.push({
        sample: i,
        arc: +(i * arcPerSample).toFixed(3),
        x: +x.toFixed(3),
        z: +z.toFixed(3),
        colliderId: hit.colliderId,
        classification: hit.classification,
        penetration: +hit.penetration.toFixed(4),
        groundExact: g.exact,
      });
    }
  }
  const intervals = rows.map((r) => ({ first: r.arc, last: r.arc, id: r.colliderId })).sort((a, b) => a.first - b.first);
  const arcs = [];
  for (const row of intervals) {
    const last = arcs[arcs.length - 1];
    if (last && row.first <= last.last + 0.5) {
      last.last = Math.max(last.last, row.last);
      last.colliders.add(row.id);
    } else {
      arcs.push({ first: row.first, last: row.last, colliders: new Set([row.id]) });
    }
  }
  return {
    blockedSamples: rows.length,
    blockedArcs: arcs.map((a) => ({
      arcStart: +a.first.toFixed(3),
      arcEnd: +a.last.toFixed(3),
      colliders: [...a.colliders].sort(),
    })),
    rows,
  };
}

function corridorTest(world, halfWidth) {
  const LATERAL = [];
  for (let v = -halfWidth; v <= halfWidth + 1e-9; v += 0.2) LATERAL.push(+v.toFixed(3));
  const step = 2; // every 0.5 m along the course
  const rows = [];
  for (let i = 0; i < points.length; i += step) {
    const [x, z] = points[i];
    const yaw = yawAt(i);
    const [nx, nz] = lateralAt(i);
    const g = groundAt(x, z);
    const clear = [];
    const blocked = [];
    for (const off of LATERAL) {
      const px = x + nx * off;
      const pz = z + nz * off;
      const hit = world.deepestContact(px, pz, yaw, g.y, envelope);
      if (hit) blocked.push(off);
      else clear.push(off);
    }
    rows.push({ sample: i, arc: +(i * arcPerSample).toFixed(3), clear, blocked });
  }

  // DP over clear offsets: a transition may move at most 1.2 m laterally over
  // 0.5 m of arc.  If a corridor only exists with an impossible jump, the test
  // must fail.
  const reachable = rows.map(() => new Array(LATERAL.length).fill(false));
  const prev = rows.map(() => new Array(LATERAL.length).fill(-1));
  for (let j = 0; j < LATERAL.length; j++) {
    if (rows[0].clear.includes(LATERAL[j])) reachable[0][j] = true;
  }
  for (let i = 1; i < rows.length; i++) {
    for (let j = 0; j < LATERAL.length; j++) {
      if (!rows[i].clear.includes(LATERAL[j])) continue;
      for (let k = 0; k < LATERAL.length; k++) {
        if (!reachable[i - 1][k]) continue;
        if (Math.abs(LATERAL[j] - LATERAL[k]) <= 1.2 + 1e-9) {
          reachable[i][j] = true;
          if (prev[i][j] === -1) prev[i][j] = k;
        }
      }
    }
  }
  let endJ = -1;
  for (let j = 0; j < LATERAL.length; j++) if (reachable[rows.length - 1][j]) endJ = j;
  const path = [];
  if (endJ >= 0) {
    let j = endJ;
    for (let i = rows.length - 1; i >= 0; i--) {
      path.push({ sample: rows[i].sample, arc: rows[i].arc, offset: LATERAL[j] });
      j = prev[i][j];
      if (j < 0 && i > 0) throw new Error("corridor backtrack hit an unreachable row");
    }
    path.reverse();
  }
  const clearCounts = rows.map((r) => r.clear.length);
  return {
    bandHalfWidth: halfWidth,
    lateralStep: 0.2,
    arcStep: step * arcPerSample,
    rows: rows.length,
    fullyBlockedRows: rows.filter((r) => r.clear.length === 0).length,
    minClearOffsets: Math.min(...clearCounts),
    maxClearOffsets: Math.max(...clearCounts),
    reachable: endJ >= 0,
    maxLateralOffset: path.length ? Math.max(...path.map((c) => Math.abs(c.offset))) : null,
    path,
  };
}

const worlds = {
  roadside: createWorld(manifest, { profile: "roadside" }),
  "all-visible": createWorld(manifest, { profile: "all-visible" }),
};
const centreline = {
  roadside: centrelineSweep(worlds.roadside),
  "all-visible": centrelineSweep(worlds["all-visible"]),
};
const corridors = {
  roadside: [2.6, 3.0, 3.5].map((w) => corridorTest(worlds.roadside, w)),
  "all-visible": [2.6].map((w) => corridorTest(worlds["all-visible"], w)),
};

const out = {
  kind: "prop-collision-road-probe",
  version: 1,
  inputs: {
    collidersSha256: sha256(fs.readFileSync(MANIFEST)),
    pathSha256: sha256(fs.readFileSync(PATH_JSON)),
    geometrySha256: sha256(fs.readFileSync(GEOMETRY)),
  },
  course: { length: pathData.course.length, samples: points.length },
  worlds: {
    roadside: worlds.roadside.colliders.length,
    "all-visible": worlds["all-visible"].colliders.length,
  },
  centreline,
  corridors,
};
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);

for (const name of ["roadside", "all-visible"]) {
  const c = centreline[name];
  console.log(`${name.padEnd(12)} centreline: ${c.blockedSamples}/${points.length} samples blocked, ${c.blockedArcs.length} arcs`);
  for (const b of c.blockedArcs) console.log(`   ${b.arcStart.toFixed(2)}..${b.arcEnd.toFixed(2)} m  colliders=${b.colliders.length}`);
}
for (const c of corridors.roadside) {
  console.log(
    `roadside corridor +/-${c.bandHalfWidth.toFixed(1)} m: reachable=${c.reachable} fullyBlocked=${c.fullyBlockedRows} ` +
      `clear min/max=${c.minClearOffsets}/${c.maxClearOffsets} used=${c.maxLateralOffset ?? "-"}`,
  );
}
for (const c of corridors["all-visible"]) {
  console.log(
    `all-visible corridor +/-${c.bandHalfWidth.toFixed(1)} m: reachable=${c.reachable} fullyBlocked=${c.fullyBlockedRows}`,
  );
}
console.log(`wrote ${OUT}`);
