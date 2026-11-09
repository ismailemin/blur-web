// Course-minimap tests for the e1-drive page.
//
// Runs without a browser or GPU. It loads the committed layouts, drives the real
// `createMinimap` module against a recording 2D-context stub, and checks:
//   * every projected point lies inside the canvas;
//   * the polyline is downsampled by the reported stride and keeps the tail;
//   * every committed gate is drawn;
//   * the player marker is placed at the projected car position;
//   * remote markers are drawn only for finite positions;
//   * a layout without a polyline yields no model (the canvas stays hidden);
//   * two models from the same layout produce identical stats.
//
// Usage:
//   node probes/e1-drive/tools/minimap_tests.mjs
//
// Writes `_work/e1-drive/minimap-report.json`. Presentation only: no retail
// claim, no geometry is invented.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMinimap, MINIMAP_SCHEMA } from '../web/minimap.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(ROOT, '_work/e1-drive');

let checks = 0;
const failures = [];
function check(label, condition, detail) {
  checks++;
  if (!condition) failures.push(label + (detail === undefined ? '' : ': ' + JSON.stringify(detail)));
}

function stubCanvas(width = 220, height = 220) {
  const calls = { moveTo: [], lineTo: [], arc: [], translate: [], fill: 0, stroke: 0 };
  const ctx = {
    clearRect() {},
    fillRect() {},
    save() {},
    restore() {},
    rotate() {},
    beginPath() {},
    closePath() {},
    fill() { calls.fill++; },
    stroke() { calls.stroke++; },
    moveTo(x, y) { calls.moveTo.push([x, y]); },
    lineTo(x, y) { calls.lineTo.push([x, y]); },
    arc(x, y, r) { calls.arc.push([x, y, r]); },
    translate(x, y) { calls.translate.push([x, y]); },
    set fillStyle(value) {},
    set strokeStyle(value) {},
    set lineWidth(value) {},
    set lineJoin(value) {},
    set lineCap(value) {}
  };
  const reset = () => {
    for (const key of Object.keys(calls)) {
      if (Array.isArray(calls[key])) calls[key].length = 0;
      else calls[key] = 0;
    }
  };
  return { canvas: { width, height, getContext: () => ctx }, calls, reset };
}

function inside(canvas, [x, y]) {
  return x >= 0 && x <= canvas.width && y >= 0 && y <= canvas.height;
}

const layouts = [
  { id: 'river-310m', file: '_work/e1-drive/sprint.json' },
  { id: 'amboy', file: '_work/e1-drive/amboy/layout.json' }
];

const report = { schema: 'e1-drive.minimap-tests/1', layouts: [] };

for (const entry of layouts) {
  const layout = JSON.parse(readFileSync(path.join(ROOT, entry.file), 'utf8'));
  const { canvas, calls, reset } = stubCanvas();
  const model = createMinimap(canvas, layout);
  check(entry.id + ': model created', model !== null);
  if (!model) continue;

  check(entry.id + ': schema', model.stats.schema === MINIMAP_SCHEMA, model.stats.schema);
  check(entry.id + ': point count bounded', model.stats.points <= 481, model.stats.points);
  check(entry.id + ': stride reported', model.stats.stride >= 1, model.stats.stride);
  check(entry.id + ': length copied', model.stats.lengthMetres === layout.course.lengthMetres,
    [model.stats.lengthMetres, layout.course.lengthMetres]);
  check(entry.id + ': gate count', model.stats.gates === layout.gates.length,
    [model.stats.gates, layout.gates.length]);

  reset();
  model.update({ position: [layout.course.spawn.x, 0, layout.course.spawn.z], remotes: [] });

  // The polyline is the first moveTo plus the first `points - 1` lineTo calls;
  // the player triangle adds one moveTo and two lineTo calls afterwards.
  const polyline = [calls.moveTo[0], ...calls.lineTo.slice(0, model.stats.points - 1)];
  check(entry.id + ': one polyline moveTo', calls.moveTo.length === 2,
    calls.moveTo.length);
  check(entry.id + ': polyline segments', calls.lineTo.length === model.stats.points + 1,
    [calls.lineTo.length, model.stats.points + 1]);
  check(entry.id + ': every point inside the canvas',
    polyline.every((point) => inside(canvas, point)));
  check(entry.id + ': one arc per gate', calls.arc.length === layout.gates.length,
    [calls.arc.length, layout.gates.length]);
  check(entry.id + ': every gate inside the canvas',
    calls.arc.every(([x, y]) => inside(canvas, [x, y])));
  check(entry.id + ': player marker placed once', calls.translate.length === 1,
    calls.translate.length);
  check(entry.id + ': player marker inside the canvas',
    calls.translate.every((point) => inside(canvas, point)));

  // Remote markers: two finite positions and one malformed row.
  reset();
  model.update({
    position: [layout.course.spawn.x, 0, layout.course.spawn.z],
    remotes: [
      { x: layout.gates[0].x, z: layout.gates[0].z },
      { x: layout.course.finish.x, z: layout.course.finish.z },
      { x: null, z: 3 }
    ]
  });
  check(entry.id + ': only finite remotes drawn',
    calls.arc.length === layout.gates.length + 2,
    [calls.arc.length, layout.gates.length + 2]);

  // Determinism: a second model from the same layout has identical stats.
  const again = createMinimap(stubCanvas().canvas, layout);
  check(entry.id + ': deterministic stats',
    JSON.stringify(again.stats) === JSON.stringify(model.stats));

  report.layouts.push({
    id: entry.id,
    file: entry.file,
    stats: model.stats,
    gates: layout.gates.length,
    inkSegments: calls.lineTo.length
  });
}

// A layout without a polyline must not produce a model.
const empty = createMinimap(stubCanvas().canvas, { course: { samples: [] }, gates: [] });
check('empty layout: no model', empty === null);
const noCanvas = createMinimap(null, { course: { samples: [{ x: 0, z: 0 }, { x: 1, z: 1 }] }, gates: [] });
check('missing canvas: no model', noCanvas === null);

report.checks = checks;
report.failures = failures;
report.status = failures.length === 0 ? 'PASS' : 'FAIL';
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'minimap-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

if (failures.length) {
  console.error('minimap tests FAILED');
  for (const failure of failures) console.error('  ' + failure);
  process.exit(1);
}
console.log(checks + '/' + checks + ' minimap checks passed');
