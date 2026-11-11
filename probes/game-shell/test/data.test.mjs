import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCarClasses } from '../tools/build-car-classes.mjs';
import { MAPS, MAP_IDS, MP_MAP_IDS } from '../../e1-drive/web/map-registry.js';
import { dataset, readJson } from './fixtures.mjs';

test('generated car classes match the committed roster, spec and pipeline rule', () => {
  const data = dataset();
  const rebuilt = buildCarClasses(data.roster, data.spec);
  assert.deepEqual(rebuilt, data.classes);
  assert.equal(Object.keys(rebuilt.classes).length, 61);
  assert.deepEqual(rebuilt.counts, { A: 5, B: 42, C: 14, unclassified: 0 });
  assert.deepEqual(rebuilt.unclassified, {});
});

test('car classes cover exactly the roster slugs and never invent a class', () => {
  const data = dataset();
  assert.deepEqual(Object.keys(data.classes.classes).sort(), data.roster.cars.map((car) => car.slug).sort());
  for (const [slug, klass] of Object.entries(data.classes.classes)) {
    assert.ok(['A', 'B', 'C', 'unclassified'].includes(klass), slug);
  }
  // Every class is traceable to the roster rationale or the committed spec.
  assert.equal(Object.keys(data.classes.provenance).length, 61);
  for (const slug of Object.keys(data.classes.classes)) {
    assert.ok(data.classes.provenance[slug], slug + ' provenance');
  }
});

test('a roster car with no class source is recorded as unclassified with the reason', () => {
  const cars = [];
  for (let index = 0; index < 15; index++) {
    cars.push({ slug: 'anchor-' + index, recordIndex: index + 1, why: 'positional anchor' });
  }
  cars.push({ slug: 'no-source', recordIndex: 999, why: 'staged without a class' });
  const document = buildCarClasses({ cars }, { cars: [] });
  assert.equal(document.classes['anchor-0'], 'A');
  assert.equal(document.classes['anchor-5'], 'B');
  assert.equal(document.classes['no-source'], 'unclassified');
  assert.match(document.provenance['no-source'], /no vehicle-batch spec entry for recordIndex 999/);
  assert.deepEqual(document.unclassified, {
    'no-source': 'no high-confidence class in the roster rationale and no vehicle-batch spec entry for recordIndex 999'
  });
  assert.equal(document.counts.unclassified, 1);
});

test('map measurements agree with the registry pins for every package map', () => {
  const data = dataset();
  for (const id of MAP_IDS) {
    if (id === 'river') continue;
    assert.equal(MAPS[id].kind, 'map-package', id + ' kind');
    assert.equal(data.measurements.maps[id]['310'], MAPS[id].pins.pathLengthMetres, id + ' 310 length');
  }
  assert.equal(data.measurements.maps.river['310'], 310.395196);
  assert.equal(data.measurements.maps.river.lap, 222.040211);
  assert.equal(data.measurements.maps.river.freeAreaM2, 7702.25);
});

test('the Amboy lap length is the committed loop-01 measurement', () => {
  const data = dataset();
  const lap = readJson('probes/map-laps/data/amboy-loop01-lap.json');
  assert.equal(lap.kind, 'e1-drive.sprint');
  assert.equal(lap.courseId, 'lap');
  assert.equal(data.measurements.maps.amboy.lap, lap.course.span.lengthMetres);
  assert.equal(data.measurements.maps.amboy.lap, 284.452387);
  assert.equal(MAPS.amboy.lapLayoutUrl, '/map-laps/data/amboy-loop01-lap.json');
});

test('every registered course has a measured value and every map is measured', () => {
  const data = dataset();
  assert.deepEqual(Object.keys(data.measurements.maps).sort(), [...MAP_IDS].sort());
  for (const id of MAP_IDS) {
    const map = MAPS[id];
    for (const course of map.courses) {
      const value = course === 'free'
        ? data.measurements.maps[id].freeAreaM2
        : data.measurements.maps[id][course];
      assert.ok(Number.isFinite(value) && value > 0, id + ' ' + course + ' measurement');
    }
  }
  // River is the only map with the short regression and the free-roam basin.
  assert.equal(data.measurements.maps.river.short, 29);
  for (const id of MAP_IDS) {
    if (id === 'river') continue;
    assert.equal(data.measurements.maps[id].short, undefined, id + ' short');
    assert.equal(data.measurements.maps[id].freeAreaM2, undefined, id + ' freeAreaM2');
  }
});

test('the registry exposes exactly the fifteen MP-capable maps', () => {
  const data = dataset();
  assert.deepEqual([...MAP_IDS], ['river', 'amboy', 'gracia', 'longbeach', 'observatory', 'downtown', 'mharuna',
    'highrise', 'shutoko', 'oval', 'amboy-mp', 'dumbo', 'downtown-mp', 'sausalito', 'hackney']);
  assert.deepEqual([...MP_MAP_IDS], [...MAP_IDS]);
  for (const id of MAP_IDS) {
    const map = data.maps[id];
    assert.equal(map.multiplayer, true, id);
    assert.ok(map.mpPins, id + ' mpPins');
    assert.match(map.mpPins.packageHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(map.mpPins.layoutHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(map.mpPins.physicsHash, /^sha256:[0-9a-f]{64}$/);
  }
});

test('measurement and class documents carry source provenance', () => {
  const measurements = readJson('probes/game-shell/data/course-measurements.json');
  const classes = readJson('probes/game-shell/data/car-classes.json');
  assert.match(measurements.source.river['310'], /T-007-310m-course/);
  assert.match(measurements.source.river.lap, /T-007-lap-mode/);
  assert.match(measurements.source.river.freeAreaM2, /T-007-free-roam/);
  assert.match(measurements.source.amboy.lap, /amboy-loop01-lap/);
  for (const id of ['longbeach', 'observatory', 'downtown', 'mharuna', 'highrise', 'shutoko', 'oval', 'amboy-mp',
    'dumbo', 'downtown-mp', 'sausalito']) {
    assert.match(measurements.source[id]['310'], new RegExp(id + '/layout\\.json'), id + ' source');
  }
  assert.equal(classes.source.roster, 'probes/e1-drive/cars/roster.json');
  assert.equal(classes.source.spec, 'probes/vehicle-batch/spec/cars.json');
  assert.match(classes.source.rule, /not a retail race class/);
  assert.match(classes.source.rule, /unclassified/);
  assert.equal(Object.keys(classes.provenance).length, 61);
});

test('the six newest maps copy their committed path length and gate arcs', () => {
  const data = dataset();
  const sources = {
    highrise: 'probes/map-laps/data/highrise-path.json',
    shutoko: 'probes/map-laps/data/shutoko-path.json',
    oval: 'probes/map-laps/data/oval-path.json',
    'amboy-mp': 'probes/map-laps/data/amboy-mp-path.json',
    dumbo: 'probes/map-laps-aid/data/dumbo-aid-path.json',
    'downtown-mp': 'probes/map-laps-aid/data/downtown-mp-aid-path.json'
  };
  for (const [id, file] of Object.entries(sources)) {
    const path = readJson(file);
    assert.equal(path.kind, 'e1-drive.sprint', id + ' kind');
    assert.equal(path.courseId, id, id + ' courseId');
    assert.equal(data.measurements.maps[id]['310'], path.course.span.lengthMetres, id + ' length');
    assert.equal(data.measurements.maps[id]['310'], MAPS[id].pins.pathLengthMetres, id + ' pin');
    const checkpoints = path.gates.filter((gate) => gate.kind === 'checkpoint').map((gate) => gate.arc);
    const finish = path.gates.find((gate) => gate.kind === 'finish');
    assert.deepEqual(data.measurements.gates[id].checkpointArcs, checkpoints, id + ' checkpoint arcs');
    assert.equal(data.measurements.gates[id].finishArc, finish.arc, id + ' finish arc');
    assert.deepEqual(MAPS[id].pins.checkpointArcs, checkpoints, id + ' pin arcs');
  }
});
