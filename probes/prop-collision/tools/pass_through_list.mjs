#!/usr/bin/env node
/*
 * pass_through_list.mjs — what the playable PoC could drive through before V2,
 * and whether V2 covers it.
 *
 * Output: _work/prop-collision/pass-through-list.json
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const DIAG = path.join(ROOT, "_work", "prop-collision", "gap-diagnose.json");
const NORMALS = path.join(ROOT, "_work", "prop-collision", "normal-census.json");
const COMMITTED = path.join(ROOT, "_work", "prop-collision", "colliders.json");
const COMMITTED_R04 = path.join(ROOT, "_work", "free-roam-prop", "colliders-r04.json");
const BASE_V2 = path.join(ROOT, "_work", "prop-collision", "colliders-v2.json");
const R04_V2 = path.join(ROOT, "_work", "free-roam-prop", "colliders-r04-v2.json");
const OUT = path.join(ROOT, "_work", "prop-collision", "pass-through-list.json");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

const diag = JSON.parse(fs.readFileSync(DIAG, "utf8"));
const normals = JSON.parse(fs.readFileSync(NORMALS, "utf8"));
const committed = JSON.parse(fs.readFileSync(COMMITTED, "utf8"));
const committedR04 = JSON.parse(fs.readFileSync(COMMITTED_R04, "utf8"));
const baseV2 = JSON.parse(fs.readFileSync(BASE_V2, "utf8"));
const r04V2 = JSON.parse(fs.readFileSync(R04_V2, "utf8"));
const normalById = new Map(normals.rows.map((r) => [r.id, r]));
const committedById = new Map(committed.colliders.map((c) => [c.id, c]));
const committedR04ById = new Map(committedR04.colliders.map((c) => [c.id, c]));
const baseV2ById = new Map(baseV2.colliders.map((c) => [c.id, c]));
const r04V2ById = new Map(r04V2.colliders.map((c) => [c.id, c]));

function isVerticalStructure(r) {
  const n = normalById.get(r.id);
  if (r.heightAboveGround < 0.5 || r.bottomAboveGround >= 2.5 || r.size[1] < 0.5) return false;
  if (r.classification === "terrain" || r.classification === "ground-surface") {
    if (n && n.upRatio >= 0.5) return false;
    if (n && !(n.verticalRatio >= 0.5 && r.heightAboveGround >= 1.0)) return false;
  }
  return true;
}

function modeState(r, mode) {
  let collider = null;
  let solid = false;
  let reason = "no-collider";
  if (mode === "free") {
    collider = committedR04ById.get(r.id) ?? null;
    solid = !!collider; // all-visible
    if (!collider) reason = r.v1Reason;
  } else if (mode === "lap") {
    collider = committedById.get(r.id) ?? null;
    solid = !!collider; // all-visible
    if (!collider) reason = r.v1Reason;
  } else {
    collider = committedById.get(r.id) ?? null;
    solid = !!collider && collider.active; // roadside
    if (!collider) reason = r.v1Reason;
    else if (!collider.active) reason = "on-measured-course-inactive";
  }
  let v2 = null;
  const v2Collider = mode === "free" ? r04V2ById.get(r.id) : baseV2ById.get(r.id);
  if (v2Collider) v2 = v2Collider.active ? "collider-active" : "collider-on-course-inactive";
  return { solid, reason, v2 };
}

const modes = ["free", "lap", "course"];
const rows = [];
for (const r of diag.rows) {
  if (!isVerticalStructure(r)) continue;
  const inMode = (mode) =>
    mode === "free" ? r.inFreeBox :
    mode === "lap" ? r.inLapCorridor :
    r.inCourseRegion;
  for (const mode of modes) {
    if (!inMode(mode)) continue;
    const state = modeState(r, mode);
    rows.push({
      mode,
      id: r.id,
      drawId: r.drawId,
      texture: r.texture,
      classification: r.classification,
      worldAabb: r.worldAabb,
      heightAboveGround: r.heightAboveGround,
      bottomAboveGround: r.bottomAboveGround,
      triangles: r.triangles,
      distanceToCourse: r.distanceToCourse,
      distanceToLoop01: r.distanceToLoop01,
      solidBeforeV2: state.solid,
      reasonBeforeV2: state.reason,
      v2State: state.v2,
      passThroughBeforeV2: !state.solid,
      // the timed course uses roadside, so an on-course collider is still
      // pass-through there even though all-visible would make it solid.
      passThroughAfterV2: mode === "course"
        ? state.v2 !== "collider-active"
        : !(state.v2 === "collider-active" || state.v2 === "collider-on-course-inactive"),
    });
  }
}

function summarize(mode) {
  const list = rows.filter((r) => r.mode === mode);
  const before = list.filter((r) => r.passThroughBeforeV2);
  const after = list.filter((r) => r.passThroughAfterV2);
  const groups = new Map();
  for (const r of before) {
    const key = r.drawId;
    if (!groups.has(key)) {
      groups.set(key, {
        drawId: key,
        texture: r.texture,
        classification: r.classification,
        count: 0,
        heightMin: Infinity,
        heightMax: -Infinity,
        aabb: {
          min: [Infinity, Infinity, Infinity],
          max: [-Infinity, -Infinity, -Infinity],
        },
        reason: r.reasonBeforeV2,
        v2States: new Set(),
        ids: [],
      });
    }
    const g = groups.get(key);
    g.count += 1;
    g.heightMin = Math.min(g.heightMin, r.heightAboveGround);
    g.heightMax = Math.max(g.heightMax, r.heightAboveGround);
    for (let k = 0; k < 3; k++) {
      g.aabb.min[k] = Math.min(g.aabb.min[k], r.worldAabb.min[k]);
      g.aabb.max[k] = Math.max(g.aabb.max[k], r.worldAabb.max[k]);
    }
    g.v2States.add(r.v2State);
    g.ids.push(r.id);
  }
  return {
    mode,
    verticalStructures: list.length,
    solidBeforeV2: list.filter((r) => r.solidBeforeV2).length,
    passThroughBeforeV2: before.length,
    passThroughAfterV2: after.length,
    groups: [...groups.values()].map((g) => ({
      ...g,
      heightMin: +g.heightMin.toFixed(3),
      heightMax: +g.heightMax.toFixed(3),
      aabb: {
        min: g.aabb.min.map((v) => +v.toFixed(3)),
        max: g.aabb.max.map((v) => +v.toFixed(3)),
      },
      v2States: [...g.v2States].sort(),
    })),
  };
}

const out = {
  kind: "prop-collision-pass-through-list",
  version: 1,
  inputs: {
    gapDiagnoseSha256: sha256(fs.readFileSync(DIAG)),
    normalCensusSha256: sha256(fs.readFileSync(NORMALS)),
    committedSha256: sha256(fs.readFileSync(COMMITTED)),
    committedR04Sha256: sha256(fs.readFileSync(COMMITTED_R04)),
    baseV2Sha256: sha256(fs.readFileSync(BASE_V2)),
    r04V2Sha256: sha256(fs.readFileSync(R04_V2)),
  },
  modes: {
    free: { manifestBefore: "_work/free-roam-prop/colliders-r04.json", profileBefore: "all-visible", manifestAfter: "_work/free-roam-prop/colliders-r04-v2.json" },
    lap: { manifestBefore: "_work/prop-collision/colliders.json", profileBefore: "all-visible", manifestAfter: "_work/prop-collision/colliders-v2.json" },
    course: { manifestBefore: "_work/prop-collision/colliders.json", profileBefore: "roadside", manifestAfter: "_work/prop-collision/colliders-v2.json" },
  },
  summary: Object.fromEntries(modes.map((m) => [m, summarize(m)])),
  rows,
};
const text = `${JSON.stringify(out, null, 1)}\n`;
fs.writeFileSync(OUT, text);
for (const m of modes) {
  const s = out.summary[m];
  console.log(`${m}: vertical ${s.verticalStructures}, pass-through before ${s.passThroughBeforeV2}, after ${s.passThroughAfterV2}, groups ${s.groups.length}`);
  for (const g of s.groups) {
    console.log(`  ${g.drawId} ${g.texture} n=${g.count} h=${g.heightMin}..${g.heightMax} reason=${g.reason} v2=${g.v2States.join(",")}`);
  }
}
console.log(`file sha256:${sha256(Buffer.from(text))}`);
console.log(`wrote ${OUT}`);
