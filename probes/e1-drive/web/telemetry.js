// Deterministic telemetry manoeuvres for the E1 drive slice.
//
// The goal is to let a reader judge the car physics objectively: three scripted
// manoeuvres per car, measured from the engine's own reported state, with no
// change to the physics and no inferred engine parameter.
//
//   1. accel   standing start, full throttle, recorded over a fixed 86 m of the
//              measured strip: 0-50 and 0-100 km/h times and the speed reached
//              at the end of that fixed distance.
//   2. brake   full throttle from the same spawn, then brake at the tick where
//              the accel run first measured 80 km/h: braking distance, peak and
//              mean deceleration.
//   3. lateral a straight run-up, then a square steering sweep: peak lateral
//              acceleration and peak yaw rate, plus the measured yaw lag behind
//              each steering reversal.
//
// Determinism: the input of every manoeuvre is a pure function of the tick
// number. Manoeuvre 1 is throttle on every tick. Manoeuvre 2 is a step function
// whose step tick is the tick measured in manoeuvre 1's own run (not wall-clock,
// not random, not tuned by hand). Manoeuvre 3 is a square wave derived from the
// tick with integer arithmetic (no sin/cos, so node and the browser agree bit
// for bit). tools/verify_e1_drive.mjs replays the recorded input sequence of
// every manoeuvre into a fresh wasm module and requires identical state hashes.
//
// Every number this module reports is a measurement of the state sequence the
// caller recorded: speed, velocity differences, body axes, angular velocity and
// positions. Nothing is read out of the XT record and no engine curve is fitted.

import { TICK_HZ } from './drive-script.js';

export const GRAVITY = 9.80665;

export const TELEMETRY_MANOEUVRE = Object.freeze({
  ACCEL: 'accel',
  BRAKE: 'brake',
  LATERAL: 'lateral'
});

export const TELEMETRY_MANOEUVRE_ORDER = Object.freeze([
  TELEMETRY_MANOEUVRE.ACCEL,
  TELEMETRY_MANOEUVRE.BRAKE,
  TELEMETRY_MANOEUVRE.LATERAL
]);

/**
 * Manoeuvre definition. These are scenario parameters for this diagnostic, not
 * recovered game values. The distances and speeds are chosen so every roster car
 * completes them on the measured strip without reaching the level wall at
 * x ~ +7 (see docs/work/verification/T-007-telemetry.md).
 */
export const TELEMETRY_SPEC = Object.freeze({
  version: 1,
  tickHz: TICK_HZ,
  accel: Object.freeze({
    endDistanceMetres: 86,
    maxTicks: 900,
    thresholdsKph: Object.freeze([50, 80, 100])
  }),
  brake: Object.freeze({
    entrySpeedKph: 80,
    maxTicks: 360,
    stoppedSpeedMps: 0.15,
    settleTicks: 10
  }),
  lateral: Object.freeze({
    throttleTicks: 90,
    sweepHalfPeriodTicks: 36,
    sweepAmplitude: 0.6,
    sweepHalfPeriods: 4,
    maxTicks: 480,
    lostContactTicks: 12
  })
});

/** Packet diagnostics label for a telemetry timeline (never changes a legacy one). */
export const TELEMETRY_PACKET_SCRIPT =
  'telemetry: 86 m standing start, 80 km/h brake and square steering sweep ' +
  '(probes/e1-drive/web/telemetry.js)';

const horizontalDistance = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/** The tick of the first sample at or above a speed, or null. */
export function tickAtSpeedKph(states, kph) {
  const minimum = kph / 3.6;
  const index = states.findIndex((state) => Number.isFinite(state.speed) && state.speed >= minimum);
  return index < 0 ? null : states[index].tick;
}

/**
 * Input for one telemetry manoeuvre. `plan` is the series plan built by
 * `runTelemetrySeries`; only the brake step uses it.
 */
export function telemetryInput(manoeuvre, tick, plan = {}) {
  if (manoeuvre === TELEMETRY_MANOEUVRE.ACCEL) return [1, 0, 0, 0];
  if (manoeuvre === TELEMETRY_MANOEUVRE.BRAKE) {
    const brakeTick = plan.brakeTick ?? Infinity;
    return tick > brakeTick ? [0, 1, 0, 0] : [1, 0, 0, 0];
  }
  if (manoeuvre === TELEMETRY_MANOEUVRE.LATERAL) {
    const spec = TELEMETRY_SPEC.lateral;
    if (tick <= spec.throttleTicks) return [1, 0, 0, 0];
    const swept = tick - spec.throttleTicks;
    if (swept > spec.sweepHalfPeriodTicks * spec.sweepHalfPeriods) return [0, 0, 0, 0];
    const half = Math.floor((swept - 1) / spec.sweepHalfPeriodTicks);
    const steer = (half % 2 === 0 ? 1 : -1) * spec.sweepAmplitude;
    return [1, 0, steer, 0];
  }
  throw new Error('unknown telemetry manoeuvre ' + JSON.stringify(manoeuvre));
}

/** Stop condition for one manoeuvre, evaluated on the state just produced. */
export function telemetryStop(manoeuvre, states, plan) {
  const state = states[states.length - 1];
  let airborne = 0;
  for (let index = states.length - 1; index >= 0 && state.anyContact === 0; index--) {
    if (states[index].anyContact !== 0) break;
    airborne++;
  }
  if (manoeuvre === TELEMETRY_MANOEUVRE.ACCEL) {
    const distance = horizontalDistance(state.position, states[0].position);
    return distance >= TELEMETRY_SPEC.accel.endDistanceMetres ||
      state.tick >= TELEMETRY_SPEC.accel.maxTicks ||
      airborne >= 5;
  }
  if (manoeuvre === TELEMETRY_MANOEUVRE.BRAKE) {
    const brakeTick = plan.brakeTick ?? Infinity;
    return (state.tick > brakeTick + TELEMETRY_SPEC.brake.settleTicks &&
        state.speed <= TELEMETRY_SPEC.brake.stoppedSpeedMps) ||
      state.tick >= TELEMETRY_SPEC.brake.maxTicks ||
      airborne >= 12;
  }
  if (manoeuvre === TELEMETRY_MANOEUVRE.LATERAL) {
    const sweepEnd = TELEMETRY_SPEC.lateral.throttleTicks +
      TELEMETRY_SPEC.lateral.sweepHalfPeriodTicks * TELEMETRY_SPEC.lateral.sweepHalfPeriods;
    return state.tick >= sweepEnd ||
      state.tick >= TELEMETRY_SPEC.lateral.maxTicks ||
      airborne >= TELEMETRY_SPEC.lateral.lostContactTicks;
  }
  return true;
}

/** Horizontal (XZ) distance between two positions. */
export function distanceXZ(a, b) {
  return horizontalDistance(a, b);
}

const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const sign = (value) => (value > 1e-9 ? 1 : value < -1e-9 ? -1 : 0);

/**
 * Turn a recorded state sequence into measured metrics plus a per-tick trace.
 * The first sample is the settled tick 0 (zero difference by construction); every
 * later row is a finite difference of the engine-reported velocity.
 */
export function analyseTelemetry(manoeuvre, states, extra = {}) {
  if (!Array.isArray(states) || states.length < 2) {
    throw new Error('telemetry analysis needs at least two states');
  }
  const dt = 1 / TELEMETRY_SPEC.tickHz;
  const origin = states[0].position;
  const trace = states.map((state, index) => {
    const previous = states[Math.max(0, index - 1)];
    const velocity = state.velocity ?? [0, 0, 0];
    const previousVelocity = previous.velocity ?? velocity;
    const axisX = state.axisX ?? [1, 0, 0];
    const axisZ = state.axisZ ?? [0, 0, 1];
    const axisY = state.axisY ?? [0, 1, 0];
    const delta = [
      (velocity[0] - previousVelocity[0]) / dt,
      (velocity[1] - previousVelocity[1]) / dt,
      (velocity[2] - previousVelocity[2]) / dt
    ];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return {
      tick: state.tick,
      timeSeconds: round(state.tick / TELEMETRY_SPEC.tickHz, 6),
      speedKph: round(state.speed * 3.6),
      distanceMetres: round(horizontalDistance(state.position, origin)),
      longitudinalAccelMps2: round(dot(delta, axisZ)),
      lateralAccelMps2: round(dot(delta, axisX)),
      lateralG: round(dot(delta, axisX) / GRAVITY),
      yawRateRadps: round(dot(state.angular ?? [0, 0, 0], axisY), 6),
      steer: state.input?.[2] ?? 0,
      throttle: state.input?.[0] ?? 0,
      brake: state.input?.[1] ?? 0,
      contacts: Array.isArray(state.contacts) ? state.contacts.join('') : '',
      speedMps: round(state.speed)
    };
  });

  const finite = states.every((state) => state.finite === 1) && trace.every((row) =>
    Number.isFinite(row.speedKph) && Number.isFinite(row.lateralG) && Number.isFinite(row.yawRateRadps));
  const contactTicks = states.filter((state) => state.anyContact === 1).length;
  const airborneTicks = states.length - contactTicks;
  const top = states.reduce((best, state) =>
    Number.isFinite(state.speed) && state.speed > best.speed ? state : best, states[0]);
  const common = {
    manoeuvre,
    sampleHz: TELEMETRY_SPEC.tickHz,
    ticks: states.length,
    durationSeconds: round((states.length - 1) / TELEMETRY_SPEC.tickHz, 6),
    finite,
    nanTicks: states.filter((state) => state.finite !== 1).length,
    contactTicks,
    airborneTicks,
    topSpeedMps: round(top.speed),
    topSpeedKph: round(top.speed * 3.6),
    topSpeedTick: top.tick,
    ...extra
  };

  if (manoeuvre === TELEMETRY_MANOEUVRE.ACCEL) {
    const zeroTo = {};
    for (const kph of TELEMETRY_SPEC.accel.thresholdsKph) {
      const tick = tickAtSpeedKph(states, kph);
      const sample = tick === null ? null : states.find((state) => state.tick === tick);
      zeroTo[String(kph)] = {
        reached: tick !== null,
        tick,
        seconds: tick === null ? null : round(tick / TELEMETRY_SPEC.tickHz, 6),
        distanceMetres: sample ? round(horizontalDistance(sample.position, origin)) : null
      };
    }
    const last = states[states.length - 1];
    return {
      ...common,
      distanceMetres: round(horizontalDistance(last.position, origin)),
      endSpeedMps: round(last.speed),
      endSpeedKph: round(last.speed * 3.6),
      zeroToSpeedKph: zeroTo,
      runLimitedBy: horizontalDistance(last.position, origin) >= TELEMETRY_SPEC.accel.endDistanceMetres - 1e-6
        ? 'distance' : 'ticks',
      trace
    };
  }

  if (manoeuvre === TELEMETRY_MANOEUVRE.BRAKE) {
    const brakeTick = extra.brakeTick;
    const entryIndex = states.findIndex((state) => state.tick === brakeTick);
    if (brakeTick === null || entryIndex < 0) {
      return { ...common, brakeTick: null, skipped: 'entry-speed-not-reached', trace };
    }
    const entry = states[entryIndex];
    const stopIndex = states.findIndex((state, index) =>
      index > entryIndex + 2 && state.speed <= TELEMETRY_SPEC.brake.stoppedSpeedMps);
    const finalIndex = stopIndex < 0 ? states.length - 1 : stopIndex;
    const final = states[finalIndex];
    const decels = [];
    for (let index = entryIndex + 1; index <= finalIndex; index++) {
      const decel = (states[index - 1].speed - states[index].speed) * TELEMETRY_SPEC.tickHz;
      if (Number.isFinite(decel)) decels.push(decel);
    }
    const peak = decels.reduce((best, value) => (value > best ? value : best), 0);
    const duration = (final.tick - entry.tick) / TELEMETRY_SPEC.tickHz;
    return {
      ...common,
      brakeTick,
      entrySpeedMps: round(entry.speed),
      entrySpeedKph: round(entry.speed * 3.6),
      entryDistanceMetres: round(horizontalDistance(entry.position, origin)),
      stopTick: final.tick,
      stopped: final.speed <= TELEMETRY_SPEC.brake.stoppedSpeedMps,
      stopSpeedMps: round(final.speed),
      brakingTimeSeconds: round(duration, 6),
      distanceMetres: round(horizontalDistance(final.position, entry.position)),
      peakDecelMps2: round(peak),
      peakDecelG: round(peak / GRAVITY),
      meanDecelMps2: duration > 0 ? round((entry.speed - final.speed) / duration) : null,
      trace
    };
  }

  if (manoeuvre === TELEMETRY_MANOEUVRE.LATERAL) {
    const spec = TELEMETRY_SPEC.lateral;
    const sweepEnd = spec.throttleTicks + spec.sweepHalfPeriodTicks * spec.sweepHalfPeriods;
    const sweep = trace.filter((row) => row.tick > spec.throttleTicks && row.tick <= sweepEnd);
    const peakLat = sweep.reduce((best, row) =>
      Math.abs(row.lateralAccelMps2) > Math.abs(best.lateralAccelMps2) ? row : best, sweep[0]);
    const peakYaw = sweep.reduce((best, row) =>
      Math.abs(row.yawRateRadps) > Math.abs(best.yawRateRadps) ? row : best, sweep[0]);
    // Measured mapping steer sign -> yaw sign, taken from the first sweep half
    // period (the car is already rolling, so the response is a real turn).
    const firstHalf = sweep.filter((row) => row.tick <= spec.throttleTicks + spec.sweepHalfPeriodTicks);
    const meanYaw = firstHalf.reduce((sum, row) => sum + row.yawRateRadps, 0) / Math.max(1, firstHalf.length);
    const observedSteer = firstHalf[0]?.steer ?? 0;
    const yawSignPerSteerSign = sign(meanYaw) * sign(observedSteer);
    // Each steering reversal and the first tick the yaw rate reaches the new sign.
    const reversals = [];
    for (let index = 1; index < sweep.length; index++) {
      const previous = sweep[index - 1];
      const row = sweep[index];
      if (sign(row.steer) === sign(previous.steer) || sign(row.steer) === 0) continue;
      const expected = sign(row.steer) * yawSignPerSteerSign;
      let lag = null;
      for (let probeIndex = index; probeIndex < Math.min(sweep.length, index + 60); probeIndex++) {
        if (sign(sweep[probeIndex].yawRateRadps) === expected) {
          lag = sweep[probeIndex].tick - row.tick;
          break;
        }
      }
      reversals.push({ tick: row.tick, steer: row.steer, expectedYawSign: expected, lagTicks: lag });
    }
    const lags = reversals.map((entry) => entry.lagTicks).filter((value) => value !== null);
    return {
      ...common,
      sweepStartTick: spec.throttleTicks + 1,
      sweepEndTick: Math.min(sweepEnd, states[states.length - 1].tick),
      sweepAmplitude: spec.sweepAmplitude,
      sweepHalfPeriodTicks: spec.sweepHalfPeriodTicks,
      entrySpeedKph: sweep.length ? sweep[0].speedKph : null,
      exitSpeedKph: sweep.length ? sweep[sweep.length - 1].speedKph : null,
      peakLateralAccelMps2: round(peakLat?.lateralAccelMps2 ?? 0),
      peakLateralG: round((peakLat?.lateralAccelMps2 ?? 0) / GRAVITY),
      peakLateralAbsG: round(Math.abs(peakLat?.lateralAccelMps2 ?? 0) / GRAVITY),
      peakLateralTick: peakLat?.tick ?? null,
      peakYawRateRadps: round(peakYaw?.yawRateRadps ?? 0),
      peakYawRateDegPerSec: round((peakYaw?.yawRateRadps ?? 0) * 180 / Math.PI, 3),
      peakYawRateAbsDegPerSec: round(Math.abs(peakYaw?.yawRateRadps ?? 0) * 180 / Math.PI, 3),
      yawSignPerSteerSign,
      steerReversals: reversals.length,
      yawResponseTicks: lags.length ? round(lags.reduce((sum, value) => sum + value, 0) / lags.length, 3) : null,
      yawResponseSeconds: lags.length
        ? round(lags.reduce((sum, value) => sum + value, 0) / lags.length / TELEMETRY_SPEC.tickHz, 4) : null,
      yawSignChanges: lags.length,
      reversals,
      trace
    };
  }

  return { ...common, trace };
}

/**
 * Build the engine interface `runTelemetrySeries` expects from pre-created wasm
 * instances, one per manoeuvre.
 *
 * This is the independent reference set: every manoeuvre runs in its own module
 * instance after exactly one `e1_create` plus the 180-tick settle, the path every
 * other run in this slice uses. It is kept so the verifier can prove that the
 * one-instance rebuild set below produces the same numbers and the same per-tick
 * state hashes; the page uses the rebuild set. (The rebuild limit that once
 * forced this split is fixed: docs/work/verification/T-007-reset-fix.md.)
 */
export async function createWasmTelemetryEngineSet({ factory, levelBytes, fieldBytes, spawn, count = 3, label = 'telemetry' }) {
  const instances = [];
  for (let index = 0; index < count; index++) {
    const module = await factory();
    const levelPtr = module._malloc(levelBytes.length);
    const fieldsPtr = module._malloc(fieldBytes.length + 1);
    if (!levelPtr || !fieldsPtr) throw new Error('wasm malloc failed');
    module.HEAPU8.set(levelBytes, levelPtr);
    module.HEAPU8.set(fieldBytes, fieldsPtr);
    const created = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                                      spawn.x, spawn.z, spawn.heading);
    if (!created) {
      throw new Error(`${label} e1_create failed: ` + module.UTF8ToString(module._e1_last_error()));
    }
    const read = () => JSON.parse(module.UTF8ToString(module._e1_get_state()));
    instances.push({
      index,
      module,
      state0: read(),
      info: JSON.parse(module.UTF8ToString(module._e1_info())),
      setInput: (input) => module._e1_set_input(input[0], input[1], input[2], input[3]),
      step: () => {
        if (!module._e1_step()) throw new Error(label + ' e1_step failed: ' + module.UTF8ToString(module._e1_last_error()));
        return read();
      }
    });
  }
  let cursor = 0;
  let current = null;
  return {
    instances,
    get info() { return instances[0].info; },
    /** Select the next pre-created instance and return its settled tick-0 state. */
    reset() {
      current = instances[cursor++];
      if (!current) throw new Error(label + ' ran out of wasm instances');
      return current.state0;
    },
    setInput(input) {
      if (!current) throw new Error(label + ' setInput before reset');
      current.setInput(input);
    },
    step() {
      if (!current) throw new Error(label + ' step before reset');
      return current.step();
    }
  };
}

/**
 * The same engine interface, backed by ONE wasm module instance that is rebuilt
 * with `e1_reset()` between manoeuvres.
 *
 * This is the path the recorded rebuild limit used to forbid: `e1_reset()` on
 * the third and fourth rebuild aborted because the physics scene was flushing an
 * uninitialised scheduler group handle (root cause and measurements in
 * docs/work/verification/T-007-reset-fix.md). With the scene groups created and
 * destroyed with the scene, one instance can be rebuilt any number of times, so
 * the telemetry series no longer needs three module instances and `R` no longer
 * needs a page reload.
 *
 * `prebuilt: true` means `module` already holds a world (the page's own module),
 * so the first `reset()` rebuilds it with `e1_reset()`; otherwise the first
 * `reset()` builds it with `e1_create()`.
 */
export async function createWasmResetEngineSet({ factory, module: given = null, levelBytes, fieldBytes, spawn,
                                                 label = 'telemetry', prebuilt = false }) {
  const module = given ?? await factory();
  const levelPtr = module._malloc(levelBytes.length);
  const fieldsPtr = module._malloc(fieldBytes.length + 1);
  if (!levelPtr || !fieldsPtr) throw new Error('wasm malloc failed');
  module.HEAPU8.set(levelBytes, levelPtr);
  module.HEAPU8.set(fieldBytes, fieldsPtr);
  const read = () => JSON.parse(module.UTF8ToString(module._e1_get_state()));
  const info = () => JSON.parse(module.UTF8ToString(module._e1_info()));

  let built = prebuilt;
  let resets = 0;
  let creates = prebuilt ? 1 : 0;
  const build = () => {
    const ok = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                                 spawn.x, spawn.z, spawn.heading);
    if (!ok) throw new Error(`${label} e1_create failed: ` + module.UTF8ToString(module._e1_last_error()));
    built = true;
    creates++;
  };

  return {
    module,
    kind: 'one-instance-rebuild',
    instances: [{ module }],
    get info() { return info(); },
    get resets() { return resets; },
    get creates() { return creates; },
    /** Total worlds built in this instance: e1_create calls plus e1_reset calls. */
    get builds() { return creates + resets; },
    get heapBytes() { return module.HEAPU8.length; },
    /** Rebuild the world in this instance and return the new settled tick 0. */
    reset() {
      if (built) {
        if (!module._e1_reset()) {
          throw new Error(`${label} e1_reset failed: ` + module.UTF8ToString(module._e1_last_error()));
        }
        resets++;
      } else {
        build();
      }
      return read();
    },
    setInput: (input) => module._e1_set_input(input[0], input[1], input[2], input[3]),
    step: () => {
      if (!module._e1_step()) throw new Error(label + ' e1_step failed: ' + module.UTF8ToString(module._e1_last_error()));
      return read();
    }
  };
}

/**
 * Run the three manoeuvres against an engine-like interface:
 *   { reset(): state, setInput([t,b,s,h]), step(): state }
 * The world is rebuilt from the same spawn for each manoeuvre, so the runs are
 * independent and one cannot contaminate another.
 */
export function runTelemetrySeries(engine) {
  const states = {};
  const inputs = {};
  const metrics = {};

  states.accel = [engine.reset()];
  inputs.accel = [];
  for (let tick = 1; tick <= TELEMETRY_SPEC.accel.maxTicks; tick++) {
    const input = telemetryInput(TELEMETRY_MANOEUVRE.ACCEL, tick);
    inputs.accel.push(input);
    engine.setInput(input);
    states.accel.push(engine.step());
    if (telemetryStop(TELEMETRY_MANOEUVRE.ACCEL, states.accel, {})) break;
  }
  metrics.accel = analyseTelemetry(TELEMETRY_MANOEUVRE.ACCEL, states.accel);
  const brakeTick = metrics.accel.zeroToSpeedKph[String(TELEMETRY_SPEC.brake.entrySpeedKph)]?.tick ?? null;

  states.brake = [engine.reset()];
  inputs.brake = [];
  const plan = { brakeTick };
  if (brakeTick === null) {
    // No measured 80 km/h tick: record one tick and let the analysis label the
    // manoeuvre `skipped`, rather than braking from a guessed speed.
    const input = [0, 0, 0, 0];
    inputs.brake.push(input);
    engine.setInput(input);
    states.brake.push(engine.step());
  } else {
    for (let tick = 1; tick <= TELEMETRY_SPEC.brake.maxTicks; tick++) {
      const input = telemetryInput(TELEMETRY_MANOEUVRE.BRAKE, tick, plan);
      inputs.brake.push(input);
      engine.setInput(input);
      states.brake.push(engine.step());
      if (telemetryStop(TELEMETRY_MANOEUVRE.BRAKE, states.brake, plan)) break;
    }
  }
  metrics.brake = analyseTelemetry(TELEMETRY_MANOEUVRE.BRAKE, states.brake, { brakeTick });

  states.lateral = [engine.reset()];
  inputs.lateral = [];
  for (let tick = 1; tick <= TELEMETRY_SPEC.lateral.maxTicks; tick++) {
    const input = telemetryInput(TELEMETRY_MANOEUVRE.LATERAL, tick);
    inputs.lateral.push(input);
    engine.setInput(input);
    states.lateral.push(engine.step());
    if (telemetryStop(TELEMETRY_MANOEUVRE.LATERAL, states.lateral)) break;
  }
  metrics.lateral = analyseTelemetry(TELEMETRY_MANOEUVRE.LATERAL, states.lateral);

  return {
    spec: TELEMETRY_SPEC,
    plan,
    states,
    inputs,
    metrics: {
      accel: metrics.accel,
      brake: metrics.brake,
      lateral: metrics.lateral
    }
  };
}

/** Drop the per-tick traces: the compact summary that goes into run.json. */
export function summariseTelemetryMetrics(metrics) {
  const pick = (entry, keys) => Object.fromEntries(keys
    .filter((key) => key in entry)
    .map((key) => [key, entry[key]]));
  return {
    accel: pick(metrics.accel, ['manoeuvre', 'sampleHz', 'ticks', 'durationSeconds', 'distanceMetres',
      'zeroToSpeedKph', 'endSpeedKph', 'topSpeedKph', 'topSpeedTick', 'runLimitedBy',
      'finite', 'nanTicks', 'contactTicks', 'airborneTicks']),
    brake: pick(metrics.brake, ['manoeuvre', 'sampleHz', 'ticks', 'durationSeconds', 'brakeTick',
      'entrySpeedKph', 'entryDistanceMetres', 'stopTick', 'stopped', 'stopSpeedMps',
      'brakingTimeSeconds', 'distanceMetres', 'peakDecelMps2', 'peakDecelG', 'meanDecelMps2',
      'finite', 'nanTicks', 'contactTicks', 'airborneTicks', 'skipped']),
    lateral: pick(metrics.lateral, ['manoeuvre', 'sampleHz', 'ticks', 'durationSeconds',
      'sweepStartTick', 'sweepEndTick', 'sweepAmplitude', 'sweepHalfPeriodTicks',
      'entrySpeedKph', 'exitSpeedKph', 'topSpeedKph', 'peakLateralAccelMps2', 'peakLateralG',
      'peakLateralAbsG', 'peakLateralTick', 'peakYawRateRadps', 'peakYawRateDegPerSec',
      'peakYawRateAbsDegPerSec', 'yawSignPerSteerSign', 'steerReversals',
      'yawResponseTicks', 'yawResponseSeconds', 'yawSignChanges', 'reversals',
      'finite', 'nanTicks', 'contactTicks', 'airborneTicks'])
  };
}
