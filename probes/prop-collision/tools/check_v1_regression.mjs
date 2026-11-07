#!/usr/bin/env node
/*
 * check_v1_regression.mjs — the V2 builder changes must not alter the committed
 * V1 derivation.  Rebuild with DEFAULTS from the current geometry and compare
 * the collider array, content hash and manifest bytes with colliders.json.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildColliderManifest, DEFAULTS, stableStringify } from "../lib/collider-build.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const GEOMETRY = path.join(ROOT, "_work", "e1-drive", "geometry.json");
const PATH_JSON = path.join(ROOT, "_work", "drivable-path", "path.json");
const COMMITTED = path.join(ROOT, "_work", "prop-collision", "colliders.json");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

const geometryBytes = fs.readFileSync(GEOMETRY);
const pathBytes = fs.readFileSync(PATH_JSON);
const committedBytes = fs.readFileSync(COMMITTED);
const geometry = JSON.parse(geometryBytes.toString("utf8"));
const pathData = JSON.parse(pathBytes.toString("utf8"));
const committed = JSON.parse(committedBytes.toString("utf8"));
const rebuilt = buildColliderManifest(geometry, pathData, { ...DEFAULTS });

const content = sha256(stableStringify(rebuilt.colliders));
const expected = committed.contentSha256;
const sameContent = `sha256:${content}` === `sha256:${expected}`;
const sameArray = stableStringify(rebuilt.colliders) === stableStringify(committed.colliders);
const sameExcluded = stableStringify(rebuilt.excluded) === stableStringify(committed.excluded);
const sameCounts = rebuilt.counts.colliders === committed.counts.colliders &&
  rebuilt.counts.active === committed.counts.active;

console.log(`geometry file sha256 ${sha256(geometryBytes)}`);
console.log(`committed input geometry ${committed.inputs.geometry.sha256} bytes ${committed.inputs.geometry.bytes}`);
console.log(`current geometry bytes ${geometryBytes.length}`);
console.log(`rebuilt colliders ${rebuilt.counts.colliders} active ${rebuilt.counts.active}`);
console.log(`committed colliders ${committed.counts.colliders} active ${committed.counts.active}`);
console.log(`content ${sameContent ? "MATCH" : "DIFF"} ${content} vs ${expected}`);
console.log(`collider array ${sameArray ? "MATCH" : "DIFF"}`);
console.log(`excluded array ${sameExcluded ? "MATCH" : "DIFF"}`);
console.log(`counts ${sameCounts ? "MATCH" : "DIFF"}`);
if (!sameContent) {
  let n = 0;
  for (const a of rebuilt.colliders) {
    const b = committed.colliders.find((c) => c.id === a.id);
    if (!b || stableStringify(a) !== stableStringify(b)) {
      if (n < 10) console.log(`changed ${a.id}: ${b ? "record differs" : "missing from committed"}`);
      n += 1;
    }
  }
  console.log(`changed or missing records ${n}`);
  process.exitCode = 1;
}
const report = {
  geometrySha256: sha256(geometryBytes),
  committedInputGeometrySha256: committed.inputs.geometry.sha256,
  currentBytes: geometryBytes.length,
  committedInputBytes: committed.inputs.geometry.bytes,
  rebuiltColliders: rebuilt.counts.colliders,
  committedColliders: committed.counts.colliders,
  rebuiltActive: rebuilt.counts.active,
  committedActive: committed.counts.active,
  contentMatch: sameContent,
  colliderArrayMatch: sameArray,
  excludedArrayMatch: sameExcluded,
  contentSha256: content,
  expectedContentSha256: expected,
};
fs.writeFileSync(path.join(ROOT, "_work", "prop-collision", "v1-regression.json"), `${JSON.stringify(report, null, 1)}\n`);
