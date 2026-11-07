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
import { bandHalfWidthAt, coursePosition, isFreeLayout, isLapLayout, isPathLayout } from './sprint-rules.js';

/**
 * Longest scripted sprint run: 60 s (3600 ticks). The 310.395 m course with a
 * standing start finishes in roughly 18-30 s for the roster; 60 s is a hard
 * bound that the verifier checks, not a silent truncation.
 */
export const SPRINT_SCRIPT_TICKS = 3600;

/**
 * Longest scripted lap run: 120 s (7200 ticks). Three 222.040 m laps at the
 * loop controller's speed take roughly 45-60 s; 120 s is a hard bound the
 * verifier checks, not a silent truncation.
 */
export const LAP_SCRIPT_TICKS = 7200;

/** Packet diagnostics label for a three-lap timeline. */
export const LAP_PACKET_SCRIPT =
  'lap: 3-2-1 countdown (1.5 s), Stanley path follower on the P61 loop-01 222.040 m closed loop, ' +
  'three forward crossings of the start/finish line, brake after lap 3 ' +
  '(probes/e1-drive/web/sprint-script.js)';

/** Packet diagnostics label for a sprint timeline (the legacy drive keeps its own). */
export const SPRINT_PACKET_SCRIPT =
  'sprint: 3-2-1 countdown (1.5 s), Stanley path follower on the measured 310.395 m P48 course, ' +
  'brake after the finish (probes/e1-drive/web/sprint-script.js)';

/**
 * Free-roam script: a tick-only diagnostic drive through the measured spawn
 * basin. It has no path follower and no route: the input is a fixed function of
 * the tick, so two runs are identical by construction, and the verifier records
 * the resulting trajectory, its containment and its prop contacts. The phase
 * lengths were chosen by measurement on the P68b layer and re-checked on the
 * P74 R04-V2 all-visible layer, not from a route file: throttle, a tight left
 * turn in the spawn bowl, a run west along the bowl, and a stop before the west
 * boundary. No physics value is involved.
 */
export const FREE_SCRIPT_TICKS = 400;
export const FREE_PACKET_SCRIPT =
  'free-roam: committed spawn (-88, 1050, pi/2), speed-capped tick-only diagnostic drive on the measured spawn ' +
  'basin, no gates/finish/lap, P74 R04-V2 all-visible prop layer ' +
  '(probes/e1-drive/web/sprint-script.js)';
export const FREE_SCENARIO = Object.freeze({
  driveTicks: FREE_SCRIPT_TICKS,
  phases: Object.freeze([
    Object.freeze({ untilTick: 15, steer: -0.1, throttle: 0.6, speedLimit: null }),
    Object.freeze({ untilTick: 150, steer: -0.9, throttle: 0.45, speedLimit: 6 }),
    Object.freeze({ untilTick: 260, steer: -0.2, throttle: 0.5, speedLimit: 7 }),
    Object.freeze({ untilTick: 330, steer: 0.35, throttle: 0.4, speedLimit: 6 }),
    Object.freeze({ untilTick: 380, steer: 0, throttle: 0, speedLimit: 0 })
  ]),
  note:
    'input is a pure function of the engine tick and the measured speed (a speed cap): throttle below the phase ' +
    'limit, brake above it; the phases are a throttle/steer/brake sequence, never wall time. The cap keeps the ' +
    'five roster cars on the same measured line so the run is contained and prop-clear for all of them'
});

/** Input for the free-roam diagnostic drive on the step that reaches `tick`. */
export function freeScriptInput(tick, speed = 0) {
  for (const phase of FREE_SCENARIO.phases) {
    if (tick <= phase.untilTick) {
      if (phase.speedLimit === null) return [phase.throttle, 0, phase.steer, 0];
      const braking = !(speed < phase.speedLimit);
      return [braking ? 0 : phase.throttle, braking ? 1 : 0, phase.steer, 0];
    }
  }
  return [0, 0, 0, 0];
}

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

/**
 * Controller constants for the 222.040 m closed loop. Only the constants the loop
 * needs differ from the 310 m sprint: a shorter lookahead, lower cruise and a
 * lower declared lateral acceleration for the tighter oval. Physics is untouched.
 * `narrowBandMetres: 0` disables the 310 m band-derived speed cap: the lap's
 * 0.8 m band is a declared respawn rule for the tight face clearance, not the
 * physical road width (P61 measured an 11.75 m flat band).
 */
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
  // Lap steering uses pure pursuit on a short speed-scaled lookahead: the loop's
  // hairpins are ~10 m radius and the Stanley lateral term saturates at low speed.
  lapPurePursuit: true,
  lapLookaheadBase: 2.5,
  lapLookaheadSpeed: 0.3,
  lapLookaheadMax: 7
});

const wrapArc = (arc, length) => {
  let value = arc % length;
  if (value < 0) value += length;
  return value;
};

/** Point on the closed lap at an arc (wraps across the seam). */
function lapPointAtArc(samples, arc, length) {
  return coursePointAtArc(samples, wrapArc(arc, length));
}

/** Heading on the closed lap at an arc, across the seam, over a window. */
function lapHeadingAt(samples, arc, length, windowMetres = 12) {
  const a = lapPointAtArc(samples, arc - windowMetres / 2, length);
  const b = lapPointAtArc(samples, arc + windowMetres / 2, length);
  return Math.atan2(b.x - a.x, b.z - a.z);
}

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
export function sprintControl(state, layout, constants = null) {
  const terms = sprintControlTerms(state, layout, constants);
  return terms.input;
}

/** The controller terms, for the verifier and diagnostics (no physics effect). */
export function sprintControlTerms(state, layout, constants = null) {
  const control = constants ?? (isLapLayout(layout) ? LAP_CONTROL : SPRINT_CONTROL);
  const lap = isLapLayout(layout);
  const lapLength = lap ? layout.course.span.finishArc : null;
  const samples = layout.course.reference?.points ?? layout.course.samples;
  const finishArc = layout.course.span.finishArc;
  const position = state.position;
  const speed = state.speed ?? 0;
  const course = coursePosition(layout.course.samples, position);
  const bandHalfWidth = bandHalfWidthAt(layout, course.arc);
  // Arc-addressed helpers: the sprint clamps at the measured end, the lap wraps
  // across its seam so the lookahead and curvature scan are continuous.
  const pointAt = (arc) => lap
    ? lapPointAtArc(samples, arc, lapLength)
    : coursePointAtArc(samples, Math.min(finishArc, arc));
  const headingAt = (arc, windowMetres = 12) => lap
    ? lapHeadingAt(samples, arc, lapLength, windowMetres)
    : courseHeadingAt(samples, Math.min(finishArc, arc), windowMetres);

  // Speed target: measured band first (a narrow strip is not a 24 m/s line),
  // then the reference-line curvature over the braking distance. The lap band is
  // a declared respawn rule, not the road width, so the band cap is sprint-only.
  const scanDistance = lap
    ? control.anticipationMetres + speed * control.anticipationSeconds
    : Math.max(0, Math.min(finishArc,
      course.arc + control.anticipationMetres + speed * control.anticipationSeconds) - course.arc);
  let narrowestBand = bandHalfWidth;
  if (!lap) {
    for (let offset = 0; offset <= scanDistance; offset += 1) {
      const band = bandHalfWidthAt(layout, course.arc + offset);
      if (band < narrowestBand) narrowestBand = band;
    }
  }
  let curvatureSpeed = control.cruiseSpeed;
  const headingStart = headingAt(course.arc);
  for (let offset = 2; offset <= Math.min(scanDistance, 30); offset += 2) {
    const turn = Math.abs(wrapAngle(headingAt(course.arc + offset) - headingStart));
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

  // Launch: the committed spawn heading is +X (pi/2) while the measured course
  // leaves the spawn at ~44 degrees, so the first metres are a deliberate turn
  // onto the line. Hold the launch speed only while still near the start; after
  // that the heading controller owns the turn.
  const carHeading = Math.atan2(state.axisZ[0], state.axisZ[2]);
  const launchError = Math.abs(wrapAngle(headingAt(course.arc) - carHeading));
  if (course.arc < control.launchArcMetres && launchError > control.launchHeadingError) {
    speedTarget = Math.min(speedTarget, control.launchSpeed);
  }

  // Finish: approach slowly enough that the post-finish brake stops the car
  // before the measured surface narrows to 2.0 m at +4 m past the course end.
  // The lap has no such narrowing: its line is crossed at speed on every lap.
  if (!lap && course.arc > finishArc - control.finishSlowdownMetres) {
    speedTarget = Math.min(speedTarget, control.finishSpeed);
  }

  // Steering. The sprint keeps the Stanley heading + lateral form; the lap uses
  // pure pursuit on a short speed-scaled lookahead, which tracks the ~10 m
  // hairpins without the low-speed lateral-term saturation.
  const yawRate = state.angular?.[1] ?? 0;
  const previousSteer = Number.isFinite(state.input?.[2]) ? state.input[2] : 0;
  const nearest = pointAt(course.arc);
  const tangentHeading = headingAt(course.arc, 2);
  const tangentX = Math.sin(tangentHeading);
  const tangentZ = Math.cos(tangentHeading);
  const offsetX = position[0] - nearest.x;
  const offsetZ = position[2] - nearest.z;
  const lateral = tangentX * offsetZ - tangentZ * offsetX;
  let headingError;
  let lateralTerm = 0;
  let desired;
  let lookaheadMetres = 0;
  if (lap && control.lapPurePursuit) {
    lookaheadMetres = clamp(control.lapLookaheadBase + control.lapLookaheadSpeed * speed,
      control.lapLookaheadBase, control.lapLookaheadMax);
    const target = pointAt(course.arc + lookaheadMetres);
    const targetHeading = Math.atan2(target.x - position[0], target.z - position[2]);
    headingError = wrapAngle(targetHeading - carHeading);
    desired = clamp(control.steerGain * headingError - control.yawDamping * yawRate, -1, 1);
  } else {
    const lookaheadHeading = headingAt(course.arc + control.headingLookahead);
    headingError = wrapAngle(lookaheadHeading - carHeading);
    // Lateral term (Stanley): for a signed lateral offset L measured along the
    // left normal, the lateral velocity is v*sin(pathHeading - carHeading), so a
    // positive L needs a positive heading correction. +atan(k*L/v) is that term.
    lateralTerm = Math.atan(control.lateralGain * lateral / Math.max(2, speed));
    // The engine's steering authority falls sharply with speed: at 24 m/s a 0.3
    // request produces ~0.08 rad/s of yaw, while 1.0 produces ~1.3 rad/s. The
    // controller therefore scales its gain with speed (measured on this car family
    // by _work/e1-drive/p50-steer.mjs) and relies on the rate limit for stability.
    const speedFactor = clamp(speed / 6, 1, control.speedSteerCeiling);
    desired = clamp(control.steerGain * speedFactor * headingError + lateralTerm -
      control.yawDamping * yawRate, -1, 1);
  }
  const speedFactor = clamp(speed / 6, 1, control.speedSteerCeiling);
  // Steering rate limit: a driver cannot move the wheel from lock to lock in one
  // 60 Hz tick. `state.input` is the input applied on the previous tick, so this
  // stays a pure function of the engine state (no controller memory).
  const steer = clamp(desired, previousSteer - control.steerRatePerTick,
    previousSteer + control.steerRatePerTick);

  // Longitudinal: throttle below the target, brake above it.
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
 *
 * `constants` is an optional controller override. M1's headless `--mode mp`
 * capture uses it to give the guest a slower diagnostic pace so both cars are
 * visibly separate; the normal page path passes nothing and the committed
 * controller is unchanged.
 */
export function sprintScriptInput(rules, state, constants = null) {
  if (isFreeLayout(rules.layout)) {
    if (rules.phase !== 'running') return [0, 0, 0, 0];
    return rules.gateInput(freeScriptInput(rules.elapsedTicks + 1, state?.speed ?? 0));
  }
  if (!isPathLayout(rules.layout)) return rules.gateInput(SPRINT_DESIRED_INPUT);
  if (!state) throw new Error('the scripted long-course sprint needs the engine state');
  if (rules.phase !== 'running') return rules.gateInput(SPRINT_DESIRED_INPUT);
  return rules.gateInput(sprintControl(state, rules.layout, constants));
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
