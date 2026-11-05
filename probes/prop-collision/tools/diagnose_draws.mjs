#!/usr/bin/env node
/*
 * diagnose_draws.mjs — read-only classification pass over geometry v6 before
 * the collider manifest is defined.
 *
 * For every track-visual draw it reports the source texture name, the texture
 * class, the distance from the draw bounds to the measured 310 m course line,
 * the vertical extent and how many vertex-connected components the draw holds.
 * Level draws are grouped by their source instance index.
 *
 * Writes _work/prop-collision/diagnose.json and prints two compact tables.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const GEOMETRY = path.join(ROOT, "_work", "e1-drive", "geometry.json");
const PATH_JSON = path.join(ROOT, "_work", "drivable-path", "path.json");
const OUT_DIR = path.join(ROOT, "_work", "prop-collision");

const TERRAIN_TEXTURES = [
  /tarmac/i, /kerb/i, /mud/i, /offroad/i, /grounddirt/i, /dirtmount/i,
  /grass/i, /mountbaked/i, /riverbasin/i, /bankwall/i, /reed/i, /treeline/i,
  /cleanslate/i, /mudfloor/i, /sand/i, /gravel/i, /road/i, /terrain/i,
];

const STRUCTURE_TEXTURES = [
  /building/i, /wall/i, /brick/i, /cargocontainer/i, /constructionfence/i,
  /concretepipe/i, /pipegate/i, /steelpole/i, /pylon/i, /crane/i,
  /metalstructure/i, /metalgirder/i, /extractor/i, /decor_hopper/i,
  /wooden/i, /treetruck/i, /rust/i, /channelbridge/i, /sign/i, /vent/i,
  /door/i, /window/i, /balc/i, /glass/i, /roof/i, /plantpot/i, /paving/i,
  /fence/i, /barrier/i, /container/i, /pole/i, /bridge/i, /tower/i,
];

function classify(name) {
  if (!name) return "untextured";
  if (TERRAIN_TEXTURES.some((re) => re.test(name))) return "terrain";
  if (STRUCTURE_TEXTURES.some((re) => re.test(name))) return "structure";
  return "unclassified";
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const geometryBytes = fs.readFileSync(GEOMETRY);
const geometry = JSON.parse(geometryBytes);
const pathBytes = fs.readFileSync(PATH_JSON);
const pathData = JSON.parse(pathBytes);
const course = pathData.course.points;

function courseDistance(x, z) {
  let best = Infinity;
  for (const p of course) {
    const dx = p[0] - x;
    const dz = p[1] - z;
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

function drawCourseDistance(d) {
  const [minX, , minZ] = d.bounds.min;
  const [maxX, , maxZ] = d.bounds.max;
  if (courseDistance((minX + maxX) / 2, (minZ + maxZ) / 2) > 200) return 999;
  let best = Infinity;
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const x = minX + ((maxX - minX) * i) / 4;
      const z = minZ + ((maxZ - minZ) * j) / 4;
      best = Math.min(best, courseDistance(x, z));
    }
  }
  return best;
}

function vertexComponents(mesh, draw) {
  const pos = mesh.positions;
  const idx = mesh.indices;
  const first = draw.indexOffset;
  const triCount = draw.indexCount / 3;
  const parent = new Map();
  const find = (a) => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(a) !== r) {
      const n = parent.get(a);
      parent.set(a, r);
      a = n;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const tris = [];
  for (let t = 0; t < triCount; t++) {
    const a = idx[first + 3 * t];
    const b = idx[first + 3 * t + 1];
    const c = idx[first + 3 * t + 2];
    tris.push([a, b, c]);
    for (const v of [a, b, c]) if (!parent.has(v)) parent.set(v, v);
    union(a, b);
    union(b, c);
  }
  const groups = new Map();
  for (let t = 0; t < tris.length; t++) {
    const r = find(tris[t][0]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }
  const comps = [];
  for (const list of groups.values()) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const t of list) {
      for (const v of tris[t]) {
        const x = pos[3 * v];
        const y = pos[3 * v + 1];
        const z = pos[3 * v + 2];
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
      }
    }
    comps.push({ triangles: list.length, min, max });
  }
  comps.sort((a, b) => b.triangles - a.triangles);
  return comps;
}

const levelMesh = geometry.meshes.find((m) => m.id === "river.block27.instances-all");
const trackMesh = geometry.meshes.find((m) => m.id === "river.track.visual");

const levelInstances = new Map();
for (const d of geometry.levelDraws) {
  const key = d.source.instanceIndex;
  if (!levelInstances.has(key)) levelInstances.set(key, []);
  levelInstances.get(key).push(d);
}
const levelRows = [];
for (const [instanceIndex, draws] of [...levelInstances.entries()].sort((a, b) => a[0] - b[0])) {
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
  levelRows.push({
    instanceIndex,
    draws: draws.length,
    triangles: tri,
    min,
    max,
    size: max.map((v, i) => v - min[i]),
    courseDistance: drawCourseDistance({ bounds: { min, max } }),
    instanceMatrix: draws[0].source.instanceMatrix,
    archivedInstanceBounds: draws[0].source.archivedInstanceBounds,
    drawIds: draws.map((d) => d.id),
  });
}

const trackRows = [];
for (const d of geometry.trackVisual.draws) {
  const name = d.textureBinding?.name ?? null;
  const cls = classify(name);
  const comps = vertexComponents(trackMesh, d);
  const dist = drawCourseDistance(d);
  const min = d.bounds.min;
  const max = d.bounds.max;
  const row = {
    id: d.id,
    name,
    cls,
    triangles: d.indexCount / 3,
    bounds: d.bounds,
    size: max.map((v, i) => v - min[i]),
    courseDistance: dist,
    components: comps.length,
    componentTriangles: comps.slice(0, 12).map((c) => ({
      tri: c.triangles,
      size: c.max.map((v, i) => v - c.min[i]),
      min: c.min,
      max: c.max,
    })),
    section: d.source?.sourceSection ?? null,
  };
  trackRows.push(row);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = {
  kind: "prop-collision-diagnose",
  version: 1,
  inputs: {
    geometry: {
      path: "_work/e1-drive/geometry.json",
      sha256: sha256(geometryBytes),
      version: geometry.version,
    },
    path: {
      path: "_work/drivable-path/path.json",
      sha256: sha256(pathBytes),
      length: pathData.course.length,
    },
  },
  terrainTexturePatterns: TERRAIN_TEXTURES.map(String),
  structureTexturePatterns: STRUCTURE_TEXTURES.map(String),
  levelInstances: levelRows,
  trackDraws: trackRows,
};
fs.writeFileSync(path.join(OUT_DIR, "diagnose.json"), JSON.stringify(out, null, 1));

const near = trackRows.filter((r) => r.courseDistance <= 30);
console.log(`geometry ${sha256(geometryBytes)} v${geometry.version}`);
console.log(`course ${pathData.course.length.toFixed(3)} m, ${course.length} points`);
console.log("");
console.log("== level instances (world-baked visible props) ==");
console.log("idx draws tri   size(x,y,z)          course   bounds min -> max");
for (const r of levelRows) {
  console.log(
    String(r.instanceIndex).padStart(3),
    String(r.draws).padStart(4),
    String(r.triangles).padStart(5),
    r.size.map((v) => v.toFixed(2)).join("x").padEnd(20),
    r.courseDistance.toFixed(1).padStart(6),
    r.min.map((v) => v.toFixed(1)).join(",") + " -> " + r.max.map((v) => v.toFixed(1)).join(","),
  );
}
console.log("");
console.log("== track-visual draws <= 30 m from the course ==");
console.log("class        texture                         tri    size(x,y,z)          course comps id");
for (const r of near.sort((a, b) => a.courseDistance - b.courseDistance)) {
  console.log(
    r.cls.padEnd(12),
    String(r.name ?? "-").padEnd(31),
    String(r.triangles).padStart(5),
    r.size.map((v) => v.toFixed(2)).join("x").padEnd(20),
    r.courseDistance.toFixed(1).padStart(6),
    String(r.components).padStart(5),
    r.id,
  );
}
console.log(`near draws: ${near.length} / ${trackRows.length}`);

const byClass = new Map();
for (const r of trackRows) {
  if (!byClass.has(r.cls)) byClass.set(r.cls, { draws: 0, tri: 0, near30: 0, near30tri: 0 });
  const row = byClass.get(r.cls);
  row.draws += 1;
  row.tri += r.triangles;
  if (r.courseDistance <= 30) {
    row.near30 += 1;
    row.near30tri += r.triangles;
  }
}
console.log("");
console.log("== texture classes (all / within 30 m) ==");
for (const [cls, row] of [...byClass.entries()].sort((a, b) => b[1].tri - a[1].tri)) {
  console.log(`${cls.padEnd(14)} draws=${String(row.draws).padStart(3)} tri=${String(row.tri).padStart(6)}  near30 draws=${String(row.near30).padStart(3)} tri=${String(row.near30tri).padStart(6)}`);
}

console.log("");
console.log("== untextured / unclassified draws within 60 m ==");
for (const r of trackRows.filter((r) => r.courseDistance <= 60 && (r.cls === "untextured" || r.cls === "unclassified")).sort((a, b) => a.courseDistance - b.courseDistance)) {
  console.log(
    r.cls.padEnd(12),
    String(r.name ?? "-").padEnd(24),
    String(r.triangles).padStart(5),
    r.size.map((v) => v.toFixed(2)).join("x").padEnd(20),
    r.courseDistance.toFixed(1).padStart(6),
    `comps=${r.components}`,
    r.id,
  );
}
