#!/usr/bin/env node
/*
 * measure.mjs — compact measurement report for both map-props manifests.
 *
 * Reads the committed collider manifests and resolve.json, and emits
 * _work/map-props/measure.json: collider counts, visible-structure coverage,
 * measured-path clearance / blocked arcs (with the exact structures), the
 * excluded diagnostic geometry and the resolver results.
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT, MAPS, loadMapPackage, sha256 } from "../lib/package.mjs";

const OUT_DIR = path.join(ROOT, "_work", "map-props");
const round6 = (v) => Math.round(v * 1e6) / 1e6;

const resolve = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "resolve.json"), "utf8"));

const maps = {};
for (const mapKey of Object.keys(MAPS)) {
  const pkg = loadMapPackage(mapKey);
  const bytes = fs.readFileSync(path.join(OUT_DIR, `colliders-${mapKey}.json`));
  const m = JSON.parse(bytes.toString("utf8"));
  const byId = new Map(m.colliders.map((c) => [c.id, c]));
  const arcs = m.path.allVisibleBlockedArcs.map((a) => ({
    arcStart: a.arcStart,
    arcEnd: a.arcEnd,
    colliders: a.colliderIds.map((id) => {
      const c = byId.get(id);
      return {
        id,
        texture: c.provenance.texture,
        classification: c.classification,
        structureClass: c.structureClass,
        size: c.size,
        heightM: c.vertical.height,
        triangles: c.triangles,
        distanceToPath: c.distanceToPath,
        samples: m.onMeasuredPath.find((r) => r.colliderId === id)?.samples ?? null,
        maxPenetration: m.onMeasuredPath.find((r) => r.colliderId === id)?.maxPenetration ?? null,
      };
    }),
  }));
  const diagnosticGroups = {};
  for (const [name, g] of Object.entries(pkg.diagnostics.groups)) {
    diagnosticGroups[name] = { draws: g.draws, triangles: g.triangles, pass: g.pass };
  }
  const largest = [...m.colliders]
    .sort((a, b) => (b.size[0] * b.size[2]) - (a.size[0] * a.size[2]) || (a.id < b.id ? -1 : 1))
    .slice(0, 10)
    .map((c) => ({
      id: c.id,
      texture: c.provenance.texture,
      structureClass: c.structureClass,
      size: c.size,
      heightM: c.vertical.height,
      triangles: c.triangles,
      distanceToPath: c.distanceToPath,
      active: c.active,
    }));
  const tallest = [...m.colliders]
    .sort((a, b) => b.vertical.height - a.vertical.height || (a.id < b.id ? -1 : 1))
    .slice(0, 10)
    .map((c) => ({ id: c.id, texture: c.provenance.texture, structureClass: c.structureClass, heightM: c.vertical.height, size: c.size }));

  maps[mapKey] = {
    level: m.level,
    manifest: {
      path: `_work/map-props/colliders-${mapKey}.json`,
      bytes: bytes.length,
      sha256: sha256(bytes),
      contentSha256: m.contentSha256,
    },
    colliders: m.counts,
    regions: m.region,
    coverage: {
      componentsTotal: m.coverage.componentsTotal,
      componentsInRegion: m.coverage.componentsInRegion,
      componentsCollider: m.coverage.componentsCollider,
      componentsExcluded: m.coverage.componentsExcluded,
      componentsOutOfRegion: m.coverage.componentsOutOfRegion,
      drawsTotal: m.coverage.drawsTotal,
      drawsInRegion: m.coverage.drawsInRegion,
      drawsWithCollider: m.coverage.drawsWithCollider,
      trianglesInRegion: m.coverage.trianglesInRegion,
      trianglesCollider: m.coverage.trianglesCollider,
      verticalStructuresInRegion: m.coverage.verticalStructuresInRegion,
      verticalStructuresWithCollider: m.coverage.verticalStructuresWithCollider,
      coverageRatio: +(m.coverage.verticalStructuresWithCollider / Math.max(1, m.coverage.verticalStructuresInRegion)).toFixed(4),
      groundBandVerticalStructuresInRegion: m.coverage.groundBandVerticalStructuresInRegion,
      groundBandVerticalStructuresWithCollider: m.coverage.groundBandVerticalStructuresWithCollider,
      groundBandCoverageRatio: +(m.coverage.groundBandVerticalStructuresWithCollider / Math.max(1, m.coverage.groundBandVerticalStructuresInRegion)).toFixed(4),
      groundBandPassThroughByReason: m.coverage.groundBandPassThroughByReason,
      componentsExcludedByReason: m.coverage.componentsExcludedByReason,
      passThroughByReason: m.coverage.passThroughByReason,
      passThroughCount: m.coverage.passThroughVerticalStructures.length,
      passThroughSample: m.coverage.passThroughVerticalStructures.slice(0, 8),
    },
    diagnosticExcluded: {
      blockedDraws: pkg.diagnostics.counts.blockedDraws,
      blockedTriangles: pkg.diagnostics.counts.blockedTriangles,
      groups: diagnosticGroups,
      role: "diagnostic/decal geometry only; not visible opaque collider source",
    },
    path: {
      lengthM: m.path.lengthM,
      polylineLengthM: m.path.polylineLengthM,
      renderRecordedFloat32LengthM: m.path.renderRecordedFloat32LengthM,
      samples: m.path.samples,
      spacingM: m.path.spacingM,
      spawn: m.path.spawn,
      checkpoints: m.path.checkpoints,
      finish: m.path.finish,
      allVisibleBlockedSamples: m.path.allVisibleBlockedSamples,
      roadsideBlockedSamples: m.path.defaultProfileBlockedSamples,
      allVisibleBlockedArcs: arcs,
      minClearanceM: m.path.minClearanceM,
      minClearanceColliderId: m.path.minClearanceColliderId,
      minClearanceArcM: m.path.minClearanceArcM,
    },
    largest,
    tallest,
    resolve: {
      spawnClear: resolve.maps[mapKey].spawn,
      headOn: {
        id: resolve.maps[mapKey].headOn.id,
        isolatedStops: resolve.maps[mapKey].headOn.directions.filter((d) => d.stops).length,
        directions: resolve.maps[mapKey].headOn.directions.map(({ direction, stops, endGap, finalSpeed, maxPenetration, substeps, passedTarget }) => ({
          direction, stops, endGap, finalSpeed, maxPenetration, substeps, passedTarget,
        })),
        fullManifest: resolve.maps[mapKey].headOn.fullManifest,
      },
      glance: (({ states, ...g }) => g)(resolve.maps[mapKey].glance),
      noTunnel: resolve.maps[mapKey].noTunnel,
      pathDrive: {
        roadside: (({ states, firstContacts, ...d }) => d)(resolve.maps[mapKey].pathDrive.roadside),
        allVisible: (({ states, firstContacts, ...d }) => d)(resolve.maps[mapKey].pathDrive.allVisible),
      },
      determinism: resolve.maps[mapKey].determinism,
    },
  };
}

const totals = Object.values(maps).reduce(
  (acc, m) => ({
    colliders: acc.colliders + m.colliders.colliders,
    active: acc.active + m.colliders.active,
    triangles: acc.triangles + m.colliders.triangles,
    verticalStructuresInRegion: acc.verticalStructuresInRegion + m.coverage.verticalStructuresInRegion,
    verticalStructuresWithCollider: acc.verticalStructuresWithCollider + m.coverage.verticalStructuresWithCollider,
    blockedSamples: acc.blockedSamples + m.path.allVisibleBlockedSamples,
    blockedArcs: acc.blockedArcs + m.path.allVisibleBlockedArcs.length,
  }),
  { colliders: 0, active: 0, triangles: 0, verticalStructuresInRegion: 0, verticalStructuresWithCollider: 0, blockedSamples: 0, blockedArcs: 0 },
);

const carEnvelope = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "colliders-amboy.json"), "utf8")).carEnvelope;
const out = {
  schema: "blur.map-props.measure/1",
  version: 1,
  carEnvelope,
  regionDistanceM: 40,
  maps,
  totals,
};
const text = `${JSON.stringify(out, null, 1)}\n`;
fs.writeFileSync(path.join(OUT_DIR, "measure.json"), text);

for (const [mapKey, m] of Object.entries(maps)) {
  console.log(`== ${mapKey}`);
  console.log(`   colliders ${m.colliders.colliders} (${m.colliders.active} active) / ${m.colliders.triangles} triangles`);
  console.log(`   visible vertical structures ${m.coverage.verticalStructuresWithCollider}/${m.coverage.verticalStructuresInRegion} (${(m.coverage.coverageRatio * 100).toFixed(1)}%)`);
  console.log(`   ground band ${m.coverage.groundBandVerticalStructuresWithCollider}/${m.coverage.groundBandVerticalStructuresInRegion} (${(m.coverage.groundBandCoverageRatio * 100).toFixed(1)}%) pass-through ${JSON.stringify(m.coverage.groundBandPassThroughByReason)}`);
  console.log(`   components ${m.coverage.componentsCollider}/${m.coverage.componentsInRegion} in region; pass-through ${m.coverage.passThroughCount} ${JSON.stringify(m.coverage.passThroughByReason)}`);
  console.log(`   path ${m.path.lengthM} m: all-visible ${m.path.allVisibleBlockedSamples} samples / ${m.path.allVisibleBlockedArcs.length} arcs; roadside ${m.path.roadsideBlockedSamples}`);
  for (const a of m.path.allVisibleBlockedArcs) {
    console.log(`     arc ${a.arcStart}-${a.arcEnd}: ${a.colliders.map((c) => `${c.texture}[${c.structureClass}]`).join(", ")}`);
  }
  console.log(`   min clearance ${m.path.minClearanceM} m at ${m.path.minClearanceColliderId}`);
}
console.log(`totals ${JSON.stringify(totals)}`);
console.log(`wrote _work/map-props/measure.json  ${Buffer.byteLength(text)} B  sha256:${sha256(Buffer.from(text))}`);
