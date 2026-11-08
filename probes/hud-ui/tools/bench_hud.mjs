/**
 * HUD UI update benchmark.
 *
 *   node --expose-gc probes/hud-ui/tools/bench_hud.mjs [iterations]
 *
 * Measures the per-update cost at 60 Hz with an eight-car grid (one local, one
 * remote human, six AI), in two scenarios:
 *
 *   steady  — the same state object, nothing changes
 *   racing  — speed, rpm, race clock and all eight car poses change every update
 *
 * Writes `_work/hud-ui/hud-bench.json` and prints a short table. Heap numbers
 * need `--expose-gc`; without it they are reported as null.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDocument } from '../tests/dom-shim.mjs';
import { createHud } from '../hud.mjs';
import { stateMp, syntheticMinimap } from '../fixtures.mjs';

const iterations = Math.max(1000, Number(process.argv[2]) || 20000);
const warmup = Math.min(5000, Math.floor(iterations / 4));

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index];
}

function makeHud() {
  const doc = createDocument();
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const hud = createHud(host, {
    viewport: { width: 1920, height: 1080 },
    dpr: 1,
    now: () => 0,
    minimap: syntheticMinimap()
  });
  const state = stateMp();
  hud.update(state);
  return { hud, state };
}

function snapshot(hud) {
  return {
    textWrites: hud.metrics().textWrites,
    attrWrites: hud.metrics().attrWrites,
    canvasDraws: hud.metrics().canvasDraws
  };
}

function benchSteady() {
  const { hud, state } = makeHud();
  for (let i = 0; i < warmup; i += 1) hud.update(state);
  const before = snapshot(hud);
  const samples = new Float64Array(iterations);
  let total = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    hud.update(state);
    const elapsed = Number(process.hrtime.bigint() - start) / 1000;
    samples[i] = elapsed;
    total += elapsed;
  }
  const wall = Number(process.hrtime.bigint() - t0) / 1e6;
  const after = snapshot(hud);
  const sorted = Array.from(samples).sort((a, b) => a - b);
  const result = {
    scenario: 'steady',
    iterations,
    avgUs: total / iterations,
    p50Us: percentile(sorted, 50),
    p95Us: percentile(sorted, 95),
    maxUs: sorted[sorted.length - 1],
    wallMs: wall,
    textWritesPerUpdate: (after.textWrites - before.textWrites) / iterations,
    attrWritesPerUpdate: (after.attrWrites - before.attrWrites) / iterations,
    canvasDrawsPerUpdate: (after.canvasDraws - before.canvasDraws) / iterations
  };
  hud.destroy();
  return result;
}

function benchRacing() {
  const { hud, state } = makeHud();
  const cars = state.cars;
  for (let i = 0; i < warmup; i += 1) {
    state.local.speedMps = 20 + (i % 300) * 0.1;
    state.local.rpm = 3000 + (i % 4000);
    state.timing.raceSeconds += 1 / 60;
    for (let j = 0; j < cars.length; j += 1) cars[j].x += 0.05;
    hud.update(state);
  }
  const before = snapshot(hud);
  const samples = new Float64Array(iterations);
  let total = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    state.local.speedMps = 20 + (i % 300) * 0.1;
    state.local.rpm = 3000 + (i % 4000);
    state.timing.raceSeconds += 1 / 60;
    for (let j = 0; j < cars.length; j += 1) cars[j].x += 0.05;
    const start = process.hrtime.bigint();
    hud.update(state);
    const elapsed = Number(process.hrtime.bigint() - start) / 1000;
    samples[i] = elapsed;
    total += elapsed;
  }
  const wall = Number(process.hrtime.bigint() - t0) / 1e6;
  const after = snapshot(hud);
  const sorted = Array.from(samples).sort((a, b) => a - b);
  const result = {
    scenario: 'racing',
    iterations,
    avgUs: total / iterations,
    p50Us: percentile(sorted, 50),
    p95Us: percentile(sorted, 95),
    maxUs: sorted[sorted.length - 1],
    wallMs: wall,
    textWritesPerUpdate: (after.textWrites - before.textWrites) / iterations,
    attrWritesPerUpdate: (after.attrWrites - before.attrWrites) / iterations,
    canvasDrawsPerUpdate: (after.canvasDraws - before.canvasDraws) / iterations
  };
  hud.destroy();
  return result;
}

function heapPerUpdate(scenario) {
  if (typeof global.gc !== 'function') return null;
  const { hud, state } = makeHud();
  const cars = state.cars;
  const runs = 3;
  let best = Infinity;
  for (let run = 0; run < runs; run += 1) {
    for (let i = 0; i < 2000; i += 1) {
      if (scenario === 'racing') {
        state.local.speedMps = 20 + (i % 300) * 0.1;
        state.local.rpm = 3000 + (i % 4000);
        state.timing.raceSeconds += 1 / 60;
        for (let j = 0; j < cars.length; j += 1) cars[j].x += 0.05;
      }
      hud.update(state);
    }
    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 5000; i += 1) {
      if (scenario === 'racing') {
        state.local.speedMps = 20 + (i % 300) * 0.1;
        state.local.rpm = 3000 + (i % 4000);
        state.timing.raceSeconds += 1 / 60;
        for (let j = 0; j < cars.length; j += 1) cars[j].x += 0.05;
      }
      hud.update(state);
    }
    const after = process.memoryUsage().heapUsed;
    const perUpdate = (after - before) / 5000;
    if (perUpdate < best) best = perUpdate;
  }
  hud.destroy();
  return best;
}

const steady = benchSteady();
const racing = benchRacing();
const steadyHeap = heapPerUpdate('steady');
const racingHeap = heapPerUpdate('racing');

const budgetMs = 1000 / 60;
const report = {
  suite: 'hud-ui-bench',
  node: process.version,
  viewport: '1920x1080',
  scale: 1,
  dpr: 1,
  cars: 8,
  budgetMs,
  steady,
  racing,
  heapBytesPerUpdate: {
    steady: steadyHeap,
    racing: racingHeap,
    note: 'heap growth observed before a forced GC; transient strings are collectable'
  },
  headroom: {
    steady: budgetMs / (steady.avgUs / 1000),
    racing: budgetMs / (racing.avgUs / 1000)
  }
};

try {
  mkdirSync(fileURLToPath(new URL('../../../_work/hud-ui/', import.meta.url)), { recursive: true });
  writeFileSync(new URL('../../../_work/hud-ui/hud-bench.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
} catch (error) {
  /* report only */
}

const fmt = (value) => (Number.isFinite(value) ? value.toFixed(2) : '—');
console.log('HUD-UI bench · ' + iterations + ' updates · 8 cars · 1920x1080');
console.log('scenario  avg µs   p50 µs   p95 µs   max µs   text/update  canvas/update  heap B/update');
for (const row of [steady, racing]) {
  const heap = row.scenario === 'steady' ? steadyHeap : racingHeap;
  console.log(
    row.scenario.padEnd(9) +
    fmt(row.avgUs).padStart(8) +
    fmt(row.p50Us).padStart(9) +
    fmt(row.p95Us).padStart(9) +
    fmt(row.maxUs).padStart(9) +
    fmt(row.textWritesPerUpdate).padStart(13) +
    fmt(row.canvasDrawsPerUpdate).padStart(15) +
    (heap === null ? '   n/a' : fmt(heap).padStart(15))
  );
}
console.log('60 Hz budget 16666.7 µs · steady headroom ×' + fmt(report.headroom.steady) + ' · racing headroom ×' + fmt(report.headroom.racing));
