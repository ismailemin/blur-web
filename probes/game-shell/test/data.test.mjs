import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCarClasses } from '../tools/build-car-classes.mjs';
import { MAPS, MAP_IDS, MP_MAP_IDS } from '../../e1-drive/web/map-registry.js';
import { dataset, readJson } from './fixtures.mjs';

test('generated car classes match the committed roster and pipeline rule', () => {
  const data = dataset();
  const rebuilt = buildCarClasses(data.roster);
  assert.deepEqual(rebuilt, data.classes);
  assert.equal(Object.keys(rebuilt.classes).length, 25);
  assert.deepEqual(rebuilt.counts, { A: 5, B: 13, C: 7 });
});

test('car classes cover exactly the roster slugs', () => {
  const data = dataset();
  assert.deepEqual(Object.keys(data.classes.classes).sort(), data.roster.cars.map((car) => car.slug).sort());
  for (const [slug, klass] of Object.entries(data.classes.classes)) {
    assert.ok(['A', 'B', 'C'].includes(klass), slug);
  }
});

test('map measurements agree with the registry pins for package maps', () => {
  const data = dataset();
  for (const id of ['amboy', 'gracia']) {
    assert.equal(data.measurements.maps[id]['310'], MAPS[id].pins.pathLengthMetres, id + ' length');
    assert.equal(MAPS[id].kind, 'map-package');
  }
  assert.equal(data.measurements.maps.river['310'], 310.395196);
  assert.equal(data.measurements.maps.river.lap, 222.040211);
  assert.equal(data.measurements.maps.river.freeAreaM2, 7702.25);
});

test('the registry exposes exactly the three MP-capable maps', () => {
  const data = dataset();
  assert.deepEqual([...MAP_IDS], ['river', 'amboy', 'gracia']);
  assert.deepEqual([...MP_MAP_IDS], ['river', 'amboy', 'gracia']);
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
  assert.equal(classes.source.roster, 'probes/e1-drive/cars/roster.json');
  assert.match(classes.source.rule, /not a retail race class/);
  assert.equal(Object.keys(classes.provenance).length, 25);
});
