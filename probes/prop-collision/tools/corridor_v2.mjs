#!/usr/bin/env node
/*
 * corridor_v2.mjs — lateral corridor test for the 310 m line under the V2
 * manifests.  A clear centreline is necessary but not sufficient: the car must
 * be able to move laterally around debris.  Uses the same DP rule as probe_road.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createWorld } from "../lib/resolver.mjs";
import { makeGroundSampler } from "../lib/geometry.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const GEOMETRY = path.join(ROOT, "_work", "e1-drive", "geometry.json");
const PATH_JSON = path.join(ROOT, "_work", "drivable-path", "path.json");
const BASE = path.join(ROOT, "_work", "prop-collision", "colliders-v2.json");
const OUT = path.join(ROOT, "_work", "prop-collision", "corridor-v2.json");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

const geometry = JSON.parse(fs.readFileSync(GEOMETRY, "utf8"));
const pathData = JSON.parse(fs.readFileSync(PATH_JSON, "utf8"));
const base = JSON.parse(fs.readFileSync(BASE, "utf8"));
const groundAt = makeGroundSampler(geometry.collisionSurface.mesh);
const envelope = base.carEnvelope;
const points = pathData.course.points;
const arcPerSample = pathData.course.length / (points.length - 1);

function yawAt(i) {
  const a = points[Math.max(0, i - 1)];
  const b = points[Math.min(points.length - 1, i + 1)];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}
function corridorTest(world, halfWidth) {
  const LATERAL = [];
  for (let v = -halfWidth; v <= halfWidth + 1e-9; v += 0.2) LATERAL.push(+v.toFixed(3));
  const step = 2;
  const rows = [];
  for (let i = 0; i < points.length; i += step) {
    const [x, z] = points[i];
    const yaw = yawAt(i);
    const nx = -Math.sin(yaw), nz = Math.cos(yaw);
    const g = groundAt(x, z);
    const clear = [];
    for (const off of LATERAL) {
      if (!world.deepestContact(x + nx * off, z + nz * off, yaw, g.y, envelope)) clear.push(off);
    }
    rows.push({ sample: i, arc: +(i * arcPerSample).toFixed(3), clear });
  }
  const reachable = rows.map(() => new Array(LATERAL.length).fill(false));
  const prev = rows.map(() => new Array(LATERAL.length).fill(-1));
  for (let j = 0; j < LATERAL.length; j++) if (rows[0].clear.includes(LATERAL[j])) reachable[0][j] = true;
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
  const clearCounts = rows.map((r) => r.clear.length);
  return {
    bandHalfWidth: halfWidth,
    lateralStep: 0.2,
    rows: rows.length,
    fullyBlockedRows: rows.filter((r) => r.clear.length === 0).length,
    minClearOffsets: Math.min(...clearCounts),
    maxClearOffsets: Math.max(...clearCounts),
    reachable: endJ >= 0,
    blockedRows: rows.filter((r) => r.clear.length === 0).map((r) => r.arc),
  };
}

const out = {
  kind: "prop-collision-corridor-v2",
  version: 1,
  inputs: {
    geometrySha256: sha256(fs.readFileSync(GEOMETRY)),
    pathSha256: sha256(fs.readFileSync(PATH_JSON)),
    baseV2Sha256: sha256(fs.readFileSync(BASE)),
  },
  roadside: [2.6, 3.0, 3.5].map((w) => corridorTest(createWorld(base, { profile: "roadside" }), w)),
  allVisible: [2.6].map((w) => corridorTest(createWorld(base, { profile: "all-visible" }), w)),
};
const text = `${JSON.stringify(out, null, 1)}\n`;
fs.writeFileSync(OUT, text);
for (const c of out.roadside) {
  console.log(`roadside +/-${c.bandHalfWidth} m: reachable=${c.reachable} fullyBlockedRows=${c.fullyBlockedRows} minClear=${c.minClearOffsets}`);
}
for (const c of out.allVisible) {
  console.log(`all-visible +/-${c.bandHalfWidth} m: reachable=${c.reachable} fullyBlockedRows=${c.fullyBlockedRows} minClear=${c.minClearOffsets}`);
}
console.log(`file sha256:${sha256(Buffer.from(text))}`);
console.log(`wrote ${OUT}`);
