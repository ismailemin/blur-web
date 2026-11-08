/*
 * resolver.mjs — standalone 2D car-vs-car contact resolver for the Blur Web PoC.
 *
 * This is *not* the retail solver. It is a deterministic sequential-impulse
 * resolver that uses the recovered retail values:
 *
 *   - mass                : XT `mass.mass` per car (caller-supplied, kg)
 *   - friction            : 0.10   (amax.xt Vehicle x Vehicle pair)
 *   - restitution         : 0.20   (same pair), zero below 0.05 m/s approach
 *   - normal impulse      : accumulated, clamped >= 0 (Gravity solver2)
 *   - friction impulse    : accumulated, |Jt| <= mu * Jn
 *   - positional bias     : Baumgarte 1.25 / slop 5e-5 recovered; the resolver
 *                           resolves the residual position directly per
 *                           substep (split-impulse-style), which is labelled
 *                           `positionalMethod:"direct-split"` on every world.
 *   - manifold            : 2D reference/incident face clipping, <= 2 points
 *                           (retail keeps <= 4 in 3D)
 *
 * Conventions match the e1-drive engine state:
 *   forward (local +Z) = (sin(yaw), cos(yaw))
 *   right   (local +X) = (cos(yaw), -sin(yaw))
 *   yaw is the engine heading; +yaw rotates +Z toward +X
 *   yaw inertia (about +Y) is not recovered, so it is the box approximation
 *   I = m (L^2 + W^2) / 12 and labelled `inertiaSource:"box-envelope"`.
 *
 * Determinism: no randomness, no clocks, no Map iteration order, pairs sorted
 * by id, points in clipping order, fixed iteration counts. Two identical runs
 * produce identical state and event hashes.
 */

import {
  CAR_ENVELOPE,
  DAMAGE,
  MATERIAL_PAIR,
  SOLVER,
  resolveCarEnvelope,
  impactLevel,
  damageForLevel,
  gameplayImpulseFromNs,
  isFrontalImpact
} from './retail.mjs';

export const RESOLVER_VERSION = 1;
const EPS = 1e-9;
const TWO_PI = Math.PI * 2;

export class CarCollisionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CarCollisionError';
    this.code = code;
  }
}

function finite(value, name) {
  if (!Number.isFinite(value)) throw new CarCollisionError('not-finite', name + ' is not finite: ' + value);
  return value;
}

function wrapAngle(a) {
  return a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
}

/** Scalar yaw cross product: r x F (about +Y). */
function crossY(rx, rz, fx, fz) {
  return rz * fx - rx * fz;
}

/** Point velocity from linear velocity and yaw rate. */
function pointVelocity(vx, vz, omega, rx, rz) {
  return { x: vx + omega * rz, z: vz - omega * rx };
}

export function obbOf(car) {
  const sin = Math.sin(car.yaw);
  const cos = Math.cos(car.yaw);
  return {
    cx: car.x,
    cz: car.z,
    fx: sin,
    fz: cos,
    rx: cos,
    rz: -sin,
    hl: car.halfLength,
    hw: car.halfWidth
  };
}

function projectRadius(ax, az, box) {
  return Math.abs(ax * box.fx + az * box.fz) * box.hl + Math.abs(ax * box.rx + az * box.rz) * box.hw;
}

/** Axis-aligned bounds of the (optionally inflated) car box. */
export function aabbOf(car) {
  const o = obbOf(car);
  const ex = Math.abs(o.fx) * o.hl + Math.abs(o.rx) * o.hw;
  const ez = Math.abs(o.fz) * o.hl + Math.abs(o.rz) * o.hw;
  return { minX: o.cx - ex, maxX: o.cx + ex, minZ: o.cz - ez, maxZ: o.cz + ez };
}

export function aabbOverlap(a, b) {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minZ <= b.maxZ && b.minZ <= a.maxZ;
}

/**
 * N^2 AABB broadphase. Pairs are (i, j) with i < j in array order, which the
 * caller keeps sorted by id. Returns the pair list and the number of AABB
 * tests performed (the measured quantity for the CPU report).
 */
export function broadphaseAabbPairs(cars) {
  const boxes = cars.map(aabbOf);
  const pairs = [];
  let tests = 0;
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      tests++;
      if (aabbOverlap(boxes[i], boxes[j])) pairs.push([i, j]);
    }
  }
  return { pairs, tests };
}

/**
 * SAT for two boxes. The returned normal points from `a` to `b`; the winning
 * axis owner is recorded so the manifold can pick the reference face.
 */
export function satBoxes(a, b) {
  const axes = [
    { ax: a.fx, az: a.fz, owner: 'a', half: a.hl },
    { ax: a.rx, az: a.rz, owner: 'a', half: a.hw },
    { ax: b.fx, az: b.fz, owner: 'b', half: b.hl },
    { ax: b.rx, az: b.rz, owner: 'b', half: b.hw }
  ];
  let best = null;
  for (const axis of axes) {
    const ra = projectRadius(axis.ax, axis.az, a);
    const rb = projectRadius(axis.ax, axis.az, b);
    const d = axis.ax * (b.cx - a.cx) + axis.az * (b.cz - a.cz);
    const penetration = ra + rb - Math.abs(d);
    if (penetration <= EPS) return null;
    if (best === null || penetration < best.penetration - 1e-12) {
      const sign = d >= 0 ? 1 : -1;
      best = {
        penetration,
        nx: axis.ax * sign,
        nz: axis.az * sign,
        owner: axis.owner,
        axisHalf: axis.half
      };
    }
  }
  return best;
}

function pickFace(box, nx, nz, mode) {
  const faces = [
    { nx: box.fx, nz: box.fz, half: box.hl, tx: box.rx, tz: box.rz, thalf: box.hw },
    { nx: -box.fx, nz: -box.fz, half: box.hl, tx: box.rx, tz: box.rz, thalf: box.hw },
    { nx: box.rx, nz: box.rz, half: box.hw, tx: box.fx, tz: box.fz, thalf: box.hl },
    { nx: -box.rx, nz: -box.rz, half: box.hw, tx: box.fx, tz: box.fz, thalf: box.hl }
  ];
  let best = faces[0];
  let bestDot = mode === 'max' ? -Infinity : Infinity;
  for (const face of faces) {
    const dot = face.nx * nx + face.nz * nz;
    if (mode === 'max' ? dot > bestDot : dot < bestDot) {
      bestDot = dot;
      best = face;
    }
  }
  return best;
}

/** Clip segment p1..p2 to a half-plane (sign * (p - origin) . dir <= limit). */
function clipHalfPlane(p1, p2, ox, oz, dx, dz, sign, limit) {
  const f1 = sign * ((p1.x - ox) * dx + (p1.z - oz) * dz) - limit;
  const f2 = sign * ((p2.x - ox) * dx + (p2.z - oz) * dz) - limit;
  const inside1 = f1 <= 0;
  const inside2 = f2 <= 0;
  if (inside1 && inside2) return [p1, p2];
  if (!inside1 && !inside2) return [];
  const s = f1 / (f1 - f2);
  const mid = { x: p1.x + (p2.x - p1.x) * s, z: p1.z + (p2.z - p1.z) * s };
  return inside1 ? [p1, mid] : [mid, p2];
}

/**
 * Contact manifold for two boxes: full SAT + reference/incident face clipping.
 * Returns null when separated. Points carry `depth` along the a->b normal.
 */
export function manifold(aBox, bBox) {
  const sat = satBoxes(aBox, bBox);
  if (!sat) return null;
  const referenceIsA = sat.owner === 'a';
  const ref = referenceIsA ? aBox : bBox;
  const inc = referenceIsA ? bBox : aBox;
  // Outward normal of the reference face, in world space.
  const refNx = referenceIsA ? sat.nx : -sat.nx;
  const refNz = referenceIsA ? sat.nz : -sat.nz;
  const refFace = pickFace(ref, refNx, refNz, 'max');
  const incFace = pickFace(inc, refFace.nx, refFace.nz, 'min');

  const faceCx = ref.cx + refFace.nx * refFace.half;
  const faceCz = ref.cz + refFace.nz * refFace.half;
  const t1x = inc.cx + incFace.nx * incFace.half + incFace.tx * incFace.thalf;
  const t1z = inc.cz + incFace.nz * incFace.half + incFace.tz * incFace.thalf;
  const t2x = inc.cx + incFace.nx * incFace.half - incFace.tx * incFace.thalf;
  const t2z = inc.cz + incFace.nz * incFace.half - incFace.tz * incFace.thalf;

  let seg = [{ x: t1x, z: t1z }, { x: t2x, z: t2z }];
  // Reference face side planes: |(p - faceC) . tangent| <= thalf.
  seg = clipHalfPlane(seg[0], seg[1], faceCx, faceCz, refFace.tx, refFace.tz, 1, refFace.thalf);
  if (seg.length) seg = clipHalfPlane(seg[0], seg[1], faceCx, faceCz, refFace.tx, refFace.tz, -1, refFace.thalf);

  const points = [];
  const consider = (p) => {
    const dist = (p.x - faceCx) * refFace.nx + (p.z - faceCz) * refFace.nz;
    if (dist > 1e-9) return;
    const depth = -dist;
    if (points.some((q) => Math.abs(q.x - p.x) < 1e-7 && Math.abs(q.z - p.z) < 1e-7)) return;
    points.push({ x: p.x, z: p.z, depth });
  };
  for (const p of seg) consider(p);
  if (points.length === 0) {
    // Degenerate clip (deep corner contact): use the deepest incident vertex.
    let deepest = null;
    for (const p of [{ x: t1x, z: t1z }, { x: t2x, z: t2z }]) {
      const dist = (p.x - faceCx) * refFace.nx + (p.z - faceCz) * refFace.nz;
      if (deepest === null || dist < deepest.dist) deepest = { ...p, dist };
    }
    if (deepest && deepest.dist <= 0) points.push({ x: deepest.x, z: deepest.z, depth: -deepest.dist });
  }
  if (points.length === 0) return null;

  // Solver normal is always a -> b.
  const n = referenceIsA ? { x: sat.nx, z: sat.nz } : { x: -sat.nx, z: -sat.nz };
  return {
    normal: n,
    points,
    penetration: Math.max(...points.map((p) => p.depth)),
    satPenetration: sat.penetration,
    axisOwner: sat.owner,
    method: 'sat+reference/incident-face-clip',
    pointCount: points.length
  };
}

function makeCar(spec, world) {
  if (!spec || typeof spec.id !== 'string' || spec.id.length === 0) {
    throw new CarCollisionError('car-id', 'every car needs a non-empty string id');
  }
  if (world.cars.some((c) => c.id === spec.id)) {
    throw new CarCollisionError('car-duplicate', 'duplicate car id: ' + spec.id);
  }
  const mass = finite(Number(spec.mass), 'mass(' + spec.id + ')');
  if (mass <= 0) throw new CarCollisionError('car-mass', 'mass must be > 0: ' + spec.id);
  const envelope = resolveCarEnvelope(spec);
  const length = envelope.length;
  const width = envelope.width;
  const margin = spec.marginM === undefined ? world.marginM : Number(spec.marginM);
  if (!Number.isFinite(margin) || margin < 0) {
    throw new CarCollisionError('car-margin', 'marginM must be >= 0: ' + spec.id);
  }
  const halfLength = length / 2 + margin;
  const halfWidth = width / 2 + margin;
  // Yaw inertia: box approximation of the collision envelope. The retail
  // tensor comes from the imported `e_carcollider` hull and is not decoded.
  const iyy = (mass * (length * length + width * width)) / 12;
  const car = {
    id: spec.id,
    kind: spec.kind ?? 'human',
    mass,
    invMass: 1 / mass,
    iyy,
    invI: 1 / iyy,
    halfLength,
    halfWidth,
    envelope,
    x: finite(Number(spec.x ?? 0), 'x(' + spec.id + ')'),
    z: finite(Number(spec.z ?? 0), 'z(' + spec.id + ')'),
    yaw: finite(Number(spec.yaw ?? 0), 'yaw(' + spec.id + ')'),
    vx: finite(Number(spec.vx ?? 0), 'vx(' + spec.id + ')'),
    vz: finite(Number(spec.vz ?? 0), 'vz(' + spec.id + ')'),
    omega: finite(Number(spec.omega ?? 0), 'omega(' + spec.id + ')'),
    health: Number.isFinite(Number(spec.health)) ? Number(spec.health) : 1000,
    collidedCooldown: 0,
    contactTicks: 0,
    lastContactTick: -1
  };
  if (Math.hypot(car.vx, car.vz) > world.maxSpeedMps) {
    throw new CarCollisionError('car-speed', 'initial speed above maxSpeedMps: ' + spec.id);
  }
  world.cars.push(car);
  world.byId.set(car.id, car);
  return car;
}

/**
 * Create a deterministic car-collision world.
 *
 * options:
 *   dt                    fixed step (default 1/60)
 *   envelope              default envelope for cars without one
 *   marginM               extra hull inflation (default 0; retail 0.04)
 *   iterations            sequential impulse iterations (default 30, retail)
 *   positionIterations    direct separation passes (default 4)
 *   maxSubstepTravel      metres of relative travel per substep (default 0.08)
 *   restitution/friction  override only for tests; defaults are the XT pair
 *   damage                compute the retail impact event (default true)
 */
export function createCarWorld(options = {}) {
  const dt = options.dt === undefined ? 1 / 60 : Number(options.dt);
  if (!Number.isFinite(dt) || dt <= 0) throw new CarCollisionError('dt', 'dt must be > 0');
  const world = {
    version: RESOLVER_VERSION,
    dt,
    cars: [],
    byId: new Map(),
    envelope: options.envelope ?? CAR_ENVELOPE,
    marginM: options.marginM === undefined ? 0 : Number(options.marginM),
    iterations: options.iterations ?? SOLVER.iterations,
    positionIterations: options.positionIterations ?? 4,
    maxSubstepTravel: options.maxSubstepTravel ?? 0.08,
    maxSubsteps: options.maxSubsteps ?? 64,
    maxSpeedMps: options.maxSpeedMps ?? 80,
    angularCap: options.angularCap ?? 12,
    restitution: options.restitution ?? MATERIAL_PAIR.restitution,
    friction: options.friction ?? MATERIAL_PAIR.friction,
    restitutionThreshold: options.restitutionThreshold ?? SOLVER.restitutionVelocityThresholdMps,
    slop: options.slop ?? SOLVER.slopM,
    damage: options.damage !== false,
    tick: 0,
    seq: 0,
    traceSubsteps: options.traceSubsteps ?? null,
    lastEvents: [],
    lastManifolds: [],
    stats: null,
    params: {
      friction: options.friction ?? MATERIAL_PAIR.friction,
      frictionSource: MATERIAL_PAIR.source,
      restitution: options.restitution ?? MATERIAL_PAIR.restitution,
      restitutionSource: MATERIAL_PAIR.source,
      restitutionVelocityThresholdMps: options.restitutionThreshold ?? SOLVER.restitutionVelocityThresholdMps,
      iterations: options.iterations ?? SOLVER.iterations,
      positionalMethod: 'direct-split',
      positionalSlopM: options.slop ?? SOLVER.slopM,
      baumgarteRecovered: SOLVER.baumgarte,
      inertiaSource: 'box-envelope m*(L^2+W^2)/12',
      massSource: 'XT mass.mass (caller-supplied)',
      manifold: '2D reference/incident face clip (retail keeps <=4 in 3D)',
      envelopeSource: 'documented fixed box unless a per-car envelope is passed'
    }
  };
  world.addCar = (spec) => makeCar(spec, world);
  world.removeCar = (id) => {
    const index = world.cars.findIndex((c) => c.id === id);
    if (index < 0) return false;
    world.cars.splice(index, 1);
    world.byId.delete(id);
    return true;
  };
  world.setVelocity = (id, vx, vz, omega = 0) => {
    const car = world.byId.get(id);
    if (!car) throw new CarCollisionError('car-unknown', 'unknown car: ' + id);
    car.vx = finite(vx, 'vx');
    car.vz = finite(vz, 'vz');
    car.omega = finite(omega, 'omega');
  };
  world.setPose = (id, x, z, yaw) => {
    const car = world.byId.get(id);
    if (!car) throw new CarCollisionError('car-unknown', 'unknown car: ' + id);
    car.x = finite(x, 'x');
    car.z = finite(z, 'z');
    car.yaw = wrapAngle(finite(yaw, 'yaw'));
  };
  /** Apply an external impulse (N.s) at the centre of mass (power-up / net). */
  world.applyImpulse = (id, jx, jz) => {
    const car = world.byId.get(id);
    if (!car) throw new CarCollisionError('car-unknown', 'unknown car: ' + id);
    if (!Number.isFinite(jx) || !Number.isFinite(jz)) {
      throw new CarCollisionError('impulse', 'impulse must be finite');
    }
    car.vx += jx * car.invMass;
    car.vz += jz * car.invMass;
  };
  world.snapshot = () => world.cars.map((car) => ({
    id: car.id,
    kind: car.kind,
    mass: car.mass,
    envelope: { ...car.envelope },
    envelopeSource: car.envelope.source,
    envelopeFallback: car.envelope.fallback,
    x: car.x,
    z: car.z,
    yaw: car.yaw,
    vx: car.vx,
    vz: car.vz,
    omega: car.omega,
    speed: Math.hypot(car.vx, car.vz),
    health: car.health,
    collidedCooldown: car.collidedCooldown
  }));
  world.sortedCars = () => [...world.cars].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  world.step = () => stepWorld(world);
  world.reset = () => {
    world.tick = 0;
    world.seq = 0;
    world.lastEvents = [];
    world.lastManifolds = [];
    world.stats = null;
    for (const car of world.cars) {
      car.collidedCooldown = 0;
      car.contactTicks = 0;
      car.lastContactTick = -1;
    }
  };
  world.validate = () => validateWorld(world);
  return world;
}

function substepCount(world) {
  let maxTravelSpeed = 0;
  for (const car of world.cars) {
    const linear = Math.hypot(car.vx, car.vz);
    const rotational = Math.abs(car.omega) * Math.hypot(car.halfLength, car.halfWidth);
    if (linear + rotational > maxTravelSpeed) maxTravelSpeed = linear + rotational;
  }
  const travel = maxTravelSpeed * world.dt;
  return Math.max(1, Math.min(world.maxSubsteps, Math.ceil(travel / world.maxSubstepTravel) || 1));
}

function buildPairs(world) {
  const cars = world.sortedCars();
  const { pairs, tests } = broadphaseAabbPairs(cars);
  const manifolds = [];
  for (const [i, j] of pairs) {
    const a = cars[i];
    const b = cars[j];
    const m = manifold(obbOf(a), obbOf(b));
    // Canonical order: normal always points from the lexicographically first id
    // to the second, so event payloads do not depend on array order.
    if (m) {
      if (a.id <= b.id) {
        manifolds.push({ a, b, m });
      } else {
        manifolds.push({ a: b, b: a, m: { ...m, normal: { x: -m.normal.x, z: -m.normal.z } } });
      }
    }
  }
  return { manifolds, tests, pairs: pairs.length, cars };
}

function normalVelocity(a, b, point, n) {
  const va = pointVelocity(a.vx, a.vz, a.omega, point.rAx, point.rAz);
  const vb = pointVelocity(b.vx, b.vz, b.omega, point.rBx, point.rBz);
  return (vb.x - va.x) * n.x + (vb.z - va.z) * n.z;
}

function tangentialVelocity(a, b, point, t) {
  const va = pointVelocity(a.vx, a.vz, a.omega, point.rAx, point.rAz);
  const vb = pointVelocity(b.vx, b.vz, b.omega, point.rBx, point.rBz);
  return (vb.x - va.x) * t.x + (vb.z - va.z) * t.z;
}

function prepareManifold(world, a, b, m) {
  const n = m.normal;
  const t = { x: -n.z, z: n.x };
  for (const point of m.points) {
    point.rAx = point.x - a.x;
    point.rAz = point.z - a.z;
    point.rBx = point.x - b.x;
    point.rBz = point.z - b.z;
    const cnA = crossY(point.rAx, point.rAz, n.x, n.z);
    const cnB = crossY(point.rBx, point.rBz, n.x, n.z);
    point.kn = a.invMass + b.invMass + a.invI * cnA * cnA + b.invI * cnB * cnB;
    const ctA = crossY(point.rAx, point.rAz, t.x, t.z);
    const ctB = crossY(point.rBx, point.rBz, t.x, t.z);
    point.kt = a.invMass + b.invMass + a.invI * ctA * ctA + b.invI * ctB * ctB;
    point.jn = 0;
    point.jt = 0;
    const vn0 = normalVelocity(a, b, point, n);
    point.approach = vn0;
    // `bounce` is the target separating velocity after the solve. Retail
    // zeroes restitution below 0.05 m/s relative normal speed.
    point.bounce = -vn0 > world.restitutionThreshold ? -world.restitution * vn0 : 0;
  }
  return t;
}

function solveManifold(world, a, b, m, t, iterations) {
  const n = m.normal;
  for (let iter = 0; iter < iterations; iter++) {
    for (const point of m.points) {
      // Normal.
      const vn = normalVelocity(a, b, point, n);
      let dj = (point.bounce - vn) / point.kn;
      const oldJn = point.jn;
      point.jn = Math.max(oldJn + dj, 0);
      dj = point.jn - oldJn;
      const jx = dj * n.x;
      const jz = dj * n.z;
      a.vx -= jx * a.invMass;
      a.vz -= jz * a.invMass;
      a.omega -= a.invI * crossY(point.rAx, point.rAz, jx, jz);
      b.vx += jx * b.invMass;
      b.vz += jz * b.invMass;
      b.omega += b.invI * crossY(point.rBx, point.rBz, jx, jz);
      // Friction.
      const vt = tangentialVelocity(a, b, point, t);
      let djt = -vt / point.kt;
      const limit = world.friction * point.jn;
      const oldJt = point.jt;
      point.jt = Math.min(Math.max(oldJt + djt, -limit), limit);
      djt = point.jt - oldJt;
      const tx = djt * t.x;
      const tz = djt * t.z;
      a.vx -= tx * a.invMass;
      a.vz -= tz * a.invMass;
      a.omega -= a.invI * crossY(point.rAx, point.rAz, tx, tz);
      b.vx += tx * b.invMass;
      b.vz += tz * b.invMass;
      b.omega += b.invI * crossY(point.rBx, point.rBz, tx, tz);
    }
  }
}

function separatePair(world, a, b) {
  for (let iter = 0; iter < world.positionIterations; iter++) {
    const m = manifold(obbOf(a), obbOf(b));
    if (!m) return 0;
    const n = m.normal;
    let deepest = m.points[0];
    for (const point of m.points) if (point.depth > deepest.depth) deepest = point;
    const correction = Math.max(0, deepest.depth - world.slop);
    if (correction <= 0) return deepest.depth;
    const totalInvMass = a.invMass + b.invMass;
    const ax = (n.x * correction * a.invMass) / totalInvMass;
    const az = (n.z * correction * a.invMass) / totalInvMass;
    a.x -= ax;
    a.z -= az;
    b.x += n.x * correction - ax;
    b.z += n.z * correction - az;
  }
  return 0;
}

function determineAggressive(aStart, bStart, event) {
  const dx = bStart.x - aStart.x;
  const dz = bStart.z - aStart.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return null;
  const ux = dx / len;
  const uz = dz / len;
  const fwdA = Math.abs(ux * Math.sin(aStart.yaw) + uz * Math.cos(aStart.yaw));
  const fwdB = Math.abs(ux * Math.sin(bStart.yaw) + uz * Math.cos(bStart.yaw));
  const facingA = fwdA >= 0.707;
  const facingB = fwdB >= 0.707;
  const mph = (v) => v * 2.2369362920544;
  const speedA = mph(Math.hypot(aStart.vx, aStart.vz));
  const speedB = mph(Math.hypot(bStart.vx, bStart.vz));
  if (facingA && facingB) {
    const low = Math.min(speedA, speedB);
    const high = Math.max(speedA, speedB);
    const boosted = low + Math.min(Math.max(low * 0.5, 25), 45);
    if (high > boosted) return speedA > speedB ? aStart.id : bStart.id;
    return null;
  }
  if (facingA && !facingB) return aStart.id;
  if (!facingA && facingB) return bStart.id;
  // Swipe branch (both not facing): compare the impulse work on each side.
  const da = Math.abs((event.impulseOnA[0] * aStart.vx + event.impulseOnA[1] * aStart.vz) / aStart.mass);
  const db = Math.abs((event.impulseOnB[0] * bStart.vx + event.impulseOnB[1] * bStart.vz) / bStart.mass);
  if (da - db > 120) return aStart.id;
  if (db - da > 120) return bStart.id;
  return null;
}

function stepWorld(world) {
  const tick = world.tick + 1;
  const startStates = new Map(world.sortedCars().map((c) => [c.id, { x: c.x, z: c.z, yaw: c.yaw, vx: c.vx, vz: c.vz, mass: c.mass, id: c.id }]));
  const substeps = substepCount(world);
  const h = world.dt / substeps;
  const pairAcc = new Map();
  let broadphaseTests = 0;
  let narrowphaseTests = 0;
  let manifoldCount = 0;
  let maxPenetration = 0;

  for (let step = 0; step < substeps; step++) {
    for (const car of world.cars) {
      car.x += car.vx * h;
      car.z += car.vz * h;
      car.yaw = wrapAngle(car.yaw + car.omega * h);
    }
    const built = buildPairs(world);
    broadphaseTests += built.tests;
    narrowphaseTests += built.manifolds.length;
    if (built.manifolds.length === 0) continue;

    const prepared = built.manifolds.map(({ a, b, m }) => ({ a, b, m, t: prepareManifold(world, a, b, m) }));
    for (let iter = 0; iter < world.iterations; iter++) {
      for (const entry of prepared) solveManifold(world, entry.a, entry.b, entry.m, entry.t, 1);
    }
    // Stability cap before the position pass: a corner impulse can otherwise
    // spin a box faster than the substep budget can sweep. This is a project
    // bound (labelled), not a retail coefficient.
    for (const { a, b } of prepared) {
      if (a.omega > world.angularCap) a.omega = world.angularCap;
      if (a.omega < -world.angularCap) a.omega = -world.angularCap;
      if (b.omega > world.angularCap) b.omega = world.angularCap;
      if (b.omega < -world.angularCap) b.omega = -world.angularCap;
    }
    for (const { a, b, m } of prepared) {
      separatePair(world, a, b);
      if (world.traceSubsteps) {
        world.traceSubsteps.push({
          substep: step,
          pair: [a.id, b.id],
          preDepth: m.penetration,
          points: m.points.map((p) => p.depth),
          postDepth: manifold(obbOf(a), obbOf(b))?.penetration ?? 0,
          a: { x: a.x, z: a.z, yaw: a.yaw, vx: a.vx, vz: a.vz, omega: a.omega },
          b: { x: b.x, z: b.z, yaw: b.yaw, vx: b.vx, vz: b.vz, omega: b.omega }
        });
      }      const key = a.id + '|' + b.id;
      const deepest = m.points.reduce((best, p) => (p.depth > best.depth ? p : best), m.points[0]);
      const sumJn = m.points.reduce((sum, p) => sum + p.jn, 0);
      const maxJn = m.points.reduce((best, p) => Math.max(best, p.jn), 0);
      let acc = pairAcc.get(key);
      if (!acc) {
        acc = {
          key, a: a.id, b: b.id, contacts: 0, sumJn: 0, maxJn: 0,
          firstApproach: 0, point: { x: deepest.x, z: deepest.z }, depth: 0,
          points: 0,
          impulseOnA: [0, 0], impulseOnB: [0, 0], normal: { ...m.normal }
        };
        pairAcc.set(key, acc);
      }
      acc.contacts += 1;
      acc.sumJn += sumJn;
      acc.maxJn = Math.max(acc.maxJn, maxJn);
      acc.points = Math.max(acc.points, m.points.length);
      acc.firstApproach = Math.min(acc.firstApproach, deepest.approach);
      acc.depth = Math.max(acc.depth, deepest.depth);
      if (deepest.depth >= acc.depth - 1e-12) acc.point = { x: deepest.x, z: deepest.z };
      acc.impulseOnA[0] -= sumJn * m.normal.x;
      acc.impulseOnA[1] -= sumJn * m.normal.z;
      acc.impulseOnB[0] += sumJn * m.normal.x;
      acc.impulseOnB[1] += sumJn * m.normal.z;
      maxPenetration = Math.max(maxPenetration, deepest.depth);
    }
    manifoldCount += prepared.length;
    world.lastManifolds = prepared.map(({ a, b, m }) => ({
      pair: [a.id, b.id],
      normal: { ...m.normal },
      pointCount: m.points.length,
      points: m.points.map((p) => ({ x: p.x, z: p.z, depth: p.depth })),
      penetration: m.penetration
    }));
  }

  for (const car of world.cars) {
    const limit = world.angularCap;
    if (car.omega > limit) car.omega = limit;
    if (car.omega < -limit) car.omega = -limit;
    if (car.collidedCooldown > 0) car.collidedCooldown -= 1;
  }

  const events = [];
  const sortedKeys = [...pairAcc.keys()].sort();
  for (const key of sortedKeys) {
    const acc = pairAcc.get(key);
    const a = world.byId.get(acc.a);
    const b = world.byId.get(acc.b);
    if (!a || !b) continue;
    const aStart = startStates.get(a.id);
    const bStart = startStates.get(b.id);
    // Retail recomputes the contact impulse per point from the relative
    // velocity (ContactStreamIterator.cpp:246-295) and normalises it by
    // MaxVehicleDamageImpulse. The 2D resolver reports the pair total normal
    // impulse, which equals that value for a symmetric manifold.
    const gameplayImpulse = gameplayImpulseFromNs(acc.sumJn);
    const deltaA = [a.vx - aStart.vx, a.vz - aStart.vz];
    const deltaB = [b.vx - bStart.vx, b.vz - bStart.vz];
    const frontalA = isFrontalImpact({ deltaVx: deltaA[0], deltaVz: deltaA[1], yaw: aStart.yaw });
    const frontalB = isFrontalImpact({ deltaVx: deltaB[0], deltaVz: deltaB[1], yaw: bStart.yaw });
    // Damage is resolved per victim; the frontal/side gate is per victim.
    let aggressive = determineAggressive(aStart, bStart, acc);
    const victims = [];
    const considerVictim = (car, frontal) => {
      if (aggressive === car.id) return;
      const level = impactLevel(gameplayImpulse, !frontal);
      victims.push({
        id: car.id,
        isFrontal: frontal,
        impactLevel: level,
        damage: damageForLevel(level),
        cooldownReady: car.collidedCooldown <= 0
      });
    };
    considerVictim(a, frontalA);
    considerVictim(b, frontalB);
    const event = {
      kind: 'car-contact',
      seq: world.seq++,
      tick,
      pair: [a.id, b.id],
      normal: [acc.normal.x, acc.normal.z],
      point: [acc.point.x, acc.point.z],
      contactSubsteps: acc.contacts,
      manifoldPoints: acc.points,
      impulseNs: acc.sumJn,
      maxPointImpulseNs: acc.maxJn,
      gameplayImpulse,
      approachSpeedMps: Math.abs(acc.firstApproach),
      penetrationM: acc.depth,
      impulseOnA: acc.impulseOnA.slice(),
      impulseOnB: acc.impulseOnB.slice(),
      deltaV: { [a.id]: deltaA, [b.id]: deltaB },
      aggressiveId: aggressive,
      victims,
      contacts: acc.contacts
    };
    if (world.damage) {
      for (const victim of victims) {
        const car = world.byId.get(victim.id);
        if (victim.damage > 0 && victim.cooldownReady && car.collidedCooldown <= 0) {
          car.health = Math.max(0, car.health - victim.damage);
          car.collidedCooldown = Math.round(DAMAGE.collidedCooldownSeconds / world.dt);
          victim.damageApplied = true;
        } else {
          victim.damageApplied = false;
        }
      }
    }
    events.push(event);
    a.lastContactTick = tick;
    b.lastContactTick = tick;
    a.contactTicks += 1;
    b.contactTicks += 1;
  }

  world.tick = tick;
  world.lastEvents = events;
  world.stats = {
    tick,
    substeps,
    broadphaseTests,
    narrowphaseTests,
    manifoldCount,
    pairContacts: events.length,
    maxPenetrationM: maxPenetration,
    iterations: world.iterations,
    cars: world.cars.length
  };
  return { tick, cars: world.snapshot(), events, stats: world.stats };
}

function validateWorld(world) {
  const errors = [];
  for (const car of world.cars) {
    for (const field of ['x', 'z', 'yaw', 'vx', 'vz', 'omega', 'mass', 'iyy', 'health']) {
      if (!Number.isFinite(car[field])) errors.push(car.id + '.' + field + ' is not finite');
    }
    if (car.mass <= 0) errors.push(car.id + '.mass <= 0');
    if (car.envelope.length < car.envelope.width) errors.push(car.id + '.envelope axes swapped');
  }
  return { ok: errors.length === 0, errors };
}

/** Deepest remaining overlap across all pairs, for test assertions. */
export function deepestOverlap(world) {
  let deepest = 0;
  const cars = world.sortedCars();
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const m = manifold(obbOf(cars[i]), obbOf(cars[j]));
      if (m) deepest = Math.max(deepest, m.penetration);
    }
  }
  return deepest;
}
