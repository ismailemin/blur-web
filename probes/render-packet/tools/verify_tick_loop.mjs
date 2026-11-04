// Tick-loop gate: prove the consumer's fixed-step driver is the project's driver.
//
// The reference implementation is probes/scheduler-probe (native + wasm + Python).
// This tool replays that probe's recorded per-frame deltas through
// web/fixed-step.js — the exact module the browser consumer runs — and requires
// every summary counter to match with no tolerance.
//
// Usage: node probes/render-packet/tools/verify_tick_loop.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixedStepDriver, FLAG, DEFAULT_CONFIG } from '../web/fixed-step.js';
import { interpolateRigid, isRigid, matrixChecksum } from '../web/interpolate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, '_work/render-packet');
const NATIVE_EXE = path.join(ROOT, '_work/build/scheduler-probe-native/Release/scheduler_probe.exe');
mkdirSync(OUT, { recursive: true });

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(label + (detail ? ': ' + detail : ''));
};

// --------------------------------------------------- reference data from the probe

let referencePath = path.join(ROOT, '_work/scheduler-probe/native.json');
let referenceSource = 'existing';
if (existsSync(NATIVE_EXE)) {
  referencePath = path.join(OUT, 'tick-loop-native.json');
  execFileSync(NATIVE_EXE, ['--out', referencePath, '--no-frames', '--quiet'], { cwd: ROOT, stdio: 'pipe' });
  referenceSource = 'regenerated';
}
if (!existsSync(referencePath)) {
  console.error('missing reference: run `python probes/scheduler-probe/tests/run_scheduler_probe.py` once, or build the native probe.');
  process.exit(2);
}

// `--no-frames` omits frameDeltas, so read the recorded suite when the per-frame
// trace is what we need. Regenerate with frames when the native tool exists.
if (referenceSource === 'regenerated') {
  execFileSync(NATIVE_EXE, ['--out', referencePath, '--quiet'], { cwd: ROOT, stdio: 'pipe' });
}
const native = JSON.parse(readFileSync(referencePath, 'utf8'));
check('reference config', native.config.stepHz === 60 && native.config.maxTicksPerFrame === 4 && native.config.pauseThresholdUs === 250000,
  JSON.stringify(native.config));

// ---------------------------------------------------------------- replay

const summaryKeys = [
  'totalTicks', 'totalRequestedTicks', 'maxTicksInFrame', 'cappedFrames', 'pausedFrames',
  'zeroTickFrames', 'rewindFrames', 'backlogDropFrames', 'backlogDropTicks', 'finalAccUnits',
  'finalAlphaNum', 'finalAlphaDen'
];

function replay(scenario) {
  const driver = new FixedStepDriver({ dropBacklog: scenario.dropBacklog });
  let maxTicksInFrame = 0;
  let rewindFrames = 0;
  let backlogDropTicks = 0;
  let totalTicks = 0;
  let totalRequestedTicks = 0;
  let pausedFrames = 0;
  let cappedFrames = 0;
  let zeroTickFrames = 0;
  let backlogDropFrames = 0;
  for (const dtUs of scenario.frameDeltas) {
    const sample = driver.advanceBy(dtUs);
    totalTicks += sample.ticks;
    totalRequestedTicks += sample.requestedTicks;
    maxTicksInFrame = Math.max(maxTicksInFrame, sample.ticks);
    if (sample.flags & FLAG.CAPPED) cappedFrames++;
    if (sample.flags & FLAG.PAUSED) pausedFrames++;
    if (sample.flags & FLAG.ZERO_TICK) zeroTickFrames++;
    if (sample.flags & FLAG.DT_REWIND) rewindFrames++;
    if (sample.flags & FLAG.BACKLOG_DROP) { backlogDropFrames++; backlogDropTicks += sample.droppedTicks; }
  }
  const alpha = driver.alpha({ accUnits: driver.accUnits });
  return {
    frames: scenario.frameDeltas.length,
    totalTicks,
    totalRequestedTicks,
    maxTicksInFrame,
    cappedFrames,
    pausedFrames,
    zeroTickFrames,
    rewindFrames,
    backlogDropFrames,
    backlogDropTicks,
    finalAccUnits: driver.accUnits,
    finalAlphaNum: alpha.numerator,
    finalAlphaDen: alpha.denominator
  };
}

const scenarios = [];
for (const scenario of native.scenarios) {
  if (!Array.isArray(scenario.frameDeltas)) {
    failures.push('scenario ' + scenario.name + ' has no frameDeltas; regenerate the reference with frames');
    continue;
  }
  const actual = replay(scenario);
  const mismatches = [];
  for (const key of summaryKeys) {
    if (key === 'finalAlphaNum' || key === 'finalAlphaDen') continue;
    if (actual[key] !== scenario[key]) mismatches.push(key + ' expected ' + scenario[key] + ' got ' + actual[key]);
  }
  // Alpha is an exact fraction; compare as num/den rather than as a float.
  const expectedAlpha = scenario.finalAlphaNum / scenario.finalAlphaDen;
  const actualAlpha = actual.finalAlphaNum / actual.finalAlphaDen;
  if (Math.abs(expectedAlpha - actualAlpha) > 0) {
    mismatches.push('alpha expected ' + expectedAlpha + ' got ' + actualAlpha);
  }
  check('scenario ' + scenario.name, mismatches.length === 0, mismatches.join('; '));
  scenarios.push({ name: scenario.name, note: scenario.note, frames: actual.frames, dropBacklog: scenario.dropBacklog, matches: mismatches.length === 0, expected: { totalTicks: scenario.totalTicks, cappedFrames: scenario.cappedFrames, pausedFrames: scenario.pausedFrames, backlogDropFrames: scenario.backlogDropFrames, finalAccUnits: scenario.finalAccUnits }, actual, mismatches });
}

// --------------------------------------------------- driver shape assertions

{
  const driver = new FixedStepDriver();
  const baseline = driver.advanceTo(1000000);
  check('first advanceTo is a baseline', baseline.flags & FLAG.BASELINE && baseline.ticks === 0, 'flags ' + baseline.flags);
  const next = driver.advanceTo(1016667);
  check('one 16.667 ms frame is one tick', next.ticks === 1, 'ticks ' + next.ticks);
  const capped = new FixedStepDriver().advanceBy(100000);
  check('a 100 ms frame requests six ticks and runs four', capped.requestedTicks === 6 && capped.ticks === 4 && (capped.flags & FLAG.CAPPED) !== 0,
    'requested ' + capped.requestedTicks + ' ticks ' + capped.ticks);
  const paused = new FixedStepDriver().advanceBy(250001);
  check('250 ms + 1 us is a pause with zero ticks', paused.ticks === 0 && paused.flags & FLAG.PAUSED, 'flags ' + paused.flags);
  const boundary = new FixedStepDriver().advanceBy(DEFAULT_CONFIG.pauseThresholdUs);
  check('exactly 250 ms is not a pause', !(boundary.flags & FLAG.PAUSED), 'flags ' + boundary.flags);
  const rewind = new FixedStepDriver().advanceBy(-5);
  check('negative delta is a rewind', rewind.flags & FLAG.DT_REWIND && rewind.ticks === 0);
}

// ------------------------------------------------------- interpolator contract

{
  const a = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 2, -3, 1];
  const angle = 0.4;
  const b = [Math.cos(angle), 0, -Math.sin(angle), 0, 0, 1, 0, 0, Math.sin(angle), 0, Math.cos(angle), 0, 14, 2, 1, 1];
  check('packet matrices are rigid', isRigid(a) && isRigid(b));
  check('interpolation at f=0 is the source matrix', JSON.stringify(Array.from(interpolateRigid(a, b, 0))) === JSON.stringify(Array.from(Float32Array.from(a))));
  check('interpolation at f=1 is the target matrix', JSON.stringify(Array.from(interpolateRigid(a, b, 1))) === JSON.stringify(Array.from(Float32Array.from(b))));
  const middle = interpolateRigid(a, b, 0.5);
  check('interpolated matrix stays rigid', isRigid(middle, 1e-5));
  check('interpolated translation is the midpoint', Math.abs(middle[12] - 12) < 1e-5 && Math.abs(middle[14] - -1) < 1e-5,
    'translation ' + [middle[12], middle[13], middle[14]].join(','));
  const half = Math.acos(middle[0]);
  check('interpolated rotation is the half angle', Math.abs(half - angle / 2) < 1e-5, 'angle ' + half);
  check('scaled matrix is rejected as non-rigid', !isRigid([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]));
  check('checksum is stable', matrixChecksum([a, b]) === matrixChecksum([Float32Array.from(a), Float32Array.from(b)]));
  check('checksum distinguishes transforms', matrixChecksum([a]) !== matrixChecksum([b]));
}

const report = {
  reference: { path: path.relative(ROOT, referencePath).split(path.sep).join('/'), source: referenceSource, config: native.config },
  scenarios,
  checks: {
    scenarioCount: scenarios.length,
    scenariosMatched: scenarios.filter((scenario) => scenario.matches).length
  },
  failures
};
writeFileSync(path.join(OUT, 'tick-loop.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({
  reference: report.reference.path,
  scenarios: report.checks.scenariosMatched + '/' + report.checks.scenarioCount,
  perScenario: scenarios.map((scenario) => scenario.name + '=' + (scenario.matches ? 'match' : 'MISMATCH') + ' (ticks ' + scenario.actual.totalTicks + ', capped ' + scenario.actual.cappedFrames + ', paused ' + scenario.actual.pausedFrames + ')'),
  failures
}, null, 2));
if (failures.length) {
  console.error('tick-loop gate FAILED');
  process.exit(1);
}
console.log('tick-loop gate PASSED');
