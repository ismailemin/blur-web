// Sprint rules for the E1 drive slice: countdown, timer, ordered checkpoints,
// finish and respawn.
//
// These rules are presentation and bookkeeping only. They never call into the
// engine and never change a physics value: they read the state the engine
// reports, count ticks, test gate crossings and decide what the *driver* is
// allowed to ask for (zero input during the countdown, brake after the finish).
// tools/verify_e1_drive.mjs proves that by recording the exact input sequence a
// scripted sprint applies and replaying it into a fresh module: every per-tick
// state hash must be identical.
//
// Two course shapes are supported by the same state machine:
//
//   * path courses (`layout.course.samples`) — the default 310 m P48 course.
//     Progress and the off-course test use the nearest point on the measured
//     polyline, the fall rule uses the measured ground at the car's arc, and
//     every gate is an arbitrary segment perpendicular to the path.
//   * the straight 29 m regression course (`layout.course.band`) — progress and
//     the off-course test use x against the spawn corridor, exactly as P37.
//
// Everything is a function of the tick sequence and the committed layout, never
// of wall-clock time, so two runs produce identical events and times.

import { TICK_HZ } from './drive-script.js';

export const SPRINT_PHASE = Object.freeze({
  COUNTDOWN: 'countdown',
  RUNNING: 'running',
  FINISHED: 'finished'
});

export const SPRINT_EVENT = Object.freeze({
  GO: 'go',
  CHECKPOINT: 'checkpoint',
  LAP: 'lap',
  FINISH: 'finish',
  GATE_OUT_OF_ORDER: 'gate-out-of-order',
  FINISH_BLOCKED: 'finish-blocked',
  RESPAWN: 'respawn'
});

const round6 = (value) => Math.round(value * 1e6) / 1e6;

/** Signed side of the gate line A->B for a point (positive = before the gate). */
function gateSide(gate, point) {
  const ax = gate.a[0], az = gate.a[1];
  const bx = gate.b[0], bz = gate.b[1];
  return (bx - ax) * (point[2] - az) - (bz - az) * (point[0] - ax);
}

/**
 * Does the segment prev -> current cross this gate line through the gate span?
 * Returns the crossing point and the fraction along the motion, or null.
 *
 * Gate points are ordered A -> B (for this layout: from low z to high z), which
 * makes the positive side the side the car approaches from. A crossing from the
 * negative to the positive side is a reverse crossing and is not counted.
 */
export function gateCrossing(previousPosition, position, gate) {
  if (!Array.isArray(previousPosition) || !Array.isArray(position)) return null;
  const s0 = gateSide(gate, previousPosition);
  const s1 = gateSide(gate, position);
  if (!(s0 > 0 && s1 <= 0)) return null;
  const px = previousPosition[0], pz = previousPosition[2];
  const rx = position[0] - px, rz = position[2] - pz;
  const ax = gate.a[0], az = gate.a[1];
  const sx = gate.b[0] - ax, sz = gate.b[1] - az;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = ax - px, qz = az - pz;
  const along = (qx * sz - qz * sx) / den;
  const across = (qx * rz - qz * rx) / den;
  if (along < 0 || along > 1 || across < -1e-9 || across > 1 + 1e-9) return null;
  return {
    point: [round6(px + rx * along), round6(previousPosition[1] + (position[1] - previousPosition[1]) * along),
      round6(pz + rz * along)],
    along,
    across
  };
}

/**
 * Nearest point on the measured course polyline: arc length, lateral distance
 * and the segment index. Pure geometry over the committed layout samples.
 */
export function coursePosition(samples, position) {
  if (!Array.isArray(samples) || samples.length < 2) throw new Error('course has no polyline');
  const px = position[0];
  const pz = position[2];
  let best = null;
  for (let index = 0; index < samples.length - 1; index++) {
    const a = samples[index];
    const b = samples[index + 1];
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const lengthSquared = vx * vx + vz * vz;
    let t = 0;
    if (lengthSquared > 0) {
      t = ((px - a.x) * vx + (pz - a.z) * vz) / lengthSquared;
      if (t < 0) t = 0; else if (t > 1) t = 1;
    }
    const dx = a.x + vx * t - px;
    const dz = a.z + vz * t - pz;
    const distanceSquared = dx * dx + dz * dz;
    if (best === null || distanceSquared < best.distanceSquared - 1e-12) {
      best = {
        distanceSquared,
        distance: Math.sqrt(distanceSquared),
        arc: round6(a.arc + (b.arc - a.arc) * t),
        segment: index,
        point: [round6(a.x + vx * t), round6(a.z + vz * t)]
      };
    }
  }
  return { distance: best.distance, arc: best.arc, segment: best.segment, point: best.point };
}

/** Measured off-course band half-width at an arc. */
export function bandHalfWidthAt(layout, arc) {
  const corridor = layout.course.corridor;
  if (corridor?.rows?.length) {
    let best = corridor.rows[0];
    for (const row of corridor.rows) {
      if (Math.abs(row.arc - arc) < Math.abs(best.arc - arc)) best = row;
    }
    return best.bandHalfWidthMetres ?? corridor.halfWidthMetres;
  }
  if (corridor?.halfWidthMetres) return corridor.halfWidthMetres;
  return layout.course.band?.halfWidthMetres ?? 3;
}

/** Measured course ground height at an arc (nearest measured sample). */
export function courseGroundAt(layout, arc) {
  const samples = layout.course.samples;
  if (!Array.isArray(samples) || samples.length === 0) return layout.course.spawnGroundY;
  let best = samples[0];
  for (const sample of samples) {
    if (Math.abs(sample.arc - arc) < Math.abs(best.arc - arc)) best = sample;
  }
  return best.groundY ?? layout.course.spawnGroundY;
}

/** True when the layout is a path course (the default 310 m course). */
export function isPathLayout(layout) {
  return Array.isArray(layout?.course?.samples) && layout.course.samples.length >= 2;
}

/** True for the P61 three-lap loop course. */
export function isLapLayout(layout) {
  return layout?.courseId === 'lap';
}

/** Why a position is off the measured course, or null when it is on it. */
export function outsideCourseReason(position, layout) {
  const span = layout.course.span;
  const respawn = layout.rules.respawn;
  if (isLapLayout(layout)) {
    const course = coursePosition(layout.course.samples, position);
    const halfWidth = bandHalfWidthAt(layout, course.arc);
    if (course.distance > halfWidth + respawn.outsideBandMarginMetres) {
      return { reason: 'outside-corridor', arc: course.arc, lateral: round6(course.distance), halfWidth };
    }
    return null;
  }
  if (isPathLayout(layout)) {
    const course = coursePosition(layout.course.samples, position);
    if (course.arc < span.startArc - respawn.overshootMarginMetres) {
      return { reason: 'behind-start', arc: course.arc, lateral: course.distance };
    }
    if (course.arc > span.finishArc + respawn.overshootMarginMetres) {
      return { reason: 'past-finish-line', arc: course.arc, lateral: course.distance };
    }
    const halfWidth = bandHalfWidthAt(layout, course.arc);
    if (course.distance > halfWidth + respawn.outsideBandMarginMetres) {
      return { reason: 'outside-corridor', arc: course.arc, lateral: round6(course.distance), halfWidth };
    }
    return null;
  }
  const band = layout.course.band;
  const x = position[0];
  const z = position[2];
  if (x < span.startX - respawn.overshootMarginMetres) return 'behind-start';
  if (x > span.finishX + respawn.overshootMarginMetres) return 'past-finish-line';
  if (Math.abs(z - band.z) > band.halfWidthMetres + respawn.outsideBandMarginMetres) return 'outside-gate-band';
  return null;
}

export class SprintRules {
  constructor(layout, options = {}) {
    if (!layout?.gates || !layout?.course || !layout?.rules) {
      throw new Error('sprint rules need the derived layout');
    }
    const total = layout.gates.length;
    if (layout.gates[total - 1].kind !== 'finish' || layout.gates[0].kind !== 'start') {
      throw new Error('sprint layout must start with the start gate and end with the finish gate');
    }
    this.layout = layout;
    this.options = options;
    this.reset();
  }

  /** Back to the start line: countdown, no timer, no checkpoints, best kept outside. */
  reset() {
    this.phase = SPRINT_PHASE.COUNTDOWN;
    this.countdownTicks = this.layout.countdown.ticks;
    this.elapsedTicks = 0;
    this.gateIndex = 1; // gate 0 is the start line the car is standing on
    this.passedGates = [{ id: 'start', index: 0, tick: 0, timeSeconds: 0, position: null, arc: 0 }];
    this.finishTimeSeconds = null;
    this.finishTick = null;
    this.finishPosition = null;
    this.respawns = 0;
    this.respawnLog = [];
    this.events = [];
    this.contactTicks = 0;
    this.nanTicks = 0;
    this.respawnTicks = 0;
    this.airborneTicks = 0;
    this.closed = false;
    this.maxX = this.layout.course.span.startX ?? this.layout.course.span.startArc;
    this.maxArc = this.layout.course.span.startArc ?? 0;
    this.arc = this.maxArc;
    this.lateral = 0;
    this.maxLateral = 0;
    this.prevState = null;
    this.awaitingRejoin = false;
    this.lastEvent = null;
  }

  /** Observe the settled tick 0 without advancing the countdown. */
  prime(state) {
    if (!state) throw new Error('sprint rules need a state');
    this.prevState = state;
    this.awaitingRejoin = false;
    this.observe(state);
  }

  /** Continue after an engine rebuild (respawn): keep progress, reset the motion history. */
  rejoin(state) {
    if (this.phase === SPRINT_PHASE.FINISHED) return;
    this.prevState = state;
    this.awaitingRejoin = false;
    this.airborneTicks = 0;
    this.observe(state);
  }

  observe(state) {
    if (state.finite !== 1) this.nanTicks++;
    if (state.anyContact === 1) { this.contactTicks++; this.airborneTicks = 0; }
    else this.airborneTicks++;
    if (Array.isArray(state.position) && Number.isFinite(state.position[0]) && Number.isFinite(state.position[2])) {
      if (state.position[0] > this.maxX) this.maxX = state.position[0];
      if (isPathLayout(this.layout)) {
        const course = coursePosition(this.layout.course.samples, state.position);
        this.arc = course.arc;
        this.lateral = course.distance;
        if (course.distance > this.maxLateral) this.maxLateral = course.distance;
        if (course.arc > this.maxArc) this.maxArc = course.arc;
      }
    }
  }

  /** Input the rules allow (the driver asks; the rules gate, physics does not change). */
  gateInput(input) {
    if (this.phase === SPRINT_PHASE.COUNTDOWN) return [0, 0, 0, 0];
    if (this.phase === SPRINT_PHASE.FINISHED) return [0, 1, 0, 0];
    return input.slice();
  }

  /**
   * Advance the rules by the engine step that produced `state`. Returns the
   * events of this tick (empty most ticks).
   */
  step(state) {
    if (!state) throw new Error('sprint rules need a state');
    const events = [];
    const seconds = (ticks) => round6(ticks / TICK_HZ);
    this.observe(state);

    if (this.phase === SPRINT_PHASE.COUNTDOWN) {
      this.countdownTicks = Math.max(0, this.countdownTicks - 1);
      if (this.countdownTicks === 0) {
        this.phase = SPRINT_PHASE.RUNNING;
        events.push({ type: SPRINT_EVENT.GO, tick: state.tick, timeSeconds: 0 });
      }
    } else if (this.phase === SPRINT_PHASE.RUNNING) {
      this.elapsedTicks++;
      if (this.prevState && !this.awaitingRejoin) {
        for (const gate of this.layout.gates) {
          if (gate.index < this.gateIndex) continue;
          const crossing = gateCrossing(this.prevState.position, state.position, gate);
          if (!crossing) continue;
          if (gate.kind === 'finish' && gate.index !== this.gateIndex) {
            events.push({
              type: SPRINT_EVENT.FINISH_BLOCKED,
              tick: state.tick,
              timeSeconds: seconds(this.elapsedTicks),
              gateId: gate.id,
              reasons: ['checkpoints-missing'],
              expectedIndex: this.gateIndex,
              position: crossing.point
            });
            continue;
          }
          if (gate.index > this.gateIndex) {
            events.push({
              type: SPRINT_EVENT.GATE_OUT_OF_ORDER,
              tick: state.tick,
              timeSeconds: seconds(this.elapsedTicks),
              gateId: gate.id,
              gateIndex: gate.index,
              expectedIndex: this.gateIndex,
              position: crossing.point
            });
            continue;
          }
          if (gate.kind === 'checkpoint') {
            this.gateIndex++;
            const record = {
              id: gate.id,
              index: gate.index,
              tick: state.tick,
              timeSeconds: seconds(this.elapsedTicks),
              position: crossing.point,
              arc: gate.arc ?? null
            };
            this.passedGates.push(record);
            events.push({ type: SPRINT_EVENT.CHECKPOINT, ...record });
          } else if (gate.kind === 'finish') {
            if (this.gateIndex !== gate.index) {
              events.push({
                type: SPRINT_EVENT.FINISH_BLOCKED,
                tick: state.tick,
                timeSeconds: seconds(this.elapsedTicks),
                gateId: gate.id,
                reasons: ['checkpoints-missing'],
                expectedIndex: this.gateIndex,
                position: crossing.point
              });
              continue;
            }
            this.gateIndex++;
            this.passedGates.push({
              id: gate.id, index: gate.index, tick: state.tick,
              timeSeconds: seconds(this.elapsedTicks), position: crossing.point, arc: gate.arc ?? null
            });
            this.phase = SPRINT_PHASE.FINISHED;
            this.finishTimeSeconds = seconds(this.elapsedTicks);
            this.finishTick = state.tick;
            this.finishPosition = crossing.point;
            events.push({
              type: SPRINT_EVENT.FINISH,
              tick: state.tick,
              timeSeconds: this.finishTimeSeconds,
              gateId: gate.id,
              arc: gate.arc ?? null,
              checkpoints: this.passedGates.filter((entry) => entry.index > 0 && entry.index < gate.index).length,
              position: crossing.point
            });
          }
        }
        const reason = this.phase === SPRINT_PHASE.RUNNING ? this.respawnReason(state) : null;
        if (reason) {
          this.respawns++;
          const target = this.respawnTarget();
          this.airborneTicks = 0;
          this.respawnTicks++;
          this.awaitingRejoin = true;
          const record = {
            type: SPRINT_EVENT.RESPAWN,
            tick: state.tick,
            timeSeconds: seconds(this.elapsedTicks),
            reasons: reason.reasons,
            position: state.position.slice(),
            target: { x: target.x, z: target.z, heading: target.heading, gateId: target.gateId, gateIndex: target.gateIndex }
          };
          this.respawnLog.push(record);
          events.push(record);
        }
      }
    }

    this.prevState = state;
    this.events = events;
    if (events.length) this.lastEvent = events[events.length - 1];
    return events;
  }

  respawnReason(state) {
    const respawn = this.layout.rules.respawn;
    const reasons = [];
    // The fall rule is relative to the measured ground at the car's arc on a path
    // course (the 310 m course rises/falls along its length), and to the spawn
    // ground on the straight regression course.
    const localGround = isPathLayout(this.layout)
      ? courseGroundAt(this.layout, this.arc)
      : this.layout.course.spawnGroundY;
    if (Number.isFinite(state.position?.[1]) &&
        state.position[1] < localGround - respawn.fallBelowGroundMetres) {
      reasons.push('below-ground');
    }
    if (this.airborneTicks >= respawn.airborneTicks) reasons.push('airborne');
    const outside = outsideCourseReason(state.position ?? [0, 0, 0], this.layout);
    if (outside) reasons.push(typeof outside === 'string' ? outside : outside.reason);
    return reasons.length ? { reasons } : null;
  }

  /** Where a respawn puts the car: the last passed checkpoint (or the start line). */
  respawnTarget() {
    const gate = this.layout.gates[Math.max(0, this.gateIndex - 1)];
    return {
      x: gate.x,
      z: gate.z,
      heading: gate.headingRad ?? this.layout.course.spawn.headingRad,
      gateId: gate.id,
      gateIndex: gate.index
    };
  }

  get totalCheckpoints() {
    return this.layout.gates.filter((gate) => gate.kind === 'checkpoint').length;
  }

  get checkpointsPassed() {
    return this.passedGates.filter((gate) => gate.index > 0 && this.layout.gates[gate.index]?.kind === 'checkpoint').length;
  }

  get elapsedSeconds() {
    return round6(this.elapsedTicks / TICK_HZ);
  }

  get nextGate() {
    return this.layout.gates[this.gateIndex] ?? null;
  }

  /** Plain snapshot for the HUD, the harness probe and the evidence files. */
  snapshot(state = this.prevState) {
    const span = this.layout.course.span;
    const path = isPathLayout(this.layout);
    const progress = path
      ? Math.max(0, Math.min(1, (this.maxArc - span.startArc) / (span.finishArc - span.startArc)))
      : Math.max(0, Math.min(1, (this.maxX - span.startX) / (span.finishX - span.startX)));
    const nextGate = this.nextGate;
    return {
      phase: this.phase,
      countdownTicks: this.countdownTicks,
      countdownLabel: this.phase === SPRINT_PHASE.COUNTDOWN
        ? (this.countdownTicks > this.layout.countdown.stepTicks * 2 ? this.layout.countdown.labels[0]
          : this.countdownTicks > this.layout.countdown.stepTicks ? this.layout.countdown.labels[1]
            : this.layout.countdown.labels[2])
        : (this.phase === SPRINT_PHASE.RUNNING ? this.layout.countdown.goLabel : null),
      elapsedTicks: this.elapsedTicks,
      elapsedSeconds: this.elapsedSeconds,
      finished: this.phase === SPRINT_PHASE.FINISHED,
      finishTimeSeconds: this.finishTimeSeconds,
      finishTick: this.finishTick,
      finishPosition: this.finishPosition,
      checkpointsPassed: this.checkpointsPassed,
      totalCheckpoints: this.totalCheckpoints,
      nextGate: nextGate ? {
        id: nextGate.id,
        kind: nextGate.kind,
        index: nextGate.index,
        x: nextGate.x,
        arc: nextGate.arc ?? null,
        distanceMetres: path
          ? round6(Math.max(0, (nextGate.arc ?? span.finishArc) - this.arc))
          : (state ? round6(nextGate.x - state.position[0]) : null)
      } : null,
      passedGates: this.passedGates.map((gate) => ({ ...gate })),
      progress: round6(progress),
      maxX: round6(this.maxX),
      maxArc: round6(this.maxArc),
      arc: round6(this.arc),
      lateralMetres: round6(this.lateral),
      maxLateralMetres: round6(this.maxLateral),
      respawns: this.respawns,
      respawnLog: this.respawnLog.map((entry) => ({ ...entry })),
      contactTicks: this.contactTicks,
      nanTicks: this.nanTicks,
      offCourseTicks: this.respawnTicks,
      lastEvent: this.lastEvent ? { ...this.lastEvent } : null,
      layoutHash: this.layout.hash,
      courseId: this.layout.courseId ?? null,
      course: path ? {
        startArc: span.startArc,
        finishArc: span.finishArc,
        lengthMetres: span.lengthMetres,
        measuredLengthMetres: span.measuredLengthMetres,
        bandHalfWidthMetres: bandHalfWidthAt(this.layout, this.arc)
      } : {
        startX: span.startX,
        finishX: span.finishX,
        lengthMetres: span.lengthMetres,
        bandHalfWidthMetres: this.layout.course.band.halfWidthMetres
      }
    };
  }
}

/**
 * Three-lap rules for the P61 loop course. It has the same public surface as
 * SprintRules (reset/prime/rejoin/step/gateInput/snapshot/respawnTarget), but the
 * lap line is one physical line crossed three times: each forward crossing after
 * at least half a lap completes the current lap, records its race-clock time and
 * starts the next one. The timer is the engine tick clock and never resets on a
 * respawn; a respawn puts the car back on the last lap line.
 */
export class LapRules {
  constructor(layout, options = {}) {
    if (!isLapLayout(layout) || !layout?.course?.lap || !layout?.gates?.[0]) {
      throw new Error('lap rules need the derived three-lap layout');
    }
    this.layout = layout;
    this.options = options;
    this.reset();
  }

  reset() {
    const lap = this.layout.course.lap;
    this.phase = SPRINT_PHASE.COUNTDOWN;
    this.countdownTicks = this.layout.countdown.ticks;
    this.elapsedTicks = 0;
    this.laps = lap.laps;
    this.length = lap.lengthMetres;
    this.lapIndex = 0;
    this.lapTimes = [];
    this.lapStartSeconds = 0;
    this.lapDistance = 0;
    this.lastArc = null;
    this.finishTimeSeconds = null;
    this.finishTick = null;
    this.finishPosition = null;
    this.lapCrossings = [];
    this.respawns = 0;
    this.respawnLog = [];
    this.events = [];
    this.contactTicks = 0;
    this.nanTicks = 0;
    this.respawnTicks = 0;
    this.airborneTicks = 0;
    this.arc = 0;
    this.maxArc = 0;
    this.lateral = 0;
    this.maxLateral = 0;
    this.maxLateralRunning = 0;
    this.prevState = null;
    this.awaitingRejoin = false;
    this.lastEvent = null;
    // Compatibility surface with SprintRules (the page and tooling read it).
    this.gateIndex = 0;
    this.passedGates = [{ id: 'start', index: 0, tick: 0, timeSeconds: 0, position: null, arc: 0 }];
  }

  prime(state) {
    if (!state) throw new Error('lap rules need a state');
    this.prevState = state;
    this.awaitingRejoin = false;
    this.lastArc = null;
    this.lapDistance = 0;
    this.observe(state);
    // The car is created on the line: the starting arc is 0, never the seam.
    this.lastArc = 0;
  }

  rejoin(state) {
    if (this.phase === SPRINT_PHASE.FINISHED) return;
    this.prevState = state;
    this.awaitingRejoin = false;
    this.airborneTicks = 0;
    // A respawn rebuilds on the last lap line, so progress restarts at that line.
    this.lastArc = 0;
    this.lapDistance = this.lapIndex * this.length;
    this.observe(state);
    this.lastArc = 0;
  }

  observe(state) {
    if (state.finite !== 1) this.nanTicks++;
    if (state.anyContact === 1) { this.contactTicks++; this.airborneTicks = 0; }
    else this.airborneTicks++;
    if (Array.isArray(state.position) && Number.isFinite(state.position[0]) && Number.isFinite(state.position[2])) {
      const course = coursePosition(this.layout.course.samples, state.position);
      this.arc = course.arc;
      this.lateral = course.distance;
      if (course.distance > this.maxLateral) this.maxLateral = course.distance;
      if (this.phase !== SPRINT_PHASE.FINISHED && course.distance > this.maxLateralRunning) {
        this.maxLateralRunning = course.distance;
      }
      if (course.arc > this.maxArc) this.maxArc = course.arc;
      let delta = this.lastArc === null ? 0 : course.arc - this.lastArc;
      // A crossing of the seam is a wrap, not a teleport.
      if (delta < -this.length / 2) delta += this.length;
      else if (delta > this.length / 2) delta -= this.length;
      if (delta > 0 && delta < this.length / 4) this.lapDistance += delta;
      this.lastArc = course.arc;
    }
  }

  gateInput(input) {
    if (this.phase === SPRINT_PHASE.COUNTDOWN) return [0, 0, 0, 0];
    if (this.phase === SPRINT_PHASE.FINISHED) return [0, 1, 0, 0];
    return input.slice();
  }

  step(state) {
    if (!state) throw new Error('lap rules need a state');
    const events = [];
    const seconds = (ticks) => round6(ticks / TICK_HZ);
    this.observe(state);
    const lap = this.layout.course.lap;

    if (this.phase === SPRINT_PHASE.COUNTDOWN) {
      this.countdownTicks = Math.max(0, this.countdownTicks - 1);
      if (this.countdownTicks === 0) {
        this.phase = SPRINT_PHASE.RUNNING;
        events.push({ type: SPRINT_EVENT.GO, tick: state.tick, timeSeconds: 0 });
      }
    } else if (this.phase === SPRINT_PHASE.RUNNING) {
      this.elapsedTicks++;
      if (this.prevState && !this.awaitingRejoin) {
        const crossing = gateCrossing(this.prevState.position, state.position, lap.line);
        // A lap only counts after a full lap of accumulated forward progress. The
        // car starts on the line and a respawn rebuilds on it, so lapDistance is
        // below a lap at both: neither can count. The previous sample's projected
        // arc is deliberately NOT used: at the seam the closed polyline repeats
        // its first point, so a position a few centimetres before the line can
        // project onto the start segment (arc ~0) instead of the end segment
        // (arc ~length), which made later laps depend on where the tick landed.
        if (crossing && this.lapDistance >= (this.lapIndex + 1) * this.length - 2) {
          const lapNumber = this.lapIndex + 1;
          const elapsed = seconds(this.elapsedTicks);
          const lapSeconds = round6(elapsed - this.lapStartSeconds);
          this.lapTimes.push(lapSeconds);
          this.lapCrossings.push({
            lap: lapNumber, tick: state.tick, timeSeconds: elapsed, lapSeconds,
            position: crossing.point
          });
          this.lapStartSeconds = elapsed;
          this.lapIndex++;
          const common = {
            lap: lapNumber,
            laps: this.laps,
            lapSeconds,
            lapTimes: this.lapTimes.slice(),
            bestLapSeconds: Math.min(...this.lapTimes),
            tick: state.tick,
            timeSeconds: elapsed,
            position: crossing.point
          };
          if (this.lapIndex >= this.laps) {
            this.phase = SPRINT_PHASE.FINISHED;
            this.finishTimeSeconds = elapsed;
            this.finishTick = state.tick;
            this.finishPosition = crossing.point;
            events.push({ type: SPRINT_EVENT.FINISH, ...common, checkpoints: this.lapTimes.length });
          } else {
            events.push({ type: SPRINT_EVENT.LAP, ...common });
          }
        }
        const reason = this.phase === SPRINT_PHASE.RUNNING ? this.respawnReason(state) : null;
        if (reason) {
          this.respawns++;
          const target = this.respawnTarget();
          this.airborneTicks = 0;
          this.respawnTicks++;
          this.awaitingRejoin = true;
          // The line is where the car is rebuilt: progress restarts at this lap's line.
          this.lapDistance = this.lapIndex * this.length;
          const record = {
            type: SPRINT_EVENT.RESPAWN,
            tick: state.tick,
            timeSeconds: seconds(this.elapsedTicks),
            reasons: reason.reasons,
            position: state.position.slice(),
            target: { x: target.x, z: target.z, heading: target.heading, gateId: target.gateId, gateIndex: target.gateIndex }
          };
          this.respawnLog.push(record);
          events.push(record);
        }
      }
    }

    this.prevState = state;
    this.events = events;
    if (events.length) this.lastEvent = events[events.length - 1];
    return events;
  }

  respawnReason(state) {
    const respawn = this.layout.rules.respawn;
    const reasons = [];
    const localGround = courseGroundAt(this.layout, this.arc);
    if (Number.isFinite(state.position?.[1]) &&
        state.position[1] < localGround - respawn.fallBelowGroundMetres) {
      reasons.push('below-ground');
    }
    if (this.airborneTicks >= respawn.airborneTicks) reasons.push('airborne');
    const outside = outsideCourseReason(state.position ?? [0, 0, 0], this.layout);
    if (outside) reasons.push(typeof outside === 'string' ? outside : outside.reason);
    return reasons.length ? { reasons } : null;
  }

  /** The last lap line: the start/finish point and its measured tangent heading. */
  respawnTarget() {
    const line = this.layout.course.lap.line;
    return { x: line.x, z: line.z, heading: line.headingRad, gateId: 'lap-line', gateIndex: 0 };
  }

  get totalCheckpoints() {
    return this.laps;
  }

  get checkpointsPassed() {
    return this.lapTimes.length;
  }

  get elapsedSeconds() {
    return round6(this.elapsedTicks / TICK_HZ);
  }

  get nextGate() {
    return this.layout.gates[1] ?? null;
  }

  snapshot(state = this.prevState) {
    const lap = this.layout.course.lap;
    const currentLapArc = Math.max(0, Math.min(this.length,
      this.lapDistance - this.lapIndex * this.length));
    // A finished race is 100 % complete even if the last projected metre is a
    // fraction short of the geometric lap length: the finish event is the
    // authority, and the HUD must not read 99.99 % on the results screen.
    const progress = this.phase === SPRINT_PHASE.FINISHED
      ? 1
      : Math.max(0, Math.min(1, this.lapDistance / (this.laps * this.length)));
    return {
      phase: this.phase,
      countdownTicks: this.countdownTicks,
      countdownLabel: this.phase === SPRINT_PHASE.COUNTDOWN
        ? (this.countdownTicks > this.layout.countdown.stepTicks * 2 ? this.layout.countdown.labels[0]
          : this.countdownTicks > this.layout.countdown.stepTicks ? this.layout.countdown.labels[1]
            : this.layout.countdown.labels[2])
        : (this.phase === SPRINT_PHASE.RUNNING ? this.layout.countdown.goLabel : null),
      elapsedTicks: this.elapsedTicks,
      elapsedSeconds: this.elapsedSeconds,
      finished: this.phase === SPRINT_PHASE.FINISHED,
      finishTimeSeconds: this.finishTimeSeconds,
      finishTick: this.finishTick,
      finishPosition: this.finishPosition,
      checkpointsPassed: this.lapTimes.length,
      totalCheckpoints: this.laps,
      lap: this.lapIndex + 1,
      lapIndex: this.lapIndex,
      laps: this.laps,
      lapTimes: this.lapTimes.slice(),
      bestLapSeconds: this.lapTimes.length ? Math.min(...this.lapTimes) : null,
      lastLapSeconds: this.lapTimes.length ? this.lapTimes[this.lapTimes.length - 1] : null,
      currentLapSeconds: round6(this.elapsedSeconds - this.lapStartSeconds),
      currentLapArcMetres: round6(currentLapArc),
      lapRuntime: {
        lapIndex: this.lapIndex,
        lapDistance: round6(this.lapDistance),
        lastArc: this.lastArc === null ? null : round6(this.lastArc),
        lapCrossings: this.lapCrossings.length,
        maxLateral: round6(this.maxLateral)
      },
      nextGate: this.phase === SPRINT_PHASE.FINISHED ? null : {
        id: 'lap-line',
        kind: 'finish',
        index: 1,
        x: lap.line.x,
        arc: this.length,
        distanceMetres: round6(Math.max(0, this.length - currentLapArc))
      },
      passedGates: this.lapCrossings.map((crossing) => ({ ...crossing })),
      progress: round6(progress),
      maxX: this.prevState?.position?.[0] ?? 0,
      maxArc: round6(this.maxArc),
      arc: round6(this.arc),
      lateralMetres: round6(this.lateral),
      maxLateralMetres: round6(this.maxLateral),
      maxLateralRunningMetres: round6(this.maxLateralRunning),
      respawns: this.respawns,
      respawnLog: this.respawnLog.map((entry) => ({ ...entry })),
      contactTicks: this.contactTicks,
      nanTicks: this.nanTicks,
      offCourseTicks: this.respawnTicks,
      lastEvent: this.lastEvent ? { ...this.lastEvent } : null,
      layoutHash: this.layout.hash,
      courseId: this.layout.courseId ?? null,
      course: {
        startArc: 0,
        finishArc: this.length,
        lengthMetres: this.length,
        measuredLengthMetres: lap.lengthMetres,
        bandHalfWidthMetres: lap.bandHalfWidthMetres,
        laps: this.laps,
        currentLap: this.lapIndex + 1
      }
    };
  }
}

export function createSprintRules(layout, options = {}) {
  if (isLapLayout(layout)) return new LapRules(layout, options);
  return new SprintRules(layout, options);
}
