// Deterministic network + authority simulation for the net-prediction probe.
//
// The harness does not touch a socket. It pre-computes three things from one
// seed:
//   1. the client input script (a pure function of tick);
//   2. the packet delivery schedule (loss, latency, jitter, duplicates, gaps);
//   3. the host-authoritative trajectory (inputs as the host received them,
//      including a fallback when an input packet missed its deadline, plus
//      host-only contact impulses, respawns and a wreck window).
// Then it runs the predictor at 60 Hz against that actor and compares four
// poses per tick: pre-correction prediction, post-correction prediction, a
// pure-interpolation view of the same authoritative snapshots, and the truth.
//
// It is deliberately one process with a simulated clock: results are exactly
// reproducible and independent of machine speed. CPU cost is measured
// separately (wall clock) and excluded from every hash.
//
// All tick arithmetic is wrap-aware (32-bit by default), so the same code runs
// across a counter wrap without special cases.

import {
  Predictor,
  positionDistance,
  quatAngle,
  quatNormalize,
  quatSlerp,
  tickAdd,
  tickDelta
} from './predictor.mjs';
import {
  SIM_TICK_HZ,
  ZERO_INPUT,
  simStep,
  simStateClone,
  simApplyImpulse,
  respawnPose,
  createSimState,
  hashUnit,
  inputForTick
} from './sim.mjs';
import { hashOf } from './hash.mjs';

export const DEFAULT_SCENARIO = Object.freeze({
  id: 'scenario',
  seed: 1,
  ticks: 3600,
  tickHz: SIM_TICK_HZ,
  tickBase: 1,
  wrapBits: 32,
  rttMs: 0,
  lossPct: 0,
  jitterMs: 0,
  snapshotHz: 20,
  duplicatePct: 0,
  inputLeadTicks: null,
  baselineDelayTicks: 3,
  disturbanceEveryTicks: 240,
  disturbanceTicks: [],
  disturbanceSpeed: 2.0,
  disturbanceYaw: 0.05,
  repositionTicks: [],
  repositionOffset: 8,
  wreckWindow: null,
  gapWindows: [],
  hostMigrationTick: null
});

const QUANT = Object.freeze({ position: 1e-4, quaternion: 1e-6, speed: 1e-4 });

function quantizeNumber(value, factor) {
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function quantizeSnapshotState(state) {
  const quaternion = quatNormalize(state.quaternion.map((part) => quantizeNumber(part, 1 / QUANT.quaternion)));
  return {
    tick: state.tick,
    position: state.position.map((part) => quantizeNumber(part, 1 / QUANT.position)),
    quaternion,
    speed: quantizeNumber(state.speed, 1 / QUANT.speed),
    heading: Array.isArray(state.heading) ? [...state.heading] : undefined
  };
}

export function summary(values) {
  if (!values.length) return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0, min: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  let sum = 0;
  for (const value of sorted) sum += value;
  return {
    count: sorted.length,
    mean: sum / sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    min: sorted[0]
  };
}

export const CORRECTION_BUCKETS = Object.freeze([0, 0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, Infinity]);

export function histogram(values, buckets = CORRECTION_BUCKETS) {
  const counts = new Array(buckets.length - 1).fill(0);
  for (const value of values) {
    let index = buckets.length - 2;
    for (let bucket = 0; bucket < buckets.length - 1; bucket++) {
      if (value >= buckets[bucket] && value < buckets[bucket + 1]) {
        index = bucket;
        break;
      }
    }
    counts[index]++;
  }
  return buckets.slice(0, -1).map((low, index) => ({
    low,
    high: buckets[index + 1],
    count: counts[index]
  }));
}

function modulo(value, wrapBits) {
  const modulus = 2 ** wrapBits;
  let result = value % modulus;
  if (result < 0) result += modulus;
  return result;
}

/** arrival <= current in modular tick order (fractional arrivals allowed). */
function dueAt(current, arrival, wrapBits) {
  const modulus = 2 ** wrapBits;
  let delta = (current - arrival) % modulus;
  if (delta < 0) delta += modulus;
  if (delta > modulus / 2) delta -= modulus;
  return delta >= 0;
}

/** `value` relative to `origin` in [0, modulus). Sort key for wrapped arrivals. */
function orderKey(value, origin, wrapBits) {
  return modulo(value - origin, wrapBits);
}

function withinRange(tick, from, to, wrapBits) {
  return tickDelta(from, tick, wrapBits) >= 0 && tickDelta(tick, to, wrapBits) >= 0;
}

/** Pure-interpolation baseline: lerp/slerp between received snapshots, no prediction. */
export class BaselineInterpolation {
  constructor({ maxSamples = 600, wrapBits = 32 } = {}) {
    this.states = new Map();
    this.keys = [];
    this.keyToTick = new Map();
    this.maxSamples = maxSamples;
    this.wrapBits = wrapBits;
    this.reference = null;
  }

  _key(tick) {
    if (this.reference === null) return tick;
    return tickDelta(this.reference, tick, this.wrapBits);
  }

  add(state) {
    if (this.reference === null) this.reference = state.tick;
    const key = this._key(state.tick);
    if (this.states.has(key)) return false;
    this.states.set(key, state);
    this.keyToTick.set(key, state.tick);
    let low = 0;
    let high = this.keys.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.keys[middle] < key) low = middle + 1;
      else high = middle;
    }
    this.keys.splice(low, 0, key);
    while (this.keys.length > this.maxSamples) {
      const removed = this.keys.shift();
      this.states.delete(removed);
      this.keyToTick.delete(removed);
    }
    return true;
  }

  latest() {
    return this.keys.length ? this.states.get(this.keys[this.keys.length - 1]) : null;
  }

  sample(renderTick) {
    if (!this.keys.length || !Number.isFinite(renderTick)) return null;
    const key = this._key(renderTick);
    if (this.states.has(key)) {
      return { ...this.states.get(key), interpolated: false, clamped: false };
    }
    let low = 0;
    let high = this.keys.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.keys[middle] < key) low = middle + 1;
      else high = middle;
    }
    if (low === 0) {
      return { ...this.states.get(this.keys[0]), interpolated: false, clamped: true };
    }
    if (low >= this.keys.length) {
      return { ...this.states.get(this.keys[this.keys.length - 1]), interpolated: false, clamped: true };
    }
    const a = this.states.get(this.keys[low - 1]);
    const b = this.states.get(this.keys[low]);
    const alpha = (key - this.keys[low - 1]) / (this.keys[low] - this.keys[low - 1]);
    return {
      tick: renderTick,
      position: [
        a.position[0] + (b.position[0] - a.position[0]) * alpha,
        a.position[1] + (b.position[1] - a.position[1]) * alpha,
        a.position[2] + (b.position[2] - a.position[2]) * alpha
      ],
      quaternion: quatSlerp(a.quaternion, b.quaternion, alpha),
      speed: a.speed + (b.speed - a.speed) * alpha,
      interpolated: true,
      clamped: false,
      alpha
    };
  }
}

function snapshotFlagsFor(tick, config, repositionEvents, recoverySnapshotTick, wrapBits) {
  const flags = {};
  if (config.wreckWindow) {
    const { fromTick, toTick } = config.wreckWindow;
    if (withinRange(tick, fromTick, toTick, wrapBits)) flags.wrecked = true;
  }
  if (recoverySnapshotTick !== null && tick === recoverySnapshotTick) {
    flags.reposition = true;
    flags.respawn = true;
    flags.wrecked = false;
  }
  for (const eventTick of repositionEvents) {
    const delta = tickDelta(eventTick, tick, wrapBits);
    if (delta >= 0 && delta < 3) {
      flags.reposition = true;
      flags.respawn = true;
    }
  }
  return flags;
}

/**
 * Run one scenario. `config` is DEFAULT_SCENARIO-shaped. Returns metrics, the
 * compact per-tick trace, the reconciliation records and the trace hash.
 */
export function runScenario(options = {}) {
  const config = { ...DEFAULT_SCENARIO, ...options };
  const {
    seed, ticks, tickHz, tickBase, wrapBits, rttMs, lossPct, jitterMs,
    snapshotHz, duplicatePct, baselineDelayTicks
  } = config;

  if (!(ticks > 0)) throw new Error('ticks must be positive');
  if (!(snapshotHz > 0) || snapshotHz > tickHz) throw new Error('snapshotHz must be in (0, tickHz]');
  const dt = 1 / tickHz;
  const oneWayTicks = (rttMs / 1000) * tickHz / 2;
  const jitterTicks = (jitterMs / 1000) * tickHz;
  const stateEvery = Math.max(1, Math.round(tickHz / snapshotHz));
  const lead = config.inputLeadTicks ??
    Math.min(16, Math.max(1, Math.ceil(oneWayTicks + jitterTicks) + 1));

  const tickLabels = [];
  let cursor = tickBase;
  for (let index = 0; index <= ticks; index++) {
    tickLabels.push(cursor);
    cursor = tickAdd(cursor, 1, wrapBits);
  }
  const endTick = tickLabels[ticks];
  const initial = createSimState({ x: 0, y: 0, z: 0, speed: 0, heading: [1, 0] });
  initial.tick = tickBase;

  // ---------------------------------------------------- 1. input schedule
  const inputPackets = new Map();
  for (let index = 1; index <= ticks; index++) {
    const tick = tickLabels[index];
    const dropped = hashUnit(seed, 0x1101, tick) < lossPct / 100;
    const jitter = (hashUnit(seed, 0x1102, tick) * 2 - 1) * jitterTicks;
    inputPackets.set(tick, { tick, dropped, arrival: modulo(tick + oneWayTicks + jitter, wrapBits) });
  }

  // ------------------------------------- 2. host-authoritative trajectory
  const truth = new Map();
  truth.set(tickBase, initial);
  const inputFallbacks = [];
  const repositionEvents = [];
  let lastApplied = { ...ZERO_INPUT };
  let state = initial;
  let wreckFrozen = null;
  let recoveryTick = null;
  let recoverySnapshotTick = null;

  if (config.wreckWindow) {
    recoveryTick = tickAdd(config.wreckWindow.toTick, 1, wrapBits);
    const offset = tickDelta(tickBase, recoveryTick, wrapBits);
    const snapped = Math.ceil(offset / stateEvery) * stateEvery;
    recoverySnapshotTick = tickAdd(tickBase, snapped, wrapBits);
    if (tickDelta(recoverySnapshotTick, endTick, wrapBits) < 0) recoverySnapshotTick = null;
  }

  for (let index = 1; index <= ticks; index++) {
    const tick = tickLabels[index];
    const packet = inputPackets.get(tick);
    const deadline = tickAdd(tick, lead, wrapBits);
    let input;
    if (!packet.dropped && dueAt(deadline, packet.arrival, wrapBits)) {
      input = inputForTick(tick, seed, tickBase);
      lastApplied = input;
    } else {
      input = lastApplied;
      inputFallbacks.push(tick);
    }

    let next = simStep(state, input, tick);
    next.tick = tick;

    const explicitDisturbance = config.disturbanceTicks.includes(tick);
    const periodicDisturbance = config.disturbanceEveryTicks > 0 &&
      tickDelta(tickBase, tick, wrapBits) % config.disturbanceEveryTicks === 0;
    if (explicitDisturbance || periodicDisturbance) {
      const signSpeed = hashUnit(seed, 0x2201, tick) < 0.5 ? -1 : 1;
      const signYaw = hashUnit(seed, 0x2202, tick) < 0.5 ? -1 : 1;
      next = simApplyImpulse(next, {
        speed: signSpeed * config.disturbanceSpeed,
        yaw: signYaw * config.disturbanceYaw
      });
      next.tick = tick;
    }

    if (config.wreckWindow && withinRange(tick, config.wreckWindow.fromTick, config.wreckWindow.toTick, wrapBits)) {
      if (wreckFrozen === null) {
        wreckFrozen = simStateClone(next);
        wreckFrozen.speed = 0;
      }
      next = simStateClone(wreckFrozen);
      next.tick = tick;
    } else if (config.wreckWindow && tick === recoveryTick) {
      next = respawnPose(next, 6);
      next.tick = tick;
      repositionEvents.push(tick);
    } else if (config.repositionTicks.includes(tick)) {
      next = respawnPose(next, config.repositionOffset);
      next.tick = tick;
      repositionEvents.push(tick);
    }

    state = next;
    truth.set(tick, state);
  }

  // ------------------------------------------------------- 3. snapshots
  let snapshotSeq = 0;
  const packets = [];
  let snapshotSent = 0;
  let snapshotDropped = 0;
  let duplicateScheduled = 0;
  for (let index = 0; index <= ticks; index += stateEvery) {
    const tick = tickLabels[index];
    const flags = snapshotFlagsFor(tick, config, repositionEvents, recoverySnapshotTick, wrapBits);
    let inGap = false;
    for (const gap of config.gapWindows) {
      if (withinRange(tick, gap.from, gap.to, wrapBits)) {
        inGap = true;
        break;
      }
    }
    const dropped = inGap || hashUnit(seed, 0x3301, tick) < lossPct / 100;
    const jitter = (hashUnit(seed, 0x3302, tick) * 2 - 1) * jitterTicks;
    const arrival = modulo(tick + lead + oneWayTicks + jitter, wrapBits);
    const packet = {
      tick,
      seq: ++snapshotSeq,
      state: quantizeSnapshotState(truth.get(tick)),
      flags,
      dropped,
      arrival,
      authority: true
    };
    if (dropped) {
      snapshotDropped++;
    } else {
      snapshotSent++;
      packets.push(packet);
      if (hashUnit(seed, 0x3303, tick) < duplicatePct / 100) {
        duplicateScheduled++;
        packets.push({
          ...packet,
          seq: ++snapshotSeq,
          duplicateOf: packet.seq,
          arrival: modulo(arrival + 1.5 + hashUnit(seed, 0x3304, tick) * 1.5, wrapBits)
        });
      }
    }
  }
  packets.sort((a, b) => {
    const keyA = orderKey(a.arrival, tickBase, wrapBits);
    const keyB = orderKey(b.arrival, tickBase, wrapBits);
    return (keyA - keyB) || (a.seq - b.seq);
  });

  // -------------------------------------------------------- 4. client run
  const corrections = [];
  const predictor = new Predictor({
    step: simStep,
    cloneState: simStateClone,
    tickHz,
    wrapBits,
    onReconcile: (record) => corrections.push(record)
  });
  predictor.start(truth.get(tickBase), tickBase);
  const baseline = new BaselineInterpolation({ wrapBits });
  const rows = [];
  const prePositions = [];
  const preAngles = [];
  const postPositions = [];
  const postAngles = [];
  const baselinePositions = [];
  const baselineAngles = [];
  const renderPositions = [];
  const renderAngles = [];
  let deliveryIndex = 0;
  let deliveredSnapshots = 0;
  let hostMigrated = false;
  let finite = true;
  let wrapped = false;
  let correctionsThisTick = 0;
  let lastCorrectionCount = 0;
  let migrationDue = config.hostMigrationTick !== null;
  const startedAt = performance.now();

  for (let index = 1; index <= ticks; index++) {
    const wall = tickLabels[index];
    if (!hostMigrated && migrationDue && tickDelta(config.hostMigrationTick, wall, wrapBits) >= 0) {
      predictor.onHostChange('pl_migrated');
      hostMigrated = true;
    }

    const localTick = tickAdd(predictor.currentTick, 1, wrapBits);
    predictor.advance(inputForTick(localTick, seed, tickBase));

    const before = predictor.currentState;
    const current = predictor.currentTick;
    const truthState = truth.get(current);
    if (!truthState) {
      finite = false;
      break;
    }
    const prePosition = positionDistance(before.position, truthState.position);
    const preAngle = quatAngle(before.quaternion, truthState.quaternion);
    prePositions.push(prePosition);
    preAngles.push(preAngle);

    while (deliveryIndex < packets.length && dueAt(wall, packets[deliveryIndex].arrival, wrapBits)) {
      const packet = packets[deliveryIndex++];
      let skip = false;
      for (const gap of config.gapWindows) {
        if (withinRange(packet.tick, gap.from, gap.to, wrapBits)) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      deliveredSnapshots++;
      baseline.add(packet.state);
      predictor.onSnapshot({ tick: packet.tick, state: packet.state, flags: packet.flags, authority: true });
    }

    const after = predictor.currentState;
    const correctedTick = predictor.currentTick;
    const correctedTruth = truth.get(correctedTick);
    if (!correctedTruth) {
      finite = false;
      break;
    }
    const postPosition = positionDistance(after.position, correctedTruth.position);
    const postAngle = quatAngle(after.quaternion, correctedTruth.quaternion);
    postPositions.push(postPosition);
    postAngles.push(postAngle);

    const rendered = predictor.renderPose();
    const renderPosition = positionDistance(rendered.position, correctedTruth.position);
    const renderAngle = quatAngle(rendered.quaternion, correctedTruth.quaternion);
    renderPositions.push(renderPosition);
    renderAngles.push(renderAngle);

    const renderTick = tickAdd(correctedTick, -baselineDelayTicks, wrapBits);
    const sample = baseline.sample(renderTick) ?? truth.get(tickBase);
    const basePosition = positionDistance(sample.position, correctedTruth.position);
    const baseAngle = quatAngle(sample.quaternion, correctedTruth.quaternion);
    baselinePositions.push(basePosition);
    baselineAngles.push(baseAngle);

    correctionsThisTick = corrections.length - lastCorrectionCount;
    lastCorrectionCount = corrections.length;
    if (wall < tickLabels[index - 1]) wrapped = true;
    if (!Number.isFinite(prePosition) || !Number.isFinite(postPosition) || !Number.isFinite(basePosition)) {
      finite = false;
    }
    rows.push([
      wall,
      correctedTick,
      Math.round(prePosition * 1e9) / 1e9,
      Math.round(preAngle * 1e9) / 1e9,
      Math.round(postPosition * 1e9) / 1e9,
      Math.round(postAngle * 1e9) / 1e9,
      Math.round(basePosition * 1e9) / 1e9,
      Math.round(baseAngle * 1e9) / 1e9,
      correctionsThisTick,
      Math.round(renderPosition * 1e9) / 1e9,
      Math.round(renderAngle * 1e9) / 1e9
    ]);
  }
  const wallMs = performance.now() - startedAt;

  const stats = predictor.statsView();
  const correctedRecords = corrections.filter((record) => record.severity !== 'clean');
  const anchorErrors = correctedRecords.map((record) => record.anchorError.position);
  const visibleCorrections = correctedRecords.map((record) => record.visibleCorrection.position);
  const depths = correctedRecords.map((record) => record.age).filter((age) => age > 0);
  const severityCounts = {};
  for (const record of corrections) severityCounts[record.severity] = (severityCounts[record.severity] ?? 0) + 1;

  const metrics = {
    id: config.id,
    seed,
    ticks,
    tickBase,
    rttMs,
    lossPct,
    jitterMs,
    snapshotHz,
    duplicatePct,
    inputLeadTicks: lead,
    stateEveryTicks: stateEvery,
    baselineDelayTicks,
    disturbanceEveryTicks: config.disturbanceEveryTicks,
    durationSeconds: ticks / tickHz,
    finite,
    wrapped,
    hostMigrated,
    prediction: {
      pre: { position: summary(prePositions), angle: summary(preAngles) },
      post: { position: summary(postPositions), angle: summary(postAngles) }
    },
    render: {
      position: summary(renderPositions),
      angle: summary(renderAngles)
    },
    interpolation: {
      position: summary(baselinePositions),
      angle: summary(baselineAngles)
    },
    reconciliations: {
      total: corrections.length,
      clean: severityCounts.clean ?? 0,
      corrected: correctedRecords.length,
      severity: severityCounts
    },
    corrections: {
      total: correctedRecords.length,
      severity: severityCounts,
      stats,
      anchorErrorPosition: summary(anchorErrors),
      visibleCorrectionPosition: summary(visibleCorrections),
      depth: summary(depths),
      histogramAnchor: histogram(anchorErrors),
      histogramVisible: histogram(visibleCorrections),
      perMinute: correctedRecords.length / (ticks / tickHz) * 60,
      replayTicksPerSecond: stats.replayTicksTotal / (ticks / tickHz)
    },
    network: {
      inputPackets: ticks,
      inputFallbacks: inputFallbacks.length,
      inputFallbackRate: inputFallbacks.length / ticks,
      snapshotUnique: snapshotSent,
      snapshotDropped,
      snapshotDelivered: deliveredSnapshots,
      duplicateScheduled,
      gapWindows: config.gapWindows,
      repositionTicks: config.repositionTicks,
      wreckWindow: config.wreckWindow,
      hostMigrationTick: config.hostMigrationTick
    },
    cpu: { simulatedWallMs: wallMs, usPerTick: (wallMs * 1000) / Math.max(1, rows.length) }
  };

  const trace = {
    id: config.id,
    hashConfig: {
      id: config.id,
      seed,
      ticks,
      tickBase,
      wrapBits,
      rttMs,
      lossPct,
      jitterMs,
      snapshotHz,
      duplicatePct,
      inputLeadTicks: lead,
      baselineDelayTicks,
      disturbanceEveryTicks: config.disturbanceEveryTicks,
      disturbanceTicks: config.disturbanceTicks,
      disturbanceSpeed: config.disturbanceSpeed,
      disturbanceYaw: config.disturbanceYaw,
      repositionTicks: config.repositionTicks,
      repositionOffset: config.repositionOffset,
      wreckWindow: config.wreckWindow,
      gapWindows: config.gapWindows,
      hostMigrationTick: config.hostMigrationTick
    },
    rows
  };
  const traceHash = hashOf(trace);
  return { config: trace.hashConfig, metrics, traceHash, rows, corrections };
}

// ---------------------------------------------------------------- microbench

function nowMs() {
  return performance.now();
}

function bench(label, iterations, fn) {
  for (let index = 0; index < Math.min(200, iterations); index++) fn(index);
  const start = nowMs();
  for (let index = 0; index < iterations; index++) fn(index);
  const elapsed = nowMs() - start;
  return { label, iterations, elapsedMs: elapsed, usPerCall: (elapsed * 1000) / iterations };
}

/**
 * CPU-cost probe. Shapes the same work the integration will do:
 *   * bareStep: injected physics only;
 *   * advance: predictor bookkeeping + one step;
 *   * reconcile(depth): rollback + replay of `depth` ticks triggered by one
 *     snapshot, measured over repeated anchors;
 *   * smoothing: the per-tick visual decay cost (part of advance).
 */
export function microbench({ step = simStep, cloneState = simStateClone, tickHz = SIM_TICK_HZ } = {}) {
  const baseTick = 1;
  const createPredictor = () => {
    const predictor = new Predictor({ step, cloneState, tickHz, smoothing: true });
    predictor.start(createSimState({ speed: 4 }), baseTick);
    return predictor;
  };

  const bare = bench('bareStep', 120000, (index) => {
    step(createSimState({ speed: 8 }), inputForTick(baseTick + index, 77, baseTick), baseTick + index);
  });

  const advancePredictor = createPredictor();
  const advance = bench('predictorAdvance', 120000, () => {
    advancePredictor.advance(inputForTick(advancePredictor.currentTick + 1, 77, baseTick));
  });

  const reconciles = {};
  for (const depth of [3, 10, 20, 30]) {
    const predictor = createPredictor();
    const iterations = Math.max(300, Math.ceil(12000 / depth));
    for (let index = 0; index < depth + 2; index++) {
      predictor.advance(inputForTick(predictor.currentTick + 1, 78, baseTick));
    }
    const result = bench('reconcileDepth' + depth, iterations, () => {
      const anchor = predictor.currentTick - depth;
      const predicted = predictor.history.get(anchor);
      if (!predicted) throw new Error('microbench anchor missing at depth ' + depth);
      const authority = cloneState(predicted);
      authority.position[0] += 0.05;
      predictor.onSnapshot({ tick: anchor, state: authority, flags: {}, authority: true });
      for (let index = 0; index < depth; index++) {
        predictor.advance(inputForTick(predictor.currentTick + 1, 79, baseTick));
      }
    });
    reconciles[depth] = {
      ...result,
      usPerReplayedTick: (result.elapsedMs * 1000) / (result.iterations * depth),
      replayTicks: result.iterations * depth
    };
  }

  return {
    tickHz,
    bareStepUs: bare.usPerCall,
    predictorAdvanceUs: advance.usPerCall,
    predictorOverheadUs: advance.usPerCall - bare.usPerCall,
    overheadRatio: advance.usPerCall / bare.usPerCall,
    reconciles,
    // Reference cost of the real wasm step from
    // docs/work/analysis/e1-drive-slice.md §4: 300 ticks in 24-32 ms.
    physicsCostMsPerTick: { low: 24 / 300, high: 32 / 300 },
    budget: [3, 10, 20, 30].map((depth) => ({
      depth,
      snapshotsPerSecond: 20,
      replayTicksPerSecond: 20 * depth,
      physicsMsPerSecondLow: 20 * depth * (24 / 300),
      physicsMsPerSecondHigh: 20 * depth * (32 / 300),
      percentOfOneCoreLow: (20 * depth * (24 / 300)) / 10,
      percentOfOneCoreHigh: (20 * depth * (32 / 300)) / 10
    }))
  };
}

export { tickDelta };
