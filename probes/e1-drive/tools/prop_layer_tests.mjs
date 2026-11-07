// Integration tests for the P74 V2 visible-prop layer (read-only consumption).
//
// These exercise the additive post-tick layer, not a second vehicle physics:
// a synthetic engine pose sequence is advanced at a fixed speed and the layer's
// resolved pose must stop on the near face, never pass through. The manifest and
// resolver are P74/P66 artifacts; nothing here writes to them.

import { createWorld as createPropWorld } from '../../prop-collision/lib/resolver.mjs';

function fakeState(x, y, z, headingRad, tick = 0) {
  return {
    tick,
    position: [x, y, z],
    axisX: [Math.cos(headingRad), 0, -Math.sin(headingRad)],
    axisY: [0, 1, 0],
    axisZ: [Math.sin(headingRad), 0, Math.cos(headingRad)],
    velocity: [0, 0, 0],
    speed: 0,
    contacts: [1, 1, 1, 1],
    anyContact: 1,
    finite: 1,
    wheels: [],
    input: [0, 0, 0, 0]
  };
}

function colliderById(manifest, id) {
  const collider = manifest.colliders.find((entry) => entry.id === id);
  if (!collider) throw new Error('prop test collider missing: ' + id);
  return collider;
}

/**
 * Drive a synthetic engine pose straight at a speed through the layer. `dir` is
 * the unit travel direction in XZ; the engine pose advances freely (the engine
 * does not know the prop), the layer's returned pose is the resolved one.
 */
function driveCase({ world, manifest, createPropLayer, propYawFromHeading, collider,
  speed, lateral = 0, ticks = 240, startDistance = 12, axisIndex = 0, angleDeg = 0, sign = 1, pins = null }) {
  const axis = collider.axes[axisIndex];
  const axisLength = Math.hypot(axis[0], axis[2]) || 1;
  const outward = [sign * axis[0] / axisLength, sign * axis[2] / axisLength];
  const baseApproach = [-outward[0], -outward[1]];
  const angle = (angleDeg * Math.PI) / 180;
  const dir = [
    baseApproach[0] * Math.cos(angle) - baseApproach[1] * Math.sin(angle),
    baseApproach[0] * Math.sin(angle) + baseApproach[1] * Math.cos(angle)
  ];
  const sideways = [-dir[1], dir[0]];
  const start = [
    collider.center[0] + outward[0] * startDistance + sideways[0] * lateral,
    collider.center[2] + outward[1] * startDistance + sideways[1] * lateral
  ];
  const groundY = collider.vertical.groundY ?? (collider.vertical.bottom ?? 0);
  const heading = Math.atan2(dir[0], dir[1]);
  const dt = 1 / 60;
  const layer = createPropLayer({ world, carEnvelope: manifest.carEnvelope, ...(pins ? { pins } : {}) });
  let engine = fakeState(start[0], groundY + 0.35, start[1], heading, 0);
  layer.begin(engine, groundY);
  const freeStart = { x: engine.position[0], z: engine.position[2] };
  const resolvedStart = { x: engine.position[0], z: engine.position[2] };
  let final = resolvedStart;
  let engineFinal = freeStart;
  let inputUnchanged = true;
  const contactIds = new Set();
  for (let tick = 1; tick <= ticks; tick++) {
    const nextX = engine.position[0] + dir[0] * speed * dt;
    const nextZ = engine.position[2] + dir[1] * speed * dt;
    const raw = fakeState(nextX, engine.position[1], nextZ, heading, tick);
    const before = [...raw.position];
    const resolved = layer.afterTick(raw, groundY);
    if (raw.position.some((value, index) => value !== before[index])) inputUnchanged = false;
    if (resolved.props) for (const id of resolved.props.lastContacts) contactIds.add(id);
    engine = raw;
    final = { x: resolved.position[0], z: resolved.position[2] };
    engineFinal = { x: nextX, z: nextZ };
  }
  const snapshot = layer.snapshot();
  const yaw = propYawFromHeading(heading);
  const residual = world.deepestContact(final.x, final.z, yaw, groundY, manifest.carEnvelope);
  const centerDistance = Math.hypot(final.x - collider.center[0], final.z - collider.center[2]);
  const freeTravel = Math.hypot(engineFinal.x - freeStart.x, engineFinal.z - freeStart.z);
  const resolvedTravel = Math.hypot(final.x - resolvedStart.x, final.z - resolvedStart.z);
  // Which side of the collider is the resolved pose on? The car starts on the
  // outward side and travels inward; a stopped car keeps a positive projection
  // on the outward normal.
  const side = (final.x - collider.center[0]) * outward[0] + (final.z - collider.center[2]) * outward[1];
  return {
    colliderId: collider.id,
    speed,
    ticks,
    contacts: snapshot.contacts,
    blockedTicks: snapshot.blockedTicks,
    substeps: snapshot.substeps,
    maxPenetrationMetres: snapshot.maxPenetrationMetres,
    contactIds: [...contactIds],
    final,
    centerDistance,
    side,
    residual: residual ? residual.penetration : 0,
    freeTravel,
    resolvedTravel,
    inputUnchanged
  };
}

function glanceAlongFence({ world, manifest, createPropLayer, propYawFromHeading, collider,
  speed = 19.9, ticks = 240, startDistance = 8, angleDeg = 5 }) {
  const longAxis = collider.axes[0];
  const normalAxis = collider.axes[2];
  const longLength = Math.hypot(longAxis[0], longAxis[2]) || 1;
  const normalLength = Math.hypot(normalAxis[0], normalAxis[2]) || 1;
  const along = [longAxis[0] / longLength, longAxis[2] / longLength];
  const normal = [normalAxis[0] / normalLength, normalAxis[2] / normalLength];
  const angle = (angleDeg * Math.PI) / 180;
  const dir = [
    along[0] * Math.cos(angle) - normal[0] * Math.sin(angle),
    along[1] * Math.cos(angle) - normal[1] * Math.sin(angle)
  ];
  const start = [
    collider.center[0] - along[0] * startDistance + normal[0] * (manifest.carEnvelope.width / 2 + 0.02),
    collider.center[2] - along[1] * startDistance + normal[1] * (manifest.carEnvelope.width / 2 + 0.02)
  ];
  const groundY = collider.vertical.groundY ?? (collider.vertical.bottom ?? 0);
  const heading = Math.atan2(dir[0], dir[1]);
  const dt = 1 / 60;
  const layer = createPropLayer({ world, carEnvelope: manifest.carEnvelope });
  let engine = fakeState(start[0], groundY + 0.35, start[1], heading, 0);
  layer.begin(engine, groundY);
  const resolvedStart = { x: engine.position[0], z: engine.position[2] };
  let final = resolvedStart;
  let engineFinal = resolvedStart;
  let inputUnchanged = true;
  for (let tick = 1; tick <= ticks; tick++) {
    const nextX = engine.position[0] + dir[0] * speed * dt;
    const nextZ = engine.position[2] + dir[1] * speed * dt;
    const raw = fakeState(nextX, engine.position[1], nextZ, heading, tick);
    const before = [...raw.position];
    const resolved = layer.afterTick(raw, groundY);
    if (raw.position.some((value, index) => value !== before[index])) inputUnchanged = false;
    engine = raw;
    final = { x: resolved.position[0], z: resolved.position[2] };
    engineFinal = { x: nextX, z: nextZ };
  }
  const residual = world.deepestContact(final.x, final.z, propYawFromHeading(heading), groundY,
    manifest.carEnvelope);
  const snapshot = layer.snapshot();
  return {
    colliderId: collider.id,
    speed,
    blockedTicks: snapshot.blockedTicks,
    contacts: snapshot.contacts,
    substeps: snapshot.substeps,
    final,
    residual: residual ? residual.penetration : 0,
    freeTravel: Math.hypot(engineFinal.x - resolvedStart.x, engineFinal.z - resolvedStart.z),
    resolvedTravel: Math.hypot(final.x - resolvedStart.x, final.z - resolvedStart.z),
    normalSide: (final.x - collider.center[0]) * normal[0] + (final.z - collider.center[2]) * normal[1],
    inputUnchanged
  };
}

export function runPropLayerTests({ world, manifest, createPropLayer, propYawFromHeading }) {
  const truck = colliderById(manifest, 'level.instance.00');
  const thin = colliderById(manifest, 'river.block56.node289.draw.115.component.010');
  const headOn = driveCase({ world, manifest, createPropLayer, propYawFromHeading, collider: truck,
    speed: 31, ticks: 180, axisIndex: 0 });
  const thinAt31 = driveCase({ world, manifest, createPropLayer, propYawFromHeading, collider: thin,
    speed: 31, ticks: 180, axisIndex: 2 });
  const glancing = glanceAlongFence({ world, manifest, createPropLayer, propYawFromHeading,
    collider: colliderById(manifest, 'river.block56.node289.draw.102.component.005'),
    speed: 19.9, ticks: 180, angleDeg: 5 });
  return { truck: truck.id, thin: thin.id, headOn, thinAt31, glancing };
}

/**
 * Four-direction ray probe at 20 m/s: from a clear origin outside the target
 * footprint, step towards the collider centre and require a contact before the
 * centre. `blocked` counts directions that are stopped; the first hit may be a
 * neighbour in the same visible cluster, which is reported verbatim.
 */
function rayCase({ world, manifest, collider, propYawFromHeading }) {
  const ground = collider.vertical.groundY ?? collider.vertical.bottom;
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const u = collider.axes[0];
  const v = collider.axes[2];
  const lu = Math.hypot(u[0], u[2]) || 1;
  const lv = Math.hypot(v[0], v[2]) || 1;
  const rows = [];
  for (const [dx, dz] of directions) {
    const radius = Math.abs((u[0] * dx + u[2] * dz) / lu) * collider.half[0] +
      Math.abs((v[0] * dx + v[2] * dz) / lv) * collider.half[2];
    const yaw = propYawFromHeading(Math.atan2(dx, dz));
    let origin = null;
    for (let distance = radius + 0.5; distance <= radius + 70; distance += 0.25) {
      const x = collider.center[0] + dx * distance;
      const z = collider.center[2] + dz * distance;
      if (!world.deepestContact(x, z, yaw, ground, manifest.carEnvelope)) {
        origin = distance;
        break;
      }
    }
    let hit = null;
    for (let distance = origin ?? 0; origin !== null && distance >= 0.02; distance -= 0.04) {
      const x = collider.center[0] + dx * distance;
      const z = collider.center[2] + dz * distance;
      const contact = world.deepestContact(x, z, yaw, ground, manifest.carEnvelope);
      if (contact) {
        hit = {
          distanceFromCentreMetres: Math.round(distance * 1e4) / 1e4,
          colliderId: contact.colliderId,
          target: contact.colliderId === collider.id
        };
        break;
      }
    }
    rows.push({ direction: [dx, dz], radius, origin, hit });
  }
  return { rows, blocked: rows.filter((row) => row.hit !== null).length };
}

function singleColliderWorld(manifest, id) {
  const collider = colliderById(manifest, id);
  return { collider, world: { ...manifest, colliders: [collider] } };
}

/**
 * P74 V2 targets: the lap building wall (`draw.355`, a 44.37 x 0.02 m wall in the
 * loop corridor but outside the car envelope), the free-roam concrete pipe
 * (`draw.95`), plus the lap no-parking sign (`draw.257`) and the free steel pole
 * (`draw.283`) in single-collider worlds so the target, not a neighbour, is the
 * stop. Every stop is on the approach side with residual 0.
 */
export function runV2PropLayerTests({ lapWorld, lapManifest, lapPins, freeWorld, freeManifest,
  freePins, createPropLayer, propYawFromHeading }) {
  const lapWallId = 'river.block59.node265.draw.355.component.000';
  const freePipeId = 'river.block56.node289.draw.95.component.004';
  const lapWall = colliderById(lapManifest, lapWallId);
  const freePipe = colliderById(freeManifest, freePipeId);
  const lapWallDrive = driveCase({ world: lapWorld, manifest: lapManifest, createPropLayer,
    propYawFromHeading, collider: lapWall, speed: 31, ticks: 120, axisIndex: 2, sign: 1, pins: lapPins });
  const freePipeDrive = driveCase({ world: freeWorld, manifest: freeManifest, createPropLayer,
    propYawFromHeading, collider: freePipe, speed: 31, ticks: 120, axisIndex: 2, sign: -1, pins: freePins });

  const signManifest = singleColliderWorld(lapManifest, 'river.block71.node209.draw.257.component.000');
  const poleManifest = singleColliderWorld(freeManifest, 'river.block71.node209.draw.283.component.327');
  const signWorld = createPropWorld(signManifest.world, { profile: 'all-visible' });
  const poleWorld = createPropWorld(poleManifest.world, { profile: 'all-visible' });
  const signPins = { ...lapPins, colliders: 1 };
  const polePins = { ...freePins, colliders: 1 };
  const signDrive = driveCase({ world: signWorld, manifest: signManifest.world, createPropLayer,
    propYawFromHeading, collider: signManifest.collider, speed: 31, ticks: 100, axisIndex: 2, sign: 1,
    pins: signPins });
  const poleDrive = driveCase({ world: poleWorld, manifest: poleManifest.world, createPropLayer,
    propYawFromHeading, collider: poleManifest.collider, speed: 31, ticks: 100, axisIndex: 2, sign: 1,
    pins: polePins });

  const lapRays = rayCase({ world: lapWorld, manifest: lapManifest, collider: lapWall, propYawFromHeading });
  const freeRays = rayCase({ world: freeWorld, manifest: freeManifest, collider: freePipe, propYawFromHeading });
  return {
    lapWall: { id: lapWallId, drive: lapWallDrive, rays: lapRays },
    freePipe: { id: freePipeId, drive: freePipeDrive, rays: freeRays },
    lapSign: { id: signManifest.collider.id, drive: signDrive },
    freePole: { id: poleManifest.collider.id, drive: poleDrive }
  };
}

/**
 * The free-roam (P74 R04-V2 manifest) version of the layer tests: a real R04
 * truck and a real 0.02 m container panel, both first contacts along the
 * approach. The targets are named manifest records, not synthetic boxes.
 */
export function runFreePropLayerTests({ world, manifest, createPropLayer, propYawFromHeading, pins }) {
  const truck = colliderById(manifest, 'level.instance.00');
  const thin = colliderById(manifest, 'river.block56.node289.draw.143.component.072');
  if (Math.min(thin.half[0], thin.half[2]) > 0.02 + 1e-9) {
    throw new Error('the free-roam thin panel is not a 0.02 m component: ' + thin.id);
  }
  const truckHeadOn = driveCase({ world, manifest, createPropLayer, propYawFromHeading, collider: truck,
    speed: 31, ticks: 180, axisIndex: 0, pins });
  const thinAt31 = driveCase({ world, manifest, createPropLayer, propYawFromHeading, collider: thin,
    speed: 31, ticks: 180, axisIndex: 2, pins });
  return { truck: truck.id, thin: thin.id, truckHeadOn, thinAt31 };
}
