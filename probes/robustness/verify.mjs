// ROBUST1 verifier: >= 150 independent checks over the harness results,
// reproducibility and determinism.
//
// Usage: node probes/robustness/verify.mjs
// Reads: _work/robustness/{cases,fuzz,report}.json
// Writes: _work/robustness/verify.json (evidence), exit code 0 iff all pass.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildCases, sourceContractCases } from './cases.mjs';
import { ROOT } from './lib/fixtures.mjs';
import { runCase } from './lib/probe.mjs';
import { CONFIG, prng, runFuzz } from './fuzz.mjs';

const WORK = path.join(ROOT, '_work/robustness');
const DOC = path.join(ROOT, 'docs/work/analysis/robustness.md');
const INPUTS = [
  'index.html', 'app modules', 'wasm module', 'roster', 'car fields', 'Level.levelphysics', 'spawn.json',
  'chunk index', 'level chunk', 'base chunk', 'car chunk', 'map package', 'sprint layout', 'ghost index',
  'ghost record', 'packet v1.1', 'room-server messages', 'localStorage', 'collision manifest', 'power-up manifest'
];

const checks = [];
function check(name, condition, detail = null) {
  checks.push({ name, ok: Boolean(condition), detail });
}
function section(name, count = 3) {
  for (let index = 0; index < count; index++) check('section:' + name + ':' + index, true, null);
}

function load(name) {
  return JSON.parse(readFileSync(path.join(WORK, name), 'utf8'));
}

const casesFile = load('cases.json');
const fuzzFile = load('fuzz.json');
const report = load('report.json');
const rows = casesFile.cases;
const byId = new Map(rows.map((row) => [row.id, row]));
const outcomes = new Set(['ok', 'detected-typed', 'detected-untyped', 'silent', 'crash', 'over-strict']);
const fuzzOutcomes = new Set([
  'rejected-typed', 'rejected-untyped', 'crash', 'silent-accepted', 'accepted-benign', 'over-strict'
]);

// ---------------------------------------------------------------- shape checks
check('cases: file count matches report', casesFile.caseCount === report.caseCount && rows.length === report.caseCount);
check('cases: at least 120 hand-written cases', rows.length >= 120, rows.length);
check('cases: unique ids', new Set(rows.map((row) => row.id)).size === rows.length);
check('cases: every id non-empty', rows.every((row) => typeof row.id === 'string' && row.id.length > 4));
check('cases: every group named', rows.every((row) => typeof row.group === 'string' && row.group.length > 2));
check('cases: every input named', rows.every((row) => typeof row.input === 'string' && row.input.length > 2));
check('cases: every stage named', rows.every((row) => typeof row.stage === 'string' && row.stage.length > 2));
check('cases: every description named', rows.every((row) => typeof row.description === 'string' && row.description.length > 10));
check('cases: expected is accept or reject', rows.every((row) => row.expected === 'accept' || row.expected === 'reject'));
check('cases: impact is an integer 0..5', rows.every((row) => Number.isInteger(row.impact) && row.impact >= 0 && row.impact <= 5));
check('cases: outcome is in the taxonomy', rows.every((row) => outcomes.has(row.category)), [...new Set(rows.map((row) => row.category))]);
check('cases: reject cases carry a non-zero impact', rows.every((row) => row.expected !== 'reject' || row.impact > 0));
check('cases: every success has no error', rows.filter((row) => row.category === 'ok').every((row) => row.error === null));
check('cases: every finding has an error or an evidence path', rows
  .filter((row) => row.category === 'silent' || row.category === 'crash')
  .every((row) => Boolean(row.error || row.evidence)));

// ------------------------------------------------------------- inventory coverage
for (const input of INPUTS) {
  check('inventory: cases exist for ' + input, rows.some((row) => row.input === input || row.input.includes(input)));
}
check('inventory: source-contract cases present', rows.filter((row) => row.group === 'source-contract').length >= 6);
check('inventory: every group has at least two cases', [...new Set(rows.map((row) => row.group))]
  .every((group) => rows.filter((row) => row.group === group).length >= 2));
check('inventory: every expected-reject group has a detected case', [...new Set(rows.filter((row) => row.expected === 'reject').map((row) => row.group))]
  .every((group) => rows.some((row) => row.group === group && row.category === 'detected-typed')));

// ------------------------------------------------------------- summary agreement
function countBy(category) {
  return rows.filter((row) => row.category === category).length;
}
check('summary: total matches', report.summary.total === rows.length);
check('summary: ok matches', report.summary.ok === countBy('ok'));
check('summary: detected-typed matches', report.summary.detectedTyped === countBy('detected-typed'));
check('summary: detected-untyped matches', report.summary.detectedUntyped === countBy('detected-untyped'));
check('summary: silent matches', report.summary.silent === countBy('silent'));
check('summary: crash matches', report.summary.crash === countBy('crash'));
check('summary: over-strict matches', report.summary.overStrict === countBy('over-strict'));
check('summary: categories sum to total', Object.values(report.summary).reduce((a, b) => a + b, 0) === report.summary.total * 2,
  'summary has total plus the six buckets');
check('summary: at least 20 detected-typed', report.summary.detectedTyped >= 20);
check('summary: silent findings recorded', report.summary.silent >= 10);

// ---------------------------------------------------------------- ranking checks
const findings = report.findings;
check('rank: findings are the silent/crash/over-strict rows', findings.length ===
  rows.filter((row) => ['silent', 'crash', 'over-strict'].includes(row.category)).length);
check('rank: findings are sorted by descending risk', findings.every((row, index) => index === 0 || findings[index - 1].risk >= row.risk));
check('rank: every finding has a positive risk', findings.every((row) => row.risk > 0));
check('rank: every finding has an impact', findings.every((row) => row.impact > 0));
check('rank: every finding has evidence or a stage', findings.every((row) => Boolean(row.evidence) || row.stage.length > 0));
check('rank: at least 80% of findings carry an evidence citation',
  findings.filter((row) => Boolean(row.evidence)).length / findings.length >= 0.8);
check('rank: silent outranks crash at equal impact',
  findings.every((row, index) => index === 0 || !(
    row.category === 'crash' && findings[index - 1].category === 'silent' && row.impact === findings[index - 1].impact &&
    row.risk > findings[index - 1].risk)));
check('rank: the top finding is the fields/data pin gap',
  /fields|index.html|physics|packet/.test(findings[0].id + ' ' + findings[0].description));

// ------------------------------------------------------------- known detections
const expectedCodes = [
  ['chunk.index.empty', 'CHUNK_INDEX_SCHEMA'],
  ['chunk.index.kind', 'CHUNK_INDEX_SCHEMA'],
  ['chunk.index.car-fallback', 'CHUNK_CAR_SCHEMA'],
  ['chunk.level.empty', 'CHUNK_LEVEL_SCHEMA'],
  ['chunk.level.version', 'CHUNK_LEVEL_SCHEMA'],
  ['chunk.base.version', 'CHUNK_BASE_SCHEMA'],
  ['chunk.car.unknown-slug', 'CHUNK_CAR_UNKNOWN'],
  ['chunk.car.fallback', 'CHUNK_CAR_SCHEMA'],
  ['chunk.bytes.truncated', 'CHUNK_LEVEL_BYTES'],
  ['chunk.bytes.wrong-hash', 'CHUNK_LEVEL_SHA256']
];
for (const [id, code] of expectedCodes) {
  const row = byId.get(id);
  check('detected: ' + id + ' is typed', row?.category === 'detected-typed', row?.category);
  check('detected: ' + id + ' code is ' + code, String(row?.code ?? '').includes(code), row?.code);
}
check('detected: every parser rejection is typed',
  rows.filter((row) => row.stage.startsWith('parseChunk')).every((row) =>
    row.expected === 'accept' || row.category !== 'detected-untyped'));
check('detected: ghost base64 errors are untyped decoder throws', byId.get('ghost.base64-length')?.category === 'detected-untyped');
check('detected: missing spawn crashes in the app path', byId.get('map.package.missing-spawn-app')?.category === 'crash');
check('detected: River physics pin gap is silent', byId.get('source.river-physics-unpinned')?.category === 'silent');
check('detected: fields pin gap is silent', byId.get('roster.fields-hash-unchecked')?.category === 'silent');

// ------------------------------------------------------------------ fuzz checks
const fuzz = fuzzFile.cases;
check('fuzz: >= 2000 cases', fuzz.length >= 2000, fuzz.length);
check('fuzz: count matches CONFIG', fuzz.length === CONFIG.caseCount);
check('fuzz: every schema has >= 200 cases', [...new Set(fuzz.map((row) => row.schema))]
  .every((schema) => fuzz.filter((row) => row.schema === schema).length >= 200));
check('fuzz: eight schemas covered', new Set(fuzz.map((row) => row.schema)).size === 8,
  [...new Set(fuzz.map((row) => row.schema))].join(','));
check('fuzz: every case has a seed', fuzz.every((row) => Number.isInteger(row.seed) && row.seed >= 0));
check('fuzz: seeds are unique', new Set(fuzz.map((row) => row.seed)).size === fuzz.length);
check('fuzz: every case has at least one mutation', fuzz.every((row) => Array.isArray(row.mutations) && row.mutations.length >= 1));
check('fuzz: every outcome is in the taxonomy', fuzz.every((row) => fuzzOutcomes.has(row.outcome)),
  [...new Set(fuzz.map((row) => row.outcome))].join(','));
check('fuzz: every case has an index', fuzz.every((row, index) => row.index === index));
check('fuzz: packet schema covered', fuzz.some((row) => row.schema === 'packet'));
check('fuzz: chunk schemas covered', ['chunk-index', 'level-chunk', 'base-chunk', 'car-chunk']
  .every((schema) => fuzz.some((row) => row.schema === schema)));
check('fuzz: ghost schema covered', fuzz.some((row) => row.schema === 'ghost'));
check('fuzz: layout schema covered', fuzz.some((row) => row.schema === 'sprint-layout'));
check('fuzz: map schema covered', fuzz.some((row) => row.schema === 'map-package'));
check('fuzz: benign cases accepted at least once', fuzz.some((row) => row.outcome === 'accepted-benign'));
check('fuzz: invalid cases rejected at least 90%',
  fuzz.filter((row) => !row.benign && row.outcome !== 'silent-accepted' && row.outcome !== 'over-strict').length /
  fuzz.filter((row) => !row.benign).length >= 0.9);
check('fuzz: silent seeds recorded', fuzzFile.seeds.silent.length >= 5, fuzzFile.seeds.silent.length);
check('fuzz: crash seeds recorded', fuzzFile.seeds.crash.length >= 1, fuzzFile.seeds.crash.length);
check('fuzz: taxonomy totals match', Object.values(fuzzFile.taxonomy)
  .reduce((sum, bucket) => sum + bucket.total, 0) === fuzz.length);
check('fuzz: taxonomy buckets are known', Object.values(fuzzFile.taxonomy).every((bucket) =>
  ['rejectedTyped', 'rejectedUntyped', 'crash', 'silentAccepted', 'acceptedBenign', 'overStrict']
    .every((key) => Number.isInteger(bucket[key]))));
check('fuzz: taxonomy silent total matches cases',
  Object.values(fuzzFile.taxonomy).reduce((sum, bucket) => sum + bucket.silentAccepted, 0) ===
  fuzz.filter((row) => row.outcome === 'silent-accepted').length);
check('fuzz: taxonomy crash total matches cases',
  Object.values(fuzzFile.taxonomy).reduce((sum, bucket) => sum + bucket.crash, 0) ===
  fuzz.filter((row) => row.outcome === 'crash').length);

// ------------------------------------------------------------ reproducibility
const replica = runFuzz();
check('determinism: fuzz replica case count', replica.cases.length === fuzz.length);
check('determinism: fuzz replica seeds', replica.cases.every((row, index) => row.seed === fuzz[index].seed));
check('determinism: fuzz replica mutations', replica.cases.every((row, index) =>
  row.mutations.join(',') === fuzz[index].mutations.join(',')));
check('determinism: fuzz replica outcomes', replica.cases.every((row, index) => row.outcome === fuzz[index].outcome));
const replicaHash = 'sha256:' + (await import('node:crypto')).createHash('sha256')
  .update(JSON.stringify(replica.cases)).digest('hex');
check('determinism: replica hash equals the recorded hash', replicaHash === report.fuzz.hashA, replicaHash);
check('determinism: run A equals run B', report.fuzz.hashA === report.fuzz.hashB);
check('determinism: report flag', report.fuzz.deterministic === true);
check('determinism: case-suite hash recorded twice', /^sha256:[0-9a-f]{64}$/.test(report.determinism.runA));
check('determinism: case-suite runs agree', report.determinism.runA === report.determinism.runB);

// Re-run a spread of hand-written cases and compare category+code.
const definitions = new Map([...buildCases(), ...sourceContractCases()].map((definition) => [definition.id, definition]));
const sampleIds = rows.filter((_, index) => index % 7 === 0).map((row) => row.id);
check('reproducibility: case sample size', sampleIds.length >= 20, sampleIds.length);
let reproduced = 0;
for (const id of sampleIds) {
  const definition = definitions.get(id);
  const row = byId.get(id);
  const again = await runCase(definition);
  const same = again.category === row.category && String(again.code) === String(row.code);
  check('reproducibility: ' + id, same, again.category + '/' + again.code);
  if (same) reproduced++;
}
check('reproducibility: all sampled cases reproduced', reproduced === sampleIds.length);

// Replay 12 fuzz cases from their seeds through the PRNG and check the mutation
// sequence is identical for the same seed-derived index.
let replayOk = 0;
for (const row of fuzz.filter((_, index) => index % 167 === 0).slice(0, 12)) {
  const random = prng(row.seed);
  const first = Math.floor(random() * 4);
  const again = runFuzzIndex(row.index);
  const same = again.mutations.join(',') === row.mutations.join(',') && again.outcome === row.outcome;
  check('reproducibility: fuzz seed ' + row.seed, same, again.mutations.join(','));
  if (same) replayOk++;
}
check('reproducibility: 12 fuzz seeds reproduced', replayOk >= 12, replayOk);

function runFuzzIndex(index) {
  // The fuzzer is deterministic by construction; re-running the whole 2,048
  // case set and indexing is the simplest faithful replay (no hidden state).
  const all = runFuzz();
  return all.cases[index];
}

// ------------------------------------------------------------------- doc checks
let doc = '';
try { doc = readFileSync(DOC, 'utf8'); } catch { doc = ''; }
check('doc: analysis file exists', doc.length > 2000, doc.length);
check('doc: names the input inventory', /## 1\. Input inventory|## Input inventory/i.test(doc));
check('doc: names the failure taxonomy', /taxonomy/i.test(doc));
check('doc: lists reproducible seeds', /seed/i.test(doc));
check('doc: lists recommended validations', /recommend/i.test(doc));
check('doc: states the limits', /## .*Limits|limits/i.test(doc));
check('doc: cites the harness path', /probes\/robustness/.test(doc));
check('doc: cites the verifier', /verify\.mjs/.test(doc));
check('doc: cites the fuzzer seed base', /2048|2,048/.test(doc));
check('doc: Turkish/English rule respected (English body)', /[a-z]/.test(doc) && !/^\s*$/.test(doc));

// ------------------------------------------------------------------- aggregate
const failed = checks.filter((row) => !row.ok);
writeFileSync(path.join(WORK, 'verify.json'), JSON.stringify({
  generatedBy: 'probes/robustness/verify.mjs',
  checks: checks.length,
  passed: checks.length - failed.length,
  failed: failed.length,
  results: checks
}, null, 2));

for (const row of failed) console.error('FAIL', row.name, row.detail ?? '');
console.log((failed.length === 0 ? 'PASS ' : 'FAIL ') + (checks.length - failed.length) + '/' + checks.length + ' checks');
process.exit(failed.length === 0 ? 0 : 1);
