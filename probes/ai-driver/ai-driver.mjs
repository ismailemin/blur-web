// Deterministic AI opponent driver for the Blur Web drive slice.
//
// The driver is a pure function of the committed course layout and the engine
// state (plus its own deterministic race observer). It never reads a wall
// clock, `Math.random`, `Date.now`, `performance.now` or the wasm engine; the
// only clock is the integer race tick supplied by the caller. It returns the
// same four-channel input the human/scripted path returns:
//
//   [throttle, brake, steer, handbrake]
//
// Three course families are supported by the same code:
//
//   * 310 m sprint (`courseId: "310m"`): Stanley heading + lateral control on
//     the measured P48 centre line, with a curvature speed target over the
//     braking distance, the measured off-course band cap, the launch guard and
//     the finish slowdown / post-finish brake policy.
//   * loop-01 three-lap race (`courseId: "lap"`): pure pursuit on a short,
//     speed-scaled lookahead (the loop's ~10 m hairpins saturate the Stanley
//     lateral term at low speed), three forward crossings of the start/finish
//     line, then the post-finish brake.
//   * measured point-to-point map paths (`courseId` in `MEASURED_MAP_IDS`:
//     amboy, gracia, longbeach, observatory, downtown, mharuna, dumbo,
//     downtown-mp): the committed M3 `AMBOY_CONTROL` policy (12 m/s cruise,
//     short pure pursuit, 2.5 m/s^2 lateral acceleration, 10 m/s finish cap).
//     The maps' declared 6 m band is a rule/respawn band, not a road width, so
//     it is not used as a narrower speed cap.
//
// The controller constants are the committed e1-drive follower constants
// (`probes/e1-drive/web/sprint-script.js`, read-only reference). The skill
// profiles only scale the speed target; they do not change physics, grip,
// engine torque or the steering authority. A profile that cannot hold the
// declared band is reported as a failure, not hidden.
//
// The module has no dependency on e1-drive code: it only consumes the committed
// layout JSON (`_work/e1-drive/sprint.json`, `_work/e1-drive/sprint-lap.json`)
// and the engine state JSON.

import { createHash } from 'node:crypto';

export const DRIVER_KIND = 'blur.ai-driver';
export const DRIVER_VERSION = 1;

/**
 * Course ids that are measured point-to-point map paths and therefore use the
 * committed `MAP_CONTROL` policy. The set is explicit: a map must be listed
 * here together with its committed layout, it is never inferred from a string
 * prefix or a missing control table.
 */
export const MEASURED_MAP_IDS = Object.freeze([
  'amboy', 'gracia', 'longbeach', 'observatory', 'downtown', 'mharuna',
  'dumbo', 'downtown-mp'
]);

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

const wrapAngle = (value) => {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
};

const round6 = (value) => Math.round(value * 1e6) / 1e6;

// ---------------------------------------------------------------------------
// Controller constants (metres, m/s, seconds). These are the committed
// e1-drive follower constants for the two course families; the only difference
// between the AI profiles is `speedScale`.
// ---------------------------------------------------------------------------

export const SPRINT_CONTROL = Object.freeze({
  cruiseSpeed: 24,
  headingLookahead: 10,
  steerGain: 3.0,
  steerRatePerTick: 0.08,
  speedSteerCeiling: 3,
  lateralGain: 2.0,
  yawDamping: 0.8,
  narrowBandMetres: 6,
  narrowSpeed: 7,
  minSpeed: 6,
  launchHeadingError: 0.5,
  launchSpeed: 6,
  launchArcMetres: 15,
  brakeGain: 0.55,
  throttleDeadband: 0.6,
  anticipationSeconds: 1.8,
  anticipationMetres: 22,
  lateralAccel: 4.0,
  finishSpeed: 13,
  finishSlowdownMetres: 18
});

// Measured point-to-point M3 map paths (usa_amboy 2,060.595 m and
// spa_barcelona_gracia 624.914 m). These are the committed e1-drive
// `AMBOY_CONTROL` constants (probes/e1-drive/web/sprint-script.js, read-only
// reference), not recovered vehicle or map values. The two maps share one
// policy because the committed scripted follower does the same.
export const MAP_CONTROL = Object.freeze({
  cruiseSpeed: 12,
  headingLookahead: 10,
  steerGain: 3.0,
  steerRatePerTick: 0.08,
  speedSteerCeiling: 3,
  lateralGain: 2.0,
  yawDamping: 0.8,
  narrowBandMetres: 6,
  narrowSpeed: 7,
  minSpeed: 5,
  launchHeadingError: 0.5,
  launchSpeed: 5,
  launchArcMetres: 15,
  brakeGain: 0.55,
  throttleDeadband: 0.6,
  anticipationSeconds: 1.8,
  anticipationMetres: 25,
  lateralAccel: 2.5,
  finishSpeed: 10,
  finishSlowdownMetres: 18,
  purePursuit: true,
  lapPurePursuit: false,
  lapLookaheadBase: 3,
  lapLookaheadSpeed: 0.25,
  lapLookaheadMax: 6
});

export const LAP_CONTROL = Object.freeze({
  cruiseSpeed: 10,
  headingLookahead: 8,
  steerGain: 4.0,
  steerRatePerTick: 0.08,
  speedSteerCeiling: 3,
  lateralGain: 2.0,
  yawDamping: 0.8,
  narrowBandMetres: 0,
  narrowSpeed: 7,
  minSpeed: 5,
  launchHeadingError: 0.5,
  launchSpeed: 6,
  launchArcMetres: 15,
  brakeGain: 0.55,
  throttleDeadband: 0.6,
  anticipationSeconds: 1.8,
  anticipationMetres: 25,
  lateralAccel: 1.5,
  finishSpeed: 13,
  finishSlowdownMetres: 0,
  lapPurePursuit: true,
  lapLookaheadBase: 2.5,
  lapLookaheadSpeed: 0.3,
  lapLookaheadMax: 7
});

export const CONTROL_TABLES = Object.freeze({ sprint: SPRINT_CONTROL, lap: LAP_CONTROL });

/**
 * Speed-only skill profiles. `speedScale` multiplies every longitudinal target
 * (cruise, curvature, narrow-band, launch, finish) and the declared minimum
 * speed. Steering authority, brake gain, physics and the layout are untouched.
 *
 * `reference` is the committed follower's own speed target and is the profile
 * used for the 5-car comparison against `_work/e1-drive/sprint-*.json` and
 * `_work/e1-drive/sprint-lap-*.json`.
 */
export const SKILL_PROFILES = Object.freeze([
  Object.freeze({
    id: 'cautious',
    speedScale: 0.85,
    status: 'supported',
    description: '85% of the reference speed target; slower corner entry, same physics and steering'
  }),
  Object.freeze({
    id: 'standard',
    speedScale: 0.95,
    status: 'supported',
    description: '95% of the reference speed target'
  }),
  Object.freeze({
    id: 'reference',
    speedScale: 1.0,
    status: 'reference',
    description: 'the committed e1-drive follower target; the baseline for the times already recorded'
  }),
  Object.freeze({
    id: 'aggressive',
    speedScale: 1.1,
    status: 'experimental',
    description: '110% of the reference target; expected to exceed the declared band on the loop and is reported if it does'
  })
]);

export function skillProfile(idOrProfile) {
  if (idOrProfile && typeof idOrProfile === 'object') {
    const speedScale = Number(idOrProfile.speedScale);
    if (!Number.isFinite(speedScale) || speedScale <= 0) {
      throw new Error('skill profile speedScale must be a positive finite number');
    }
    return Object.freeze({
      id: String(idOrProfile.id ?? 'custom'),
      speedScale,
      status: String(idOrProfile.status ?? 'custom'),
      description: String(idOrProfile.description ?? 'custom speed scale')
    });
  }
  const found = SKILL_PROFILES.find((profile) => profile.id === idOrProfile);
  if (!found) throw new Error(`unknown skill profile ${JSON.stringify(idOrProfile)}`);
  return found;
}

// ---------------------------------------------------------------------------
// Layout geometry. The samples are the committed measured centre line; no
// geometry is re-derived. Projection is warm-started around the previous
// sample index, which keeps a 7,200-tick lap run cheap while remaining a pure
// function of the state sequence (the hint is itself deterministic).
// ---------------------------------------------------------------------------

function sampleAtArc(samples, arc) {
  if (arc <= samples[0].arc) return samples[0];
  const last = samples[samples.length - 1];
  if (arc >= last.arc) return last;
  let low = 0;
  let high = samples.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (samples[middle].arc <= arc) low = middle; else high = middle;
  }
  const a = samples[low];
  const b = samples[high];
  const span = b.arc - a.arc;
  const t = span > 0 ? (arc - a.arc) / span : 0;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, arc, groundY: a.groundY };
}

const wrapArc = (arc, length) => {
  let value = arc % length;
  if (value < 0) value += length;
  return value;
};

class TrackModel {
  constructor(layout) {
    if (!layout || typeof layout !== 'object') throw new Error('layout is required');
    const samples = layout.course?.samples;
    if (!Array.isArray(samples) || samples.length < 2) throw new Error('layout has no measured sample polyline');
    this.layout = layout;
    this.samples = samples;
    this.lap = layout.courseId === 'lap';
    this.measuredPath = MEASURED_MAP_IDS.includes(layout.courseId);
    this.laps = layout.course?.span?.laps ?? layout.course?.laps ?? 1;
    this.length = layout.course?.span?.finishArc ?? layout.course?.finishArc ??
      samples[samples.length - 1].arc;
    this.finishArc = layout.course?.finishArc ?? this.length;
    this.corridorHalfWidth = layout.course?.corridor?.halfWidthMetres ??
      layout.course?.band?.halfWidthMetres ?? 3;
    this.respawnRules = layout.rules?.respawn ?? {};
    this.countdownTicks = layout.countdown?.ticks ?? 0;
    this.gates = Array.isArray(layout.gates) ? layout.gates : [];
    this.startGate = this.gates.find((gate) => gate.id === 'start') ?? this.gates[0] ?? null;
    this.finishGate = this.gates.find((gate) => gate.id === 'finish') ??
      this.gates[this.gates.length - 1] ?? null;
    this.checkpointGates = this.gates.filter((gate) => gate.kind === 'checkpoint');
    this.hint = null;
    this.lastArc = 0;
  }

  reset() {
    this.hint = null;
    this.lastArc = 0;
  }

  /** Nearest point on the measured polyline, unwrapped for the closed loop. */
  project(position) {
    const px = position[0];
    const pz = position[2];
    const n = this.samples.length;
    const lastSegment = n - 2;
    let best = null;

    const consider = (index) => {
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
      const dx = a.x + vx * t - px;
      const dz = a.z + vz * t - pz;
      const distanceSquared = dx * dx + dz * dz;
      if (best === null || distanceSquared < best.distanceSquared - 1e-12) {
        best = {
          distanceSquared,
          distance: Math.sqrt(distanceSquared),
          arc: a.arc + (b.arc - a.arc) * t,
          segment: index,
          x: a.x + vx * t,
          z: a.z + vz * t
        };
      }
    };

    if (this.hint === null || !Number.isInteger(this.hint)) {
      for (let index = 0; index <= lastSegment; index++) consider(index);
    } else if (this.lap) {
      // Search a window around the previous segment, wrapping across the seam.
      const span = 48;
      for (let offset = -span; offset <= span; offset++) {
        const index = ((this.hint + offset) % lastSegment + lastSegment) % lastSegment;
        consider(index);
      }
    } else {
      const span = 48;
      const low = Math.max(0, this.hint - span);
      const high = Math.min(lastSegment, this.hint + span);
      for (let index = low; index <= high; index++) consider(index);
    }

    if (this.lap) {
      // Keep the arc continuous across the seam: the closed polyline repeats
      // its first point, so a position a few centimetres before the line can
      // project onto arc ~0 or arc ~length. Choose the branch nearest the
      // previous unwrapped arc.
      while (best.arc - this.lastArc > this.length / 2) best.arc -= this.length;
      while (this.lastArc - best.arc > this.length / 2) best.arc += this.length;
      best.arc = round6(best.arc);
    }

    this.hint = best.segment;
    this.lastArc = best.arc;

    const tangentHeading = this.headingAt(best.arc, 2);
    const tangentX = Math.sin(tangentHeading);
    const tangentZ = Math.cos(tangentHeading);
    const offsetX = px - best.x;
    const offsetZ = pz - best.z;
    // Same sign convention as the committed follower: for a signed lateral
    // offset L, a positive L needs a positive heading correction.
    best.lateral = round6(tangentX * offsetZ - tangentZ * offsetX);
    best.tangentHeading = tangentHeading;
    best.distance = round6(best.distance);
    best.arc = round6(best.arc);
    return best;
  }

  pointAt(arc) {
    if (this.lap) return sampleAtArc(this.samples, wrapArc(arc, this.length));
    return sampleAtArc(this.samples, Math.min(this.finishArc, arc));
  }

  headingAt(arc, windowMetres = 12) {
    if (this.lap) {
      const a = this.pointAt(arc - windowMetres / 2);
      const b = this.pointAt(arc + windowMetres / 2);
      return Math.atan2(b.x - a.x, b.z - a.z);
    }
    const a = sampleAtArc(this.samples,
      Math.max(this.samples[0].arc, Math.min(this.finishArc, arc) - windowMetres / 2));
    const b = sampleAtArc(this.samples,
      Math.min(this.samples[this.samples.length - 1].arc,
        Math.min(this.finishArc, arc) + windowMetres / 2));
    return Math.atan2(b.x - a.x, b.z - a.z);
  }

  groundAt(arc) {
    return this.pointAt(arc).groundY ?? this.layout.course.spawnGroundY ?? 0;
  }
}

// ---------------------------------------------------------------------------
// AI driver. `step` returns the input for this tick; `observe` consumes the
// post-step engine state and returns deterministic race events.
// ---------------------------------------------------------------------------

export class AiDriver {
  constructor({ layout, profile = 'reference', finishLaps = null, controlOverrides = null,
    controlTable = null } = {}) {
    this.layout = layout;
    this.track = new TrackModel(layout);
    this.profile = skillProfile(profile);
    const defaultControl = this.track.lap ? LAP_CONTROL
      : this.track.measuredPath ? MAP_CONTROL : SPRINT_CONTROL;
    // `controlTable` selects another committed control table for a diagnostic
    // anchor (for example the sprint follower that produced a committed map
    // run). It replaces the default table; it never changes physics.
    const baseControl = controlTable ?? defaultControl;
    // `controlOverrides` exists for tuning diagnostics only. With no override the
    // driver uses the committed control table unchanged.
    this.control = controlOverrides
      ? Object.freeze({ ...baseControl, ...controlOverrides })
      : baseControl;
    this.finishLaps = finishLaps ?? this.track.laps;
    this.primed = false;
    this.finished = false;
    this.checkpointsPassed = 0;
    this.lapsCompleted = 0;
    this.forwardTravel = 0;
    this.lapStartTick = 0;
    this.lapTimes = [];
    this.prevPosition = null;
    this.projection = null;
    this.lastTerms = null;
    this.airborneTicks = 0;
    this.finish = null;
    this.events = [];
  }

  /** Prime the observer at the created start pose. Does not advance race state. */
  prime(state) {
    this.track.reset();
    this.projection = this.track.project(state.position);
    this.prevPosition = state.position.slice();
    this.primed = true;
    this.airborneTicks = 0;
    return this.projection;
  }

  /** Re-prime after a deterministic respawn rebuild (progress is retained). */
  reprime(state) {
    this.track.reset();
    this.projection = this.track.project(state.position);
    this.prevPosition = state.position.slice();
    this.track.lastArc = this.projection.arc;
    this.airborneTicks = 0;
  }

  /**
   * Controller terms for one state. Pure function of `state`, the layout and
   * the previous input carried in `state.input` (the engine's last applied
   * input), so the call can be replayed without controller memory.
   */
  controlTerms(state) {
    const control = this.control;
    const lap = this.track.lap;
    const scale = this.profile.speedScale;
    const position = state.position;
    const speed = state.speed ?? 0;
    const course = this.track.project(position);
    this.projection = course;
    const arc = course.arc;

    const scanDistance = lap
      ? control.anticipationMetres + speed * control.anticipationSeconds
      : Math.max(0, Math.min(this.track.finishArc,
        arc + control.anticipationMetres + speed * control.anticipationSeconds) - arc);
    let narrowestBand = this.track.corridorHalfWidth;
    // The sprint layout declares one constant band. The loop keeps its own
    // declared respawn band out of the speed target (the physical flat band is
    // 11.75 m and the ±1.25 m is a rule, not a lane).
    let curvatureSpeed = control.cruiseSpeed;
    const headingStart = this.track.headingAt(arc);
    for (let offset = 2; offset <= Math.min(scanDistance, 30); offset += 2) {
      const turn = Math.abs(wrapAngle(this.track.headingAt(arc + offset) - headingStart));
      const distance = Math.max(2, offset);
      const radius = distance / Math.max(1e-3, turn);
      curvatureSpeed = Math.min(curvatureSpeed, Math.sqrt(control.lateralAccel * radius));
    }
    let speedTarget = Math.min(control.cruiseSpeed, curvatureSpeed);
    if (!lap && narrowestBand < control.narrowBandMetres) {
      speedTarget = Math.min(speedTarget,
        control.narrowSpeed * clamp(narrowestBand / control.narrowBandMetres, 0.7, 1));
    }
    speedTarget = Math.max(control.minSpeed, speedTarget);
    speedTarget *= scale;

    const carHeading = Math.atan2(state.axisZ[0], state.axisZ[2]);
    const launchError = Math.abs(wrapAngle(this.track.headingAt(arc) - carHeading));
    if (arc < control.launchArcMetres && launchError > control.launchHeadingError) {
      speedTarget = Math.min(speedTarget, control.launchSpeed * scale);
    }

    if (!lap && arc > this.track.finishArc - control.finishSlowdownMetres) {
      speedTarget = Math.min(speedTarget, control.finishSpeed * scale);
    }

    const yawRate = state.angular?.[1] ?? 0;
    const previousSteer = Number.isFinite(state.input?.[2]) ? state.input[2] : 0;
    const nearest = course;
    const tangentHeading = course.tangentHeading;
    const tangentX = Math.sin(tangentHeading);
    const tangentZ = Math.cos(tangentHeading);
    const offsetX = position[0] - nearest.x;
    const offsetZ = position[2] - nearest.z;
    const lateral = tangentX * offsetZ - tangentZ * offsetX;
    let headingError;
    let lateralTerm = 0;
    let desired;
    let lookaheadMetres = 0;
    if ((lap && control.lapPurePursuit) || control.purePursuit) {
      lookaheadMetres = clamp(
        control.lapLookaheadBase + control.lapLookaheadSpeed * speed,
        control.lapLookaheadBase, control.lapLookaheadMax);
      const target = this.track.pointAt(arc + lookaheadMetres);
      const targetHeading = Math.atan2(target.x - position[0], target.z - position[2]);
      headingError = wrapAngle(targetHeading - carHeading);
      desired = clamp(control.steerGain * headingError - control.yawDamping * yawRate, -1, 1);
    } else {
      const lookaheadHeading = this.track.headingAt(arc + control.headingLookahead);
      headingError = wrapAngle(lookaheadHeading - carHeading);
      lateralTerm = Math.atan(control.lateralGain * lateral / Math.max(2, speed));
      const speedFactor = clamp(speed / 6, 1, control.speedSteerCeiling);
      desired = clamp(control.steerGain * speedFactor * headingError + lateralTerm -
        control.yawDamping * yawRate, -1, 1);
    }
    const speedFactor = clamp(speed / 6, 1, control.speedSteerCeiling);
    const steer = clamp(desired, previousSteer - control.steerRatePerTick,
      previousSteer + control.steerRatePerTick);

    let throttle = 1;
    let brake = 0;
    if (speed > speedTarget + control.throttleDeadband) {
      throttle = 0;
      brake = clamp(control.brakeGain * (speed - speedTarget), 0, 1);
    } else if (speed > speedTarget) {
      throttle = clamp(1 - (speed - speedTarget), 0, 1);
    }

    return {
      input: [throttle, brake, steer, 0],
      arc,
      lateral: course.distance,
      speedTarget,
      curvatureSpeed: curvatureSpeed * scale,
      narrowestBand,
      scanDistance,
      carHeading,
      headingError,
      lateralTerm,
      yawRate,
      speedFactor,
      desired,
      previousSteer,
      steer,
      throttle,
      brake,
      lookaheadMetres
    };
  }

  /** Input for the next engine step. `state` is the current engine snapshot. */
  step(state) {
    if (!this.primed) this.prime(state);
    if (this.finished) {
      const terms = {
        input: [0, 1, 0, 0],
        finished: true,
        arc: this.projection?.arc ?? 0,
        speedTarget: 0,
        throttle: 0,
        brake: 1,
        steer: 0
      };
      this.lastTerms = terms;
      return terms;
    }
    // Evaluate the pure controller for this state.
    const terms = this.controlTerms(state);
    this.lastTerms = terms;
    return terms;
  }

  _lineCrossing(previousPosition, position, gate) {
    if (!gate || !Array.isArray(gate.a) || !Array.isArray(gate.b)) return null;
    const side = (point) => (gate.b[0] - gate.a[0]) * (point[2] - gate.a[1]) -
      (gate.b[1] - gate.a[1]) * (point[0] - gate.a[0]);
    const s0 = side(previousPosition);
    const s1 = side(position);
    if (!(s0 > 0 && s1 <= 0)) return null;
    const px = previousPosition[0];
    const pz = previousPosition[2];
    const rx = position[0] - px;
    const rz = position[2] - pz;
    const ax = gate.a[0];
    const az = gate.a[1];
    const sx = gate.b[0] - ax;
    const sz = gate.b[1] - az;
    const denominator = rx * sz - rz * sx;
    if (Math.abs(denominator) < 1e-12) return null;
    const qx = ax - px;
    const qz = az - pz;
    const along = (qx * sz - qz * sx) / denominator;
    const across = (qx * rz - qz * rx) / denominator;
    if (along < 0 || along > 1 || across < -1e-9 || across > 1 + 1e-9) return null;
    return { along: round6(along), across: round6(across) };
  }

  /**
   * Consume the post-step state and return ordered deterministic events:
   * `checkpoint`, `lap`, `finish`, `respawn`. `raceTick` is the integer tick
   * since GO (1 on the first running step), supplied by the caller.
   */
  observe(state, raceTick) {
    const events = [];
    if (!this.primed) this.prime(state);
    const previous = this.prevPosition;
    const previousArc = this.track.lastArc;
    const projection = this.track.project(state.position);
    this.projection = projection;
    const arc = projection.arc;

    if (this.track.lap) {
      // Accumulate forward travel before testing the line so a crossing on the
      // current segment is judged with the same segment's travel.
      const delta = arc - previousArc;
      if (delta > 0) this.forwardTravel += delta;
    }

    if (!this.track.lap) {
      // Sprint: ordered gates; the start is primed, not counted.
      for (const gate of this.track.gates) {
        const crossing = this._lineCrossing(previous, state.position, gate);
        if (!crossing) continue;
        if (gate.kind === 'start') {
          events.push({ type: 'start-crossing', tick: raceTick, gateId: gate.id });
        } else if (gate.kind === 'checkpoint') {
          const expected = this.track.checkpointGates[this.checkpointsPassed];
          if (expected && gate.id === expected.id) {
            this.checkpointsPassed += 1;
            events.push({ type: 'checkpoint', tick: raceTick, gateId: gate.id,
              checkpoint: this.checkpointsPassed });
          } else {
            events.push({ type: 'gate-out-of-order', tick: raceTick, gateId: gate.id });
          }
        } else if (gate.kind === 'finish') {
          if (this.checkpointsPassed >= this.track.checkpointGates.length && !this.finished) {
            this.finished = true;
            this.finish = {
              type: 'finish', tick: raceTick, timeSeconds: round6(raceTick / 60),
              gateId: gate.id, checkpoints: this.checkpointsPassed,
              position: state.position.map(round6), arc: round6(arc)
            };
            events.push(this.finish);
          } else if (!this.finished) {
            events.push({ type: 'finish-blocked', tick: raceTick, gateId: gate.id });
          }
        }
      }
    } else {
      // Loop: one physical line crossed forward three times. The accumulated
      // forward travel guarantees a full lap; the seam branch is already
      // unwrapped by TrackModel.project.
      const gate = this.track.finishGate;
      const crossing = this._lineCrossing(previous, state.position, gate);
      if (crossing && !this.finished) {
        const required = (this.lapsCompleted + 1) * this.track.length - 2;
        if (this.forwardTravel + 1e-9 >= required) {
          this.lapsCompleted += 1;
          const lapTime = round6((raceTick - this.lapStartTick) / 60);
          this.lapTimes.push(lapTime);
          this.lapStartTick = raceTick;
          events.push({
            type: 'lap',
            tick: raceTick, lap: this.lapsCompleted, laps: this.finishLaps,
            lapSeconds: lapTime, lapTimes: this.lapTimes.slice()
          });
          if (this.lapsCompleted >= this.finishLaps) {
            this.finished = true;
            this.finish = {
              type: 'finish', tick: raceTick, timeSeconds: round6(raceTick / 60),
              laps: this.finishLaps, lapTimes: this.lapTimes.slice(),
              bestLapSeconds: Math.min(...this.lapTimes),
              position: state.position.map(round6), arc: round6(arc)
            };
            events.push(this.finish);
          }
        } else {
          events.push({ type: 'short-lap-crossing', tick: raceTick,
            requiredMetres: round6(required), forwardTravel: round6(this.forwardTravel) });
        }
      }
    }

    if (this.track.lap) {
      // TrackModel.project already advanced lastArc to `arc`.
      this.track.lastArc = arc;
    }

    if (!this.finished) {
      const contacts = Array.isArray(state.contacts) ? state.contacts : [0, 0, 0, 0];
      const airborne = contacts.every((contact) => !contact);
      this.airborneTicks = airborne ? this.airborneTicks + 1 : 0;
      const groundY = this.track.groundAt(arc);
      const fall = this.track.respawnRules.fallBelowGroundMetres ?? 1;
      const margin = this.track.respawnRules.outsideBandMarginMetres ?? 0;
      const airborneLimit = this.track.respawnRules.airborneTicks ?? 30;
      const reasons = [];
      if (projection.distance > this.track.corridorHalfWidth + margin) {
        reasons.push({ code: 'outside-corridor', distance: projection.distance,
          allowed: round6(this.track.corridorHalfWidth + margin) });
      }
      if (state.position[1] < groundY - fall) {
        reasons.push({ code: 'below-ground', y: state.position[1],
          groundY: round6(groundY), fall });
      }
      if (this.airborneTicks >= airborneLimit) {
        reasons.push({ code: 'airborne', ticks: this.airborneTicks });
      }
      if (reasons.length) {
        const target = this.track.lap
          ? {
            x: this.track.finishGate.x,
            z: this.track.finishGate.z,
            headingRad: this.track.finishGate.headingRad
          }
          : this._respawnTarget();
        events.push({
          type: 'respawn', tick: raceTick, reasons,
          observed: { position: state.position.map(round6), arc: round6(arc) },
          target
        });
        this.airborneTicks = 0;
      }
    }

    this.prevPosition = state.position.slice();
    this.events.push(...events);
    return events;
  }

  _respawnTarget() {
    if (this.checkpointsPassed > 0) {
      const gate = this.track.checkpointGates[this.checkpointsPassed - 1];
      return { x: gate.x, z: gate.z, headingRad: gate.headingRad };
    }
    const start = this.track.startGate;
    return { x: start.x, z: start.z, headingRad: start.headingRad };
  }

  snapshot() {
    return {
      kind: 'blur.ai-driver-state',
      profile: this.profile,
      courseId: this.layout.courseId,
      finished: this.finished,
      lapsCompleted: this.lapsCompleted,
      finishLaps: this.finishLaps,
      lapTimes: this.lapTimes.slice(),
      checkpointsPassed: this.checkpointsPassed,
      forwardTravel: round6(this.forwardTravel),
      finish: this.finish,
      eventCount: this.events.length
    };
  }
}

export function createAiDriver(options) {
  return new AiDriver(options);
}

// ---------------------------------------------------------------------------
// Canonical JSON / SHA-256 helpers (the same definition as
// probes/e1-drive/web/packet-hash.js and probes/race-rules/hash.mjs).
// ---------------------------------------------------------------------------

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

export function aggregateHash(hashes) {
  return 'sha256:' + createHash('sha256').update(hashes.join('\n')).digest('hex');
}

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// ---------------------------------------------------------------------------
// Standalone diagnostics helpers used by the runner and verifier.
// ---------------------------------------------------------------------------

export function stateIsFinite(state) {
  const vectors = [state.position, state.axisX, state.axisY, state.axisZ, state.velocity, state.angular];
  if (vectors.some((vector) => !Array.isArray(vector) || vector.some((value) => !Number.isFinite(value)))) {
    return false;
  }
  if (!Number.isFinite(state.speed)) return false;
  if (!Array.isArray(state.contacts) || state.contacts.length !== 4) return false;
  if (!Array.isArray(state.wheels)) return false;
  for (const wheel of state.wheels) {
    if (!Number.isFinite(wheel.suspension) || !Number.isFinite(wheel.angular)) return false;
    if (!Array.isArray(wheel.position) || wheel.position.some((value) => !Number.isFinite(value))) return false;
    if (!Array.isArray(wheel.groundNormal) || wheel.groundNormal.some((value) => !Number.isFinite(value))) {
      return false;
    }
  }
  return true;
}

export function layoutSummary(layout) {
  return {
    courseId: layout.courseId,
    mode: layout.course?.rule ?? layout.courseId,
    hash: layout.hash ?? null,
    samples: layout.course?.samples?.length ?? 0,
    lengthMetres: layout.course?.span?.lengthMetres ?? layout.course?.lengthMetres ?? null,
    finishArc: layout.course?.finishArc ?? null,
    laps: layout.course?.span?.laps ?? layout.course?.laps ?? 1,
    corridorHalfWidthMetres: layout.course?.corridor?.halfWidthMetres ?? null,
    spawnGroundY: layout.course?.spawnGroundY ?? null,
    countdownTicks: layout.countdown?.ticks ?? 0,
    gates: (layout.gates ?? []).map((gate) => ({ id: gate.id, kind: gate.kind, arc: gate.arc }))
  };
}
