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
const EXPECTED_MAPS = ['amboy', 'gracia', 'longbeach', 'observatory', 'downtown', 'mharuna',
  'dumbo', 'downtown-mp'];
check('M02', 'driver kind/version, measured-path control table and the eight measured maps',
  results.driver?.kind === 'blur.ai-driver' && results.driver?.version === 1 &&
  results.driver?.mapControl?.cruiseSpeed === 12 &&
  results.driver?.mapControl?.purePursuit === true &&
  results.driver?.mapControl?.lateralAccel === 2.5 &&
  results.driver?.mapControl?.minSpeed === 5 &&
  results.driver?.controlMode === 'tuned' &&
  results.driver?.mapTunedOverrides?.amboy?.minSpeed === 3.5 &&
  results.driver?.mapTunedOverrides?.gracia === null &&
  EXPECTED_MAPS.every((mapId) => (results.driver?.measuredMapIds ?? []).includes(mapId)) &&
  selectedMaps.length === EXPECTED_MAPS.length &&
  EXPECTED_MAPS.every((mapId) => selectedMaps.includes(mapId)),
  JSON.stringify({
    kind: results.driver?.kind, mode: results.driver?.controlMode,
    cruiseSpeed: results.driver?.mapControl?.cruiseSpeed, committedMin: results.driver?.mapControl?.minSpeed,
    amboyTunedMin: results.driver?.mapTunedOverrides?.amboy?.minSpeed,
    measuredMapIds: results.driver?.measuredMapIds, selectedMaps
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
let badCommittedPath = 0;
for (const mapId of selectedMaps) {
  const info = mapInputs[mapId];
  if (!info) { badLayout += 1; badLevel += 1; continue; }
  const layoutPath = path.join(ROOT, info.layoutPath);
  const levelPath = path.join(ROOT, info.levelPath);
  if (!exists(layoutPath) || sha256Hex(readFileSync(layoutPath)) !== info.layoutFileSha256) badLayout += 1;
  if (!exists(levelPath) || sha256Hex(readFileSync(levelPath)) !== info.levelSha256) badLevel += 1;
  if (info.committedPath) {
    const committedPath = path.join(ROOT, info.committedPath.path);
    if (!exists(committedPath) ||
        sha256Hex(readFileSync(committedPath)) !== info.committedPath.fileSha256 ||
        info.committedPath.hash !== info.summary?.hash) {
      badCommittedPath += 1;
    }
  }
}
check('M05', 'every map layout file still matches the recorded SHA-256',
  badLayout === 0, `${badLayout}/${selectedMaps.length} mismatched layouts`);
check('M06', 'every map Level.levelphysics file still matches the recorded SHA-256',
  badLevel === 0, `${badLevel}/${selectedMaps.length} mismatched levels`);
check('M06b', 'every new map E1 layout still matches its committed collision path hash',
  badCommittedPath === 0,
  `${badCommittedPath} mismatched committed paths; ` +
  selectedMaps.filter((mapId) => mapInputs[mapId]?.committedPath)
    .map((mapId) => `${mapId}:${mapInputs[mapId].committedPath.hash?.slice(7, 19)}`).join(', '));

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
check('M13', 'clean runs stay inside their map\'s declared corridor', badLateral === 0,
  `${badLateral} runs outside the declared corridor`);
check('M14', 'all state-sequence hashes are canonical sha256 values', badHash === 0,
  `${badHash} bad hashes`);

// ---------------------------------------------------------------------------
// Committed scripted follower comparison and committed-control anchor.
// ---------------------------------------------------------------------------

const committed = Array.isArray(results.committedComparison) ? results.committedComparison : [];
const anchorRuns = Array.isArray(results.anchorRuns) ? results.anchorRuns : [];
const expectedCommitted = { amboy: 222.05, gracia: 66.266667 };
// The committed follower runs for amboy/gracia were produced by the measured
// AMBOY_CONTROL (top speed ~13 m/s). The four new-map runs were produced by the
// sprint follower (top speed ~24.7 m/s), so their times are not directly
// comparable with the AI's 12 m/s measured-path matrix. `comparable` is derived
// from the committed run's own recorded top speed, not assumed.
const committedRows = committed.filter((row) => selectedMaps.includes(row.mapId));
const committedPresent = committedRows.length === selectedMaps.length &&
  committedRows.every((row) => row.committed &&
    Number.isFinite(row.committed.timeSeconds) &&
    /^sha256:[0-9a-f]{64}$/.test(row.committed.stateSequenceHash ?? '') &&
    row.ai && Number.isFinite(row.ai.timeSeconds));
check('M15', 'committed map follower runs were read for every selected map', committedPresent,
  `${committedRows.length}/${selectedMaps.length} present`);
const measuredControlRows = committedRows.filter((row) =>
  row.mapId === 'amboy' || row.mapId === 'gracia');
const sprintControlRows = committedRows.filter((row) =>
  row.mapId !== 'amboy' && row.mapId !== 'gracia');
// Provenance is derived from each committed run's own recorded top speed: a
// sprint-control run must beat the measured control's cruise class *and* every
// measured-control committed top speed. The previous hard-coded 20 m/s assumed
// every sprint run reached the sprint cruise; Downtown MP is only 86 m and its
// committed sprint run tops out at 17.58 m/s, still well above the measured
// control's 13.08 m/s. The bound is derived from the recorded data, not assumed.
const measuredCommittedTopSpeed = measuredControlRows.reduce((max, row) =>
  Number.isFinite(row.committed?.maxSpeedMps) ? Math.max(max, row.committed.maxSpeedMps) : max, 0);
const maxDifference = measuredControlRows.reduce((max, row) =>
  row.differenceSeconds === null ? max : Math.max(max, Math.abs(row.differenceSeconds)), 0);
check('M16', 'measured-control maps reproduce the documented committed difference; sprint-control maps are marked non-comparable',
  committedPresent && measuredControlRows.length === 2 &&
  measuredControlRows.every((row) =>
    row.committed.timeSeconds === expectedCommitted[row.mapId] &&
    row.comparable === true &&
    (row.mapId === 'amboy'
      ? Math.abs(row.differenceSeconds - 3.466667) <= 1e-6
      : row.differenceSeconds === 0)) &&
  sprintControlRows.length === selectedMaps.length - 2 &&
  sprintControlRows.every((row) => row.comparable === false &&
    row.committedControlClass === 'sprint' &&
    row.committed.maxSpeedMps > results.driver.mapControl.cruiseSpeed * 1.2 &&
    row.committed.maxSpeedMps > measuredCommittedTopSpeed),
  measuredControlRows.map((row) =>
    `${row.mapId}: ${row.ai?.timeSeconds} vs ${row.committed?.timeSeconds} (${row.differenceSeconds})`).join('; ') +
  `; sprint-control: ` + sprintControlRows.map((row) =>
    `${row.mapId}: ${row.ai?.timeSeconds} vs ${row.committed?.timeSeconds} ` +
    `(committed top ${row.committed?.maxSpeedMps} m/s, comparable ${row.comparable})`).join('; ') +
  `; max measured |difference| = ${maxDifference.toFixed(6)} s; ` +
  `measured-control committed top speed = ${measuredCommittedTopSpeed} m/s`);
const exactAnchorRows = anchorRuns.filter((run) =>
  run.mapId === 'amboy' || run.mapId === 'gracia');
const sprintAnchorRows = anchorRuns.filter((run) =>
  run.mapId !== 'amboy' && run.mapId !== 'gracia');
check('M17', 'committed-control anchor reproduces the measured-control maps exactly and the sprint-control maps are clean',
  anchorRuns.length === selectedMaps.length &&
  exactAnchorRows.length === 2 &&
  exactAnchorRows.every((run) => run.status === 'finished' && run.respawns === 0 &&
    run.comparable === true &&
    run.timeMatchesExactly === true && run.stateSequenceMatchesExactly === true &&
    run.replayMatchedEveryTick === true &&
    run.committed && run.committed.timeSeconds === expectedCommitted[run.mapId] &&
    /^sha256:[0-9a-f]{64}$/.test(run.committed.stateSequenceHash ?? '')) &&
  sprintAnchorRows.length === selectedMaps.length - 2 &&
  sprintAnchorRows.every((run) => run.status === 'finished' && run.respawns === 0 &&
    run.nanTicks === 0 && run.replayMatchedEveryTick === true &&
    run.comparable === false && run.committedControlClass === 'sprint' &&
    run.committed && Number.isFinite(run.committed.maxSpeedMps)),
  anchorRuns.map((run) => `${run.mapId}:${run.timeMatchesExactly}/${run.stateSequenceMatchesExactly}/` +
    `${run.timeSeconds}/comparable=${run.comparable}`).join(', '));
// Every declared limit must name a car, a course and a cause, carry the
// observed detail, and stay bounded relative to the run count.
check('M17b', 'every declared limit names a car, a course and a cause, and the set is bounded',
  knownLimits.length <= Math.ceil(runs.length * 0.15) &&
  knownLimits.every((item) => typeof item.car === 'string' && typeof item.courseId === 'string' &&
    typeof item.cause === 'string' && typeof item.profile === 'string' &&
    typeof item.detail === 'string' && item.detail.length > 0) &&
  unexpectedFailures.length === 0,
  `${knownLimits.length} declared of ${runs.length}: ` +
  [...new Set(knownLimits.map((item) => `${item.courseId}/${item.car}:${item.cause}`))].join(', '));

// ---------------------------------------------------------------------------
// Multi-AI race.
// ---------------------------------------------------------------------------

const raceSummaries = races.filter((race) => Array.isArray(race.entries));
const raceByMap = Object.fromEntries(raceSummaries.map((race) => [race.courseId, race]));
check('M18', 'each map has a 2-4 AI race and every entrant finished',
  selectedMaps.every((mapId) => {
    const race = raceByMap[mapId];
    return race && race.entries.length >= 2 && race.entries.length <= 4 &&
      race.entries.every((entry) => entry.status === 'finished' &&
        Number.isFinite(entry.finishTick) && Number.isFinite(entry.timeSeconds));
  }),
  selectedMaps.map((mapId) => `${mapId}:${raceByMap[mapId]?.entries.length ?? 0} entrants`).join(', '));

const raceOrderOk = raceSummaries.every((race) => {
  const positions = race.entries.map((entry) => entry.position);
  const ticks = race.entries.map((entry) => entry.finishTick);
  return positions.every((position, index) => position === index + 1) &&
    ticks.every((tick, index) => index === 0 || ticks[index - 1] <= tick);
});
check('M19', 'race positions are ordered by finish tick without gaps', raceOrderOk,
  raceSummaries.map((race) => `${race.name}:${race.entries.map((entry) => entry.finishTick).join(',')}`).join(' | '));
check('M20', 'every race is deterministic across two fresh instance sets',
  raceSummaries.length === selectedMaps.length &&
  raceSummaries.every((race) => race.deterministic === true),
  raceSummaries.map((race) => `${race.name}:${race.deterministic}`).join(', '));
check('M21', 'every race replay reproduces every car hash',
  raceSummaries.length === selectedMaps.length &&
  raceSummaries.every((race) => race.replayMatchedEveryTick === true) &&
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

// ---------------------------------------------------------------------------
// New-map evidence: required per-run fields, ground hint, determinism.
// ---------------------------------------------------------------------------

let missingFields = 0;
for (const run of runs) {
  const ok = typeof run.mapId === 'string' &&
    run.mapId === run.courseId &&
    typeof run.profile === 'string' &&
    typeof run.car === 'string' &&
    typeof run.status === 'string' &&
    (run.status === 'finished'
      ? Number.isFinite(run.timeSeconds) && Number.isFinite(run.finish?.tick)
      : knownKey.has(`${run.courseId}|${run.profile}|${run.car}`)) &&
    Number.isInteger(run.respawns) &&
    Number.isFinite(run.maxLateralMetres) &&
    Number.isFinite(run.contactTicks) &&
    Number.isFinite(run.contacts?.runningTicks) &&
    typeof run.replay?.matchedEveryTick === 'boolean' &&
    /^sha256:[0-9a-f]{64}$/.test(run.stateSequenceHash ?? '');
  if (!ok) missingFields += 1;
}
check('M25', 'every run records mapId, profile, car, status, time, respawns, lateral, contact ticks, replay and state hash',
  missingFields === 0, `${missingFields}/${runs.length} runs missing a required field`);

let badGroundHint = 0;
for (const mapId of selectedMaps) {
  const info = mapInputs[mapId];
  if (!info) { badGroundHint += 1; continue; }
  const layout = readJson(path.join(ROOT, info.layoutPath));
  const value = layout.course?.spawnGroundY;
  const expectedApplied = Number.isFinite(value) && (value < -170 || value > 130);
  const hint = info.groundHint;
  if (!Number.isFinite(value) ||
      !hint || hint.value !== value ||
      hint.applied !== expectedApplied ||
      hint.reason !== (expectedApplied
        ? 'spawn-ground-outside-fixed-probe-column'
        : 'spawn-ground-inside-fixed-probe-column') ||
      info.summary?.spawnGroundY !== value) {
    badGroundHint += 1;
  }
}
check('M26', 'every map records its layout spawnGroundY and applies the ground hint when it is outside the fixed column',
  badGroundHint === 0 &&
  mapInputs.mharuna?.groundHint?.value === 1064.4312 &&
  mapInputs.mharuna?.groundHint?.applied === true,
  `${badGroundHint}/${selectedMaps.length} bad hints; ` +
  selectedMaps.map((mapId) => `${mapId}:${mapInputs[mapId]?.groundHint?.value}` +
    `/${mapInputs[mapId]?.groundHint?.applied}`).join(', '));

// Finish-time determinism across two process-separated runs. This is stronger
// than the byte-identical file check because it names the run that drifted.
const previousResults = previousExists ? JSON.parse(previousBytes.toString('utf8')) : null;
const runKey = (run) => `${run.mapId}|${run.profile}|${run.car}`;
const previousByKey = new Map((previousResults?.runs ?? []).map((run) => [runKey(run), run]));
let driftedRuns = 0;
let missingPreviousRuns = 0;
for (const run of runs) {
  const previous = previousByKey.get(runKey(run));
  if (!previous) { missingPreviousRuns += 1; continue; }
  if (previous.status !== run.status ||
      previous.timeSeconds !== run.timeSeconds ||
      previous.respawns !== run.respawns ||
      previous.maxLateralMetres !== run.maxLateralMetres ||
      previous.contactTicks !== run.contactTicks ||
      previous.replay?.matchedEveryTick !== run.replay?.matchedEveryTick ||
      previous.stateSequenceHash !== run.stateSequenceHash ||
      previous.finishStateSequenceHash !== run.finishStateSequenceHash) {
    driftedRuns += 1;
  }
}
check('M27', 'finish times, lateral/contact metrics, replay and state hashes are identical across two process-separated runs',
  previousExists && missingPreviousRuns === 0 && driftedRuns === 0 &&
  runs.length === (previousResults?.runs ?? []).length,
  previousExists
    ? `${driftedRuns} drifted, ${missingPreviousRuns} missing of ${runs.length}`
    : 'results-maps.previous.json not present');

// Per-map split: every selected car × profile has exactly one run, and every
// run is either clean or a declared limit.
const perMap = selectedMaps.map((mapId) => {
  const mapRuns = runs.filter((run) => run.mapId === mapId);
  const mapClean = mapRuns.filter((run) => run.clean === true).length;
  const mapDeclared = mapRuns.filter((run) =>
    !run.clean && knownKey.has(`${run.courseId}|${run.profile}|${run.car}`)).length;
  return {
    mapId, runs: mapRuns.length, clean: mapClean, declared: mapDeclared,
    expected: selectedCars.length * selectedProfiles.length
  };
});
check('M28', 'every map has one run per car/profile and every run is clean or declared',
  perMap.every((row) => row.runs === row.expected && row.clean + row.declared === row.runs),
  perMap.map((row) => `${row.mapId}:${row.clean} clean + ${row.declared} declared / ${row.runs}`).join('; '));

// ---------------------------------------------------------------------------
// 61-car roster pin and the two aid-path maps (Dumbo, Downtown MP).
// ---------------------------------------------------------------------------

const PINNED_ROSTER = path.join(OUT, 'cars-61.json');
const pinnedRoster = exists(PINNED_ROSTER) ? readJson(PINNED_ROSTER) : null;
const pinnedSlugs = (pinnedRoster?.roster?.cars ?? []).map((car) => car.slug);
const recordedRoster = results.inputs?.roster ?? {};
const recordedSlugs = (recordedRoster.cars ?? []).map((car) => car.slug);
const pinnedRosterPath = path.relative(ROOT, PINNED_ROSTER).split(path.sep).join('/');
check('M29', 'the 61-car roster is pinned to _work/ai-driver/cars-61.json and matches the recorded selection',
  selectedCars.length === 61 &&
  recordedRoster.selected === 61 &&
  pinnedSlugs.length === 61 &&
  new Set(pinnedSlugs).size === 61 &&
  JSON.stringify(pinnedSlugs) === JSON.stringify(selectedCars) &&
  JSON.stringify(recordedSlugs) === JSON.stringify(selectedCars) &&
  ['hummer-h2-rat', 'ford-supervan-stock', 'ratrod-na-stock', 'toyota-supra-smooth']
    .every((slug) => selectedCars.includes(slug)),
  `selected ${selectedCars.length}; pinned ${pinnedSlugs.length} (${pinnedRosterPath}); ` +
  `roster ${recordedRoster.path}`);

// The two new maps have no `probes/map-laps` path: their committed collision
// path is the map-laps-aid aid path, copied verbatim into the E1 layout. The
// verifier re-reads the layout and the recorded committed path rather than
// trusting the runner's own summary.
const NEW_MAPS = { dumbo: 361.999436, 'downtown-mp': 86.452776 };
const newMapRows = Object.entries(NEW_MAPS).map(([mapId, length]) => {
  const info = mapInputs[mapId];
  const layout = info ? readJson(path.join(ROOT, info.layoutPath)) : null;
  const committedPath = info?.committedPath ?? null;
  const aidPath = committedPath?.path ?? '';
  const gates = Array.isArray(layout?.gates) ? layout.gates : [];
  const checkpoints = gates.filter((gate) => gate.kind === 'checkpoint').length;
  const mapRuns = runs.filter((run) => run.mapId === mapId);
  const mapClean = mapRuns.filter((run) => run.clean === true).length;
  const mapDeclared = mapRuns.filter((run) =>
    !run.clean && knownKey.has(`${run.courseId}|${run.profile}|${run.car}`)).length;
  const ok = Boolean(info) &&
    info.summary?.lengthMetres === length &&
    info.summary?.finishArc === length &&
    info.summary?.corridorHalfWidthMetres === 12 &&
    committedPath !== null &&
    aidPath.startsWith('probes/map-laps-aid/data/') &&
    aidPath.endsWith('-aid-path.json') &&
    committedPath.hash === info.summary?.hash &&
    checkpoints === 2 &&
    gates.length === 4 &&
    mapRuns.length === selectedCars.length * selectedProfiles.length &&
    mapClean + mapDeclared === mapRuns.length;
  return {
    mapId, ok, lengthMetres: info?.summary?.lengthMetres, finishArc: info?.summary?.finishArc,
    corridorHalfWidthMetres: info?.summary?.corridorHalfWidthMetres,
    committedPath: aidPath, committedPathHash: committedPath?.hash ?? null,
    gates: gates.length, checkpoints, runs: mapRuns.length, clean: mapClean, declared: mapDeclared
  };
});
check('M30', 'Dumbo and Downtown MP run the committed aid path with the documented length, gates and full run accounting',
  newMapRows.every((row) => row.ok),
  newMapRows.map((row) => `${row.mapId}: ${row.lengthMetres} m finish ${row.finishArc} m, ` +
    `${row.gates} gates/${row.checkpoints} cp, ${row.clean} clean + ${row.declared} declared / ${row.runs}, ` +
    `${row.committedPath}`).join('; '));

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
    roster: {
      path: recordedRoster.path,
      selected: selectedCars.length,
      pinned: pinnedRosterPath,
      pinnedCars: pinnedSlugs.length
    },
    newMaps: newMapRows,
    runs: runs.length,
    finished: runs.filter((run) => run.status === 'finished').length,
    clean: runs.filter((run) => run.clean).length,
    totalRespawns: runs.reduce((sum, run) => sum + run.respawns, 0),
    knownLimits: knownLimits.map((item) => ({
      mapId: item.mapId, courseId: item.courseId, car: item.car, profile: item.profile,
      status: item.status, respawns: item.respawns, cause: item.cause,
      detail: item.detail, maxLateralMetres: item.maxLateralMetres,
      maxArcMetres: item.maxArcMetres, finishArcMetres: item.finishArcMetres
    })),
    unexpectedFailures: unexpectedFailures.length,
    statesCompared: results.determinism?.perRunReplayStatesCompared ?? 0,
    perMap,
    profiles: profiles.map((profile) => ({
      id: profile.id, speedScale: profile.speedScale,
      clean: profile.clean, runs: profile.runs, failed: profile.failed.length,
      byMap: profile.byMap
    })),
    committed: committedRows.map((row) => ({
      mapId: row.mapId,
      timeSeconds: row.ai?.timeSeconds,
      committedTimeSeconds: row.committed?.timeSeconds,
      committedMaxSpeedMps: row.committed?.maxSpeedMps,
      comparable: row.comparable,
      committedControlClass: row.committedControlClass,
      differenceSeconds: row.differenceSeconds
    })),
    anchor: anchorRuns.map((run) => ({
      mapId: run.mapId,
      timeSeconds: run.timeSeconds,
      committedTimeSeconds: run.committed?.timeSeconds,
      committedMaxSpeedMps: run.committed?.maxSpeedMps,
      comparable: run.comparable,
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
