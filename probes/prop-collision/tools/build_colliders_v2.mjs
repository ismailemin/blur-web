#!/usr/bin/env node
/*
 * build_colliders_v2.mjs — P74 collision-data build.
 *
 * Produces two manifests from the same visible E1 geometry v6:
 *
 *   _work/prop-collision/colliders-v2.json
 *     region = 310 m course band (30 m) ∪ free-roam box ∪ loop-01 corridor (8 m)
 *
 *   _work/free-roam-prop/colliders-r04-v2.json
 *     region = P68a reachable spawn component ∪ 30 m ring (region.json)
 *
 * V2 rules versus the committed P66 manifest:
 *   - visible vertical structures are collidable regardless of texture/material
 *     classification; terrain/ground-surface textures are excluded only when the
 *     component geometry is actually ground (mostly horizontal or sloped);
 *   - only true overhead geometry (bottom >= 2.5 m above local ground) is
 *     excluded; a non-overhead obstacle uses a ground-to-top 2.5D column, so a
 *     low pipe/container cannot be driven under;
 *   - flat/flush exclusions are unchanged.
 *
 * The committed colliders.json and colliders-r04.json are never written.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  buildColliderManifest,
  CAR_ENVELOPE,
  DEFAULTS,
  stableStringify,
  sha256 as sha256Text,
} from "../lib/collider-build.mjs";
import { makeGroundSampler } from "../lib/geometry.mjs";
import { createWorld } from "../lib/resolver.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const GEOMETRY_PATH = path.join(ROOT, "_work", "e1-drive", "geometry.json");
const PATH_PATH = path.join(ROOT, "_work", "drivable-path", "path.json");
const LOOPS_PATH = path.join(ROOT, "_work", "lap-search", "loops.json");
const REGION_PATH = path.join(ROOT, "_work", "free-roam-prop", "region.json");
const COMMITTED_PATH = path.join(ROOT, "_work", "prop-collision", "colliders.json");
const OUT_BASE = path.join(ROOT, "_work", "prop-collision", "colliders-v2.json");
const OUT_R04 = path.join(ROOT, "_work", "free-roam-prop", "colliders-r04-v2.json");
const CHECK_ONLY = process.argv.includes("--check");

const PINNED_PATH = "81eac0ce413075de33e2b3c0e1c077412b35002420b199d9f05d2fdeef230e7f";
const COMMITTED_SHA = "a98fb8eb7e7a6f6851e0c6b5671d40be2c346d0c28a2442df0fe6ab497317af4";
const COMMITTED_INPUT_GEOMETRY_SHA = "85a321000868042a11ccabffeb65feaa16e36d35220f1843ea46b48244eb0445";
const FREE_BOX = { minX: -108.5, maxX: 5.0, minZ: 1027.5, maxZ: 1164.0 };
const LAP_RADIUS_M = 8;
const R04_RING_M = 30;
const R04_CANDIDATE_M = 120;
const V2_OPTS = {
  materialIndependent: true,
  groundColumn: true,
  overheadClearance: 2.5,
};

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// --------------------------------------------------------------------------
// inputs
// --------------------------------------------------------------------------

const geometryBytes = fs.readFileSync(GEOMETRY_PATH);
const pathBytes = fs.readFileSync(PATH_PATH);
const loopsBytes = fs.readFileSync(LOOPS_PATH);
const regionBytes = fs.readFileSync(REGION_PATH);
const committedBytes = fs.readFileSync(COMMITTED_PATH);
const geometry = JSON.parse(geometryBytes.toString("utf8"));
const pathData = JSON.parse(pathBytes.toString("utf8"));
const loops = JSON.parse(loopsBytes.toString("utf8"));
const regionDoc = JSON.parse(regionBytes.toString("utf8"));

if (sha256(pathBytes) !== PINNED_PATH) {
  throw new Error("path.json is not the pinned P48 course");
}
if (sha256(committedBytes) !== COMMITTED_SHA) {
  throw new Error("the committed colliders.json changed; this build is not comparable");
}
// The committed manifest was derived before P73 textured the level-instance
// draws.  Its track-visual geometry is unchanged: check_v1_regression.mjs
// rebuilds V1 from this file and reproduces contentSha256:8f09d12d…ffd174 and
// the 468/373 counts.  Record both hashes rather than pinning the stale one.
console.log(`geometry file sha256 ${sha256(geometryBytes)} (committed manifest input ${COMMITTED_INPUT_GEOMETRY_SHA})`);
if (geometry.version !== 6) throw new Error(`geometry v${geometry.version}`);
if (regionDoc.kind !== "free-roam-prop.region" || regionDoc.version !== 1) {
  throw new Error("unexpected free-roam region kind");
}
const loop01 = loops.loops.find((l) => l.id === "loop-01");
if (!loop01) throw new Error("loops.json has no loop-01");

function fillInputs(manifest) {
  manifest.inputs = manifest.inputs ?? {};
  manifest.inputs.geometry = {
    path: "_work/e1-drive/geometry.json",
    version: geometry.version,
    sha256: sha256(geometryBytes),
    bytes: geometryBytes.length,
    committedManifestInputSha256: COMMITTED_INPUT_GEOMETRY_SHA,
    note:
      "the committed colliders.json was derived before P73 textured the level-instance draws; " +
      "check_v1_regression.mjs reproduces its exact 468/373 collider array from this file",
  };
  manifest.inputs.path = {
    path: "_work/drivable-path/path.json",
    sha256: sha256(pathBytes),
    bytes: pathBytes.length,
  };
  manifest.inputs.loops = {
    path: "_work/lap-search/loops.json",
    sha256: sha256(loopsBytes),
    bytes: loopsBytes.length,
    loop: "loop-01",
  };
  manifest.inputs.region = {
    path: "_work/free-roam-prop/region.json",
    sha256: sha256(regionBytes),
    bytes: regionBytes.length,
  };
  manifest.inputs.committedManifest = {
    path: "_work/prop-collision/colliders.json",
    sha256: COMMITTED_SHA,
    role: "comparison/provenance only; not modified by this build",
  };
  manifest.contentSha256 = sha256Text(stableStringify(manifest.colliders));
}

// --------------------------------------------------------------------------
// base V2 manifest: union of playable regions
// --------------------------------------------------------------------------

const baseOptions = {
  ...DEFAULTS,
  ...V2_OPTS,
  regionDistance: 30,
  extraRegions: [
    { name: "free-roam-box", type: "box", ...FREE_BOX },
    { name: "lap-01", type: "polyline", points: loop01.points, radiusM: LAP_RADIUS_M },
  ],
};
const base = buildColliderManifest(geometry, pathData, baseOptions);
fillInputs(base);
base.variant = "playable-regions-v2";
base.scope.variantNote =
  "Base V2 manifest for the timed 310 m course, the loop-01 lap and the free-roam box. " +
  "Use profile roadside for the timed course and all-visible for lap/free-roam if no dedicated " +
  "free-roam manifest is loaded.";
const baseText = `${JSON.stringify(base, null, 1)}\n`;
fs.mkdirSync(path.dirname(OUT_BASE), { recursive: true });
const baseExisting = fs.existsSync(OUT_BASE) ? JSON.parse(fs.readFileSync(OUT_BASE, "utf8")) : null;
// The file embeds the input hashes, so a car-only geometry growth changes the
// text while leaving the collider data identical. The invariant is the data.
const baseMatchesExisting = !!baseExisting &&
  baseExisting.contentSha256 === base.contentSha256 &&
  (baseExisting.colliders || []).length === base.colliders.length;
if (!CHECK_ONLY) fs.writeFileSync(OUT_BASE, baseText);
const baseFileSha = sha256(Buffer.from(baseText));

console.log(`geometry v${geometry.version} ${sha256(geometryBytes)}`);
console.log(`path     ${sha256(pathBytes)}  ${pathData.course.length.toFixed(3)} m`);
console.log(`loop-01  ${loop01.points.length} points, ${loop01.length.toFixed(3)} m`);
console.log("");
console.log(`base V2 colliders ${base.counts.colliders}  active ${base.counts.active}  on-course ${base.counts.inactiveOnMeasuredCourse}`);
console.log(`  level ${base.counts.levelInstances}, track ${base.counts.trackComponents}, triangles ${base.counts.triangles}`);
console.log(`  blocked arcs (all-visible) ${base.road.allVisibleBlockedArcs.length}: ` +
  base.road.allVisibleBlockedArcs.map((a) => `${a.arcStart.toFixed(1)}-${a.arcEnd.toFixed(1)}`).join(", "));
console.log(`  by class ${JSON.stringify(base.counts.byClass)}`);
console.log(`  content sha256:${base.contentSha256}`);
console.log(`  file    ${OUT_BASE}`);
console.log(`  file    sha256:${baseFileSha}  ${Buffer.byteLength(baseText)} B`);
if (CHECK_ONLY) {
  console.log(`  check   ${baseMatchesExisting ? "MATCH" : "DRIFT"} vs committed manifest`);
}

// --------------------------------------------------------------------------
// free-roam V2 manifest: P68a region replacement
// --------------------------------------------------------------------------

function loadRegion(doc) {
  const rows = doc.rows.map((r) => ({ z: r.z, runs: r.runs }));
  if (!rows.length) throw new Error("empty free-roam region");
  function distanceRect(ax0, ax1, az0, az1) {
    let best = Infinity;
    for (const row of rows) {
      if (row.z + 0.25 < az0 - R04_RING_M || row.z - 0.25 > az1 + R04_RING_M) continue;
      const dz = Math.max((row.z - 0.25) - az1, az0 - (row.z + 0.25), 0);
      if (dz > R04_RING_M) continue;
      for (const [x0, x1] of row.runs) {
        const dx = Math.max(x0 - ax1, ax0 - x1, 0);
        const d = Math.hypot(dx, dz);
        if (d < best) best = d;
      }
    }
    return best;
  }
  return { rows, distanceRect };
}
const region = loadRegion(regionDoc);

const candidate = buildColliderManifest(geometry, pathData, {
  ...DEFAULTS,
  ...V2_OPTS,
  regionDistance: R04_CANDIDATE_M,
});
const kept = [];
const membership = { inside: 0, ring: 0, excluded: 0 };
const keptDistances = [];
for (const c of candidate.colliders) {
  const a = c.worldAabb;
  const d = region.distanceRect(a.min[0], a.max[0], a.min[2], a.max[2]);
  if (!(d <= R04_RING_M)) {
    membership.excluded += 1;
    continue;
  }
  if (d === 0) membership.inside += 1;
  else membership.ring += 1;
  keptDistances.push(d);
  kept.push(c);
}

// Recompute the measured-course conflict over the kept set, exactly as P68b.
const groundAt = makeGroundSampler(geometry.collisionSurface.mesh);
const course = pathData.course.points;
const probeWorld = createWorld({ colliders: kept, carEnvelope: CAR_ENVELOPE }, { profile: "all-visible" });
const onCourse = new Map();
const blockedSamples = new Set();
for (let i = 0; i < course.length; i++) {
  const [x, z] = course[i];
  const a = course[Math.max(0, i - 1)];
  const b = course[Math.min(course.length - 1, i + 1)];
  const yaw = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const ground = groundAt(x, z);
  const hits = probeWorld.contactsAll(x, z, yaw, ground.y, CAR_ENVELOPE);
  if (hits.length) blockedSamples.add(i);
  for (const hit of hits) {
    const arc = (i * pathData.course.length) / (course.length - 1);
    const row = onCourse.get(hit.colliderId);
    if (!row) {
      onCourse.set(hit.colliderId, {
        colliderId: hit.colliderId, firstArc: arc, lastArc: arc, samples: 1,
        classification: hit.classification,
      });
    } else {
      row.lastArc = arc;
      row.samples += 1;
    }
  }
}
for (const c of kept) {
  const row = onCourse.get(c.id);
  c.active = !row;
  if (row) {
    c.exclusion = {
      rule: "on-measured-course",
      reason:
        "the visible collider overlaps the car envelope on the measured 310 m course; " +
        "the committed course was measured on the collision-only surface and passes through this prop, " +
        "so colliding it would make the measured line impassable",
      firstArc: round6(row.firstArc),
      lastArc: round6(row.lastArc),
      samples: row.samples,
    };
  } else {
    delete c.exclusion;
  }
}
for (const c of kept) {
  const { hash, ...rest } = c;
  c.hash = `sha256:${sha256Text(stableStringify(rest))}`;
}
kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const rows = [...onCourse.values()].sort((a, b) =>
  a.firstArc === b.firstArc ? a.lastArc - b.lastArc : a.firstArc - b.firstArc);
const arcs = [];
for (const row of rows) {
  const last = arcs[arcs.length - 1];
  if (last && row.firstArc <= last.lastArc + 0.5) {
    last.lastArc = Math.max(last.lastArc, row.lastArc);
    last.colliderIds.add(row.colliderId);
  } else {
    arcs.push({ firstArc: row.firstArc, lastArc: row.lastArc, colliderIds: new Set([row.colliderId]) });
  }
}
const blockedArcReport = arcs.map((a) => ({
  arcStart: round6(a.firstArc),
  arcEnd: round6(a.lastArc),
  colliders: a.colliderIds.size,
  colliderIds: [...a.colliderIds].sort(),
}));

const activeCount = kept.filter((c) => c.active).length;
const triangles = kept.reduce((n, c) => n + c.triangles, 0);
const classSet = [...new Set(kept.map((c) => c.classification))].sort();
const bounds = kept.reduce((acc, c) => ({
  min: [Math.min(acc.min[0], c.worldAabb.min[0]), Math.min(acc.min[1], c.worldAabb.min[1]), Math.min(acc.min[2], c.worldAabb.min[2])],
  max: [Math.max(acc.max[0], c.worldAabb.max[0]), Math.max(acc.max[1], c.worldAabb.max[1]), Math.max(acc.max[2], c.worldAabb.max[2])],
}), { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
const activeBounds = kept.filter((c) => c.active).reduce((acc, c) => ({
  min: [Math.min(acc.min[0], c.worldAabb.min[0]), Math.min(acc.min[1], c.worldAabb.min[1]), Math.min(acc.min[2], c.worldAabb.min[2])],
  max: [Math.max(acc.max[0], c.worldAabb.max[0]), Math.max(acc.max[1], c.worldAabb.max[1]), Math.max(acc.max[2], c.worldAabb.max[2])],
}), { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });

const excludedCounts = new Map();
for (const e of candidate.excluded) excludedCounts.set(e.reason, (excludedCounts.get(e.reason) ?? 0) + 1);
const keptIds = new Set(kept.map((c) => c.id));

const r04 = {
  kind: "prop-collision-colliders",
  version: 1,
  variant: "free-roam-r04",
  variantRevision: "v2",
  scope: {
    visibleMeshApproximation: true,
    retailCollision: false,
    collisionSurfaceUsedAsCollider: false,
    gameClaim: false,
    materialIndependentStructures: true,
    groundColumn: true,
    overheadClearanceM: V2_OPTS.overheadClearance,
    statement:
      "Static colliders derived from the visible E1 prop meshes over the P68a free-roam spawn " +
      "component plus a 30 m ring. V2 derivation: visible vertical structures are collidable regardless " +
      "of texture/material class; terrain-textured components are excluded only when the geometry is ground; " +
      "non-overhead obstacles use a ground-to-top column. Visible-geometry approximation, not retail collision.",
  },
  carEnvelope: CAR_ENVELOPE,
  region: {
    kind: "free-roam-component-ring",
    method:
      "collider XZ world AABB tested against the union of the reachable spawn-component cells; " +
      "kept when inside or within 30 m of it",
    distanceM: R04_RING_M,
    candidateRegionDistanceM: R04_CANDIDATE_M,
    candidateRegionMethod:
      "the committed 30 m course band was widened to 120 m for the candidate pass; the farthest " +
      "reachable cell is 81.31 m from the course, so 120 m is a strict superset of this region",
    component: {
      source: "_work/free-roam-prop/region.json",
      sha256: sha256(regionBytes),
      cells: regionDoc.cells,
      areaM2: regionDoc.areaM2,
      bboxMetres: regionDoc.bboxMetres,
      derivedFromManifestSha256: regionDoc.manifestSha256,
    },
    membership: {
      collidersInsideComponent: membership.inside,
      collidersInRing: membership.ring,
      collidersKept: kept.length,
      candidatesOutsideRegion: membership.excluded,
      maxKeptRingDistanceM: keptDistances.length ? round6(Math.max(...keptDistances)) : null,
    },
    differsFrom:
      "_work/prop-collision/colliders-v2.json covers the playable-region union; this file is the " +
      "free-roam component+ring replacement for ?course=free",
  },
  classification: candidate.classification,
  rules: {
    ...candidate.rules,
    inclusion: [
      "visible component with real vertical geometry; no texture/material class is required",
      "texture-class terrain/ground-surface excluded only when the geometry is ground",
      `vertical extent >= ${DEFAULTS.minVerticalExtent} m`,
      `top > sampled ground + ${DEFAULTS.flushHeight} m`,
      `bottom < sampled ground + ${V2_OPTS.overheadClearance} m`,
      "non-overhead obstacles use a ground-to-top collision column",
      `inside the free-roam spawn component or within ${R04_RING_M} m of it`,
    ],
    thresholds: {
      ...candidate.rules.thresholds,
      regionDistance: R04_RING_M,
      candidateRegionDistance: R04_CANDIDATE_M,
      regionKind: "free-roam-component-ring",
    },
    excludedListScope:
      `the excluded[] rows come from the ${R04_CANDIDATE_M} m candidate pass, which is a ` +
      "superset of this region; no component inside the region is missing from the list",
  },
  road: {
    source: "_work/drivable-path/path.json",
    lengthM: round6(pathData.course.length),
    samples: course.length,
    testEnvelope: { length: CAR_ENVELOPE.length, width: CAR_ENVELOPE.width },
    defaultProfileBlockedSamples: 0,
    allVisibleBlockedSamples: blockedSamples.size,
    allVisibleBlockedArcs: blockedArcReport,
    note:
      "same measured-course conflict rule as the committed P66 manifest, recomputed over this " +
      "collider set. The default profile excludes props that overlap the measured line.",
  },
  profiles: {
    roadside: {
      active: true,
      colliders: activeCount,
      description: "all mapped visible props except the ones that overlap the measured course line",
    },
    "all-visible": {
      active: false,
      colliders: kept.length,
      description: "every mapped visible prop in the free-roam region",
    },
  },
  inputs: {
    geometry: {
      path: "_work/e1-drive/geometry.json",
      version: geometry.version,
      sha256: sha256(geometryBytes),
      bytes: geometryBytes.length,
    },
    path: {
      path: "_work/drivable-path/path.json",
      sha256: sha256(pathBytes),
      bytes: pathBytes.length,
    },
    loops: {
      path: "_work/lap-search/loops.json",
      sha256: sha256(loopsBytes),
      bytes: loopsBytes.length,
      loop: "loop-01",
      role: "not used by this region; recorded for build provenance",
    },
    region: {
      path: "_work/free-roam-prop/region.json",
      sha256: sha256(regionBytes),
      bytes: regionBytes.length,
    },
    committedManifest: {
      path: "_work/prop-collision/colliders.json",
      sha256: COMMITTED_SHA,
      role: "region provenance only; not modified by this build",
    },
  },
  counts: {
    colliders: kept.length,
    active: activeCount,
    inactiveOnMeasuredCourse: kept.length - activeCount,
    levelInstances: kept.filter((c) => c.source === "level-instance").length,
    activeLevelInstances: kept.filter((c) => c.source === "level-instance" && c.active).length,
    trackComponents: kept.filter((c) => c.source === "track-visual").length,
    activeTrackComponents: kept.filter((c) => c.source === "track-visual" && c.active).length,
    triangles,
    activeTriangles: kept.filter((c) => c.active).reduce((n, c) => n + c.triangles, 0),
    byClass: Object.fromEntries(classSet.map((k) => [k, kept.filter((c) => c.classification === k).length])),
    byClassActive: Object.fromEntries(classSet.map((k) => [k, kept.filter((c) => c.classification === k && c.active).length])),
    byClassInactive: Object.fromEntries(classSet.map((k) => [k, kept.filter((c) => c.classification === k && !c.active).length])),
    candidateColliders: candidate.counts.colliders,
    candidateExcluded: candidate.excluded.length,
    excluded: Object.fromEntries([...excludedCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    outOfRegionByClass: candidate.counts.outOfRegionByClass,
    excludedNote:
      `excluded[] and outOfRegionByClass cover the ${R04_CANDIDATE_M} m candidate pass, ` +
      "a superset of this region",
    bounds: { min: bounds.min.map(round6), max: bounds.max.map(round6) },
    boundsActive: { min: activeBounds.min.map(round6), max: activeBounds.max.map(round6) },
  },
  unclassified: candidate.unclassified.filter((u) => keptIds.has(u.id)),
  onMeasuredCourse: [...onCourse.values()]
    .sort((a, b) => (a.colliderId < b.colliderId ? -1 : 1))
    .map((r) => ({
      colliderId: r.colliderId,
      classification: r.classification,
      firstArc: round6(r.firstArc),
      lastArc: round6(r.lastArc),
      samples: r.samples,
    })),
  colliders: kept,
  excluded: candidate.excluded,
  contentSha256: sha256Text(stableStringify(kept)),
};
const r04Text = `${JSON.stringify(r04, null, 1)}\n`;
fs.mkdirSync(path.dirname(OUT_R04), { recursive: true });
const r04Existing = fs.existsSync(OUT_R04) ? JSON.parse(fs.readFileSync(OUT_R04, "utf8")) : null;
const r04MatchesExisting = !!r04Existing &&
  r04Existing.contentSha256 === r04.contentSha256 &&
  (r04Existing.colliders || []).length === r04.colliders.length;
if (!CHECK_ONLY) fs.writeFileSync(OUT_R04, r04Text);
const r04FileSha = sha256(Buffer.from(r04Text));

console.log("");
console.log(`free-roam V2 colliders ${r04.counts.colliders}  active ${r04.counts.active}  on-course ${r04.counts.inactiveOnMeasuredCourse}`);
console.log(`  membership inside ${membership.inside}, ring ${membership.ring}, dropped ${membership.excluded}`);
console.log(`  triangles ${r04.counts.triangles}, by class ${JSON.stringify(r04.counts.byClass)}`);
console.log(`  blocked arcs (all-visible) ${r04.road.allVisibleBlockedArcs.length}: ` +
  r04.road.allVisibleBlockedArcs.map((a) => `${a.arcStart.toFixed(1)}-${a.arcEnd.toFixed(1)}`).join(", "));
console.log(`  content sha256:${r04.contentSha256}`);
console.log(`  file    ${OUT_R04}`);
console.log(`  file    sha256:${r04FileSha}  ${Buffer.byteLength(r04Text)} B`);
if (CHECK_ONLY) {
  console.log("");
  console.log(`check base ${baseMatchesExisting ? "MATCH" : "DRIFT"}  r04 ${r04MatchesExisting ? "MATCH" : "DRIFT"}`);
  process.exitCode = baseMatchesExisting && r04MatchesExisting ? 0 : 1;
}
