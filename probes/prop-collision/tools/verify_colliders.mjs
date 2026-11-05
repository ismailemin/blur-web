#!/usr/bin/env node
/*
 * verify_colliders.mjs — deterministic gate for the prop-collision probe.
 *
 * Checks the manifest schema, provenance, active/inactive consistency and
 * reproducibility; sweeps the 310 m course; runs the resolver tests (head-on,
 * glancing, 31 m/s no-tunnelling, deterministic replay) and a no-collision
 * baseline; and writes _work/prop-collision/verify.json.
 *
 * Exit code 0 = every check passed.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildColliderManifest, stableStringify, CAR_ENVELOPE } from "../lib/collider-build.mjs";
import { createWorld } from "../lib/resolver.mjs";
import { makeGroundSampler } from "../lib/geometry.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const GEOMETRY_PATH = path.join(ROOT, "_work", "e1-drive", "geometry.json");
const PATH_PATH = path.join(ROOT, "_work", "drivable-path", "path.json");
const MANIFEST_PATH = path.join(ROOT, "_work", "prop-collision", "colliders.json");
const OUT_PATH = path.join(ROOT, "_work", "prop-collision", "verify.json");
const LOG_DIR = path.join(ROOT, "_work", "logs", "prop-collision");

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const checks = [];
let failures = 0;
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${detail}`}`);
}

const geometryBytes = fs.readFileSync(GEOMETRY_PATH);
const pathBytes = fs.readFileSync(PATH_PATH);
const manifestBytes = fs.readFileSync(MANIFEST_PATH);
const geometry = JSON.parse(geometryBytes);
const pathData = JSON.parse(pathBytes);
const manifest = JSON.parse(manifestBytes);
const points = pathData.course.points;
const arcPerSample = pathData.course.length / (points.length - 1);
const groundAt = makeGroundSampler(geometry.collisionSurface.mesh);

function yawAt(i) {
  const a = points[Math.max(0, i - 1)];
  const b = points[Math.min(points.length - 1, i + 1)];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

const world = createWorld(manifest, { profile: "roadside" });
const allWorld = createWorld(manifest, { profile: "all-visible" });

// ---------------------------------------------------------------------------
// 1. Manifest integrity and reproducibility
// ---------------------------------------------------------------------------
check("manifest kind", manifest.kind === "prop-collision-colliders", manifest.kind);
check("manifest version", manifest.version === 1, manifest.version);
check("geometry input pinned", manifest.inputs.geometry.sha256 === sha256(geometryBytes), manifest.inputs.geometry.sha256);
check("path input pinned", manifest.inputs.path.sha256 === sha256(pathBytes), manifest.inputs.path.sha256);
check("geometry version 6", manifest.inputs.geometry.version === 6);
check("car envelope", manifest.carEnvelope.length === 2.98 && manifest.carEnvelope.width === 1.68 && manifest.carEnvelope.height === 1.35);
check("scope labels", manifest.scope.visibleMeshApproximation === true && manifest.scope.retailCollision === false && manifest.scope.collisionSurfaceUsedAsCollider === false && manifest.scope.gameClaim === false);
check("collider count", manifest.counts.colliders === manifest.colliders.length, `${manifest.counts.colliders}`);
check("active count", manifest.counts.active === manifest.colliders.filter((c) => c.active).length);
check("inactive count", manifest.counts.inactiveOnMeasuredCourse === manifest.colliders.filter((c) => !c.active).length);
check("level instance count", manifest.counts.levelInstances === 8, `${manifest.counts.levelInstances}`);
check("all classes known", manifest.colliders.every((c) => ["vehicle-sized-wreck", "building-sized", "vehicle", "building", "structure", "unclassified"].includes(c.classification)));
check("no unclassified colliders", manifest.unclassified.length === 0, `${manifest.unclassified.length}`);
check("has both profiles", !!manifest.profiles.roadside && !!manifest.profiles["all-visible"]);
check("content hash", manifest.contentSha256 === sha256(stableStringify(manifest.colliders)), `sha256:${manifest.contentSha256.slice(0, 16)}…`);

const ids = manifest.colliders.map((c) => c.id);
check("ids unique", new Set(ids).size === ids.length);
check("ids sorted", ids.every((id, i) => i === 0 || ids[i - 1] < id));

let finiteOk = true;
let obbValid = true;
let boundsValid = true;
let reasonOk = true;
let hashOk = true;
let sizeOk = true;
for (const c of manifest.colliders) {
  const { hash, ...withoutHash } = c;
  if (hash !== `sha256:${sha256(stableStringify(withoutHash))}`) hashOk = false;
  if (!c.size || !near(c.size[0], c.half[0] * 2, 1e-5) || !near(c.size[1], c.half[1] * 2, 1e-5) || !near(c.size[2], c.half[2] * 2, 1e-5)) sizeOk = false;
  const nums = [...c.center, ...c.half, ...c.axes.flat(), c.vertical.bottom, c.vertical.top, c.distanceToCourse];
  if (!nums.every(Number.isFinite)) finiteOk = false;
  if (!(c.half[0] > 0 && c.half[1] > 0 && c.half[2] > 0)) obbValid = false;
  if (!(c.vertical.top > c.vertical.bottom)) obbValid = false;
  if (c.type !== "obb") obbValid = false;
  if (c.distanceToCourse < -1e-6) boundsValid = false;
  if (!c.classificationReason || !c.provenance) reasonOk = false;
  for (let k = 0; k < 3; k++) {
    const a = c.axes[k];
    const len = Math.hypot(a[0], a[1], a[2]);
    if (Math.abs(len - 1) > 1e-6) obbValid = false;
  }
  const dot01 = c.axes[0][0] * c.axes[1][0] + c.axes[0][1] * c.axes[1][1] + c.axes[0][2] * c.axes[1][2];
  const dot02 = c.axes[0][0] * c.axes[2][0] + c.axes[0][1] * c.axes[2][1] + c.axes[0][2] * c.axes[2][2];
  const dot12 = c.axes[1][0] * c.axes[2][0] + c.axes[1][1] * c.axes[2][1] + c.axes[1][2] * c.axes[2][2];
  if (Math.abs(dot01) > 1e-5 || Math.abs(dot02) > 1e-5 || Math.abs(dot12) > 1e-5) obbValid = false;
}
check("all collider numbers finite", finiteOk);
check("all OBBs valid (positive extents, orthonormal axes)", obbValid);
check("distance to course non-negative", boundsValid);
check("classification reason + provenance on every collider", reasonOk);
check("per-collider hash matches its record", hashOk);
check("size equals 2 x half extent", sizeOk);

// Recompute the manifest in memory: same inputs must produce the same collider
// array and content hash.
const rebuilt = buildColliderManifest(geometry, pathData);
check("recomputed content hash", rebuilt.contentSha256 === manifest.contentSha256, `sha256:${rebuilt.contentSha256.slice(0, 16)}…`);
check("recomputed collider array byte-identical", stableStringify(rebuilt.colliders) === stableStringify(manifest.colliders));
check(
  "recomputed counts identical",
  stableStringify(rebuilt.counts) === stableStringify(manifest.counts),
);
check(
  "recomputed road conflict identical",
  stableStringify(rebuilt.road.allVisibleBlockedArcs) === stableStringify(manifest.road.allVisibleBlockedArcs),
);

// Active flags must match the measured-line overlap exactly.
let activeOnLine = 0;
let inactiveOffLine = 0;
for (let i = 0; i < points.length; i++) {
  const yaw = yawAt(i);
  const g = groundAt(points[i][0], points[i][1]);
  const hits = allWorld.contactsAll(points[i][0], points[i][1], yaw, g.y, CAR_ENVELOPE);
  for (const h of hits) {
    const c = manifest.colliders.find((x) => x.id === h.colliderId);
    if (c.active) activeOnLine += 1;
  }
}
const inactiveIds = new Set(manifest.colliders.filter((c) => !c.active).map((c) => c.id));
const seenInactive = new Set();
for (let i = 0; i < points.length; i++) {
  const yaw = yawAt(i);
  const g = groundAt(points[i][0], points[i][1]);
  const hits = allWorld.contactsAll(points[i][0], points[i][1], yaw, g.y, CAR_ENVELOPE);
  for (const h of hits) if (inactiveIds.has(h.colliderId)) seenInactive.add(h.colliderId);
}
for (const id of inactiveIds) if (!seenInactive.has(id)) inactiveOffLine += 1;
check("no active collider overlaps the measured line", activeOnLine === 0, `${activeOnLine} overlaps`);
check("every inactive collider overlaps the measured line", inactiveOffLine === 0, `${inactiveOffLine} not on line`);

// ---------------------------------------------------------------------------
// 2. Course sweeps
// ---------------------------------------------------------------------------
let roadsideBlocked = 0;
for (let i = 0; i < points.length; i++) {
  const yaw = yawAt(i);
  const g = groundAt(points[i][0], points[i][1]);
  if (world.deepestContact(points[i][0], points[i][1], yaw, g.y, CAR_ENVELOPE)) roadsideBlocked += 1;
}
check("roadside profile leaves the 310 m line clear", roadsideBlocked === 0, `${roadsideBlocked}/${points.length} samples blocked`);

const allBlocked = [];
for (let i = 0; i < points.length; i++) {
  const yaw = yawAt(i);
  const g = groundAt(points[i][0], points[i][1]);
  const hit = allWorld.deepestContact(points[i][0], points[i][1], yaw, g.y, CAR_ENVELOPE);
  if (hit) allBlocked.push({ sample: i, arc: i * arcPerSample, id: hit.colliderId });
}
check("all-visible profile blocks the committed line at 4 arcs", allBlocked.length > 0 && allWorld.colliders.length === manifest.counts.colliders, `${allBlocked.length}/${points.length} samples blocked, ${allWorld.colliders.length} colliders`);

// Corridor check: every 0.5 m, at least one car pose within +/-2.16 m of the
// centreline (the 6 m gate width minus the car half-width) is clear, and a
// continuous path exists with <= 1.2 m lateral change per 0.5 m.
const LATERAL = [];
for (let v = -2.16; v <= 2.1601; v += 0.12) LATERAL.push(+v.toFixed(2));
const corridorRows = [];
for (let i = 0; i < points.length; i += 2) {
  const yaw = yawAt(i);
  const nx = -Math.sin(yaw);
  const nz = Math.cos(yaw);
  const g = groundAt(points[i][0], points[i][1]);
  let clearCount = 0;
  for (const off of LATERAL) {
    if (!world.deepestContact(points[i][0] + nx * off, points[i][1] + nz * off, yaw, g.y, CAR_ENVELOPE)) clearCount += 1;
  }
  corridorRows.push(clearCount);
}
check("6 m gate corridor has a clear car pose at every 0.5 m row", corridorRows.every((n) => n > 0), `min clear ${Math.min(...corridorRows)}/${LATERAL.length}`);

// ---------------------------------------------------------------------------
// 3. Resolver tests
// ---------------------------------------------------------------------------
function integrate(state, ticks, dt = 1 / 60) {
  const s = { ...state };
  for (let t = 0; t < ticks; t++) {
    s.x += s.vx * dt;
    s.z += s.vz * dt;
    s.yaw = Math.hypot(s.vx, s.vz) > 1e-9 ? Math.atan2(s.vz, s.vx) : s.yaw;
  }
  return s;
}

function supportAlong(c, dx, dz) {
  const ux = c.axes[0][0];
  const uz = c.axes[0][2];
  const vx = c.axes[2][0];
  const vz = c.axes[2][2];
  const lu = Math.hypot(ux, uz);
  const lv = Math.hypot(vx, vz);
  return c.half[0] * lu * Math.abs((ux * dx + uz * dz) / lu) + c.half[2] * lv * Math.abs((vx * dx + vz * dz) / lv);
}

function findApproach(c, worldRef, minDistance) {
  const dirs = [];
  for (let k = 0; k < 32; k++) dirs.push((k * Math.PI) / 16);
  for (const a of dirs) {
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const support = supportAlong(c, dx, dz);
    const startDist = support + minDistance;
    const sx = c.center[0] + dx * startDist;
    const sz = c.center[2] + dz * startDist;
    const yaw = Math.atan2(-dz, -dx);
    const baseY = c.vertical.groundY;
    if (worldRef.overlaps(sx, sz, yaw, baseY, CAR_ENVELOPE)) continue;
    let first = null;
    for (let t = 0; t <= minDistance; t += 0.25) {
      const px = sx - dx * t;
      const pz = sz - dz * t;
      const h = worldRef.deepestContact(px, pz, yaw, baseY, CAR_ENVELOPE);
      if (h) {
        first = h;
        break;
      }
    }
    if (first && first.colliderId === c.id) {
      return { dx, dz, sx, sz, yaw, baseY, startDist, support, angle: a };
    }
  }
  return null;
}

const headTarget = manifest.colliders.find((c) => c.id === "level.instance.00");
const headApproach = headTarget ? findApproach(headTarget, world, 12) : null;
check("head-on target found", !!headApproach, headTarget ? `${headTarget.id} (${headTarget.classification})` : "missing");

let headRun = null;
let headBaseline = null;
if (headApproach && headTarget) {
  const start = {
    x: headApproach.sx,
    z: headApproach.sz,
    y: headApproach.baseY,
    yaw: headApproach.yaw,
    vx: -headApproach.dx * 31,
    vz: -headApproach.dz * 31,
  };
  let s = { ...start };
  const trace = [];
  let maxPen = 0;
  const contactIds = new Set();
  let substeps = 0;
  for (let t = 0; t < 300; t++) {
    const res = world.step({ ...s }, { dt: 1 / 60 });
    s = res.state;
    substeps = Math.max(substeps, res.substeps);
    maxPen = Math.max(maxPen, res.maxPenetration);
    for (const id of res.contactIds) contactIds.add(id);
    trace.push({ tick: t, x: r6(s.x), z: r6(s.z), speed: r6(Math.hypot(s.vx, s.vz)), contacts: res.contactIds.length });
  }
  const carSupport = CAR_ENVELOPE.length / 2;
  const r = Math.hypot(s.x - headTarget.center[0], s.z - headTarget.center[2]);
  const gap = r - headApproach.support - carSupport;
  const traveled = Math.hypot(s.x - start.x, s.z - start.z);
  const baseline = integrate(start, 300);
  const baselineR = Math.hypot(baseline.x - headTarget.center[0], baseline.z - headTarget.center[2]);
  const baselineGap = baselineR - headApproach.support - carSupport;
  const headResidual = world.deepestContact(s.x, s.z, s.yaw, s.y, CAR_ENVELOPE);
  const headOnStartSide = (s.x - headTarget.center[0]) * headApproach.dx + (s.z - headTarget.center[2]) * headApproach.dz > 0;
  const baselineOnStartSide = (baseline.x - headTarget.center[0]) * headApproach.dx + (baseline.z - headTarget.center[2]) * headApproach.dz > 0;
  headRun = {
    target: headTarget.id,
    classification: headTarget.classification,
    approachAngle: r6(headApproach.angle),
    start: { x: r6(start.x), z: r6(start.z), speed: 31 },
    final: { x: r6(s.x), z: r6(s.z), speed: r6(Math.hypot(s.vx, s.vz)), gapToTarget: r6(gap), traveled: r6(traveled) },
    maxPenetration: r6(maxPen),
    contactIds: [...contactIds].sort(),
    maxSubsteps: substeps,
    baseline: { traveled: r6(Math.hypot(baseline.x - start.x, baseline.z - start.z)), gapToTarget: r6(baselineGap), passedThrough: !baselineOnStartSide },
    trace,
  };
  check("head-on stops outside the target", gap >= -0.02 && headOnStartSide, `gap ${gap.toFixed(3)} m, start side ${headOnStartSide}`);
  check("head-on final speed ≈ 0", Math.hypot(s.vx, s.vz) < 0.5, `${Math.hypot(s.vx, s.vz).toFixed(3)} m/s`);
  check("head-on penetration bounded by one substep", maxPen < 0.09, `${maxPen.toFixed(4)} m`);
  check("head-on final pose has no residual overlap", headResidual === null, headResidual ? `${headResidual.colliderId} ${headResidual.penetration.toFixed(4)}` : "clear");
  check("head-on contact is the target", contactIds.has(headTarget.id), [...contactIds].join(","));
  check("head-on baseline passes through", !baselineOnStartSide, `baseline on start side ${baselineOnStartSide}, gap ${baselineGap.toFixed(3)} m`);
}

// On-course prop under the all-visible profile: the 95 inactive components are
// not decorative data — enabling them stops the car on the measured line.
let onCourseCollision = null;
{
  const pipe = manifest.colliders.find((c) => c.id === "river.block56.node289.draw.95.component.003");
  const approach = pipe ? findApproach(pipe, allWorld, 8) : null;
  if (pipe && approach) {
    let s = {
      x: approach.sx,
      z: approach.sz,
      y: approach.baseY,
      yaw: approach.yaw,
      vx: -approach.dx * 20,
      vz: -approach.dz * 20,
    };
    let maxPen = 0;
    const contactIds = new Set();
    for (let t = 0; t < 150; t++) {
      const res = allWorld.step({ ...s }, { dt: 1 / 60 });
      s = res.state;
      maxPen = Math.max(maxPen, res.maxPenetration);
      for (const id of res.contactIds) contactIds.add(id);
    }
    const r = Math.hypot(s.x - pipe.center[0], s.z - pipe.center[2]);
    const gap = r - approach.support - CAR_ENVELOPE.length / 2;
    const residual = allWorld.deepestContact(s.x, s.z, s.yaw, s.y, CAR_ENVELOPE);
    onCourseCollision = {
      target: pipe.id,
      texture: pipe.provenance.texture,
      profile: "all-visible",
      finalSpeed: r6(Math.hypot(s.vx, s.vz)),
      gapToTarget: r6(gap),
      maxPenetration: r6(maxPen),
      contactIds: [...contactIds].sort(),
    };
    check("all-visible: an on-course pipe stops the car", contactIds.has(pipe.id) && gap >= -0.02, `gap ${gap.toFixed(3)} m`);
    check("all-visible: on-course contact leaves no residual overlap", residual === null, residual ? `${residual.colliderId}` : "clear");
  }
}

// Glancing: drive alongside the longest active wall at 5 degrees of incidence.
// The start is beside the wall with a 0.35 m gap; the inward component closes
// the gap, the side contact resolves laterally, and the car slides.
let glanceRun = null;
{
  const wall = manifest.colliders
    .filter((c) => c.active && c.half[0] >= 4 && c.vertical.height >= 0.5)
    .sort((a, b) => (b.half[0] === a.half[0] ? (a.id < b.id ? -1 : 1) : b.half[0] - a.half[0]))[0];
  if (wall) {
    const ux = wall.axes[0][0];
    const uz = wall.axes[0][2];
    const vx = wall.axes[2][0];
    const vz = wall.axes[2][2];
    const sign = 1;
    const angle = (5 * Math.PI) / 180;
    const dx = ux * sign * Math.cos(angle) - vx * Math.sin(angle);
    const dz = uz * sign * Math.cos(angle) - vz * Math.sin(angle);
    const gapOff = wall.half[2] + CAR_ENVELOPE.width / 2 + 0.35;
    const sx = wall.center[0] + ux * sign * (-wall.half[0] + 1.6) + vx * gapOff;
    const sz = wall.center[2] + uz * sign * (-wall.half[0] + 1.6) + vz * gapOff;
    const yaw = Math.atan2(dz, dx);
    let s = { x: sx, z: sz, y: wall.vertical.groundY, yaw, vx: dx * 20, vz: dz * 20 };
    const initial = Math.hypot(s.vx, s.vz);
    const startTangent = s.vx * (ux * sign) + s.vz * (uz * sign);
    let maxPen = 0;
    const contactIds = new Set();
    const trace = [];
    for (let t = 0; t < 150; t++) {
      const res = world.step({ ...s }, { dt: 1 / 60 });
      s = res.state;
      maxPen = Math.max(maxPen, res.maxPenetration);
      for (const id of res.contactIds) contactIds.add(id);
      if (t % 10 === 0 || t === 149) trace.push({ tick: t, x: r6(s.x), z: r6(s.z), speed: r6(Math.hypot(s.vx, s.vz)), contacts: res.contactIds.length });
    }
    const finalSpeed = Math.hypot(s.vx, s.vz);
    const tangentSpeed = s.vx * (ux * sign) + s.vz * (uz * sign);
    const baseline = integrate({ x: sx, z: sz, y: wall.vertical.groundY, yaw, vx: dx * 20, vz: dz * 20 }, 150);
    glanceRun = {
      target: wall.id,
      classification: wall.classification,
      texture: wall.provenance.texture,
      incidenceDeg: 5,
      initialSpeed: initial,
      startTangentSpeed: r6(startTangent),
      finalSpeed: r6(finalSpeed),
      finalTangentSpeed: r6(tangentSpeed),
      retainedTangentFraction: r6(tangentSpeed / startTangent),
      maxPenetration: r6(maxPen),
      contactIds: [...contactIds].sort(),
      baselineTraveled: r6(Math.hypot(baseline.x - sx, baseline.z - sz)),
      trace,
    };
    const glanceResidual = world.deepestContact(s.x, s.z, s.yaw, s.y, CAR_ENVELOPE);
    check("glancing hit records a contact with the wall", contactIds.has(wall.id), [...contactIds].join(","));
    check("glancing hit slides (tangential speed retained)", tangentSpeed > startTangent * 0.8 && finalSpeed > 10, `${finalSpeed.toFixed(2)} m/s (${(100 * tangentSpeed / startTangent).toFixed(1)}%)`);
    check("glancing penetration bounded by one substep", maxPen < 0.09, `${maxPen.toFixed(4)} m`);
    check("glancing final pose has no residual overlap", glanceResidual === null, glanceResidual ? `${glanceResidual.colliderId} ${glanceResidual.penetration.toFixed(4)}` : "clear");
  }
}

// 31 m/s no-tunnelling against the thinnest active colliders with a clear
// approach.  The 2.98 m long car OBB plus substeps must register the contact.
const carSupport = CAR_ENVELOPE.length / 2;
const thinCandidates = manifest.colliders
  .filter((c) => c.active && Math.min(c.half[0], c.half[2]) <= 0.3 && c.vertical.height >= 0.8 && c.source === "track-visual")
  .sort((a, b) => {
    const ta = Math.min(a.half[0], a.half[2]);
    const tb = Math.min(b.half[0], b.half[2]);
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : 1;
  });
const tunnelRows = [];
let tunnelTested = 0;
for (const c of thinCandidates) {
  if (tunnelTested >= 12) break;
  const approach = findApproach(c, world, 6);
  if (!approach) {
    tunnelRows.push({ id: c.id, skipped: "no clear 6 m approach" });
    continue;
  }
  tunnelTested += 1;
  let s = {
    x: approach.sx,
    z: approach.sz,
    y: approach.baseY,
    yaw: approach.yaw,
    vx: -approach.dx * 31,
    vz: -approach.dz * 31,
  };
  let maxPen = 0;
  let maxSubsteps = 0;
  let hit = false;
  for (let t = 0; t < 60; t++) {
    const res = world.step({ ...s }, { dt: 1 / 60 });
    s = res.state;
    maxPen = Math.max(maxPen, res.maxPenetration);
    maxSubsteps = Math.max(maxSubsteps, res.substeps);
    if (res.contactIds.includes(c.id)) hit = true;
  }
  const r = Math.hypot(s.x - c.center[0], s.z - c.center[2]);
  const gap = r - approach.support - carSupport;
  const baseline = integrate(
    { x: approach.sx, z: approach.sz, y: approach.baseY, yaw: approach.yaw, vx: -approach.dx * 31, vz: -approach.dz * 31 },
    60,
  );
  const baselineR = Math.hypot(baseline.x - c.center[0], baseline.z - c.center[2]);
  const baselineGap = baselineR - approach.support - carSupport;
  const baselineOnStartSide = (baseline.x - c.center[0]) * approach.dx + (baseline.z - c.center[2]) * approach.dz > 0;
  tunnelRows.push({
    id: c.id,
    thickness: r6(Math.min(c.half[0], c.half[2]) * 2),
    hit,
    maxPenetration: r6(maxPen),
    maxSubsteps,
    finalGap: r6(gap),
    baselinePassedThrough: !baselineOnStartSide,
  });
}
const tunnelled = tunnelRows.filter((row) => row.skipped === undefined && (row.finalGap < -0.02 || row.maxPenetration > 0.09));
const contactedTarget = tunnelRows.filter((row) => row.skipped === undefined && row.hit).length;
check("31 m/s: thin colliders are not tunnelled", tunnelTested >= 6 && tunnelled.length === 0, `${tunnelTested} tested, ${contactedTarget} target contacts, ${tunnelRows.filter((r) => r.skipped).length} skipped, ${tunnelled.length} failures`);
check("31 m/s: substeps >= 7", tunnelRows.every((r) => r.skipped !== undefined || r.maxSubsteps >= 7), `min ${Math.min(...tunnelRows.filter((r) => r.maxSubsteps).map((r) => r.maxSubsteps))}`);
check("31 m/s: no-collision baseline passes through", tunnelRows.some((r) => r.baselinePassedThrough), `${tunnelRows.filter((r) => r.baselinePassedThrough).length}/${tunnelTested} baselines passed through`);

// Deterministic replay: same start, same inputs → identical tick states.
let determinism = null;
if (headApproach) {
  function runHead() {
    let s = {
      x: headApproach.sx,
      z: headApproach.sz,
      y: headApproach.baseY,
      yaw: headApproach.yaw,
      vx: headApproach.dx * 31,
      vz: headApproach.dz * 31,
    };
    const rows = [];
    for (let t = 0; t < 120; t++) {
      const res = world.step({ ...s }, { dt: 1 / 60 });
      s = res.state;
      rows.push([r6(s.x), r6(s.z), r6(s.vx), r6(s.vz), res.substeps, res.contactIds.length]);
    }
    return { rows, hash: sha256(stableStringify(rows)) };
  }
  const a = runHead();
  const b = runHead();
  determinism = { hashA: a.hash, hashB: b.hash, ticks: a.rows.length, identical: a.hash === b.hash };
  check("resolver deterministic over 120 ticks", a.hash === b.hash, `sha256:${a.hash.slice(0, 16)}…`);
}

// 310 m path-following drive through the resolver at 20 m/s.  This is a
// kinematic probe, not the race rules: it proves a car-sized body can traverse
// the measured line with the roadside layer active.
let drive = null;
{
  let s = {
    x: points[0][0],
    z: points[0][1],
    y: groundAt(points[0][0], points[0][1]).y,
    yaw: yawAt(0),
    vx: 0,
    vz: 0,
  };
  let nearest = 0;
  let maxPen = 0;
  const contactIds = new Set();
  let ticks = 0;
  const speed = 20;
  while (nearest < points.length - 3 && ticks < 3000) {
    // local nearest search ahead
    let best = nearest;
    let bestD = Infinity;
    for (let i = nearest; i < Math.min(points.length, nearest + 80); i++) {
      const dx = points[i][0] - s.x;
      const dz = points[i][1] - s.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    nearest = best;
    const la = Math.min(points.length - 1, nearest + 32); // 8 m lookahead
    const dx = points[la][0] - s.x;
    const dz = points[la][1] - s.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    s.vx = ux * speed;
    s.vz = uz * speed;
    s.yaw = Math.atan2(uz, ux);
    s.y = groundAt(s.x, s.z).y;
    const res = world.step({ ...s }, { dt: 1 / 60 });
    s = res.state;
    maxPen = Math.max(maxPen, res.maxPenetration);
    for (const id of res.contactIds) contactIds.add(id);
    ticks += 1;
  }
  const arc = Math.min(nearest * arcPerSample, pathData.course.length);
  drive = {
    start: { x: r6(points[0][0]), z: r6(points[0][1]) },
    end: { x: r6(s.x), z: r6(s.z) },
    arc: r6(arc),
    ticks,
    speed,
    maxPenetration: r6(maxPen),
    contactIds: [...contactIds].sort(),
    completed: arc >= pathData.course.length - 5,
  };
  check("310 m line: resolver drive completes", drive.completed, `arc ${drive.arc.toFixed(2)} m in ${ticks} ticks`);
  check("310 m line: resolver drive has no contact", contactIds.size === 0, contactIds.size ? [...contactIds].join(",") : "0 contacts");
  check("310 m line: penetration zero", maxPen === 0, `${maxPen}`);
}

// ---------------------------------------------------------------------------
// 4. Performance probe (diagnostic, not a frame-rate claim)
// ---------------------------------------------------------------------------
const t0 = process.hrtime.bigint();
let probes = 0;
for (let rep = 0; rep < 20; rep++) {
  for (let i = 0; i < points.length; i += 5) {
    const yaw = yawAt(i);
    const g = groundAt(points[i][0], points[i][1]);
    world.deepestContact(points[i][0], points[i][1], yaw, g.y, CAR_ENVELOPE);
    probes += 1;
  }
}
const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
const perf = { probes, totalMs: r6(elapsedMs), perProbeUs: r6((elapsedMs * 1000) / probes) };

const summary = {
  kind: "prop-collision-verify",
  version: 1,
  command: "node probes/prop-collision/tools/verify_colliders.mjs",
  inputs: {
    geometrySha256: sha256(geometryBytes),
    pathSha256: sha256(pathBytes),
    collidersSha256: sha256(manifestBytes),
    collidersContentSha256: manifest.contentSha256,
  },
  counts: manifest.counts,
  profiles: manifest.profiles,
  road: {
    lengthM: pathData.course.length,
    samples: points.length,
    roadsideBlockedSamples: roadsideBlocked,
    allVisibleBlockedSamples: allBlocked.length,
    allVisibleBlockedArcs: manifest.road.allVisibleBlockedArcs,
    corridorMinClearRows: Math.min(...corridorRows),
    corridorRows: corridorRows.length,
  },
  headOn: headRun,
  onCourseCollision,
  glancing: glanceRun,
  noTunnelling: tunnelRows,
  determinism,
  drive310m: drive,
  checks: { total: checks.length, passed: checks.length - failures, failed: failures },
  result: failures === 0 ? "PASS" : "FAIL",
  checksList: checks,
};
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.writeFileSync(OUT_PATH, `${JSON.stringify(summary, null, 1)}\n`);

console.log("");
console.log(`broadphase: ${perf.probes} probes in ${perf.totalMs.toFixed(2)} ms (${perf.perProbeUs.toFixed(3)} us/probe; diagnostic only)`);
console.log(`${summary.result}: ${summary.checks.passed}/${summary.checks.total} checks, ${failures} failures`);
console.log(`wrote ${OUT_PATH}`);
process.exit(failures === 0 ? 0 : 1);
