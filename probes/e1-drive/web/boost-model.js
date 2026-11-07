// M2a boost model: the exact recovered Nitro/Shock speed targets and the
// deterministic queue semantics used by the wasm `e1_boost_*` API.
//
// Sources:
//   * Nitrous `balancingGraph` and `ClassAModifier..D` (PWR1 manifest);
//   * Shock `balancingGraph`, `InnerRadius/OuterRadius/Lifetime/DamageInflicted`;
//   * `C_HermiteCurve::Evaluate` (misc_shared/Curve/HermiteCurve.h:150-200) with
//     the serialized tangents converted by tan(deg*pi/180)/3
//     (HermiteCurve.h:77-82);
//   * FakeVehicleSpeedState (Game/GameActors/Vehicles/FakePhysics.cpp:700-778)
//     for the 300 m/s^2 force shape, `_value = 0.5 s` force window and the
//     `g_debugShockManagerMinSpeedScrub = 10 mph` floor.
//
// The curve evaluator is exact; the only project choice is the car class, which
// the e1 roster does not record. The event carries the class it used and every
// class target, so no value is silently assumed.

export const BOOST_SCHEMA = 'e1-drive.boost/1';

export const MPH_TO_MPS = 0.44704;
export const MPS_TO_MPH = 1 / MPH_TO_MPS;
export const TICK_HZ = 60;

// BOOST1 measured shape and the retail constants.
export const M2_BOOST_MAGNITUDE_MPS2 = 300; // FakePhysics.cpp:191/195
export const M2_NITRO_ACCELERATING_BUDGET_TICKS = 30; // 0.5 s `_value`
export const M2_NITRO_DURATION_SECONDS = 1.3; // PWR1 Nitrous Duration
export const M2_NITRO_DURATION_TICKS = 78; // 1.3 s at 60 Hz
export const M2_SHOCK_DURATION_SECONDS = 1.5; // PWR1 Shock Lifetime
export const M2_SHOCK_DURATION_TICKS = 90; // 1.5 s at 60 Hz
export const M2_SHOCK_MIN_SCRUB_MPH = 10; // g_debugShockManagerMinSpeedScrub
export const M2_NITRO_CAP_MPS = 55; // project safety cap (BOOST1 §6.3)

// The reference 310 m sprint speed the recovered target table is quoted at.
export const M2_REFERENCE_SPRINT_SPEED_MPS = 24.73;
export const M2_REFERENCE_MAX_SPEED_MPS = 35.134;

// The e1 roster records no `AmaxVehicle::carClass`; M2a uses the exact class-A
// target and labels the choice in every event. It is not claimed as retail data.
export const M2_NITRO_CLASS = 'A';
export const M2_NITRO_CLASS_SOURCE =
  'project-assumption: AmaxVehicle::carClass is not recorded by the e1 roster; M2a uses the exact class-A target';

// Host-sequenced event timing: a receiver applies at its own tick + delay - 1,
// so the first application is on the next step when delayTicks = 1.
export const M2_BOOST_DELAY_TICKS = 4;

export const M2_BOOST_LABELS = Object.freeze({
  targetSource: 'pwr1-hermite',
  source: 'recovered',
  force: 'AddForce before C_Scene::Simulate (FakeVehicleSpeedState shape)',
  authority: 'host-sequenced; each page applies the event to its own car'
});

const round6 = (value) => Math.round(value * 1e6) / 1e6;

/** Convert a PWR1 `balancingGraph` record to the evaluator's keyframe form. */
export function keyframesFromLevel(level) {
  const frames = level?.balancingGraph?.keyframes ?? level?.graph;
  if (!Array.isArray(frames) || frames.length < 2) {
    throw new Error('balancingGraph.keyframes missing (PWR1 manifest)');
  }
  return frames.map((frame) => ({
    t: frame.Time ?? frame.t,
    v: frame.Value ?? frame.v,
    in: frame.InTangent ?? frame.in ?? 0,
    out: frame.OutTangent ?? frame.out ?? 0
  }));
}

/**
 * Exact `C_HermiteCurve::Evaluate`. The serialized tangents are degrees and are
 * converted to a gradient by tan(deg*pi/180)/3 before the cubic Hermite basis.
 */
export function evaluateHermite(keyframes, position) {
  let index = 0;
  for (let i = 0; i < keyframes.length; i++) {
    if (keyframes[i].t <= position) index = i;
  }
  if (index >= keyframes.length - 1) return keyframes[keyframes.length - 1].v;
  const a = keyframes[index];
  const b = keyframes[index + 1];
  const period = b.t - a.t;
  if (period <= 1e-6) return a.v;
  let u = (position - a.t) / period;
  u = Math.max(0, Math.min(1, u));
  const y1 = a.v;
  const y4 = b.v;
  const y2 = y1 + (Math.tan((a.out * Math.PI) / 180) / 3) * period;
  const y3 = y4 - (Math.tan((b.in * Math.PI) / 180) / 3) * period;
  const u2 = u * u;
  const u3 = u2 * u;
  return y1 * (-u3 + 3 * u2 - 3 * u + 1) +
    y2 * (3 * u3 - 6 * u2 + 3 * u) +
    y3 * (-3 * u3 + 3 * u2) +
    y4 * u3;
}

/** The exact Nitro target for a fire speed and class modifier. */
export function nitroTargetForSpeed(keyframes, {
  speedMps = M2_REFERENCE_SPRINT_SPEED_MPS,
  classLetter = M2_NITRO_CLASS,
  classModifiers = { A: 1, B: 0.95, C: 0.9, D: 0.85 },
  capMps = M2_NITRO_CAP_MPS
} = {}) {
  if (!(speedMps >= 0)) throw new Error('nitro target needs a non-negative speed');
  const modifier = classModifiers[classLetter];
  if (!Number.isFinite(modifier)) throw new Error('unknown Nitro class ' + JSON.stringify(classLetter));
  const speedMph = speedMps * MPS_TO_MPH;
  const graphPosition = speedMph / 200;
  const graphValue = evaluateHermite(keyframes, graphPosition);
  const graphMph = graphValue * 200;
  const rawMps = graphMph * MPH_TO_MPS * modifier;
  const targetMps = Math.min(rawMps, capMps);
  return {
    speedMps: round6(speedMps),
    speedMph: round6(speedMph),
    graphPosition: round6(graphPosition),
    graphValue: round6(graphValue),
    classLetter,
    classModifier: modifier,
    classSource: M2_NITRO_CLASS_SOURCE,
    graphMph: round6(graphMph),
    rawMps: round6(rawMps),
    targetMps: round6(targetMps),
    capMps,
    capApplied: targetMps < rawMps,
    targetSource: M2_BOOST_LABELS.targetSource,
    source: M2_BOOST_LABELS.source
  };
}

/** The exact Shock speed target, with the `speed - 10 mph` retail floor. */
export function shockTargetForSpeed(keyframes, {
  speedMps = M2_REFERENCE_SPRINT_SPEED_MPS,
  minScrubMph = M2_SHOCK_MIN_SCRUB_MPH
} = {}) {
  if (!(speedMps >= 0)) throw new Error('shock target needs a non-negative speed');
  const speedMph = speedMps * MPS_TO_MPH;
  const graphPosition = speedMph / 200;
  const graphValue = evaluateHermite(keyframes, graphPosition);
  const graphMph = graphValue * 200;
  const graphMps = graphMph * MPH_TO_MPS;
  const floorMps = Math.max(0, speedMps - minScrubMph * MPH_TO_MPS);
  const targetMps = Math.max(0, Math.min(graphMps, floorMps));
  return {
    speedMps: round6(speedMps),
    speedMph: round6(speedMph),
    graphPosition: round6(graphPosition),
    graphValue: round6(graphValue),
    graphMph: round6(graphMph),
    graphMps: round6(graphMps),
    floorMps: round6(floorMps),
    floorApplied: graphMps > floorMps + 1e-9,
    minScrubMph,
    targetMps: round6(targetMps),
    targetSource: M2_BOOST_LABELS.targetSource,
    source: M2_BOOST_LABELS.source
  };
}

/** Every class target at a fire speed (the BOOST1 §4 tables). */
export function nitroClassTargetTable(keyframes, speedMps = M2_REFERENCE_SPRINT_SPEED_MPS,
  classModifiers = { A: 1, B: 0.95, C: 0.9, D: 0.85 }) {
  const rows = {};
  for (const letter of ['A', 'B', 'C', 'D']) {
    rows[letter] = nitroTargetForSpeed(keyframes, { speedMps, classLetter: letter, classModifiers });
  }
  return rows;
}

/** Read the two graphs and modifiers from the PWR1 manifest without re-typing. */
export function boostManifestValues(manifest) {
  const byId = new Map((manifest?.entities ?? []).map((entity) => [entity.id, entity]));
  const nitrous = byId.get('pickup.Nitrous')?.levels?.Normal;
  const shock = byId.get('pickup.Shock')?.levels?.Normal;
  if (!nitrous || !shock) throw new Error('PWR1 manifest is missing Nitrous/Shock Normal levels');
  return {
    nitro: {
      keyframes: keyframesFromLevel(nitrous),
      durationSeconds: nitrous.balancing.Duration,
      slowDownGraphValue: nitrous.balancing.SlowDownGraphValue,
      classModifiers: {
        A: nitrous.balancing.ClassAModifier,
        B: nitrous.balancing.ClassBModifier,
        C: nitrous.balancing.ClassCModifier,
        D: nitrous.balancing.ClassDModifier
      },
      maxBoost: nitrous.balancingGraph.maxBoost
    },
    shock: {
      keyframes: keyframesFromLevel(shock),
      innerRadius: shock.balancing.InnerRadius,
      outerRadius: shock.balancing.OuterRadius,
      lifetime: shock.balancing.Lifetime,
      damage: shock.balancing.DamageInflicted,
      delay: shock.balancing.Delay,
      heightDiff: shock.balancing.HeightDiff
    }
  };
}

// ---------------------------------------------------------------- queue model
//
// A pure mirror of the wasm semantics, used by the Node tests to prove queue,
// target, expiry, cap and determinism without a wasm build. It deliberately has
// no damping/tyre model: `dv = force/mass*dt` is enough to test the force
// window, target clamp and expiry.

export function createBoostQueueModel({
  mass = 1600,
  dt = 1 / TICK_HZ,
  speedMps = M2_REFERENCE_SPRINT_SPEED_MPS,
  maxEffects = 4
} = {}) {
  const effects = [];
  const model = {
    schema: BOOST_SCHEMA,
    tick: 0,
    speedMps,
    mass,
    dt,
    nextSeq: 0,
    effects,

    queue({ kind, startTick = model.tick, ticks, targetMps = 0, magnitude, direction = null }) {
      if (![1, 2, 3].includes(kind)) throw new Error('kind must be 1 (nitro), 2 (brake) or 3 (impulse)');
      if (!(startTick >= model.tick)) throw new Error('startTick is before the current tick');
      if (!(ticks > 0)) throw new Error('ticks must be > 0');
      if (!Number.isFinite(magnitude)) throw new Error('magnitude must be finite');
      if (kind !== 3) {
        if (!(targetMps > 0)) throw new Error('targetMps must be > 0');
        if (!(magnitude > 0)) throw new Error('magnitude must be > 0');
      }
      if (effects.filter((effect) => effect.active).length >= maxEffects) throw new Error('queue full');
      const effect = {
        seq: ++model.nextSeq,
        kind,
        startTick,
        ticks,
        targetMps,
        magnitude,
        direction: direction ? [...direction] : [0, 0, 0],
        active: true,
        applied: 0,
        forceTicks: 0,
        forceBudget: kind === 1 ? Math.min(ticks, M2_NITRO_ACCELERATING_BUDGET_TICKS) : -1
      };
      effects.push(effect);
      return effect.seq;
    },

    step() {
      for (const effect of effects) {
        if (!effect.active) continue;
        if (model.tick < effect.startTick) continue;
        if (model.tick >= effect.startTick + effect.ticks) {
          effect.active = false;
          continue;
        }
        effect.applied++;
        if (effect.kind === 1) {
          if (effect.forceBudget > 0 && model.speedMps < effect.targetMps) {
            const adjust = model.speedMps < effect.targetMps * 0.5 ? 2 : 1;
            const force = effect.magnitude * model.mass * adjust;
            model.speedMps = Math.min(effect.targetMps, model.speedMps + (force / model.mass) * model.dt);
            effect.forceTicks++;
          }
          if (effect.forceBudget > 0) effect.forceBudget--;
        } else if (effect.kind === 2) {
          if (model.speedMps > effect.targetMps) {
            const adjust = model.speedMps > effect.targetMps * 2 ? 2 : 1;
            model.speedMps = Math.max(effect.targetMps,
              model.speedMps - effect.magnitude * adjust * model.dt);
            effect.forceTicks++;
          }
        } else if (effect.kind === 3) {
          const [dx, dy, dz] = effect.direction;
          const length = Math.hypot(dx, dy, dz);
          if (!(length > 0)) throw new Error('impulse direction must be non-zero');
          model.speedMps = Math.max(0, model.speedMps + effect.magnitude / model.mass);
          effect.forceTicks++;
          effect.active = false;
        }
      }
      model.tick++;
      return model;
    },

    state() {
      const current = effects
        .filter((effect) => effect.seq > 0)
        .sort((a, b) => b.seq - a.seq)[0] ?? null;
      return {
        status: 'ok',
        tick: model.tick,
        active: current?.active === true,
        speedMps: round6(model.speedMps),
        seq: current?.seq ?? 0,
        kind: current?.kind ?? 0,
        startTick: current?.startTick ?? 0,
        ticks: current?.ticks ?? 0,
        remaining: current?.active ? Math.max(0, current.startTick + current.ticks - model.tick) : 0,
        applied: current?.applied ?? 0,
        forceTicks: current?.forceTicks ?? 0,
        targetMps: current?.targetMps ?? 0,
        magnitude: current?.magnitude ?? 0,
        queued: effects.filter((effect) => effect.active).length,
        effects: effects.map((effect) => ({ ...effect, direction: [...effect.direction] }))
      };
    }
  };
  return model;
}
