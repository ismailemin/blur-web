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

/** Why a position is off the measured course, or null when it is on it. */
export function outsideCourseReason(position, layout) {
  const span = layout.course.span;
  const band = layout.course.band;
  const respawn = layout.rules.respawn;
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
    this.passedGates = [{ id: 'start', index: 0, tick: 0, timeSeconds: 0, position: null }];
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
    this.maxX = this.layout.course.span.startX;
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
    if (Number.isFinite(state.position?.[0]) && state.position[0] > this.maxX) this.maxX = state.position[0];
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
              position: crossing.point
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
              timeSeconds: seconds(this.elapsedTicks), position: crossing.point
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
    if (Number.isFinite(state.position?.[1]) &&
        state.position[1] < this.layout.course.spawnGroundY - respawn.fallBelowGroundMetres) {
      reasons.push('below-ground');
    }
    if (this.airborneTicks >= respawn.airborneTicks) reasons.push('airborne');
    const outside = outsideCourseReason(state.position ?? [0, 0, 0], this.layout);
    if (outside) reasons.push(outside);
    return reasons.length ? { reasons } : null;
  }

  /** Where a respawn puts the car: the last passed checkpoint (or the start line). */
  respawnTarget() {
    const gate = this.layout.gates[Math.max(0, this.gateIndex - 1)];
    return {
      x: gate.x,
      z: gate.z,
      heading: this.layout.course.spawn.headingRad,
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
    const progress = Math.max(0, Math.min(1, (this.maxX - span.startX) / (span.finishX - span.startX)));
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
        distanceMetres: state ? round6(nextGate.x - state.position[0]) : null
      } : null,
      passedGates: this.passedGates.map((gate) => ({ ...gate })),
      progress: round6(progress),
      maxX: round6(this.maxX),
      respawns: this.respawns,
      respawnLog: this.respawnLog.map((entry) => ({ ...entry })),
      contactTicks: this.contactTicks,
      nanTicks: this.nanTicks,
      offCourseTicks: this.respawnTicks,
      lastEvent: this.lastEvent ? { ...this.lastEvent } : null,
      layoutHash: this.layout.hash,
      course: {
        startX: span.startX,
        finishX: span.finishX,
        lengthMetres: span.lengthMetres,
        bandHalfWidthMetres: this.layout.course.band.halfWidthMetres
      }
    };
  }
}

export function createSprintRules(layout, options = {}) {
  return new SprintRules(layout, options);
}
