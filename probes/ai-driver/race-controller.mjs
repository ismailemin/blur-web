// Deterministic AI race controller: pure pursuit on the racing line, a speed
// profile from the car's own XT grip data, a typed recovery state and a
// corridor-bounded overtake planner.
//
// The controller is a pure function of
//   * the current engine state (position, axisZ, angular[1], velocity, input),
//   * the precomputed racing line (see `./racing-line.mjs`),
//   * the caller-supplied opponent list,
//   * its own typed state machine (which is itself a deterministic function of
//     the state sequence).
//
// It returns exactly the four-channel input the existing drive path accepts:
//   [throttle, brake, steer, handbrake]
//
// Race progress (gates, laps, finish, respawn reasons) is *not* re-implemented:
// the controller embeds one `AiDriver` observer from `./ai-driver.mjs` and
// forwards `observe()` to it, so the AI uses exactly the committed, verified
// rules observer and the comparison against the previous AI is like for like.
//
// No clock, no `Math.random`, no `Date`, no `performance.now`.

import {
  createAiDriver, skillProfile, SKILL_PROFILES, MEASURED_MAP_IDS, hashOf
} from './ai-driver.mjs';

export const RACER_KIND = 'blur.ai-racer';
export const RACER_VERSION = 1;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

const wrapAngle = (value) => {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
};

const round6 = (value) => Math.round(value * 1e6) / 1e6;

// ---------------------------------------------------------------------------
// Controller parameter tables.
//
// `lookaheadBase`/`lookaheadPerSpeed` are pure-pursuit geometry: the look-ahead
// distance grows with speed (a fixed look-ahead would either cut corners at low
// speed or oscillate at high speed). `steerLimitRad` is the car's own XT
// `steering.steerLimit`, so the normalised steer request maps to a real front
// wheel angle. `steerRatePerTick` is the same 0.08/tick the committed follower
// uses: a driver cannot move lock to lock inside one 60 Hz tick.
// ---------------------------------------------------------------------------

export const RACER_CONTROL = Object.freeze({
  default: Object.freeze({
    lookaheadBaseMetres: 4.0,
    lookaheadPerSpeedSeconds: 0.45,
    lookaheadMinMetres: 4.0,
    lookaheadMaxMetres: 20.0,
    steerAnglePerInput: 0.26,
    steerRatePerTick: 0.08,
    yawDamping: 0.28,
    throttleDeadband: 0.35,
    brakeGain: 1.7,
    brakeMinSpeedError: 0.25,
    speedLookaheadSeconds: 0.12,
    stuckSpeedMetresPerSecond: 0.9,
    stuckTicks: 48,
    reverseTicks: 40,
    reverseSteerGain: 0.9,
    recoveryTimeoutTicks: 420,
    overtake: Object.freeze({
      enabled: true,
      detectAheadMetres: 26,
      detectBehindMetres: 2.5,
      minSpeedAdvantageMetresPerSecond: 0.8,
      clearanceMetres: 2.276,
      commitMetres: 6,
      abortGapMetres: 1.2,
      blendMetresPerSecond: 2.6
    })
  }),
  lap: Object.freeze({
    lookaheadBaseMetres: 3.0,
    lookaheadPerSpeedSeconds: 0.32,
    lookaheadMinMetres: 3.0,
    lookaheadMaxMetres: 13.0,
    steerAnglePerInput: 0.26,
    steerRatePerTick: 0.08,
    yawDamping: 0.3,
    throttleDeadband: 0.35,
    brakeGain: 1.7,
    brakeMinSpeedError: 0.25,
    speedLookaheadSeconds: 0.12,
    stuckSpeedMetresPerSecond: 0.9,
    stuckTicks: 48,
    reverseTicks: 40,
    reverseSteerGain: 0.9,
    recoveryTimeoutTicks: 420,
    overtake: Object.freeze({
      enabled: true,
      detectAheadMetres: 18,
      detectBehindMetres: 2.0,
      minSpeedAdvantageMetresPerSecond: 0.8,
      clearanceMetres: 2.276,
      commitMetres: 5,
      abortGapMetres: 1.2,
      blendMetresPerSecond: 2.2
    })
  }),
  measured: Object.freeze({
    lookaheadBaseMetres: 4.0,
    lookaheadPerSpeedSeconds: 0.45,
    lookaheadMinMetres: 4.0,
    lookaheadMaxMetres: 18.0,
    steerAnglePerInput: 0.26,
    steerRatePerTick: 0.08,
    yawDamping: 0.28,
    throttleDeadband: 0.35,
    brakeGain: 1.7,
    brakeMinSpeedError: 0.25,
    speedLookaheadSeconds: 0.12,
    stuckSpeedMetresPerSecond: 0.9,
    stuckTicks: 48,
    reverseTicks: 40,
    reverseSteerGain: 0.9,
    recoveryTimeoutTicks: 420,
    overtake: Object.freeze({
      enabled: true,
      detectAheadMetres: 26,
      detectBehindMetres: 2.5,
      minSpeedAdvantageMetresPerSecond: 0.8,
      clearanceMetres: 2.276,
      commitMetres: 6,
      abortGapMetres: 1.2,
      blendMetresPerSecond: 2.6
    })
  })
});

export function controlTableFor(courseId) {
  if (courseId === 'lap') return RACER_CONTROL.lap;
  if (MEASURED_MAP_IDS.includes(courseId)) return RACER_CONTROL.measured;
  return RACER_CONTROL.default;
}

/**
 * Skill profiles for the racing AI. The ids and `speedScale` values are the
 * committed `SKILL_PROFILES` from `./ai-driver.mjs`, so a lap time from this
 * controller and a lap time from the previous controller differ only by the
 * driving, never by the profile definition. The racing line is generated at
 * `gripUtilisation` of the car's XT grip, so even `aggressive` (1.10x) stays at
 * 0.935 of the tyre limit.
 */
export const RACER_PROFILES = SKILL_PROFILES;

// ---------------------------------------------------------------------------
// Overtake planner. Pure: given the ego arc/speed and a list of opponents, it
// returns the lateral deviation the controller should fly and the typed reason.
// ---------------------------------------------------------------------------

export function planOvertake({ line, egoArc, egoSpeed, egoOffset, opponents, control, previous }) {
  const settings = control.overtake;
  const state = {
    active: false,
    side: null,
    targetOffsetMetres: previous?.targetOffsetMetres ?? 0,
    opponentId: null,
    gapMetres: null,
    roomLeftMetres: null,
    roomRightMetres: null,
    decision: 'none',
    committed: false
  };
  if (!settings.enabled || !Array.isArray(opponents) || opponents.length === 0) {
    state.decision = 'disabled';
    return state;
  }
  const length = line.length;
  let best = null;
  for (const opponent of opponents) {
    if (opponent?.role === 'ego') continue;
    if (!Number.isFinite(opponent.arc) || !Number.isFinite(opponent.speed)) continue;
    let gap = opponent.arc - egoArc;
    if (line.closed) {
      gap = ((gap % length) + length) % length;
      if (gap > length / 2) gap -= length;
    }
    if (gap < -settings.detectBehindMetres || gap > settings.detectAheadMetres) continue;
    const advantage = egoSpeed - opponent.speed;
    if (advantage < settings.minSpeedAdvantageMetresPerSecond) continue;
    if (gap <= settings.abortGapMetres) continue;
    if (best === null || gap < best.gap) best = { opponent, gap, advantage };
  }
  if (!best) {
    state.decision = 'no-target';
    return state;
  }

  const { opponent, gap } = best;
  const halfWidth = line.halfWidthAt(opponent.arc);
  const opponentOffset = Number.isFinite(opponent.offset) ? opponent.offset : 0;
  const clearance = settings.clearanceMetres;
  // Offset is positive to the left of the line's own travel direction.
  const roomLeft = halfWidth - (opponentOffset + clearance);
  const roomRight = (opponentOffset - clearance) + halfWidth;
  const fits = Math.max(roomLeft, roomRight) >= 0;
  state.opponentId = opponent.id ?? null;
  state.gapMetres = round6(gap);
  state.roomLeftMetres = round6(roomLeft);
  state.roomRightMetres = round6(roomRight);
  state.committed = previous?.committed === true;
  if (!fits) {
    state.decision = 'blocked';
    return state;
  }
  const side = roomLeft >= roomRight ? 'left' : 'right';
  const target = side === 'left'
    ? clamp(opponentOffset + clearance, -halfWidth, halfWidth)
    : clamp(opponentOffset - clearance, -halfWidth, halfWidth);
  state.active = true;
  state.side = side;
  state.targetOffsetMetres = round6(target);
  state.decision = state.committed ? 'execute' : 'plan';
  // Commit once the gap is inside the execution window so the side cannot
  // flicker tick by tick.
  if (gap <= settings.commitMetres) state.committed = true;
  void egoOffset;
  return state;
}

// ---------------------------------------------------------------------------
// Race controller.
// ---------------------------------------------------------------------------

export class AiRacer {
  /**
   * @param {object} args
   * @param {object} args.layout    committed layout (progress rules)
   * @param {object} args.line      `buildRacingLine()` document
   * @param {object} args.physics   `deriveCarPhysics()` result
   * @param {string|object} [args.profile] skill profile id or object
   * @param {object} [args.control] control-table override (diagnostics only)
   */
  constructor({ layout, line, physics, profile = 'reference', control = null }) {
    if (!layout) throw new Error('layout is required');
    if (!line) throw new Error('racing line is required');
    if (!physics) throw new Error('car physics is required');
    this.layout = layout;
    this.line = line;
    this.physics = physics;
    this.profile = skillProfile(profile);
    this.control = control ?? controlTableFor(layout.courseId);
    // The committed, verified race observer owns gate/lap/finish/respawn.
    this.observer = createAiDriver({ layout, profile: this.profile.id });
    this.primed = false;
    this.mode = 'racing';
    this.stuck = { active: false, phase: 'none', ticks: 0, reason: null, since: null };
    this.slowTicks = 0;
    this.recoverTicks = 0;
    this.overtake = {
      active: false, side: null, targetOffsetMetres: 0, opponentId: null,
      gapMetres: null, decision: 'none', committed: false, aborted: 0, executed: 0,
      passed: 0
    };
    this.overtakeDeviation = 0;
    this.lastTerms = null;
    this.metrics = {
      ticks: 0,
      maxLateralMetres: 0,
      maxTrackingErrorMetres: 0,
      maxSpeed: 0,
      minSpeed: 0,
      recoveries: 0,
      overtakes: 0,
      aborts: 0,
      contactTicks: 0,
      minOpponentSeparationMetres: null
    };
  }

  get finished() { return this.observer.finished; }
  get finish() { return this.observer.finish; }
  get lapTimes() { return this.observer.lapTimes; }
  get checkpointsPassed() { return this.observer.checkpointsPassed; }
  get projection() { return this.observer.projection; }
  get track() { return this.observer.track; }

  prime(state) {
    this.observer.prime(state);
    this.primed = true;
    this.mode = 'racing';
    this.slowTicks = 0;
    this.recoverTicks = 0;
    this.overtakeDeviation = 0;
    return this.observer.projection;
  }

  reprime(state) {
    this.observer.reprime(state);
    this.mode = 'racing';
    this.slowTicks = 0;
    this.recoverTicks = 0;
    this.overtakeDeviation = 0;
    this.stuck = { active: false, phase: 'none', ticks: 0, reason: null, since: null };
  }

  /** Signed ground speed along the car's own forward axis (reverse is negative). */
  signedSpeed(state) {
    const velocity = state.velocity;
    if (!Array.isArray(velocity)) return state.speed ?? 0;
    const heading = Math.atan2(state.axisZ[0], state.axisZ[2]);
    return velocity[0] * Math.sin(heading) + velocity[2] * Math.cos(heading);
  }

  /** Compute the input for this tick. */
  step(state, { opponents = [], raceTick = 0 } = {}) {
    if (!this.primed) this.prime(state);
    if (this.observer.finished) {
      this.lastTerms = { input: [0, 1, 0, 0], mode: 'finished', finished: true };
      return this.lastTerms;
    }
    const control = this.control;
    const scale = this.profile.speedScale;
    const speed = state.speed ?? 0;
    const signed = this.signedSpeed(state);
    const carHeading = Math.atan2(state.axisZ[0], state.axisZ[2]);
    const yawRate = state.angular?.[1] ?? 0;
    const previousSteer = Number.isFinite(state.input?.[2]) ? state.input[2] : 0;

    // Shared projection: the same TrackModel the race observer uses, so the
    // controller and the rules layer always agree on arc and lateral distance.
    const projection = this.observer.track.project(state.position);
    const arc = projection.arc;

    this.slowTicks = speed < control.stuckSpeedMetresPerSecond ? this.slowTicks + 1 : 0;

    let input;
    let terms;
    if (this.mode === 'recover') {
      ({ input, terms } = this._recoveryStep({
        state, arc, carHeading, signed, previousSteer, raceTick
      }));
    } else {
      if (this.slowTicks >= control.stuckTicks) {
        this.mode = 'recover';
        this.recoverTicks = 0;
        this.stuck = {
          active: true, phase: 'reverse', ticks: 0, since: raceTick,
          reason: 'no-progress'
        };
        this.metrics.recoveries += 1;
        ({ input, terms } = this._recoveryStep({
          state, arc, carHeading, signed, previousSteer, raceTick
        }));
      } else {
        ({ input, terms } = this._racingStep({
          state, arc, carHeading, yawRate, previousSteer, speed, signed,
          scale, opponents, raceTick
        }));
      }
    }

    this.metrics.ticks += 1;
    this.metrics.maxSpeed = Math.max(this.metrics.maxSpeed, speed);
    this.metrics.minSpeed = this.metrics.ticks === 1 ? speed : Math.min(this.metrics.minSpeed, speed);
    this.metrics.maxLateralMetres = Math.max(this.metrics.maxLateralMetres, projection.distance);
    const trackingError = Math.abs(projection.distance - this.line.indexAt(projection.arc).offset);
    this.metrics.maxTrackingErrorMetres = Math.max(
      this.metrics.maxTrackingErrorMetres ?? 0, trackingError);
    const contacts = Array.isArray(state.contacts) ? state.contacts : [];
    if (contacts.length && contacts.every((value) => !value)) this.metrics.contactTicks += 1;

    this.lastTerms = terms;
    return terms;
  }

  _racingStep({ arc, carHeading, yawRate, previousSteer, speed, scale, opponents, state }) {
    const control = this.control;
    const line = this.line;

    // ---- overtaking ------------------------------------------------------
    let deviation = 0;
    if (control.overtake.enabled && opponents.length) {
      const egoOffset = line.indexAt(arc).offset;
      const plan = planOvertake({
        line, egoArc: arc, egoSpeed: speed, egoOffset, opponents,
        control, previous: this.overtake
      });
      const requested = plan.active ? plan.targetOffsetMetres - egoOffset : 0;
      const maxStep = control.overtake.blendMetresPerSecond / 60;
      const delta = clamp(requested - this.overtakeDeviation, -maxStep, maxStep);
      const width = line.halfWidthAt(arc);
      this.overtakeDeviation = clamp(this.overtakeDeviation + delta,
        -width - egoOffset, width - egoOffset);
      if (plan.active && !this.overtake.active) {
        this.overtake.executed += 1;
        this.metrics.overtakes += 1;
      }
      if (!plan.active && this.overtake.active) {
        this.overtake.aborted += 1;
        this.metrics.aborts += 1;
      }
      this.overtake = { ...plan, aborted: this.overtake.aborted,
        executed: this.overtake.executed, passed: this.overtake.passed };
      deviation = this.overtakeDeviation;
    } else {
      this.overtakeDeviation = 0;
      this.overtake = { ...this.overtake, active: false, decision: 'no-opponent',
        gapMetres: null, side: null };
    }

    // ---- steering: pure pursuit on the racing line -----------------------
    const lookahead = clamp(
      control.lookaheadBaseMetres + control.lookaheadPerSpeedSeconds * speed,
      control.lookaheadMinMetres, control.lookaheadMaxMetres);
    const target = line.indexAt(arc + lookahead);
    const normal = this._normalAt(arc);
    const targetX = target.x + deviation * normal.x;
    const targetZ = target.z + deviation * normal.z;
    const alpha = wrapAngle(Math.atan2(targetX - state.position[0], targetZ - state.position[2]) - carHeading);
    // Pure-pursuit curvature, then the engine's steering request. The retail
    // wheel angle that a normalised request actually produces is set by the
    // steering spring and the tyre resistance (`car.cpp` steer spring), not by
    // `steering.steerLimit` alone; the open-loop engine measurement in
    // `docs/work/analysis/ai-racing-line.md` puts it at ~0.26 rad per unit
    // request at racing speed. That gain is a controller calibration, not a
    // physics value.
    const curvature = 2 * Math.sin(alpha) / Math.max(0.5, lookahead);
    // Never ask for a curvature the tyres cannot deliver: the XT lateral limit
    // divided by v^2 is the friction-circle curvature bound. Without this cap a
    // large tracking error winds the steering up into a slide.
    const gripCurvature = this.physics.lateralAccelLimitMps2 /
      Math.max(4, state.speed * state.speed);
    const commanded = clamp(curvature, -gripCurvature, gripCurvature);
    const steerAngle = Math.atan(commanded * this.physics.wheelBaseMetres);
    const steerLimit = this._steerLimitRad();
    const desired = clamp(steerAngle / control.steerAnglePerInput, -1, 1) -
      control.yawDamping * yawRate;
    const steer = clamp(desired, previousSteer - control.steerRatePerTick,
      previousSteer + control.steerRatePerTick);

    // ---- longitudinal: follow the speed profile --------------------------
    const speedLookahead = Math.max(1, speed * control.speedLookaheadSeconds);
    const targetSpeed = line.indexAt(arc + speedLookahead).targetSpeed * scale;
    const error = targetSpeed - speed;
    let throttle;
    let brake;
    if (error > control.throttleDeadband) {
      throttle = 1;
      brake = 0;
    } else if (error > -control.brakeMinSpeedError) {
      throttle = clamp(0.5 + error / (control.throttleDeadband * 2), 0, 1);
      brake = 0;
    } else {
      throttle = 0;
      brake = clamp(control.brakeGain * (-error) / 4, 0, 1);
    }
    // Do not keep the throttle pinned while the car is off the ground: the
    // measured 310 m course has crests where a car at 35 m/s+ goes light.
    const contacts = Array.isArray(state.contacts) ? state.contacts : [1, 1, 1, 1];
    const wheelsDown = contacts.reduce((sum, value) => sum + (value ? 1 : 0), 0);
    if (wheelsDown < 4) throttle = Math.min(throttle, wheelsDown === 0 ? 0 : 0.35);

    const terms = {
      input: [throttle, brake, steer, 0],
      mode: 'racing',
      arc: round6(arc),
      lateral: round6(this.observer.projection?.distance ?? 0),
      lookahead: round6(lookahead),
      targetSpeed: round6(targetSpeed),
      speed,
      throttle: round6(throttle),
      brake: round6(brake),
      steer: round6(steer),
      alpha: round6(alpha),
      curvature: round6(curvature),
      overtake: this.overtake.active ? {
        side: this.overtake.side, gapMetres: this.overtake.gapMetres,
        targetOffsetMetres: this.overtake.targetOffsetMetres, deviation: round6(deviation)
      } : null
    };
    return { input: terms.input, terms };
  }

  _recoveryStep({ state, carHeading, signed, previousSteer, raceTick }) {
    const control = this.control;
    this.recoverTicks += 1;
    this.stuck.active = true;
    this.stuck.ticks = this.recoverTicks;

    if (this.stuck.phase === 'reverse') {
      // Hold the brake with no throttle: the retail `AutoReverse` path engages
      // reverse when brake > 0.1 and throttle < 0.1 at low speed (car.cpp:778),
      // so this reverses the car without a separate reverse channel existing in
      // the four-channel input.
      const steer = clamp(-previousSteer * 0.5, -1, 1);
      if (this.recoverTicks >= control.reverseTicks || signed < -3.0) {
        this.stuck.phase = 'realign';
      }
      const terms = {
        input: [0, 1, steer, 0],
        mode: 'recover', stuckPhase: 'reverse', arc: 0,
        throttle: 0, brake: 1, steer: round6(steer)
      };
      return { input: terms.input, terms };
    }

    // Realign: drive forward and steer back onto the line.
    const projection = this.observer.track.project(state.position);
    const lookahead = clamp(control.lookaheadBaseMetres, 3, 8);
    const target = this.line.indexAt(projection.arc + lookahead);
    const alpha = wrapAngle(Math.atan2(target.x - state.position[0], target.z - state.position[2]) - carHeading);
    const steer = clamp(alpha * control.reverseSteerGain, -1, 1);
    const done = this.recoverTicks > control.recoveryTimeoutTicks ||
      (signed > 3.0 && Math.abs(alpha) < 0.35 && projection.distance < 1.5);
    if (signed > 3.0) this.stuck.phase = 'rejoin';
    if (done) {
      this.mode = 'racing';
      this.slowTicks = 0;
      this.stuck = {
        active: false, phase: 'done', ticks: this.recoverTicks,
        reason: this.stuck.reason, since: this.stuck.since
      };
    }
    const throttle = signed > 1.5 ? 0.55 : 1;
    const terms = {
      input: [throttle, 0, steer, 0],
      mode: 'recover', stuckPhase: this.stuck.phase, arc: round6(projection.arc),
      throttle, brake: 0, steer: round6(steer)
    };
    void raceTick;
    return { input: terms.input, terms };
  }

  _normalAt(arc) {
    const point = this.line.indexAt(arc);
    const ahead = this.line.indexAt(arc + 0.5);
    const behind = this.line.indexAt(arc - 0.5);
    let tx = ahead.x - behind.x;
    let tz = ahead.z - behind.z;
    const length = Math.hypot(tx, tz);
    if (!(length > 1e-9)) { tx = Math.sin(0); tz = 1; }
    tx /= length;
    tz /= length;
    void point;
    return { x: -tz, z: tx };
  }

  _steerLimitRad() {
    const limit = this.physics?.steerLimitRad;
    return Number.isFinite(limit) && limit > 0.05 ? limit : 1.0;
  }

  observe(state, raceTick) {
    return this.observer.observe(state, raceTick);
  }

  snapshot() {
    return {
      kind: RACER_KIND,
      version: RACER_VERSION,
      courseId: this.layout.courseId,
      lineHash: this.line.document.hash,
      profile: this.profile,
      mode: this.mode,
      stuck: { ...this.stuck },
      overtake: { ...this.overtake },
      metrics: {
        ...this.metrics,
        maxLateralMetres: round6(this.metrics.maxLateralMetres),
        maxTrackingErrorMetres: round6(this.metrics.maxTrackingErrorMetres),
        maxSpeed: round6(this.metrics.maxSpeed),
        minSpeed: round6(this.metrics.minSpeed)
      },
      observer: this.observer.snapshot(),
      lastTerms: this.lastTerms
    };
  }
}

export function createAiRacer(options) {
  return new AiRacer(options);
}

export { hashOf };
