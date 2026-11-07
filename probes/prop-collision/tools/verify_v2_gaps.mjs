#!/usr/bin/env node
/*
 * verify_v2_gaps.mjs — join the V2 manifests back to every visible component
 * inside the playable regions and report what is still not a collider.
 *
 * Output: _work/prop-collision/gap-v2.json
 *
 * Allowed non-collider reasons are only true exclusions: flat, flush, overhead
 * (bottom >= 2.5 m), true ground/terrain geometry, or out of the manifest region.
 * An "UNRESOLVED" row is a visible vertical structure that the build missed.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const DIAG = path.join(ROOT, "_work", "prop-collision", "gap-diagnose.json");
const NORMALS = path.join(ROOT, "_work", "prop-collision", "normal-census.json");
const BASE = path.join(ROOT, "_work", "prop-collision", "colliders-v2.json");
const R04 = path.join(ROOT, "_work", "free-roam-prop", "colliders-r04-v2.json");
const REGION = path.join(ROOT, "_work", "free-roam-prop", "region.json");
const OUT = path.join(ROOT, "_work", "prop-collision", "gap-v2.json");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

const diag = JSON.parse(fs.readFileSync(DIAG, "utf8"));
const normals = JSON.parse(fs.readFileSync(NORMALS, "utf8"));
const base = JSON.parse(fs.readFileSync(BASE, "utf8"));
const r04 = JSON.parse(fs.readFileSync(R04, "utf8"));
const regionDoc = JSON.parse(fs.readFileSync(REGION, "utf8"));
const baseIds = new Set(base.colliders.map((c) => c.id));
const r04Ids = new Set(r04.colliders.map((c) => c.id));
const normalById = new Map(normals.rows.map((r) => [r.id, r]));

const rows = regionDoc.rows.map((r) => ({ z: r.z, runs: r.runs }));
function regionDistanceRect(ax0, ax1, az0, az1, ring) {
  let best = Infinity;
  for (const row of rows) {
    if (row.z + 0.25 < az0 - ring || row.z - 0.25 > az1 + ring) continue;
    const dz = Math.max((row.z - 0.25) - az1, az0 - (row.z + 0.25), 0);
    if (dz > ring) continue;
    for (const [x0, x1] of row.runs) {
      const dx = Math.max(x0 - ax1, ax0 - x1, 0);
      const d = Math.hypot(dx, dz);
      if (d < best) best = d;
    }
  }
  return best;
}

function v2Reason(row, manifestRegion, presence) {
  if (presence) return "collider";
  const n = normalById.get(row.id);
  const upRatio = n?.upRatio ?? null;
  const verticalRatio = n?.verticalRatio ?? null;
  if (manifestRegion === "r04") {
    const a = row.worldAabb;
    const d = regionDistanceRect(a.min[0], a.max[0], a.min[2], a.max[2], 30);
    if (!(d <= 30)) return "outOfRegion";
  } else if (!row.inFreeBox && !row.inLapCorridor && !row.inCourseRegion) {
    return "outOfRegion";
  }
  if (row.size[1] < 0.25) return "flat";
  if (row.heightAboveGround <= 0.2) return "flush";
  if (row.bottomAboveGround >= 2.5) return "overhead";
  if (row.classification === "terrain" || row.classification === "ground-surface") {
    const geometryGround = upRatio === null || upRatio >= 0.5 ||
      !(verticalRatio !== null && verticalRatio >= 0.5 && row.heightAboveGround >= 1.0);
    if (geometryGround) return row.classification === "terrain" ? "road-terrain" : "ground-surface";
  }
  return "UNRESOLVED";
}

const enriched = diag.rows.map((r) => ({
  id: r.id,
  drawId: r.drawId,
  texture: r.texture,
  classification: r.classification,
  worldAabb: r.worldAabb,
  heightAboveGround: r.heightAboveGround,
  bottomAboveGround: r.bottomAboveGround,
  sizeY: r.size[1],
  triangles: r.triangles,
  inFreeBox: r.inFreeBox,
  inLapCorridor: r.inLapCorridor,
  inCourseRegion: r.inCourseRegion,
  base: v2Reason(r, "base", baseIds.has(r.id)),
  r04: v2Reason(r, "r04", r04Ids.has(r.id)),
}));

const vertical = enriched.filter((r) => r.heightAboveGround >= 0.5 && r.bottomAboveGround < 2.5 && r.sizeY >= 0.5);
function summarize(list, tag) {
  const byReason = {};
  const byTexture = {};
  for (const r of list) {
    const reason = r[tag];
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    byTexture[r.texture ?? "(none)"] = (byTexture[r.texture ?? "(none)"] ?? 0) + 1;
  }
  return { count: list.length, byReason, byTexture };
}
const baseUnresolved = enriched.filter((r) => r.base === "UNRESOLVED");
const r04Unresolved = enriched.filter((r) => r.r04 === "UNRESOLVED" && r.inFreeBox);
const baseVerticalUnresolved = vertical.filter((r) => r.base === "UNRESOLVED");
const r04VerticalUnresolved = vertical.filter((r) => r.r04 === "UNRESOLVED" && r.inFreeBox);

const out = {
  kind: "prop-collision-gap-v2",
  version: 1,
  inputs: {
    gapDiagnoseSha256: sha256(fs.readFileSync(DIAG)),
    normalCensusSha256: sha256(fs.readFileSync(NORMALS)),
    baseV2Sha256: sha256(fs.readFileSync(BASE)),
    r04V2Sha256: sha256(fs.readFileSync(R04)),
    regionSha256: sha256(fs.readFileSync(REGION)),
  },
  counts: {
    componentsInRegions: enriched.length,
    verticalStructures: vertical.length,
    baseWithCollider: enriched.filter((r) => r.base === "collider").length,
    r04WithCollider: enriched.filter((r) => r.r04 === "collider").length,
    baseUnresolved: baseUnresolved.length,
    r04UnresolvedInFreeBox: r04Unresolved.length,
    baseVerticalUnresolved: baseVerticalUnresolved.length,
    r04VerticalUnresolved: r04VerticalUnresolved.length,
  },
  base: summarize(enriched, "base"),
  r04: summarize(enriched, "r04"),
  baseVertical: summarize(vertical, "base"),
  r04Vertical: summarize(vertical, "r04"),
  unresolved: {
    base: baseUnresolved.map((r) => ({ ...r })),
    r04InFreeBox: r04Unresolved.map((r) => ({ ...r })),
  },
};

const text = `${JSON.stringify(out, null, 1)}\n`;
fs.writeFileSync(OUT, text);
console.log(`components ${enriched.length}, vertical ${vertical.length}`);
console.log(`base colliders ${out.counts.baseWithCollider}, unresolved ${baseUnresolved.length}, vertical unresolved ${baseVerticalUnresolved.length}`);
console.log(`r04  colliders ${out.counts.r04WithCollider}, unresolved-in-free-box ${r04Unresolved.length}, vertical unresolved ${r04VerticalUnresolved.length}`);
console.log(`base reasons ${JSON.stringify(out.base.byReason)}`);
console.log(`r04 reasons ${JSON.stringify(out.r04.byReason)}`);
console.log(`file sha256:${sha256(Buffer.from(text))}`);
console.log(`wrote ${OUT}`);
