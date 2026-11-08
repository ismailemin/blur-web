// ROBUST1 harness entry point.
//
// Runs the hand-written malformed-input cases and the deterministic fuzzer,
// writes:
//   _work/robustness/cases.json    every case: expected vs observed outcome
//   _work/robustness/fuzz.json     every fuzz seed and its taxonomy
//   _work/robustness/report.json   counts, ranked findings, determinism hashes
//   _work/logs/robustness/run.log  human-readable summary
//
// Usage: node probes/robustness/run.mjs [--quick]

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildCases, sourceContractCases } from './cases.mjs';
import { ROOT } from './lib/fixtures.mjs';
import { rankFindings, runCase, summarise } from './lib/probe.mjs';
import { runFuzz, fuzzDeterminism } from './fuzz.mjs';

export const WORK = path.join(ROOT, '_work/robustness');
export const LOGS = path.join(ROOT, '_work/logs/robustness');

function sha256(value) {
  return 'sha256:' + createHash('sha256').update(value).digest('hex');
}

function normalise(rows) {
  return rows.map((row) => ({
    id: row.id,
    category: row.category,
    code: row.code,
    error: row.error,
    expected: row.expected
  }));
}

export async function runAll({ write = true } = {}) {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(LOGS, { recursive: true });

  const definitions = [...buildCases(), ...sourceContractCases()];
  const seen = new Set();
  for (const definition of definitions) {
    if (seen.has(definition.id)) throw new Error('duplicate case id: ' + definition.id);
    seen.add(definition.id);
  }

  const first = [];
  for (const definition of definitions) first.push(await runCase(definition));
  const summary = summarise(first);
  const findings = rankFindings(first);

  const fuzzFirst = runFuzz();
  const fuzzSecond = runFuzz();
  const fuzzHashA = sha256(JSON.stringify(fuzzFirst.cases));
  const fuzzHashB = sha256(JSON.stringify(fuzzSecond.cases));
  const fuzzDeterministic = fuzzHashA === fuzzHashB;
  const determinism = fuzzDeterminism(fuzzFirst);

  // The whole case suite must be deterministic too.
  const second = [];
  for (const definition of definitions) second.push(await runCase(definition));
  const caseHashA = sha256(JSON.stringify(normalise(first)));
  const caseHashB = sha256(JSON.stringify(normalise(second)));

  const report = {
    generatedBy: 'probes/robustness/run.mjs',
    version: 1,
    contract: 'ROBUST1 loader-failure proof',
    caseCount: first.length,
    summary,
    findings,
    fuzz: {
      caseCount: fuzzFirst.cases.length,
      taxonomy: fuzzFirst.taxonomy,
      determinants: fuzzFirst.determinants,
      seeds: fuzzFirst.seeds,
      hashA: fuzzHashA,
      hashB: fuzzHashB,
      deterministic: fuzzDeterministic && determinism.ok,
      determinism
    },
    determinism: {
      runA: caseHashA,
      runB: caseHashB,
      deterministic: caseHashA === caseHashB
    }
  };

  if (write) {
    writeFileSync(path.join(WORK, 'cases.json'), JSON.stringify({
      generatedBy: report.generatedBy,
      caseCount: first.length,
      summary,
      findings,
      cases: first
    }, null, 2));
    writeFileSync(path.join(WORK, 'fuzz.json'), JSON.stringify({
      generatedBy: report.generatedBy,
      caseCount: fuzzFirst.cases.length,
      taxonomy: fuzzFirst.taxonomy,
      determinants: fuzzFirst.determinants,
      seeds: fuzzFirst.seeds,
      hashA: fuzzHashA,
      cases: fuzzFirst.cases
    }, null, 2));
    writeFileSync(path.join(WORK, 'report.json'), JSON.stringify(report, null, 2));

    const lines = [];
    lines.push('ROBUST1 run ' + new Date().toISOString());
    lines.push('cases: ' + summary.total +
      ' | ok ' + summary.ok +
      ' | detected-typed ' + summary.detectedTyped +
      ' | detected-untyped ' + summary.detectedUntyped +
      ' | silent ' + summary.silent +
      ' | crash ' + summary.crash +
      ' | over-strict ' + summary.overStrict);
    lines.push('fuzz: ' + fuzzFirst.cases.length + ' cases, deterministic=' + report.fuzz.deterministic +
      ', taxonomy=' + JSON.stringify(fuzzFirst.taxonomy));
    lines.push('case determinism: ' + report.determinism.deterministic + ' (' + caseHashA + ')');
    lines.push('');
    lines.push('ranked findings (silent/crash/over-strict):');
    for (const finding of findings) {
      lines.push('  risk ' + String(finding.risk).padEnd(5) + ' ' + finding.category.padEnd(9) + ' ' +
        finding.id + ' — ' + finding.description + (finding.code ? ' [' + finding.code + ']' : ''));
    }
    writeFileSync(path.join(LOGS, 'run.log'), lines.join('\n') + '\n');
  }

  return report;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href ||
    process.argv[1]?.endsWith('run.mjs')) {
  const report = await runAll();
  console.log('cases', report.caseCount, report.summary);
  console.log('fuzz', report.fuzz.caseCount, report.fuzz.taxonomy, 'deterministic', report.fuzz.deterministic);
  console.log('findings', report.findings.length);
  for (const finding of report.findings.slice(0, 15)) {
    console.log(' ', finding.risk, finding.category, finding.id, '-', finding.description);
  }
}
