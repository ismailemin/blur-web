#!/usr/bin/env node
/*
 * resolve.mjs — committed-resolver tests over the map-props collider manifests.
 *
 * Uses the committed P66/P74 resolver (`probes/prop-collision/lib/resolver.mjs`)
 * unchanged.  Tests, per map:
 *   1. spawn pose clear (both profiles);
 *   2. head-on stop at 31 m/s into the largest active building collider;
 *   3. 5 deg glancing slide along the longest active wall at 20 m/s;
 *   4. 31 m/s no-tunnelling into the 8 thinnest colliders;
 *   5. measured-path drive at 20 m/s, roadside (expect 0 contacts) and
 *      all-visible (contacts at the recorded blocked arcs);
 *   6. two-run determinism (state hash) for every simulation.
 *
 * Output: _work/map-props/resolve.json
 */

import fs from "node:fs";
import path from "node:path";
import { ROOT, MAPS, loadMapPackage, sha256 } from "../lib/package.mjs";
import {
  carCorners2D,
  colliderCorners2D,
  measureClearance,
  rectDistance2D,
} from "../lib/build.mjs";
import { buildPathIndex } from "../lib/pathindex.mjs";
import { CAR_ENVELOPE } from "../../prop-collision/lib/collider-build.mjs";
import { makeWindowedGround } from "../lib/ground.mjs";
import { createWorld } from "../../prop-collision/lib/resolver.mjs";

const OUT_DIR = path.join(ROOT, "_work", "map-props");
const DT = 1 / 60;
const CAR_HU = CAR_ENVELOPE.length / 2;
const CAR_HV = CAR_ENVELOPE.width / 2;
const round6 = (v) => Math.round(v * 1e6) / 1e6;

function frame(c) {
  const ux = c.axes[0][0], uz = c.axes[0][2];
  const vx = c.axes[2][0], vz = c.axes[2][2];
  const lu = Math.hypot(ux, uz) || 1;
  const lv = Math.hypot(vx, vz) || 1;
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

function stateHash(rows) {
  return `sha256:${sha256(JSON.stringify(rows))}`;
}

function groundRefAt(pkg, pathIndex, x, z) {
  const idx = pathIndex.nearestPointIndex(x, z);
  if (idx === null) return pkg.layout.spawn.ground;
  return pkg.pathGround[idx];
}

function simulate(world, target, groundAt, start, velocity, ticks, envelope) {
  let state = {
    x: start.x, z: start.z, y: start.y,
    yaw: Math.atan2(velocity.vz, velocity.vx),
    vx: velocity.vx, vz: velocity.vz,
  };
  const targetPoly = colliderCorners2D(target);
  const f = frame(target);
  const startProj = projected(f, state.x, state.z);
  const states = [];
  let firstContact = null;
  let maxPenetration = 0;
  let targetContacts = 0;
  let substeps = 0;
  for (let t = 0; t < ticks; t++) {
    const out = world.step(state, { dt: DT, carEnvelope: envelope, slop: 0.001 });
    state = out.state;
    state.y = groundAt(state.x, state.z, start.y, 8).y;
    substeps = Math.max(substeps, out.substeps);
    if (out.maxPenetration > maxPenetration) maxPenetration = out.maxPenetration;
    if (out.contactIds.length) {
      targetContacts += out.contactIds.filter((id) => id === target.id).length;
      if (!firstContact) firstContact = out.contactIds[0];
    }
    states.push([
      +state.x.toFixed(6), +state.z.toFixed(6), +state.y.toFixed(6),
      +state.vx.toFixed(6), +state.vz.toFixed(6), +state.yaw.toFixed(6),
    ]);
  }
  const finalPoly = carCorners2D(state.x, state.z, state.yaw, envelope);
  const endGap = rectDistance2D(finalPoly, targetPoly);
  const finalHit = world.deepestContact(state.x, state.z, state.yaw, state.y, envelope);
  const finalProj = projected(f, state.x, state.z);
  const passedTarget = startProj > 0 ? finalProj < -f.hv : finalProj > f.hv;
  return {
    start: { x: +start.x.toFixed(6), z: +start.z.toFixed(6), y: +start.y.toFixed(6), yaw: +Math.atan2(velocity.vz, velocity.vx).toFixed(6) },
    initialSpeed: +Math.hypot(velocity.vx, velocity.vz).toFixed(6),
    final: { x: +state.x.toFixed(6), z: +state.z.toFixed(6), speed: +Math.hypot(state.vx, state.vz).toFixed(6), yaw: +state.yaw.toFixed(6) },
    firstContact,
    targetContacts,
    maxPenetration: +maxPenetration.toFixed(6),
    endGap: +endGap.toFixed(6),
    residual: +(finalHit ? finalHit.penetration : 0).toFixed(6),
    startProjection: +startProj.toFixed(6),
    finalProjection: +finalProj.toFixed(6),
    targetProjectionHalfWidth: +f.hv.toFixed(6),
    passedTarget,
    substeps,
    ticks,
    states,
  };
}

function clearStart(world, f, dir, gap, groundAt, envelope) {
  for (let extra = gap; extra <= gap + 40; extra += 1) {
    const d = support(f, dir[0], dir[1]) + CAR_HU + extra;
    const x = f.cx + dir[0] * d;
    const z = f.cz + dir[1] * d;
    const g = groundAt(x, z, f.groundY ?? 0, 8);
    if (!world.overlaps(x, z, Math.atan2(-dir[1], -dir[0]), g.y, envelope)) {
      return { x, z, y: g.y, extra };
    }
  }
  return null;
}

function selectTargets(colliders) {
  const active = colliders.filter((c) => c.active !== false);
  const byFootprint = [...active].sort((a, b) => {
    const aa = a.size[0] * a.size[2];
    const bb = b.size[0] * b.size[2];
    return bb - aa || (a.id < b.id ? -1 : 1);
  });
  const wallLike = active
    .filter((c) => c.vertical.height >= 1.0 && Math.min(c.size[0], c.size[2]) <= 3.0)
    .sort((a, b) => {
      const la = Math.max(a.size[0], a.size[2]);
      const lb = Math.max(b.size[0], b.size[2]);
      return lb - la || (a.id < b.id ? -1 : 1);
    });
  const thin = [...active]
    .sort((a, b) => {
      const ta = Math.min(a.size[0], a.size[2]);
      const tb = Math.min(b.size[0], b.size[2]);
      return ta - tb || (a.id < b.id ? -1 : 1);
    })
    .slice(0, 8);
  return { byFootprint, wallLike, thin };
}

function runMap(mapKey) {
  const pkg = loadMapPackage(mapKey);
  const manifestPath = path.join(OUT_DIR, `colliders-${mapKey}.json`);
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const pathIndex = buildPathIndex(pkg.path);
  const ground = makeWindowedGround(pkg.collisionMesh, 8);
  const groundAt = (x, z, refY) => ground.sample(x, z, refY ?? pkg.layout.spawn.ground, 8);
  const envelope = manifest.carEnvelope;

  const worldAll = createWorld(manifest, { profile: "all-visible" });
  const worldRoadside = createWorld(manifest, { profile: "roadside" });

  // ---- 1. spawn clear ---------------------------------------------------
  const spawn = pkg.layout.spawn;
  const spawnPose = { x: spawn.x, z: spawn.z, y: spawn.ground, yaw: spawn.heading };
  const spawnResults = {};
  for (const [name, world] of [["roadside", worldRoadside], ["all-visible", worldAll]]) {
    const hit = world.deepestContact(spawnPose.x, spawnPose.z, spawnPose.yaw, spawnPose.y, envelope);
    const clearance = measureClearance(pkg, pathIndex, manifest.colliders, name);
    spawnResults[name] = {
      clear: hit === null,
      penetration: hit ? round6(hit.penetration) : 0,
      colliderId: hit ? hit.colliderId : null,
      pathMinClearanceM: clearance.minClearanceM,
    };
  }

  const targets = selectTargets(manifest.colliders);
  const targetResults = {};

  // ---- 2. head-on at 31 m/s --------------------------------------------
  // deterministic choice: the largest-footprint collider with a clear 10 m
  // approach on both normal sides in the full active world.
  let headOn = null;
  for (const c of targets.byFootprint.slice(0, 24)) {
    const f = frame(c);
    f.groundY = c.vertical.groundY;
    const plus = clearStart(worldAll, f, [f.vx, f.vz], 10, groundAt, envelope);
    const minus = clearStart(worldAll, f, [-f.vx, -f.vz], 10, groundAt, envelope);
    if (plus && minus) { headOn = c; break; }
  }
  if (!headOn) headOn = targets.byFootprint[0] ?? null;
  if (headOn) {
    const c = headOn;
    const f = frame(c);
    f.groundY = c.vertical.groundY;
    const isolated = createWorld({ colliders: [c], carEnvelope: envelope }, { profile: "all-visible" });
    const dirs = [
      { name: "normal+", dir: [f.vx, f.vz] },
      { name: "normal-", dir: [-f.vx, -f.vz] },
    ];
    targetResults.headOn = {
      id: c.id,
      label: `${c.structureClass} / ${c.provenance.texture}`,
      size: c.size.map(round6),
      vertical: c.vertical,
      directions: dirs.map((d) => {
        const start = clearStart(isolated, f, d.dir, 10, groundAt, envelope);
        if (!start) return { direction: d.name, error: "no clear start" };
        const run = simulate(isolated, c, groundAt, start, { vx: -d.dir[0] * 31, vz: -d.dir[1] * 31 }, 180, envelope);
        return {
          direction: d.name,
          stops: run.firstContact === c.id && run.endGap <= 0.02 && run.final.speed < 0.5,
          firstContact: run.firstContact,
          endGap: run.endGap,
          finalSpeed: run.final.speed,
          residual: run.residual,
          maxPenetration: run.maxPenetration,
          substeps: run.substeps,
          passedTarget: run.passedTarget,
          states: run.states,
        };
      }),
    };
    // full-manifest approach from the +normal side
    const start = clearStart(worldAll, f, [f.vx, f.vz], 10, groundAt, envelope);
    if (start) {
      const run = simulate(worldAll, c, groundAt, start, { vx: -f.vx * 31, vz: -f.vz * 31 }, 180, envelope);
      targetResults.headOn.fullManifest = {
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
    }
  }

  // ---- 3. glancing slide at 5 deg --------------------------------------
  // deterministic choice: the longest wall-like collider with a clear start
  // whose 5 deg run actually grazes the target and keeps most of its speed.
  let glanceResult = null;
  let glanceTried = 0;
  for (const c of targets.wallLike.slice(0, 24)) {
    const f = frame(c);
    let offset = f.hv + CAR_HV + 0.6;
    let sx = 0, sz = 0, found = false;
    for (; offset <= f.hv + CAR_HV + 12; offset += 0.2) {
      sx = f.cx - f.ux * f.hu * 0.9 + f.vx * offset;
      sz = f.cz - f.uz * f.hu * 0.9 + f.vz * offset;
      const g = groundAt(sx, sz, c.vertical.groundY);
      if (!worldAll.overlaps(sx, sz, Math.atan2(f.uz, f.ux), g.y, envelope)) { found = true; break; }
    }
    if (!found) continue;
    glanceTried += 1;
    const angle = (5 * Math.PI) / 180;
    const vx = f.ux * 20 * Math.cos(angle) - f.vx * 20 * Math.sin(angle);
    const vz = f.uz * 20 * Math.cos(angle) - f.vz * 20 * Math.sin(angle);
    const start = { x: sx, z: sz, y: groundAt(sx, sz, c.vertical.groundY).y };
    const run = simulate(worldAll, c, groundAt, start, { vx, vz }, 150, envelope);
    const row = {
      id: c.id,
      label: `${c.structureClass} / ${c.provenance.texture}`,
      lengthM: round6(Math.max(c.size[0], c.size[2])),
      start: run.start,
      initialSpeed: 20,
      finalSpeed: run.final.speed,
      speedRetained: +(run.final.speed / 20).toFixed(4),
      targetContacts: run.targetContacts,
      maxPenetration: run.maxPenetration,
      residual: run.residual,
      endGap: run.endGap,
      states: run.states,
    };
    if (glanceResult === null || row.speedRetained > glanceResult.speedRetained) glanceResult = row;
    if (row.targetContacts > 0 && row.residual <= 0.02 && row.speedRetained >= 0.5) {
      glanceResult = row;
      break;
    }
  }
  targetResults.glance = glanceResult
    ? { ...glanceResult, candidatesTried: glanceTried }
    : { id: null, error: "no wall-like collider with a clear glancing start", candidatesTried: glanceTried };
  const glance = glanceResult;

  // ---- 4. 31 m/s no tunnelling -----------------------------------------
  const tunnel = targets.thin.map((c) => {
    const f = frame(c);
    f.groundY = c.vertical.groundY;
    const isolated = createWorld({ colliders: [c], carEnvelope: envelope }, { profile: "all-visible" });
    const runs = [
      { name: "normal+", dir: [f.vx, f.vz] },
      { name: "normal-", dir: [-f.vx, -f.vz] },
    ].map((d) => {
      const start = clearStart(isolated, f, d.dir, 6, groundAt, envelope);
      if (!start) return { direction: d.name, error: "no clear start" };
      const run = simulate(isolated, c, groundAt, start, { vx: -d.dir[0] * 31, vz: -d.dir[1] * 31 }, 180, envelope);
      return {
        direction: d.name,
        tunnelled: run.passedTarget,
        targetContacted: run.targetContacts > 0,
        firstContact: run.firstContact,
        endGap: run.endGap,
        maxPenetration: run.maxPenetration,
        substeps: run.substeps,
        states: run.states,
      };
    });
    return {
      id: c.id,
      label: `${c.structureClass} / ${c.provenance.texture}`,
      minSizeM: round6(Math.min(c.size[0], c.size[2])),
      heightM: c.vertical.height,
      runs,
    };
  });

  // ---- 5. measured-path drive at 20 m/s --------------------------------
  function drive(world) {
    const speed = 20;
    const ticks = Math.ceil(pathIndex.lengthM / (speed * DT));
    const contacts = [];
    const states = [];
    let contactsAt = 0;
    const contactIds = new Set();
    let maxPenetration = 0;
    let residualMax = 0;
    for (let t = 0; t <= ticks; t++) {
      const s = Math.min(t * speed * DT, pathIndex.lengthM);
      const pose = pathIndex.poseAt(s);
      const baseY = pkg.pathGround[pose.index];
      const res = world.resolvePose(pose.x, pose.z, pose.yaw, baseY, envelope, { maxIterations: 8, slop: 0.001 });
      if (res.residual > residualMax) residualMax = res.residual;
      if (res.contacts.length) {
        contactsAt += 1;
        for (const ct of res.contacts) {
          contactIds.add(ct.colliderId);
          contacts.push({
            arcM: round6(s),
            colliderId: ct.colliderId,
            classification: ct.classification,
            penetration: round6(ct.penetration),
            normal: ct.normal.map(round6),
          });
          if (ct.penetration > maxPenetration) maxPenetration = ct.penetration;
        }
      }
      states.push([+res.x.toFixed(6), +res.z.toFixed(6), +baseY.toFixed(6), +pose.yaw.toFixed(6), round6(res.residual)]);
    }
    const arcs = [];
    for (const ct of contacts) {
      const last = arcs[arcs.length - 1];
      if (last && ct.arcM <= last.lastArc + 0.5) {
        last.lastArc = Math.max(last.lastArc, ct.arcM);
        last.colliderIds.add(ct.colliderId);
      } else {
        arcs.push({ firstArc: ct.arcM, lastArc: ct.arcM, colliderIds: new Set([ct.colliderId]) });
      }
    }
    return {
      speedMps: speed,
      dt: DT,
      ticks,
      poses: ticks + 1,
      contactsAt,
      contactCount: contacts.length,
      distinctColliders: contactIds.size,
      maxPenetration: round6(maxPenetration),
      residualMax: round6(residualMax),
      arcs: arcs.map((a) => ({ arcStart: round6(a.firstArc), arcEnd: round6(a.lastArc), colliders: a.colliderIds.size, colliderIds: [...a.colliderIds].sort() })),
      firstContacts: contacts.slice(0, 24),
      states,
    };
  }
  const driveRoadside = drive(worldRoadside);
  const driveAll = drive(worldAll);

  // states of this run, hashed by the caller against a second independent run
  const stateRows = [
    ...(targetResults.headOn?.directions ?? []).map((d) => d.states),
    targetResults.headOn?.fullManifest?.states ?? null,
    targetResults.glance?.states ?? null,
    ...tunnel.flatMap((t) => t.runs.map((r) => r.states)),
    driveRoadside.states,
    driveAll.states,
  ];
  return {
    mapKey,
    level: manifest.level,
    manifest: {
      path: `_work/map-props/colliders-${mapKey}.json`,
      sha256: sha256(manifestBytes),
      contentSha256: manifest.contentSha256,
    },
    carEnvelope: envelope,
    spawn: spawnResults,
    targets: {
      headOn: headOn?.id ?? null,
      glance: glance?.id ?? null,
      thin: targets.thin.map((c) => c.id),
    },
    headOn: targetResults.headOn ?? null,
    glance: targetResults.glance ?? null,
    noTunnel: {
      candidates: tunnel.length,
      pass: tunnel.filter((t) => t.runs.every((r) => !r.tunnelled && r.targetContacted)).length,
      rows: tunnel.map((t) => ({ id: t.id, label: t.label, minSizeM: t.minSizeM, heightM: t.heightM, runs: t.runs.map(({ states, ...rest }) => rest) })),
    },
    pathDrive: {
      roadside: driveRoadside,
      allVisible: driveAll,
    },
    stateHash: stateHash(stateRows),
  };
}

const results = { schema: "blur.map-props.resolve/1", version: 1, maps: {} };
for (const mapKey of Object.keys(MAPS)) {
  const first = runMap(mapKey);
  const second = runMap(mapKey);
  first.determinism = {
    firstHash: first.stateHash,
    secondHash: second.stateHash,
    match: first.stateHash === second.stateHash,
  };
  delete first.stateHash;
  results.maps[mapKey] = first;
}

// strip state arrays from the written file (keep hashes + scalars)
const written = JSON.parse(JSON.stringify(results, (k, v) => (k === "states" ? undefined : v)));
fs.writeFileSync(path.join(OUT_DIR, "resolve.json"), `${JSON.stringify(written, null, 1)}\n`);

for (const mapKey of Object.keys(MAPS)) {
  const r = results.maps[mapKey];
  const h = r.headOn;
  const g = r.glance;
  console.log(`== ${mapKey} (${r.level})`);
  console.log(`   spawn clear roadside=${r.spawn.roadside.clear} all-visible=${r.spawn["all-visible"].clear}`);
  console.log(`   head-on ${h ? `${h.id}: isolated ${h.directions.filter((d) => d.stops).length}/2 stop; full ${h.fullManifest ? `${h.fullManifest.stops} (target ${h.fullManifest.targetContacted})` : "n/a"}` : "none"}`);
  console.log(`   glance ${g ? `${g.id}: retained ${g.speedRetained}, contacts ${g.targetContacts}, residual ${g.residual}` : "none"}`);
  console.log(`   no-tunnel ${r.noTunnel.pass}/${r.noTunnel.candidates}`);
  console.log(`   path drive roadside contacts ${r.pathDrive.roadside.contactCount} poses ${r.pathDrive.roadside.contactsAt}/${r.pathDrive.roadside.poses}`);
  console.log(`   path drive all-visible contacts ${r.pathDrive.allVisible.contactCount} poses ${r.pathDrive.allVisible.contactsAt}/${r.pathDrive.allVisible.poses} arcs ` +
    r.pathDrive.allVisible.arcs.map((a) => `${a.arcStart}-${a.arcEnd}(${a.colliders})`).join(", "));
  console.log(`   determinism ${r.determinism.match} ${r.determinism.firstHash}`);
}
const text = fs.readFileSync(path.join(OUT_DIR, "resolve.json"));
console.log(`\nwrote _work/map-props/resolve.json  ${text.length} B  sha256:${sha256(text)}`);
