#!/usr/bin/env node
/*
 * verify.mjs — independent verification of the map-props collider manifests.
 *
 * It re-reads every committed input, re-checks the package pins, validates every
 * collider record, recomputes the path clearance with the committed resolver,
 * cross-checks the component split against the committed `drawComponents()`,
 * re-checks the resolver suite, and rebuilds both manifests twice to prove byte
 * determinism.
 *
 * Output: _work/map-props/verify.json  (status PASS only when errors == 0)
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, MAPS, loadMapPackage, sha256 } from "../lib/package.mjs";
import { BUILD_DEFAULTS } from "../lib/build.mjs";
import { buildPathIndex } from "../lib/pathindex.mjs";
import { drawComponents as localComponents } from "../lib/components.mjs";
import { meshAccessor, drawComponents as committedComponents } from "../../prop-collision/lib/geometry.mjs";
import { convexHull2D, minAreaRect2D } from "../../prop-collision/lib/geom2d.mjs";
import { createWorld } from "../../prop-collision/lib/resolver.mjs";
import { CAR_ENVELOPE, stableStringify } from "../../prop-collision/lib/collider-build.mjs";

const OUT_DIR = path.join(ROOT, "_work", "map-props");
const round6 = (v) => Math.round(v * 1e6) / 1e6;

const checks = [];
const errors = [];
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, ...(detail === undefined ? {} : { detail }) });
  if (!ok) errors.push({ name, detail });
  return ok;
}
function near(a, b, tol = 1e-6) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
}

const CLASSES = new Set(["building", "structure", "vehicle", "terrain", "ground-surface", "unclassified", "no-material"]);
const STRUCTURE_CLASSES = new Set(["building", "silo-tank", "wall", "pole-tower", "fence-barrier", "container-vehicle", "pipe-structure", "other"]);
const EXCLUDE_REASONS = new Set(["flat", "flush", "overhead", "road-terrain", "ground-surface", "natural-terrain-scenery"]);

// ---------------------------------------------------------------------------
// 2D distance used only by the verifier (independent of the builder distance)
// ---------------------------------------------------------------------------
function segDist(a, b, c, d) {
  const ux = b[0] - a[0], uz = b[1] - a[1];
  const vx = d[0] - c[0], vz = d[1] - c[1];
  const wx = a[0] - c[0], wz = a[1] - c[1];
  const a1 = ux * ux + uz * uz;
  const b1 = ux * vx + uz * vz;
  const c1 = vx * vx + vz * vz;
  const d1 = ux * wx + uz * wz;
  const e1 = vx * wx + vz * wz;
  const den = a1 * c1 - b1 * b1;
  let s = 0;
  let t = 0;
  if (den < 1e-12) {
    t = c1 > 1e-12 ? e1 / c1 : 0;
  } else {
    s = (b1 * e1 - c1 * d1) / den;
    t = (a1 * e1 - b1 * d1) / den;
  }
  s = Math.max(0, Math.min(1, s));
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + s * ux - (c[0] + t * vx), a[1] + s * uz - (c[1] + t * vz));
}
function inside(p, poly) {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if ((poly[i][1] > p[1]) !== (poly[j][1] > p[1]) &&
      p[0] < ((poly[j][0] - poly[i][0]) * (p[1] - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) r = !r;
  }
  return r;
}
function polyDist(a, b) {
  for (const p of a) if (inside(p, b)) return 0;
  for (const p of b) if (inside(p, a)) return 0;
  let best = Infinity;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    best = Math.min(best, segDist(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length]));
  }
  return best;
}
function colliderPoly(c) {
  const lu = Math.hypot(c.axes[0][0], c.axes[0][2]) || 1;
  const lv = Math.hypot(c.axes[2][0], c.axes[2][2]) || 1;
  const ux = c.axes[0][0] / lu, uz = c.axes[0][2] / lu;
  const vx = c.axes[2][0] / lv, vz = c.axes[2][2] / lv;
  const hu = c.half[0] * lu, hv = c.half[2] * lv;
  const [cx, cz] = [c.center[0], c.center[2]];
  return [
    [cx + ux * hu + vx * hv, cz + uz * hu + vz * hv],
    [cx + ux * hu - vx * hv, cz + uz * hu - vz * hv],
    [cx - ux * hu - vx * hv, cz - uz * hu - vz * hv],
    [cx - ux * hu + vx * hv, cz - uz * hu + vz * hv],
  ];
}
function carPoly(x, z, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const hu = CAR_ENVELOPE.length / 2, hv = CAR_ENVELOPE.width / 2;
  return [
    [x + c * hu - s * hv, z + s * hu + c * hv],
    [x + c * hu + s * hv, z + s * hu - c * hv],
    [x - c * hu + s * hv, z - s * hu - c * hv],
    [x - c * hu - s * hv, z - s * hu + c * hv],
  ];
}

// ---------------------------------------------------------------------------
// per-map verification
// ---------------------------------------------------------------------------
function verifyMap(mapKey) {
  const prefix = `${mapKey}:`;
  const pkg = loadMapPackage(mapKey);
  for (const c of pkg.checks) check(`${prefix}${c.name}`, c.ok, c.actual);

  const collidersRel = `_work/map-props/colliders-${mapKey}.json`;
  const loaderRel = `_work/map-props/manifest-${mapKey}.json`;
  const collidersBytes = fs.readFileSync(path.join(ROOT, collidersRel));
  const loaderBytes = fs.readFileSync(path.join(ROOT, loaderRel));
  const manifest = JSON.parse(collidersBytes.toString("utf8"));
  const loader = JSON.parse(loaderBytes.toString("utf8"));

  const m = manifest;
  check(`${prefix}manifest.kind`, m.kind === "map-props-colliders", m.kind);
  check(`${prefix}manifest.version`, m.version === 1, m.version);
  check(`${prefix}manifest.mapKey`, m.mapKey === mapKey, m.mapKey);
  check(`${prefix}manifest.level`, m.level === pkg.render.level, m.level);
  check(`${prefix}carEnvelope`, m.carEnvelope.length === 2.98 && m.carEnvelope.width === 1.68 && m.carEnvelope.height === 1.35, m.carEnvelope);
  check(`${prefix}region.distanceM`, m.region.distanceM === BUILD_DEFAULTS.regionDistance, m.region.distanceM);
  for (const k of ["regionDistance", "minVerticalExtent", "minColliderThickness", "overheadClearance", "flushHeight", "groundWindowM"]) {
    check(`${prefix}thresholds.${k}`, m.rules.thresholds[k] === BUILD_DEFAULTS[k], m.rules.thresholds[k]);
  }
  check(`${prefix}scope.dataOnly`, m.scope.dataOnly === true);
  check(`${prefix}scope.retailCollision`, m.scope.retailCollision === false);
  check(`${prefix}scope.gameClaim`, m.scope.gameClaim === false);

  // ---- index-range join against the render package ----
  const renderById = new Map(pkg.render.draws.map((d) => [d.drawId, d]));
  const ids = new Set();
  let dupIds = 0;
  let dupHashes = 0;
  const seenHashes = new Set();
  const idsInOrder = [];
  const badRecords = [];
  for (const c of m.colliders) {
    const problems = [];
    if (ids.has(c.id)) dupIds += 1;
    ids.add(c.id);
    idsInOrder.push(c.id);
    if (seenHashes.has(c.hash)) dupHashes += 1;
    seenHashes.add(c.hash);

    if (c.type !== "obb") problems.push("type");
    if (c.source !== "track-visual") problems.push("source");
    if (!CLASSES.has(c.classification)) problems.push("classification");
    if (!STRUCTURE_CLASSES.has(c.structureClass)) problems.push("structureClass");
    if (typeof c.active !== "boolean") problems.push("active");

    const nums = [...c.center, ...c.half, ...c.size, c.vertical.bottom, c.vertical.top, c.vertical.height, c.vertical.groundY];
    if (!nums.every(Number.isFinite)) problems.push("finite");
    if (!(c.half[0] > 0 && c.half[1] > 0 && c.half[2] > 0)) problems.push("half-positive");
    if (c.half[0] < 0.009999 || c.half[2] < 0.009999) problems.push("half-min");
    for (let i = 0; i < 3; i++) {
      const len = Math.hypot(...c.axes[i]);
      if (!near(len, 1, 2e-6)) problems.push(`axis${i}-unit`);
    }
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
      const dot = c.axes[i][0] * c.axes[j][0] + c.axes[i][1] * c.axes[j][1] + c.axes[i][2] * c.axes[j][2];
      if (Math.abs(dot) > 1e-5) problems.push(`axis${i}${j}-ortho`);
    }
    for (let i = 0; i < 3; i++) if (!near(c.size[i], 2 * c.half[i], 2e-6)) problems.push(`size${i}`);
    if (!near(c.vertical.bottom, c.center[1] - c.half[1], 2e-6)) problems.push("vertical-bottom");
    if (!near(c.vertical.top, c.center[1] + c.half[1], 2e-6)) problems.push("vertical-top");
    if (!near(c.vertical.height, c.vertical.top - c.vertical.bottom, 2e-6)) problems.push("vertical-height");
    if (c.vertical.top <= c.vertical.bottom) problems.push("vertical-order");
    if (!(c.vertical.topAboveGround > BUILD_DEFAULTS.flushHeight)) problems.push("flush-rule");
    if (!(c.vertical.bottomAboveGround < BUILD_DEFAULTS.overheadClearance)) problems.push("overhead-rule");

    // world AABB must contain the fitted box and the component geometry
    const poly = colliderPoly(c);
    for (const p of poly) {
      if (p[0] < c.worldAabb.min[0] - 1e-4 || p[0] > c.worldAabb.max[0] + 1e-4 ||
        p[1] < c.worldAabb.min[2] - 1e-4 || p[1] > c.worldAabb.max[2] + 1e-4) problems.push("aabb-xz");
    }
    // the world AABB is the fitted box AABB; the collision column may start
    // below the component geometry (ground column)
    if (!near(c.vertical.bottom, c.worldAabb.min[1], 2e-6)) problems.push("aabb-y-bottom");
    if (c.vertical.bottom > c.worldAabb.min[1] + 1e-4) problems.push("aabb-y-bottom-order");
    if (!near(c.vertical.top, c.worldAabb.max[1], 2e-6)) problems.push("aabb-y-top");

    if (!(c.distanceToPath >= 0 && c.distanceToPath <= BUILD_DEFAULTS.regionDistance + 1e-3)) problems.push("distance-to-path");
    if (!(Number.isInteger(c.triangles) && c.triangles > 0)) problems.push("triangles");

    const draw = renderById.get(c.provenance.drawId);
    if (!draw) problems.push("draw-missing");
    else {
      if (c.provenance.indexRange[0] !== draw.firstIndex) problems.push("index-range-start");
      if (c.provenance.indexRange[1] !== draw.firstIndex + draw.indexCount) problems.push("index-range-end");
      if (c.provenance.indexCount !== draw.indexCount) problems.push("index-count");
      if (c.provenance.componentTriangles !== c.triangles) problems.push("component-triangles");
    }
    if (!Number.isInteger(c.provenance.componentIndex) || c.provenance.componentIndex < 0) problems.push("component-index");

    const { hash, ...rest } = c;
    if (hash !== `sha256:${sha256(stableStringify(rest))}`) problems.push("hash");
    if (c.active === false && (!c.exclusion || c.exclusion.rule !== "on-measured-path")) problems.push("exclusion");
    if (c.active === true && c.exclusion !== undefined) problems.push("active-exclusion");
    if (c.active === false) {
      if (!(c.exclusion.firstArc <= c.exclusion.lastArc)) problems.push("exclusion-arc-order");
      if (!(c.exclusion.samples > 0)) problems.push("exclusion-samples");
    }
    if (problems.length) badRecords.push({ id: c.id, problems });
  }
  check(`${prefix}colliders.uniqueIds`, dupIds === 0, dupIds);
  check(`${prefix}colliders.uniqueHashes`, dupHashes === 0, dupHashes);
  check(`${prefix}colliders.sorted`, idsInOrder.every((id, i) => i === 0 || idsInOrder[i - 1] < id));
  check(`${prefix}colliders.recordValid`, badRecords.length === 0, badRecords.slice(0, 10));
  check(`${prefix}colliders.count`, m.counts.colliders === m.colliders.length, `${m.counts.colliders}/${m.colliders.length}`);
  check(`${prefix}colliders.count.positive`, m.counts.colliders > 0, m.counts.colliders);
  check(`${prefix}colliders.activeCount`, m.counts.active === m.colliders.filter((c) => c.active).length, m.counts.active);
  check(`${prefix}colliders.inactiveCount`, m.counts.inactiveOnMeasuredPath === m.colliders.filter((c) => !c.active).length);
  check(`${prefix}colliders.triangles`, m.counts.triangles === m.colliders.reduce((n, c) => n + c.triangles, 0));
  check(`${prefix}colliders.activeTriangles`, m.counts.activeTriangles === m.colliders.filter((c) => c.active).reduce((n, c) => n + c.triangles, 0));
  check(`${prefix}profiles.roadside`, m.profiles.roadside.colliders === m.counts.active);
  check(`${prefix}profiles.allVisible`, m.profiles["all-visible"].colliders === m.counts.colliders);
  check(`${prefix}contentSha256`, m.contentSha256 === sha256(stableStringify(m.colliders)));

  // byte-level loader manifest
  check(`${prefix}loader.kind`, loader.kind === "map-props-manifest");
  check(`${prefix}loader.mapKey`, loader.mapKey === mapKey);
  check(`${prefix}loader.colliderFile`, loader.colliders.file === `colliders-${mapKey}.json`);
  check(`${prefix}loader.bytes`, loader.colliders.bytes === collidersBytes.length, `${loader.colliders.bytes}/${collidersBytes.length}`);
  check(`${prefix}loader.sha256`, loader.colliders.sha256 === sha256(collidersBytes));
  check(`${prefix}loader.contentSha256`, loader.colliders.contentSha256 === m.contentSha256);
  check(`${prefix}loader.counts`, loader.counts.colliders === m.counts.colliders && loader.counts.active === m.counts.active);
  check(`${prefix}loader.profiles`, loader.profiles.default === "roadside" && loader.profiles.roadside.colliders === m.counts.active);

  // ---- excluded rows and coverage ----
  const excludedReasons = {};
  let excludedOutOfRegion = 0;
  for (const e of m.excluded) {
    excludedReasons[e.reason] = (excludedReasons[e.reason] ?? 0) + 1;
    if (!EXCLUDE_REASONS.has(e.reason)) errors.push({ name: `${prefix}excluded.reason`, detail: e.reason });
    if (!(e.distanceToPath <= BUILD_DEFAULTS.regionDistance + 1e-3)) excludedOutOfRegion += 1;
    if (!Number.isInteger(e.triangles) && e.triangles !== undefined) errors.push({ name: `${prefix}excluded.triangles`, detail: e.id });
  }
  check(`${prefix}excluded.reasons`, EXCLUDE_REASONS.size === 6 && Object.keys(excludedReasons).every((k) => EXCLUDE_REASONS.has(k)), excludedReasons);
  check(`${prefix}excluded.inRegion`, excludedOutOfRegion === 0, excludedOutOfRegion);
  check(`${prefix}excluded.countMatch`, JSON.stringify(Object.fromEntries(Object.entries(excludedReasons).sort())) === JSON.stringify(Object.fromEntries(Object.entries(m.counts.excluded).sort())), { excludedReasons, counts: m.counts.excluded });
  check(`${prefix}coverage.componentsBalance`, m.coverage.componentsInRegion === m.coverage.componentsCollider + m.coverage.componentsExcluded, {
    inRegion: m.coverage.componentsInRegion, collider: m.coverage.componentsCollider, excluded: m.coverage.componentsExcluded,
  });
  check(`${prefix}coverage.componentsCollider`, m.coverage.componentsCollider === m.colliders.length);
  check(`${prefix}coverage.drawsWithCollider`, m.coverage.drawsWithCollider === new Set(m.colliders.map((c) => c.provenance.drawId)).size);
  check(`${prefix}coverage.triangles`, m.coverage.trianglesInRegion >= m.coverage.trianglesCollider && m.coverage.trianglesCollider === m.counts.triangles);
  const colliderIdSet = new Set(m.colliders.map((c) => c.id));
  check(`${prefix}coverage.passThroughReasons`, m.coverage.passThroughVerticalStructures.every((r) => EXCLUDE_REASONS.has(r.reason) && !colliderIdSet.has(r.id)));
  check(`${prefix}coverage.verticalBalance`, m.coverage.verticalStructuresInRegion === m.coverage.verticalStructuresWithCollider + m.coverage.passThroughVerticalStructures.length, {
    inRegion: m.coverage.verticalStructuresInRegion,
    collider: m.coverage.verticalStructuresWithCollider,
    passThrough: m.coverage.passThroughVerticalStructures.length,
  });
  const passCounts = m.coverage.passThroughVerticalStructures.reduce((acc, row) => {
    acc[row.reason] = (acc[row.reason] ?? 0) + 1;
    return acc;
  }, {});
  check(`${prefix}coverage.passThroughByReason`, JSON.stringify(Object.fromEntries(Object.entries(passCounts).sort())) === JSON.stringify(Object.fromEntries(Object.entries(m.coverage.passThroughByReason).sort())), { passCounts, recorded: m.coverage.passThroughByReason });
  const groundBandPassCounts = m.coverage.passThroughVerticalStructures.filter((r) => r.groundBand).reduce((acc, row) => {
    acc[row.reason] = (acc[row.reason] ?? 0) + 1;
    return acc;
  }, {});
  check(`${prefix}coverage.groundBandBalance`, m.coverage.groundBandVerticalStructuresInRegion === m.coverage.groundBandVerticalStructuresWithCollider + Object.values(groundBandPassCounts).reduce((a, b) => a + b, 0), {
    inRegion: m.coverage.groundBandVerticalStructuresInRegion,
    collider: m.coverage.groundBandVerticalStructuresWithCollider,
    passThrough: groundBandPassCounts,
  });
  check(`${prefix}coverage.groundBandPassThroughByReason`, JSON.stringify(Object.fromEntries(Object.entries(groundBandPassCounts).sort())) === JSON.stringify(Object.fromEntries(Object.entries(m.coverage.groundBandPassThroughByReason).sort())));
  const groundBandRecomputed = m.colliders.filter(
    (c) => c.provenance.verticalRatio !== null && c.provenance.verticalRatio >= 0.5 &&
      (c.provenance.componentMax[1] - c.provenance.componentMin[1]) >= 1.0 &&
      (c.vertical.geometryBottom - c.vertical.groundY) < BUILD_DEFAULTS.overheadClearance,
  ).length;
  check(`${prefix}coverage.groundBandColliders`, groundBandRecomputed === m.coverage.groundBandVerticalStructuresWithCollider, {
    recomputed: groundBandRecomputed, recorded: m.coverage.groundBandVerticalStructuresWithCollider,
  });

  const verticalInColliders = m.colliders.filter(
    (c) => c.provenance.verticalRatio !== null && c.provenance.verticalRatio >= 0.5 &&
      (c.provenance.componentMax[1] - c.provenance.componentMin[1]) >= 1.0,
  ).length;
  check(`${prefix}coverage.verticalStructures`, verticalInColliders === m.coverage.verticalStructuresWithCollider, {
    recomputed: verticalInColliders, recorded: m.coverage.verticalStructuresWithCollider,
  });

  const unclassified = m.colliders.filter((c) => c.classification === "unclassified");
  check(`${prefix}unclassified.list`, m.unclassified.length === unclassified.length);
  check(`${prefix}classification.censusDraws`, m.classification.textureCensus.reduce((n, r) => n + r.draws, 0) === pkg.render.draws.length);
  check(`${prefix}classification.structureCensus`, m.classification.structureClassCensus.reduce((n, r) => n + r.components, 0) === m.colliders.length);

  // ---- path clearance recomputed with the committed resolver ----
  const pathIndex = buildPathIndex(pkg.path);
  const worldAll = createWorld(m, { profile: "all-visible" });
  const worldRoadside = createWorld(m, { profile: "roadside" });
  check(`${prefix}resolver.roadsideColliders`, worldRoadside.colliders.length === m.counts.active, worldRoadside.colliders.length);
  check(`${prefix}resolver.allVisibleColliders`, worldAll.colliders.length === m.counts.colliders, worldAll.colliders.length);

  function blockedSamples(world) {
    const blocked = [];
    for (let i = 0; i < pkg.path.length; i++) {
      const a = pkg.path[Math.max(0, i - 1)];
      const b = pkg.path[Math.min(pkg.path.length - 1, i + 1)];
      const yaw = Math.atan2(b[1] - a[1], b[0] - a[0]);
      if (world.overlaps(pkg.path[i][0], pkg.path[i][1], yaw, pkg.pathGround[i], CAR_ENVELOPE)) blocked.push(i);
    }
    return blocked;
  }
  const allBlocked = blockedSamples(worldAll);
  const roadBlocked = blockedSamples(worldRoadside);
  check(`${prefix}path.allVisibleBlockedSamples`, allBlocked.length === m.path.allVisibleBlockedSamples, `${allBlocked.length}/${m.path.allVisibleBlockedSamples}`);
  check(`${prefix}path.roadsideBlockedSamples`, roadBlocked.length === m.path.defaultProfileBlockedSamples, `${roadBlocked.length}/${m.path.defaultProfileBlockedSamples}`);
  check(`${prefix}path.roadsideClear`, roadBlocked.length === 0, roadBlocked.length);
  check(`${prefix}path.length`, near(m.path.lengthM, pkg.layout.lengthM, 1e-6), `${m.path.lengthM}/${pkg.layout.lengthM}`);
  check(`${prefix}path.polylineLength`, near(m.path.polylineLengthM, pathIndex.lengthM, 1e-6), `${m.path.polylineLengthM}/${pathIndex.lengthM}`);
  check(`${prefix}path.renderRecordedLength`, m.path.renderRecordedFloat32LengthM === (pkg.render.layout.pointsFloat32?.lengthM ?? null), {
    recorded: m.path.renderRecordedFloat32LengthM, render: pkg.render.layout.pointsFloat32?.lengthM,
  });
  check(`${prefix}path.samples`, m.path.samples === pkg.layout.pointCount);

  // recompute the blocked arcs from the contact rows and compare
  const arcRows = m.onMeasuredPath
    .map((r) => ({ firstArc: r.firstArc, lastArc: r.lastArc, id: r.colliderId }))
    .sort((a, b) => (a.firstArc === b.firstArc ? a.lastArc - b.lastArc : a.firstArc - b.firstArc));
  const arcs = [];
  for (const row of arcRows) {
    const last = arcs[arcs.length - 1];
    if (last && row.firstArc <= last.lastArc + 0.5) {
      last.lastArc = Math.max(last.lastArc, row.lastArc);
      last.ids.add(row.id);
    } else arcs.push({ firstArc: row.firstArc, lastArc: row.lastArc, ids: new Set([row.id]) });
  }
  const arcsMatch = arcs.length === m.path.allVisibleBlockedArcs.length &&
    arcs.every((a, i) => {
      const b = m.path.allVisibleBlockedArcs[i];
      return near(a.firstArc, b.arcStart, 1e-6) && near(a.lastArc, b.arcEnd, 1e-6) && a.ids.size === b.colliders;
    });
  check(`${prefix}path.blockedArcs`, arcsMatch, { computed: arcs.map((a) => [a.firstArc, a.lastArc, a.ids.size]), recorded: m.path.allVisibleBlockedArcs.map((a) => [a.arcStart, a.arcEnd, a.colliders]) });
  check(`${prefix}path.arcColliderIdsInRows`, m.path.allVisibleBlockedArcs.every((a) => a.colliderIds.every((id) => m.onMeasuredPath.some((r) => r.colliderId === id))));
  check(`${prefix}path.onMeasuredRowsUnique`, new Set(m.onMeasuredPath.map((r) => r.colliderId)).size === m.onMeasuredPath.length);
  check(`${prefix}path.inactiveMatchesRows`, m.colliders.filter((c) => !c.active).length === m.onMeasuredPath.length);

  // independent min-clearance recomputation (roadside profile)
  let minD = Infinity;
  let minId = null;
  let minArc = null;
  const active = m.colliders.filter((c) => c.active);
  const activePolys = active.map((c) => [c, colliderPoly(c)]);
  for (let i = 0; i < pkg.path.length; i++) {
    const a = pkg.path[Math.max(0, i - 1)];
    const b = pkg.path[Math.min(pkg.path.length - 1, i + 1)];
    const yaw = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const car = carPoly(pkg.path[i][0], pkg.path[i][1], yaw);
    const y0 = pkg.pathGround[i];
    const y1 = y0 + CAR_ENVELOPE.height;
    for (const [c, poly] of activePolys) {
      if (c.vertical.top <= y0 || c.vertical.bottom >= y1) continue;
      // cheap AABB reject
      if (c.worldAabb.max[0] < pkg.path[i][0] - 6 || c.worldAabb.min[0] > pkg.path[i][0] + 6) continue;
      if (c.worldAabb.max[2] < pkg.path[i][1] - 6 || c.worldAabb.min[2] > pkg.path[i][1] + 6) continue;
      const d = polyDist(car, poly);
      if (d < minD) { minD = d; minId = c.id; minArc = pathIndex.cumulative[i]; }
    }
  }
  check(`${prefix}path.minClearance`, m.path.minClearanceM !== null && near(round6(minD), m.path.minClearanceM, 2e-6), {
    recomputed: round6(minD), recorded: m.path.minClearanceM,
  });
  check(`${prefix}path.minClearanceCollider`, minId === m.path.minClearanceColliderId, { recomputed: minId, recorded: m.path.minClearanceColliderId });

  // ---- component-split cross-check against the committed implementation ----
  const accessor = meshAccessor({
    positions: pkg.positions,
    indices: pkg.indices,
    vertexCount: pkg.vertexCount,
    indexCount: pkg.indexCount,
  });
  const colliderByComponent = new Map();
  for (const c of m.colliders) {
    colliderByComponent.set(`${c.provenance.drawId}#${c.provenance.componentIndex}`, c);
  }
  const colliderDrawIds = [...new Set(m.colliders.map((c) => c.provenance.drawId))];
  const drawIdsToCheck = new Set(colliderDrawIds.slice(0, 60));
  for (const d of pkg.render.draws) {
    if (drawIdsToCheck.size >= 80) break;
    if (!drawIdsToCheck.has(d.drawId) && pkg.render.draws.indexOf(d) % Math.max(1, Math.floor(pkg.render.draws.length / 20)) === 0) {
      drawIdsToCheck.add(d.drawId);
    }
  }
  const drawsToCheck = pkg.render.draws.filter((d) => drawIdsToCheck.has(d.drawId));
  let componentMismatch = 0;
  let colliderMismatch = 0;
  let boxFitMismatch = 0;
  let boxFitChecked = 0;
  for (const draw of drawsToCheck) {
    const committed = committedComponents(accessor, { id: draw.drawId, indexOffset: draw.firstIndex, indexCount: draw.indexCount });
    const local = localComponents(pkg.positions, pkg.indices, draw.firstIndex, draw.indexCount);
    if (committed.length !== local.length) { componentMismatch += 1; continue; }
    for (let i = 0; i < committed.length; i++) {
      const a = committed[i];
      const b = local[i];
      if (a.triangles !== b.triangles || !a.min.every((v, k) => near(v, b.min[k], 1e-6)) || !a.max.every((v, k) => near(v, b.max[k], 1e-6)) ||
        a.vertices.length !== b.vertices.length || a.vertices.some((v, k) => v !== b.vertices[k])) {
        componentMismatch += 1;
        break;
      }
      const rec = colliderByComponent.get(`${draw.drawId}#${i}`);
      if (rec) {
        if (!rec.provenance.componentMin.every((v, k) => near(v, round6(a.min[k]), 1e-6)) ||
          !rec.provenance.componentMax.every((v, k) => near(v, round6(a.max[k]), 1e-6)) ||
          rec.triangles !== a.triangles) colliderMismatch += 1;

        // independent box fit from the committed component hull
        boxFitChecked += 1;
        const hull = convexHull2D(a.vertices.map((v) => [pkg.positions[3 * v], pkg.positions[3 * v + 2]]));
        const rect = minAreaRect2D(hull);
        const minHalf = BUILD_DEFAULTS.minColliderThickness / 2;
        const hu = round6(Math.max(rect.half[0], minHalf));
        const hv = round6(Math.max(rect.half[1], minHalf));
        if (!near(rec.half[0], hu, 2e-6) || !near(rec.half[2], hv, 2e-6) ||
          !near(rec.provenance.boxAngleRad, round6(rect.angle), 2e-6)) boxFitMismatch += 1;
      }
    }
  }
  check(`${prefix}components.sampled`, drawsToCheck.length >= 40, drawsToCheck.length);
  check(`${prefix}components.matchCommitted`, componentMismatch === 0, componentMismatch);
  check(`${prefix}components.colliderBounds`, colliderMismatch === 0, colliderMismatch);
  check(`${prefix}components.boxFit`, boxFitChecked > 0 && boxFitMismatch === 0, { checked: boxFitChecked, mismatch: boxFitMismatch });

  return { pkg, manifest: m, collidersBytes, loaderBytes };
}

// ---------------------------------------------------------------------------
// resolver-suite verification
// ---------------------------------------------------------------------------
function verifyResolve(maps) {
  const resolveRel = "_work/map-props/resolve.json";
  const resolveBytes = fs.readFileSync(path.join(ROOT, resolveRel));
  const res = JSON.parse(resolveBytes.toString("utf8"));
  check("resolve.kind", res.schema === "blur.map-props.resolve/1");
  check("resolve.maps", Object.keys(res.maps).length === Object.keys(MAPS).length);
  for (const mapKey of Object.keys(MAPS)) {
    const r = res.maps[mapKey];
    const manifestBytes = maps[mapKey].collidersBytes;
    check(`resolve.${mapKey}.manifestSha256`, r.manifest.sha256 === sha256(manifestBytes));
    check(`resolve.${mapKey}.spawnClear.roadside`, r.spawn.roadside.clear === true, r.spawn.roadside);
    check(`resolve.${mapKey}.spawnClear.allVisible`, r.spawn["all-visible"].clear === true, r.spawn["all-visible"]);
    check(`resolve.${mapKey}.headOn.isolatedStops`, r.headOn.directions.filter((d) => d.stops).length === 2, r.headOn.directions.map((d) => d.stops));
    check(`resolve.${mapKey}.headOn.noPass`, r.headOn.directions.every((d) => d.passedTarget === false));
    check(`resolve.${mapKey}.headOn.gap`, r.headOn.directions.every((d) => d.endGap <= 0.02), r.headOn.directions.map((d) => d.endGap));
    check(`resolve.${mapKey}.headOn.fullBlocked`, r.headOn.fullManifest ? (r.headOn.fullManifest.targetContacted === true && r.headOn.fullManifest.passedTarget === false) : false, r.headOn.fullManifest);
    check(`resolve.${mapKey}.glance.contact`, r.glance && r.glance.targetContacts > 0, r.glance?.targetContacts);
    check(`resolve.${mapKey}.glance.retained`, r.glance && r.glance.speedRetained >= 0.4, r.glance?.speedRetained);
    check(`resolve.${mapKey}.glance.residual`, r.glance && r.glance.residual <= 0.02, r.glance?.residual);
    check(`resolve.${mapKey}.noTunnel`, r.noTunnel.pass === r.noTunnel.candidates && r.noTunnel.candidates === 8, `${r.noTunnel.pass}/${r.noTunnel.candidates}`);
    check(`resolve.${mapKey}.pathDrive.roadside`, r.pathDrive.roadside.contactCount === 0, r.pathDrive.roadside.contactCount);
    check(`resolve.${mapKey}.pathDrive.roadsidePoses`, r.pathDrive.roadside.contactsAt === 0, r.pathDrive.roadside.contactsAt);
    check(`resolve.${mapKey}.determinism`, r.determinism.match === true && r.determinism.firstHash === r.determinism.secondHash);
    const allDrive = r.pathDrive.allVisible;
    const recorded = maps[mapKey].manifest.path.allVisibleBlockedArcs;
    if (recorded.length === 0) {
      check(`resolve.${mapKey}.pathDrive.allVisibleClear`, allDrive.contactCount === 0, allDrive.contactCount);
    } else {
      check(`resolve.${mapKey}.pathDrive.allVisibleContacts`, allDrive.contactCount > 0, allDrive.contactCount);
      const arcsMatch = allDrive.arcs.length === recorded.length &&
        allDrive.arcs.every((a, i) => near(a.arcStart, recorded[i].arcStart, 0.5) && near(a.arcEnd, recorded[i].arcEnd, 0.5));
      check(`resolve.${mapKey}.pathDrive.arcsMatch`, arcsMatch, { computed: allDrive.arcs, recorded });
    }
    check(`resolve.${mapKey}.residual`, allDrive.residualMax <= 1e-6, allDrive.residualMax);
  }
}

// ---------------------------------------------------------------------------
// deterministic rebuild
// ---------------------------------------------------------------------------
function verifyDeterminism() {
  const out1 = path.join(OUT_DIR, ".verify-build-1");
  const out2 = path.join(OUT_DIR, ".verify-build-2");
  for (const dir of [out1, out2]) fs.rmSync(dir, { recursive: true, force: true });
  const builder = path.join(ROOT, "probes", "map-props", "tools", "build_colliders.mjs");
  const run = (out) => {
    execFileSync(process.execPath, [builder, "--map", "all", "--out", out], { cwd: ROOT, stdio: "pipe" });
  };
  run(out1);
  run(out2);
  const aggregates = [];
  for (const out of [out1, out2]) {
    const files = ["colliders-amboy.json", "colliders-gracia.json", "manifest-amboy.json", "manifest-gracia.json"];
    const hashes = {};
    for (const f of files) hashes[f] = `sha256:${sha256(fs.readFileSync(path.join(out, f)))}`;
    aggregates.push({ files: hashes, aggregate: `sha256:${sha256(files.map((f) => hashes[f]).join("\n"))}` });
  }
  check("determinism.build1", aggregates[0].aggregate === `sha256:${sha256(["colliders-amboy.json", "colliders-gracia.json", "manifest-amboy.json", "manifest-gracia.json"].map((f) => `sha256:${sha256(fs.readFileSync(path.join(OUT_DIR, f)))}`).join("\n"))}`);
  check("determinism.rebuildMatch", aggregates[0].aggregate === aggregates[1].aggregate, aggregates.map((a) => a.aggregate));
  const committedHashes = {};
  for (const f of ["colliders-amboy.json", "colliders-gracia.json", "manifest-amboy.json", "manifest-gracia.json"]) {
    committedHashes[f] = `sha256:${sha256(fs.readFileSync(path.join(OUT_DIR, f)))}`;
  }
  check("determinism.committedMatch", Object.entries(committedHashes).every(([f, h]) => aggregates[0].files[f] === h), { committedHashes, rebuilt: aggregates[0].files });
  for (const dir of [out1, out2]) fs.rmSync(dir, { recursive: true, force: true });
  return { builds: 2, aggregates: aggregates.map((a) => a.aggregate), committedHashes };
}

// ---------------------------------------------------------------------------
const mapResults = {};
for (const mapKey of Object.keys(MAPS)) mapResults[mapKey] = verifyMap(mapKey);
verifyResolve(mapResults);
const determinism = verifyDeterminism();

check("verify.checkCount>=100", checks.length >= 100, checks.length);

const failures = checks.filter((c) => !c.ok);
const verify = {
  schema: "blur.map-props.verify/1",
  kind: "map-props-verifier",
  version: 1,
  status: failures.length === 0 ? "PASS" : "FAIL",
  checks: checks.length,
  errors: failures.length,
  firstErrors: failures.slice(0, 20),
  maps: Object.fromEntries(Object.keys(MAPS).map((k) => [k, {
    manifest: {
      path: `_work/map-props/colliders-${k}.json`,
      bytes: mapResults[k].collidersBytes.length,
      sha256: sha256(mapResults[k].collidersBytes),
      contentSha256: mapResults[k].manifest.contentSha256,
    },
    loader: {
      path: `_work/map-props/manifest-${k}.json`,
      bytes: mapResults[k].loaderBytes.length,
      sha256: sha256(mapResults[k].loaderBytes),
    },
    counts: mapResults[k].manifest.counts,
    path: {
      lengthM: mapResults[k].manifest.path.lengthM,
      allVisibleBlockedSamples: mapResults[k].manifest.path.allVisibleBlockedSamples,
      allVisibleBlockedArcs: mapResults[k].manifest.path.allVisibleBlockedArcs,
      defaultProfileBlockedSamples: mapResults[k].manifest.path.defaultProfileBlockedSamples,
      minClearanceM: mapResults[k].manifest.path.minClearanceM,
    },
  }])),
  determinism,
  checksDetail: checks,
};
const text = `${JSON.stringify(verify, null, 1)}\n`;
fs.writeFileSync(path.join(OUT_DIR, "verify.json"), text);

console.log(`checks ${verify.checks}, errors ${verify.errors}, status ${verify.status}`);
for (const f of failures.slice(0, 20)) console.log(`  FAIL ${f.name}: ${JSON.stringify(f.detail)}`);
for (const k of Object.keys(MAPS)) {
  const v = verify.maps[k];
  console.log(`  ${k}: ${v.counts.colliders} colliders / ${v.counts.active} active; blocked ${v.path.allVisibleBlockedSamples} samples in ${v.path.allVisibleBlockedArcs.length} arcs; roadside ${v.path.defaultProfileBlockedSamples}`);
}
console.log(`determinism ${determinism.aggregates[0]} == ${determinism.aggregates[1]}`);
console.log(`wrote _work/map-props/verify.json  ${Buffer.byteLength(text)} B  sha256:${sha256(Buffer.from(text))}`);
process.exitCode = verify.status === "PASS" ? 0 : 1;
