#!/usr/bin/env node
// Deterministic builder for the committed browser placement artifact.
//
//   node probes/powerups/tools/build_runtime_placement.mjs
//   node probes/powerups/tools/build_runtime_placement.mjs --out <json> --module-out <mjs>
//
// Inputs (read-only, from `_work/`):
//   _work/powerups/runtime-amboy.json          PWR6 primary Amboy route
//   _work/powerups/runtime-gracia.json         PWR6 primary Gracia route
//   _work/powerups/placements.json             PWR3 River route
//   _work/e1-drive/{amboy,gracia}/layout.json  measured layouts
//   _work/e1-drive/{sprint,sprint-lap}.json    River 310 m / loop-01 layouts
//   _work/map-slice/{amboy,gracia}/collision.positions.f32.bin
//   _work/collision-oracle/native.json         full River Level.levelphysics AABB
//
// Outputs (committed):
//   probes/powerups/data/runtime-placement.json
//   probes/powerups/runtime-placement.mjs
//
// The retail actor already stores its world position in `WorldMatrix.aw`. This
// builder copies that coordinate verbatim (rounded to 1e-6 m) and reports the
// measured-course arc/lateral projection as metadata. It never snaps, moves or
// interpolates a retail position: PWR6 records the projection, it does not
// apply it.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CourseModel } from '../../race-rules/course-model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DEFAULT_JSON = path.join(ROOT, 'probes/powerups/data/runtime-placement.json');
const DEFAULT_MODULE = path.join(ROOT, 'probes/powerups/runtime-placement.mjs');
const TEMPLATE = path.join(HERE, 'runtime_placement_module.template.mjs');
const DATA_PLACEHOLDER = '/*__RUNTIME_PLACEMENT_DATA__*/';

const SCHEMA = 'blur-powerups-runtime-placement/1';
const MP_TYPES = new Set(['Barge', 'Nitrous', 'Shock', 'Shunt', 'Blindfire', 'Bomb', 'Repair', 'Shield']);

const round6 = (value) => Math.round(value * 1e6) / 1e6;

function parseArgs(argv) {
  const options = { json: DEFAULT_JSON, module: DEFAULT_MODULE, quiet: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--out') {
      options.json = path.resolve(argv[++index]);
    } else if (arg === '--module-out') {
      options.module = path.resolve(argv[++index]);
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else {
      throw new Error('unknown argument ' + JSON.stringify(arg));
    }
  }
  return options;
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

function hexFloat(hex) {
  const buffer = Buffer.from(hex, 'hex');
  if (buffer.length !== 4) throw new Error('expected a 4-byte float hex, got ' + hex);
  return buffer.readFloatBE(0);
}

function loadLayout(relative, layoutId) {
  const layout = readJson(relative);
  // CourseModel only accepts the two River course ids. Amboy/Gracia use the
  // same measured-sample projection; the id patch only satisfies the
  // constructor, and the hash check is disabled because the geometry is
  // unchanged. `project()` reads `course.samples` only.
  const copy = { ...layout };
  if (!['310m', 'lap'].includes(copy.courseId)) copy.courseId = '310m';
  const model = new CourseModel(copy, { verifyLayoutHash: false });
  return {
    id: layoutId,
    path: relative,
    layout,
    model,
    laps: layout.course?.lap?.laps ?? 1,
    lengthMetres: layout.course?.span?.lengthMetres ?? null
  };
}

/**
 * Nearest-segment projection with the committed CourseModel rule.
 * `lateral` is the signed perpendicular offset along the layout's left normal
 * (-tz, tx), the same convention as PWR6 `signedCross2d` and
 * `CourseModel.positionAtArc(arc, lateral)`.
 */
function project(model, layoutId, position) {
  const result = model.project([position.x, position.y, position.z]);
  const a = model.samples[result.segment];
  const b = model.samples[result.segment + 1];
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const lengthSquared = vx * vx + vz * vz;
  const length = Math.sqrt(lengthSquared);
  const tx = length > 0 ? vx / length : 0;
  const tz = length > 0 ? vz / length : 0;
  const t = lengthSquared > 0
    ? ((position.x - a.x) * vx + (position.z - a.z) * vz) / lengthSquared
    : 0;
  const lateral = tx * (position.z - result.point[2]) - tz * (position.x - result.point[0]);
  return {
    layout: layoutId,
    arc: round6(result.arc),
    lateral: round6(lateral),
    distance: round6(result.lateral),
    segment: result.segment,
    clamped: t <= 0 || t >= 1,
    groundY: round6(result.groundY)
  };
}

function respawnTable() {
  const runtime = readJson('_work/powerups/runtime-amboy.json');
  const parity = runtime.respawnModel?.riverParity;
  if (!parity) throw new Error('runtime-amboy.json has no respawnModel.riverParity');
  const table = {
    Normal: parity.normalSeconds ?? null,
    AlwaysOn: null,
    Long: parity.longSeconds ?? null,
    VeryLong: parity.veryLongSeconds ?? null,
    None: null,
    deactivateSeconds: round6(parity.deactivateSeconds)
  };
  for (const [label, seconds] of Object.entries(table)) {
    if (label === 'deactivateSeconds') continue;
    if (seconds !== null && !Number.isFinite(seconds)) {
      throw new Error('respawn table ' + label + ' is not a finite number');
    }
  }
  return {
    ...table,
    source: 'MultiplayerConfig via PWR6 respawnModel.riverParity; Normal/AlwaysOn/None are not serialized'
  };
}

function respawnSecondsFor(label, table) {
  if (!(label in table) || label === 'deactivateSeconds' || label === 'source') {
    throw new Error('unknown respawn label ' + JSON.stringify(label));
  }
  return table[label];
}

function modalLabel(labels) {
  const counts = new Map();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  let best = null;
  for (const [label, count] of counts) {
    if (best === null || count > best.count) best = { label, count };
  }
  return best ? best.label : null;
}

function collisionBounds(mapId) {
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
      },
      source: '_work/collision-oracle/native.json (full Level.levelphysics AABB, hex-encoded float32)'
    };
  }
  const relative = '_work/map-slice/' + mapId + '/collision.positions.f32.bin';
  const buffer = readBinary(relative);
  const positions = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
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
    max: { x: round6(max.x), y: round6(max.y), z: round6(max.z) },
    source: relative + ' (static collision triangle AABB)'
  };
}

function unsupportedEntry(mapId, uid, type, reason) {
  return { id: mapId + ':' + uid, uid, type, reason };
}

function buildRuntimeMap(mapId, level, runtimeRelative, layoutRelative, layoutId) {
  const runtime = readJson(runtimeRelative);
  const routeRecordId = runtime.authority.primaryRouteRecordId;
  const variant = runtime.authority.variants.find((row) => row.recordId === routeRecordId);
  if (!variant) throw new Error(mapId + ': primary route ' + routeRecordId + ' not found');
  const layout = loadLayout(layoutRelative, layoutId);
  const table = respawnTable();
  const pickups = [];
  const unsupported = [];

  for (const slot of variant.slots) {
    const uid = slot.uid;
    const type = slot.serializedType.name;
    const id = mapId + ':' + uid;
    const position = {
      x: round6(slot.position.x),
      y: round6(slot.position.y),
      z: round6(slot.position.z)
    };
    const projection = project(layout.model, layoutId, slot.position);
    const respawnLabel = slot.respawn.modeLabel;
    const respawnSeconds = slot.respawn.overrideUsed
      ? round6(slot.respawn.overrideSeconds)
      : respawnSecondsFor(respawnLabel, table);

    if (slot.overrides.pickupActiveLevel !== 1) {
      unsupported.push(unsupportedEntry(mapId, uid, type,
        'pickup-active-level-0: retail PickupActiveLevel is ' +
        slot.overrides.pickupActiveLevel + ' (inactive); the slot is excluded, not guessed'));
      continue;
    }
    if (!slot.surface?.groundBelowPresent) {
      unsupported.push(unsupportedEntry(mapId, uid, type,
        'no-collision-ground: no up-facing collision triangle at or below the retail position'));
      continue;
    }
    if (!slot.serializedType.isMultiplayerType || !MP_TYPES.has(type)) {
      unsupported.push(unsupportedEntry(mapId, uid, type,
        'non-multiplayer-type: the serialized type is not one of the eight multiplayer pickup types'));
      continue;
    }

    pickups.push({
      id,
      uid,
      type,
      x: position.x,
      y: position.y,
      z: position.z,
      respawnSeconds,
      respawnLabel,
      activationLap: slot.overrides.activationLap,
      actorListRecord: slot.actorListRecord,
      projections: {
        [layoutId]: projection
      }
    });
  }

  return {
    mapId,
    level,
    defaultLayout: layoutId,
    layouts: [layoutId],
    laps: { [layoutId]: layout.laps },
    routeRecordId,
    actorListId: variant.pickupActorListId ?? null,
    source: 'primary retail route ' + routeRecordId +
      ' (actorpack record ' + (variant.pickupActorListRecord ?? 'n/a') + ') from ' + runtimeRelative +
      '; projections use probes/race-rules/course-model.mjs CourseModel.project on ' + layoutRelative +
      '; xyz = retail PickupPosition.WorldMatrix.aw (not snapped)',
    bounds: collisionBounds(mapId),
    counts: {
      retailPlacements: variant.slots.length,
      pickups: pickups.length,
      unsupported: unsupported.length
    },
    pickups,
    unsupported
  };
}

function buildRiverMap() {
  const placements = readJson('_work/powerups/placements.json');
  const route = placements.authority.route;
  const routeRecordId = route.recordId;
  const layouts = [
    loadLayout('_work/e1-drive/sprint.json', '310m'),
    loadLayout('_work/e1-drive/sprint-lap.json', 'lap')
  ];
  const table = respawnTable();
  const respawnLabel = modalLabel(placements.authority.riverMpRaces.map((race) => race.powerupRespawn.label));
  if (respawnLabel === null) throw new Error('river: no racing respawn label');
  const modeSeconds = respawnSecondsFor(respawnLabel, table);
  const pickups = [];
  const unsupported = [];

  for (const placement of placements.placements) {
    const uid = placement.uid;
    const type = placement.serializedType.name;
    const id = 'river:' + uid;
    const position = {
      x: round6(placement.position.x),
      y: round6(placement.position.y),
      z: round6(placement.position.z)
    };
    const projections = {};
    for (const layout of layouts) {
      projections[layout.id] = project(layout.model, layout.id, placement.position);
    }
    const respawnSeconds = placement.overrides.respawnTimerOverride !== 0
      ? round6(placement.overrides.respawnTimerOverride)
      : modeSeconds;

    if (placement.overrides.pickupActiveLevel !== 1) {
      unsupported.push(unsupportedEntry('river', uid, type,
        'pickup-active-level-0: retail PickupActiveLevel is ' +
        placement.overrides.pickupActiveLevel + ' (inactive); the slot is excluded, not guessed'));
      continue;
    }
    if (!placement.collision?.surfacePresent) {
      unsupported.push(unsupportedEntry('river', uid, type,
        'no-collision-ground: no up-facing collision triangle at or below the retail position'));
      continue;
    }
    if (!MP_TYPES.has(type)) {
      unsupported.push(unsupportedEntry('river', uid, type,
        'non-multiplayer-type: the serialized type is not one of the eight multiplayer pickup types'));
      continue;
    }

    pickups.push({
      id,
      uid,
      type,
      x: position.x,
      y: position.y,
      z: position.z,
      respawnSeconds,
      respawnLabel,
      activationLap: placement.overrides.activationLap,
      actorListRecord: placement.actorListRecord,
      projections
    });
  }

  return {
    mapId: 'river',
    level: 'usa_la_river',
    defaultLayout: '310m',
    layouts: ['310m', 'lap'],
    laps: { '310m': layouts[0].laps, lap: layouts[1].laps },
    routeRecordId,
    actorListId: route.pickupActorListId ?? null,
    source: 'primary retail route ' + routeRecordId +
      ' (actorpack record ' + (route.pickupActorListRecord ?? 'n/a') + ') from _work/powerups/placements.json' +
      '; projections use probes/race-rules/course-model.mjs CourseModel.project on ' +
      '_work/e1-drive/sprint.json (310m) and _work/e1-drive/sprint-lap.json (lap)' +
      '; xyz = retail PickupPosition.WorldMatrix.aw (not snapped)',
    bounds: collisionBounds('river'),
    counts: {
      retailPlacements: placements.placements.length,
      pickups: pickups.length,
      unsupported: unsupported.length
    },
    pickups,
    unsupported
  };
}

function buildDocument() {
  const sourceFiles = [
    '_work/powerups/runtime-amboy.json',
    '_work/powerups/runtime-gracia.json',
    '_work/powerups/placements.json',
    '_work/e1-drive/amboy/layout.json',
    '_work/e1-drive/gracia/layout.json',
    '_work/e1-drive/sprint.json',
    '_work/e1-drive/sprint-lap.json',
    '_work/map-slice/amboy/collision.positions.f32.bin',
    '_work/map-slice/gracia/collision.positions.f32.bin',
    '_work/collision-oracle/native.json'
  ];
  const sources = {};
  for (const relative of sourceFiles) {
    sources[relative] = { sha256: sha256(relative) };
  }
  return {
    schema: SCHEMA,
    kind: 'powerups.runtime-placement',
    version: 1,
    generatedBy: 'probes/powerups/tools/build_runtime_placement.mjs',
    scope: 'Retail PickupPosition world coordinates for the e1-drive browser slice. ' +
      'Positions are the retail WorldMatrix.aw values; the measured-course arc/lateral ' +
      'projection is reported in `source` and is never applied to the coordinate. ' +
      'Only the primary raced route per map is included; alternate route variants stay in ' +
      '_work/powerups and are not mixed into one set.',
    projectionRule: 'Nearest planar point on the committed measured layout polyline ' +
      '(CourseModel.project: clamped segment, sample-arc interpolation, ties to the earlier ' +
      'segment). `lateral` is the signed perpendicular offset along the layout left normal ' +
      '(-tz, tx), identical to PWR6 signedCross2d and CourseModel.positionAtArc lateral ' +
      'convention. `distance` is the full planar distance to the nearest point. A clamped ' +
      'projection is reported, not hidden.',
    respawnTable: respawnTable(),
    sources,
    maps: {
      amboy: buildRuntimeMap('amboy', 'usa_amboy',
        '_work/powerups/runtime-amboy.json', '_work/e1-drive/amboy/layout.json', 'amboy'),
      gracia: buildRuntimeMap('gracia', 'spa_barcelona_gracia',
        '_work/powerups/runtime-gracia.json', '_work/e1-drive/gracia/layout.json', 'gracia'),
      river: buildRiverMap()
    }
  };
}

function generateModule(document, template) {
  if (!template.includes(DATA_PLACEHOLDER)) {
    throw new Error('module template is missing ' + DATA_PLACEHOLDER);
  }
  return template.replace(DATA_PLACEHOLDER, JSON.stringify(document, null, 2));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const document = buildDocument();
  const template = readFileSync(TEMPLATE, 'utf8');
  const jsonText = JSON.stringify(document, null, 2) + '\n';
  const moduleText = generateModule(document, template);

  mkdirSync(path.dirname(options.json), { recursive: true });
  mkdirSync(path.dirname(options.module), { recursive: true });
  writeFileSync(options.json, jsonText);
  writeFileSync(options.module, moduleText);

  if (!options.quiet) {
    for (const mapId of ['amboy', 'gracia', 'river']) {
      const map = document.maps[mapId];
      console.log('runtime-placement: ' + mapId + ' ' + map.counts.pickups + ' pickups / ' +
        map.counts.unsupported + ' unsupported (' + map.counts.retailPlacements + ' retail; layouts ' +
        map.layouts.join(', ') + ')');
    }
    console.log('wrote ' + path.relative(ROOT, options.json) + ' sha256 ' +
      createHash('sha256').update(jsonText).digest('hex'));
    console.log('wrote ' + path.relative(ROOT, options.module) + ' sha256 ' +
      createHash('sha256').update(moduleText).digest('hex'));
  }
}

main();
