// Verifier for the standalone AI opponent driver evidence.
//
//   node probes/ai-driver/verify.mjs
//
// Reads `_work/ai-driver/results.json` (produced by run.mjs) and, when present,
// `_work/ai-driver/results.previous.json` from an earlier identical invocation.
// Writes `_work/ai-driver/verify.json` and exits non-zero on any failure.
//
// It does not re-run the engine; it checks the recorded evidence and the two
// process-separated result files byte for byte. The engine replay proof is part
// of run.mjs (every per-tick state hash is compared in a fresh wasm instance).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { sha256Hex } from './ai-driver.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/ai-driver');
const RESULTS = path.join(OUT, 'results.json');
const PREVIOUS = path.join(OUT, 'results.previous.json');
const VERIFY = path.join(OUT, 'verify.json');
const DRIVER_SOURCE = path.join(ROOT, 'probes/ai-driver/ai-driver.mjs');

const checks = [];
const check = (id, label, ok, detail = '') => {
  checks.push({ id, label, ok: Boolean(ok), detail: String(detail) });
};

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const exists = (file) => existsSync(file);

mkdirSync(OUT, { recursive: true });

if (!exists(RESULTS)) {
  throw new Error('missing _work/ai-driver/results.json; run `node probes/ai-driver/run.mjs` first');
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
const selectedCourses = selection.courses ?? [];
const selectedProfiles = selection.profiles ?? [];

// ---------------------------------------------------------------------------
// Structural and artifact checks.
// ---------------------------------------------------------------------------

check('V01', 'results kind/version', results.kind === 'blur.ai-driver-results' &&
  results.version === 1, `${results.kind} v${results.version}`);
check('V02', 'driver kind/version', results.driver?.kind === 'blur.ai-driver' &&
  results.driver?.version === 1, `${results.driver?.kind} v${results.driver?.version}`);
check('V03', 'control tables carry the committed follower constants',
  results.driver?.controlTables?.sprint?.cruiseSpeed === 24 &&
  results.driver?.controlTables?.lap?.cruiseSpeed === 10 &&
  results.driver?.controlTables?.lap?.lapPurePursuit === true,
  'sprint cruise 24, lap cruise 10, lap pure pursuit');
check('V04', 'at least three speed-scaled skill profiles are defined',
  (results.driver?.profiles ?? []).filter((profile) => profile.status !== 'experimental').length >= 3,
  (results.driver?.profiles ?? []).map((profile) => `${profile.id}:${profile.speedScale}`).join(', '));
check('V05', 'selected profiles include 0.85 / 0.95 / 1.0',
  ['0.85', '0.95', '1'].every((scale) =>
    (results.driver?.profiles ?? []).some((profile) => String(profile.speedScale) === scale)),
  (results.driver?.profiles ?? []).map((profile) => profile.speedScale).join(', '));

const wasmPath = path.join(ROOT, '_work/e1-drive/module/e1_drive.wasm');
const levelPath = path.join(ROOT, '_work/e1-drive/Level.levelphysics');
const sprintLayoutPath = path.join(ROOT, '_work/e1-drive/sprint.json');
const lapLayoutPath = path.join(ROOT, '_work/e1-drive/sprint-lap.json');
check('V06', 'wasm/level/layout artifacts still match the recorded SHA-256',
  exists(wasmPath) && sha256Hex(readFileSync(wasmPath)) === results.inputs?.module?.wasmSha256,
  results.inputs?.module?.wasmSha256);
check('V07', 'level SHA-256 matches',
  exists(levelPath) && sha256Hex(readFileSync(levelPath)) === results.inputs?.level?.sha256,
  results.inputs?.level?.sha256);
check('V08', 'layout SHA-256s match',
  exists(sprintLayoutPath) && exists(lapLayoutPath) &&
  sha256Hex(readFileSync(sprintLayoutPath)) === results.inputs?.layouts?.['310m']?.fileSha256 &&
  sha256Hex(readFileSync(lapLayoutPath)) === results.inputs?.layouts?.lap?.fileSha256,
  `${results.inputs?.layouts?.['310m']?.fileSha256?.slice(0, 18)} / ${results.inputs?.layouts?.lap?.fileSha256?.slice(0, 18)}`);

// ---------------------------------------------------------------------------
// Per-run checks.
// ---------------------------------------------------------------------------

const expectedRuns = selectedCars.length * selectedCourses.length * selectedProfiles.length;
check('V09', 'one run per selected car/course/profile',
  runs.length === expectedRuns, `${runs.length}/${expectedRuns}`);

let badNan = 0;
let badReplay = 0;
let badFinish = 0;
let badContacts = 0;
let badLateral = 0;
let badHash = 0;
for (const run of runs) {
  if (run.nanTicks !== 0) badNan += 1;
  if (!run.replay?.matchedEveryTick || run.replay?.stateSequenceHash !== run.stateSequenceHash) {
    badReplay += 1;
  }
  const supported = run.profile !== 'aggressive';
  if (supported && run.status !== 'finished') badFinish += 1;
  if (run.status === 'finished') {
    const corr = results.inputs?.layouts?.[run.courseId]?.summary?.corridorHalfWidthMetres;
    if (!Number.isFinite(run.timeSeconds) || !Number.isFinite(run.finish?.tick) ||
        Math.abs(run.finish.tick - run.timeSeconds * 60) > 1e-3) {
      badFinish += 1;
    }
    if (run.respawns === 0 && run.contacts.ticksWithAnyContact !== run.contacts.runningTicks) {
      badContacts += 1;
    }
    if (run.respawns === 0 && Number.isFinite(corr) &&
        run.maxLateralMetres > corr + 1e-6) {
      badLateral += 1;
    }
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(run.stateSequenceHash ?? '') ||
      !/^sha256:[0-9a-f]{64}$/.test(run.replay?.stateSequenceHash ?? '')) {
    badHash += 1;
  }
}
check('V10', 'every run has zero NaN ticks', badNan === 0, `${badNan} runs with NaN`);
check('V11', 'every run per-tick replay matches and aggregates agree', badReplay === 0,
  `${badReplay} mismatched runs; ${results.determinism?.perRunReplayStatesCompared ?? 0} states compared`);
check('V12', 'supported profiles finish every selected run', badFinish === 0,
  `${badFinish} non-finishing/malformed supported runs`);
check('V13', 'clean runs keep wheel contact on every running tick', badContacts === 0,
  `${badContacts} runs with contact gaps`);
check('V14', 'clean runs stay inside the declared corridor', badLateral === 0,
  `${badLateral} runs outside the declared band`);
check('V15', 'all state-sequence hashes are canonical sha256 values', badHash === 0,
  `${badHash} bad hashes`);

// ---------------------------------------------------------------------------
// Committed follower comparison.
// ---------------------------------------------------------------------------

const committed = Array.isArray(results.committedComparison) ? results.committedComparison : [];
const referenceRuns = runs.filter((run) => run.profile === 'reference');
const committedRows = committed.filter((row) => row.courseId === '310m' || row.courseId === 'lap');
const committedPresent = committedRows.length > 0 &&
  committedRows.every((row) => row.committed && row.ai?.timeSeconds !== null);
const maxDifference = committedRows.reduce((max, row) =>
  row.differenceSeconds === null ? max : Math.max(max, Math.abs(row.differenceSeconds)), 0);
const committedRowsWithReference = committedRows.filter((row) => row.committed);
const committedMissing = committedRows.filter((row) => !row.committed);
check('V16', 'every car/course with a committed follower time was compared',
  committedRowsWithReference.length > 0 &&
  committedRowsWithReference.every((row) => row.ai?.timeSeconds !== null),
  `${committedRowsWithReference.length}/${committedRows.length} present` +
  (committedMissing.length ? `; no committed reference: ` +
    committedMissing.map((row) => `${row.car}/${row.courseId}`).join(', ') : ''));
check('V17', 'AI reference times stay within 50 ms of the committed follower',
  committedRowsWithReference.length > 0 && maxDifference <= 0.05,
  `max |difference| = ${maxDifference.toFixed(6)} s over ${committedRowsWithReference.length} rows`);

// ---------------------------------------------------------------------------
// Skill profiles.
// ---------------------------------------------------------------------------

const supportedProfiles = profiles.filter((profile) => profile.id !== 'aggressive');
const cleanSupported = supportedProfiles.filter((profile) =>
  profile.runs > 0 && profile.clean === profile.runs && profile.finished === profile.runs);
check('V18', 'every supported skill profile finishes every run',
  supportedProfiles.every((profile) => profile.runs > 0 && profile.finished === profile.runs),
  supportedProfiles.map((profile) => `${profile.id}:${profile.finished}/${profile.runs}`).join(', '));
// Respawn exceptions are recorded, not hidden: a heavy car can leave the River
// lap's 1.25 m band at a cautious/reference speed.
const respawnExceptions = supportedProfiles.flatMap((profile) =>
  (profile.failed ?? []).map((row) => `${profile.id}/${row.car}/${row.courseId}:${row.respawns}`));
check('V18b', 'respawn exceptions are listed with car, course and count',
  respawnExceptions.length <= 4 && supportedProfiles.every((profile) =>
    (profile.failed ?? []).every((row) => typeof row.car === 'string' &&
      typeof row.courseId === 'string' && Number.isInteger(row.respawns))),
  respawnExceptions.join(', ') || 'none');
const aggressive = profiles.find((profile) => profile.id === 'aggressive');
check('V19', 'experimental profile result is recorded, including failures',
  !aggressive || (aggressive.runs > 0 &&
    (aggressive.failed.length === 0 || aggressive.failed.every((failure) =>
      typeof failure.courseId === 'string' && typeof failure.car === 'string'))),
  aggressive ? `clean ${aggressive.clean}/${aggressive.runs}, failed ${aggressive.failed.length}` : 'no aggressive profile');

// ---------------------------------------------------------------------------
// Multi-AI race.
// ---------------------------------------------------------------------------

const expectedRace = races.find((race) => race.entries && race.entries.length >= 2 &&
  race.entries.length <= 4);
const racePositions = expectedRace?.entries?.map((entry) => entry.position) ?? [];
const orderedPositions = racePositions.every((position, index) => position === index + 1);
const raceFinishTicks = expectedRace?.entries?.map((entry) => entry.finishTick) ?? [];
const ascending = raceFinishTicks.every((tick, index) =>
  index === 0 || (raceFinishTicks[index - 1] <= tick));
check('V20', 'a 2-4 AI race exists and every entrant finished', Boolean(expectedRace) &&
  expectedRace.entries.length >= 2 && expectedRace.entries.length <= 4 &&
  expectedRace.entries.every((entry) => entry.status === 'finished'),
  expectedRace ? `${expectedRace.name}: ${expectedRace.entries.length} entrants` : 'missing');
check('V21', 'race positions are ordered by finish tick without gaps',
  orderedPositions && ascending,
  `${raceFinishTicks.join(', ')}`);
check('V22', 'the race is deterministic across two fresh instance sets',
  races.every((race) => race.deterministic === true),
  races.map((race) => `${race.name}:${race.deterministic}`).join(', '));
check('V23', 'the race replay reproduces every car hash',
  races.every((race) => race.replayMatchedEveryTick === true) &&
  (results.determinism?.raceReplayStatesCompared ?? 0) > 0,
  races.map((race) => `${race.name}:${race.replayMatchedEveryTick}`).join(', ') +
  `; ${results.determinism?.raceReplayStatesCompared ?? 0} states compared`);

// ---------------------------------------------------------------------------
// Determinism and source hygiene.
// ---------------------------------------------------------------------------

check('V24', 'all per-run replay flags agree with the summary',
  results.determinism?.perRunReplayAllMatch === true &&
  results.determinism?.racesDeterministic === true &&
  results.determinism?.racesReplayMatched === true,
  JSON.stringify(results.determinism));

check('V25', 'two process-separated runs are byte-identical', byteIdentical === true,
  previousExists ? `${resultsSha256} vs ${previousSha256}` : 'results.previous.json not present (skipped)');

const source = existsSync(DRIVER_SOURCE) ? readFileSync(DRIVER_SOURCE, 'utf8') : '';
check('V26', 'driver source contains no random or wall-clock call',
  source.length > 0 && !/Math\.random\s*\(/.test(source) && !/Date\.now\s*\(/.test(source) &&
  !/performance\.now\s*\(/.test(source) && !/new\s+Date\s*\(/.test(source) &&
  !/setTimeout\s*\(/.test(source) && !/setInterval\s*\(/.test(source),
  'no Math.random/Date.now/performance.now/new Date/timer calls');

const failed = checks.filter((item) => !item.ok);
const report = {
  kind: 'blur.ai-driver-verify',
  version: 1,
  command: 'node probes/ai-driver/verify.mjs',
  results: {
    path: '_work/ai-driver/results.json',
    sha256: resultsSha256,
    bytes: resultsBytes.length,
    kind: results.kind,
    version: results.version
  },
  previous: previousExists ? {
    path: '_work/ai-driver/results.previous.json',
    sha256: previousSha256,
    bytes: previousBytes.length,
    byteIdentical
  } : null,
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  checks,
  summary: {
    runs: runs.length,
    finished: runs.filter((run) => run.status === 'finished').length,
    clean: runs.filter((run) => run.clean).length,
    statesCompared: results.determinism?.perRunReplayStatesCompared ?? 0,
    profiles: profiles.map((profile) => ({
      id: profile.id, speedScale: profile.speedScale,
      clean: profile.clean, runs: profile.runs, failed: profile.failed.length
    })),
    races: races.map((race) => ({
      name: race.name, order: race.order, deterministic: race.deterministic,
      replayMatchedEveryTick: race.replayMatchedEveryTick
    })),
    committedMaxDifferenceSeconds: Number(maxDifference.toFixed(6))
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
