// Deterministic fake vehicle simulator for the net-prediction probe.
//
// This is NOT the wasm RacingPhysics step and makes no claim about it. It is a
// cheap, fully deterministic stand-in with the same interface the real step
// must expose: step(state, input, tick) -> newState. The predictor under test
// never imports this module; the harness injects the step. When the real
// e1-drive wasm step is wired in, only the injection changes.
//
// Arithmetic policy: `+ - * / sqrt` only. Yaw rotation uses a 7th-order Taylor
// series and the quaternion is derived from the heading vector with sqrt, so
// two runs in the same engine are bit-identical and the trace hashes repeat
// without depending on Math.sin/Math.cos/Math.atan2.

export const SIM_TICK_HZ = 60;
export const SIM_DT = 1 / SIM_TICK_HZ;

export const ZERO_INPUT = Object.freeze({ throttle: 0, brake: 0, steer: 0, handbrake: 0 });

export function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

/** Small, seedable generator used for network schedules and input segments. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hash32(seed, value) {
  let x = (seed ^ Math.imul((value + 1) >>> 0, 0x9e3779b1)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** Deterministic [0,1) value for a (seed, salt, tick) triple. */
export function hashUnit(seed, salt, tick) {
  return hash32(seed ^ salt, tick) / 4294967296;
}

function normalizeHeading(heading) {
  const x = Number(heading?.[0] ?? 1);
  const z = Number(heading?.[1] ?? 0);
  const length = Math.sqrt(x * x + z * z);
  if (!(length > 1e-12)) return [1, 0];
  return [x / length, z / length];
}

/**
 * Rotate a unit heading by `angle` around +Y. For heading (cos t, -sin t), the
 * +Y yaw rotation is x' = x cos a + z sin a, z' = -x sin a + z cos a.
 */
export function rotateHeading(heading, angle) {
  const [x, z] = normalizeHeading(heading);
  const a2 = angle * angle;
  const cos = 1 - a2 / 2 + (a2 * a2) / 24 - (a2 * a2 * a2) / 720;
  const sin = angle - (angle * a2) / 6 + (angle * a2 * a2) / 120 - (angle * a2 * a2 * a2) / 5040;
  return [x * cos + z * sin, -x * sin + z * cos];
}

/** Yaw quaternion from a unit heading vector; heading (hx,hz) uses hz=-sin(t). */
export function quaternionFromHeading(heading) {
  const [hx, hz] = normalizeHeading(heading);
  const sinTheta = -hz;
  const cosHalf = Math.sqrt(Math.max(0, (1 + hx) / 2));
  let sinHalf;
  if (cosHalf > 1e-9) sinHalf = sinTheta / (2 * cosHalf);
  else sinHalf = sinTheta >= 0 ? 1 : -1;
  const q = [0, sinHalf, 0, cosHalf];
  const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  return [0, q[1] / length, 0, q[3] / length];
}

export function createSimState({ x = 0, y = 0, z = 0, speed = 0, heading = [1, 0] } = {}) {
  const normalized = normalizeHeading(heading);
  return {
    tick: 0,
    position: [x, y, z],
    quaternion: quaternionFromHeading(normalized),
    speed,
    heading: normalized
  };
}

export function simStateClone(state) {
  return {
    tick: state.tick,
    position: [state.position[0], state.position[1], state.position[2]],
    quaternion: [state.quaternion[0], state.quaternion[1], state.quaternion[2], state.quaternion[3]],
    speed: state.speed,
    heading: [state.heading[0], state.heading[1]]
  };
}

/**
 * One fixed 1/60 s step. Inputs are clamped and validated by the caller. The
 * state argument is never mutated.
 */
export function simStep(state, input, tick = null) {
  const throttle = clamp(Number(input?.throttle ?? 0), -1, 1);
  const brake = clamp(Number(input?.brake ?? 0), -1, 1);
  const steer = clamp(Number(input?.steer ?? 0), -1, 1);
  const handbrake = clamp(Number(input?.handbrake ?? 0), -1, 1);

  let speed = Number(state.speed);
  const speedAbs = Math.abs(speed);

  const engine = throttle > 0 ? throttle * 8.8 * (1 - clamp(speed / 62, 0, 1)) : 0;
  const reverse = throttle < 0 ? throttle * 4.0 : 0;
  const brakePower = brake * 18;
  const drag = 0.005 * speedAbs * speedAbs;
  const rolling = speedAbs > 0.05 ? 0.35 : 0;

  let acceleration = engine + reverse;
  if (speed > 0.01) acceleration -= brakePower;
  else if (speed < -0.01) acceleration += brakePower;
  if (speed !== 0) acceleration -= Math.sign(speed) * (drag + rolling);

  speed = speed + acceleration * SIM_DT;
  if (handbrake > 0.5) speed *= 1 - 1.2 * SIM_DT;
  if (Math.abs(speed) < 0.05 && throttle === 0 && brake === 0) speed = 0;
  speed = clamp(speed, -8, 62);

  const speedFactor = clamp(speedAbs / 14, 0, 1);
  let yawRate = steer * 1.75 * speedFactor;
  if (speed < 0) yawRate = -yawRate;
  if (handbrake > 0.5) yawRate *= 1.35;
  const heading = rotateHeading(state.heading, yawRate * SIM_DT);

  const nextTick = tick === null ? state.tick + 1 : tick;
  return {
    tick: nextTick,
    position: [
      state.position[0] + heading[0] * speed * SIM_DT,
      state.position[1],
      state.position[2] + heading[1] * speed * SIM_DT
    ],
    quaternion: quaternionFromHeading(heading),
    speed,
    heading
  };
}

/**
 * Host-only disturbance: a deterministic contact/power-up style impulse the
 * client does not predict. Used to produce a measurable authoritative
 * divergence; it is a simulation input, not a physics claim.
 */
export function simApplyImpulse(state, { speed = 0, yaw = 0 } = {}) {
  const heading = rotateHeading(state.heading, yaw);
  return {
    tick: state.tick,
    position: [state.position[0], state.position[1], state.position[2]],
    quaternion: quaternionFromHeading(heading),
    speed: clamp(state.speed + speed, -8, 62),
    heading
  };
}

/**
 * Tick-addressed input script. Pure function of (tick, seed): it does not use
 * Math.random, so a replayed tick always receives the same input. Segment
 * length 90 ticks (1.5 s) gives long straights and direction changes.
 */
export function inputForTick(tick, seed = 1, baseTick = 1) {
  const local = tick - baseTick;
  if (local < 0) return { ...ZERO_INPUT };
  const segment = Math.floor(local / 90);
  const within = local % 90;
  const h = hash32(seed, segment);
  const throttle = 0.55 + 0.45 * ((h & 0xff) / 255);
  const steer = (((h >>> 8) & 0xff) / 255) * 1.2 - 0.6;
  const brake = ((h >>> 16) & 0x3) === 0 && within < 20 ? 0.6 : 0;
  const handbrake = ((h >>> 18) & 0x7) === 0 && within < 12 ? 0.7 : 0;
  return { throttle, brake, steer, handbrake };
}

/** Deterministic scripted respawn pose used by the reposition edge case. */
export function respawnPose(state, offset = 8) {
  return {
    tick: state.tick,
    position: [state.position[0] + offset, state.position[1], state.position[2] + offset * 0.5],
    quaternion: quaternionFromHeading([1, 0]),
    speed: 0,
    heading: [1, 0]
  };
}
