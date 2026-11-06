/*
 * resolve_r04.mjs — P68a resolver tests on the R04 all-visible layer.
 *
 * Consumes, read-only:
 *   _work/prop-collision/colliders.json    P66 manifest (pinned sha256)
 *   _work/free-roam-prop/props.json        P68a raster analysis
 *   _work/free-roam-prop/route.json        P68a route across the reachable basin
 *   _work/free-roam-prop/ground.json       1 m ground lattice for the vertical band
 *   probes/prop-collision/lib/resolver.mjs P66 resolver (imported, not modified)
 *
 * Tests: spawn clearance, 31 m/s head-on stop, 5 deg glancing slide, 31 m/s into
 * thin components (no tunnelling), and a 20 m/s drive along the route.
 * Writes _work/free-roam-prop/resolver.json. No engine, browser or game claim.
 *
 * Targets are chosen by marching the car pose until the first collider overlap,
 * so the reported target is the component the car actually hits first. The R04
 * props are clusters of overlapping boxes; naming a specific component up front
 * would report a gap to a box behind the contact face.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createWorld } from "../../prop-collision/lib/resolver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");

// argv: [--manifest <path>] [--dir <output dir>]
const ARGV = process.argv.slice(2);
let manifestPath = path.join(ROOT, "_work", "prop-collision", "colliders.json");
let OUT = path.join(ROOT, "_work", "free-roam-prop");
for (let i = 0; i < ARGV.length; i++) {
  if (ARGV[i] === "--manifest") manifestPath = path.resolve(ROOT, ARGV[++i]);
  else if (ARGV[i] === "--dir") OUT = path.resolve(ROOT, ARGV[++i]);
  else throw new Error(`unknown argument ${ARGV[i]}`);
}

const COLL_SHA256 = "a98fb8eb7e7a6f6851e0c6b5671d40be2c346d0c28a2442df0fe6ab497317af4";
const ENVELOPE = { length: 2.98, width: 1.68, height: 1.35 };
const SPAWN = { x: -88, z: 1050, heading: Math.PI / 2 };

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const round = (v, n = 4) => (Number.isFinite(v) ? Number(v.toFixed(n)) : null);

// --------------------------------------------------------------------------
// inputs
// --------------------------------------------------------------------------

const collBytes = fs.readFileSync(manifestPath);
const collSha = sha256(collBytes);
const manifest = JSON.parse(collBytes.toString("utf8"));
const isVariant = manifest.variant === "free-roam-r04";
if (collSha !== COLL_SHA256 && !isVariant) {
  throw new Error(`colliders.json sha256 changed: ${collSha}`);
}
if (!isVariant && manifest.colliders.length !== 468) throw new Error("expected 468 colliders");
const props = JSON.parse(fs.readFileSync(path.join(OUT, "props.json"), "utf8"));
const routeDoc = JSON.parse(fs.readFileSync(path.join(OUT, "route.json"), "utf8"));
const groundDoc = JSON.parse(fs.readFileSync(path.join(OUT, "ground.json"), "utf8"));

const world = createWorld(manifest, { profile: "all-visible" });
if (world.colliders.length !== manifest.counts.colliders) {
  throw new Error(`all-visible world has ${world.colliders.length} colliders, ` +
                  `manifest says ${manifest.counts.colliders}`);
}
const roadside = createWorld(manifest, { profile: "roadside" });
if (roadside.colliders.length !== manifest.profiles.roadside.colliders) {
  throw new Error(`roadside world has ${roadside.colliders.length} colliders, ` +
                  `manifest says ${manifest.profiles.roadside.colliders}`);
}
const emptyWorld = createWorld({ colliders: [], carEnvelope: manifest.carEnvelope },
                               { profile: "all-visible" });

const env = manifest.carEnvelope;

function ground(x, z) {
  const i = Math.round((x - groundDoc.x0) / groundDoc.sampleStepM);
  const j = Math.round((z - groundDoc.z0) / groundDoc.sampleStepM);
  const ii = Math.max(0, Math.min(groundDoc.nx - 1, i));
  const jj = Math.max(0, Math.min(groundDoc.nz - 1, j));
  return groundDoc.values[jj][ii];
}

// --------------------------------------------------------------------------
// exact rectangle-rectangle distance (independent of the resolver SAT)
// --------------------------------------------------------------------------

function rectOf(c) {
  return { cx: c.cx, cz: c.cz, ux: c.ux, uz: c.uz, vx: c.vx, vz: c.vz, hu: c.hu, hv: c.hv };
}
function carRect(x, z, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { cx: x, cz: z, ux: c, uz: s, vx: -s, vz: c,
           hu: ENVELOPE.length / 2, hv: ENVELOPE.width / 2 };
}
function corners(r) {
  const out = [];
  for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    out.push([r.cx + su * r.hu * r.ux + sv * r.hv * r.vx,
              r.cz + su * r.hu * r.uz + sv * r.hv * r.vz]);
  }
  return out;
}
function pointRectDistance(px, pz, r) {
  const dx = px - r.cx, dz = pz - r.cz;
  const lu = dx * r.ux + dz * r.uz, lv = dx * r.vx + dz * r.vz;
  const qu = Math.max(Math.abs(lu) - r.hu, 0), qv = Math.max(Math.abs(lv) - r.hv, 0);
  return Math.hypot(qu, qv);
}
function rectDistance(a, b) {
  const axes = [[a.ux, a.uz], [a.vx, a.vz], [b.ux, b.uz], [b.vx, b.vz]];
  for (const [ax, az] of axes) {
    const pa = corners(a).map(([x, z]) => x * ax + z * az);
    const pb = corners(b).map(([x, z]) => x * ax + z * az);
    if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) {
      let best = Infinity;
      for (const [px, pz] of corners(a)) best = Math.min(best, pointRectDistance(px, pz, b));
      for (const [px, pz] of corners(b)) best = Math.min(best, pointRectDistance(px, pz, a));
      return best;
    }
  }
  return 0;
}
function clearanceAt(x, z, yaw) {
  const car = carRect(x, z, yaw);
  let best = { d: Infinity, id: null };
  const r = Math.hypot(ENVELOPE.length, ENVELOPE.width) / 2;
  for (const i of world.queryIndices(x - r - 3, x + r + 3, z - r - 3, z + r + 3)) {
    const c = world.colliders[i];
    const d = rectDistance(car, rectOf(c));
    if (d < best.d) best = { d, id: c.id, classification: c.classification };
  }
  return best;
}
function hashStates(states) {
  return "sha256:" + sha256(JSON.stringify(states));
}
function poseFree(x, z, yaw, label = "") {
  const c = world.deepestContact(x, z, yaw, ground(x, z), env);
  if (c) throw new Error(`setup: ${label} pose (${x}, ${z}) overlaps ${c.colliderId}`);
}
const worldIndexById = new Map(world.colliders.map((c, i) => [c.id, i]));
const manifestById = new Map(manifest.colliders.map((c) => [c.id, c]));
const clusterIds = (id) => (props.clusters.find((c) => c.id === id) ?? {}).colliderIds ?? [];
const longAxis = (c) => (c.hu >= c.hv
  ? { a: [c.ux, c.uz], h: c.hu, ho: c.hv }
  : { a: [c.vx, c.vz], h: c.hv, ho: c.hu });

/** March the car pose forward and return the first collider overlap. */
function firstHitAlong(x, z, yaw, maxDist = 40) {
  const dx = Math.cos(yaw), dz = Math.sin(yaw);
  for (let s = 0; s <= maxDist; s += 0.05) {
    const px = x + dx * s, pz = z + dz * s;
    const c = world.deepestContact(px, pz, yaw, ground(px, pz), env);
    if (c) return { id: c.colliderId, s, x: px, z: pz, penetration: c.penetration };
  }
  return null;
}

function findApproach(colliderId, distance, opts = {}) {
  const c = world.colliders[worldIndexById.get(colliderId)];
  const dirs = [];
  if (opts.dirs) {
    dirs.push(...opts.dirs);
  } else {
    const stepDeg = opts.stepDeg ?? 5;
    for (let d = 0; d < 360; d += stepDeg) dirs.push((d * Math.PI) / 180);
  }
  for (const ang of dirs) {
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const x = c.cx + dx * distance, z = c.cz + dz * distance;
    const yaw = Math.atan2(-dz, -dx);
    if (Math.hypot(x - SPAWN.x, z - SPAWN.z) > 400) continue;
    if (opts.towardSpawn) {
      const dStart = Math.hypot(x - SPAWN.x, z - SPAWN.z);
      const dColl = Math.hypot(c.cx - SPAWN.x, c.cz - SPAWN.z);
      if (dStart > dColl - 2.0) continue;
    }
    try {
      const tMax = Math.max(0, 1 - 3.0 / distance);
      for (let t = 0; t <= tMax + 1e-9; t += 0.05) {
        poseFree(x * (1 - t) + c.cx * t, z * (1 - t) + c.cz * t, yaw, `approach ${colliderId}`);
      }
    } catch {
      continue;
    }
    const gy = ground(x, z);
    if (!(c.top > gy && c.bottom < gy + ENVELOPE.height)) continue;
    return { x, z, yaw, distance };
  }
  return null;
}

// --------------------------------------------------------------------------
// 1. spawn clearance
// --------------------------------------------------------------------------

const spawnContact = world.deepestContact(SPAWN.x, SPAWN.z, SPAWN.heading,
                                          ground(SPAWN.x, SPAWN.z), env);
const spawnClear = clearanceAt(SPAWN.x, SPAWN.z, SPAWN.heading);
const spawnResolve = world.resolvePose(SPAWN.x, SPAWN.z, SPAWN.heading,
                                       ground(SPAWN.x, SPAWN.z), env);
const spawnProps = props.r04.spawnClearance;

const spawnTest = {
  pose: { x: SPAWN.x, z: SPAWN.z, yaw: round(SPAWN.heading, 6),
          baseY: round(ground(SPAWN.x, SPAWN.z), 3) },
  overlaps: spawnContact !== null,
  clearanceM: round(spawnClear.d, 3),
  nearestCollider: spawnClear.id,
  nearestClass: spawnClear.classification ?? null,
  builderClearanceM: spawnProps.committedHeadingDistanceM,
  clearanceAgreesWithBuilder: Math.abs(spawnClear.d - spawnProps.committedHeadingDistanceM) <= 0.002,
  resolvePoseResidual: round(spawnResolve.residual, 6),
  resolvePoseContacts: spawnResolve.contacts.length,
  pass: spawnContact === null && spawnResolve.residual === 0 && spawnClear.d > 0,
};

// --------------------------------------------------------------------------
// 2. 31 m/s head-on into the C03 construction wall at the neck
// --------------------------------------------------------------------------

const gate = props.free.pockets[0].separationFromSpawn.gateCentreMetres;
const c03 = clusterIds("C03").map((id) => manifestById.get(id)).filter(Boolean);
c03.sort((a, b) => {
  const da = Math.hypot(a.center[0] - gate[0], a.center[2] - gate[1]);
  const db = Math.hypot(b.center[0] - gate[0], b.center[2] - gate[1]);
  return da - db || a.id.localeCompare(b.id);
});
let headApproach = null;
let headSeed = null;
for (const m of c03) {
  for (const dist of [22.0, 16.0]) {
    const ap = findApproach(m.id, dist, { towardSpawn: true, stepDeg: 5 });
    if (ap) { headApproach = ap; headSeed = m; break; }
  }
  if (headApproach) break;
}
if (!headApproach) throw new Error("no free approach to the C03 gate");
poseFree(headApproach.x, headApproach.z, headApproach.yaw, "head-on start");
const headFirst = firstHitAlong(headApproach.x, headApproach.z, headApproach.yaw, 40);
if (!headFirst) throw new Error("head-on approach hits nothing");
const headTarget = world.colliders[worldIndexById.get(headFirst.id)];

function runDrive(approach, speed, ticks, friction = 0.45) {
  let state = { x: approach.x, z: approach.z, y: ground(approach.x, approach.z),
                yaw: approach.yaw,
                vx: Math.cos(approach.yaw) * speed, vz: Math.sin(approach.yaw) * speed };
  const states = [];
  let maxPen = 0, contacts = new Set(), substeps = 0;
  for (let t = 0; t < ticks; t++) {
    const r = world.step(state, { dt: 1 / 60, carEnvelope: env, friction,
                                  slop: 0.001, maxIterations: 8 });
    state = r.state;
    maxPen = Math.max(maxPen, r.maxPenetration);
    substeps = Math.max(substeps, r.substeps);
    for (const id of r.contactIds) contacts.add(id);
    states.push([round(state.x, 5), round(state.z, 5), round(state.vx, 5), round(state.vz, 5)]);
    if (Math.hypot(state.vx, state.vz) < 0.05) break;
  }
  const endC = world.deepestContact(state.x, state.z, state.yaw, ground(state.x, state.z), env);
  return { state, states, maxPen, contacts, substeps,
           endPenetration: endC ? endC.penetration : 0 };
}

const headRun = runDrive(headApproach, 31, 400);
const headReplay = runDrive(headApproach, 31, 400);
const headGap = rectDistance(carRect(headRun.state.x, headRun.state.z, headRun.state.yaw),
                             rectOf(headTarget));

const baselineApproach = headApproach;
let baselineState = { x: baselineApproach.x, z: baselineApproach.z,
                      y: ground(baselineApproach.x, baselineApproach.z),
                      yaw: baselineApproach.yaw,
                      vx: Math.cos(baselineApproach.yaw) * 31,
                      vz: Math.sin(baselineApproach.yaw) * 31 };
for (let t = 0; t < 400; t++) {
  const r = emptyWorld.step(baselineState, { dt: 1 / 60, carEnvelope: env });
  baselineState = r.state;
  if (Math.hypot(baselineState.vx, baselineState.vz) < 0.05) break;
}
const headOn = {
  seedCollider: headSeed.id,
  target: headFirst.id,
  targetClass: headTarget.classification,
  firstHitAtM: round(headFirst.s, 3),
  approach: { x: round(headApproach.x, 3), z: round(headApproach.z, 3),
              yawDeg: round((headApproach.yaw * 180) / Math.PI, 2) },
  startSpeed: 31,
  finalSpeed: round(Math.hypot(headRun.state.vx, headRun.state.vz), 3),
  travelledM: round(Math.hypot(headRun.state.x - headApproach.x,
                               headRun.state.z - headApproach.z), 3),
  finalPose: { x: round(headRun.state.x, 3), z: round(headRun.state.z, 3) },
  finalGapM: round(headGap, 4),
  maxPenetrationM: round(headRun.maxPen, 4),
  endPenetrationM: round(headRun.endPenetration, 5),
  substeps: headRun.substeps,
  contactCount: headRun.contacts.size,
  contactIds: [...headRun.contacts].sort(),
  targetContacted: headRun.contacts.has(headFirst.id),
  stopHash: hashStates(headRun.states),
  replayHash: hashStates(headReplay.states),
  ticks: headRun.states.length,
};
const headOnBaseline = {
  colliderWorld: "empty (no colliders), same start pose and speed",
  travelledM: round(Math.hypot(baselineState.x - baselineApproach.x,
                               baselineState.z - baselineApproach.z), 3),
  finalSpeed: round(Math.hypot(baselineState.vx, baselineState.vz), 3),
  contacts: 0,
};

// --------------------------------------------------------------------------
// 3. glancing slide along the longest reachable C01 rack
// --------------------------------------------------------------------------

const c01 = clusterIds("C01").map((id) => manifestById.get(id)).filter(Boolean);
c01.sort((a, b) => (b.size[0] * b.size[2]) - (a.size[0] * a.size[2]) || a.id.localeCompare(b.id));
const glanceSeed = c01[0];
const gs = world.colliders[worldIndexById.get(glanceSeed.id)];
const ga = longAxis(gs);

function glancingRun(targetCollider, lateral, angleDeg, speed, ticks) {
  const c = targetCollider;
  const la = longAxis(c);
  const nx = -la.a[1], nz = la.a[0];
  const startX = c.cx - la.a[0] * (la.h * 0.55) + nx * lateral;
  const startZ = c.cz - la.a[1] * (la.h * 0.55) + nz * lateral;
  const inc = (angleDeg * Math.PI) / 180;
  const dx = la.a[0] * Math.cos(inc) - nx * Math.sin(inc);
  const dz = la.a[1] * Math.cos(inc) - nz * Math.sin(inc);
  const yaw = Math.atan2(dz, dx);
  const start = { x: startX, z: startZ, yaw, lateral, angleDeg };
  const contact = world.deepestContact(startX, startZ, yaw, ground(startX, startZ), env);
  if (contact) return { error: `glancing start overlaps ${contact.colliderId}`, start };
  let state = { x: startX, z: startZ, y: ground(startX, startZ), yaw,
                vx: dx * speed, vz: dz * speed };
  const speeds = [];
  const states = [];
  let maxPen = 0;
  const contacts = new Set();
  for (let t = 0; t < ticks; t++) {
    const r = world.step(state, { dt: 1 / 60, carEnvelope: env, friction: 0.45,
                                  slop: 0.001, maxIterations: 8 });
    state = r.state;
    maxPen = Math.max(maxPen, r.maxPenetration);
    for (const id of r.contactIds) contacts.add(id);
    speeds.push(Math.hypot(state.vx, state.vz));
    states.push([round(state.x, 5), round(state.z, 5), round(state.vx, 5), round(state.vz, 5)]);
  }
  const endC = world.deepestContact(state.x, state.z, state.yaw, ground(state.x, state.z), env);
  const vt = Math.abs(state.vx * la.a[0] + state.vz * la.a[1]);
  return {
    seedCollider: targetCollider.id,
    start: { x: round(startX, 3), z: round(startZ, 3), yawDeg: round((yaw * 180) / Math.PI, 3) },
    lateralOffsetM: lateral,
    incidenceDeg: angleDeg,
    startSpeed: speed,
    endSpeed: round(Math.hypot(state.vx, state.vz), 3),
    endTangentialSpeed: round(vt, 3),
    retainedFraction: round(vt / speed, 4),
    minSpeed: round(Math.min(...speeds), 3),
    maxPenetrationM: round(maxPen, 4),
    endPenetrationM: round(endC ? endC.penetration : 0, 5),
    contactCount: contacts.size,
    contactIds: [...contacts].sort(),
    targetContacted: contacts.has(targetCollider.id),
    residualOverlap: endC !== null,
    hash: hashStates(states),
  };
}

const glancing = glancingRun(gs, 2.2, 5, 20, 60);
const glancing2 = glancingRun(gs, 2.2, 5, 20, 60);
if (glancing.error) throw new Error(glancing.error);

// --------------------------------------------------------------------------
// 4. 31 m/s into thin components (no tunnelling)
// --------------------------------------------------------------------------

const r04Thin = props.props.colliders
  .filter((c) => Math.min(c.sizeXZ[0], c.sizeXZ[1]) <= 0.2 && c.inR04Cells > 0)
  .map((c) => c.id)
  .filter((id) => worldIndexById.has(id));
const thinIds = r04Thin.sort((a, b) => {
  const ma = manifestById.get(a), mb = manifestById.get(b);
  return Math.min(ma.half[0], ma.half[2]) - Math.min(mb.half[0], mb.half[2])
    || a.localeCompare(b);
});
function normalDirs(c) {
  const thinIsU = c.hu <= c.hv;
  const nx = thinIsU ? c.ux : c.vx;
  const nz = thinIsU ? c.uz : c.vz;
  const base = Math.atan2(nz, nx);
  const offs = [0, Math.PI, 0.26, -0.26, Math.PI + 0.26, Math.PI - 0.26];
  return offs.map((o) => base + o);
}

const tunnelRuns = [];
const skipped = [];
const seen = new Set();
let candidatesTried = 0;
for (const id of thinIds) {
  if (tunnelRuns.length >= 6 || candidatesTried >= 60) break;
  const m = manifestById.get(id);
  const key = `${Math.round(m.center[0] * 2)},${Math.round(m.center[2] * 2)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  candidatesTried += 1;
  const wc = world.colliders[worldIndexById.get(id)];
  const ap = findApproach(id, 7.0, { dirs: normalDirs(wc) });
  if (!ap) { skipped.push({ id, reason: "no free 7 m approach" }); continue; }
  const hit = firstHitAlong(ap.x, ap.z, ap.yaw, 12);
  if (!hit) { skipped.push({ id, reason: "no first hit" }); continue; }
  if (hit.id !== id) {
    skipped.push({ id, reason: "not the first contact", firstHit: hit.id });
    continue;
  }
  const c = world.colliders[worldIndexById.get(id)];
  let state = { x: ap.x, z: ap.z, y: ground(ap.x, ap.z), yaw: ap.yaw,
                vx: Math.cos(ap.yaw) * 31, vz: Math.sin(ap.yaw) * 31 };
  const states = [];
  const contacts = new Set();
  let maxPen = 0, substeps = 0, passed = false;
  const dx = Math.cos(ap.yaw), dz = Math.sin(ap.yaw);
  for (let t = 0; t < 120; t++) {
    const r = world.step(state, { dt: 1 / 60, carEnvelope: env, friction: 0.45,
                                  slop: 0.001, maxIterations: 8 });
    state = r.state;
    for (const cid of r.contactIds) contacts.add(cid);
    maxPen = Math.max(maxPen, r.maxPenetration);
    substeps = Math.max(substeps, r.substeps);
    if ((state.x - c.cx) * dx + (state.z - c.cz) * dz > 1.6) passed = true;
    states.push([round(state.x, 5), round(state.z, 5), round(state.vx, 5), round(state.vz, 5)]);
    if (Math.hypot(state.vx, state.vz) < 0.05) break;
  }
  let baseState = { x: ap.x, z: ap.z, y: ground(ap.x, ap.z), yaw: ap.yaw,
                    vx: Math.cos(ap.yaw) * 31, vz: Math.sin(ap.yaw) * 31 };
  for (let t = 0; t < 120; t++) {
    const r = emptyWorld.step(baseState, { dt: 1 / 60, carEnvelope: env });
    baseState = r.state;
    if ((baseState.x - c.cx) * dx + (baseState.z - c.cz) * dz > 6.0) break;
  }
  const endC = world.deepestContact(state.x, state.z, state.yaw, ground(state.x, state.z), env);
  tunnelRuns.push({
    target: id,
    thicknessM: round(2 * Math.min(m.half[0], m.half[2]), 3),
    approach: { x: round(ap.x, 3), z: round(ap.z, 3),
                yawDeg: round((ap.yaw * 180) / Math.PI, 2) },
    firstHitAtM: round(hit.s, 3),
    startSpeed: 31,
    substeps,
    contactedTarget: contacts.has(id),
    passedTargetPlane: passed,
    tunnelled: passed && !contacts.has(id),
    maxPenetrationM: round(maxPen, 4),
    endPenetrationM: round(endC ? endC.penetration : 0, 5),
    finalSpeed: round(Math.hypot(state.vx, state.vz), 3),
    baselineTravelledPastTargetM: round(
      (baseState.x - c.cx) * dx + (baseState.z - c.cz) * dz, 3),
    contacts: [...contacts].sort(),
    hash: hashStates(states),
  });
}

// --------------------------------------------------------------------------
// 5. route drive at 20 m/s (kinematic follower, lookahead 8 m)
// --------------------------------------------------------------------------

const route = routeDoc.points;
poseFree(route[0].x, route[0].z, route[0].heading, "route start");

function driveRoute(speed, lookahead, maxTicks) {
  let state = { x: route[0].x, z: route[0].z, y: ground(route[0].x, route[0].z),
                yaw: route[0].heading, vx: 0, vz: 0 };
  const states = [];
  let maxPen = 0, progressIdx = 0, minClear = Infinity;
  const contacts = new Set();
  let ticks = 0;
  for (let t = 0; t < maxTicks; t++) {
    let bestI = progressIdx, bestD = Infinity;
    for (let i = progressIdx; i < route.length; i++) {
      const d = Math.hypot(route[i].x - state.x, route[i].z - state.z);
      if (d < bestD) { bestD = d; bestI = i; }
      if (i > progressIdx + 12) break;
    }
    progressIdx = Math.max(progressIdx, bestI);
    if (progressIdx >= route.length - 1 && bestD < 1.5) break;
    let li = progressIdx, acc = 0;
    while (li < route.length - 1 && acc < lookahead) {
      acc += Math.hypot(route[li + 1].x - route[li].x, route[li + 1].z - route[li].z);
      li += 1;
    }
    const tx = route[li].x - state.x, tz = route[li].z - state.z;
    const n = Math.hypot(tx, tz) || 1;
    state.vx = (tx / n) * speed;
    state.vz = (tz / n) * speed;
    const r = world.step(state, { dt: 1 / 60, carEnvelope: env, friction: 0.45,
                                  slop: 0.001, maxIterations: 8 });
    state = r.state;
    maxPen = Math.max(maxPen, r.maxPenetration);
    for (const id of r.contactIds) contacts.add(id);
    minClear = Math.min(minClear, clearanceAt(state.x, state.z, state.yaw).d);
    states.push([round(state.x, 4), round(state.z, 4), round(state.vx, 4), round(state.vz, 4)]);
    ticks += 1;
  }
  const endC = world.deepestContact(state.x, state.z, state.yaw, ground(state.x, state.z), env);
  return {
    speed, lookaheadM: lookahead, ticks, routePoints: route.length,
    reachedEnd: progressIdx >= route.length - 2,
    progressIndex: progressIdx,
    distanceM: round(route.slice(0, progressIdx + 1).reduce((a, p, i, arr) =>
      i === 0 ? 0 : a + Math.hypot(p.x - arr[i - 1].x, p.z - arr[i - 1].z), 0), 3),
    maxPenetrationM: round(maxPen, 4),
    endPenetrationM: round(endC ? endC.penetration : 0, 5),
    contactCount: contacts.size,
    contactIds: [...contacts].sort(),
    minPropClearanceM: round(minClear, 3),
    hash: hashStates(states),
  };
}
const routeRun = driveRoute(20, 8, 3000);
const routeRun2 = driveRoute(20, 8, 3000);

// --------------------------------------------------------------------------
// verdict + output
// --------------------------------------------------------------------------

const checks = {
  spawnClear: spawnTest.pass,
  spawnClearanceMatchesBuilder: spawnTest.clearanceAgreesWithBuilder,
  headOnStops: headOn.finalSpeed < 0.1 && headOn.targetContacted
    && headOn.endPenetrationM < 0.01,
  headOnStopsAtFace: headOn.finalGapM !== null && headOn.finalGapM < 0.05,
  headOnDeterministic: headOn.stopHash === headOn.replayHash,
  headOnBaselinePasses: headOnBaseline.contacts === 0
    && headOnBaseline.travelledM > headOn.travelledM + 5,
  glancingSlides: glancing.retainedFraction > 0.8 && glancing.maxPenetrationM < 0.02
    && glancing.endPenetrationM < 0.01 && glancing.contactCount > 0,
  glancingDeterministic: glancing.hash === glancing2.hash,
  noTunnelling: tunnelRuns.length > 0 && tunnelRuns.every((r) => !r.tunnelled
    && r.contactedTarget && r.baselineTravelledPastTargetM > 6.0),
  routeReachesEnd: routeRun.reachedEnd,
  routeNoPenetration: routeRun.maxPenetrationM < 0.02 && routeRun.endPenetrationM < 0.01,
  routeDeterministic: routeRun.hash === routeRun2.hash,
};

const result = {
  kind: "free-roam-prop.resolver", version: 1,
  scope: {
    visibleMeshApproximation: true, retailCollision: false, engineRun: false,
    rendererClaim: false, gameClaim: false, e1DriveIntegration: false,
    statement: "P66 resolver run against the P66 all-visible collider manifest on " +
               "P68a R04 test poses; kinematic 2.5D prototype, not vehicle physics",
  },
  inputs: {
    colliders: { path: path.relative(ROOT, manifestPath).split(path.sep).join("/"),
                 sha256: collSha, variant: manifest.variant ?? "committed-p66",
                 colliderCount: manifest.counts.colliders },
    props: { path: "_work/free-roam-prop/props.json" },
    route: { path: "_work/free-roam-prop/route.json" },
    ground: { path: "_work/free-roam-prop/ground.json" },
    resolver: { path: "probes/prop-collision/lib/resolver.mjs" },
  },
  profile: "all-visible",
  carEnvelope: ENVELOPE,
  spawn: spawnTest,
  headOn,
  headOnBaseline,
  glancing,
  tunnelling: tunnelRuns,
  tunnellingSkipped: skipped,
  route: routeRun,
  routeReplayHash: routeRun2.hash,
  checks,
  result: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
};

fs.writeFileSync(path.join(OUT, "resolver.json"), JSON.stringify(result, null, 1) + "\n");
console.log(JSON.stringify({
  spawnClearanceM: spawnTest.clearanceM,
  spawnNearest: spawnTest.nearestCollider,
  headOn: { target: headOn.target, finalSpeed: headOn.finalSpeed, gap: headOn.finalGapM,
            maxPen: headOn.maxPenetrationM, endPen: headOn.endPenetrationM,
            contacts: headOn.contactCount },
  glancing: { retained: glancing.retainedFraction, maxPen: glancing.maxPenetrationM,
              contacts: glancing.contactCount, endPen: glancing.endPenetrationM },
  tunnelling: tunnelRuns.map((r) => ({ t: r.target.split(".").slice(-2).join("."),
                                       thick: r.thicknessM, contacted: r.contactedTarget,
                                       passed: r.passedTargetPlane })),
  tunnellingSkipped: skipped.length,
  route: { reached: routeRun.reachedEnd, ticks: routeRun.ticks,
           distance: routeRun.distanceM, maxPen: routeRun.maxPenetrationM,
           contacts: routeRun.contactCount, minClear: routeRun.minPropClearanceM },
  checks,
  result: result.result,
}, null, 1));
if (result.result !== "PASS") process.exitCode = 1;
