// Read-only XT vehicle-physics reader for the AI racing line.
//
// The AI racing line needs a lateral-grip and braking limit that comes from the
// car's own decoded XT fields, not from a tuned constant. This module parses the
// committed `_work/e1-drive/cars/<slug>.fields` dump (the RP_CarDynamics XT
// decode produced by the asset reader) and derives:
//
//   muLat   = static-load-weighted peak tyre grip / transverseGripScale
//   muBrake = static-load-weighted peak tyre grip / backwardsGripScale
//   muAccel = static-load-weighted peak tyre grip / forwardsGripScale
//
// and the acceleration limits `mu * g`. The retail solver computes a wheel force
// of `|normalForce| * gripSaturation * <direction>GripScale` (see
// `carwheel.cpp` `CalculateDynamicFrictionForce`), so the grip curve value is a
// dimensionless friction coefficient and `mu * g` is the friction-circle
// acceleration limit in m/s^2. Nothing is invented:
//
//   * `tyres.<axle>.grip.yScale`       global grip multiplier (all cars: 1.0)
//   * `tyres.<axle>.grip.data[i].y`    grip curve peak (index 1 is the plateau)
//   * `tyres.<axle>.transverseGripScale` lateral direction scale
//   * `tyres.<axle>.forwardsGripScale`   drive direction scale
//   * `tyres.<axle>.backwardsGripScale`  braking direction scale
//   * `tyres.<axle>.loadDependence`     per-car load sensitivity
//   * `mass.mass`, `mass.cofGOffsetZ`   axle static-load split
//   * `geometry.wheelBase`, `geometry.trackWidthFront/Rear`  geometry
//   * `physics.GRAVITY` (upstream `physics.cpp`: 9.81 m/s^2)
//
// Not modelled, and therefore conservative (they can only add grip):
//   * `friction.downforce` / `friction.constantDownforce` (speed-dependent load)
//   * the retail surface grip modifier for the mesh the car is on
//   * combined-slip reduction when braking and cornering at the same time
//
// The module never writes a car field, never imports the wasm engine, and has no
// clock or random source.

import { readFileSync } from 'node:fs';

export const CAR_PHYSICS_KIND = 'blur.ai-car-physics';
export const CAR_PHYSICS_VERSION = 1;

// Upstream `RacingPhysics::PhysicsConstants::GRAVITY` (physics.cpp:11).
export const XT_GRAVITY_MPS2 = 9.81;

const FIELD_LINE = /^([^\t]+)\t(\S+)$/;
const HEX32 = /^[0-9a-fA-F]{8}$/;

/** Parse the committed `.fields` text dump into `{ path: value }`. */
export function parseFields(text) {
  if (typeof text !== 'string') throw new Error('car field dump must be text');
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine) continue;
    const match = FIELD_LINE.exec(rawLine);
    if (!match) continue;
    const [, key, raw] = match;
    if (HEX32.test(raw)) {
      // The dump stores the IEEE-754 float32 as a big-endian hex word.
      values.set(key, Buffer.from(raw, 'hex').readFloatBE(0));
    } else {
      values.set(key, raw);
    }
  }
  if (values.size === 0) throw new Error('car field dump has no fields');
  return values;
}

function num(values, key) {
  const value = values.get(key);
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`car field ${key} is missing or not finite (${value})`);
  return parsed;
}

function gripPeak(values, axle) {
  const prefix = `tyres.${axle}.grip`;
  const count = Number(values.get(`${prefix}.data`));
  if (!Number.isInteger(count) || count < 1) throw new Error(`${prefix}.data count is invalid`);
  let peak = 0;
  let peakX = 0;
  for (let index = 0; index < count; index++) {
    const x = num(values, `${prefix}.data[${index}].x`);
    const y = num(values, `${prefix}.data[${index}].y`);
    if (y > peak) { peak = y; peakX = x; }
  }
  if (peak <= 0) throw new Error(`${prefix} grip curve has no positive plateau`);
  return { peak, peakAt: peakX };
}

/**
 * Derive the friction-circle limits from one car's committed field dump.
 * `slug` is only a label; every number comes from the fields.
 */
export function deriveCarPhysics(fieldText, { slug = 'car', sourcePath = null } = {}) {
  const values = parseFields(fieldText);

  const massKg = num(values, 'mass.mass');
  const cogOffsetZ = num(values, 'mass.cofGOffsetZ');
  const wheelBase = num(values, 'geometry.wheelBase');
  const trackWidthFront = num(values, 'geometry.trackWidthFront');
  const trackWidthRear = num(values, 'geometry.trackWidthRear');
  // `steering.steerLimit` is the front-wheel angle (radians) that a full
  // normalised steering request asks for (car.cpp `CalculateSteerLimits`:
  // `desiredAngle = Lerp(0, steerLimit, steer)`). It turns the pure-pursuit
  // curvature into the engine's four-channel steering request.
  const steerLimitRad = num(values, 'steering.steerLimit');
  if (!(massKg > 0)) throw new Error(`${slug}: mass must be positive`);
  if (!(wheelBase > 0)) throw new Error(`${slug}: wheelBase must be positive`);

  // Static axle load. `cofGOffsetZ` is the longitudinal centre-of-mass offset
  // from the wheelbase midpoint in metres (retail positive = towards +Z). The
  // static front share is therefore 0.5 - offset/wheelBase. Every roster car
  // records 0, giving the 50/50 split, but the formula is kept so the reader is
  // not silently 50/50 for a car that is not.
  const frontLoadShare = 0.5 - cogOffsetZ / wheelBase;
  if (!(frontLoadShare > 0 && frontLoadShare < 1)) {
    throw new Error(`${slug}: cofGOffsetZ ${cogOffsetZ} gives an impossible axle split`);
  }
  const rearLoadShare = 1 - frontLoadShare;

  const front = {
    peakGrip: gripPeak(values, 'frontTyres'),
    yScale: num(values, 'tyres.frontTyres.grip.yScale'),
    transverseGripScale: num(values, 'tyres.frontTyres.transverseGripScale'),
    forwardsGripScale: num(values, 'tyres.frontTyres.forwardsGripScale'),
    backwardsGripScale: num(values, 'tyres.frontTyres.backwardsGripScale'),
    loadDependence: num(values, 'tyres.frontTyres.loadDependence'),
    radius: num(values, 'tyres.frontTyres.radius')
  };
  const rear = {
    peakGrip: gripPeak(values, 'rearTyres'),
    yScale: num(values, 'tyres.rearTyres.grip.yScale'),
    transverseGripScale: num(values, 'tyres.rearTyres.transverseGripScale'),
    forwardsGripScale: num(values, 'tyres.rearTyres.forwardsGripScale'),
    backwardsGripScale: num(values, 'tyres.rearTyres.backwardsGripScale'),
    loadDependence: num(values, 'tyres.rearTyres.loadDependence'),
    radius: num(values, 'tyres.rearTyres.radius')
  };

  const friction = (axle, scaleKey) =>
    axle.peakGrip.peak * axle.yScale * axle[scaleKey];

  const frontLat = friction(front, 'transverseGripScale');
  const rearLat = friction(rear, 'transverseGripScale');
  const frontBrake = friction(front, 'backwardsGripScale');
  const rearBrake = friction(rear, 'backwardsGripScale');
  const frontAccel = friction(front, 'forwardsGripScale');
  const rearAccel = friction(rear, 'forwardsGripScale');

  const muLat = frontLoadShare * frontLat + rearLoadShare * rearLat;
  const muBrake = frontLoadShare * frontBrake + rearLoadShare * rearBrake;
  const muAccel = frontLoadShare * frontAccel + rearLoadShare * rearAccel;

  if (!(muLat > 0.05 && muLat < 3) || !(muBrake > 0.05 && muBrake < 3) ||
      !(muAccel > 0.05 && muAccel < 3)) {
    throw new Error(`${slug}: derived friction is outside a plausible range ` +
      `(lat ${muLat}, brake ${muBrake}, accel ${muAccel})`);
  }

  // Half the widest track is the geometric half-width used by the racing-line
  // corridor margin. It is geometry from XT, not a body-overhang claim.
  const halfTrackWidth = Math.max(trackWidthFront, trackWidthRear) / 2;

  return Object.freeze({
    kind: CAR_PHYSICS_KIND,
    version: CAR_PHYSICS_VERSION,
    slug,
    sourcePath,
    gravityMps2: XT_GRAVITY_MPS2,
    massKg,
    wheelBaseMetres: wheelBase,
    trackWidthFrontMetres: trackWidthFront,
    trackWidthRearMetres: trackWidthRear,
    halfTrackWidthMetres: halfTrackWidth,
    steerLimitRad,
    axles: Object.freeze({
      front: Object.freeze({
        loadShare: frontLoadShare,
        peakGrip: front.peakGrip.peak,
        peakGripAtSlip: front.peakGrip.peakAt,
        gripYScale: front.yScale,
        transverseGripScale: front.transverseGripScale,
        forwardsGripScale: front.forwardsGripScale,
        backwardsGripScale: front.backwardsGripScale,
        loadDependence: front.loadDependence,
        muLat: frontLat,
        muBrake: frontBrake,
        muAccel: frontAccel
      }),
      rear: Object.freeze({
        loadShare: rearLoadShare,
        peakGrip: rear.peakGrip.peak,
        peakGripAtSlip: rear.peakGrip.peakAt,
        gripYScale: rear.yScale,
        transverseGripScale: rear.transverseGripScale,
        forwardsGripScale: rear.forwardsGripScale,
        backwardsGripScale: rear.backwardsGripScale,
        loadDependence: rear.loadDependence,
        muLat: rearLat,
        muBrake: rearBrake,
        muAccel: rearAccel
      })
    }),
    muLat,
    muBrake,
    muAccel,
    lateralAccelLimitMps2: muLat * XT_GRAVITY_MPS2,
    brakeDecelLimitMps2: muBrake * XT_GRAVITY_MPS2,
    accelLimitMps2: muAccel * XT_GRAVITY_MPS2,
    fieldsUsed: Object.freeze([
      'mass.mass', 'mass.cofGOffsetZ',
      'geometry.wheelBase', 'geometry.trackWidthFront', 'geometry.trackWidthRear',
      'tyres.frontTyres.grip.yScale', 'tyres.frontTyres.grip.data',
      'tyres.frontTyres.grip.data[0].x', 'tyres.frontTyres.grip.data[0].y',
      'tyres.frontTyres.grip.data[1].x', 'tyres.frontTyres.grip.data[1].y',
      'tyres.frontTyres.grip.data[2].x', 'tyres.frontTyres.grip.data[2].y',
      'tyres.frontTyres.transverseGripScale', 'tyres.frontTyres.forwardsGripScale',
      'tyres.frontTyres.backwardsGripScale', 'tyres.frontTyres.loadDependence',
      'tyres.frontTyres.radius',
      'tyres.rearTyres.grip.yScale', 'tyres.rearTyres.grip.data',
      'tyres.rearTyres.grip.data[0].x', 'tyres.rearTyres.grip.data[0].y',
      'tyres.rearTyres.grip.data[1].x', 'tyres.rearTyres.grip.data[1].y',
      'tyres.rearTyres.grip.data[2].x', 'tyres.rearTyres.grip.data[2].y',
      'tyres.rearTyres.transverseGripScale', 'tyres.rearTyres.forwardsGripScale',
      'tyres.rearTyres.backwardsGripScale', 'tyres.rearTyres.loadDependence',
      'tyres.rearTyres.radius'
    ]),
    notModelled: Object.freeze([
      'friction.downforce', 'friction.constantDownforce',
      'surface grip modifier of the mesh under the wheel',
      'combined-slip reduction while braking and cornering together'
    ]),
    rule: 'friction-circle limit = static-axle-weighted peak grip * direction scale * 9.81; ' +
      'the retail solver applies the grip curve as a dimensionless coefficient'
  });
}

/** Read and derive one car by slug from `_work/e1-drive/cars.json`. */
export function loadCarPhysics(slug, { root }) {
  const roster = JSON.parse(readFileSync(`${root}/_work/e1-drive/cars.json`, 'utf8')).roster;
  const car = roster.cars.find((entry) => entry.slug === slug);
  if (!car) throw new Error(`car ${slug} is not in the roster`);
  const text = readFileSync(`${root}/${car.fields.path}`, 'utf8');
  return { car, physics: deriveCarPhysics(text, { slug, sourcePath: car.fields.path }) };
}
