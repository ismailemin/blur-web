// Generate the shell's A/B/C content-class map from the committed roster.
//
// The class is the vehicle-pipeline content-completeness class, not a retail
// Blur race class. The rule, in order, is:
//
//   1. roster positions 0-4  -> A (the T-007 reference anchors);
//   2. roster positions 5-14 -> B (the V1 class-B batch 1);
//   3. a `high-confidence A|B|C` phrase in the roster rationale -> that class
//      (the batch-2 rule);
//   4. otherwise the committed vehicle-batch spec entry with the same
//      recordIndex supplies `class` and `classReason`;
//   5. a car with none of the above is `unclassified` and its provenance names
//      the missing source. No class is inferred from mass, drivetrain or name.
//
// Run with `--check` to fail when the output is stale.
//
//   node probes/game-shell/tools/build-car-classes.mjs
//   node probes/game-shell/tools/build-car-classes.mjs --check

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const ROSTER_PATH = path.join(ROOT, 'probes/e1-drive/cars/roster.json');
const SPEC_PATH = path.join(ROOT, 'probes/vehicle-batch/spec/cars.json');
const OUT_PATH = path.join(ROOT, 'probes/game-shell/data/car-classes.json');

const CLASSES = ['A', 'B', 'C'];
const UNCLASSIFIED = 'unclassified';

function specIndex(spec) {
  const cars = spec?.cars;
  if (!Array.isArray(cars)) throw new Error('vehicle-batch spec has no cars array');
  const byRecordIndex = new Map();
  for (const entry of cars) {
    if (!Number.isInteger(entry?.recordIndex)) continue;
    byRecordIndex.set(entry.recordIndex, entry);
  }
  return byRecordIndex;
}

export function buildCarClasses(roster, spec = null) {
  const cars = roster?.cars;
  if (!Array.isArray(cars)) throw new Error('roster document has no cars array');
  const specByIndex = spec ? specIndex(spec) : new Map();
  const classes = {};
  const sources = {};
  const unclassified = {};
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
      if (match) {
        klass = match[1].toUpperCase();
        sources[car.slug] = 'roster.cars[' + index + '].why: high-confidence ' + klass + ' record';
      }
    }
    if (klass === null) {
      const entry = specByIndex.get(car.recordIndex);
      if (entry && CLASSES.includes(entry.class)) {
        klass = entry.class;
        sources[car.slug] = 'vehicle-batch/spec/cars.json: record ' + entry.recordIndex +
          ' class ' + klass + ' - ' + String(entry.classReason ?? 'no classReason recorded');
      }
    }
    if (klass === null) {
      klass = UNCLASSIFIED;
      const reason = spec
        ? 'no high-confidence class in the roster rationale and no vehicle-batch spec entry for recordIndex ' +
          JSON.stringify(car.recordIndex)
        : 'no high-confidence class in the roster rationale and no vehicle-batch spec was supplied';
      sources[car.slug] = reason;
      unclassified[car.slug] = reason;
    }
    if (![...CLASSES, UNCLASSIFIED].includes(klass)) {
      throw new Error('roster car ' + car.slug + ' has an invalid class ' + JSON.stringify(klass));
    }
    classes[car.slug] = klass;
  }
  const counts = { A: 0, B: 0, C: 0, [UNCLASSIFIED]: 0 };
  for (const value of Object.values(classes)) counts[value] += 1;
  if (Object.keys(classes).length !== cars.length) {
    throw new Error('class map does not cover every roster car');
  }
  return {
    kind: 'game-shell.car-classes',
    version: 2,
    source: {
      roster: 'probes/e1-drive/cars/roster.json',
      spec: 'probes/vehicle-batch/spec/cars.json',
      pipelineDoc: 'docs/work/analysis/vehicle-pipeline.md',
      rule: 'content-completeness class A/B/C from the vehicle pipeline; not a retail race class. ' +
        'Order: roster positions 0-4 = A (T-007 anchors), 5-14 = B (V1 batch 1), then a ' +
        '"high-confidence A|B|C" roster rationale, then the committed vehicle-batch spec entry for the ' +
        'same recordIndex; a car with none of these is "unclassified" with the reason in provenance. ' +
        'Mass, drivetrain and name never select a class.'
    },
    counts,
    classes,
    provenance: sources,
    unclassified
  };
}

function main() {
  const roster = JSON.parse(readFileSync(ROSTER_PATH, 'utf8'));
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
  const document = buildCarClasses(roster, spec);
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
      document.counts.A + 'A/' + document.counts.B + 'B/' + document.counts.C + 'C/' +
      document.counts.unclassified + ' unclassified)\n');
    return;
  }
  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, text);
  process.stdout.write('wrote ' + path.relative(ROOT, OUT_PATH) + ': ' +
    Object.keys(document.classes).length + ' classes (' +
    document.counts.A + 'A/' + document.counts.B + 'B/' + document.counts.C + 'C/' +
    document.counts.unclassified + ' unclassified)\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
