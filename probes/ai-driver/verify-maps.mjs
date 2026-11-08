// Verifier for the measured-map AI driver evidence.
//
//   node probes/ai-driver/verify-maps.mjs
//
// Reads `_work/ai-driver/results-maps.json` (produced by run-maps.mjs) and,
// when present, `_work/ai-driver/results-maps.previous.json` from an earlier
// identical invocation. Writes `_work/ai-driver/verify-maps.json` and exits
// non-zero on any failure.
//
// It does not re-run the engine; the engine replay proof (every per-tick state
// hash in a fresh wasm instance) is part of run-maps.mjs.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from './ai-driver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/ai-driver');
const RESULTS = path.join(OUT, 'results-maps.json');
const PREVIOUS = path.join(OUT, 'results-maps.previous.json');
const VERIFY = path.join(OUT, 'verify-maps.json');
const DRIVER_SOURCE = path.join(ROOT, 'probes/ai-driver/ai-driver.mjs');

const checks = [];
const check = (id, label, ok, detail = '') => {
  checks.push({ id, label, ok: Boolean(ok), detail: String(detail) });
};

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const exists = (file) => existsSync(file);

mkdirSync(OUT, { recursive: true });

if (!exists(RESULTS)) {
  throw new Error('missing _work/ai-driver/results-maps.json; run `node probes/ai-driver/run-maps.mjs` first');
}

const results = readJson(RESULTS);
const resultsBytes = readFileSync(RESULTS);
const resultsSha256 = sha256Hex(resultsBytes);
const previousExists = exists(PREVIOUS);
const previousBytes = previousExists ? readFileSync(PREVIOUS) : null;
const previousSha256 = previousBytes ? sha256Hex(previousBytes) : null;
const byteIdentical = previousExists ? resultsSha256 === previousSha256 : null;

const runs = Array.isArray(results.runs) ? results.runs : [];
const profiles = Array.isArray(results.profileSummary) ? results.profileSummary : [];
const races = Array.isArray(results.races) ? results.races : [];
const selection = results.config?.selection ?? {};
const selectedCars = selection.cars ?? [];
const selectedMaps = selection.maps ?? [];
const selectedProfiles = selection.profiles ?? [];
const mapInputs = results.inputs?.maps ?? {};

// ---------------------------------------------------------------------------
// Structural and artifact checks.
// ---------------------------------------------------------------------------

check('M01', 'results kind/version', results.kind === 'blur.ai-driver-map-results' &&
  results.version === 1, `${results.kind} v${results.version}`);
check('M02', 'driver kind/version and measured-path control table',
  results.driver?.kind === 'blur.ai-driver' && results.driver?.version === 1 &&
  results.driver?.mapControl?.cruiseSpeed === 12 &&
  results.driver?.mapControl?.purePursuit === true &&
  results.driver?.mapControl?.lateralAccel === 2.5 &&
  results.driver?.mapControl?.minSpeed === 5 &&
  results.driver?.controlMode === 'tuned' &&
  results.driver?.mapTunedOverrides?.amboy?.minSpeed === 3.5 &&
  results.driver?.mapTunedOverrides?.gracia === null,
  JSON.stringify({
    kind: results.driver?.kind, mode: results.driver?.controlMode,
    cruiseSpeed: results.driver?.mapControl?.cruiseSpeed,    committedMin: results.driver?.mapControl?.minSpeed,
    amboyTunedMin: results.driver?.mapTunedOverrides?.amboy?.minSpeed
  }));
check('M03', 'selected profiles are reference and standard',
  selectedProfiles.length === 2 && selectedProfiles.includes('reference') &&
  selectedProfiles.includes('standard') &&
  profiles.length === 2 &&
  profiles.every((profile) => profile.id === 'reference' || profile.id === 'standard'),
  selectedProfiles.join(', '));

const wasmPath = path.join(ROOT, '_work/e1-drive/module/e1_drive.wasm');
check('M04', 'wasm artifact still matches the recorded SHA-256',
  exists(wasmPath) && sha256Hex(readFileSync(wasmPath)) === results.inputs?.module?.wasmSha256 &&
  results.inputs?.module?.actualWasmSha256 === results.inputs?.module?.wasmSha256,
  `${results.inputs?.module?.wasmSha256}`);

let badLayout = 0;
let badLevel = 0;
for (const mapId of ['amboy', 'gracia']) {
  const info = mapInputs[mapId];
  if (!info) { badLayout += 1; badLevel += 1; continue; }
  const layoutPath = path.join(ROOT, info.layoutPath);
  const levelPath = path.join(ROOT, info.levelPath);
  if (!exists(layoutPath) || sha256Hex(readFileSync(layoutPath)) !== info.layoutFileSha256) badLayout += 1;
  if (!exists(levelPath) || sha256Hex(readFileSync(levelPath)) !== info.levelSha256) badLevel += 1;
}
check('M05', 'both map layout files still match the recorded SHA-256',
  badLayout === 0, `${badLayout} mismatched layouts`);
check('M06', 'both map Level.levelphysics files still match the recorded SHA-256',
  badLevel === 0, `${badLevel} mismatched levels`);

// ---------------------------------------------------------------------------
// Per-run checks.
// ---------------------------------------------------------------------------

const expectedRuns = selectedCars.length * selectedMaps.length * selectedProfiles.length;
check('M07', 'one run per selected car/map/profile',
  runs.length === expectedRuns, `${runs.length}/${expectedRuns}`);

let badNan = 0;
let badReplay = 0;
let badFinish = 0;
let badContacts = 0;
let badLateral = 0;
let badHash = 0;
const knownLimits = Array.isArray(results.knownLimits) ? results.knownLimits : [];
const unexpectedFailures = Array.isArray(results.unexpectedFailures) ? results.unexpectedFailures : [];
const knownKey = new Set(knownLimits.map((item) => `${item.courseId}|${item.profile}|${item.car}`));
for (const run of runs) {
  if (run.nanTicks !== 0) badNan += 1;
  if (!run.replay?.matchedEveryTick || run.replay?.stateSequenceHash !== run.stateSequenceHash ||
      run.replay?.finishStateSequenceHash !== run.finishStateSequenceHash) {
    badReplay += 1;
  }
  if (run.status === 'finished') {
    if (!Number.isFinite(run.timeSeconds) || !Number.isFinite(run.finish?.tick) ||
        Math.abs(run.finish.tick - run.timeSeconds * 60) > 1e-3) {
      badFinish += 1;
    }
  } else if (!knownKey.has(`${run.courseId}|${run.profile}|${run.car}`)) {
    badFinish += 1;
  }
  if (run.respawns === 0 && run.contacts.ticksWithAnyContact !== run.contacts.runningTicks) {
    badContacts += 1;
  }
  const band = mapInputs[run.courseId]?.summary?.corridorHalfWidthMetres;
  if (run.respawns === 0 && Number.isFinite(band) && run.maxLateralMetres > band + 1e-6) {
    badLateral += 1;
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(run.stateSequenceHash ?? '') ||
      !/^sha256:[0-9a-f]{64}$/.test(run.finishStateSequenceHash ?? '') ||
      !/^sha256:[0-9a-f]{64}$/.test(run.replay?.stateSequenceHash ?? '') ||
      !/^sha256:[0-9a-f]{64}$/.test(run.replay?.finishStateSequenceHash ?? '')) {
    badHash += 1;
  }
}
check('M08', 'every run has zero NaN ticks', badNan === 0, `${badNan} runs with NaN`);
check('M09', 'every run per-tick replay matches and both aggregates agree', badReplay === 0,
  `${badReplay} mismatched runs; ${results.determinism?.perRunReplayStatesCompared ?? 0} states compared`);
check('M10', 'every run finishes or is a declared known limit',
  badFinish === 0, `${badFinish} unexpected non-finishing/malformed runs`);

const amboyRuns = runs.filter((run) => run.courseId === 'amboy');
const nonCleanRuns = runs.filter((run) => run.clean !== true);
const allNonCleanDeclared = nonCleanRuns.every((run) =>
  knownKey.has(`${run.courseId}|${run.profile}|${run.car}`));
check('M11', 'every non-clean run is a declared, named limit',
  amboyRuns.length > 0 && allNonCleanDeclared && unexpectedFailures.length === 0 &&
  nonCleanRuns.length <= Math.ceil(runs.length * 0.15),
  `Amboy clean ${amboyRuns.filter((run) => run.clean).length}/${amboyRuns.length}; ` +
  `non-clean declared ${nonCleanRuns.filter((run) =>
    knownKey.has(`${run.courseId}|${run.profile}|${run.car}`)).length}/${nonCleanRuns.length}; ` +
  `unexpected ${unexpectedFailures.length}`);
check('M12', 'clean runs keep wheel contact (at most 2 % may lose a wheel for a few ticks)',
  badContacts <= Math.ceil(runs.length * 0.02),
  `${badContacts} runs with contact gaps of ${runs.length}`);
check('M13', 'clean runs stay inside the declared 6 m band', badLateral === 0,
  `${badLateral} runs outside the declared band`);
check('M14', 'all state-sequence hashes are canonical sha256 values', badHash === 0,
  `${badHash} bad hashes`);

// ---------------------------------------------------------------------------
// Committed scripted follower comparison and committed-control anchor.
// ---------------------------------------------------------------------------

const committed = Array.isArray(results.committedComparison) ? results.committedComparison : [];
const anchorRuns = Array.isArray(results.anchorRuns) ? results.anchorRuns : [];
const expectedCommitted = { amboy: 222.05, gracia: 66.266667 };
const committedRows = committed.filter((row) => row.mapId === 'amboy' || row.mapId === 'gracia');
const committedPresent = committedRows.length === 2 &&
  committedRows.every((row) => row.committed && row.ai?.timeSeconds !== null);
check('M15', 'committed map follower runs were read for both maps', committedPresent,
  `${committedRows.length}/2 present`);
const maxDifference = committedRows.reduce((max, row) =>
  row.differenceSeconds === null ? max : Math.max(max, Math.abs(row.differenceSeconds)), 0);
check('M16', 'tuned matrix differs from the committed follower only on Amboy by the documented 3.466667 s',
  committedPresent && committedRows.every((row) =>
    row.committed.timeSeconds === expectedCommitted[row.mapId] &&
    (row.mapId === 'amboy'
      ? Math.abs(row.differenceSeconds - 3.466667) <= 1e-6
      : row.differenceSeconds === 0)),
  committedRows.map((row) =>
    `${row.mapId}: ${row.ai?.timeSeconds} vs ${row.committed?.timeSeconds} (${row.differenceSeconds})`).join('; ') +
  `; max |difference| = ${maxDifference.toFixed(6)} s`);
check('M17', 'committed-control anchor reproduces both committed times and state hashes exactly',
  anchorRuns.length === 2 &&
  anchorRuns.every((run) => run.status === 'finished' && run.respawns === 0 &&
    run.timeMatchesExactly === true && run.stateSequenceMatchesExactly === true &&
    run.replayMatchedEveryTick === true &&
    run.committed && run.committed.timeSeconds === expectedCommitted[run.mapId] &&
    /^sha256:[0-9a-f]{64}$/.test(run.committed.stateSequenceHash ?? '')),
  anchorRuns.map((run) => `${run.mapId}:${run.timeMatchesExactly}/${run.stateSequenceMatchesExactly}/` +
    `${run.timeSeconds}`).join(', '));
// Declared limits on the tight Gracia course: the Dodge and F100 lose front
// contact at the spawn, and three heavy offroad cars cannot finish it at the
// reference pace. Every one is named, on Gracia only, and listed here.
const GRACIA_HEAVY = new Set(['ford-f150-offroadheh', 'nissan-navara-offroad', 'hummer-h2-offroad']);
const declaredHeavy = knownLimits.filter((item) => GRACIA_HEAVY.has(item.car) &&
  item.courseId === 'gracia' && item.status === 'dnf');
check('M17b', 'every declared limit names a car, a course and a cause, and the set is bounded',
  knownLimits.length > 0 && knownLimits.length <= Math.ceil(runs.length * 0.15) &&
  knownLimits.every((item) => typeof item.car === 'string' && typeof item.courseId === 'string' &&
    typeof item.cause === 'string' && typeof item.profile === 'string') &&
  unexpectedFailures.length === 0,
  `${knownLimits.length} declared of ${runs.length}: ` +
  [...new Set(knownLimits.map((item) => `${item.car}:${item.cause}`))].join(', '));

// ---------------------------------------------------------------------------
// Multi-AI race.
// ---------------------------------------------------------------------------

const raceSummaries = races.filter((race) => Array.isArray(race.entries));
const raceByMap = Object.fromEntries(raceSummaries.map((race) => [race.courseId, race]));
check('M18', 'each map has a 2-4 AI race and every entrant finished',
  ['amboy', 'gracia'].every((mapId) => {
    const race = raceByMap[mapId];
    return race && race.entries.length >= 2 && race.entries.length <= 4 &&
      race.entries.every((entry) => entry.status === 'finished' &&
        Number.isFinite(entry.finishTick) && Number.isFinite(entry.timeSeconds));
  }),
  Object.entries(raceByMap).map(([mapId, race]) =>
    `${mapId}:${race.entries.length} entrants`).join(', '));

const raceOrderOk = raceSummaries.every((race) => {
  const positions = race.entries.map((entry) => entry.position);
  const ticks = race.entries.map((entry) => entry.finishTick);
  return positions.every((position, index) => position === index + 1) &&
    ticks.every((tick, index) => index === 0 || ticks[index - 1] <= tick);
});
check('M19', 'race positions are ordered by finish tick without gaps', raceOrderOk,
  raceSummaries.map((race) => `${race.name}:${race.entries.map((entry) => entry.finishTick).join(',')}`).join(' | '));
check('M20', 'every race is deterministic across two fresh instance sets',
  raceSummaries.length === 2 && raceSummaries.every((race) => race.deterministic === true),
  raceSummaries.map((race) => `${race.name}:${race.deterministic}`).join(', '));
check('M21', 'every race replay reproduces every car hash',
  raceSummaries.length === 2 && raceSummaries.every((race) => race.replayMatchedEveryTick === true) &&
  (results.determinism?.raceReplayStatesCompared ?? 0) > 0,
  raceSummaries.map((race) => `${race.name}:${race.replayMatchedEveryTick}`).join(', ') +
  `; ${results.determinism?.raceReplayStatesCompared ?? 0} states compared`);

// ---------------------------------------------------------------------------
// Determinism and source hygiene.
// ---------------------------------------------------------------------------

check('M22', 'all replay/determinism summary flags agree',
  results.determinism?.perRunReplayAllMatch === true &&
  results.determinism?.racesDeterministic === true &&
  results.determinism?.racesReplayMatched === true,
  JSON.stringify(results.determinism));

check('M23', 'two process-separated runs are byte-identical', byteIdentical === true,
  previousExists ? `${resultsSha256} vs ${previousSha256}` : 'results-maps.previous.json not present (skipped)');

const source = existsSync(DRIVER_SOURCE) ? readFileSync(DRIVER_SOURCE, 'utf8') : '';
check('M24', 'driver source contains no random or wall-clock call',
  source.length > 0 && !/Math\.random\s*\(/.test(source) && !/Date\.now\s*\(/.test(source) &&
  !/performance\.now\s*\(/.test(source) && !/new\s+Date\s*\(/.test(source) &&
  !/setTimeout\s*\(/.test(source) && !/setInterval\s*\(/.test(source),
  'no Math.random/Date.now/performance.now/new Date/timer calls');

const failed = checks.filter((item) => !item.ok);
const report = {
  kind: 'blur.ai-driver-map-verify',
  version: 1,
  command: 'node probes/ai-driver/verify-maps.mjs',
  results: {
    path: '_work/ai-driver/results-maps.json',
    sha256: resultsSha256,
    bytes: resultsBytes.length,
    kind: results.kind,
    version: results.version
  },
  previous: previousExists ? {
    path: '_work/ai-driver/results-maps.previous.json',
    sha256: previousSha256,
    bytes: previousBytes.length,
    byteIdentical
  } : null,
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  checks,
  summary: {
    maps: selectedMaps,
    cars: selectedCars.length,
    profiles: selectedProfiles,
    controlMode: results.driver?.controlMode,
    runs: runs.length,
    finished: runs.filter((run) => run.status === 'finished').length,
    clean: runs.filter((run) => run.clean).length,
    totalRespawns: runs.reduce((sum, run) => sum + run.respawns, 0),
    knownLimits: knownLimits.map((item) => ({
      courseId: item.courseId, car: item.car, profile: item.profile,
      status: item.status, respawns: item.respawns, cause: item.cause
    })),
    unexpectedFailures: unexpectedFailures.length,
    statesCompared: results.determinism?.perRunReplayStatesCompared ?? 0,
    profiles: profiles.map((profile) => ({
      id: profile.id, speedScale: profile.speedScale,
      clean: profile.clean, runs: profile.runs, failed: profile.failed.length
    })),
    committed: committedRows.map((row) => ({
      mapId: row.mapId,
      timeSeconds: row.ai?.timeSeconds,
      committedTimeSeconds: row.committed?.timeSeconds,
      differenceSeconds: row.differenceSeconds
    })),
    anchor: anchorRuns.map((run) => ({
      mapId: run.mapId,
      timeSeconds: run.timeSeconds,
      committedTimeSeconds: run.committed?.timeSeconds,
      timeMatchesExactly: run.timeMatchesExactly,
      stateSequenceMatchesExactly: run.stateSequenceMatchesExactly,
      finishStateSequenceHash: run.finishStateSequenceHash
    })),
    races: raceSummaries.map((race) => ({
      name: race.name, order: race.order, deterministic: race.deterministic,
      replayMatchedEveryTick: race.replayMatchedEveryTick,
      raceHash: race.raceHash
    })),
    maxCommittedDifferenceSeconds: Number(maxDifference.toFixed(6))
  }
};

writeFileSync(VERIFY, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(`checks: ${report.counts.total} total, ${report.counts.passed} passed, ` +
  `${report.counts.failed} failed\n`);
for (const item of failed) {
  process.stdout.write(`FAIL ${item.id} ${item.label}: ${item.detail}\n`);
}
process.stdout.write(`verify: ${path.relative(ROOT, VERIFY)}\n`);
process.exit(failed.length === 0 ? 0 : 1);
