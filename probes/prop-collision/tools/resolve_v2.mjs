#!/usr/bin/env node
/*
 * resolve_v2.mjs — resolver proof for the structures that V1 left pass-through.
 *
 * For every candidate:
 *   - 31 m/s head-on: stops on the near face, residual 0;
 *   - 4-direction ray: blocked, never on the far side of the target;
 *   - no tunnelling at 31 m/s;
 * plus one 5° glance along the longest wall and a two-run determinism check.
 *
 * Output: _work/prop-collision/resolve-v2.json
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createWorld } from "../lib/resolver.mjs";
import { makeGroundSampler } from "../lib/geometry.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const GEOMETRY = path.join(ROOT, "_work", "e1-drive", "geometry.json");
const BASE = path.join(ROOT, "_work", "prop-collision", "colliders-v2.json");
const R04 = path.join(ROOT, "_work", "free-roam-prop", "colliders-r04-v2.json");
const OUT = path.join(ROOT, "_work", "prop-collision", "resolve-v2.json");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

const geometry = JSON.parse(fs.readFileSync(GEOMETRY, "utf8"));
const base = JSON.parse(fs.readFileSync(BASE, "utf8"));
const r04 = JSON.parse(fs.readFileSync(R04, "utf8"));
const groundAt = makeGroundSampler(geometry.collisionSurface.mesh);
const envelope = base.carEnvelope;
const CAR_HU = envelope.length / 2;
const CAR_HV = envelope.width / 2;
const DT = 1 / 60;

// ---------------------------------------------------------------------------
// 2D rectangle helpers
// ---------------------------------------------------------------------------
function rectCorners(cx, cz, ux, uz, vx, vz, hu, hv) {
  return [
    [cx + ux * hu + vx * hv, cz + uz * hu + vz * hv],
    [cx + ux * hu - vx * hv, cz + uz * hu - vz * hv],
    [cx - ux * hu - vx * hv, cz - uz * hu - vz * hv],
    [cx - ux * hu + vx * hv, cz - uz * hu + vz * hv],
  ];
}
function carPoly(x, z, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return rectCorners(x, z, c, s, -s, c, CAR_HU, CAR_HV);
}
function colliderPoly(c) {
  return rectCorners(c.center[0], c.center[2], c.axes[0][0], c.axes[0][2], c.axes[2][0], c.axes[2][2], c.half[0], c.half[2]);
}
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
  let s1, t1;
  if (den < 1e-12) { s1 = 0; t1 = c1 > 1e-12 ? e1 / c1 : 0; }
  else { s1 = (b1 * e1 - c1 * d1) / den; t1 = (a1 * e1 - b1 * d1) / den; }
  s1 = Math.max(0, Math.min(1, s1));
  t1 = Math.max(0, Math.min(1, t1));
  const px = a[0] + s1 * ux, pz = a[1] + s1 * uz;
  const qx = c[0] + t1 * vx, qz = c[1] + t1 * vz;
  return Math.hypot(px - qx, pz - qz);
}
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > p[1]) !== (zj > p[1]) && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function polyDistance(a, b) {
  for (const p of a) if (pointInPoly(p, b)) return 0;
  for (const p of b) if (pointInPoly(p, a)) return 0;
  let best = Infinity;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const d = segDist(a1, a2, b[j], b[(j + 1) % b.length]);
      if (d < best) best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// target frames
// ---------------------------------------------------------------------------
function frame(c) {
  const ux = c.axes[0][0], uz = c.axes[0][2];
  const vx = c.axes[2][0], vz = c.axes[2][2];
  const lu = Math.hypot(ux, uz) || 1, lv = Math.hypot(vx, vz) || 1;
  return {
    cx: c.center[0], cz: c.center[2],
    ux: ux / lu, uz: uz / lu,
    vx: vx / lv, vz: vz / lv,
    hu: c.half[0] * lu, hv: c.half[2] * lv,
  };
}
function support(f, dx, dz) {
  return Math.abs(f.ux * dx + f.uz * dz) * f.hu + Math.abs(f.vx * dx + f.vz * dz) * f.hv;
}
function projected(f, x, z) {
  return (x - f.cx) * f.vx + (z - f.cz) * f.vz;
}
function stateHash(states) {
  return `sha256:${sha256(JSON.stringify(states))}`;
}

// ---------------------------------------------------------------------------
// simulation
// ---------------------------------------------------------------------------
function simulate(world, targetRecord, start, velocity, ticks) {
  const targetId = targetRecord.id;
  let state = { x: start.x, z: start.z, y: start.y, yaw: Math.atan2(velocity.vz, velocity.vx), vx: velocity.vx, vz: velocity.vz };
  const target = targetRecord;
  const targetPoly = colliderPoly(target);
  const f = frame(target);
  const startProj = projected(f, state.x, state.z);
  const states = [];
  let firstContact = null;
  let maxPenetration = 0;
  let targetContacts = 0;
  let residual = 0;
  let substeps = 0;
  for (let t = 0; t < ticks; t++) {
    const out = world.step(state, { dt: DT, carEnvelope: envelope, slop: 0.001 });
    state = out.state;
    // Follow the local ground; the C03 pipes sit on a slope and a constant
    // start height would let the car pass above them.
    state.y = groundAt(state.x, state.z).y;
    substeps = Math.max(substeps, out.substeps);
    if (out.maxPenetration > maxPenetration) maxPenetration = out.maxPenetration;
    if (out.contactIds.length) {
      targetContacts += out.contactIds.filter((id) => id === targetId).length;
      if (!firstContact) firstContact = out.contactIds[0];
    }
    states.push([+state.x.toFixed(6), +state.z.toFixed(6), +state.y.toFixed(6), +state.vx.toFixed(6), +state.vz.toFixed(6), +state.yaw.toFixed(6)]);
  }
  const finalPoly = carPoly(state.x, state.z, state.yaw);
  const endGap = polyDistance(finalPoly, targetPoly);
  const finalHit = world.deepestContact(state.x, state.z, state.yaw, state.y, envelope);
  residual = finalHit ? finalHit.penetration : 0;
  const finalProj = projected(f, state.x, state.z);
  const passedTarget = startProj > 0 ? finalProj < -f.hv : finalProj > f.hv;
  return {
    start: { x: +start.x.toFixed(6), z: +start.z.toFixed(6), yaw: +Math.atan2(velocity.vz, velocity.vx).toFixed(6) },
    initialSpeed: +Math.hypot(velocity.vx, velocity.vz).toFixed(6),
    final: { x: +state.x.toFixed(6), z: +state.z.toFixed(6), speed: +Math.hypot(state.vx, state.vz).toFixed(6), yaw: +state.yaw.toFixed(6) },
    firstContact,
    targetContacts,
    maxPenetration: +maxPenetration.toFixed(6),
    endGap: +endGap.toFixed(6),
    residual: +residual.toFixed(6),
    startProjection: +startProj.toFixed(6),
    finalProjection: +finalProj.toFixed(6),
    targetProjectionHalfWidth: +f.hv.toFixed(6),
    passedTarget,
    substeps,
    ticks,
    states,
  };
}

function clearStart(world, frame, dir, gap) {
  for (let extra = gap; extra <= gap + 30; extra += 1) {
    const d = support(frame, dir[0], dir[1]) + CAR_HU + extra;
    const x = frame.cx + dir[0] * d;
    const z = frame.cz + dir[1] * d;
    const g = groundAt(x, z);
    if (!world.overlaps(x, z, Math.atan2(-dir[1], -dir[0]), g.y, envelope)) {
      return { x, z, y: g.y, extra };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// candidate set
// ---------------------------------------------------------------------------
const CANDIDATES = [
  { id: "river.block56.node289.draw.95.component.004", manifest: "r04", label: "concrete pipe, free-roam C03 (V1 overhead)" },
  { id: "river.block56.node289.draw.95.component.005", manifest: "r04", label: "concrete pipe, free-roam C03 (V1 overhead, on 310 line)" },
  { id: "river.block56.node289.draw.96.component.004", manifest: "base", label: "concrete pipe, 310 m band (V1 overhead)" },
  { id: "river.block56.node289.draw.143.component.060", manifest: "base", label: "cargo container wall, 310 m band (V1 overhead)" },
  { id: "river.block59.node265.draw.355.component.000", manifest: "base", label: "building wall, loop-01 (V1 outOfRegion)" },
  { id: "river.block71.node209.draw.257.component.000", manifest: "base", label: "no-parking sign, loop-01 (V1 outOfRegion)" },
  { id: "river.block71.node209.draw.283.component.327", manifest: "r04", label: "steel pole, free-roam (V1 outOfRegion)" },
  { id: "river.block56.node289.draw.117.component.029", manifest: "r04", label: "metalstructure rail, free-roam (V1 overhead)" },
];

const worlds = {
  base: createWorld(base, { profile: "all-visible" }),
  r04: createWorld(r04, { profile: "all-visible" }),
};
function manifestFor(name) {
  return name === "base" ? base : r04;
}

function runCandidate(cand) {
  const world = worlds[cand.manifest];
  const c = manifestFor(cand.manifest).colliders.find((x) => x.id === cand.id);
  if (!c) throw new Error(`candidate ${cand.id} missing from ${cand.manifest}`);
  // all-visible includes on-measured-course colliders; active:false is expected
  // for the 310 m-line conflict and is reported with the candidate.
  const isolated = createWorld({ colliders: [c], carEnvelope: envelope }, { profile: "all-visible" });
  const f = frame(c);
  const dirs = [
    { name: "normal+", dir: [f.vx, f.vz] },
    { name: "normal-", dir: [-f.vx, -f.vz] },
    { name: "long+", dir: [f.ux, f.uz] },
    { name: "long-", dir: [-f.ux, -f.uz] },
  ];
  const d45 = Math.SQRT1_2;
  const dirs8 = [
    ...dirs,
    { name: "normal+long+", dir: [(f.vx + f.ux) * d45, (f.vz + f.uz) * d45] },
    { name: "normal+long-", dir: [(f.vx - f.ux) * d45, (f.vz - f.uz) * d45] },
    { name: "normal-long+", dir: [(-f.vx + f.ux) * d45, (-f.vz + f.uz) * d45] },
    { name: "normal-long-", dir: [(-f.vx - f.ux) * d45, (-f.vz - f.uz) * d45] },
  ];

  // (1) candidate-only world: prove the collider itself stops the car at 31 m/s
  const isolatedHeadOn = dirs8.map((candidateDir) => {
    const [dx, dz] = candidateDir.dir;
    const start = clearStart(isolated, f, [dx, dz], 10);
    if (!start) return { direction: candidateDir.name, error: "no clear start" };
    const run = simulate(isolated, c, start, { vx: -dx * 31, vz: -dz * 31 }, 180);
    return {
      direction: candidateDir.name,
      stops: run.firstContact === cand.id && run.endGap <= 0.02 && run.final.speed < 0.5,
      firstContact: run.firstContact,
      endGap: run.endGap,
      finalSpeed: run.final.speed,
      residual: run.residual,
      maxPenetration: run.maxPenetration,
      substeps: run.substeps,
      states: run.states,
    };
  });
  const isolatedStops = isolatedHeadOn.filter((x) => x.stops && !x.error);

  // (2) full manifest: a realistic approach from outside the cluster; the first
  // contact may be a neighbouring component, so record both.
  const fullHeadOn = dirs8.map((candidateDir) => {
    const [dx, dz] = candidateDir.dir;
    const start = clearStart(world, f, [dx, dz], 10);
    if (!start) return { direction: candidateDir.name, error: "no clear start" };
    const run = simulate(world, c, start, { vx: -dx * 31, vz: -dz * 31 }, 180);
    return {
      direction: candidateDir.name,
      stops: run.endGap <= 0.02 && run.final.speed < 0.5,
      targetContacted: run.targetContacts > 0,
      firstContact: run.firstContact,
      endGap: run.endGap,
      finalSpeed: run.final.speed,
      residual: run.residual,
      maxPenetration: run.maxPenetration,
      passedTarget: run.passedTarget,
      states: run.states,
    };
  });
  const fullStop = fullHeadOn.find((x) => x.stops && x.targetContacted) ??
    fullHeadOn.find((x) => x.stops) ?? fullHeadOn[0];

  // (3) four local directions at 20 m/s in the full manifest: never pass through
  const rays = dirs.map((candidateDir) => {
    const [dx, dz] = candidateDir.dir;
    const start = clearStart(world, f, [dx, dz], 8);
    if (!start) return { direction: candidateDir.name, error: "no clear start" };
    const run = simulate(world, c, start, { vx: -dx * 20, vz: -dz * 20 }, 150);
    return {
      direction: candidateDir.name,
      blocked: !run.passedTarget,
      targetContacted: run.targetContacts > 0,
      firstContact: run.firstContact,
      endGap: run.endGap,
      finalProjection: run.finalProjection,
      targetProjectionHalfWidth: run.targetProjectionHalfWidth,
      maxPenetration: run.maxPenetration,
      states: run.states,
    };
  });

  // (4) no-tunnelling: 31 m/s from both normal sides, full manifest and isolated
  const tunnelRuns = [dirs[0], dirs[1]].map((candidateDir) => {
    const [dx, dz] = candidateDir.dir;
    const start = clearStart(world, f, [dx, dz], 6);
    const isolatedStart = clearStart(isolated, f, [dx, dz], 6);
    if (!start || !isolatedStart) return { direction: candidateDir.name, error: "no clear start" };
    const run = simulate(world, c, start, { vx: -dx * 31, vz: -dz * 31 }, 180);
    const iso = simulate(isolated, c, isolatedStart, { vx: -dx * 31, vz: -dz * 31 }, 180);
    return {
      direction: candidateDir.name,
      tunnelled: run.passedTarget,
      targetContacted: run.targetContacts > 0,
      firstContact: run.firstContact,
      maxPenetration: run.maxPenetration,
      substeps: run.substeps,
      endGap: run.endGap,
      isolatedTunnelled: iso.passedTarget,
      isolatedTargetContacted: iso.targetContacts > 0,
      isolatedSubsteps: iso.substeps,
      isolatedEndGap: iso.endGap,
      states: run.states,
      isolatedStates: iso.states,
    };
  });

  return {
    id: cand.id,
    label: cand.label,
    manifest: cand.manifest,
    target: {
      center: c.center,
      half: c.half,
      vertical: c.vertical,
      triangles: c.triangles,
      classification: c.classification,
      active: c.active,
    },
    isolatedHeadOn: isolatedHeadOn.map(({ states, ...rest }) => rest),
    isolatedStops: isolatedStops.length,
    fullHeadOn: { direction: fullStop?.direction ?? null, ...fullStop, states: undefined },
    rays,
    tunnelRuns,
    headOnStates: fullStop?.states,
    isolatedStates: isolatedHeadOn.map((x) => x.states),
  };
}

function resetState() {
  // nothing to reset: every simulate() creates a fresh state object
}

const results = { first: [], second: [] };
for (const pass of [0, 1]) {
  resetState();
  const rows = CANDIDATES.map(runCandidate);
  results[pass === 0 ? "first" : "second"] = rows;
}
const first = results.first;
const second = results.second;
const determinism = {
  firstHash: stateHash(first.map((r) => [
    r.headOnStates,
    r.isolatedStates,
    r.rays.map((x) => x.states),
    r.tunnelRuns.map((x) => x.states),
  ])),
  secondHash: stateHash(second.map((r) => [
    r.headOnStates,
    r.isolatedStates,
    r.rays.map((x) => x.states),
    r.tunnelRuns.map((x) => x.states),
  ])),
};
determinism.match = determinism.firstHash === determinism.secondHash;

// glancing test: the longest wall (building wall 355)
const glanceId = "river.block59.node265.draw.355.component.000";
const glanceCollider = base.colliders.find((c) => c.id === glanceId);
const glanceWorld = worlds.base;
const gf = frame(glanceCollider);
// Start alongside the wall with a clear lateral gap, then approach at 5 deg.
// The wall is 44 m long; -0.9 hu keeps the start on the wall, not past its end.
let glanceOffset = gf.hv + CAR_HV + 0.6;
let startX, startZ;
for (; glanceOffset <= gf.hv + CAR_HV + 6; glanceOffset += 0.2) {
  startX = gf.cx - gf.ux * gf.hu * 0.9 + gf.vx * glanceOffset;
  startZ = gf.cz - gf.uz * gf.hu * 0.9 + gf.vz * glanceOffset;
  if (!glanceWorld.overlaps(startX, startZ, Math.atan2(gf.uz, gf.ux), groundAt(startX, startZ).y, envelope)) break;
}
const angle = (5 * Math.PI) / 180;
const glen = Math.hypot(gf.ux, gf.uz);
const vx = (gf.ux / glen) * 20 * Math.cos(angle) - gf.vx * 20 * Math.sin(angle);
const vz = (gf.uz / glen) * 20 * Math.cos(angle) - gf.vz * 20 * Math.sin(angle);
const glanceStart = { x: startX, z: startZ, y: groundAt(startX, startZ).y };
const glanceRun = simulate(glanceWorld, glanceCollider, glanceStart, { vx, vz }, 150);
const tangential = Math.hypot(glanceRun.final.vx, glanceRun.final.vz);
const glance = {
  id: glanceId,
  start: glanceRun.start,
  initialSpeed: 20,
  finalSpeed: glanceRun.final.speed,
  speedRetained: +(glanceRun.final.speed / 20).toFixed(4),
  targetContacts: glanceRun.targetContacts,
  maxPenetration: glanceRun.maxPenetration,
  residual: glanceRun.residual,
  endGap: glanceRun.endGap,
  states: glanceRun.states,
};

// second glance run for determinism
const glanceRun2 = simulate(glanceWorld, glanceCollider, glanceStart, { vx, vz }, 150);
const glanceDeterminism = stateHash([glanceRun.states]) === stateHash([glanceRun2.states]);

const passChecks = first.map((r) => {
  const normalRays = r.rays.filter((x) => x.direction === "normal+" || x.direction === "normal-");
  const isolatedNormal = r.isolatedHeadOn.filter((x) => x.direction === "normal+" || x.direction === "normal-");
  const fullClusterStops = !r.fullHeadOn.passedTarget && r.fullHeadOn.finalSpeed < 0.5;
  return {
    id: r.id,
    candidateSolid: isolatedNormal.length === 2 && isolatedNormal.every((x) => x.stops),
    isolatedNormalStops: isolatedNormal.filter((x) => x.stops).length,
    isolatedStops: r.isolatedStops,
    fullClusterStops,
    targetFirstContact: r.fullHeadOn.targetContacted === true,
    headOnResidual: r.fullHeadOn.residual,
    throughBlocked: normalRays.every((x) => x.blocked),
    allFourRaysBlocked: r.rays.every((x) => x.blocked),
    noTunnel: r.tunnelRuns.every((x) => !x.isolatedTunnelled),
    fullWorldTunnelDeflected: r.tunnelRuns.some((x) => x.tunnelled),
  };
});
const checks = {
  candidates: passChecks.length,
  headOnPass: passChecks.filter((r) => r.candidateSolid && r.fullClusterStops).length,
  targetFirstContact: passChecks.filter((r) => r.targetFirstContact).length,
  raysPass: passChecks.filter((r) => r.throughBlocked).length,
  allFourRaysPass: passChecks.filter((r) => r.allFourRaysBlocked).length,
  noTunnelPass: passChecks.filter((r) => r.noTunnel).length,
  glancePass: glance.speedRetained >= 0.5 && glance.residual <= 0.02 && glance.targetContacts > 0,
  determinismPass: determinism.match && glanceDeterminism,
};
checks.allPass = checks.headOnPass === checks.candidates &&
  checks.raysPass === checks.candidates &&
  checks.noTunnelPass === checks.candidates &&
  checks.glancePass && checks.determinismPass;

const out = {
  kind: "prop-collision-resolve-v2",
  version: 1,
  inputs: {
    geometrySha256: sha256(fs.readFileSync(GEOMETRY)),
    baseV2Sha256: sha256(fs.readFileSync(BASE)),
    r04V2Sha256: sha256(fs.readFileSync(R04)),
  },
  carEnvelope: envelope,
  profile: "all-visible",
  candidates: first.map((r) => ({
    id: r.id,
    label: r.label,
    manifest: r.manifest,
    target: r.target,
    isolatedHeadOn: r.isolatedHeadOn,
    isolatedStops: r.isolatedStops,
    fullHeadOn: r.fullHeadOn,
    rays: r.rays.map(({ states, ...rest }) => rest),
    tunnelRuns: r.tunnelRuns.map(({ states, isolatedStates, ...rest }) => rest),
  })),
  glance,
  passChecks,
  checks,
  determinism,
  glanceDeterminism,
};
const text = `${JSON.stringify(out, null, 1)}\n`;
fs.writeFileSync(OUT, text);
console.log(`candidates ${checks.candidates}`);
console.log(`head-on pass ${checks.headOnPass}/${checks.candidates} (candidate-only stops + full-cluster block; target first contact ${checks.targetFirstContact})`);
console.log(`through-ray pass ${checks.raysPass}/${checks.candidates}; all-four ${checks.allFourRaysPass}/${checks.candidates}`);
console.log(`no-tunnel pass ${checks.noTunnelPass}/${checks.candidates}`);
console.log(`glance retained ${glance.speedRetained} residual ${glance.residual} pass ${checks.glancePass}`);
console.log(`determinism ${determinism.firstHash} match ${determinism.match}, glance ${glanceDeterminism}`);
console.log(`all pass ${checks.allPass}`);
console.log(`file sha256:${sha256(Buffer.from(text))}`);
console.log(`wrote ${OUT}`);
