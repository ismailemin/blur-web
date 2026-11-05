#!/usr/bin/env node
/*
 * explore_props.mjs — read-only exploration of the committed E1 geometry v6.
 *
 * It answers three questions before any collider is emitted:
 *   1. Which draw ranges are level instances, which are merged track-visual
 *      section draws, and which texture name each one carries?
 *   2. How do those draws decompose into vertex-connected triangle components?
 *   3. Which components sit in the 310 m course corridor, and what are their
 *      dimensions and vertical extents?
 *
 * No file is written outside stdout. This tool is evidence, not a producer.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const GEOMETRY = path.join(ROOT, "_work", "e1-drive", "geometry.json");
const PATH_JSON = path.join(ROOT, "_work", "drivable-path", "path.json");

const geometryBytes = fs.readFileSync(GEOMETRY);
const geometry = JSON.parse(geometryBytes);
const pathData = JSON.parse(fs.readFileSync(PATH_JSON, "utf8"));

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const ROAD_TEXTURE_PATTERNS = [
  /tarmac/i,
  /kerb/i,
  /mud/i,
  /offroad/i,
  /grounddirt/i,
  /dirtmount/i,
  /grass/i,
  /mountbaked/i,
  /riverbasin/i,
  /bankwall/i,
  /reed/i,
  /treeline/i,
  /cleanslate/i,
];

const STRUCTURE_TEXTURE_PATTERNS = [
  /building/i,
  /wall/i,
  /brick/i,
  /cargocontainer/i,
  /constructionfence/i,
  /concretepipe/i,
  /pipegate/i,
  /steelpole/i,
  /pylon/i,
  /crane/i,
  /metalstructure/i,
  /metalgirder/i,
  /extractor/i,
  /decor_hopper/i,
  /wooden/i,
  /treetruck/i,
  /rust/i,
  /channelbridge/i,
  /sign/i,
  /vent/i,
  /door/i,
  /window/i,
  /balc/i,
  /glass/i,
  /roof/i,
  /plantpot/i,
  /paving/i,
];

function classifyTexture(name) {
  if (!name) return "untextured";
  if (ROAD_TEXTURE_PATTERNS.some((re) => re.test(name))) return "terrain";
  if (STRUCTURE_TEXTURE_PATTERNS.some((re) => re.test(name))) return "structure";
  return "unclassified";
}

function meshAccessor(mesh) {
  const positions = mesh.positions;
  const indices = mesh.indices;
  const vertexCount = mesh.vertexCount;
  const getV = (i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
  return { positions, indices, vertexCount, getV };
}

/** Union-find over the vertices used by the draw's triangles. */
function componentsOfDraw(accessor, draw) {
  const { indices } = accessor;
  const first = draw.indexOffset;
  const count = draw.indexCount;
  const triCount = count / 3;
  const parent = new Map();
  const find = (a) => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(a) !== r) {
      const next = parent.get(a);
      parent.set(a, r);
      a = next;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const triVerts = [];
  for (let t = 0; t < triCount; t++) {
    const a = indices[first + 3 * t];
    const b = indices[first + 3 * t + 1];
    const c = indices[first + 3 * t + 2];
    triVerts.push([a, b, c]);
    for (const v of [a, b, c]) if (!parent.has(v)) parent.set(v, v);
    union(a, b);
    union(b, c);
  }
  const groups = new Map();
  for (let t = 0; t < triVerts.length; t++) {
    const root = find(triVerts[t][0]);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  }
  const comps = [];
  for (const triList of groups.values()) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const t of triList) {
      for (const v of triVerts[t]) {
        const p = accessor.getV(v);
        for (let k = 0; k < 3; k++) {
          if (p[k] < min[k]) min[k] = p[k];
          if (p[k] > max[k]) max[k] = p[k];
        }
        sx += p[0];
        sy += p[1];
        sz += p[2];
      }
    }
    const n = triList.length * 3;
    comps.push({
      triangles: triList.length,
      min,
      max,
      centroid: [sx / n, sy / n, sz / n],
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    });
  }
  comps.sort((a, b) => b.triangles - a.triangles);
  return comps;
}

const coursePoints = pathData.course.points;
function distanceToCourse(x, z) {
  let best = Infinity;
  for (const p of coursePoints) {
    const dx = p[0] - x;
    const dz = p[1] - z;
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

const levelMesh = geometry.meshes.find((m) => m.id === "river.block27.instances-all");
const trackMesh = geometry.meshes.find((m) => m.id === "river.track.visual");
const levelAcc = meshAccessor(levelMesh);
const trackAcc = meshAccessor(trackMesh);

console.log(`geometry SHA-256 ${sha256(geometryBytes)}  version ${geometry.version}`);
console.log(`path SHA-256     ${sha256(fs.readFileSync(PATH_JSON))}  length ${pathData.course.length.toFixed(3)} m`);
console.log();

console.log("== level instances (river.block27.instances-all) ==");
const instGroups = new Map();
for (const d of geometry.levelDraws) {
  const m = d.source.instanceMatrix;
  const key = [m[0], m[2], m[8], m[10], m[12], m[14]].map((v) => v.toFixed(4)).join(",");
  if (!instGroups.has(key)) instGroups.set(key, []);
  instGroups.get(key).push(d);
}
for (const [key, draws] of instGroups) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let tri = 0;
  for (const d of draws) {
    tri += d.indexCount / 3;
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], d.bounds.min[k]);
      max[k] = Math.max(max[k], d.bounds.max[k]);
    }
  }
  console.log(
    key,
    `draws=${draws.length}`,
    `tri=${tri}`,
    `min=${min.map((v) => v.toFixed(2)).join(",")}`,
    `max=${max.map((v) => v.toFixed(2)).join(",")}`,
    `size=${max.map((v, i) => (v - min[i]).toFixed(2)).join("x")}`,
    `course=${distanceToCourse((min[0] + max[0]) / 2, (min[2] + max[2]) / 2).toFixed(1)} m`,
  );
}
console.log();

console.log("== track-visual texture classes ==");
const byClass = new Map();
for (const d of geometry.trackVisual.draws) {
  const cls = classifyTexture(d.textureBinding?.name);
  if (!byClass.has(cls)) byClass.set(cls, { draws: 0, tri: 0 });
  const row = byClass.get(cls);
  row.draws += 1;
  row.tri += d.indexCount / 3;
}
for (const [cls, row] of [...byClass.entries()].sort((a, b) => b[1].tri - a[1].tri)) {
  console.log(`${cls.padEnd(14)} draws=${String(row.draws).padStart(3)} tri=${String(row.tri).padStart(6)}`);
}
console.log();

console.log("== track-visual components in/near the 310 m corridor (<= 12 m) ==");
const near = [];
for (const d of geometry.trackVisual.draws) {
  const cls = classifyTexture(d.textureBinding?.name);
  const comps = componentsOfDraw(trackAcc, d);
  for (const c of comps) {
    const dist = distanceToCourse(c.centroid[0], c.centroid[2]);
    c.drawId = d.id;
    c.texture = d.textureBinding?.name ?? null;
    c.cls = cls;
    c.courseDistance = dist;
    if (dist <= 12) near.push(c);
  }
}
near.sort((a, b) => a.courseDistance - b.courseDistance);
for (const c of near) {
  console.log(
    `${c.cls.padEnd(13)} ${String(c.texture).padEnd(30)} ${c.drawId.padEnd(34)}`,
    `tri=${String(c.triangles).padStart(5)}`,
    `size=${c.size.map((v) => v.toFixed(2)).join("x")}`,
    `min=${c.min.map((v) => v.toFixed(2)).join(",")}`,
    `max=${c.max.map((v) => v.toFixed(2)).join(",")}`,
    `course=${c.courseDistance.toFixed(2)}`,
  );
}
console.log(`components within 12 m: ${near.length}`);
