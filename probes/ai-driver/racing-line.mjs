// Deterministic racing-line generator and speed profile for the Blur Web AI.
//
// Inputs are read-only and already committed:
//   * a measured course layout (`_work/e1-drive/sprint.json`,
//     `_work/e1-drive/sprint-lap.json`, `_work/e1-drive/amboy/layout.json`,
//     `_work/e1-drive/gracia/layout.json`) with its 0.25 m centre-line samples,
//   * the car's derived XT friction limits from `./car-physics.mjs`.
//
// The generator does three things:
//
//   1. Line  — constrained minimum-curvature relaxation of the measured centre
//      line inside the course's usable lateral width. Each sample keeps its own
//      lateral offset `o_i` from the centre line; the relaxation minimises the
//      discrete second difference of the resulting polyline (the standard
//      minimum-curvature formulation) subject to `|o_i| <= halfWidth_i`. That
//      produces the classic out-in-out line: the offset saturates on the outside
//      at corner entry/exit and on the inside at the apex.
//   2. Profile — `v_curve = sqrt(a_lat / |kappa|)` from the line curvature, then a
//      backward braking pass with `a_brake` and a forward traction pass with
//      `a_accel`. `a_lat`, `a_brake` and `a_accel` come from the car's XT tyre
//      grip fields (see `car-physics.mjs`), times a declared tyre-utilisation
//      factor. There is no tuned friction constant anywhere in this file.
//   3. Hash — a canonical SHA-256 over the line so a baked line can be compared
//      with a rebuilt one byte for byte.
//
// No clock, no `Math.random`, no wall time. Same layout + same car => same line,
// same profile, same hash.

import { createHash } from 'node:crypto';

export const RACING_LINE_KIND = 'blur.ai-racing-line';
export const RACING_LINE_VERSION = 1;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

const wrapAngle = (value) => {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
};

const round6 = (value) => Math.round(value * 1e6) / 1e6;

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function hashOf(value) {
  return 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
}

// ---------------------------------------------------------------------------
// Course width model.
//
// The lateral bound is the *declared* course corridor minus a declared margin.
// The corridor is a rules/respawn band, not a measured road width, so every
// generated line records that provenance and the margin it used. A caller that
// has a measured road width can pass `halfWidthMetres` explicitly and the line
// records `source: 'caller'`.
// ---------------------------------------------------------------------------

export const DEFAULT_LINE_MARGIN_METRES = Object.freeze({
  // 6 m declared band, 1.0 m margin: the car centre stays within +/-5.0 m.
  '310m': 1.0,
  amboy: 1.0,
  gracia: 1.0,
  // 1.25 m declared band. The loop's measured flat band is 11.75 m, but the
  // respawn rule is the 1.25 m band, so only 0.5 m of line freedom is safe.
  lap: 0.75
});

export const LINE_OPTIONS = Object.freeze({
  /** Coarse-to-fine relaxation schedule (sample stride per level). */
  relaxationLevels: Object.freeze([32, 16, 8, 4, 2, 1]),
  relaxationIterations: 60,
  relaxationGain: 0.45,
  postSmoothPasses: 3,
  curvatureWindowMetres: 4,
  pinEndsMetres: 8,
  gripUtilisation: 0.85,
  speedCapMetresPerSecond: 42,
  minLateralSpeedMetresPerSecond: 3
});

function courseHalfWidth(layout) {
  const course = layout.course ?? {};
  const declared = course.corridor?.halfWidthMetres ?? course.band?.halfWidthMetres ?? null;
  return Number.isFinite(declared) ? declared : null;
}

// ---------------------------------------------------------------------------
// Line nodes: the measured samples as a periodic (closed) or open list, with a
// unit tangent and the left normal that matches the committed lateral sign
// convention (`lateral = tangentX * offsetZ - tangentZ * offsetX`).
// ---------------------------------------------------------------------------

function buildNodes(layout) {
  const course = layout.course;
  const all = course.samples;
  if (!Array.isArray(all) || all.length < 9) throw new Error('layout has too few samples');
  const closed = layout.courseId === 'lap';
  // The closed loop repeats its first point as its last sample; drop the
  // duplicate so the node list is a true cycle.
  const samples = closed ? all.slice(0, all.length - 1) : all.slice();
  const count = samples.length;

  const nodes = samples.map((sample, index) => ({
    index,
    arc: sample.arc,
    x: sample.x,
    z: sample.z,
    groundY: sample.groundY
  }));

  const at = (index) => nodes[closed ? ((index % count) + count) % count
    : clamp(index, 0, count - 1)];

  // Tangent from a +-2 sample window so a single 0.25 m step cannot rotate it.
  for (let index = 0; index < count; index++) {
    const a = at(index - 2);
    const b = at(index + 2);
    let tx = b.x - a.x;
    let tz = b.z - a.z;
    const length = Math.hypot(tx, tz);
    if (!(length > 1e-9)) throw new Error(`degenerate tangent at sample ${index}`);
    tx /= length;
    tz /= length;
    const node = nodes[index];
    node.tangentX = tx;
    node.tangentZ = tz;
    // Left normal in the committed convention (see the module header).
    node.normalX = -tz;
    node.normalZ = tx;
    node.heading = Math.atan2(tx, tz);
  }

  return { nodes, closed, count, at };
}

/** Line arc spacing (metres) between node i and the next node. */
function spacingOf(nodes, index, closed) {
  const count = nodes.length;
  const next = nodes[closed ? (index + 1) % count : Math.min(index + 1, count - 1)];
  return Math.hypot(next.x - nodes[index].x, next.z - nodes[index].z);
}

// ---------------------------------------------------------------------------
// Constrained minimum-curvature relaxation.
//
// p_i = c_i + o_i * n_i  (c = measured sample, n = left normal, |o_i| <= w_i).
// One Gauss-Seidel sweep sets the lateral move that would zero the second
// difference component along n_i:
//
//     d_i = p_{i-1} - 2 p_i + p_{i+1}
//     delta_i = gain * (d_i . n_i) / 2
//     o_i <- clamp(o_i + delta_i, -w_i, +w_i)
//
// Repeated sweeps minimise sum |d_i|^2 inside the corridor. The clamp is what
// makes the line use the free width; the objective is what makes it the racing
// line rather than the shortest line (a shortest line would hug the inside of
// every corner and increase curvature).
// ---------------------------------------------------------------------------

function relaxSweeps(nodes, halfWidths, { closed, iterations, gain, initial = null }) {
  const count = nodes.length;
  const offset = initial ? Float64Array.from(initial) : new Float64Array(count);
  const px = new Float64Array(count);
  const pz = new Float64Array(count);

  const project = () => {
    for (let index = 0; index < count; index++) {
      const node = nodes[index];
      px[index] = node.x + offset[index] * node.normalX;
      pz[index] = node.z + offset[index] * node.normalZ;
    }
  };

  const prevIndex = (index) => (closed ? (index - 1 + count) % count : Math.max(0, index - 1));
  const nextIndex = (index) => (closed ? (index + 1) % count : Math.min(count - 1, index + 1));

  for (let iteration = 0; iteration < iterations; iteration++) {
    project();
    for (let index = 0; index < count; index++) {
      if (!closed && (index === 0 || index === count - 1)) continue;
      const node = nodes[index];
      const a = prevIndex(index);
      const b = nextIndex(index);
      const dx = px[a] - 2 * px[index] + px[b];
      const dz = pz[a] - 2 * pz[index] + pz[b];
      const along = dx * node.normalX + dz * node.normalZ;
      const moved = offset[index] + gain * along * 0.5;
      offset[index] = clamp(moved, -halfWidths[index], halfWidths[index]);
    }
  }
  return offset;
}

/**
 * Multi-resolution relaxation.
 *
 * A single-resolution Gauss-Seidel sweep converges the high-frequency modes in
 * a few iterations but the low-frequency modes (the uniform "move the whole
 * line to the outside of the bend" mode, which is the one that matters) only in
 * O(n^2) sweeps. Relaxing a decimated copy first lets that mode converge on a
 * 30-sample curve, and each finer level then only has to correct the detail it
 * adds. The level schedule and iteration counts are fixed, so the result is a
 * pure function of the input.
 */
function relax(nodes, halfWidths, { closed, levels, iterations, gain }) {
  const count = nodes.length;
  let coarse = null; // { stride, offset, count }

  const sample = (target) => {
    if (!coarse) return 0;
    const { stride, offset, count: coarseCount } = coarse;
    const position = target / stride;
    const low = Math.floor(position);
    const high = Math.min(low + 1, coarseCount - 1);
    const t = position - low;
    return offset[low] * (1 - t) + offset[high] * t;
  };

  for (const stride of levels) {
    const indices = [];
    for (let index = 0; index < count; index += stride) indices.push(index);
    if (!closed && indices[indices.length - 1] !== count - 1) indices.push(count - 1);
    const subNodes = indices.map((index) => nodes[index]);
    const subWidths = new Float64Array(indices.length);
    for (let position = 0; position < indices.length; position++) {
      subWidths[position] = halfWidths[indices[position]];
      if (closed) {
        const from = indices[position];
        const to = position + 1 < indices.length ? indices[position + 1]
          : indices[0] + count;
        for (let index = from + 1; index < to; index++) {
          subWidths[position] = Math.min(subWidths[position], halfWidths[index % count]);
        }
      }
    }
    const seed = Float64Array.from(subNodes, (node) => sample(node.index));
    for (let position = 0; position < seed.length; position++) {
      seed[position] = clamp(seed[position], -subWidths[position], subWidths[position]);
    }
    const merged = relaxSweeps(subNodes, subWidths, { closed, iterations, gain, initial: seed });
    coarse = { stride, offset: merged, count: merged.length };
  }

  const offset = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    offset[index] = clamp(sample(index), -halfWidths[index], halfWidths[index]);
  }

  // A short 1-2-1 pass removes the residual sample-to-sample stair stepping the
  // Gauss-Seidel sweep leaves behind while keeping every offset inside the band.
  for (let pass = 0; pass < 3; pass++) {
    const copy = Float64Array.from(offset);
    for (let index = 0; index < count; index++) {
      if (!closed && (index === 0 || index === count - 1)) continue;
      const a = copy[closed ? (index - 1 + count) % count : Math.max(0, index - 1)];
      const b = copy[closed ? (index + 1) % count : Math.min(count - 1, index + 1)];
      offset[index] = clamp(0.25 * a + 0.5 * copy[index] + 0.25 * b,
        -halfWidths[index], halfWidths[index]);
    }
  }
  return offset;
}

// ---------------------------------------------------------------------------
// Curvature and speed profile.
// ---------------------------------------------------------------------------

function linePoints(nodes, offset) {
  return nodes.map((node, index) => ({
    arc: node.arc,
    x: node.x + offset[index] * node.normalX,
    z: node.z + offset[index] * node.normalZ,
    groundY: node.groundY,
    offset: offset[index],
    normalX: node.normalX,
    normalZ: node.normalZ,
    tangentX: node.tangentX,
    tangentZ: node.tangentZ
  }));
}

/**
 * Signed curvature per metre, measured as the heading change between two
 * half-windows of `windowMetres` divided by the window length. A window rather
 * than a 3-point circle keeps the measured 0.25 m samples from injecting
 * high-frequency curvature noise into the speed profile.
 */
function curvatures(points, closed, windowMetres) {
  const n = points.length;
  const span = closed
    ? points[n - 1].arc + (points[n - 1].arc - points[n - 2].arc)
    : points[n - 1].arc;
  const wrap = (arc) => {
    if (!closed) return clamp(arc, points[0].arc, points[n - 1].arc);
    let value = arc % span;
    if (value < 0) value += span;
    return value;
  };
  const lookup = (target) => {
    const arc = wrap(target);
    let low = 0;
    let high = n - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (points[middle].arc <= arc) low = middle; else high = middle;
    }
    const a = points[low];
    const b = points[(low + 1) % n];
    const gap = b.arc - a.arc;
    const t = gap > 0 ? clamp((arc - a.arc) / gap, 0, 1) : 0;
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  };

  const result = new Float64Array(n);
  const half = windowMetres / 2;
  for (let index = 0; index < n; index++) {
    const s = points[index].arc;
    const p0 = lookup(s - half);
    const p1 = lookup(s);
    const p2 = lookup(s + half);
    const h01 = Math.atan2(p1.x - p0.x, p1.z - p0.z);
    const h12 = Math.atan2(p2.x - p1.x, p2.z - p1.z);
    result[index] = wrapAngle(h12 - h01) / windowMetres;
  }
  if (!closed) {
    // The `lookup` clamp collapses the window at the two ends, which would
    // report a huge fake curvature there. Copy the first/last window that is
    // fully inside the polyline instead.
    const interior = Math.max(1, Math.ceil(half / Math.max(1e-6,
      (points[n - 1].arc - points[0].arc) / (n - 1))));
    const first = result[Math.min(interior, n - 1)];
    const last = result[Math.max(0, n - 1 - interior)];
    for (let index = 0; index < interior; index++) result[index] = first;
    for (let index = Math.max(0, n - interior); index < n; index++) result[index] = last;
  }
  return result;
}

function speedProfile(points, curvature, physics, options, closed) {
  const count = points.length;
  const aLat = physics.lateralAccelLimitMps2 * options.gripUtilisation;
  const aBrake = physics.brakeDecelLimitMps2 * options.gripUtilisation;
  const aAccel = physics.accelLimitMps2 * options.gripUtilisation;
  const cap = options.speedCapMetresPerSecond;

  const ds = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const next = points[(index + 1) % count];
    const here = points[index];
    ds[index] = closed
      ? Math.hypot(next.x - here.x, next.z - here.z)
      : Math.hypot(points[Math.min(index + 1, count - 1)].x - here.x,
        points[Math.min(index + 1, count - 1)].z - here.z);
  }

  const v = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const k = Math.abs(curvature[index]);
    const curve = k > 1e-6 ? Math.sqrt(aLat / k) : cap;
    v[index] = Math.min(cap, Math.max(options.minLateralSpeedMetresPerSecond, curve));
  }

  // Braking pass (backwards): v_i must be reachable from v_{i+1} at aBrake.
  const passes = closed ? 2 : 1;
  for (let pass = 0; pass < passes; pass++) {
    for (let index = count - 1; index >= 0; index--) {
      const next = (index + 1) % count;
      if (!closed && index === count - 1) continue;
      const limit = Math.sqrt(v[next] * v[next] + 2 * aBrake * ds[index]);
      if (v[index] > limit) v[index] = limit;
    }
  }
  // Traction pass (forwards): the profile cannot demand more acceleration than
  // the tyre allows. This pass only ever raises the physical realism of the
  // target; the throttle controller caps the real acceleration anyway.
  for (let pass = 0; pass < passes; pass++) {
    for (let index = 0; index < count; index++) {
      if (!closed && index === 0) continue;
      const previous = (index - 1 + count) % count;
      const limit = Math.sqrt(v[previous] * v[previous] + 2 * aAccel * ds[previous]);
      if (v[index] > limit) v[index] = limit;
    }
  }
  return { v, ds, aLat, aBrake, aAccel };
}

// ---------------------------------------------------------------------------
// Public: build a racing line for a layout and a car.
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {object} args.layout   committed layout document (read-only)
 * @param {object} args.physics  `deriveCarPhysics()` result
 * @param {object} [args.options] overrides for `LINE_OPTIONS`
 * @param {number} [args.halfWidthMetres] caller-supplied measured half width
 * @param {number} [args.lineMarginMetres] corridor margin override
 */
export function buildRacingLine({ layout, physics, options = {}, halfWidthMetres = null,
  lineMarginMetres = null }) {
  if (!layout) throw new Error('layout is required');
  if (!physics || !Number.isFinite(physics.lateralAccelLimitMps2)) {
    throw new Error('physics (deriveCarPhysics result) is required');
  }
  const settings = Object.freeze({ ...LINE_OPTIONS, ...options });
  const { nodes, closed, count } = buildNodes(layout);

  const declaredHalfWidth = courseHalfWidth(layout);
  const margin = lineMarginMetres ?? DEFAULT_LINE_MARGIN_METRES[layout.courseId] ?? 1;
  const bound = halfWidthMetres ?? (declaredHalfWidth === null ? null : declaredHalfWidth - margin);
  if (bound === null || !(bound > 0.05)) {
    throw new Error(`course ${layout.courseId} has no usable lateral width ` +
      `(declared ${declaredHalfWidth}, margin ${margin}, bound ${bound})`);
  }
  const widthSource = halfWidthMetres !== null
    ? 'caller-supplied half width'
    : `declared course corridor half width ${declaredHalfWidth} m minus ${margin} m line margin`;

  const halfWidths = new Float64Array(count).fill(bound);
  // Open courses pin the line to the measured start and finish so the car
  // launches and crosses the gate on the committed line.
  if (!closed && settings.pinEndsMetres > 0) {
    for (let index = 0; index < count; index++) {
      const fromStart = nodes[index].arc;
      const fromEnd = nodes[count - 1].arc - nodes[index].arc;
      const ramp = Math.min(1, Math.min(fromStart, fromEnd) / settings.pinEndsMetres);
      halfWidths[index] = bound * ramp;
    }
  }

  const offset = relax(nodes, halfWidths, {
    closed,
    levels: settings.relaxationLevels,
    iterations: settings.relaxationIterations,
    gain: settings.relaxationGain
  });

  const points = linePoints(nodes, offset);

  const curvature = curvatures(points, closed, settings.curvatureWindowMetres);
  const { v, ds, aLat, aBrake, aAccel } = speedProfile(points, curvature, physics, settings, closed);

  let maxAbsCurvature = 0;
  let minRadius = Infinity;
  let maxOffset = 0;
  let minSpeed = Infinity;
  let maxSpeed = 0;
  for (let index = 0; index < count; index++) {
    const k = Math.abs(curvature[index]);
    if (k > maxAbsCurvature) maxAbsCurvature = k;
    if (k > 1e-6 && 1 / k < minRadius) minRadius = 1 / k;
    if (Math.abs(points[index].offset) > maxOffset) maxOffset = Math.abs(points[index].offset);
    if (v[index] < minSpeed) minSpeed = v[index];
    if (v[index] > maxSpeed) maxSpeed = v[index];
  }

  const linePointsOut = points.map((point, index) => ({
    arc: round6(point.arc),
    x: round6(point.x),
    z: round6(point.z),
    groundY: round6(point.groundY ?? 0),
    offset: round6(point.offset),
    halfWidth: round6(halfWidths[index]),
    curvature: round6(curvature[index]),
    targetSpeed: round6(v[index])
  }));

  const document = {
    kind: RACING_LINE_KIND,
    version: RACING_LINE_VERSION,
    courseId: layout.courseId,
    layoutHash: layout.hash ?? null,
    closed,
    spawn: layout.course?.spawn ?? null,
    count,
    lengthMetres: round6(closed ? points[count - 1].arc + ds[count - 1] : points[count - 1].arc),
    width: {
      source: widthSource,
      declaredCorridorHalfWidthMetres: declaredHalfWidth,
      lineMarginMetres: margin,
      usableHalfWidthMetres: round6(bound),
      maxLineOffsetMetres: round6(maxOffset),
      rule: 'the declared corridor is a rules/respawn band, not a measured road width'
    },
    profile: {
      car: physics.slug,
      gripUtilisation: settings.gripUtilisation,
      lateralAccelLimitMps2: round6(physics.lateralAccelLimitMps2),
      brakeDecelLimitMps2: round6(physics.brakeDecelLimitMps2),
      accelLimitMps2: round6(physics.accelLimitMps2),
      lateralAccelUsedMps2: round6(aLat),
      brakeDecelUsedMps2: round6(aBrake),
      accelUsedMps2: round6(aAccel),
      speedCapMetresPerSecond: settings.speedCapMetresPerSecond,
      curvatureWindowMetres: settings.curvatureWindowMetres,
      minTargetSpeed: round6(minSpeed),
      maxTargetSpeed: round6(maxSpeed),
      rule: 'v = sqrt(a_lat/|kappa|), then a braking pass at a_brake and a traction pass at a_accel; ' +
        'a_lat/a_brake/a_accel are XT tyre-grip limits times gripUtilisation'
    },
    geometry: {
      maxAbsCurvature: round6(maxAbsCurvature),
      minRadiusMetres: Number.isFinite(minRadius) ? round6(minRadius) : null,
      relaxationLevels: settings.relaxationLevels.slice(),
      relaxationIterations: settings.relaxationIterations,
      relaxationGain: settings.relaxationGain,
      postSmoothPasses: settings.postSmoothPasses,
      pinEndsMetres: settings.pinEndsMetres,
      rule: 'constrained minimum-curvature relaxation of the measured centre line inside the usable width'
    },
    points: linePointsOut
  };
  document.hash = hashOf(document);
  return document;
}

// ---------------------------------------------------------------------------
// Runtime lookup: the controller needs the target point, the line offset and the
// target speed at a centre-line arc.
// ---------------------------------------------------------------------------

export class RacingLine {
  constructor(document) {
    if (!document || document.kind !== RACING_LINE_KIND) {
      throw new Error('not a racing-line document');
    }
    const { hash, ...rest } = document;
    const rebuilt = hashOf(rest);
    if (rebuilt !== hash) throw new Error('racing-line hash does not match its content');
    this.document = document;
    this.points = document.points;
    this.closed = document.closed;
    this.length = document.lengthMetres;
    this.count = this.points.length;
  }

  /** Index of the point at or before `arc` (binary search + linear refine). */
  indexAt(arc) {
    const points = this.points;
    const n = points.length;
    let target = arc;
    if (this.closed) {
      const span = this.length;
      target = arc % span;
      if (target < 0) target += span;
    } else {
      target = clamp(arc, points[0].arc, points[n - 1].arc);
    }
    let low = 0;
    let high = n - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (points[middle].arc <= target) low = middle; else high = middle;
    }
    const a = points[low];
    const b = points[(low + 1) % n];
    const span = b.arc - a.arc;
    const t = span > 0 ? clamp((target - a.arc) / span, 0, 1) : 0;
    return { low, t, x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
      offset: a.offset + (b.offset - a.offset) * t,
      halfWidth: a.halfWidth + (b.halfWidth - a.halfWidth) * t,
      curvature: a.curvature + (b.curvature - a.curvature) * t,
      targetSpeed: a.targetSpeed + (b.targetSpeed - a.targetSpeed) * t };
  }

  /** Point on the line `aheadMetres` beyond `arc`. */
  pointAt(arc, aheadMetres = 0) {
    return this.indexAt(arc + aheadMetres);
  }

  /** Half width available at `arc` (metres, each side of the centre line). */
  halfWidthAt(arc) {
    return this.indexAt(arc).halfWidth;
  }

  summary() {
    const d = this.document;
    return {
      kind: d.kind, version: d.version, courseId: d.courseId, hash: d.hash,
      closed: d.closed, count: d.count, lengthMetres: d.lengthMetres,
      width: d.width, profile: d.profile, geometry: d.geometry,
      car: d.profile.car
    };
  }
}

export function createRacingLine(document) {
  return new RacingLine(document);
}
