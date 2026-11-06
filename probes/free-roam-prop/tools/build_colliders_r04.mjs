#!/usr/bin/env node
/*
 * build_colliders_r04.mjs — extended P66 collider manifest for the free-roam
 * spawn component.
 *
 * The committed P66 builder is imported unchanged from
 * `probes/prop-collision/lib/collider-build.mjs` (read-only).  Only the region
 * predicate differs:
 *
 *   committed colliders.json : footprint within 30 m of the measured 310 m course
 *   this manifest            : footprint inside the P68a reachable spawn component
 *                              or within 30 m of it (`region.json`)
 *
 * The candidate pass is run with `regionDistance = 120` m around the course,
 * which is a strict superset of the free-roam region (the farthest reachable
 * cell is 81.31 m from the course), then filtered against the region.  Every
 * collider record is kept verbatim, so the schema, the per-collider hashes, the
 * car envelope and the `roadside` / `all-visible` semantics are identical to
 * P66.  The summary blocks (region, counts, profiles, road, onMeasuredCourse)
 * are recomputed for the filtered set.
 *
 * Output: _work/free-roam-prop/colliders-r04.json
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  buildColliderManifest,
  CAR_ENVELOPE,
  DEFAULTS,
  stableStringify,
  sha256 as sha256Text,
} from "../../prop-collision/lib/collider-build.mjs";
import { makeGroundSampler } from "../../prop-collision/lib/geometry.mjs";
import { createWorld } from "../../prop-collision/lib/resolver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const OUT = path.join(ROOT, "_work", "free-roam-prop");
const GEOMETRY_PATH = path.join(ROOT, "_work", "e1-drive", "geometry.json");
const PATH_PATH = path.join(ROOT, "_work", "drivable-path", "path.json");
const REGION_PATH = path.join(OUT, "region.json");
const COMMITTED_PATH = path.join(ROOT, "_work", "prop-collision", "colliders.json");
const OUT_PATH = path.join(OUT, "colliders-r04.json");

const PINNED_GEOMETRY = "85a321000868042a11ccabffeb65feaa16e36d35220f1843ea46b48244eb0445";
const PINNED_PATH = "81eac0ce413075de33e2b3c0e1c077412b35002420b199d9f05d2fdeef230e7f";
const COMMITTED_SHA = "a98fb8eb7e7a6f6851e0c6b5671d40be2c346d0c28a2442df0fe6ab497317af4";
const CANDIDATE_REGION_M = 120;   // superset of reachable component + 30 m ring
const RING_M = 30;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// --------------------------------------------------------------------------
// region: run-length rows of the reachable component, plus a ring
// --------------------------------------------------------------------------

function loadRegion(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (doc.kind !== "free-roam-prop.region" || doc.version !== 1) {
    throw new Error("unexpected region kind");
  }
  const rows = doc.rows.map((r) => ({ z: r.z, runs: r.runs }));
  if (!rows.length) throw new Error("empty region");
  /** Distance from an axis-aligned XZ rectangle to the region cell union. */
  function distanceRect(ax0, ax1, az0, az1) {
    let best = Infinity;
    for (const row of rows) {
      if (row.z + 0.25 < az0 - RING_M || row.z - 0.25 > az1 + RING_M) continue;
      const dz = Math.max((row.z - 0.25) - az1, az0 - (row.z + 0.25), 0);
      if (dz > RING_M) continue;
      for (const [x0, x1] of row.runs) {
        const dx = Math.max(x0 - ax1, ax0 - x1, 0);
        const d = Math.hypot(dx, dz);
        if (d < best) best = d;
      }
    }
    return best;
  }
  return { doc, rows, distanceRect };
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

const geometryBytes = fs.readFileSync(GEOMETRY_PATH);
const pathBytes = fs.readFileSync(PATH_PATH);
const regionBytes = fs.readFileSync(REGION_PATH);
const committedBytes = fs.readFileSync(COMMITTED_PATH);
const geometry = JSON.parse(geometryBytes.toString("utf8"));
const pathData = JSON.parse(pathBytes.toString("utf8"));
const region = loadRegion(REGION_PATH);

if (sha256(geometryBytes) !== PINNED_GEOMETRY) {
  throw new Error(`geometry.json is not the pinned v6 file (${sha256(geometryBytes)})`);
}
if (sha256(pathBytes) !== PINNED_PATH) {
  throw new Error("path.json is not the pinned P48 course");
}
if (sha256(committedBytes) !== COMMITTED_SHA) {
  throw new Error("the committed colliders.json changed; this build is not comparable");
}
if (geometry.version !== 6) throw new Error(`geometry v${geometry.version}`);
if (region.doc.manifestSha256 !== COMMITTED_SHA) {
  throw new Error("region.json was not derived from the committed P66 manifest");
}

console.log(`region ${region.rows.length} rows, ${region.doc.cells} cells, ` +
            `${region.doc.areaM2} m2, bbox ${JSON.stringify(region.doc.bboxMetres)}`);

// candidate pass: the committed builder with a superset region
const candidate = buildColliderManifest(geometry, pathData, {
  ...DEFAULTS,
  regionDistance: CANDIDATE_REGION_M,
});
console.log(`candidate colliders ${candidate.counts.colliders} ` +
            `(regionDistance ${CANDIDATE_REGION_M} m around the course)`);

// filter: inside the reachable component or within the ring
const kept = [];
const membership = { inside: 0, ring: 0, excluded: 0 };
const dists = [];
for (const c of candidate.colliders) {
  const a = c.worldAabb;
  const d = region.distanceRect(a.min[0], a.max[0], a.min[2], a.max[2]);
  if (!(d <= RING_M)) {
    membership.excluded += 1;
    continue;
  }
  if (d === 0) membership.inside += 1;
  else membership.ring += 1;
  dists.push(d);
  kept.push(c);
}
console.log(`kept ${kept.length} (inside ${membership.inside}, ring ${membership.ring}), ` +
            `dropped ${membership.excluded}`);

// ---- per-collider hashes must still match the P66 derivation --------------
let hashMismatch = 0;
for (const c of kept) {
  const { hash, ...rest } = c;
  if (`sha256:${sha256Text(stableStringify(rest))}` !== hash) hashMismatch += 1;
}
if (hashMismatch) throw new Error(`${hashMismatch} collider hashes do not recompute`);

// ---- rebuild the on-course flags for the kept set (same rule as P66) ------
const groundAt = makeGroundSampler(geometry.collisionSurface.mesh);
const course = pathData.course.points;
const probeWorld = createWorld({ colliders: kept, carEnvelope: CAR_ENVELOPE },
                              { profile: "all-visible" });
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
// the recomputed flags must reproduce the P66 hash, so nothing above drifted
let hashMismatch2 = 0;
for (const c of kept) {
  const { hash, ...rest } = c;
  if (`sha256:${sha256Text(stableStringify(rest))}` !== hash) hashMismatch2 += 1;
}
if (hashMismatch2) throw new Error(`${hashMismatch2} hashes drift after the on-course pass`);

kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// ---- merged blocked arcs (same merge rule as P66) -------------------------
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

// ---- counts block ---------------------------------------------------------
const activeCount = kept.filter((c) => c.active).length;
const triangles = kept.reduce((n, c) => n + c.triangles, 0);
const classSet = [...new Set(kept.map((c) => c.classification))].sort();
const bounds = kept.reduce((acc, c) => ({
  min: [Math.min(acc.min[0], c.worldAabb.min[0]), Math.min(acc.min[1], c.worldAabb.min[1]),
        Math.min(acc.min[2], c.worldAabb.min[2])],
  max: [Math.max(acc.max[0], c.worldAabb.max[0]), Math.max(acc.max[1], c.worldAabb.max[1]),
        Math.max(acc.max[2], c.worldAabb.max[2])],
}), { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
const activeBounds = kept.filter((c) => c.active).reduce((acc, c) => ({
  min: [Math.min(acc.min[0], c.worldAabb.min[0]), Math.min(acc.min[1], c.worldAabb.min[1]),
        Math.min(acc.min[2], c.worldAabb.min[2])],
  max: [Math.max(acc.max[0], c.worldAabb.max[0]), Math.max(acc.max[1], c.worldAabb.max[1]),
        Math.max(acc.max[2], c.worldAabb.max[2])],
}), { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });

const keptIds = new Set(kept.map((c) => c.id));
const excludedCounts = new Map();
for (const e of candidate.excluded) {
  excludedCounts.set(e.reason, (excludedCounts.get(e.reason) ?? 0) + 1);
}

const manifest = {
  kind: "prop-collision-colliders",
  version: 1,
  variant: "free-roam-r04",
  scope: {
    visibleMeshApproximation: true,
    retailCollision: false,
    collisionSurfaceUsedAsCollider: false,
    gameClaim: false,
    statement:
      "Static colliders derived from the visible E1 prop meshes over the P68a free-roam spawn " +
      "component plus a 30 m ring. Same derivation, schema and hashes as the committed P66 " +
      "manifest; only the region predicate differs. Visible-geometry approximation, not retail " +
      "collision.",
  },
  carEnvelope: CAR_ENVELOPE,
  region: {
    kind: "free-roam-component-ring",
    method:
      "collider XZ world AABB tested against the union of the reachable spawn-component cells; " +
      "kept when inside or within 30 m of it",
    distanceM: RING_M,
    candidateRegionDistanceM: CANDIDATE_REGION_M,
    candidateRegionMethod:
      "the committed 30 m course band was widened to 120 m for the candidate pass; the farthest " +
      "reachable cell is 81.31 m from the course, so 120 m is a strict superset of this region",
    component: {
      source: "_work/free-roam-prop/region.json",
      sha256: sha256(regionBytes),
      cells: region.doc.cells,
      areaM2: region.doc.areaM2,
      bboxMetres: region.doc.bboxMetres,
      derivedFromManifestSha256: region.doc.manifestSha256,
    },
    membership: {
      collidersInsideComponent: membership.inside,
      collidersInRing: membership.ring,
      collidersKept: kept.length,
      candidatesOutsideRegion: membership.excluded,
      maxKeptRingDistanceM: dists.length ? round6(Math.max(...dists)) : null,
    },
    differsFrom:
      "_work/prop-collision/colliders.json is bounded to 30 m around the measured 310 m course " +
      "and does not cover the outer free-roam basin",
  },
  classification: candidate.classification,
  rules: {
    ...candidate.rules,
    sources: candidate.rules.sources,
    inclusion: [
      "texture class in {vehicle, building, structure} OR unclassified that passes the geometry rules",
      `vertical extent >= ${DEFAULTS.minVerticalExtent} m`,
      `top > sampled ground + ${DEFAULTS.flushHeight} m`,
      `bottom < sampled ground + ${DEFAULTS.overheadClearance} m`,
      `inside the free-roam spawn component or within ${RING_M} m of it`,
    ],
    thresholds: {
      ...candidate.rules.thresholds,
      regionDistance: RING_M,
      candidateRegionDistance: CANDIDATE_REGION_M,
      regionKind: "free-roam-component-ring",
    },
    excludedListScope:
      `the excluded[] rows come from the ${CANDIDATE_REGION_M} m candidate pass, which is a ` +
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
      `excluded[] and outOfRegionByClass cover the ${CANDIDATE_REGION_M} m candidate pass, ` +
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

const text = `${JSON.stringify(manifest, null, 1)}\n`;
fs.writeFileSync(OUT_PATH, text);
const fileSha = sha256(Buffer.from(text));

console.log("");
console.log(`colliders ${manifest.counts.colliders}  active ${manifest.counts.active}  on-course ${manifest.counts.inactiveOnMeasuredCourse}`);
console.log(`  level ${manifest.counts.levelInstances} (active ${manifest.counts.activeLevelInstances}), track ${manifest.counts.trackComponents} (active ${manifest.counts.activeTrackComponents})`);
console.log(`triangles ${manifest.counts.triangles}  active ${manifest.counts.activeTriangles}`);
console.log(`bounds    ${manifest.counts.bounds.min.map((v) => v.toFixed(2)).join(",")} -> ${manifest.counts.bounds.max.map((v) => v.toFixed(2)).join(",")}`);
console.log(`blocked   ${manifest.road.allVisibleBlockedArcs.length} arcs (all-visible): ${manifest.road.allVisibleBlockedArcs.map((a) => a.arcStart.toFixed(1) + "-" + a.arcEnd.toFixed(1)).join(", ")}`);
console.log(`by class  ${JSON.stringify(manifest.counts.byClass)}`);
console.log(`membership inside ${membership.inside} ring ${membership.ring} kept ${kept.length}`);
console.log(`hashes    ${kept.length}/${kept.length} collider hashes recompute`);
console.log("");
console.log(`content   sha256:${manifest.contentSha256}`);
console.log(`file      ${OUT_PATH}`);
console.log(`file      sha256:${fileSha}  ${Buffer.byteLength(text)} B`);
