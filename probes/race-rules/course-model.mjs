// CourseModel — ordered gates and lap lines built from a committed e1-drive
// layout document. Geometry is never duplicated: this module reads the layout's
// measured samples, gate records (a/b line, arc, heading, tangent, ground) and
// lap line as-is, validates their order and exposes projection/crossing helpers.
//
// Supported committed layouts:
//   * `_work/e1-drive/sprint.json`      courseId "310m" (310 m point-to-point)
//   * `_work/e1-drive/sprint-lap.json`  courseId "lap"  (loop-01, 3 laps)
//
// The layout files are read-only inputs. Nothing here calls an engine, a clock
// or a random source. Only +, -, *, /, Math.sqrt and Math.hypot are used for
// geometry; the committed gate tangent is used for the start grid.

import { hashOf } from './hash.mjs';

export const SUPPORTED_COURSE_IDS = Object.freeze(['310m', 'lap']);
export const COURSE_MODEL_SCHEMA = 'blur.race-rules.course/1';

/** Starting-grid constants are project-specific, not retail values. */
export const GRID_DEFAULTS = Object.freeze({
  source: 'provisional',
  spacingMetres: 2.2,
  rowSpacingMetres: 5.0,
  perRow: 2
});

const round6 = (value) => Math.round(value * 1e6) / 1e6;

function fail(message) {
  throw new Error('CourseModel: ' + message);
}

function finite(value, name) {
  if (!Number.isFinite(value)) fail(name + ' must be finite');
  return value;
}

function normalize2(x, z, name) {
  const length = Math.hypot(x, z);
  if (!(length > 1e-12)) fail(name + ' is degenerate');
  return { x: x / length, z: z / length };
}

/** Signed side of the gate line A->B for a point [x, y, z]. */
function lineSide(line, point) {
  return (line.b[0] - line.a[0]) * (point[2] - line.a[1]) -
    (line.b[1] - line.a[1]) * (point[0] - line.a[0]);
}

/**
 * Does the segment previousPosition -> position cross this gate line through
 * the gate span? The layout orients A->B so the positive side is the approach
 * side; only positive -> non-positive crossings count (same rule as the
 * existing e1-drive SprintRules/LapRules geometry).
 */
export function lineCrossing(previousPosition, position, line) {
  if (!Array.isArray(previousPosition) || !Array.isArray(position)) return null;
  if (!line || !Array.isArray(line.a) || !Array.isArray(line.b)) fail('gate line is missing a/b');
  const s0 = lineSide(line, previousPosition);
  const s1 = lineSide(line, position);
  if (!(s0 > 0 && s1 <= 0)) return null;
  const px = previousPosition[0];
  const pz = previousPosition[2];
  const rx = position[0] - px;
  const rz = position[2] - pz;
  const ax = line.a[0];
  const az = line.a[1];
  const sx = line.b[0] - ax;
  const sz = line.b[1] - az;
  const denominator = rx * sz - rz * sx;
  if (Math.abs(denominator) < 1e-12) return null;
  const qx = ax - px;
  const qz = az - pz;
  const along = (qx * sz - qz * sx) / denominator;
  const across = (qx * rz - qz * rx) / denominator;
  if (along < 0 || along > 1 || across < -1e-9 || across > 1 + 1e-9) return null;
  return {
    point: [
      round6(px + rx * along),
      round6(previousPosition[1] + (position[1] - previousPosition[1]) * along),
      round6(pz + rz * along)
    ],
    along: round6(along),
    across: round6(across)
  };
}

/** Nearest measured sample index for an arc (ties choose the earlier sample). */
function nearestSampleIndex(samples, arc) {
  let bestIndex = 0;
  let bestDelta = Math.abs(samples[0].arc - arc);
  for (let index = 1; index < samples.length; index++) {
    const delta = Math.abs(samples[index].arc - arc);
    if (delta < bestDelta - 1e-12) {
      bestDelta = delta;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function segmentIndexAtArc(samples, arc) {
  if (arc <= samples[0].arc) return 0;
  const last = samples.length - 1;
  if (arc >= samples[last].arc) return last - 1;
  let low = 0;
  let high = last;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (samples[middle].arc <= arc) low = middle;
    else high = middle;
  }
  return low;
}

export class CourseModel {
  /**
   * @param {object} layout parsed committed layout JSON
   * @param {{verifyLayoutHash?: boolean}} options
   */
  constructor(layout, options = {}) {
    if (!layout || typeof layout !== 'object') fail('layout is missing');
    if (layout.kind !== 'e1-drive.sprint') fail('unsupported layout kind ' + String(layout.kind));
    if (layout.version !== 1) fail('unsupported layout version ' + String(layout.version));
    if (!SUPPORTED_COURSE_IDS.includes(layout.courseId)) {
      fail('unsupported courseId ' + String(layout.courseId));
    }
    if (options.verifyLayoutHash !== false) {
      const copy = { ...layout };
      delete copy.hash;
      const expected = hashOf(copy);
      if (layout.hash !== expected) {
        fail('layout hash mismatch: file ' + String(layout.hash) + ' != recomputed ' + expected);
      }
    }

    const samples = layout.course?.samples;
    if (!Array.isArray(samples) || samples.length < 2) fail('layout has no measured samples');
    if (!Number.isFinite(samples[0].arc)) fail('sample arcs are not finite');
    for (let index = 1; index < samples.length; index++) {
      if (!(samples[index].arc > samples[index - 1].arc)) {
        fail('sample arcs do not strictly increase at index ' + index);
      }
    }

    const gates = layout.gates;
    if (!Array.isArray(gates) || gates.length < 2) fail('layout has no ordered gates');
    if (gates[0].kind !== 'start') fail('the first gate must be the start gate');
    if (gates[gates.length - 1].kind !== 'finish') fail('the last gate must be the finish gate');
    for (let index = 0; index < gates.length; index++) {
      const gate = gates[index];
      if (gate.index !== index) fail('gate ' + gate.id + ' has index ' + gate.index + ', expected ' + index);
      if (!Array.isArray(gate.a) || !Array.isArray(gate.b)) fail('gate ' + gate.id + ' has no a/b line');
      finite(gate.arc, 'gate arc ' + gate.id);
      finite(gate.x, 'gate x ' + gate.id);
      finite(gate.z, 'gate z ' + gate.id);
      if (index > 0 && !(gate.arc >= gates[index - 1].arc)) {
        fail('gate ' + gate.id + ' does not advance the arc');
      }
    }

    this.layout = layout;
    this.schema = COURSE_MODEL_SCHEMA;
    this.courseId = layout.courseId;
    this.mode = layout.courseId === 'lap' ? 'lap' : 'sprint';
    this.layoutHash = layout.hash;
    this.tickHz = layout.rules?.tickHz ?? 60;
    if (!(this.tickHz > 0)) fail('tickHz must be positive');
    this.countdownTicks = layout.countdown?.ticks ?? 0;
    if (!Number.isInteger(this.countdownTicks) || this.countdownTicks < 0) {
      fail('countdown ticks must be a non-negative integer');
    }
    this.samples = samples;
    this.measuredLengthMetres = samples[samples.length - 1].arc;
    this.gates = gates.map((gate) => Object.freeze({
      id: gate.id,
      kind: gate.kind,
      index: gate.index,
      sampleIndex: gate.sampleIndex ?? null,
      arc: gate.arc,
      x: gate.x,
      z: gate.z,
      height: gate.height ?? null,
      groundY: gate.height ?? layout.course?.spawnGroundY ?? null,
      headingRad: gate.headingRad,
      tangent: gate.tangent ? { ...gate.tangent } : null,
      widthMetres: gate.widthMetres ?? null,
      a: gate.a.slice(),
      b: gate.b.slice()
    }));
    this.startGate = this.gates[0];
    this.finishGate = this.gates[this.gates.length - 1];
    this.checkpointCount = this.gates.filter((gate) => gate.kind === 'checkpoint').length;
    this.corridorHalfWidthMetres = layout.course?.corridor?.halfWidthMetres ?? null;
    this.spawnGroundY = layout.course?.spawnGroundY ?? null;
    this.respawnConfig = Object.freeze({ ...(layout.rules?.respawn ?? {}) });

    if (this.mode === 'lap') {
      const lap = layout.course?.lap;
      if (!lap || !Number.isInteger(lap.laps) || lap.laps < 1) fail('lap layout has no lap count');
      if (!Number.isFinite(lap.lengthMetres) || !(lap.lengthMetres > 0)) fail('lap layout has no length');
      if (Math.abs(lap.lengthMetres - this.measuredLengthMetres) > 1e-3) {
        fail('lap length differs from the measured samples');
      }
      if (!lap.line || !Array.isArray(lap.line.a) || !Array.isArray(lap.line.b)) {
        fail('lap layout has no start/finish line');
      }
      this.laps = lap.laps;
      this.lengthMetres = lap.lengthMetres;
      this.minLapMetres = lap.minLapMetres ?? lap.lengthMetres * 0.5;
      this.lapLine = Object.freeze({
        arc: lap.line.arc ?? 0,
        x: lap.line.x,
        z: lap.line.z,
        groundY: lap.line.groundY ?? this.spawnGroundY,
        headingRad: lap.line.headingRad,
        widthMetres: lap.line.widthMetres ?? null,
        a: lap.line.a.slice(),
        b: lap.line.b.slice()
      });
      this.finishArc = this.lengthMetres;
    } else {
      const span = layout.course?.span;
      if (!span || !Number.isFinite(span.finishArc)) fail('sprint layout has no finish arc');
      this.laps = 1;
      this.lengthMetres = span.finishArc - (span.startArc ?? 0);
      this.minLapMetres = this.lengthMetres;
      this.lapLine = null;
      this.finishArc = span.finishArc;
    }

    this.modelHash = hashOf(this.toJSON());
  }

  /** Compact, hashable description: no sample array, no duplicated geometry. */
  toJSON() {
    return {
      schema: this.schema,
      courseId: this.courseId,
      mode: this.mode,
      layoutHash: this.layoutHash,
      tickHz: this.tickHz,
      countdownTicks: this.countdownTicks,
      laps: this.laps,
      lengthMetres: round6(this.lengthMetres),
      finishArc: round6(this.finishArc),
      measuredLengthMetres: round6(this.measuredLengthMetres),
      corridorHalfWidthMetres: this.corridorHalfWidthMetres,
      gates: this.gates.map((gate) => ({
        id: gate.id,
        kind: gate.kind,
        index: gate.index,
        arc: gate.arc,
        x: gate.x,
        z: gate.z,
        groundY: gate.groundY,
        headingRad: gate.headingRad,
        widthMetres: gate.widthMetres,
        a: gate.a,
        b: gate.b
      })),
      lapLine: this.lapLine
        ? { arc: this.lapLine.arc, x: this.lapLine.x, z: this.lapLine.z,
          groundY: this.lapLine.groundY, headingRad: this.lapLine.headingRad,
          widthMetres: this.lapLine.widthMetres, a: this.lapLine.a, b: this.lapLine.b }
        : null
    };
  }

  gate(index) {
    if (index < 0 || index >= this.gates.length) return null;
    return this.gates[index];
  }

  nextGate(index) {
    return this.gate(index + 1);
  }

  totalCheckpoints() {
    return this.checkpointCount;
  }

  /** Nearest measured ground height at an arc (nearest sample, as e1-drive). */
  groundAtArc(arc) {
    const sample = this.samples[nearestSampleIndex(this.samples, arc)];
    return sample.groundY ?? this.spawnGroundY;
  }

  /**
   * Interpolated point and local tangent at an arc. For a lap the arc wraps
   * modulo the measured loop length so callers can ask for lap 2 arc 12 m.
   */
  positionAtArc(arc, lateral = 0) {
    let target = finite(arc, 'arc');
    if (this.mode === 'lap') {
      target = ((target % this.lengthMetres) + this.lengthMetres) % this.lengthMetres;
    } else {
      target = Math.max(0, Math.min(this.measuredLengthMetres, target));
    }
    const index = segmentIndexAtArc(this.samples, target);
    const a = this.samples[index];
    const b = this.samples[index + 1];
    const span = b.arc - a.arc;
    const t = span > 0 ? (target - a.arc) / span : 0;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const tangent = normalize2(b.x - a.x, b.z - a.z, 'course segment');
    const nx = -tangent.z;
    const nz = tangent.x;
    return {
      x: round6(x + nx * lateral),
      y: round6(a.groundY ?? this.spawnGroundY),
      z: round6(z + nz * lateral),
      groundY: round6(this.groundAtArc(target)),
      tx: round6(tangent.x),
      tz: round6(tangent.z),
      nx: round6(nx),
      nz: round6(nz),
      arc: round6(target)
    };
  }

  /** Local forward tangent at an arc (unit, increasing-arc direction). */
  tangentAtArc(arc) {
    const point = this.positionAtArc(arc, 0);
    return { tx: point.tx, tz: point.tz };
  }

  /** Nearest point on the measured polyline. Pure full scan, no path state. */
  project(position) {
    if (!Array.isArray(position) || position.length < 3) fail('position must be [x, y, z]');
    finite(position[0], 'position.x');
    finite(position[1], 'position.y');
    finite(position[2], 'position.z');
    const px = position[0];
    const pz = position[2];
    let best = null;
    for (let index = 0; index < this.samples.length - 1; index++) {
      const a = this.samples[index];
      const b = this.samples[index + 1];
      const vx = b.x - a.x;
      const vz = b.z - a.z;
      const lengthSquared = vx * vx + vz * vz;
      let t = 0;
      if (lengthSquared > 0) {
        t = ((px - a.x) * vx + (pz - a.z) * vz) / lengthSquared;
        if (t < 0) t = 0; else if (t > 1) t = 1;
      }
      const x = a.x + vx * t;
      const z = a.z + vz * t;
      const dx = x - px;
      const dz = z - pz;
      const distanceSquared = dx * dx + dz * dz;
      if (best === null || distanceSquared < best.distanceSquared - 1e-12) {
        best = {
          distanceSquared,
          lateral: Math.sqrt(distanceSquared),
          arc: a.arc + (b.arc - a.arc) * t,
          segment: index,
          x,
          z
        };
      }
    }
    return {
      arc: round6(best.arc),
      lateral: round6(best.lateral),
      segment: best.segment,
      point: [round6(best.x), position[1], round6(best.z)],
      groundY: this.groundAtArc(best.arc)
    };
  }

  /** Crossing test for an ordered gate (or the lap line with gate.kind 'lap'). */
  crossing(previousPosition, position, gate) {
    if (!gate) return null;
    return lineCrossing(previousPosition, position, gate);
  }

  /**
   * Respawn target for the last passed gate. Sprint: the gate point and its
   * measured tangent heading (start line before the first checkpoint). Lap: the
   * start/finish line, because that is the last lap line the car crossed.
   */
  respawnTargetForGate(gateIndex) {
    if (this.mode === 'lap') {
      return {
        x: this.lapLine.x,
        y: this.lapLine.groundY,
        z: this.lapLine.z,
        headingRad: this.lapLine.headingRad,
        gateId: 'lap-line',
        gateIndex: 0
      };
    }
    const index = Math.max(0, Math.min(this.gates.length - 1, gateIndex));
    const gate = this.gates[index];
    return {
      x: gate.x,
      y: gate.groundY,
      z: gate.z,
      headingRad: gate.headingRad,
      gateId: gate.id,
      gateIndex: gate.index
    };
  }

  /**
   * Deterministic starting grid along the start gate. These are PROJECT-
   * SPECIFIC offsets, not recovered retail start positions: `source` is
   * "provisional" and the caller must show that label in the lobby/results UI.
   */
  startGrid(count, options = {}) {
    if (!Number.isInteger(count) || count < 1) fail('grid count must be a positive integer');
    const settings = { ...GRID_DEFAULTS, ...options };
    const gate = this.startGate;
    const tangent = gate.tangent
      ? normalize2(gate.tangent.tx, gate.tangent.tz, 'start tangent')
      : normalize2(gate.x - gate.a[0], gate.z - gate.a[1], 'start heading');
    const across = normalize2(gate.b[0] - gate.a[0], gate.b[1] - gate.a[1], 'start line');
    const slots = [];
    for (let index = 0; index < count; index++) {
      const row = Math.floor(index / settings.perRow);
      const column = index % settings.perRow;
      const lateral = (column - (settings.perRow - 1) / 2) * settings.spacingMetres;
      const back = row * settings.rowSpacingMetres;
      const x = gate.x - tangent.x * back + across.x * lateral;
      const z = gate.z - tangent.z * back + across.z * lateral;
      slots.push({
        slot: index + 1,
        x: round6(x),
        y: round6(this.groundAtArc(gate.arc - back)),
        z: round6(z),
        headingRad: gate.headingRad,
        source: settings.source
      });
    }
    return slots;
  }
}

export function createCourseModel(layout, options = {}) {
  return new CourseModel(layout, options);
}
