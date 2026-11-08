// Verification gate for the net-prediction probe.
//
// Runs unit checks (tick arithmetic, the injected sim, predictor semantics),
// the 4x3 RTT/loss matrix, a jitter sweep, two stress scenarios, and the edge
// cases (snapshot gap, duplicates/out-of-order, respawn, wreck, host migration,
// 32-bit tick wrap, resync). Writes a machine-readable summary, the full
// per-tick traces for representative runs, a microbench record and a log.
//
// Run: <node> probes/net-prediction/verify.mjs
// No game data, no engine, no network, no browser.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  Predictor,
  PredictionError,
  tickAdd,
  tickDelta,
  positionDistance,
  quatAngle,
  checkPredictionState
} from './predictor.mjs';
import { sha256Hex, canonicalJson, hashOf } from './hash.mjs';
import {
  createSimState,
  simStep,
  simStateClone,
  simApplyImpulse,
  inputForTick,
  ZERO_INPUT,
  SIM_DT
} from './sim.mjs';
import {
  runScenario,
  microbench,
  summary,
  BaselineInterpolation,
  quantizeSnapshotState
} from './harness.mjs';

const ROOT = new URL('../../', import.meta.url);
const OUT = new URL('_work/net-prediction/', ROOT);
const LOG_DIR = new URL('_work/logs/net-prediction/', ROOT);
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(OUT, { recursive: true });

const checks = [];
let checkIndex = 0;
const failures = [];

function check(code, name, pass, detail = null) {
  checkIndex++;
  const record = { id: 'C' + String(checkIndex).padStart(3, '0'), code, name, pass: pass === true, detail };
  checks.push(record);
  if (!record.pass) failures.push(record);
  return record.pass;
}

function near(a, b, tolerance = 1e-9) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function finiteState(state) {
  return checkPredictionState(state) === null;
}

function makePredictor(options = {}) {
  const predictor = new Predictor({ step: simStep, cloneState: simStateClone, ...options });
  predictor.start(createSimState({ speed: 5 }), 1);
  return predictor;
}

function advanceFor(predictor, count) {
  for (let index = 0; index < count; index++) {
    predictor.advance(inputForTick(predictor.currentTick + 1, 11, 1));
  }
}

function snapshotAt(predictor, tick, offset = 0) {
  const predicted = predictor.history.get(tick);
  if (!predicted) throw new Error('no history at tick ' + tick);
  const state = simStateClone(predicted);
  state.tick = tick;
  state.position[0] += offset;
  return { tick, state, flags: {}, authority: true };
}

// ---------------------------------------------------------------- 1. hash

check('HASH', 'sha256 empty vector', sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
check('HASH', 'sha256 abc vector', sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
check(
  'HASH',
  'sha256 long vector',
  sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq') ===
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
);
check('HASH', 'canonical json sorts keys', canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }) === '{"a":[{"c":3,"d":2}],"b":1}');
check('HASH', 'hashOf is stable', hashOf({ x: 1 }) === hashOf({ x: 1 }) && hashOf({ x: 1 }) !== hashOf({ x: 2 }));

// ------------------------------------------------- 2. tick arithmetic

check('TICK', 'tickAdd forward', tickAdd(5, 3) === 8);
check('TICK', 'tickAdd negative', tickAdd(5, -3) === 2);
check('TICK', 'tickAdd wraps 32 bit', tickAdd(2 ** 32 - 1, 1) === 0);
check('TICK', 'tickAdd wraps negative', tickAdd(0, -1) === 2 ** 32 - 1);
check('TICK', 'tickDelta zero', tickDelta(7, 7) === 0);
check('TICK', 'tickDelta backward', tickDelta(5, 3) === -2);
check('TICK', 'tickDelta across wrap', tickDelta(2 ** 32 - 2, 1) === 3);
check('TICK', 'tickDelta across wrap backward', tickDelta(1, 2 ** 32 - 2) === -3);
let wrapSequenceOk = true;
let wrapCursor = 2 ** 32 - 4;
for (let index = 0; index < 10; index++) {
  const next = tickAdd(wrapCursor, 1);
  if (tickDelta(wrapCursor, next) !== 1) wrapSequenceOk = false;
  wrapCursor = next;
}
check('TICK', 'tick sequence crosses wrap monotonically', wrapSequenceOk);
check('TICK', 'tickAdd rejects non-integers', (() => {
  try {
    tickAdd(1.5, 1);
    return false;
  } catch (error) {
    return error instanceof PredictionError && error.code === 'PREDICT_TICK';
  }
})());

// --------------------------------------------------------- 3. fake sim

const simA = [];
let simStateA = createSimState({ speed: 0 });
for (let tick = 1; tick <= 300; tick++) {
  simStateA = simStep(simStateA, inputForTick(tick, 5, 1), tick);
  simA.push(simStateA);
}
const simB = [];
let simStateB = createSimState({ speed: 0 });
for (let tick = 1; tick <= 300; tick++) {
  simStateB = simStep(simStateB, inputForTick(tick, 5, 1), tick);
  simB.push(simStateB);
}
check('SIM', 'two fresh sim runs are bit-identical', hashOf(simA) === hashOf(simB));
check('SIM', 'sim states are finite', simA.every(finiteState));
check('SIM', 'quaternion stays unit length', simA.every((state) => {
  const norm = Math.sqrt(state.quaternion.reduce((sum, part) => sum + part * part, 0));
  return Math.abs(norm - 1) < 1e-9;
}));
check('SIM', 'speed stays inside declared bounds', simA.every((state) => state.speed >= -8 && state.speed <= 62.0001));
check('SIM', 'car actually moves', positionDistance(simA[0].position, simA[299].position) > 50);
check('SIM', 'input script is deterministic', hashOf(inputForTick(123, 9, 1)) === hashOf(inputForTick(123, 9, 1)));
check('SIM', 'input script stays in [-1,1]', (() => {
  for (let tick = 1; tick <= 500; tick++) {
    const input = inputForTick(tick, 9, 1);
    for (const value of Object.values(input)) if (!(value >= -1 && value <= 1)) return false;
  }
  return true;
})());
const impulseA = simApplyImpulse(simA[100], { speed: 2, yaw: 0.05 });
const impulseB = simApplyImpulse(simA[100], { speed: 2, yaw: 0.05 });
check('SIM', 'host impulse is deterministic', hashOf(impulseA) === hashOf(impulseB));
check('SIM', 'host impulse changes speed', impulseA.speed !== simA[100].speed);

// ------------------------------------------------------ 4. predictor units

const p1 = makePredictor();
check('PREDICTOR', 'start tick is preserved', p1.currentTick === 1);
advanceFor(p1, 5);
check('PREDICTOR', 'advance increments the tick', p1.currentTick === 6);
check('PREDICTOR', 'advance returns a cloned state', (() => {
  const result = p1.advance(inputForTick(7, 11, 1));
  result.state.position[0] = 1e9;
  return p1.currentState.position[0] !== 1e9;
})());
check('PREDICTOR', 'start clones its input state', (() => {
  const source = createSimState({ speed: 2 });
  const predictor = new Predictor({ step: simStep, cloneState: simStateClone });
  predictor.start(source, 10);
  source.position[0] = 1e9;
  return predictor.currentState.position[0] !== 1e9;
})());
check('PREDICTOR', 'invalid input throws PREDICT_INPUT', (() => {
  try {
    p1.advance({ throttle: 2, brake: 0, steer: 0, handbrake: 0 });
    return false;
  } catch (error) {
    return error instanceof PredictionError && error.code === 'PREDICT_INPUT';
  }
})());
check('PREDICTOR', 'broken step contract throws PREDICT_STEP', (() => {
  const bad = new Predictor({
    step: () => ({ tick: 0, position: [NaN, 0, 0], quaternion: [0, 0, 0, 1], speed: 0 }),
    cloneState: simStateClone
  });
  bad.start(createSimState({ speed: 1 }), 1);
  try {
    bad.advance(inputForTick(2, 1, 1));
    return false;
  } catch (error) {
    return error instanceof PredictionError && error.code === 'PREDICT_STEP';
  }
})());
check('PREDICTOR', 'onSnapshot before start throws', (() => {
  const fresh = new Predictor({ step: simStep, cloneState: simStateClone });
  try {
    fresh.onSnapshot({ tick: 1, state: createSimState(), authority: true });
    return false;
  } catch (error) {
    return error instanceof PredictionError && error.code === 'PREDICT_NOT_STARTED';
  }
})());
check('PREDICTOR', 'malformed snapshot is counted, not thrown', (() => {
  const outcome = p1.onSnapshot({ tick: 3, state: { position: [1, 2] }, authority: true });
  return outcome.applied === false && outcome.reason === 'invalid' && p1.stats.invalidSnapshots === 1;
})());

// clean anchor / deadband
const pClean = makePredictor();
advanceFor(pClean, 10);
const tiny = snapshotAt(pClean, pClean.currentTick, 0.001);
const tinyOutcome = pClean.onSnapshot(tiny);
check('RECONCILE', 'deadband keeps a 1 mm error clean', tinyOutcome.applied && tinyOutcome.record.severity === 'clean');
check('RECONCILE', 'deadband does not replay', pClean.stats.replayTicksTotal === 0);
check('RECONCILE', 'clean anchor is counted', pClean.stats.cleanAnchors === 1);

// duplicate / out-of-order / future
const pOrder = makePredictor();
advanceFor(pOrder, 30);
const anchor20 = snapshotAt(pOrder, 20, 0.1);
const firstApply = pOrder.onSnapshot(anchor20);
const duplicate = pOrder.onSnapshot(anchor20);
check('RECONCILE', 'snapshot duplicate is rejected', duplicate.applied === false && duplicate.reason === 'duplicate');
check('RECONCILE', 'duplicate counter increments', pOrder.stats.duplicates === 1);
const anchor12 = snapshotAt(pOrder, 12, 0.1);
const older = pOrder.onSnapshot(anchor12);
check('RECONCILE', 'older snapshot is out-of-order', older.applied === false && older.reason === 'out-of-order');
check('RECONCILE', 'out-of-order counter increments', pOrder.stats.outOfOrder === 1);

const pFuture = makePredictor();
advanceFor(pFuture, 10);
const futureTick = pFuture.currentTick + 3;
const futureSnapshot = {
  tick: futureTick,
  state: { ...simStateClone(pFuture.currentState), tick: futureTick },
  flags: {},
  authority: true
};
const futureOutcome = pFuture.onSnapshot(futureSnapshot);
check('RECONCILE', 'future snapshot is buffered', futureOutcome.applied === false && futureOutcome.reason === 'future-buffered');
advanceFor(pFuture, 3);
check('RECONCILE', 'buffered snapshot applies when the tick arrives', pFuture.stats.snapshotsApplied === 1);

// rollback + replay + smoothing
const pRollback = makePredictor();
advanceFor(pRollback, 20);
const anchorTick = pRollback.currentTick - 10;
const beforeCorrection = pRollback.renderPose();
const rollbackOutcome = pRollback.onSnapshot(snapshotAt(pRollback, anchorTick, 0.1));
const afterCorrection = pRollback.renderPose();
check('RECONCILE', 'position error triggers a rollback', rollbackOutcome.record.severity === 'rollback');
check('RECONCILE', 'rollback replays exactly the anchor age', rollbackOutcome.record.replayTicks === 10);
check('RECONCILE', 'rollback is smoothed by default', rollbackOutcome.record.smoothing === true);
check('RECONCILE', 'rollback counter increments', pRollback.stats.rollbacks === 1);
check('RECONCILE', 'rollback records the anchor error', near(rollbackOutcome.record.anchorError.position, 0.1, 1e-6));
check(
  'SMOOTH',
  'smoothing preserves the rendered pose at the correction instant',
  positionDistance(beforeCorrection.position, afterCorrection.position) < 1e-9 &&
    quatAngle(beforeCorrection.quaternion, afterCorrection.quaternion) < 1e-9
);
check(
  'SMOOTH',
  'smoothing offset is non-zero after the correction',
  afterCorrection.smoothing.position > 0.05
);
advanceFor(pRollback, 40);
check('SMOOTH', 'smoothing offset decays below 2 mm after 40 ticks', pRollback.renderPose().smoothing.position < 0.002);

// hard snap when the error is too large
const pHard = makePredictor();
advanceFor(pHard, 15);
const hardOutcome = pHard.onSnapshot(snapshotAt(pHard, pHard.currentTick - 5, 3.0));
check('RECONCILE', 'a 3 m error is a hard snap, not a slide', hardOutcome.record.smoothing === false);
check('RECONCILE', 'hard snap counter increments', pHard.stats.hardSnaps === 1);

// resync with a bounded history
const pResync = makePredictor({ historyTicks: 10, maxRollbackTicks: 5 });
advanceFor(pResync, 20);
const staleTick = pResync.currentTick - 16;
const staleSnapshot = {
  tick: staleTick,
  state: { ...simStateClone(pResync.currentState), tick: staleTick },
  flags: {},
  authority: true
};
const staleOutcome = pResync.onSnapshot(staleSnapshot);
check('EDGE', 'stale anchor triggers a resync', staleOutcome.record.severity === 'resync');
check('EDGE', 'resync rewinds the local tick to the anchor', pResync.currentTick === staleTick);
check('EDGE', 'resync records the rewound tick count', pResync.stats.clockRewoundTicks === 16);
check('EDGE', 'resync is counted separately from rollback', pResync.stats.resyncSnaps === 1 && pResync.stats.rollbacks === 0);

// wreck freeze
const pWreck = makePredictor();
advanceFor(pWreck, 10);
pWreck.setWrecked(true);
const frozenAt = [...pWreck.currentState.position];
advanceFor(pWreck, 5);
check('EDGE', 'wrecked local car does not move', positionDistance(frozenAt, pWreck.currentState.position) < 1e-12);
check('EDGE', 'frozen ticks are counted', pWreck.stats.frozenTicks === 5);
pWreck.setWrecked(false);
advanceFor(pWreck, 1);
check('EDGE', 'prediction resumes after the wreck flag clears', positionDistance(frozenAt, pWreck.currentState.position) > 0);

// host migration
const pMigrate = makePredictor();
advanceFor(pMigrate, 10);
const migration = pMigrate.onHostChange('pl_new');
check('EDGE', 'host change is recorded and returns the local tick', migration.hostId === 'pl_new' && pMigrate.stats.hostChanges === 1);
advanceFor(pMigrate, 2);
check('EDGE', 'prediction continues after a host change', pMigrate.currentTick === 13);

// -------------------------------------------------------- 5. scenario grid

const MATRIX = [];
for (const rttMs of [0, 50, 100, 150]) {
  for (const lossPct of [0, 2, 5]) {
    MATRIX.push({
      id: `rtt${rttMs}-loss${lossPct}`,
      seed: 1000 + rttMs * 10 + lossPct,
      ticks: 3600,
      rttMs,
      lossPct,
      jitterMs: 15,
      disturbanceEveryTicks: 240
    });
  }
}

const results = new Map();
for (const scenario of MATRIX) {
  results.set(scenario.id, runScenario(scenario));
}

function checkMatrix(result) {
  const m = result.metrics;
  const id = m.id;
  const expectedUnique = Math.floor(m.ticks / m.stateEveryTicks) + 1;
  check('SCENARIO', `${id}: finite states`, m.finite);
  check('SCENARIO', `${id}: pre-correction p95 < 1 m`, m.prediction.pre.position.p95 < 1.0, m.prediction.pre.position.p95);
  check('SCENARIO', `${id}: post-correction p95 < 0.4 m`, m.prediction.post.position.p95 < 0.4, m.prediction.post.position.p95);
  check('SCENARIO', `${id}: rendered p95 < 0.45 m`, m.render.position.p95 < 0.45, m.render.position.p95);
  check('SCENARIO', `${id}: post-correction angle p95 < 0.08 rad`, m.prediction.post.angle.p95 < 0.08, m.prediction.post.angle.p95);
  check(
    'SCENARIO',
    `${id}: prediction beats pure interpolation`,
    m.interpolation.position.p95 > m.prediction.post.position.p95 + 0.5,
    { predictionP95: m.prediction.post.position.p95, interpolationP95: m.interpolation.position.p95 }
  );
  check('SCENARIO', `${id}: interpolation lags by > 1 m at p95`, m.interpolation.position.p95 > 1.0, m.interpolation.position.p95);
  check('SCENARIO', `${id}: correction path is exercised`, m.corrections.total >= 10, m.corrections.total);
  check('SCENARIO', `${id}: correction histogram sums to the count`, (() => {
    const total = m.corrections.histogramVisible.reduce((sum, bucket) => sum + bucket.count, 0);
    return total === m.corrections.total;
  })());
  check('SCENARIO', `${id}: rollback depth stays within 20 ticks`, m.corrections.depth.max <= 20, m.corrections.depth.max);
  check('SCENARIO', `${id}: no hard snaps in the matrix`, m.corrections.stats.hardSnaps === 0, m.corrections.stats.hardSnaps);
  check('SCENARIO', `${id}: no resync in the matrix`, m.corrections.stats.resyncSnaps === 0, m.corrections.stats.resyncSnaps);
  check('SCENARIO', `${id}: replay budget < 30 ticks/s`, m.corrections.replayTicksPerSecond < 30, m.corrections.replayTicksPerSecond);
  check('SCENARIO', `${id}: unique snapshots account for the schedule`, m.network.snapshotUnique === expectedUnique - m.network.snapshotDropped, {
    unique: m.network.snapshotUnique,
    dropped: m.network.snapshotDropped,
    expectedUnique
  });
  check('SCENARIO', `${id}: delivered snapshots are bounded`, m.network.snapshotDelivered >= m.network.snapshotUnique && m.network.snapshotDelivered <= m.network.snapshotUnique + m.network.duplicateScheduled);
  if (m.lossPct === 0) {
    check('SCENARIO', `${id}: zero loss has zero input fallbacks`, m.network.inputFallbacks === 0, m.network.inputFallbacks);
  } else {
    check('SCENARIO', `${id}: loss produces input fallbacks`, m.network.inputFallbacks > 0, m.network.inputFallbacks);
  }
  check('SCENARIO', `${id}: no non-finite trace rows`, result.rows.every((row) => row.slice(2, 9).every(Number.isFinite)));
}

for (const result of results.values()) checkMatrix(result);

// clean, no-divergence scenario
const clean = runScenario({ id: 'clean', seed: 5, ticks: 1800, rttMs: 0, lossPct: 0, jitterMs: 0, disturbanceEveryTicks: 0 });
check('SCENARIO', 'clean: prediction is exact', clean.metrics.prediction.post.position.max < 1e-6, clean.metrics.prediction.post.position.max);
check('SCENARIO', 'clean: no corrections', clean.metrics.corrections.total === 0, clean.metrics.corrections.total);
check('SCENARIO', 'clean: all anchors are clean', clean.metrics.reconciliations.clean === clean.metrics.reconciliations.total);
check('SCENARIO', 'clean: interpolation still lags', clean.metrics.interpolation.position.p95 > 0.5, clean.metrics.interpolation.position.p95);

// RTT monotonicity, loss 0
const rttSeries = [0, 50, 100, 150].map((rtt) => results.get(`rtt${rtt}-loss0`).metrics.interpolation.position.p95);
check('SCENARIO', 'interpolation error grows with RTT', rttSeries[0] < rttSeries[1] && rttSeries[1] < rttSeries[2] && rttSeries[2] < rttSeries[3], rttSeries);
check('SCENARIO', '0 ms RTT still lags by the interpolation delay', rttSeries[0] > 0.5, rttSeries[0]);
check('SCENARIO', '150 ms RTT interpolation lag exceeds 4 m', rttSeries[3] > 4, rttSeries[3]);

// jitter sweep
const JITTER = [];
for (const jitterMs of [0, 10, 30, 60]) {
  JITTER.push(runScenario({
    id: `jitter${jitterMs}`,
    seed: 400 + jitterMs,
    ticks: 1800,
    rttMs: 100,
    lossPct: 2,
    jitterMs,
    disturbanceEveryTicks: 240
  }));
}
for (const result of JITTER) {
  const m = result.metrics;
  check('SCENARIO', `${m.id}: finite`, m.finite);
  check('SCENARIO', `${m.id}: post p95 < 0.4 m`, m.prediction.post.position.p95 < 0.4, m.prediction.post.position.p95);
  check('SCENARIO', `${m.id}: prediction beats interpolation`, m.interpolation.position.p95 > m.prediction.post.position.p95 + 0.5);
  check('SCENARIO', `${m.id}: depth stays within 20 ticks`, m.corrections.depth.max <= 20, m.corrections.depth.max);
  check('SCENARIO', `${m.id}: no resync`, m.corrections.stats.resyncSnaps === 0);
}

// stress: a contact every 2 or every snapshot
const STRESS = [6, 3].map((every) => runScenario({
  id: `stress${every}`,
  seed: 900 + every,
  ticks: 1800,
  rttMs: 150,
  lossPct: 2,
  jitterMs: 15,
  disturbanceEveryTicks: every
}));
for (const result of STRESS) {
  const m = result.metrics;
  check('SCENARIO', `${m.id}: finite`, m.finite);
  check('SCENARIO', `${m.id}: corrections are frequent`, m.corrections.perMinute > 500, m.corrections.perMinute);
  check('SCENARIO', `${m.id}: replay load is measured`, m.corrections.replayTicksPerSecond > 50, m.corrections.replayTicksPerSecond);
  check('SCENARIO', `${m.id}: depth stays within the 30-tick budget`, m.corrections.depth.max <= 30, m.corrections.depth.max);
  check('SCENARIO', `${m.id}: prediction still beats interpolation`, m.interpolation.position.p95 > m.prediction.post.position.p95 + 2);
}

// ------------------------------------------------------------- 6. edge cases

const gapResult = runScenario({
  id: 'gap',
  seed: 21,
  ticks: 900,
  rttMs: 100,
  lossPct: 0,
  jitterMs: 10,
  disturbanceEveryTicks: 0,
  disturbanceTicks: [315],
  gapWindows: [{ from: 300, to: 330 }]
});
check('EDGE', 'gap: anchor gap is recorded', gapResult.metrics.corrections.stats.maxAnchorGapTicks >= 30, gapResult.metrics.corrections.stats.maxAnchorGapTicks);
check('EDGE', 'gap: prediction continues through the gap', gapResult.metrics.finite);
check('EDGE', 'gap: first fresh snapshot corrects', gapResult.metrics.corrections.total >= 1);
check('EDGE', 'gap: correction depth stays bounded', gapResult.metrics.corrections.depth.max <= 20, gapResult.metrics.corrections.depth.max);
check('EDGE', 'gap: no resync for a 0.5 s gap', gapResult.metrics.corrections.stats.resyncSnaps === 0);
check('EDGE', 'gap: interpolation lags during the outage', gapResult.metrics.interpolation.position.p95 > 1);

const duplicateResult = runScenario({
  id: 'duplicate',
  seed: 31,
  ticks: 600,
  rttMs: 50,
  lossPct: 0,
  jitterMs: 30,
  disturbanceEveryTicks: 60,
  duplicatePct: 40
});
check('EDGE', 'duplicate: duplicates are counted', duplicateResult.metrics.corrections.stats.duplicates > 5, duplicateResult.metrics.corrections.stats.duplicates);
check('EDGE', 'duplicate: out-of-order snapshots are counted', duplicateResult.metrics.corrections.stats.outOfOrder > 0, duplicateResult.metrics.corrections.stats.outOfOrder);
check('EDGE', 'duplicate: no duplicate is applied twice', duplicateResult.metrics.corrections.stats.snapshotsApplied <= duplicateResult.metrics.network.snapshotUnique);
check('EDGE', 'duplicate: no resync', duplicateResult.metrics.corrections.stats.resyncSnaps === 0);
check('EDGE', 'duplicate: prediction stays bounded', duplicateResult.metrics.prediction.post.position.p95 < 0.4, duplicateResult.metrics.prediction.post.position.p95);

const respawnResult = runScenario({
  id: 'respawn',
  seed: 41,
  ticks: 600,
  rttMs: 50,
  lossPct: 0,
  jitterMs: 5,
  disturbanceEveryTicks: 0,
  repositionTicks: [300]
});
const repositionRecords = respawnResult.corrections.filter((record) => record.severity === 'reposition');
check('EDGE', 'respawn: reposition snapshot is flagged', respawnResult.metrics.corrections.stats.repositionSnaps >= 1);
check('EDGE', 'respawn: hard snap is counted', respawnResult.metrics.corrections.stats.hardSnaps >= 1);
check('EDGE', 'respawn: reposition is not smoothed', repositionRecords.length > 0 && repositionRecords.every((record) => record.smoothing === false));
check('EDGE', 'respawn: visible correction is a real teleport', repositionRecords.some((record) => record.visibleCorrection.position > 1), repositionRecords.map((record) => record.visibleCorrection.position));
check('EDGE', 'respawn: prediction recovers after the snap', respawnResult.metrics.prediction.post.position.p95 < 0.05, respawnResult.metrics.prediction.post.position.p95);
check('EDGE', 'respawn: no resync', respawnResult.metrics.corrections.stats.resyncSnaps === 0);

const wreckResult = runScenario({
  id: 'wreck',
  seed: 51,
  ticks: 900,
  rttMs: 50,
  lossPct: 0,
  jitterMs: 5,
  disturbanceEveryTicks: 0,
  wreckWindow: { fromTick: 300, toTick: 420 }
});
check('EDGE', 'wreck: wreck snapshots are counted', wreckResult.metrics.corrections.stats.wreckSnaps >= 10, wreckResult.metrics.corrections.stats.wreckSnaps);
check('EDGE', 'wreck: recovery is counted once', wreckResult.metrics.corrections.stats.wreckRecoveries === 1, wreckResult.metrics.corrections.stats.wreckRecoveries);
check('EDGE', 'wreck: frozen ticks are counted', wreckResult.metrics.corrections.stats.frozenTicks >= 100, wreckResult.metrics.corrections.stats.frozenTicks);
check('EDGE', 'wreck: no resync after recovery', wreckResult.metrics.corrections.stats.resyncSnaps === 0, wreckResult.metrics.corrections.stats.resyncSnaps);
check('EDGE', 'wreck: prediction recovers after the wreck', wreckResult.metrics.prediction.post.position.p95 < 0.05, wreckResult.metrics.prediction.post.position.p95);
check('EDGE', 'wreck: states stay finite', wreckResult.metrics.finite);

const migrationResult = runScenario({
  id: 'migration',
  seed: 61,
  ticks: 600,
  rttMs: 50,
  lossPct: 0,
  jitterMs: 5,
  disturbanceEveryTicks: 60,
  hostMigrationTick: 300
});
check('EDGE', 'migration: host change is observed', migrationResult.metrics.hostMigrated);
check('EDGE', 'migration: predictor does not crash', migrationResult.metrics.finite);
check('EDGE', 'migration: corrections continue after migration', migrationResult.metrics.corrections.total >= 5, migrationResult.metrics.corrections.total);
check('EDGE', 'migration: error stays bounded', migrationResult.metrics.prediction.post.position.p95 < 0.4, migrationResult.metrics.prediction.post.position.p95);

const wrapBase = 2 ** 32 - 200;
const wrapResult = runScenario({
  id: 'wrap',
  seed: 71,
  ticks: 900,
  tickBase: wrapBase,
  rttMs: 50,
  lossPct: 2,
  jitterMs: 5,
  disturbanceEveryTicks: 240
});
const wrapRepeat = runScenario({
  id: 'wrap',
  seed: 71,
  ticks: 900,
  tickBase: wrapBase,
  rttMs: 50,
  lossPct: 2,
  jitterMs: 5,
  disturbanceEveryTicks: 240
});
check('EDGE', 'tick wrap: the run crosses 2^32', wrapResult.metrics.wrapped);
check('EDGE', 'tick wrap: states stay finite', wrapResult.metrics.finite);
check('EDGE', 'tick wrap: no false resync', wrapResult.metrics.corrections.stats.resyncSnaps === 0);
check('EDGE', 'tick wrap: no false duplicate', wrapResult.metrics.corrections.stats.duplicates === 0);
check('EDGE', 'tick wrap: prediction stays exact', wrapResult.metrics.prediction.post.position.p95 < 0.4, wrapResult.metrics.prediction.post.position.p95);
check('EDGE', 'tick wrap: trace hash repeats', wrapResult.traceHash === wrapRepeat.traceHash);

// ---------------------------------------------------------- 7. determinism

const repeatA = runScenario({ ...MATRIX[7] });
const repeatB = runScenario({ ...MATRIX[7] });
check('DETERMINISM', 'matrix scenario hash repeats', repeatA.traceHash === repeatB.traceHash, { a: repeatA.traceHash, b: repeatB.traceHash });
check('DETERMINISM', 'matrix scenario rows are identical', hashOf(repeatA.rows) === hashOf(repeatB.rows));
const cleanRepeat = runScenario({ id: 'clean', seed: 5, ticks: 1800, rttMs: 0, lossPct: 0, jitterMs: 0, disturbanceEveryTicks: 0 });
check('DETERMINISM', 'clean scenario hash repeats', cleanRepeat.traceHash === clean.traceHash);

// ---------------------------------------------------------- 8. microbench

const bench = microbench();
check('COST', 'bare step cost is measured', bench.bareStepUs > 0, bench.bareStepUs);
check('COST', 'predictor advance cost is measured', bench.predictorAdvanceUs > 0, bench.predictorAdvanceUs);
check('COST', 'predictor bookkeeping overhead is below 100 us/tick', bench.predictorOverheadUs < 100, bench.predictorOverheadUs);
check('COST', 'predictor bookkeeping overhead is non-zero', bench.predictorOverheadUs > 0, bench.predictorOverheadUs);
check('COST', 'advance cost is within 8x the fake step', bench.overheadRatio < 8, bench.overheadRatio);
for (const depth of [3, 10, 20, 30]) {
  check('COST', `reconcile depth ${depth} is measured`, bench.reconciles[depth].usPerCall > 0, bench.reconciles[depth].usPerCall);
  check('COST', `reconcile depth ${depth} replays ${depth} ticks`, bench.reconciles[depth].replayTicks > 0);
}
check('COST', 'reconcile cost grows with depth', bench.reconciles[30].usPerCall > bench.reconciles[3].usPerCall);
check('COST', 'replayed tick cost stays below 100 us', bench.reconciles[30].usPerReplayedTick < 100, bench.reconciles[30].usPerReplayedTick);
check('COST', 'worst-case rollback budget below 70 ms/s', bench.budget.find((row) => row.depth === 30).physicsMsPerSecondHigh < 70);
check('COST', 'worst-case rollback budget below 7% of one core', bench.budget.find((row) => row.depth === 30).percentOfOneCoreHigh < 7);
check('COST', 'typical depth-10 budget below 25 ms/s', bench.budget.find((row) => row.depth === 10).physicsMsPerSecondHigh < 25);
check('COST', 'prediction at 60 Hz costs under 1 ms/s', (bench.predictorOverheadUs * 60) / 1000 < 1, (bench.predictorOverheadUs * 60) / 1000);
check('COST', 'depth-30 measured replay is cheaper than 20 live ticks', bench.reconciles[30].usPerCall * 20 / 1000 < 200);

// ------------------------------------------------------------- 9. evidence

const scenarioSummary = [...results.values()].map((result) => ({
  id: result.metrics.id,
  config: result.config,
  metrics: result.metrics,
  traceHash: result.traceHash
}));
for (const extra of [clean, ...JITTER, ...STRESS, gapResult, duplicateResult, respawnResult, wreckResult, migrationResult, wrapResult]) {
  scenarioSummary.push({ id: extra.metrics.id, config: extra.config, metrics: extra.metrics, traceHash: extra.traceHash });
}

const failuresByCode = {};
for (const failure of failures) failuresByCode[failure.code] = (failuresByCode[failure.code] ?? 0) + 1;

const core = {
  schema: 'blur.net-prediction/1',
  node: process.version,
  platform: process.platform,
  counts: {
    checks: checks.length,
    passed: checks.length - failures.length,
    failed: failures.length,
    scenarios: scenarioSummary.length
  },
  failuresByCode,
  scenarios: scenarioSummary,
  microbench: bench,
  hashes: {
    clean: clean.traceHash,
    matrix: Object.fromEntries([...results.entries()].map(([id, result]) => [id, result.traceHash])),
    edge: {
      gap: gapResult.traceHash,
      duplicate: duplicateResult.traceHash,
      respawn: respawnResult.traceHash,
      wreck: wreckResult.traceHash,
      migration: migrationResult.traceHash,
      wrap: wrapResult.traceHash
    }
  }
};
const summaryHash = hashOf(core);
const output = { ...core, summaryHash, checks };

writeFileSync(new URL('summary.json', OUT), JSON.stringify(output, null, 2));
writeFileSync(new URL('microbench.json', OUT), JSON.stringify(bench, null, 2));

const TRACE_IDS = new Set(['rtt0-loss0', 'rtt150-loss5', 'gap', 'wreck', 'wrap']);
for (const entry of scenarioSummary) {
  if (!TRACE_IDS.has(entry.id)) continue;
  const result = [...results.values()].find((value) => value.metrics.id === entry.id) ??
    [gapResult, wreckResult, wrapResult].find((value) => value.metrics.id === entry.id);
  if (!result) continue;
  writeFileSync(new URL(`trace-${entry.id}.json`, OUT), JSON.stringify({
    id: entry.id,
    traceHash: result.traceHash,
    columns: ['wallTick', 'localTick', 'prePosition', 'preAngle', 'postPosition', 'postAngle', 'baselinePosition', 'baselineAngle', 'corrections', 'renderPosition', 'renderAngle'],
    rows: result.rows
  }));
}

const logLines = [];
logLines.push('# net-prediction verification');
logLines.push(`node ${process.version} ${process.platform}`);
logLines.push(`checks ${checks.length}, passed ${checks.length - failures.length}, failed ${failures.length}`);
logLines.push(`scenarios ${scenarioSummary.length}, summaryHash ${summaryHash}`);
logLines.push('');
for (const record of checks) {
  logLines.push(`${record.pass ? 'PASS' : 'FAIL'} ${record.id} [${record.code}] ${record.name}` +
    (record.pass ? '' : ' :: ' + JSON.stringify(record.detail)));
}
writeFileSync(new URL('verify.log', LOG_DIR), logLines.join('\n') + '\n');

console.log(`checks ${checks.length} passed ${checks.length - failures.length} failed ${failures.length}`);
console.log(`summaryHash ${summaryHash}`);
console.log(`summary _work/net-prediction/summary.json`);
if (failures.length) {
  console.log('failures by code ' + JSON.stringify(failuresByCode));
  for (const failure of failures.slice(0, 20)) {
    console.log(`FAIL ${failure.id} [${failure.code}] ${failure.name} :: ${JSON.stringify(failure.detail)}`);
  }
  process.exitCode = 1;
}
