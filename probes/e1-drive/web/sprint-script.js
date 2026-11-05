// Deterministic sprint drivers for the E1 drive slice.
//
// The default course is the measured P48 310.395 m collision-clean path, so the
// scripted driver is a real path follower, not a throttle hold:
//
//   * a Stanley controller steers to the measured course: heading error to a
//     point `headingLookahead` metres ahead plus a lateral term to the nearest
//     point on the measured polyline, with yaw damping;
//   * the speed target comes from the upcoming path curvature over the braking
//     distance, the measured off-course band, a launch guard while the car still
//     points away from the line, and a slow-down before the finish so the brake
//     after the line stops the car before the measured 2.0 m narrowing.
//
// The straight 29 m regression course keeps the original P37 behaviour: full
// throttle while running, gated by the rules.
//
// The controller is a pure function of the engine state and the committed
// layout: same tick sequence, same inputs, same state hashes. The rules still
// gate the returned input (zero during the countdown, brake after the finish),
// and the rules never write a physics value.
//
// A second, diagnostic driver exists to exercise the respawn path on the real
// engine: it waits out the countdown, accelerates straight, then holds full
// steering until the car leaves the measured course. The verifier uses it to
// prove that the rules respawn the car at the last checkpoint; the page can run
// it with `?sprintfall=1`.

import { COUNTDOWN_TICKS } from './sprint-layout.js';
import { bandHalfWidthAt, coursePosition, isPathLayout } from './sprint-rules.js';

/**
 * Longest scripted sprint run: 60 s (3600 ticks). The 310.395 m course with a
 * standing start finishes in roughly 18-30 s for the roster; 60 s is a hard
 * bound that the verifier checks, not a silent truncation.
 */
export const SPRINT_SCRIPT_TICKS = 3600;

/** Packet diagnostics label for a sprint timeline (the legacy drive keeps its own). */
export const SPRINT_PACKET_SCRIPT =
  'sprint: 3-2-1 countdown (1.5 s), Stanley path follower on the measured 310.395 m P48 course, ' +
  'brake after the finish (probes/e1-drive/web/sprint-script.js)';

/** What the short-course sprint driver asks for while running. */
export const SPRINT_DESIRED_INPUT = Object.freeze([1, 0, 0, 0]);

/** Controller constants. Distances in metres, speeds in m/s, times in seconds. */
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

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const wrapAngle = (value) => {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
};

/** Point on the measured course at an arc length (linear between samples). */
export function coursePointAtArc(samples, arc) {
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
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, arc };
}

/** Course heading (engine convention: forward = (sin h, cos h)) at an arc. */
export function courseHeadingAt(samples, arc, windowMetres = 12) {
  const a = coursePointAtArc(samples, Math.max(samples[0].arc, arc - windowMetres / 2));
  const b = coursePointAtArc(samples, Math.min(samples[samples.length - 1].arc, arc + windowMetres / 2));
  return Math.atan2(b.x - a.x, b.z - a.z);
}

/**
 * Path-following control for one tick (Stanley form). Returns the request the
 * rules will gate. `state` is the engine snapshot; `layout` is the committed
 * sprint layout. Only path layouts use this: the 29 m regression course keeps
 * the P37 throttle hold.
 */
export function sprintControl(state, layout, constants = SPRINT_CONTROL) {
  const terms = sprintControlTerms(state, layout, constants);
  return terms.input;
}

/** The controller terms, for the verifier and diagnostics (no physics effect). */
export function sprintControlTerms(state, layout, constants = SPRINT_CONTROL) {
  const samples = layout.course.reference?.points ?? layout.course.samples;
  const finishArc = layout.course.span.finishArc;
  const position = state.position;
  const speed = state.speed ?? 0;
  const course = coursePosition(layout.course.samples, position);
  const bandHalfWidth = bandHalfWidthAt(layout, course.arc);

  // Speed target: measured band first (a narrow strip is not a 24 m/s line),
  // then the reference-line curvature over the braking distance.
  const scanTo = Math.min(finishArc, course.arc + constants.anticipationMetres + speed * constants.anticipationSeconds);
  let narrowestBand = bandHalfWidth;
  for (let arc = course.arc; arc <= scanTo; arc += 1) {
    const band = bandHalfWidthAt(layout, arc);
    if (band < narrowestBand) narrowestBand = band;
  }
  let curvatureSpeed = constants.cruiseSpeed;
  const headingStart = courseHeadingAt(samples, course.arc);
  for (let arc = course.arc + 2; arc <= Math.min(scanTo, course.arc + 30); arc += 2) {
    const turn = Math.abs(wrapAngle(courseHeadingAt(samples, arc) - headingStart));
    const distance = Math.max(2, arc - course.arc);
    const radius = distance / Math.max(1e-3, turn);
    curvatureSpeed = Math.min(curvatureSpeed, Math.sqrt(constants.lateralAccel * radius));
  }
  let speedTarget = Math.min(constants.cruiseSpeed, curvatureSpeed);
  if (narrowestBand < constants.narrowBandMetres) {
    speedTarget = Math.min(speedTarget,
      constants.narrowSpeed * clamp(narrowestBand / constants.narrowBandMetres, 0.7, 1));
  }
  speedTarget = Math.max(constants.minSpeed, speedTarget);

  // Launch: the committed spawn heading is +X (pi/2) while the measured course
  // leaves the spawn at ~44 degrees, so the first metres are a deliberate turn
  // onto the line. Hold the launch speed only while still near the start; after
  // that the heading controller owns the turn.
  const carHeading = Math.atan2(state.axisZ[0], state.axisZ[2]);
  const launchError = Math.abs(wrapAngle(courseHeadingAt(samples, course.arc) - carHeading));
  if (course.arc < constants.launchArcMetres && launchError > constants.launchHeadingError) {
    speedTarget = Math.min(speedTarget, constants.launchSpeed);
  }

  // Finish: approach slowly enough that the post-finish brake stops the car
  // before the measured surface narrows to 2.0 m at +4 m past the course end.
  if (course.arc > finishArc - constants.finishSlowdownMetres) {
    speedTarget = Math.min(speedTarget, constants.finishSpeed);
  }

  // Stanley steering: heading term + lateral term.
  const lookaheadHeading = courseHeadingAt(samples, Math.min(finishArc, course.arc + constants.headingLookahead));
  const headingError = wrapAngle(lookaheadHeading - carHeading);
  const nearest = coursePointAtArc(layout.course.samples, course.arc);
  const tangentHeading = courseHeadingAt(layout.course.samples, course.arc, 2);
  const tangentX = Math.sin(tangentHeading);
  const tangentZ = Math.cos(tangentHeading);
  const offsetX = position[0] - nearest.x;
  const offsetZ = position[2] - nearest.z;
  const lateral = tangentX * offsetZ - tangentZ * offsetX;
  // Lateral term (Stanley): for a signed lateral offset L measured along the
  // left normal, the lateral velocity is v*sin(pathHeading - carHeading), so a
  // positive L needs a positive heading correction. +atan(k*L/v) is that term.
  const lateralTerm = Math.atan(constants.lateralGain * lateral / Math.max(2, speed));
  const yawRate = state.angular?.[1] ?? 0;
  // The engine's steering authority falls sharply with speed: at 24 m/s a 0.3
  // request produces ~0.08 rad/s of yaw, while 1.0 produces ~1.3 rad/s. The
  // controller therefore scales its gain with speed (measured on this car family
  // by _work/e1-drive/p50-steer.mjs) and relies on the rate limit for stability.
  const speedFactor = clamp(speed / 6, 1, constants.speedSteerCeiling);
  const desired = clamp(constants.steerGain * speedFactor * headingError + lateralTerm -
    constants.yawDamping * yawRate, -1, 1);
  // Steering rate limit: a driver cannot move the wheel from lock to lock in one
  // 60 Hz tick. `state.input` is the input applied on the previous tick, so this
  // stays a pure function of the engine state (no controller memory).
  const previousSteer = Number.isFinite(state.input?.[2]) ? state.input[2] : 0;
  const steer = clamp(desired, previousSteer - constants.steerRatePerTick,
    previousSteer + constants.steerRatePerTick);

  // Longitudinal: throttle below the target, brake above it.
  let throttle = 1;
  let brake = 0;
  if (speed > speedTarget + constants.throttleDeadband) {
    throttle = 0;
    brake = clamp(constants.brakeGain * (speed - speedTarget), 0, 1);
  } else if (speed > speedTarget) {
    throttle = clamp(1 - (speed - speedTarget), 0, 1);
  }

  return {
    input: [throttle, brake, steer, 0],
    arc: course.arc,
    lateral: course.distance,
    speedTarget,
    curvatureSpeed,
    narrowestBand,
    carHeading,
    headingError,
    lateralTerm,
    yawRate,
    speedFactor,
    desired,
    previousSteer,
    steer,
    throttle,
    brake
  };
}

/**
 * Input for the scripted sprint: the rules gate the request, so the sequence is
 * still a pure function of the rules state, the engine state and the tick order.
 */
export function sprintScriptInput(rules, state) {
  if (!isPathLayout(rules.layout)) return rules.gateInput(SPRINT_DESIRED_INPUT);
  if (!state) throw new Error('the scripted long-course sprint needs the engine state');
  if (rules.phase !== 'running') return rules.gateInput(SPRINT_DESIRED_INPUT);
  return rules.gateInput(sprintControl(state, rules.layout));
}

/**
 * Diagnostic off-course driver (respawn test). Tick-based, never wall-clock:
 *   ticks 1..90     countdown, no input
 *   ticks 91..180   throttle straight (the measured course turns immediately)
 *   ticks 181..420  throttle + full steer (leaves the measured course)
 *   ticks 421..600  coast
 */
export const RESPAWN_SCENARIO = Object.freeze({
  holdTicks: COUNTDOWN_TICKS,
  straightTicks: 90,
  steerTicks: 240,
  steer: 1,
  totalTicks: 600
});

export function respawnScriptInput(tick) {
  if (tick <= RESPAWN_SCENARIO.holdTicks) return [0, 0, 0, 0];
  if (tick <= RESPAWN_SCENARIO.holdTicks + RESPAWN_SCENARIO.straightTicks) return [1, 0, 0, 0];
  if (tick <= RESPAWN_SCENARIO.holdTicks + RESPAWN_SCENARIO.straightTicks + RESPAWN_SCENARIO.steerTicks) {
    return [1, 0, RESPAWN_SCENARIO.steer, 0];
  }
  return [0, 0, 0, 0];
}
