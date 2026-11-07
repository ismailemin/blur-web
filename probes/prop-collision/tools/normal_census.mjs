#!/usr/bin/env node
/* Normal/ground-likeness census for the component inventory. Diagnostic only. */
import fs from "node:fs";
import path from "node:path";
import { meshAccessor, drawComponents } from "../lib/geometry.mjs";
import { classifyTexture } from "../lib/collider-build.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const geometry = JSON.parse(fs.readFileSync(path.join(ROOT, "_work", "e1-drive", "geometry.json"), "utf8"));
const trackMesh = geometry.meshes.find((m) => m.id === "river.track.visual");
const acc = meshAccessor(trackMesh);
const { positions, indices } = acc;

const diag = JSON.parse(fs.readFileSync(path.join(ROOT, "_work", "prop-collision", "gap-diagnose.json"), "utf8"));
const wanted = new Map(diag.rows.map((r) => [r.id, r]));

const rows = [];
for (const draw of geometry.trackVisual.draws) {
  const name = draw.textureBinding?.name ?? null;
  const cls = classifyTexture(name);
  const comps = drawComponents(acc, draw);
  for (let ci = 0; ci < comps.length; ci++) {
    const id = `${draw.id}.component.${String(ci).padStart(3, "0")}`;
    const r = wanted.get(id);
    if (!r) continue;
    const comp = comps[ci];
    let up = 0;
    let down = 0;
    let vertical = 0;
    let area = 0;
    const unique = comp.vertices;
    // recompute triangles belonging to this component by walking the draw and
    // checking vertex membership in the component set.
    const vs = new Set(unique);
    for (let t = 0; t < draw.indexCount / 3; t++) {
      const ia = indices[draw.indexOffset + 3 * t];
      const ib = indices[draw.indexOffset + 3 * t + 1];
      const ic = indices[draw.indexOffset + 3 * t + 2];
      if (!vs.has(ia) || !vs.has(ib) || !vs.has(ic)) continue;
      const ax = positions[3 * ia], ay = positions[3 * ia + 1], az = positions[3 * ia + 2];
      const bx = positions[3 * ib], by = positions[3 * ib + 1], bz = positions[3 * ib + 2];
      const cx = positions[3 * ic], cy = positions[3 * ic + 1], cz = positions[3 * ic + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-12) continue;
      const a = len / 2;
      area += a;
      const u = Math.abs(ny) / len;
      if (u >= 0.7) up += a;
      else if (u <= 0.3) vertical += a;
      else down += a;
    }
    rows.push({
      id,
      texture: name,
      classification: cls.kind,
      sizeY: r.size[1],
      heightAboveGround: r.heightAboveGround,
      bottomAboveGround: r.bottomAboveGround,
      triangles: comp.triangles,
      area: +area.toFixed(4),
      upRatio: area ? +(up / area).toFixed(4) : null,
      verticalRatio: area ? +(vertical / area).toFixed(4) : null,
      diagReason: r.v1Reason,
      regions: [r.inFreeBox ? "free" : "", r.inLapCorridor ? "lap" : "", r.inCourseRegion ? "course" : ""].filter(Boolean).join("+"),
    });
  }
}
rows.sort((a, b) => (a.id < b.id ? -1 : 1));
fs.writeFileSync(path.join(ROOT, "_work", "prop-collision", "normal-census.json"), `${JSON.stringify({ rows }, null, 1)}\n`);

const groups = new Map();
for (const r of rows) {
  const k = `${r.texture ?? "(none)"}|${r.classification}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
const summary = [...groups.entries()].map(([k, list]) => {
  const ups = list.map((r) => r.upRatio).filter((v) => v !== null);
  return {
    key: k,
    n: list.length,
    upRatioMin: Math.min(...ups),
    upRatioMedian: ups.slice().sort((a, b) => a - b)[Math.floor(ups.length / 2)],
    upRatioMax: Math.max(...ups),
    regions: [...new Set(list.map((r) => r.regions))].join(","),
    reason: [...new Set(list.map((r) => r.diagReason))].join(","),
  };
});
summary.sort((a, b) => (a.key < b.key ? -1 : 1));
fs.writeFileSync(path.join(ROOT, "_work", "prop-collision", "normal-summary.json"), `${JSON.stringify({ summary }, null, 1)}\n`);
console.log(JSON.stringify(summary, null, 1));
