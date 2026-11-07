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
import { readFileSync, writeFileSync } from 'node:fs';
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
if (world.colliders.length !== SPRINT_PROP_PINS.colliders) {
  throw new Error('roadside world is ' + world.colliders.length + ', pinned ' + SPRINT_PROP_PINS.colliders);
}

const excluded = new Map();
const carRows = [];
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
  let contacts = 0;
  const ids = new Set();
  for (let tick = 0; tick < decoded.tickCount; tick++) {
    const pose = ghostPoseAt(decoded, tick);
    const body = matrixFromQuaternion(pose.quaternion, pose.position);
    const heading = Math.atan2(body[8], body[10]);
    const arc = coursePosition(layout.course.samples, pose.position).arc;
    const ground = courseGroundAt(layout, arc);
    const hits = world.contactsAll(pose.position[0], pose.position[2],
      propYawFromHeading(heading), ground, manifest.carEnvelope);
    if (hits.length) contacts++;
    for (const hit of hits) {
      ids.add(hit.colliderId);
      const row = excluded.get(hit.colliderId) ?? { colliderId: hit.colliderId, firstArc: Infinity, lastArc: -Infinity, samples: 0 };
      row.firstArc = Math.min(row.firstArc, arc);
      row.lastArc = Math.max(row.lastArc, arc);
      row.samples++;
      excluded.set(hit.colliderId, row);
    }
  }
  carRows.push({ slug, ghost: path.relative(ROOT, file).split(path.sep).join('/'), ghostFileSha256: fileHash,
    ghostHash: record.hash, tickCount: decoded.tickCount, contacts, colliderIds: [...ids] });
}

const rows = [...excluded.values()]
  .map((row) => ({ ...row, firstArc: Math.round(row.firstArc * 1e6) / 1e6,
    lastArc: Math.round(row.lastArc * 1e6) / 1e6 }))
  .sort((a, b) => (a.colliderId < b.colliderId ? -1 : a.colliderId > b.colliderId ? 1 : 0));
const ids = rows.map((row) => row.colliderId);
const exclusionContentSha256 = 'sha256:' + createHash('sha256')
  .update(JSON.stringify(ids)).digest('hex');

// The filtered world must be clear on every committed ghost tick.
const filteredManifest = {
  ...manifest,
  colliders: manifest.colliders.map((collider) =>
    ids.includes(collider.id) ? { ...collider, active: false } : collider)
};
const filteredWorld = createWorld(filteredManifest, { profile: SPRINT_PROP_PINS.profile });
for (const car of carRows) {
  const file = path.join(ROOT, car.ghost);
  const decoded = decodeGhost(JSON.parse(readFileSync(file, 'utf8')));
  for (let tick = 0; tick < decoded.tickCount; tick++) {
    const pose = ghostPoseAt(decoded, tick);
    const body = matrixFromQuaternion(pose.quaternion, pose.position);
    const heading = Math.atan2(body[8], body[10]);
    const arc = coursePosition(layout.course.samples, pose.position).arc;
    const hits = filteredWorld.contactsAll(pose.position[0], pose.position[2],
      propYawFromHeading(heading), courseGroundAt(layout, arc), manifest.carEnvelope);
    if (hits.length) throw new Error('filtered world still contacts ' + car.slug + ' at tick ' + tick);
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
  algorithm: 'sweep the committed 310 m reference ghosts (integer ticks) through the pinned V2 roadside world ' +
    'with the documented 2.98 x 1.68 m car envelope; record every collider the measured line overlaps',
  source: { ghostsIndex: 'probes/e1-drive/ghosts/index.json',
    ghostsIndexSha256: 'sha256:' + sha256(indexBytes), cars: carRows },
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
