#!/usr/bin/env node
// Verify `probes/map-laps/data/remaining-paths.json` against the committed data.
//
//   node probes/map-laps/tools/verify_remaining_paths.mjs
//   node probes/map-laps/tools/verify_remaining_paths.mjs --python <python.exe>
//
// The summary is checked, not trusted. For every one of the twelve map-batch
// levels it re-derives the verdict from the committed files:
//
//   path         probes/map-laps/data/<mapId>-path.json exists, its canonical
//                hash and file SHA-256 match, its sample length and gate arcs
//                are recomputed, and its clearance / corridor cells match;
//   blocked      no path document exists, `_work/map-laps/<mapId>/blocked.json`
//                exists and its stage, reason, clearance / corridor cells and
//                blocked-sample count match the summary;
//   unsupported  no path document exists and `map-decisions.json` records the
//                committed `showroom-mode` blocker.
//
// It also checks the batch path length and the map-pipeline draw/collision
// lengths, the canonical summary hash, the scope labels, and determinism (the
// generator twice, byte-identical, plus `--check`).
//
// Prints "N/M checks passed"; exits 1 on any failure.

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GENERATOR = path.join(ROOT, 'probes/map-laps/tools/build_remaining_paths.py');
const SUMMARY = 'probes/map-laps/data/remaining-paths.json';
const DECISIONS = 'probes/map-pipeline/data/map-decisions.json';
const MIN_CLEARANCE_CELLS = 3;

// The twelve levels and the verdict each must carry. This table is the
// independent expectation; the summary has to agree with it.
const EXPECTED = [
  { level: 'uk_london_hackney', mapId: 'hackney', verdict: 'blocked' },
  { level: 'usa_ny_dumbo', mapId: 'dumbo', verdict: 'blocked' },
  { level: 'usa_la_multiplayer_highrise', mapId: 'highrise', verdict: 'path' },
  { level: 'jpn_tokyo_shutoko', mapId: 'shutoko', verdict: 'path' },
  { level: 'uk_brighton', mapId: 'brighton', verdict: 'blocked' },
  { level: 'usa_sanfran_sausalito', mapId: 'sausalito', verdict: 'blocked' },
  { level: 'usa_sanfran_russianhill', mapId: 'russianhill', verdict: 'blocked' },
  { level: 'spa_barcelona_oval', mapId: 'oval', verdict: 'path' },
  { level: 'usa_amboy_multiplayer', mapId: 'amboy-mp', verdict: 'path' },
  { level: 'usa_la_downtown_multiplayer', mapId: 'downtown-mp', verdict: 'blocked' },
  { level: 'spa_barcelona_bowl_multiplayer', mapId: 'bowl', verdict: 'blocked' },
  { level: 'showroom', mapId: 'showroom', verdict: 'unsupported' }
];

const sha256 = (buffer) => 'sha256:' + createHash('sha256').update(buffer).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}
const hashOf = (value) => 'sha256:' + createHash('sha256')
  .update(JSON.stringify(sortValue(value))).digest('hex');
const bodyHash = (doc) => {
  const body = { ...doc };
  delete body.hash;
  return hashOf(body);
};

const checks = [];
function check(label, ok, detail = null) {
  checks.push({ label, ok: Boolean(ok), detail });
  return Boolean(ok);
}

function resolvePython() {
  const index = process.argv.indexOf('--python');
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (process.env.BLUR_PYTHON) return process.env.BLUR_PYTHON;
  const bundled = 'C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
  return existsSync(bundled) ? bundled : 'python';
}

function near(a, b, tol) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
}

// ---------------------------------------------------------------- main
const summaryPath = path.join(ROOT, SUMMARY);
if (!existsSync(summaryPath)) {
  console.log('FAIL summary exists: ' + SUMMARY);
  console.log('0/1 checks passed');
  process.exit(1);
}
const doc = readJson(summaryPath);
const decisions = readJson(path.join(ROOT, DECISIONS));
const decisionsByLevel = new Map(decisions.levels.map((row) => [row.level, row]));

check('summary schema is blur.map-laps.remaining-paths/1',
  doc.schema === 'blur.map-laps.remaining-paths/1', doc.schema);
check('summary hash matches its canonical JSON', doc.hash === bodyHash(doc), doc.hash);
check('summary scope is collision-only with no renderer/vehicle/game/driven claim',
  doc.scope?.collisionOnly === true && doc.scope?.drawGeometryRead === false &&
  doc.scope?.rendererClaim === false && doc.scope?.vehiclePhysics === false &&
  doc.scope?.gameRun === false && doc.scope?.pathDriven === false,
  JSON.stringify(doc.scope));
check('summary source pins the committed map-decisions.json',
  doc.source?.mapDecisions?.path === DECISIONS &&
  doc.source.mapDecisions.sha256 === sha256(readFileSync(path.join(ROOT, DECISIONS))) &&
  doc.source.mapDecisions.bytes === readFileSync(path.join(ROOT, DECISIONS)).length,
  doc.source?.mapDecisions?.sha256);

const rows = Array.isArray(doc.levels) ? doc.levels : [];
check('summary lists exactly the twelve expected levels in order',
  rows.length === EXPECTED.length &&
  rows.every((row, index) => row.level === EXPECTED[index].level &&
    row.mapId === EXPECTED[index].mapId),
  rows.map((row) => row.level).join(','));

const counts = { path: 0, blocked: 0, unsupported: 0 };
for (const row of rows) if (counts[row.verdict] !== undefined) counts[row.verdict]++;
check('summary counts agree with the rows',
  doc.summary?.levelCount === rows.length &&
  doc.summary?.counts?.path === counts.path &&
  doc.summary?.counts?.blocked === counts.blocked &&
  doc.summary?.counts?.unsupported === counts.unsupported,
  JSON.stringify(doc.summary));

for (let index = 0; index < EXPECTED.length; index++) {
  const spec = EXPECTED[index];
  const row = rows[index];
  const tag = spec.mapId + ': ';
  if (!row) {
    check(tag + 'row exists', false, 'missing');
    continue;
  }

  check(tag + 'level and mapId match the expected table',
    row.level === spec.level && row.mapId === spec.mapId,
    `${row.level}/${row.mapId}`);
  check(tag + 'verdict is ' + spec.verdict, row.verdict === spec.verdict, row.verdict);

  // ------------------------------------------------------ batch + decisions
  const batchPath = path.join(ROOT, '_work/map-batch', spec.level, 'path.json');
  const batch = readJson(batchPath);
  check(tag + 'batch path length and sample count match the committed package',
    near(row.batchPathMetres, batch.lengthM, 1e-6) &&
    row.batchPathSamples === batch.samples.length,
    `${row.batchPathMetres} vs ${batch.lengthM}, ${row.batchPathSamples} vs ${batch.samples.length}`);

  const decision = decisionsByLevel.get(spec.level);
  check(tag + 'map-decisions draw/collision lengths match',
    decision &&
    near(row.mapDecisionsDrawCoveredM, decision.paths.drawCoveredM, 1e-6) &&
    near(row.mapDecisionsCollisionM, decision.paths.collisionM, 1e-6) &&
    row.mapDecisionsVerdict === decision.verdict,
    JSON.stringify({ draw: row.mapDecisionsDrawCoveredM,
      collision: row.mapDecisionsCollisionM, verdict: row.mapDecisionsVerdict }));

  const pathFile = path.join(ROOT, 'probes/map-laps/data', spec.mapId + '-path.json');

  if (spec.verdict === 'path') {
    if (!existsSync(pathFile)) {
      check(tag + 'committed path document exists', false, path.relative(ROOT, pathFile));
      continue;
    }
    check(tag + 'committed path document exists', true, path.relative(ROOT, pathFile));
    const pathDoc = readJson(pathFile);
    check(tag + 'path file SHA-256 and canonical hash match',
      row.pathFile === 'probes/map-laps/data/' + spec.mapId + '-path.json' &&
      row.pathFileSha256 === sha256(readFileSync(pathFile)) &&
      row.pathContentHash === pathDoc.hash &&
      pathDoc.hash === bodyHash(pathDoc),
      JSON.stringify({ file: row.pathFileSha256, content: row.pathContentHash }));
    check(tag + 'path document is e1-drive.sprint v1 with the committed courseId',
      pathDoc.kind === 'e1-drive.sprint' && pathDoc.version === 1 &&
      pathDoc.courseId === spec.mapId,
      `${pathDoc.kind} v${pathDoc.version} ${pathDoc.courseId}`);

    const samples = pathDoc.course.samples;
    let measured = 0;
    for (let i = 1; i < samples.length; i++) {
      measured += Math.hypot(samples[i].x - samples[i - 1].x,
        samples[i].z - samples[i - 1].z);
    }
    check(tag + 'summary length and sample count are the re-derived path values',
      near(row.lengthMetres, measured, 1e-6) &&
      near(row.lengthMetres, pathDoc.course.lengthMetres, 1e-9) &&
      row.samples === samples.length &&
      row.samples === pathDoc.course.sampleCount,
      `${measured.toFixed(6)} / ${row.lengthMetres} / ${samples.length}`);
    check(tag + 'summary gate arcs are the committed gate arcs',
      Array.isArray(row.gateArcs) &&
      row.gateArcs.length === pathDoc.gates.length &&
      row.gateArcs.every((arc, i) => near(arc, pathDoc.gates[i].arc, 1e-9)),
      JSON.stringify(row.gateArcs));
    check(tag + 'summary clearance and corridor cells match the path document',
      row.clearanceCells === pathDoc.source.clearance.cells &&
      row.clearanceCells >= MIN_CLEARANCE_CELLS &&
      row.corridorCells === pathDoc.source.corridor.cells,
      `${row.clearanceCells}/${row.corridorCells}`);
    check(tag + 'path document keeps the collision-only scope labels',
      pathDoc.scope?.collisionOnly === true &&
      pathDoc.scope?.rendererClaim === false &&
      pathDoc.scope?.vehiclePhysics === false &&
      pathDoc.scope?.gameRun === false &&
      pathDoc.scope?.pathDriven === false,
      JSON.stringify(pathDoc.scope));
  } else if (spec.verdict === 'blocked') {
    check(tag + 'no path document is committed', !existsSync(pathFile),
      path.relative(ROOT, pathFile));
    const blockedFile = path.join(ROOT, '_work/map-laps', spec.mapId, 'blocked.json');
    if (!existsSync(blockedFile)) {
      check(tag + 'typed blocker exists', false, path.relative(ROOT, blockedFile));
      continue;
    }
    const blocked = readJson(blockedFile);
    check(tag + 'typed blocker exists and names the level', true,
      path.relative(ROOT, blockedFile));
    check(tag + 'blocker stage, reason and sample count match the summary',
      blocked.schema === 'blur.map-laps.batch-blocked/1' &&
      blocked.level === spec.level && blocked.map === spec.mapId &&
      blocked.stage === row.blockerStage &&
      blocked.reason === row.reason &&
      (blocked.blockedSamples ?? []).length === row.blockedSampleCount,
      `${blocked.stage} / ${row.blockerStage} / ${(blocked.blockedSamples ?? []).length} vs ${row.blockedSampleCount}`);
    check(tag + 'blocker clearance and corridor cells match the summary',
      blocked.clearanceCells === row.clearanceCells &&
      blocked.corridorCells === row.corridorCells,
      `${blocked.clearanceCells}/${blocked.corridorCells} vs ${row.clearanceCells}/${row.corridorCells}`);
    check(tag + 'summary length and samples are empty for a blocked level',
      row.lengthMetres === null && row.samples === 0 &&
      Array.isArray(row.gateArcs) && row.gateArcs.length === 0,
      JSON.stringify({ length: row.lengthMetres, samples: row.samples }));
  } else {
    check(tag + 'no path document is committed', !existsSync(pathFile),
      path.relative(ROOT, pathFile));
    const decision = decisionsByLevel.get(spec.level);
    check(tag + 'map-decisions records the committed showroom-mode blocker',
      decision?.blocker?.code === 'showroom-mode' &&
      /showroom is not a race\/sprint map/.test(decision?.blocker?.reason ?? ''),
      decision?.blocker?.code);
    check(tag + 'summary reason names the showroom blocker and keeps the source',
      /showroom is not a race\/sprint map/.test(row.reason ?? '') &&
      /map-decisions\.json/.test(row.unsupportedSource ?? ''),
      row.reason);
    check(tag + 'summary length and samples are empty for an unsupported level',
      row.lengthMetres === null && row.samples === 0 &&
      Array.isArray(row.gateArcs) && row.gateArcs.length === 0,
      JSON.stringify({ length: row.lengthMetres, samples: row.samples }));
  }
}

// ---------------------------------------------------------------- determinism
const python = resolvePython();
const scratch = mkdtempSync(path.join(tmpdir(), 'remaining-paths-'));
const outputs = [];
let generatorError = null;
for (const name of ['a.json', 'b.json']) {
  const out = path.join(scratch, name);
  const result = spawnSync(python, [GENERATOR, '--out', out], {
    cwd: ROOT, encoding: 'utf8', timeout: 600000
  });
  if (result.status !== 0) {
    generatorError = (result.stderr || result.stdout || 'generator failed').trim().slice(0, 600);
    break;
  }
  outputs.push(readFileSync(out));
}
if (outputs.length === 2) {
  const committed = readFileSync(summaryPath);
  check('generator output is byte-identical on repeat',
    outputs[0].equals(outputs[1]), `${outputs[0].length} vs ${outputs[1].length} bytes`);
  check('committed summary equals the generator output',
    outputs[0].equals(committed), `${outputs[0].length} vs ${committed.length} bytes`);
} else {
  check('generator output is byte-identical on repeat', false, generatorError);
  check('committed summary equals the generator output', false, generatorError);
}
const checkRun = spawnSync(python, [GENERATOR, '--check'], {
  cwd: ROOT, encoding: 'utf8', timeout: 600000
});
check('generator --check accepts the committed summary',
  checkRun.status === 0, (checkRun.stdout || checkRun.stderr || '').trim().slice(0, 300));
rmSync(scratch, { recursive: true, force: true });

const passed = checks.filter((entry) => entry.ok).length;
for (const entry of checks) {
  if (!entry.ok) console.log('FAIL ' + entry.label + (entry.detail ? ': ' + entry.detail : ''));
}
console.log(`${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
