// Measured-course geometry for the live-standings probe.
//
// The course is read from the committed e1-drive layout documents and never
// re-derived: samples, gates, the lap line and the respawn rules come from the
// file. This module only projects a reported 2D position onto the measured
// polyline and tests declared gates/lines.
//
// Sprint (courseId "310m"): arc along the measured P48 path, finish clamped at
// course.span.finishArc. Lap (courseId "lap"): arc around the measured P61
// loop-01, wrapped at the closed seam. Free (courseId "free"): no course line,
// no standings metric; the object advertises `standings:false`.
//
// Project-specific, labelled values (never presented as retail split lines):
//   - lap sector lines: `sectorCount - 1` interior lines at equal measured arcs.
//     They are rules markers on the measured loop, used only for shortcut
//     rejection. The start/finish line comes from the layout.

import { hashOf } from './hash.mjs';

const round6 = (value) => Math.round(value * 1e6) / 1e6;

export const COURSE_MODE = Object.freeze({
  SPRINT: 'sprint',
  LAP: 'lap',
  FREE: 'free'
});

const SUPPORTED_KINDS = new Set(['e1-drive.sprint']);
const SUPPORTED_COURSE_IDS = new Set(['310m', 'lap', 'free']);

function fail(message) {
  throw new Error('standings course: ' + message);
}

function finite(value, label) {
  if (!Number.isFinite(value)) fail(label + ' is not finite');
  return value;
}

function normalize2(x, z, label) {
  const length = Math.hypot(x, z);
  if (!(length > 1e-9)) fail(label + ' has zero length');
  return { x: x / length, z: z / length };
}

/** Wrapped forward delta on a closed loop; plain delta on an open path. */
function wrapDelta(delta, length, closed) {
  if (!closed) return delta;
  let value = ((delta % length) + length) % length;
  if (value > length / 2) value -= length;
  return value;
}

/** Nearest measured sample index by arc (binary search). */
function nearestSampleIndex(samples, arc) {
  let low = 0;
  let high = samples.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (samples[middle].arc <= arc) low = middle;
    else high = middle;
  }
  return Math.abs(samples[low].arc - arc) <= Math.abs(samples[high].arc - arc) ? low : high;
}

/** Interpolated measured point and unit tangent at an arc. */
function positionAtArc(samples, arc, closed) {
  const length = samples[samples.length - 1].arc;
  let target = arc;
  if (closed) target = ((target % length) + length) % length;
  else target = Math.max(samples[0].arc, Math.min(length, target));
  const index = nearestSampleIndex(samples, target);
  let a = samples[index];
  let b = samples[index + 1] ?? samples[index];
  if (closed && b === samples[index]) {
    // The last sample of a closed loop is the first point of the next lap.
    b = samples[index];
  }
  const span = b.arc - a.arc;
  const t = span > 0 ? Math.max(0, Math.min(1, (target - a.arc) / span)) : 0;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const tangent = normalize2(dx, dz, 'course segment at arc ' + target);
  return {
    x: round6(a.x + dx * t),
    z: round6(a.z + dz * t),
    groundY: a.groundY ?? null,
    tx: round6(tangent.x),
    tz: round6(tangent.z)
  };
}

/**
 * A gate/line used by the tracker. `tx/tz` is the increasing-arc tangent, so a
 * forward crossing is a move from negative to non-negative signed distance.
 */
function makeLine({ id, kind, index, arc, x, z, tangent, widthMetres, groundY }) {
  const unit = normalize2(tangent.x, tangent.z, 'gate tangent ' + id);
  return Object.freeze({
    id,
    kind,
    index,
    arc: round6(arc),
    x: round6(x),
    z: round6(z),
    tx: unit.x,
    tz: unit.z,
    widthMetres,
    groundY
  });
}

/**
 * Forward crossing of a declared line. Returns the crossing point or null.
 * A forward crossing goes from behind the line (negative tangent distance) to
 * on/after it, through the declared line width.
 */
export function lineCrossing(previous, current, line, toleranceMetres = 1e-9) {
  if (!Array.isArray(previous) || !Array.isArray(current) || !line) return null;
  const s0 = (previous[0] - line.x) * line.tx + (previous[2] - line.z) * line.tz;
  const s1 = (current[0] - line.x) * line.tx + (current[2] - line.z) * line.tz;
  if (!(s0 < 0 && s1 >= 0)) return null;
  const den = s0 - s1;
  if (Math.abs(den) < 1e-12) return null;
  const u = s0 / den;
  if (!(u >= 0 && u <= 1)) return null;
  const px = previous[0] + (current[0] - previous[0]) * u;
  const pz = previous[2] + (current[2] - previous[2]) * u;
  const lateral = (px - line.x) * -line.tz + (pz - line.z) * line.tx;
  if (Math.abs(lateral) > line.widthMetres / 2 + toleranceMetres) return null;
  const py = previous[1] + ((current[1] ?? previous[1]) - previous[1]) * u;
  return { u, point: [round6(px), round6(py), round6(pz)], lateral: round6(lateral) };
}

export class CourseModel {
  /**
   * @param {object} layout parsed committed e1-drive layout
   * @param {{verifyLayoutHash?: boolean, sectorCount?: number}} options
   */
  constructor(layout, options = {}) {
    if (!layout || typeof layout !== 'object') fail('layout is missing');
    if (!SUPPORTED_KINDS.has(layout.kind)) fail('unsupported layout kind ' + String(layout.kind));
    if (layout.version !== 1) fail('unsupported layout version ' + String(layout.version));
    if (!SUPPORTED_COURSE_IDS.has(layout.courseId)) {
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
    this.layout = layout;
    this.layoutHash = layout.hash;
    this.courseId = layout.courseId;
    this.tickHz = layout.rules?.tickHz ?? 60;
    if (!(this.tickHz > 0)) fail('tickHz must be positive');
    this.countdownTicks = layout.countdown?.ticks ?? 0;

    if (layout.courseId === COURSE_MODE.FREE) {
      this.mode = COURSE_MODE.FREE;
      this.standings = false;
      this.samples = null;
      this.bounds = layout.course.bounds ? { ...layout.course.bounds } : null;
      this.containment = layout.course.containment ? { ...layout.course.containment } : null;
      this.reason = 'free-roam has no race progress metric';
      return;
    }

    const samples = layout.course?.samples;
    if (!Array.isArray(samples) || samples.length < 2) fail('layout has no measured samples');
    for (let index = 1; index < samples.length; index++) {
      if (!(samples[index].arc > samples[index - 1].arc)) {
        fail('sample arcs do not strictly increase at index ' + index);
      }
    }
    this.samples = samples;
    this.standings = true;
    this.mode = layout.courseId === COURSE_MODE.LAP ? COURSE_MODE.LAP : COURSE_MODE.SPRINT;
    this.measuredLengthMetres = samples[samples.length - 1].arc;
    this.closed = this.mode === COURSE_MODE.LAP;

    const gates = layout.gates;
    if (!Array.isArray(gates) || gates.length < 2) fail('layout has no ordered gates');
    if (gates[0].kind !== 'start') fail('the first gate must be the start gate');
    if (gates[gates.length - 1].kind !== 'finish') fail('the last gate must be the finish gate');
    this.gates = gates.map((gate, index) => {
      if (gate.index !== index) fail('gate ' + gate.id + ' has a non-sequential index');
      finite(gate.arc, 'gate arc');
      finite(gate.x, 'gate x');
      finite(gate.z, 'gate z');
      const tangent = gate.tangent
        ? { x: gate.tangent.tx, z: gate.tangent.tz }
        : { x: gate.b[0] - gate.a[0], z: gate.b[1] - gate.a[1] };
      return makeLine({
        id: gate.id,
        kind: gate.kind,
        index,
        arc: gate.arc,
        x: gate.x,
        z: gate.z,
        tangent,
        widthMetres: gate.widthMetres ?? Math.hypot(gate.b[0] - gate.a[0], gate.b[1] - gate.a[1]),
        groundY: gate.height ?? gate.groundY ?? layout.course.spawnGroundY ?? null
      });
    });
    this.startGate = this.gates[0];
    this.finishGate = this.gates[this.gates.length - 1];
    this.corridorHalfWidthMetres = layout.course.corridor?.halfWidthMetres ?? null;
    this.spawnGroundY = layout.course.spawnGroundY ?? null;
    this.respawnRules = Object.freeze({ ...(layout.rules?.respawn ?? {}) });

    if (this.mode === COURSE_MODE.LAP) {
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
      this.finishArc = this.lengthMetres;
      this.lapLine = makeLine({
        id: 'lap-line',
        kind: 'lap',
        index: 0,
        arc: lap.line.arc ?? 0,
        x: lap.line.x,
        z: lap.line.z,
        tangent: lap.line.tangent
          ? { x: lap.line.tangent.tx, z: lap.line.tangent.tz }
          : { x: lap.line.b[0] - lap.line.a[0], z: lap.line.b[1] - lap.line.a[1] },
        widthMetres: lap.line.widthMetres ?? Math.hypot(lap.line.b[0] - lap.line.a[0], lap.line.b[1] - lap.line.a[1]),
        groundY: lap.line.groundY ?? this.spawnGroundY
      });
      const sectorCount = options.sectorCount ?? 4;
      if (!Number.isInteger(sectorCount) || sectorCount < 2) {
        fail('sectorCount must be an integer >= 2');
      }
      this.sectorCount = sectorCount;
      this.sectors = [];
      for (let sector = 1; sector < sectorCount; sector++) {
        const arc = this.lengthMetres * sector / sectorCount;
        const point = positionAtArc(samples, arc, true);
        this.sectors.push(makeLine({
          id: 'sector-' + sector,
          kind: 'sector',
          index: sector,
          arc,
          x: point.x,
          z: point.z,
          tangent: { x: point.tx, z: point.tz },
          widthMetres: 6,
          groundY: point.groundY
        }));
      }
    } else {
      const span = layout.course?.span;
      if (!span || !Number.isFinite(span.finishArc)) fail('sprint layout has no finish arc');
      this.laps = 1;
      this.lengthMetres = span.finishArc - (span.startArc ?? 0);
      this.finishArc = span.finishArc;
      this.sectorCount = 1;
      this.sectors = [];
      this.lapLine = null;
    }
    this.checkpointCount = this.mode === COURSE_MODE.LAP
      ? this.sectors.length
      : this.gates.filter((gate) => gate.kind === 'checkpoint').length;
  }

  /** Interpolated measured point and tangent at an arc. */
  positionAtArc(arc) {
    if (!this.standings) fail('free-roam has no measured course line');
    return positionAtArc(this.samples, arc, this.closed);
  }

  groundAtArc(arc) {
    if (!this.standings) return null;
    return this.samples[nearestSampleIndex(this.samples, arc)].groundY ?? this.spawnGroundY;
  }

  /**
   * Project a reported position onto the measured polyline.
   *
   * `previousArc` provides seam continuity on the closed lap: candidates whose
   * distance is within 2 m of the nearest candidate are compared by wrapped
   * forward delta, so a car crossing the physical start/finish seam keeps the
   * forward branch instead of flipping between arc 0 and arc length.
   *
   * `hintSegment` limits the search to a deterministic window; a full scan is
   * used when the local best is farther than `fallbackDistanceMetres`.
   */
  project(position, options = {}) {
    if (!this.standings) fail('free-roam has no course projection');
    if (!Array.isArray(position) || position.length < 3) fail('position must be [x, y, z]');
    finite(position[0], 'position.x');
    finite(position[1], 'position.y');
    finite(position[2], 'position.z');
    const px = position[0];
    const pz = position[2];
    const segmentCount = this.samples.length - 1;
    const hint = Number.isInteger(options.hintSegment) ? options.hintSegment : null;
    const radius = options.windowSegments ?? 64;
    const fallbackDistanceMetres = options.fallbackDistanceMetres ?? 8;

    const indices = [];
    if (hint === null) {
      for (let index = 0; index < segmentCount; index++) indices.push(index);
    } else if (this.closed) {
      const seen = new Set();
      for (let delta = -radius; delta <= radius; delta++) {
        const index = ((hint + delta) % segmentCount + segmentCount) % segmentCount;
        if (!seen.has(index)) { seen.add(index); indices.push(index); }
      }
    } else {
      for (let index = Math.max(0, hint - radius); index <= Math.min(segmentCount - 1, hint + radius); index++) {
        indices.push(index);
      }
    }

    let candidates = [];
    let minimumDistanceSquared = Infinity;
    for (const index of indices) {
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
      candidates.push({
        distanceSquared,
        arc: a.arc + (b.arc - a.arc) * t,
        segment: index,
        x: round6(x),
        z: round6(z)
      });
      if (distanceSquared < minimumDistanceSquared) minimumDistanceSquared = distanceSquared;
    }

    const minimumDistance = Math.sqrt(minimumDistanceSquared);
    if (hint !== null && minimumDistance > fallbackDistanceMetres) {
      return this.project(position, { ...options, hintSegment: null });
    }

    const near = candidates.filter((candidate) => candidate.distanceSquared <= minimumDistanceSquared + 4);
    const previousArc = Number.isFinite(options.previousArc) ? options.previousArc : null;
    let chosen;
    if (previousArc === null) {
      chosen = near.reduce((best, candidate) =>
        candidate.distanceSquared < best.distanceSquared ? candidate : best);
    } else {
      const scored = near.map((candidate) => {
        const delta = wrapDelta(candidate.arc - previousArc, this.lengthMetres, this.closed);
        return { candidate, delta };
      });
      const forward = scored.filter((entry) => entry.delta > 0.02);
      const sideways = scored.filter((entry) => Math.abs(entry.delta) <= 0.02);
      let pool;
      if (forward.length) {
        pool = forward;
        pool.sort((a, b) => a.delta - b.delta ||
          a.candidate.distanceSquared - b.candidate.distanceSquared ||
          a.candidate.segment - b.candidate.segment);
      } else if (sideways.length) {
        pool = sideways;
        pool.sort((a, b) => a.candidate.distanceSquared - b.candidate.distanceSquared ||
          a.candidate.segment - b.candidate.segment);
      } else {
        pool = scored.slice();
        pool.sort((a, b) => b.delta - a.delta ||
          a.candidate.distanceSquared - b.candidate.distanceSquared ||
          a.candidate.segment - b.candidate.segment);
      }
      chosen = pool[0].candidate;
    }

    return {
      arc: round6(chosen.arc),
      lateral: round6(Math.sqrt(chosen.distanceSquared)),
      segment: chosen.segment,
      point: [chosen.x, position[1], chosen.z],
      groundY: this.groundAtArc(chosen.arc)
    };
  }

  /** Forward crossing of any gate in the layout, in gate order. */
  crossing(previousPosition, position, line) {
    return lineCrossing(previousPosition, position, line);
  }

  /** Expected retail respawn target: last passed checkpoint, or the lap line. */
  respawnTarget({ mode, checkpointIndex = 0, gateIndex = 0 } = {}) {
    if (this.mode === COURSE_MODE.LAP) {
      return {
        gateId: 'lap-line',
        gateIndex: 0,
        arc: 0,
        x: this.lapLine.x,
        y: this.lapLine.groundY,
        z: this.lapLine.z,
        headingRad: Math.atan2(this.lapLine.tz, this.lapLine.tx)
      };
    }
    const index = Math.max(0, Math.min(this.gates.length - 1,
      mode === 'sprint' ? (checkpointIndex ?? 0) : (gateIndex ?? 0)));
    const gate = this.gates[index];
    return {
      gateId: gate.id,
      gateIndex: gate.index,
      arc: gate.arc,
      x: gate.x,
      y: gate.groundY,
      z: gate.z,
      headingRad: Math.atan2(gate.tz, gate.tx)
    };
  }

  toJSON() {
    return {
      courseId: this.courseId,
      mode: this.mode,
      standings: this.standings,
      layoutHash: this.layoutHash,
      tickHz: this.tickHz,
      countdownTicks: this.countdownTicks,
      laps: this.laps ?? null,
      lengthMetres: this.lengthMetres ?? null,
      finishArc: this.finishArc ?? null,
      measuredLengthMetres: this.measuredLengthMetres ?? null,
      corridorHalfWidthMetres: this.corridorHalfWidthMetres ?? null,
      checkpointsPerLap: this.mode === COURSE_MODE.LAP ? this.sectorCount : this.checkpointCount,
      sectors: this.sectors.map((sector) => ({
        id: sector.id, arc: sector.arc, x: sector.x, z: sector.z,
        tx: sector.tx, tz: sector.tz, widthMetres: sector.widthMetres
      })),
      lapLine: this.lapLine ? {
        arc: this.lapLine.arc, x: this.lapLine.x, z: this.lapLine.z,
        tx: this.lapLine.tx, tz: this.lapLine.tz, widthMetres: this.lapLine.widthMetres
      } : null,
      gates: this.gates.map((gate) => ({
        id: gate.id, kind: gate.kind, index: gate.index, arc: gate.arc,
        x: gate.x, z: gate.z, tx: gate.tx, tz: gate.tz, widthMetres: gate.widthMetres
      }))
    };
  }
}

export function loadCourse(layout, options = {}) {
  return new CourseModel(layout, options);
}
