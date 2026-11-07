// Control: the shipped e1 module must produce the same 318-tick state sequence
// as the probe's mode-0 baseline. If it does not, the probe changed physics.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SHIPPED = path.join(ROOT, '_work/e1-drive/module/e1_drive.mjs');
const LEVEL = path.join(ROOT, 'game-data/Blur/levels/usa_la_river/Level.levelphysics');
const FIELDS = path.join(ROOT, '_work/e1-drive/cars/corvette-zr1-stock.fields');
const REPORT = path.join(ROOT, '_work/boost-feasibility/report.json');
const OUT = path.join(ROOT, '_work/boost-feasibility/control.json');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const factory = (await import(pathToFileURL(SHIPPED).href)).default;
const m = await factory();
const levelBytes = readFileSync(LEVEL);
const fieldBytes = readFileSync(FIELDS);
const levelPtr = m._malloc(levelBytes.length);
const fieldsPtr = m._malloc(fieldBytes.length + 1);
m.HEAPU8.set(levelBytes, levelPtr);
m.HEAPU8.set(fieldBytes, fieldsPtr);
if (!m._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length, 281.2833, 1823.6890, 0)) {
  throw new Error(m.UTF8ToString(m._e1_last_error()));
}
const states = [];
states.push(JSON.parse(m.UTF8ToString(m._e1_get_state())));
for (let i = 0; i < 180 + 78 + 60; i++) {
  m._e1_set_input(1, 0, 0, 0);
  if (!m._e1_step()) throw new Error(m.UTF8ToString(m._e1_last_error()));
  states.push(JSON.parse(m.UTF8ToString(m._e1_get_state())));
}
const sequence = 'sha256:' + sha256(states.map((s) => JSON.stringify(s)).join('\n'));
const report = JSON.parse(readFileSync(REPORT, 'utf8'));
const baseline = report.candidateTable.find((c) => c.id === 'baseline');
const result = {
  shippedModule: '_work/e1-drive/module/e1_drive.mjs',
  probeModule: '_work/boost-feasibility/module/boost_probe.mjs',
  ticks: states.length,
  shippedSequence: sequence,
  probeBaselineSequence: baseline.stateSequence,
  match: sequence === baseline.stateSequence,
  final: { tick: states.at(-1).tick, speed: states.at(-1).speed, position: states.at(-1).position }
};
writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.match) process.exitCode = 1;
