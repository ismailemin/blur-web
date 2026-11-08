#!/usr/bin/env node
/*
 * build_colliders.mjs — build the Amboy and Gracia static prop collider
 * manifests from the committed map-slice render packages.
 *
 * Usage:
 *   node probes/map-props/tools/build_colliders.mjs [--map amboy|gracia|all] [--out DIR]
 *
 * Outputs (relative to the repo root unless --out is absolute):
 *   <out>/colliders-<map>.json    full collider manifest (profiles, hashes)
 *   <out>/manifest-<map>.json     small per-map loader manifest for e1
 *
 * Deterministic: no timestamps, no random ids, no absolute paths in the output.
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT, MAPS, loadMapPackage, sha256 } from "../lib/package.mjs";
import { buildManifest } from "../lib/build.mjs";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const mapArg = arg("--map", "all");
const outArg = arg("--out", "_work/map-props");
const outDir = path.isAbsolute(outArg) ? outArg : path.join(ROOT, outArg);

const maps = mapArg === "all" ? Object.keys(MAPS) : [mapArg];
for (const m of maps) if (!MAPS[m]) throw new Error(`unknown --map "${m}"`);

fs.mkdirSync(outDir, { recursive: true });

const summary = [];
for (const mapKey of maps) {
  const pkg = loadMapPackage(mapKey);
  const { manifest } = buildManifest(pkg);

  const collidersPath = path.join(outDir, `colliders-${mapKey}.json`);
  const collidersText = `${JSON.stringify(manifest, null, 1)}\n`;
  fs.writeFileSync(collidersPath, collidersText);
  const collidersBytes = Buffer.byteLength(collidersText);
  const collidersSha = sha256(Buffer.from(collidersText));

  const loader = {
    schema: "blur.map-props.manifest/1",
    kind: "map-props-manifest",
    version: 1,
    mapKey,
    level: manifest.level,
    colliders: {
      file: `colliders-${mapKey}.json`,
      bytes: collidersBytes,
      sha256: collidersSha,
      contentSha256: manifest.contentSha256,
      kind: manifest.kind,
      schema: manifest.schema,
    },
    carEnvelope: manifest.carEnvelope,
    region: { method: manifest.region.method, distanceM: manifest.region.distanceM },
    profiles: {
      default: "roadside",
      roadside: manifest.profiles.roadside,
      "all-visible": manifest.profiles["all-visible"],
    },
    counts: {
      colliders: manifest.counts.colliders,
      active: manifest.counts.active,
      inactiveOnMeasuredPath: manifest.counts.inactiveOnMeasuredPath,
      triangles: manifest.counts.triangles,
      byClass: manifest.counts.byClass,
      byStructureClass: manifest.counts.byStructureClass,
    },
    path: {
      lengthM: manifest.path.lengthM,
      polylineLengthM: manifest.path.polylineLengthM,
      samples: manifest.path.samples,
      spawn: manifest.path.spawn,
      checkpoints: manifest.path.checkpoints,
      finish: manifest.path.finish,
      allVisibleBlockedSamples: manifest.path.allVisibleBlockedSamples,
      allVisibleBlockedArcs: manifest.path.allVisibleBlockedArcs,
      defaultProfileBlockedSamples: manifest.path.defaultProfileBlockedSamples,
      minClearanceM: manifest.path.minClearanceM,
    },
    inputs: manifest.inputs,
    notes: [
      "Load colliders-<map>.json with profile 'roadside' to keep the measured path clear, or",
      "'all-visible' to collide every visible structure (the measured path is then blocked at the recorded arcs).",
      "The manifest is data only; no renderer, browser or full-game claim is made.",
    ],
  };
  const loaderText = `${JSON.stringify(loader, null, 1)}\n`;
  const loaderPath = path.join(outDir, `manifest-${mapKey}.json`);
  fs.writeFileSync(loaderPath, loaderText);
  const loaderSha = sha256(Buffer.from(loaderText));

  summary.push({
    mapKey,
    level: manifest.level,
    colliders: manifest.counts.colliders,
    active: manifest.counts.active,
    inactive: manifest.counts.inactiveOnMeasuredPath,
    triangles: manifest.counts.triangles,
    byClass: manifest.counts.byClass,
    byStructureClass: manifest.counts.byStructureClass,
    excluded: manifest.counts.excluded,
    outOfRegion: manifest.counts.outOfRegionByClass,
    coverage: {
      componentsTotal: manifest.coverage.componentsTotal,
      componentsInRegion: manifest.coverage.componentsInRegion,
      componentsCollider: manifest.coverage.componentsCollider,
      componentsExcluded: manifest.coverage.componentsExcluded,
      componentsOutOfRegion: manifest.coverage.componentsOutOfRegion,
      drawsTotal: manifest.coverage.drawsTotal,
      drawsInRegion: manifest.coverage.drawsInRegion,
      drawsWithCollider: manifest.coverage.drawsWithCollider,
      trianglesInRegion: manifest.coverage.trianglesInRegion,
      trianglesCollider: manifest.coverage.trianglesCollider,
      verticalStructuresInRegion: manifest.coverage.verticalStructuresInRegion,
      verticalStructuresWithCollider: manifest.coverage.verticalStructuresWithCollider,
      groundBandVerticalStructuresInRegion: manifest.coverage.groundBandVerticalStructuresInRegion,
      groundBandVerticalStructuresWithCollider: manifest.coverage.groundBandVerticalStructuresWithCollider,
      componentsExcludedByReason: manifest.coverage.componentsExcludedByReason,
      passThroughByReason: manifest.coverage.passThroughByReason,
      groundBandPassThroughByReason: manifest.coverage.groundBandPassThroughByReason,
      passThroughCount: manifest.coverage.passThroughVerticalStructures.length,
    },
    path: {
      lengthM: manifest.path.lengthM,
      samples: manifest.path.samples,
      allVisibleBlockedSamples: manifest.path.allVisibleBlockedSamples,
      arcs: manifest.path.allVisibleBlockedArcs.map((a) => `${a.arcStart}-${a.arcEnd} (${a.colliders})`),
      defaultProfileBlockedSamples: manifest.path.defaultProfileBlockedSamples,
      minClearanceM: manifest.path.minClearanceM,
      minClearanceColliderId: manifest.path.minClearanceColliderId,
    },
    contentSha256: manifest.contentSha256,
    file: path.relative(ROOT, collidersPath).split(path.sep).join("/"),
    bytes: collidersBytes,
    sha256: collidersSha,
    loaderFile: path.relative(ROOT, loaderPath).split(path.sep).join("/"),
    loaderSha256: loaderSha,
  });

  console.log(`== ${mapKey} (${manifest.level})`);
  console.log(`   colliders ${manifest.counts.colliders}  active ${manifest.counts.active}  on-path ${manifest.counts.inactiveOnMeasuredPath}`);
  console.log(`   triangles ${manifest.counts.triangles}  byClass ${JSON.stringify(manifest.counts.byClass)}`);
  console.log(`   byStructureClass ${JSON.stringify(manifest.counts.byStructureClass)}`);
  console.log(`   coverage components ${manifest.coverage.componentsCollider}/${manifest.coverage.componentsInRegion} in region; ` +
    `draws ${manifest.coverage.drawsWithCollider}/${manifest.coverage.drawsInRegion}; ` +
    `vertical structures ${manifest.coverage.verticalStructuresWithCollider}/${manifest.coverage.verticalStructuresInRegion}`);
  console.log(`   excluded ${JSON.stringify(manifest.counts.excluded)}`);
  console.log(`   path ${manifest.path.lengthM} m / ${manifest.path.samples} samples`);
  console.log(`   all-visible blocked ${manifest.path.allVisibleBlockedSamples} samples in ${manifest.path.allVisibleBlockedArcs.length} arcs: ` +
    manifest.path.allVisibleBlockedArcs.map((a) => `${a.arcStart}-${a.arcEnd}(${a.colliders})`).join(", "));
  console.log(`   roadside blocked ${manifest.path.defaultProfileBlockedSamples}; min clearance ${manifest.path.minClearanceM} m at ${manifest.path.minClearanceColliderId}`);
  console.log(`   content sha256:${manifest.contentSha256}`);
  console.log(`   file ${path.relative(ROOT, collidersPath).split(path.sep).join("/")}  ${collidersBytes} B  sha256:${collidersSha}`);
  console.log(`   loader ${path.relative(ROOT, loaderPath).split(path.sep).join("/")}  sha256:${loaderSha}`);
}

fs.writeFileSync(path.join(outDir, "build-summary.json"), `${JSON.stringify({ schema: "blur.map-props.build-summary/1", version: 1, maps: summary }, null, 1)}\n`);
console.log(`\nwrote ${path.relative(ROOT, outDir).split(path.sep).join("/")}/build-summary.json`);
