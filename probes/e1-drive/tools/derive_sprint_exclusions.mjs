// Derive the timed 310 m sprint's measured driven-line prop exclusions (P74b).
//
// The P74 V2 `roadside` profile is clear on the *measured centreline* (0 of 1,245
// poses). The committed scripted sprint does not drive the centreline exactly: its
// Stanley follower has up to ~0.6-0.9 m lateral error, so it grazes fence posts and
// rack components that are active in that profile. This tool sweeps the committed
// reference ghost traces (the anchored five-car sprint runs) through the same
// additive layer and records exactly which colliders the committed line touches.
//
// The result is a measured exclusion set: the app marks those ids inactive for the
// timed 310 m course only, so the committed run stays bit-identical (0 contacts),
// while every other V2 structure is solid. The manifest itself is not modified;
// the exclusion set is re-derived and compared by `verify_e1_drive.mjs`.
//
// Inputs (read-only): _work/prop-collision/colliders-v2.json,
// _work/e1-drive/sprint.json, probes/e1-drive/ghosts/index.json and the five
// committed 310 m ghost records.
//
// Output: _work/e1-drive/sprint-driven-exclusions.json and the JSON array printed
// to stdout for `SPRINT_DRIVEN_EXCLUSIONS` in web/prop-layer.js.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPRINT_PROP_PINS, propYawFromHeading } from '../web/prop-layer.js';
import { courseGroundAt, coursePosition } from '../web/sprint-rules.js';
import { decodeGhost, ghostPoseAt, matrixFromQuaternion, referenceGhostFileName } from '../web/ghost-replay.js';
import { createWorld } from '../../prop-collision/lib/resolver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORK = path.join(ROOT, '_work/e1-drive');
const GHOSTS = path.join(ROOT, 'probes/e1-drive/ghosts');
const MANIFEST = path.join(ROOT, SPRINT_PROP_PINS.manifest);
const LAYOUT = path.join(WORK, 'sprint.json');

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const manifestBytes = readFileSync(MANIFEST);
const fileSha = 'sha256:' + sha256(manifestBytes);
if (fileSha !== SPRINT_PROP_PINS.manifestFileSha256) {
  throw new Error('manifest is not the pinned V2 file: ' + fileSha);
}
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const layout = JSON.parse(readFileSync(LAYOUT, 'utf8'));
const indexBytes = readFileSync(path.join(GHOSTS, 'index.json'));
const index = JSON.parse(indexBytes.toString('utf8'));

const world = createWorld(manifest, { profile: SPRINT_PROP_PINS.profile });
if (world.colliders.length !== SPRINT_PROP_PINS.profileColliders) {
  throw new Error('roadside world is ' + world.colliders.length + ', pinned profile ' +
    SPRINT_PROP_PINS.profileColliders);
}

// The timed course's prop layer resolves the engine delta in 8 cm substeps, so a
// car can touch a thin collider between two 60 Hz ticks. This deriver reproduces
// that same sweep (same envelope, yaw, ground and resolvePose options) and
// iterates to a fixed point: every collider the measured line touches is added,
// the filtered world is rebuilt, and the sweep repeats until it is clear.
const envelope = manifest.carEnvelope;
const ghosts = [];
for (const [slug, courses] of Object.entries(index.cars)) {
  const entry = courses?.['310m'];
  if (!entry) throw new Error('no committed 310 m ghost for ' + slug);
  const file = path.join(GHOSTS, referenceGhostFileName(slug, '310m'));
  const bytes = readFileSync(file);
  const fileHash = 'sha256:' + sha256(bytes);
  if (entry.sha256 && fileHash !== entry.sha256) {
    throw new Error(slug + ': ghost file is not the committed one: ' + fileHash);
  }
  const record = JSON.parse(bytes.toString('utf8'));
  const decoded = decodeGhost(record);
  // The committed ghost stops at the finish tick. The timed run continues its
  // brake tail for 120 ticks and the prop layer is active there too, so the
  // derivation uses the full raw trace written by `verify_e1_drive.mjs`. The
  // ghost remains the committed reference and the fallback when an older
  // artifact has no rawTicks.
  let rawTicks = null;
  const runFile = path.join(WORK, `sprint-${slug}.json`);
  if (existsSync(runFile)) {
    const run = JSON.parse(readFileSync(runFile, 'utf8'));
    if (Array.isArray(run.rawTicks) && run.rawTicks.length >= decoded.tickCount) {
      rawTicks = run.rawTicks.slice(0, decoded.tickCount);
    }
  }
  if (!rawTicks) {
    rawTicks = [];
    for (let tick = 0; tick < decoded.tickCount; tick++) {
      const pose = ghostPoseAt(decoded, tick);
      const body = matrixFromQuaternion(pose.quaternion, pose.position);
      rawTicks.push({
        tick,
        position: pose.position,
        axisZ: [body[8], body[9], body[10]],
        ground: courseGroundAt(layout, coursePosition(layout.course.samples, pose.position).arc)
      });
    }
  }
  ghosts.push({ slug, file, fileHash, record, rawTicks });
}

const excluded = new Map();
let firstSweep = null;
let carRows = [];
for (let iteration = 0; iteration < 12; iteration++) {
  const ids = [...excluded.keys()].sort();
  const filteredManifest = {
    ...manifest,
    colliders: manifest.colliders.map((collider) =>
      ids.includes(collider.id) ? { ...collider, active: false } : collider)
  };
  const currentWorld = createWorld(filteredManifest, { profile: SPRINT_PROP_PINS.profile });
  const found = new Set();
  const nextCarRows = [];
  for (const ghost of ghosts) {
    const trace = ghost.rawTicks;
    let render = null;
    let previous = null;
    let blocked = false;
    let contacts = 0;
    const idsThisCar = new Set();
    for (let tick = 0; tick < trace.length; tick++) {
      const pose = trace[tick];
      const axisZ = pose.axisZ;
      const heading = Math.atan2(axisZ[0], axisZ[2]);
      const yaw = propYawFromHeading(heading);
      const arc = coursePosition(layout.course.samples, pose.position).arc;
      if (render === null) render = { x: pose.position[0], z: pose.position[2] };
      if (previous === null) previous = { x: pose.position[0], z: pose.position[2] };
      const dx = pose.position[0] - previous.x;
      const dz = pose.position[2] - previous.z;
      const ground = pose.ground ?? courseGroundAt(layout, arc);
      const distance = Math.hypot(dx, dz);
      const steps = Math.max(1, Math.min(64, Math.ceil(distance / 0.08)));
      let tickContacts = [];
      for (let step = 0; step < steps; step++) {
        render.x += dx / steps;
        render.z += dz / steps;
        const resolved = currentWorld.resolvePose(render.x, render.z, yaw, ground, envelope,
          { maxIterations: 12, slop: 0.001 });
        render = { x: resolved.x, z: resolved.z };
        for (const contact of resolved.contacts) {
          if (!tickContacts.includes(contact.colliderId)) tickContacts.push(contact.colliderId);
          idsThisCar.add(contact.colliderId);
          found.add(contact.colliderId);
          const row = excluded.get(contact.colliderId) ?? { colliderId: contact.colliderId, firstArc: Infinity, lastArc: -Infinity, samples: 0 };
          row.firstArc = Math.min(row.firstArc, arc);
          row.lastArc = Math.max(row.lastArc, arc);
          row.samples++;
          excluded.set(contact.colliderId, row);
        }
      }
      if (tickContacts.length) { contacts++; blocked = true; }
      if (!blocked) render = { x: pose.position[0], z: pose.position[2] };
      previous = { x: pose.position[0], z: pose.position[2] };
    }
    nextCarRows.push({ slug: ghost.slug, ghost: path.relative(ROOT, ghost.file).split(path.sep).join('/'),
      ghostFileSha256: ghost.fileHash, ghostHash: ghost.record.hash, tickCount: trace.length,
      contacts, colliderIds: [...idsThisCar].sort() });
  }
  if (firstSweep === null) {
    firstSweep = nextCarRows;
  }
  if (found.size === 0) { carRows = nextCarRows; break; }
  carRows = nextCarRows;
}

const rows = [...excluded.values()]
  .map((row) => ({ ...row, firstArc: Math.round(row.firstArc * 1e6) / 1e6,
    lastArc: Math.round(row.lastArc * 1e6) / 1e6 }))
  .sort((a, b) => (a.colliderId < b.colliderId ? -1 : a.colliderId > b.colliderId ? 1 : 0));
const ids = rows.map((row) => row.colliderId);
const exclusionContentSha256 = 'sha256:' + createHash('sha256')
  .update(JSON.stringify(ids)).digest('hex');

// The filtered world must be clear on every committed ghost tick, including the
// swept substeps the layer uses.
const filteredManifest = {
  ...manifest,
  colliders: manifest.colliders.map((collider) =>
    ids.includes(collider.id) ? { ...collider, active: false } : collider)
};
const filteredWorld = createWorld(filteredManifest, { profile: SPRINT_PROP_PINS.profile });
for (const ghost of ghosts) {
  const trace = ghost.rawTicks;
  let render = null;
  let previous = null;
  let blocked = false;
  for (let tick = 0; tick < trace.length; tick++) {
    const pose = trace[tick];
    const axisZ = pose.axisZ;
    const heading = Math.atan2(axisZ[0], axisZ[2]);
    const yaw = propYawFromHeading(heading);
    const arc = coursePosition(layout.course.samples, pose.position).arc;
    if (render === null) render = { x: pose.position[0], z: pose.position[2] };
    if (previous === null) previous = { x: pose.position[0], z: pose.position[2] };
    const dx = pose.position[0] - previous.x;
    const dz = pose.position[2] - previous.z;
    const ground = pose.ground ?? courseGroundAt(layout, arc);
    const distance = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.min(64, Math.ceil(distance / 0.08)));
    for (let step = 0; step < steps; step++) {
      render.x += dx / steps;
      render.z += dz / steps;
      const resolved = filteredWorld.resolvePose(render.x, render.z, yaw, ground, envelope,
        { maxIterations: 12, slop: 0.001 });
      render = { x: resolved.x, z: resolved.z };
      if (resolved.contacts.length) {
        throw new Error('filtered world still contacts ' + ghost.slug + ' at tick ' + tick + ' (' +
          resolved.contacts.map((contact) => contact.colliderId).join(', ') + ')');
      }
    }
    if (!blocked) render = { x: pose.position[0], z: pose.position[2] };
    previous = { x: pose.position[0], z: pose.position[2] };
  }
}

const result = {
  kind: 'e1-drive.sprint-driven-exclusions',
  version: 1,
  scope: 'timed 310 m sprint only; a measured list of V2 roadside colliders that the committed scripted line touches',
  manifest: SPRINT_PROP_PINS.manifest,
  manifestFileSha256: fileSha,
  manifestContentSha256: manifest.contentSha256,
  profile: SPRINT_PROP_PINS.profile,
  manifestColliders: manifest.colliders.length,
  roadsideActive: world.colliders.length,
  excludedCount: ids.length,
  activeAfterExclusions: filteredWorld.colliders.length,
  exclusionContentSha256,
  algorithm: 'reproduce the timed-course prop layer sweep (8 cm substeps, documented 2.98 x 1.68 x 1.35 m car ' +
    'envelope) over every committed 310 m reference ghost; add every touched collider, rebuild the filtered ' +
    'roadside world and repeat until the whole measured line is clear',
  source: { ghostsIndex: 'probes/e1-drive/ghosts/index.json',
    ghostsIndexSha256: 'sha256:' + sha256(indexBytes), cars: firstSweep ?? carRows },
  ids,
  rows
};
const text = JSON.stringify(result, null, 2) + '\n';
writeFileSync(path.join(WORK, 'sprint-driven-exclusions.json'), text, 'utf8');
console.log(JSON.stringify({
  excludedCount: ids.length,
  activeAfterExclusions: filteredWorld.colliders.length,
  exclusionContentSha256,
  textSha256: 'sha256:' + sha256(Buffer.from(text, 'utf8')),
  ids
}, null, 2));
