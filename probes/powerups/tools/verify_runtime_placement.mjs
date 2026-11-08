#!/usr/bin/env node
// Independent verifier for the committed browser placement artifact.
//
//   node probes/powerups/tools/verify_runtime_placement.mjs
//
// Re-derives every claim from `_work/` and the committed layouts without
// importing the builder:
//   * per-map retail counts, uid/type/position/activation-lap/respawn values;
//   * the measured-course arc/lateral projection (own nearest-segment code,
//     cross-checked against the committed CourseModel);
//   * every pickup inside the map's drivable collision AABB, with ground below;
//   * respawn seconds against the retail MultiplayerConfig table;
//   * unsupported entries carry a retail record id and a typed reason;
//   * two builder runs are byte-identical to each other and to the committed
//     JSON/module;
//   * the committed module's `placementsFor` contract.
//
// Exit code 0 only when every check passes.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CourseModel } from '../../race-rules/course-model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const JSON_FILE = path.join(ROOT, 'probes/powerups/data/runtime-placement.json');
const MODULE_FILE = path.join(ROOT, 'probes/powerups/runtime-placement.mjs');
const TEMPLATE_FILE = path.join(HERE, 'runtime_placement_module.template.mjs');
const BUILDER_FILE = path.join(HERE, 'build_runtime_placement.mjs');
const DATA_PLACEHOLDER = '/*__RUNTIME_PLACEMENT_DATA__*/';
const SCHEMA = 'blur-powerups-runtime-placement/1';
const MP_TYPES = new Set(['Barge', 'Nitrous', 'Shock', 'Shunt', 'Blindfire', 'Bomb', 'Repair', 'Shield']);
const KNOWN_REASONS = new Set([
  'pickup-active-level-0',
  'no-collision-ground',
  'non-multiplayer-type',
  'no-route-arc',
  'no-measured-ground',
  'outside-drivable-bounds'
]);

const round6 = (value) => Math.round(value * 1e6) / 1e6;

const checks = [];
const failures = [];

function check(name, ok, detail = null) {
  const row = { name, ok: Boolean(ok), detail };
  checks.push(row);
  if (!row.ok) failures.push(row);
  return row.ok;
}

function equal(name, actual, expected) {
  return check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

function close(name, actual, expected, tolerance = 1e-5) {
  const ok = typeof actual === 'number' && typeof expected === 'number' &&
    Number.isFinite(actual) && Number.isFinite(expected) &&
    Math.abs(actual - expected) <= tolerance;
  return check(name, ok, { actual, expected, tolerance });
}

function throws(name, fn) {
  try {
    fn();
    return check(name, false, 'expected a throw');
  } catch (error) {
    return check(name, true, error.message);
  }
}

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
}

function readBinary(relative) {
  return readFileSync(path.join(ROOT, relative));
}

function sha256(relative) {
  return createHash('sha256').update(readBinary(relative)).digest('hex');
}

function normalizeNewlines(value) {
  return value.toString('utf8').replace(/\r\n/g, '\n');
}

function hexFloat(hex) {
  const buffer = Buffer.from(hex, 'hex');
  if (buffer.length !== 4) throw new Error('expected a 4-byte float hex, got ' + hex);
  return buffer.readFloatBE(0);
}

function readF32(relative) {
  const buffer = readBinary(relative);
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

function readU32(relative) {
  const buffer = readBinary(relative);
  return new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

// ---------------------------------------------------------------- projection
// Independent nearest-segment projection. Same rule as CourseModel.project:
// clamped segment, sample-arc interpolation, ties to the earlier segment.
function projectPolyline(samples, x, z) {
  let best = null;
  for (let index = 0; index < samples.length - 1; index++) {
    const a = samples[index];
    const b = samples[index + 1];
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const lengthSquared = vx * vx + vz * vz;
    let t = 0;
    if (lengthSquared > 0) {
      t = ((x - a.x) * vx + (z - a.z) * vz) / lengthSquared;
      if (t < 0) t = 0; else if (t > 1) t = 1;
    }
    const qx = a.x + vx * t;
    const qz = a.z + vz * t;
    const dx = x - qx;
    const dz = z - qz;
    const distanceSquared = dx * dx + dz * dz;
    if (best === null || distanceSquared < best.distanceSquared - 1e-12) {
      const length = Math.sqrt(lengthSquared);
      const tx = length > 0 ? vx / length : 0;
      const tz = length > 0 ? vz / length : 0;
      best = {
        distanceSquared,
        arc: a.arc + (b.arc - a.arc) * t,
        segment: index,
        qx,
        qz,
        tx,
        tz,
        t
      };
    }
  }
  const lateral = best.tx * (z - best.qz) - best.tz * (x - best.qx);
  return {
    arc: round6(best.arc),
    lateral: round6(lateral),
    distance: round6(Math.sqrt(best.distanceSquared)),
    segment: best.segment,
    clamped: best.t <= 0 || best.t >= 1,
    groundY: round6(groundAtArc(samples, best.arc))
  };
}

function groundAtArc(samples, arc) {
  let best = samples[0];
  let bestDelta = Math.abs(best.arc - arc);
  for (let index = 1; index < samples.length; index++) {
    const delta = Math.abs(samples[index].arc - arc);
    if (delta < bestDelta - 1e-12) {
      best = samples[index];
      bestDelta = delta;
    }
  }
  return best.groundY;
}

function layoutModel(relative) {
  const layout = readJson(relative);
  const copy = { ...layout };
  if (!['310m', 'lap'].includes(copy.courseId)) copy.courseId = '310m';
  return {
    layout,
    model: new CourseModel(copy, { verifyLayoutHash: false }),
    laps: layout.course?.lap?.laps ?? 1
  };
}

// ---------------------------------------------------------------- retail data
function modalLabel(labels) {
  const counts = new Map();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  let best = null;
  for (const [label, count] of counts) {
    if (best === null || count > best.count) best = { label, count };
  }
  return best ? best.label : null;
}

function respawnSecondsFor(label, table) {
  if (!(label in table) || label === 'deactivateSeconds' || label === 'source') {
    throw new Error('unknown respawn label ' + JSON.stringify(label));
  }
  return table[label];
}

function retailFor(mapId, table) {
  if (mapId === 'river') {
    const placements = readJson('_work/powerups/placements.json');
    const route = placements.authority.route;
    const respawnLabel = modalLabel(placements.authority.riverMpRaces.map((race) => race.powerupRespawn.label));
    return {
      routeRecordId: route.recordId,
      actorListId: route.pickupActorListId,
      respawnLabel,
      placements: placements.placements.map((placement) => ({
        uid: placement.uid,
        type: placement.serializedType.name,
        position: placement.position,
        actorListRecord: placement.actorListRecord,
        activationLap: placement.overrides.activationLap,
        pickupActiveLevel: placement.overrides.pickupActiveLevel,
        groundPresent: Boolean(placement.collision?.surfacePresent),
        groundY: placement.collision?.groundY ?? null,
        respawnLabel,
        respawnSeconds: placement.overrides.respawnTimerOverride !== 0
          ? round6(placement.overrides.respawnTimerOverride)
          : respawnSecondsFor(respawnLabel, table)
      }))
    };
  }
  const runtime = readJson('_work/powerups/runtime-' + mapId + '.json');
  const routeRecordId = runtime.authority.primaryRouteRecordId;
  const variant = runtime.authority.variants.find((row) => row.recordId === routeRecordId);
  if (!variant) throw new Error(mapId + ': primary variant missing');
  return {
    routeRecordId,
    actorListId: variant.pickupActorListId,
    respawnLabel: variant.defaultRaceConfig.powerupRespawn,
    placements: variant.slots.map((slot) => ({
      uid: slot.uid,
      type: slot.serializedType.name,
      position: slot.position,
      actorListRecord: slot.actorListRecord,
      activationLap: slot.overrides.activationLap,
      pickupActiveLevel: slot.overrides.pickupActiveLevel,
      groundPresent: Boolean(slot.surface?.groundBelowPresent),
      groundY: slot.surface?.groundBelowY ?? null,
      respawnLabel: slot.respawn.modeLabel,
      respawnSeconds: slot.respawn.overrideUsed
        ? round6(slot.respawn.overrideSeconds)
        : respawnSecondsFor(slot.respawn.modeLabel, table)
    }))
  };
}

// ---------------------------------------------------------------- bounds/ground
function boundsFor(mapId) {
  if (mapId === 'river') {
    const oracle = readJson('_work/collision-oracle/native.json');
    return {
      min: {
        x: round6(hexFloat(oracle.bounds.min.x)),
        y: round6(hexFloat(oracle.bounds.min.y)),
        z: round6(hexFloat(oracle.bounds.min.z))
      },
      max: {
        x: round6(hexFloat(oracle.bounds.max.x)),
        y: round6(hexFloat(oracle.bounds.max.y)),
        z: round6(hexFloat(oracle.bounds.max.z))
      }
    };
  }
  const positions = readF32('_work/map-slice/' + mapId + '/collision.positions.f32.bin');
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let index = 0; index < positions.length; index += 3) {
    min.x = Math.min(min.x, positions[index]);
    min.y = Math.min(min.y, positions[index + 1]);
    min.z = Math.min(min.z, positions[index + 2]);
    max.x = Math.max(max.x, positions[index]);
    max.y = Math.max(max.y, positions[index + 1]);
    max.z = Math.max(max.z, positions[index + 2]);
  }
  return {
    min: { x: round6(min.x), y: round6(min.y), z: round6(min.z) },
    max: { x: round6(max.x), y: round6(max.y), z: round6(max.z) }
  };
}

function collisionTriangles(mapId) {
  const positions = readF32('_work/map-slice/' + mapId + '/collision.positions.f32.bin');
  const indices = readU32('_work/map-slice/' + mapId + '/collision.indices.u32.bin');
  const triangles = new Float32Array(indices.length * 3);
  for (let index = 0; index < indices.length; index++) {
    const vertex = indices[index] * 3;
    triangles[index * 3] = positions[vertex];
    triangles[index * 3 + 1] = positions[vertex + 1];
    triangles[index * 3 + 2] = positions[vertex + 2];
  }
  return triangles;
}

function hasGroundBelow(triangles, x, y, z) {
  for (let index = 0; index < triangles.length; index += 9) {
    const ax = triangles[index];
    const ay = triangles[index + 1];
    const az = triangles[index + 2];
    const bx = triangles[index + 3];
    const by = triangles[index + 4];
    const bz = triangles[index + 5];
    const cx = triangles[index + 6];
    const cy = triangles[index + 7];
    const cz = triangles[index + 8];
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-12 || ny / length <= 0.1) continue;
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-12) continue;
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
    const w = 1 - u - v;
    if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
    const height = u * ay + v * by + w * cy;
    if (height <= y + 1e-3) return true;
  }
  return false;
}

// ---------------------------------------------------------------- main
const document = JSON.parse(readFileSync(JSON_FILE, 'utf8'));
const template = readFileSync(TEMPLATE_FILE, 'utf8');
const module = await import(pathToFileURL(MODULE_FILE).href);

equal('document schema', document.schema, SCHEMA);
equal('document kind', document.kind, 'powerups.runtime-placement');
equal('document version', document.version, 1);
equal('module schema export', module.RUNTIME_PLACEMENT_SCHEMA, SCHEMA);
equal('module data equals committed JSON', JSON.stringify(module.RUNTIME_PLACEMENT_DATA), JSON.stringify(document));

// Input hashes.
for (const [relative, entry] of Object.entries(document.sources ?? {})) {
  equal('source hash ' + relative, entry.sha256, sha256(relative));
}

// Respawn table from the retail MultiplayerConfig.
const parity = readJson('_work/powerups/runtime-amboy.json').respawnModel.riverParity;
equal('respawn table Normal', document.respawnTable.Normal, null);
equal('respawn table AlwaysOn', document.respawnTable.AlwaysOn, null);
equal('respawn table Long', document.respawnTable.Long, parity.longSeconds);
equal('respawn table VeryLong', document.respawnTable.VeryLong, parity.veryLongSeconds);
equal('respawn table None', document.respawnTable.None, null);
close('respawn deactivate seconds', document.respawnTable.deactivateSeconds, parity.deactivateSeconds);
const table = {
  Normal: document.respawnTable.Normal,
  AlwaysOn: document.respawnTable.AlwaysOn,
  Long: document.respawnTable.Long,
  VeryLong: document.respawnTable.VeryLong,
  None: document.respawnTable.None
};
equal('respawn table Long is 5 s', table.Long, 5);
equal('respawn table VeryLong is 20 s', table.VeryLong, 20);

const MAP_LAYOUTS = {
  amboy: ['amboy'],
  gracia: ['gracia'],
  river: ['310m', 'lap']
};
const LAYOUT_FILES = {
  amboy: '_work/e1-drive/amboy/layout.json',
  gracia: '_work/e1-drive/gracia/layout.json',
  '310m': '_work/e1-drive/sprint.json',
  lap: '_work/e1-drive/sprint-lap.json'
};

const perMap = {};

for (const mapId of ['amboy', 'gracia', 'river']) {
  const map = document.maps[mapId];
  const retail = retailFor(mapId, table);
  const retailByUid = new Map(retail.placements.map((placement) => [placement.uid, placement]));
  const bounds = boundsFor(mapId);
  const triangles = mapId === 'river' ? null : collisionTriangles(mapId);
  const layoutModels = {};
  for (const layout of MAP_LAYOUTS[mapId]) {
    layoutModels[layout] = layoutModel(LAYOUT_FILES[layout]);
  }

  check(mapId + ' map present', Boolean(map));
  equal(mapId + ' route record id', map.routeRecordId, retail.routeRecordId);
  equal(mapId + ' actor list id', map.actorListId, retail.actorListId);
  equal(mapId + ' retail count', map.counts.retailPlacements, retail.placements.length);
  equal(mapId + ' pickup count', map.counts.pickups, map.pickups.length);
  equal(mapId + ' unsupported count', map.counts.unsupported, map.unsupported.length);
  equal(mapId + ' pickup + unsupported = retail',
    map.pickups.length + map.unsupported.length, retail.placements.length);
  equal(mapId + ' layouts', map.layouts, MAP_LAYOUTS[mapId]);
  equal(mapId + ' default layout', map.defaultLayout, MAP_LAYOUTS[mapId][0]);
  for (const layout of MAP_LAYOUTS[mapId]) {
    equal(mapId + ' laps ' + layout, map.laps[layout], layoutModels[layout].laps);
  }

  // Bounds are independently re-derived, then every pickup is checked.
  close(mapId + ' bounds min x', map.bounds.min.x, bounds.min.x, 1e-5);
  close(mapId + ' bounds min y', map.bounds.min.y, bounds.min.y, 1e-5);
  close(mapId + ' bounds min z', map.bounds.min.z, bounds.min.z, 1e-5);
  close(mapId + ' bounds max x', map.bounds.max.x, bounds.max.x, 1e-5);
  close(mapId + ' bounds max y', map.bounds.max.y, bounds.max.y, 1e-5);
  close(mapId + ' bounds max z', map.bounds.max.z, bounds.max.z, 1e-5);

  const seen = new Set();
  for (const pickup of map.pickups) {
    const uid = pickup.uid;
    const row = retailByUid.get(uid);
    const prefix = mapId + ':' + uid;
    check(prefix + ' retail record exists', Boolean(row));
    check(prefix + ' id format', pickup.id === mapId + ':' + uid, { id: pickup.id });
    check(prefix + ' uid unique', !seen.has(uid));
    seen.add(uid);
    if (!row) continue;
    equal(prefix + ' type', pickup.type, row.type);
    close(prefix + ' x', pickup.x, round6(row.position.x));
    close(prefix + ' y', pickup.y, round6(row.position.y));
    close(prefix + ' z', pickup.z, round6(row.position.z));
    equal(prefix + ' activation lap', pickup.activationLap, row.activationLap);
    equal(prefix + ' respawn seconds', pickup.respawnSeconds, row.respawnSeconds);
    equal(prefix + ' respawn label', pickup.respawnLabel, row.respawnLabel);
    equal(prefix + ' actor list record', pickup.actorListRecord, row.actorListRecord);

    check(prefix + ' inside drivable x',
      pickup.x >= bounds.min.x - 1e-6 && pickup.x <= bounds.max.x + 1e-6,
      { x: pickup.x, min: bounds.min.x, max: bounds.max.x });
    check(prefix + ' inside drivable y',
      pickup.y >= bounds.min.y - 1e-6 && pickup.y <= bounds.max.y + 1e-6,
      { y: pickup.y, min: bounds.min.y, max: bounds.max.y });
    check(prefix + ' inside drivable z',
      pickup.z >= bounds.min.z - 1e-6 && pickup.z <= bounds.max.z + 1e-6,
      { z: pickup.z, min: bounds.min.z, max: bounds.max.z });
    if (triangles) {
      check(prefix + ' ground below (collision mesh)',
        hasGroundBelow(triangles, pickup.x, pickup.y, pickup.z));
    } else {
      check(prefix + ' ground below (retail collision flag)', row.groundPresent === true);
      check(prefix + ' ground height at or below pickup',
        row.groundY !== null && row.groundY <= pickup.y + 1e-3,
        { groundY: row.groundY, y: pickup.y });
    }

    for (const layout of MAP_LAYOUTS[mapId]) {
      const projection = pickup.projections?.[layout];
      check(prefix + ' projection ' + layout + ' present', Boolean(projection));
      if (!projection) continue;
      const model = layoutModels[layout].model;
      const samples = model.samples;
      const expected = projectPolyline(samples, pickup.x, pickup.z);
      close(prefix + ' arc ' + layout, projection.arc, expected.arc);
      close(prefix + ' lateral ' + layout, projection.lateral, expected.lateral);
      close(prefix + ' distance ' + layout, projection.distance, expected.distance);
      equal(prefix + ' segment ' + layout, projection.segment, expected.segment);
      equal(prefix + ' clamped ' + layout, projection.clamped, expected.clamped);
      close(prefix + ' groundY ' + layout, projection.groundY, expected.groundY);
      equal(prefix + ' projection layout ' + layout, projection.layout, layout);

      // Cross-check the committed CourseModel (same samples, same rule).
      const reference = model.project([pickup.x, pickup.y, pickup.z]);
      close(prefix + ' CourseModel arc ' + layout, projection.arc, round6(reference.arc));
      close(prefix + ' CourseModel distance ' + layout, projection.distance, round6(reference.lateral));
      equal(prefix + ' CourseModel segment ' + layout, projection.segment, reference.segment);
    }
  }

  for (const entry of map.unsupported) {
    const prefix = mapId + ':' + entry.uid;
    const row = retailByUid.get(entry.uid);
    check(prefix + ' unsupported retail record exists', Boolean(row));
    check(prefix + ' unsupported id format', entry.id === mapId + ':' + entry.uid, { id: entry.id });
    check(prefix + ' unsupported uid unique', !seen.has(entry.uid));
    seen.add(entry.uid);
    check(prefix + ' unsupported has reason',
      typeof entry.reason === 'string' && entry.reason.trim().length > 0);
    check(prefix + ' unsupported reason is typed',
      typeof entry.reason === 'string' && KNOWN_REASONS.has(entry.reason.split(':')[0]),
      { reason: entry.reason });
    if (row) {
      equal(prefix + ' unsupported type', entry.type, row.type);
      if (entry.reason.startsWith('pickup-active-level-0')) {
        check(prefix + ' unsupported active-level reason matches retail',
          row.pickupActiveLevel !== 1, { pickupActiveLevel: row.pickupActiveLevel });
      }
      if (entry.reason.startsWith('no-collision-ground')) {
        check(prefix + ' unsupported ground reason matches retail', row.groundPresent === false);
      }
      if (entry.reason.startsWith('non-multiplayer-type')) {
        check(prefix + ' unsupported type reason matches retail', !MP_TYPES.has(row.type));
      }
    }
  }

  equal(mapId + ' every retail uid appears once', seen.size, retail.placements.length);
  perMap[mapId] = {
    pickups: map.pickups.length,
    unsupported: map.unsupported.length,
    retail: retail.placements.length
  };
}

// ---------------------------------------------------------------- module contract
for (const mapId of ['amboy', 'gracia', 'river']) {
  for (const layout of MAP_LAYOUTS[mapId]) {
    const set = module.placementsFor(mapId, layout);
    const map = document.maps[mapId];
    equal(mapId + '/' + layout + ' set schema', set.schema, SCHEMA);
    equal(mapId + '/' + layout + ' set mapId', set.mapId, mapId);
    check(mapId + '/' + layout + ' set source string', typeof set.source === 'string' && set.source.length > 0);
    equal(mapId + '/' + layout + ' set pickup count', set.pickups.length, map.counts.pickups);
    equal(mapId + '/' + layout + ' set unsupported count', set.unsupported.length, map.counts.unsupported);
    for (const pickup of set.pickups) {
      const keys = Object.keys(pickup).sort().join(',');
      equal(mapId + '/' + layout + ' pickup keys ' + pickup.id, keys,
        'id,lapMax,lapMin,respawnSeconds,source,type,x,y,z');
      check(mapId + '/' + layout + ' pickup id ' + pickup.id,
        typeof pickup.id === 'string' && pickup.id.startsWith(mapId + ':'));
      check(mapId + '/' + layout + ' pickup type ' + pickup.id, MP_TYPES.has(pickup.type));
      check(mapId + '/' + layout + ' pickup finite xyz ' + pickup.id,
        Number.isFinite(pickup.x) && Number.isFinite(pickup.y) && Number.isFinite(pickup.z));
      check(mapId + '/' + layout + ' pickup respawn ' + pickup.id,
        pickup.respawnSeconds === null || Number.isFinite(pickup.respawnSeconds));
      check(mapId + '/' + layout + ' pickup lap window ' + pickup.id,
        Number.isInteger(pickup.lapMin) && Number.isInteger(pickup.lapMax) &&
        pickup.lapMin >= 0 && pickup.lapMax >= pickup.lapMin);
      equal(mapId + '/' + layout + ' pickup lapMax ' + pickup.id, pickup.lapMax, map.laps[layout]);
      check(mapId + '/' + layout + ' pickup source ' + pickup.id,
        typeof pickup.source === 'string' &&
        pickup.source.includes('uid ' + pickup.id.split(':')[1]) &&
        pickup.source.includes('layout ' + layout) &&
        pickup.source.includes('xyz = retail WorldMatrix.aw'));
    }
    for (const entry of set.unsupported) {
      equal(mapId + '/' + layout + ' unsupported keys ' + entry.id,
        Object.keys(entry).sort().join(','), 'id,reason,type');
      check(mapId + '/' + layout + ' unsupported reason ' + entry.id,
        typeof entry.reason === 'string' && entry.reason.length > 0);
    }
  }
}
throws('unknown map throws', () => module.placementsFor('nope'));
throws('bad layout throws', () => module.placementsFor('amboy', 'lap'));
throws('river bad layout throws', () => module.placementsFor('river', 'short'));
equal('river default layout is 310m', module.placementsFor('river').pickups[0].source.includes('layout 310m'), true);
equal('river lap layout lapMax 3', module.placementsFor('river', 'lap').pickups[0].lapMax, 3);

// ---------------------------------------------------------------- determinism
const temp = mkdtempSync(path.join(os.tmpdir(), 'pwr7-'));
try {
  const runs = [];
  for (const suffix of ['a', 'b']) {
    const jsonOut = path.join(temp, 'runtime-placement-' + suffix + '.json');
    const moduleOut = path.join(temp, 'runtime-placement-' + suffix + '.mjs');
    const result = spawnSync(process.execPath, [
      BUILDER_FILE, '--out', jsonOut, '--module-out', moduleOut, '--quiet'
    ], { cwd: ROOT, encoding: 'utf8' });
    equal('builder run ' + suffix + ' exit 0', result.status, 0);
    check('builder run ' + suffix + ' no stderr', !result.stderr || result.stderr.trim() === '',
      result.stderr ?? '');
    runs.push({
      json: readFileSync(jsonOut),
      module: readFileSync(moduleOut)
    });
  }
  check('two builds byte-identical JSON', runs[0].json.equals(runs[1].json));
  check('two builds byte-identical module', runs[0].module.equals(runs[1].module));
  check('committed JSON equals build',
    normalizeNewlines(runs[0].json) === normalizeNewlines(readFileSync(JSON_FILE)));
  check('committed module equals build',
    normalizeNewlines(runs[0].module) === normalizeNewlines(readFileSync(MODULE_FILE)));
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const generated = template.replace(DATA_PLACEHOLDER, JSON.stringify(document, null, 2));
check('committed module equals template + JSON',
  normalizeNewlines(generated) === normalizeNewlines(readFileSync(MODULE_FILE)));

// ---------------------------------------------------------------- summary
for (const mapId of ['amboy', 'gracia', 'river']) {
  const row = perMap[mapId];
  console.log('  ' + mapId + ': ' + row.pickups + ' pickups / ' + row.unsupported +
    ' unsupported / ' + row.retail + ' retail');
}
for (const failure of failures) {
  console.log('FAIL ' + failure.name +
    (failure.detail === null ? '' : ' :: ' + JSON.stringify(failure.detail)));
}
const passed = checks.length - failures.length;
console.log(passed + '/' + checks.length + ' checks passed');
if (failures.length > 0) process.exitCode = 1;
