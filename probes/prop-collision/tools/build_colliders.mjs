#!/usr/bin/env node
/*
 * build_colliders.mjs — deterministic collider manifest producer.
 *
 * Inputs (read-only, pinned by SHA-256 in the output):
 *   _work/e1-drive/geometry.json        committed E1 geometry v6
 *   _work/drivable-path/path.json       measured 310.395 m course
 *
 * Output:
 *   _work/prop-collision/colliders.json
 *
 * The tool re-hashes the geometry and path bytes before using them, so a
 * regenerated or hand-edited input shows up as a changed pinned hash.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildColliderManifest, stableStringify } from "../lib/collider-build.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const GEOMETRY_PATH = path.join(ROOT, "_work", "e1-drive", "geometry.json");
const PATH_PATH = path.join(ROOT, "_work", "drivable-path", "path.json");
const OUT_DIR = path.join(ROOT, "_work", "prop-collision");
const OUT_PATH = path.join(OUT_DIR, "colliders.json");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const geometryBytes = fs.readFileSync(GEOMETRY_PATH);
const pathBytes = fs.readFileSync(PATH_PATH);
const geometry = JSON.parse(geometryBytes);
const pathData = JSON.parse(pathBytes);

if (geometry.version !== 6) {
  throw new Error(`expected geometry v6, got v${geometry.version}`);
}
if (Math.abs(pathData.course.length - 310.3952) > 0.001) {
  throw new Error(`expected the 310.395 m P48 course, got ${pathData.course.length}`);
}

const manifest = buildColliderManifest(geometry, pathData);
manifest.inputs.geometry.sha256 = sha256(geometryBytes);
manifest.inputs.path.sha256 = sha256(pathBytes);
manifest.inputs.geometry.bytes = geometryBytes.length;
manifest.inputs.path.bytes = pathBytes.length;

// Recompute the content hash over the final collider array (the inputs block is
// provenance, not content).
manifest.contentSha256 = crypto
  .createHash("sha256")
  .update(stableStringify(manifest.colliders))
  .digest("hex");

fs.mkdirSync(OUT_DIR, { recursive: true });
const text = `${JSON.stringify(manifest, null, 1)}\n`;
fs.writeFileSync(OUT_PATH, text);
const fileSha = sha256(Buffer.from(text));

console.log(`geometry v${geometry.version} ${manifest.inputs.geometry.sha256}`);
console.log(`path     ${manifest.inputs.path.sha256}  ${pathData.course.length.toFixed(3)} m`);
console.log("");
console.log(`colliders ${manifest.counts.colliders}  active ${manifest.counts.active}  on-course ${manifest.counts.inactiveOnMeasuredCourse}`);
console.log(`  level ${manifest.counts.levelInstances} (active ${manifest.counts.activeLevelInstances}), track ${manifest.counts.trackComponents} (active ${manifest.counts.activeTrackComponents})`);
console.log(`triangles ${manifest.counts.triangles}  active ${manifest.counts.activeTriangles}`);
console.log(`bounds    ${manifest.counts.bounds.min.map((v) => v.toFixed(2)).join(",")} -> ${manifest.counts.bounds.max.map((v) => v.toFixed(2)).join(",")}`);
console.log(`blocked   ${manifest.road.allVisibleBlockedArcs.length} arcs (all-visible): ${manifest.road.allVisibleBlockedArcs.map((a) => a.arcStart.toFixed(1) + "-" + a.arcEnd.toFixed(1)).join(", ")}`);
console.log(`by class  ${JSON.stringify(manifest.counts.byClass)}`);
console.log(`excluded  ${JSON.stringify(manifest.counts.excluded)}`);
console.log(`outregion ${JSON.stringify(manifest.counts.outOfRegionByClass)}`);
console.log(`unclassified colliders ${manifest.unclassified.length}`);
console.log("");
console.log(`content   sha256:${manifest.contentSha256}`);
console.log(`file      ${OUT_PATH}`);
console.log(`file      sha256:${fileSha}  ${Buffer.byteLength(text)} B`);
