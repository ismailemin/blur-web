// Integration tests for the P66 visible-prop layer (P67, read-only consumption).
//
// These exercise the additive post-tick layer, not a second vehicle physics:
// a synthetic engine pose sequence is advanced at a fixed speed and the layer's
// resolved pose must stop on the near face, never pass through. The manifest and
// resolver are P66 artifacts; nothing here writes to them.

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
  speed, lateral = 0, ticks = 240, startDistance = 12, axisIndex = 0, angleDeg = 0, pins = null }) {
  const axis = collider.axes[axisIndex];
  const axisLength = Math.hypot(axis[0], axis[2]) || 1;
  const outward = [axis[0] / axisLength, axis[2] / axisLength];
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
 * The free-roam (P68b extended manifest) version of the layer tests: a real R04
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
