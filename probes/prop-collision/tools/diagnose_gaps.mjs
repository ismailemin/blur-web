#!/usr/bin/env node
/*
 * diagnose_gaps.mjs — inventory visible E1 structures inside the playable
 * regions and join them to the committed collider manifest.
 *
 * Regions:
 *   free   — the free-roam box x -108.5..5.0, z 1027.5..1164.0
 *   lap    — within 8 m of the loop-01 polyline (P61 laps)
 *   course — within 30 m of the measured 310.395 m course (P66 region)
 *
 * Output: _work/prop-collision/gap-diagnose.json
 *
 * Diagnostic only.  It does not write a collider manifest.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  meshAccessor,
  drawComponents,
  makeGroundSampler,
} from "../lib/geometry.mjs";
import { classifyTexture } from "../lib/collider-build.mjs";
import { pointPolylineDistance2D } from "../lib/geom2d.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const GEOMETRY = path.join(ROOT, "_work", "e1-drive", "geometry.json");
const PATH_JSON = path.join(ROOT, "_work", "drivable-path", "path.json");
const LOOPS = path.join(ROOT, "_work", "lap-search", "loops.json");
const MANIFEST = path.join(ROOT, "_work", "prop-collision", "colliders.json");
const OUT = path.join(ROOT, "_work", "prop-collision", "gap-diagnose.json");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

const FREE_BOX = { minX: -108.5, maxX: 5.0, minZ: 1027.5, maxZ: 1164.0 };
const LAP_RADIUS = 8;
const COURSE_RADIUS = 30;

const geometry = JSON.parse(fs.readFileSync(GEOMETRY, "utf8"));
const pathData = JSON.parse(fs.readFileSync(PATH_JSON, "utf8"));
const loops = JSON.parse(fs.readFileSync(LOOPS, "utf8"));
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const course = pathData.course.points;
const loop01 = loops.loops.find((l) => l.id === "loop-01").points;
const trackMesh = geometry.meshes.find((m) => m.id === "river.track.visual");
const trackAcc = meshAccessor(trackMesh);
const groundAt = makeGroundSampler(geometry.collisionSurface.mesh);

const colliderById = new Map(manifest.colliders.map((c) => [c.id, c]));

function aabbIntersectsRect(min, max, rect) {
  return max[0] >= rect.minX && min[0] <= rect.maxX && max[2] >= rect.minZ && min[2] <= rect.maxZ;
}

function classifyReason(cls, size, comp, ground, hullDist, inFree, inLap, inCourse) {
  if (!inFree && !inLap && !inCourse) return { reason: "outOfRegion", detail: "footprint is outside the free, lap and 30 m course regions" };
  if (cls.kind === "terrain") return { reason: "road-terrain", detail: cls.reason };
  if (cls.kind === "ground-surface") return { reason: "ground-surface", detail: cls.reason };
  if (size[1] < 0.25) return { reason: "flat", detail: `vertical extent ${size[1].toFixed(3)} m < 0.25 m` };
  if (comp.max[1] - ground.y <= 0.2) return { reason: "flush", detail: `top is ${(comp.max[1] - ground.y).toFixed(3)} m above ground` };
  if (comp.min[1] - ground.y >= 1.5) return { reason: "overhead", detail: `bottom is ${(comp.min[1] - ground.y).toFixed(3)} m above ground` };
  return { reason: "included", detail: "would pass the v1 geometry rules" };
}

const rows = [];
const classCounts = new Map();
for (const draw of geometry.trackVisual.draws) {
  const name = draw.textureBinding?.name ?? null;
  const cls = classifyTexture(name);
  const comps = drawComponents(trackAcc, draw);
  for (let ci = 0; ci < comps.length; ci++) {
    const c = comps[ci];
    const id = `${draw.id}.component.${String(ci).padStart(3, "0")}`;
    const size = c.max.map((v, i) => v - c.min[i]);
    const unique = c.vertices.map((v) => [trackAcc.positions[3 * v], trackAcc.positions[3 * v + 2]]);
    const hullDist = Math.min(...unique.map((p) => pointPolylineDistance2D(p[0], p[1], course)));
    const loopDist = Math.min(...unique.map((p) => pointPolylineDistance2D(p[0], p[1], loop01)));
    const inFree = aabbIntersectsRect(c.min, c.max, FREE_BOX);
    const inLap = loopDist <= LAP_RADIUS;
    const inCourse = hullDist <= COURSE_RADIUS;
    if (!inFree && !inLap && !inCourse) continue;
    const centerXZ = [(c.min[0] + c.max[0]) / 2, (c.min[2] + c.max[2]) / 2];
    const ground = groundAt(centerXZ[0], centerXZ[1]);
    const collider = colliderById.get(id) ?? null;
    const reason = classifyReason(cls, size, c, ground, hullDist, inFree, inLap, inCourse);
    const heightAboveGround = c.max[1] - ground.y;
    const bottomAboveGround = c.min[1] - ground.y;
    classCounts.set(cls.kind, (classCounts.get(cls.kind) ?? 0) + 1);
    rows.push({
      id,
      drawId: draw.id,
      section: draw.source?.sourceSection ?? null,
      texture: name,
      classification: cls.kind,
      componentIndex: ci,
      triangles: c.triangles,
      worldAabb: { min: c.min.map((v) => +v.toFixed(6)), max: c.max.map((v) => +v.toFixed(6)) },
      size: size.map((v) => +v.toFixed(6)),
      groundY: +ground.y.toFixed(6),
      groundExact: ground.exact,
      heightAboveGround: +heightAboveGround.toFixed(6),
      bottomAboveGround: +bottomAboveGround.toFixed(6),
      distanceToCourse: +hullDist.toFixed(3),
      distanceToLoop01: +loopDist.toFixed(3),
      inFreeBox: inFree,
      inLapCorridor: inLap,
      inCourseRegion: inCourse,
      colliderId: collider ? id : null,
      colliderActive: collider ? collider.active : null,
      colliderSize: collider ? collider.size : null,
      v1Reason: collider ? (collider.active ? "collider-active" : "collider-on-course-inactive") : reason.reason,
      v1Detail: collider ? (collider.active ? "present in the committed manifest" : collider.exclusion?.reason ?? "present but inactive") : reason.detail,
    });
  }
}

rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const vertical = rows.filter((r) => r.heightAboveGround >= 0.5 && r.bottomAboveGround < 2.5 && r.size[1] >= 0.5);
const largeVertical = vertical.filter((r) => r.heightAboveGround >= 2.0 && r.size[0] * r.size[2] >= 1.0);
const missing = rows.filter((r) => !r.colliderId);
const missingVertical = vertical.filter((r) => !r.colliderId);
const missingLarge = largeVertical.filter((r) => !r.colliderId);

function summarize(list) {
  const byReason = {};
  const byTexture = {};
  for (const r of list) {
    byReason[r.v1Reason] = (byReason[r.v1Reason] ?? 0) + 1;
    byTexture[r.texture ?? "(none)"] = (byTexture[r.texture ?? "(none)"] ?? 0) + 1;
  }
  return { count: list.length, byReason, byTexture };
}

const out = {
  kind: "prop-collision-gap-diagnose",
  version: 1,
  inputs: {
    geometrySha256: sha256(fs.readFileSync(GEOMETRY)),
    pathSha256: sha256(fs.readFileSync(PATH_JSON)),
    loopsSha256: sha256(fs.readFileSync(LOOPS)),
    manifestSha256: sha256(fs.readFileSync(MANIFEST)),
  },
  regions: {
    freeBox: FREE_BOX,
    lap01RadiusM: LAP_RADIUS,
    lap01Bounds: (() => {
      const xs = loop01.map((p) => p[0]);
      const zs = loop01.map((p) => p[1]);
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
    })(),
    courseRadiusM: COURSE_RADIUS,
  },
  summary: {
    componentsInRegions: rows.length,
    byClassification: Object.fromEntries([...classCounts.entries()].sort()),
    hasCollider: rows.length - missing.length,
    missingCollider: missing.length,
    verticalStructures: vertical.length,
    verticalMissingCollider: missingVertical.length,
    largeVertical: largeVertical.length,
    largeVerticalMissingCollider: missingLarge.length,
    missing: summarize(missing),
    missingVertical: summarize(missingVertical),
    missingLarge: summarize(missingLarge),
  },
  missingLarge: missingLarge.map((r) => ({
    id: r.id,
    section: r.section,
    texture: r.texture,
    classification: r.classification,
    worldAabb: r.worldAabb,
    groundY: r.groundY,
    heightAboveGround: r.heightAboveGround,
    bottomAboveGround: r.bottomAboveGround,
    triangles: r.triangles,
    distanceToCourse: r.distanceToCourse,
    distanceToLoop01: r.distanceToLoop01,
    inFreeBox: r.inFreeBox,
    inLapCorridor: r.inLapCorridor,
    inCourseRegion: r.inCourseRegion,
    v1Reason: r.v1Reason,
    v1Detail: r.v1Detail,
  })),
  rows,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);

console.log(`components in regions ${rows.length}, missing collider ${missing.length}`);
console.log(`vertical structures ${vertical.length}, missing ${missingVertical.length}`);
console.log(`large vertical structures ${largeVertical.length}, missing ${missingLarge.length}`);
console.log("missing reasons", JSON.stringify(out.summary.missing.byReason));
console.log("missing textures", JSON.stringify(out.summary.missing.byTexture));
console.log("");
for (const r of missingLarge.slice(0, 80)) {
  console.log(
    `${r.id}\n  tex=${r.texture ?? "(none)"} cls=${r.classification} h=${r.heightAboveGround.toFixed(2)} bottom=${r.bottomAboveGround.toFixed(2)} tri=${r.triangles} ` +
      `aabb=${r.worldAabb.min.map((v) => v.toFixed(1))}..${r.worldAabb.max.map((v) => v.toFixed(1))} free=${r.inFreeBox} lap=${r.inLapCorridor} course=${r.inCourseRegion} reason=${r.v1Reason}`,
  );
}
console.log(`wrote ${OUT}`);
