// Independent verifier for the AI power-up evidence run.
//
// Run: node probes/ai-driver/verify-powerups.mjs
// Writes `_work/ai-driver/verify-powerups.json`.
//
// It never re-runs the wasm; it re-reads the recorded results and the recovered
// AI data, recomputes every file hash and checks the policy/usage/determinism
// claims. The two-process determinism check uses
// `_work/ai-driver/results-powerups.previous.json` when present.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex, hashOf } from './ai-driver.mjs';
import {
  AI_PROFILE_DIFFICULTY, RECOVERED_AI_CONTROLLER, SUPPORTED_MP_TYPES,
} from './rules/ai-powerups.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(ROOT, '_work/ai-driver');
const RESULTS = path.join(OUT, 'results-powerups.json');
const PREVIOUS = path.join(OUT, 'results-powerups.previous.json');
const RECOVERED = path.join(OUT, 'recovered-ai-powerups.json');

const checks = [];
let passed = 0;
let failed = 0;

function check(id, condition, detail = null) {
  const entry = { id, passed: Boolean(condition), detail };
  checks.push(entry);
  if (entry.passed) passed += 1;
  else failed += 1;
  return entry.passed;
}

function equal(id, actual, expected, detail = null) {
  return check(id, JSON.stringify(actual) === JSON.stringify(expected),
    { actual, expected, ...(detail ? { note: detail } : {}) });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

if (!existsSync(RESULTS)) {
  throw new Error(`missing ${RESULTS}; run run-powerups.mjs first`);
}
const results = readJson(RESULTS);
const recovered = readJson(RECOVERED);
const build = readJson(path.join(ROOT, '_work/e1-drive/module/build.json'));
const previousExists = existsSync(PREVIOUS);
const previous = previousExists ? readJson(PREVIOUS) : null;

// ---------------------------------------------------------------------------
// V01-V07: inputs, recovered data and policy constants.
// ---------------------------------------------------------------------------

check('V01-results-schema', results.kind === 'blur.ai-powerups-results' &&
  results.version === 1, { kind: results.kind, version: results.version });

const wasmBytes = readFileSync(path.join(ROOT, '_work/e1-drive/module/e1_drive.wasm'));
check('V02-wasm-hash', sha256Hex(wasmBytes) === build.wasmSha256 &&
  results.inputs.module.wasmSha256 === build.wasmSha256,
{ result: results.inputs.module.wasmSha256, build: build.wasmSha256 });

for (const [key, relPath] of [
  ['powerupsManifest', '_work/powerups/powerups.json'],
  ['placements', '_work/powerups/placements.json'],
  ['recoveredAi', '_work/ai-driver/recovered-ai-powerups.json'],
]) {
  const actual = sha256Hex(readFileSync(path.join(ROOT, relPath)));
  check(`V03-input-hash-${key}`, results.inputs[key].sha256 === actual,
    { actual, recorded: results.inputs[key].sha256 });
}
for (const [course, relPath] of [
  ['310m', '_work/e1-drive/sprint.json'],
  ['lap', '_work/e1-drive/sprint-lap.json'],
]) {
  if (!results.inputs.layouts[course]) continue;
  const actual = sha256Hex(readFileSync(path.join(ROOT, relPath)));
  check(`V03-layout-hash-${course}`, results.inputs.layouts[course].fileSha256 === actual,
    { actual, recorded: results.inputs.layouts[course].fileSha256 });
}

const controllerRows = recovered.pickupsAi.controller['355'].difficultyRows;
const setupRecords = Object.keys(recovered.pickupsAi.setupRecords).map(Number).sort((a, b) => a - b);
check('V04-recovered-controller-rows', controllerRows.length === 5 &&
  Array.isArray(setupRecords) && setupRecords.length === 5,
{ controllerRows: controllerRows.length, setupRecords });
equal('V04-recovered-controller-record', recovered.pickupsAi.controller['355'].record, 355);
equal('V04-recovered-controller-refid', recovered.pickupsAi.controller['355'].refId, 1737121311);
equal('V04-difficulty-perks-empty', recovered.singlePlayer.difficultyPerks.recordCount, 0);
equal('V04-aiperkuse-empty', recovered.singlePlayer.aiPerkUseEntries, 0);
const aiPerkField = recovered.singlePlayer.difficultySettings.fields
  .find((field) => field.name === 'AIPerkUse');
check('V04-aiperkuse-field', aiPerkField && aiPerkField.offset === 64 &&
  aiPerkField.typeIndex === 102, aiPerkField);
const perkFieldNames = recovered.singlePlayer.difficultyPerks.fields.map((field) => field.name);
equal('V04-difficulty-perks-fields', perkFieldNames,
  ['OpponentIndex', 'MaxPerkLevel', 'PerkToGrant', 'GrantTimeMin', 'GrantTimeMax',
    'CharactersNeverTargetted', 'PreferredPickups']);

equal('V05-profile-difficulty-map', AI_PROFILE_DIFFICULTY,
  { cautious: 'Easy', standard: 'Normal', reference: 'Hard', aggressive: 'HardCore' });
equal('V05-supported-types', SUPPORTED_MP_TYPES,
  ['Nitrous', 'Shock', 'Shunt', 'Blindfire', 'Barge', 'Bomb', 'Repair', 'Shield']);

let controllerMatches = 0;
for (const row of controllerRows) {
  const label = row.difficulty.label;
  const expected = RECOVERED_AI_CONTROLLER.difficulties[label];
  const setup = recovered.pickupsAi.setupRecords[String(row.setupRecord)];
  if (expected && expected.setupRecord === row.setupRecord &&
      expected.setupRefId === row.setupRefId &&
      expected.setupPayloadAbs === row.setupPayloadAbs &&
      expected.pickupSwitchSeconds === setup.values.PickupSwitchTime) {
    controllerMatches += 1;
  }
}
check('V06-difficulty-values-match-recovered', controllerMatches === 5,
  { controllerMatches });

// ---------------------------------------------------------------------------
// V08-V14: scenario coverage, finishes, events, usage and degradation.
// ---------------------------------------------------------------------------

const runs = results.runs;
check('V08-scenario-count', runs.length >= 8, { runs: runs.length });
const courses = new Set(runs.map((run) => run.courseId));
check('V08-course-coverage', courses.has('310m') && courses.has('lap'),
  { courses: [...courses].sort() });
const kinds = new Set(runs.map((run) => run.kind));
check('V08-kind-coverage', kinds.has('solo') && kinds.has('race') && kinds.has('degraded'),
  { kinds: [...kinds].sort() });

const allRows = runs.flatMap((run) => run.rows.map((row) => ({ run, row })));
const finishedRows = allRows.filter(({ row }) => row.status === 'finished');
check('V09-all-finished', finishedRows.length === allRows.length,
  { rows: allRows.length, finished: finishedRows.length,
    failed: allRows.filter(({ row }) => row.status !== 'finished')
      .map(({ run, row }) => `${run.courseId}/${run.scenario}/${row.profile}`) });
check('V09-zero-respawns', allRows.every(({ row }) => row.respawns === 0),
  { total: allRows.reduce((sum, { row }) => sum + row.respawns, 0) });
check('V09-zero-nan', allRows.every(({ row }) => row.nanTicks === 0),
  { total: allRows.reduce((sum, { row }) => sum + row.nanTicks, 0) });

check('V10-no-violations', allRows.every(({ row }) => row.violations.length === 0),
  { violations: allRows.flatMap(({ run, row }) => row.violations.map((violation) => ({
    course: run.courseId, scenario: run.scenario, profile: row.profile, ...violation }))).slice(0, 10) });
check('V10-no-post-finish-intents',
  allRows.every(({ row }) => row.postFinishIntents === 0 && row.postFinishUseIntents === 0),
  { maxPostFinish: Math.max(...allRows.map(({ row }) => row.postFinishIntents)) });
check('V10-no-double-fire',
  allRows.every(({ row }) => row.maxUsesPerPlayerPerTick <= 1),
  { max: Math.max(...allRows.map(({ row }) => row.maxUsesPerPlayerPerTick)) });

check('V11-world-event-validity',
  runs.every((run) => run.worldEventValidity.invalid === 0 &&
    run.worldEventValidity.seqMonotonic === true &&
    run.worldEventCount > 0 && /^sha256:[0-9a-f]{64}$/.test(run.eventAggregate)),
  { runs: runs.length });
check('V11-decision-hash-format',
  runs.every((run) => /^sha256:[0-9a-f]{64}$/.test(run.decisionAggregate) &&
    /^sha256:[0-9a-f]{64}$/.test(run.runHash)), { runs: runs.length });

const expectedPickupCounts = {
  'pwr2-provisional-6': 6,
  '8type-provisional-12': 12,
  'recovered-loop01': 2,
  'degraded-unsupported-shock-bomb': 3,
};
check('V12-pickup-layout-counts',
  runs.every((run) => run.spawnedPickups.length === expectedPickupCounts[run.scenario]),
  { actual: runs.map((run) => `${run.courseId}/${run.scenario}:${run.spawnedPickups.length}`) });

const usage = results.usageByProfile;
check('V13-usage-profiles', ['cautious', 'standard', 'reference'].every((profile) =>
  usage[profile] && usage[profile].soloRuns > 0 &&
  Number.isFinite(usage[profile].totalUses)), {
  runs: Object.fromEntries(Object.entries(usage).map(([profile, value]) => [profile, value.soloRuns])),
});
let usageMatches = 0;
for (const [profile, value] of Object.entries(usage)) {
  let sum = 0;
  for (const scenario of value.soloScenarios) {
    sum += Object.values(scenario.useCounts).reduce((inner, count) => inner + count, 0);
  }
  if (sum === value.totalUses) usageMatches += 1;
}
check('V13-usage-sums', usageMatches === Object.keys(usage).length, { usageMatches });

const degraded = runs.find((run) => run.kind === 'degraded');
check('V14-degradation-run', Boolean(degraded), degraded ? degraded.scenario : null);
if (degraded) {
  const row = degraded.rows[0];
  check('V14-degradation-supported-types',
    !row.supportedTypes.includes('Shock') && !row.supportedTypes.includes('Bomb'),
    row.supportedTypes);
  check('V14-degradation-no-uses',
    !(row.useCounts.Shock > 0) && !(row.useCounts.Bomb > 0), row.useCounts);
  check('V14-degradation-typed-skips',
    row.skipCounts.Shock > 0 && row.skipCounts.Bomb > 0, row.skipCounts);
}

// ---------------------------------------------------------------------------
// V15-V18: determinism, source hygiene and the recovered-data cross-check.
// ---------------------------------------------------------------------------

if (previousExists) {
  const currentCanonical = hashOf(results);
  const previousCanonical = hashOf(previous);
  check('V15-two-process-byte-identical', currentCanonical === previousCanonical,
    { current: currentCanonical, previous: previousCanonical });
  check('V15-file-bytes-equal',
    sha256Hex(readFileSync(RESULTS)) === sha256Hex(readFileSync(PREVIOUS)),
    { current: sha256Hex(readFileSync(RESULTS)),
      previous: sha256Hex(readFileSync(PREVIOUS)) });
  check('V15-decision-aggregate-equal',
    results.determinism.decisionAggregate === previous.determinism.decisionAggregate,
    { current: results.determinism.decisionAggregate,
      previous: previous.determinism.decisionAggregate });
  check('V15-event-aggregate-equal',
    results.determinism.eventAggregate === previous.determinism.eventAggregate,
    { current: results.determinism.eventAggregate,
      previous: previous.determinism.eventAggregate });
  const currentFingerprint = runs.map((run) => ({
    scenario: run.scenario, courseId: run.courseId, kind: run.kind, runHash: run.runHash,
  }));
  const previousFingerprint = previous.runs.map((run) => ({
    scenario: run.scenario, courseId: run.courseId, kind: run.kind, runHash: run.runHash,
  }));
  check('V15-run-hashes-equal',
    JSON.stringify(currentFingerprint) === JSON.stringify(previousFingerprint),
    { current: currentFingerprint, previous: previousFingerprint });
} else {
  check('V15-two-process-byte-identical', false,
    'missing results-powerups.previous.json; run the harness twice');
}

const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
const policySource = stripComments(readFileSync(path.join(HERE, 'rules/ai-powerups.mjs'), 'utf8'));
const runnerSource = stripComments(readFileSync(path.join(HERE, 'run-powerups.mjs'), 'utf8'));
const forbidden = ['Math.random', 'Date.now', 'performance.now', 'new Date',
  'setTimeout', 'setInterval'];
check('V16-source-hygiene', forbidden.every((token) =>
  !policySource.includes(token) && !runnerSource.includes(token)), {
  forbidden: forbidden.filter((token) =>
    policySource.includes(token) || runnerSource.includes(token)),
});

check('V17-recovered-cross-check',
  results.inputs.recoveredAiCrossCheck.controllerRows === 5 &&
  results.inputs.recoveredAiCrossCheck.aiPerkUseEntries === 0 &&
  results.inputs.recoveredAiCrossCheck.difficultyPerkRecords === 0,
  results.inputs.recoveredAiCrossCheck);

const resultsFileHash = sha256Hex(readFileSync(RESULTS));
check('V18-results-hash', /^[0-9a-f]{64}$/.test(resultsFileHash), {
  fileSha256: resultsFileHash,
  bytes: readFileSync(RESULTS).length,
});

const report = {
  kind: 'blur.ai-powerups-verify',
  version: 1,
  checkedAt: 'deterministic',
  resultsFile: '_work/ai-driver/results-powerups.json',
  resultsSha256: sha256Hex(readFileSync(RESULTS)),
  previousExists,
  checks,
  summary: { total: checks.length, passed, failed },
};
writeFileSync(path.join(OUT, 'verify-powerups.json'),
  JSON.stringify(report, null, 2) + '\n');
console.log(`checks: ${checks.length} total, ${passed} passed, ${failed} failed`);
for (const entry of checks.filter((item) => !item.passed)) {
  console.log(`FAIL ${entry.id}: ${JSON.stringify(entry.detail)}`);
}
if (failed) process.exitCode = 1;
