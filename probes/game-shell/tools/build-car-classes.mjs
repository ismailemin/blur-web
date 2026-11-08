// Generate the shell's A/B/C content-class map from the committed roster.
//
// The roster itself records the class in prose for batch 2 and by position for
// batches 1-2. This script makes that rule machine-checkable instead of
// hand-copying 25 values. Run with `--check` to fail when the output is stale.
//
//   node probes/game-shell/tools/build-car-classes.mjs
//   node probes/game-shell/tools/build-car-classes.mjs --check

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const ROSTER_PATH = path.join(ROOT, 'probes/e1-drive/cars/roster.json');
const OUT_PATH = path.join(ROOT, 'probes/game-shell/data/car-classes.json');

export function buildCarClasses(roster) {
  const cars = roster?.cars;
  if (!Array.isArray(cars)) throw new Error('roster document has no cars array');
  const classes = {};
  const sources = {};
  for (let index = 0; index < cars.length; index++) {
    const car = cars[index];
    if (!car?.slug) throw new Error('roster car ' + index + ' has no slug');
    let klass = null;
    if (index < 5) {
      klass = 'A';
      sources[car.slug] = 'roster.selection: the first five are the T-007 reference anchors';
    } else if (index < 15) {
      klass = 'B';
      sources[car.slug] = 'roster.selection: cars 6-15 are the V1 class-B batch 1';
    } else {
      const match = /\bhigh-confidence ([ABC])\b/i.exec(String(car.why ?? ''));
      if (!match) throw new Error('roster car ' + car.slug + ' has no class in its rationale');
      klass = match[1].toUpperCase();
      sources[car.slug] = 'roster.cars[' + index + '].why: high-confidence ' + klass + ' record';
    }
    if (!['A', 'B', 'C'].includes(klass)) {
      throw new Error('roster car ' + car.slug + ' has an invalid class ' + JSON.stringify(klass));
    }
    classes[car.slug] = klass;
  }
  const counts = { A: 0, B: 0, C: 0 };
  for (const value of Object.values(classes)) counts[value] += 1;
  if (Object.keys(classes).length !== cars.length) {
    throw new Error('class map does not cover every roster car');
  }
  return {
    kind: 'game-shell.car-classes',
    version: 1,
    source: {
      roster: 'probes/e1-drive/cars/roster.json',
      pipelineDoc: 'docs/work/analysis/vehicle-pipeline.md',
      rule: 'content-completeness class A/B/C from the vehicle pipeline; not a retail race class'
    },
    counts,
    classes,
    provenance: sources
  };
}

function main() {
  const roster = JSON.parse(readFileSync(ROSTER_PATH, 'utf8'));
  const document = buildCarClasses(roster);
  const text = JSON.stringify(document, null, 2) + '\n';
  const check = process.argv.includes('--check');
  if (check) {
    let existing = '';
    try { existing = readFileSync(OUT_PATH, 'utf8'); } catch { /* missing is stale */ }
    if (existing !== text) {
      process.stderr.write('stale: ' + path.relative(ROOT, OUT_PATH) + '\n');
      process.exit(1);
    }
    process.stdout.write('ok: ' + Object.keys(document.classes).length + ' classes (' +
      document.counts.A + 'A/' + document.counts.B + 'B/' + document.counts.C + 'C)\n');
    return;
  }
  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, text);
  process.stdout.write('wrote ' + path.relative(ROOT, OUT_PATH) + ': ' +
    Object.keys(document.classes).length + ' classes (' +
    document.counts.A + 'A/' + document.counts.B + 'B/' + document.counts.C + 'C)\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
