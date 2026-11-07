#!/usr/bin/env node
/*
 * verify_v2.mjs — gate for the P74 V2 collision data.
 *
 * Reads the produced manifests and the measurement/resolver artifacts and
 * checks the claims made in docs/work/analysis/prop-collision.md.  It does not
 * modify any manifest.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stableStringify, sha256 as sha256Text } from "../lib/collider-build.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const P = (rel) => path.join(ROOT, ...rel.split("/"));
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const read = (rel) => fs.readFileSync(P(rel));
const json = (rel) => JSON.parse(read(rel).toString("utf8"));

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail: String(detail) });
}

const base = json("_work/prop-collision/colliders-v2.json");
const r04 = json("_work/free-roam-prop/colliders-r04-v2.json");
const committed = json("_work/prop-collision/colliders.json");
const committedR04 = json("_work/free-roam-prop/colliders-r04.json");
const measure = json("_work/prop-collision/measure-v2.json");
const resolve = json("_work/prop-collision/resolve-v2.json");
const gap = json("_work/prop-collision/gap-v2.json");
const pass = json("_work/prop-collision/pass-through-list.json");
const corridor = json("_work/prop-collision/corridor-v2.json");
const freeProps = json("_work/prop-collision/free-v2/props.json");
const v1 = json("_work/prop-collision/v1-regression.json");

check("base kind/version", base.kind === "prop-collision-colliders" && base.version === 1, base.kind);
check("base variant", base.variant === "playable-regions-v2", base.variant);
check("base collider count", base.counts.colliders === 651, base.counts.colliders);
check("base active count", base.counts.active === 553, base.counts.active);
check("base on-course count", base.counts.inactiveOnMeasuredCourse === 98, base.counts.inactiveOnMeasuredCourse);
check("base content hash", base.contentSha256 === sha256Text(stableStringify(base.colliders)), base.contentSha256);
check("base input geometry current", base.inputs.geometry.sha256 === sha256(read("_work/e1-drive/geometry.json")), base.inputs.geometry.sha256);
check("base input path", base.inputs.path.sha256 === sha256(read("_work/drivable-path/path.json")));

let baseHashOk = true;
for (const c of base.colliders) {
  const { hash, ...rest } = c;
  if (hash !== `sha256:${sha256Text(stableStringify(rest))}`) baseHashOk = false;
}
check("base per-collider hashes", baseHashOk, `${base.colliders.length}/${base.colliders.length}`);
check("base colliders sorted/unique", base.colliders.every((c, i, a) => i === 0 || a[i - 1].id < c.id), "sorted");

check("r04 kind/version", r04.kind === "prop-collision-colliders" && r04.version === 1, r04.kind);
check("r04 variant", r04.variant === "free-roam-r04" && r04.variantRevision === "v2", `${r04.variant}/${r04.variantRevision}`);
check("r04 collider count", r04.counts.colliders === 447, r04.counts.colliders);
check("r04 active count", r04.counts.active === 371, r04.counts.active);
check("r04 on-course count", r04.counts.inactiveOnMeasuredCourse === 76, r04.counts.inactiveOnMeasuredCourse);
check("r04 content hash", r04.contentSha256 === sha256Text(stableStringify(r04.colliders)), r04.contentSha256);
check("r04 region input", r04.inputs.region.sha256 === sha256(read("_work/free-roam-prop/region.json")), r04.inputs.region.sha256);

let r04HashOk = true;
for (const c of r04.colliders) {
  const { hash, ...rest } = c;
  if (hash !== `sha256:${sha256Text(stableStringify(rest))}`) r04HashOk = false;
}
check("r04 per-collider hashes", r04HashOk, `${r04.colliders.length}/${r04.colliders.length}`);

check("committed manifests untouched", sha256(read("_work/prop-collision/colliders.json")) ===
  "a98fb8eb7e7a6f6851e0c6b5671d40be2c346d0c28a2442df0fe6ab497317af4" &&
  sha256(read("_work/free-roam-prop/colliders-r04.json")) ===
  "5c7bba74fd9c978b4ff9e729287c9a7935d827f4d353c2c918da9d1788a49805", "pinned");

check("V1 derivation unchanged", v1.contentMatch === true && v1.colliderArrayMatch === true,
  `content ${v1.contentSha256.slice(0, 8)}…`);

check("gap V2 base unresolved", gap.counts.baseUnresolved === 0, gap.counts.baseUnresolved);
check("gap V2 r04 unresolved in free box", gap.counts.r04UnresolvedInFreeBox === 0, gap.counts.r04UnresolvedInFreeBox);

check("pass-through lap after V2", pass.summary.lap.passThroughAfterV2 === 0, pass.summary.lap.passThroughAfterV2);
check("pass-through free after V2", pass.summary.free.passThroughAfterV2 === 2, pass.summary.free.passThroughAfterV2);
check("pass-through course after V2 (on-course exclusions)", pass.summary.course.passThroughAfterV2 === 61, pass.summary.course.passThroughAfterV2);

check("310 roadside centreline clear", measure.base.roadside.course.blockedSamples === 0, measure.base.roadside.course.blockedSamples);
check("310 all-visible arcs", measure.base.allVisible.course.blockedArcs.length === 4, measure.base.allVisible.course.blockedArcs.length);
check("310 all-visible blocked samples", measure.base.allVisible.course.blockedSamples === 181, measure.base.allVisible.course.blockedSamples);
check("lap clear (base all-visible)", measure.base.allVisible.lap.blockedSamples === 0, measure.base.allVisible.lap.blockedSamples);
check("lap band has clear offsets", measure.base.allVisible.lapBand.fullyBlockedRows === 0, measure.base.allVisible.lapBand.fullyBlockedRows);
check("free route clear (base)", measure.base.allVisible.free.routeBlockedSamples === 0, measure.base.allVisible.free.routeBlockedSamples);
check("free route clear (r04-v2)", measure.r04.allVisible.free.routeBlockedSamples === 0, measure.r04.allVisible.free.routeBlockedSamples);
check("free spawn clear (r04-v2)", measure.r04.allVisible.free.spawn.blocked === false, measure.r04.allVisible.free.spawn.clearanceM);

check("roadside +/-2.6 corridor reachable", corridor.roadside.find((c) => c.bandHalfWidth === 2.6)?.reachable === true, "2.6 m");
check("roadside +/-3.5 corridor reachable", corridor.roadside.find((c) => c.bandHalfWidth === 3.5)?.reachable === true, "3.5 m");
check("all-visible corridor blocked", corridor.allVisible[0].reachable === false, "expected data conflict");

check("free spawn component", freeProps.free.spawnComponentM2 === 7415, freeProps.free.spawnComponentM2);
check("free components/pockets", freeProps.free.componentCount === 6 && freeProps.free.pocketCount === 5,
  `${freeProps.free.componentCount}/${freeProps.free.pocketCount}`);
check("free route", freeProps.route.lengthM === 135.619, freeProps.route.lengthM);

check("resolver all pass", resolve.checks.allPass === true, JSON.stringify(resolve.checks));
check("resolver determinism", resolve.determinism.match === true, resolve.determinism.firstHash);
check("resolver head-on", resolve.checks.headOnPass === 8, resolve.checks.headOnPass);
check("resolver through rays", resolve.checks.raysPass === 8, resolve.checks.raysPass);
check("resolver no tunnel", resolve.checks.noTunnelPass === 8, resolve.checks.noTunnelPass);
check("resolver glance", resolve.checks.glancePass === true, `${resolve.glance.speedRetained} retained`);

const ok = checks.filter((c) => c.ok).length;
const out = {
  kind: "prop-collision-verify-v2",
  version: 1,
  inputs: {
    baseV2Sha256: sha256(read("_work/prop-collision/colliders-v2.json")),
    r04V2Sha256: sha256(read("_work/free-roam-prop/colliders-r04-v2.json")),
  },
  checks,
  passed: ok,
  total: checks.length,
  failures: checks.filter((c) => !c.ok),
};
const text = `${JSON.stringify(out, null, 1)}\n`;
fs.writeFileSync(P("_work/prop-collision/verify-v2.json"), text);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  ${c.detail}`);
console.log(`\n${ok}/${checks.length} checks`);
console.log(`file sha256:${sha256(Buffer.from(text))}`);
process.exitCode = ok === checks.length ? 0 : 1;
