#!/usr/bin/env node
/*
 * emit_hashes.mjs — deterministic hash index for the map-props artifacts.
 *
 * Output: _work/map-props/hashes.json
 *   - one SHA-256 per artifact (collider manifests, loader manifests, build
 *     summary, measurement, resolver suite, verifier result, top-down maps),
 *   - the source files of this probe (so the data is pinned to the code),
 *   - the determinism records taken from verify.json / resolve.json.
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT, sha256 } from "../lib/package.mjs";

const OUT_DIR = path.join(ROOT, "_work", "map-props");

const artifacts = [
  "colliders-amboy.json",
  "colliders-gracia.json",
  "manifest-amboy.json",
  "manifest-gracia.json",
  "build-summary.json",
  "measure.json",
  "resolve.json",
  "verify.json",
  "map-amboy.png",
  "map-gracia.png",
];

const sources = [
  "probes/map-props/lib/package.mjs",
  "probes/map-props/lib/pathindex.mjs",
  "probes/map-props/lib/components.mjs",
  "probes/map-props/lib/ground.mjs",
  "probes/map-props/lib/build.mjs",
  "probes/map-props/tools/build_colliders.mjs",
  "probes/map-props/tools/resolve.mjs",
  "probes/map-props/tools/measure.mjs",
  "probes/map-props/tools/verify.mjs",
  "probes/map-props/tools/map_topdown.py",
  "probes/map-props/README.md",
  "docs/work/analysis/map-props.md",
];

const files = {};
for (const rel of artifacts) {
  const abs = path.join(OUT_DIR, rel);
  if (!fs.existsSync(abs)) throw new Error(`missing artifact ${rel}`);
  const bytes = fs.readFileSync(abs);
  files[rel] = { bytes: bytes.length, sha256: sha256(bytes) };
}
const sourcesOut = {};
for (const rel of sources) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    sourcesOut[rel] = { present: false };
    continue;
  }
  const bytes = fs.readFileSync(abs);
  sourcesOut[rel] = { bytes: bytes.length, sha256: sha256(bytes) };
}

const verify = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "verify.json"), "utf8"));
const resolve = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "resolve.json"), "utf8"));
const colliders = {};
for (const mapKey of ["amboy", "gracia"]) {
  const m = JSON.parse(fs.readFileSync(path.join(OUT_DIR, `colliders-${mapKey}.json`), "utf8"));
  colliders[mapKey] = {
    file: `colliders-${mapKey}.json`,
    bytes: files[`colliders-${mapKey}.json`].bytes,
    sha256: files[`colliders-${mapKey}.json`].sha256,
    contentSha256: m.contentSha256,
    counts: { colliders: m.counts.colliders, active: m.counts.active, triangles: m.counts.triangles },
  };
}

const out = {
  schema: "blur.map-props.hashes/1",
  version: 1,
  statement:
    "SHA-256 of every map-props artifact. The collider manifest content hash is the SHA-256 of the " +
    "canonical (key-sorted) collider array; the file hash covers the exact committed bytes.",
  colliders,
  files,
  sources: sourcesOut,
  determinism: {
    verify: verify.determinism,
    resolve: Object.fromEntries(Object.entries(resolve.maps).map(([k, v]) => [k, v.determinism])),
    verifier: { status: verify.status, checks: verify.checks, errors: verify.errors, file: "verify.json" },
  },
};
const text = `${JSON.stringify(out, null, 1)}\n`;
fs.writeFileSync(path.join(OUT_DIR, "hashes.json"), text);

for (const [name, row] of Object.entries(files)) console.log(`${row.sha256}  ${row.bytes.toString().padStart(9)}  ${name}`);
console.log(`wrote _work/map-props/hashes.json  ${Buffer.byteLength(text)} B  sha256:${sha256(Buffer.from(text))}`);
