#!/usr/bin/env node
/*
 * measure_course.mjs — gameplay/parity impact of the per-car envelope.
 *
 * Reads the PHYS1 manifest and the committed 310 m course, then re-runs the
 * committed P66/P74 resolver for three envelopes per integrated car:
 *
 *   fixed — the 2.98 x 1.68 x 1.35 m box every consumer uses today;
 *   axle  — the car's own wheelbase x widest track x 1.35 m;
 *   body  — the car's own visible mesh AABB (upper bound).
 *
 * The resolver, collider manifest and ground sampler are imported read-only
 * from `probes/prop-collision`.  No browser, no engine tick, no e1-drive change.
 *
 *   node probes/physics/tools/measure_course.mjs
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createWorld } from "../../prop-collision/lib/resolver.mjs";
import { makeGroundSampler } from "../../prop-collision/lib/geometry.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const ENVELOPE = path.join(ROOT, "_work", "physics", "envelope.json");
const COLLIDERS = path.join(ROOT, "_work", "prop-collision", "colliders-v2.json");
const GEOMETRY = path.join(ROOT, "_work", "e1-drive", "geometry.json");
const PATH_JSON = path.join(ROOT, "_work", "drivable-path", "path.json");
const OUT = path.join(ROOT, "_work", "physics", "measure-course.json");
const LOG = path.join(ROOT, "_work", "logs", "physics", "measure-course.log");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const envelope = JSON.parse(fs.readFileSync(ENVELOPE, "utf8"));
const colliders = JSON.parse(fs.readFileSync(COLLIDERS, "utf8"));
const geometry = JSON.parse(fs.readFileSync(GEOMETRY, "utf8"));
const pathData = JSON.parse(fs.readFileSync(PATH_JSON, "utf8"));
const points = pathData.course.points;
const arcPerSample = pathData.course.length / (points.length - 1);
const groundAt = makeGroundSampler(geometry.collisionSurface.mesh);

const worlds = {
  roadside: createWorld(colliders, { profile: "roadside" }),
  "all-visible": createWorld(colliders, { profile: "all-visible" }),
};

function yawAt(i) {
  const a = points[Math.max(0, i - 1)];
  const b = points[Math.min(points.length - 1, i + 1)];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

function sweep(world, box) {
  const hits = [];
  for (let i = 0; i < points.length; i++) {
    const [x, z] = points[i];
    const yaw = yawAt(i);
    const g = groundAt(x, z);
    const hit = world.deepestContact(x, z, yaw, g.y, box);
    if (hit) {
      hits.push({
        sample: i,
        arc: +(i * arcPerSample).toFixed(3),
        colliderId: hit.colliderId,
        classification: hit.classification,
        penetration: +hit.penetration.toFixed(4),
        groundY: +g.y.toFixed(4),
      });
    }
  }
  return hits;
}

function arcs(rows) {
  const out = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && row.arc <= last.arcEnd + 0.5) {
      last.arcEnd = Math.max(last.arcEnd, row.arc);
      if (!last.colliders.includes(row.colliderId)) last.colliders.push(row.colliderId);
    } else {
      out.push({ arcStart: row.arc, arcEnd: row.arc, colliders: [row.colliderId] });
    }
  }
  return out.map((entry) => ({
    arcStart: entry.arcStart,
    arcEnd: entry.arcEnd,
    colliders: entry.colliders.sort(),
  }));
}

const integrated = envelope.cars.filter((c) => c.integrationStage === "integrated-batch1");
const rows = [];
for (const car of integrated) {
  const v = car.physics.values;
  const wb = v["geometry.wheelBase"].value;
  const tf = v["geometry.trackWidthFront"].value;
  const tr = v["geometry.trackWidthRear"].value;
  const body = car.bodyEnvelope;
  if (typeof body.length !== "number") throw new Error(car.name + ": no body AABB");
  const boxes = {
    fixed: { length: 2.98, width: 1.68, height: 1.35 },
    axle: { length: wb, width: Math.max(tf, tr), height: 1.35 },
    body: { length: body.length, width: body.width, height: body.height },
  };
  const entry = {
    name: car.name,
    slug: car.slug,
    envelopes: boxes,
    profiles: {},
  };
  for (const profile of ["roadside", "all-visible"]) {
    entry.profiles[profile] = {};
    for (const kind of ["fixed", "axle", "body"]) {
      const hits = sweep(worlds[profile], boxes[kind]);
      entry.profiles[profile][kind] = {
        blockedSamples: hits.length,
        blockedArcs: arcs(hits),
        firstBlocked: hits[0] ?? null,
      };
    }
  }
  rows.push(entry);
}

const payload = {
  kind: "blur.vehicle-physics-envelope-course-impact",
  version: 1,
  scope: {
    cars: rows.length,
    samples: points.length,
    courseLength: pathData.course.length,
    resolver: "probes/prop-collision/lib/resolver.mjs (committed, unmodified)",
    profiles: ["roadside", "all-visible"],
    envelopes: ["fixed", "axle", "body"],
    gameClaim: false,
    browserClaim: false,
  },
  inputs: {
    envelope: { path: "_work/physics/envelope.json", sha256: sha256(fs.readFileSync(ENVELOPE)) },
    colliders: { path: "_work/prop-collision/colliders-v2.json", sha256: sha256(fs.readFileSync(COLLIDERS)) },
    geometry: { path: "_work/e1-drive/geometry.json", sha256: sha256(fs.readFileSync(GEOMETRY)) },
    path: { path: "_work/drivable-path/path.json", sha256: sha256(fs.readFileSync(PATH_JSON)) },
  },
  cars: rows,
};

const text = JSON.stringify(payload, null, 2) + "\n";
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(OUT, text);
fs.writeFileSync(LOG, text);

const summary = rows.map((r) => {
  const line = [r.name];
  for (const profile of ["roadside", "all-visible"]) {
    for (const kind of ["fixed", "axle", "body"]) {
      const b = r.profiles[profile][kind];
      line.push(`${profile}/${kind}=${b.blockedSamples}`);
    }
  }
  return line.join(" ");
});
console.log(summary.join("\n"));
console.log("sha256", sha256(text));
