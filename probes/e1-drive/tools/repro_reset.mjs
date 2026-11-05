// Reproduce the e1-drive library rebuild limit.
//
// The recorded limitation (docs/work/verification/T-007-telemetry.md, Limits)
// says this wasm build cannot rebuild the same module instance more than about
// three times: the third `e1_reset()` after `e1_create` aborts and the fourth
// `e1_create()` in one instance aborts.
//
// This tool drives exactly that sequence in one wasm instance and records, for
// every call, the return value, the tick, the reset counter, the module memory
// size and (on failure) `e1_last_error()` plus the exception that ended the run.
// It never reloads the page and never creates a second instance before the
// abort, so whatever happens is the library's own state.
//
// Usage:
//   node probes/e1-drive/tools/repro_reset.mjs            # 10 create/reset cycles
//   node probes/e1-drive/tools/repro_reset.mjs --cycles 20
//   node probes/e1-drive/tools/repro_reset.mjs --mode reset   # (or --mode create)
//   node probes/e1-drive/tools/repro_reset.mjs --debug        # resolve the trap stack
//   node probes/e1-drive/tools/repro_reset.mjs --json out.json
//
// Exit code 0 when every requested cycle succeeded, 1 when one aborted.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TICK0_LIMITS } from './spawn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, '_work/e1-drive');
const LOGS = path.join(ROOT, '_work/logs/e1-drive');
const MODULE = path.join(OUT, 'module/e1_drive.mjs');
const DEBUG_MODULE = path.join(OUT, 'module/e1_drive_debug.mjs');
const LEVEL = path.join(ROOT, 'game-data/Blur/levels/usa_la_river/Level.levelphysics');
const ROSTER = path.join(OUT, 'cars.json');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf('--' + name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};

const CYCLES = Number(option('cycles', 10));
const MODE = option('mode', 'mixed'); // mixed | reset | create
const CAR = option('car', null);
const JSON_OUT = option('json', null);
const USE_DEBUG = option('debug', false) !== false;
const ACTIVE_MODULE = USE_DEBUG ? DEBUG_MODULE : MODULE;

// A cycle: create -> 12 scripted ticks -> build a fresh world again. `reset`
// goes through e1_reset(), `create` through a second e1_create(); `mixed`
// alternates so both entry points are exercised in the same instance.
const TICKS_PER_CYCLE = 12;

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const roster = JSON.parse(readFileSync(ROSTER, 'utf8'));
const cars = roster.roster.cars;
const car = CAR ? cars.find((entry) => entry.slug === CAR) : (cars.find((entry) => entry.default) ?? cars[0]);
if (!car) throw new Error('unknown car: ' + CAR);
const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));
const levelBytes = readFileSync(LEVEL);

mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const steps = [];
let failure = null;

function record(phase, cycle, detail) {
  steps.push({ phase, cycle, ...detail });
}

const factory = (await import(pathToFileURL(ACTIVE_MODULE).href)).default;
const module = await factory();
const levelPtr = module._malloc(levelBytes.length);
const fieldsPtr = module._malloc(fieldBytes.length + 1);
module.HEAPU8.set(levelBytes, levelPtr);
module.HEAPU8.set(fieldBytes, fieldsPtr);

const info = () => JSON.parse(module.UTF8ToString(module._e1_info()));
const state = () => JSON.parse(module.UTF8ToString(module._e1_get_state()));
const diag = () => JSON.parse(module.UTF8ToString(module._e1_diag()));
const utf8OrEmpty = (call) => { try { return module.UTF8ToString(call()); } catch { return null; } };

const snapshot = () => ({
  tick: info().tick,
  resets: info().resets,
  heapBytes: module.HEAPU8.length,
  wasmPages: module.HEAPU8.length / 65536,
  diag: diag()
});

const runCycle = (cycle, useReset) => {
  if (useReset) {
    const ok = module._e1_reset();
    if (!ok) throw new Error('e1_reset returned 0: ' + module.UTF8ToString(module._e1_last_error()));
  } else {
    const ok = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                                 TICK0_LIMITS.x, TICK0_LIMITS.z, TICK0_LIMITS.heading);
    if (!ok) throw new Error('e1_create returned 0: ' + module.UTF8ToString(module._e1_last_error()));
  }
  const built = state();
  record('build', cycle, {
    via: useReset ? 'e1_reset' : 'e1_create',
    ...snapshot(),
    position: built.position,
    stateHash: sha256(Buffer.from(JSON.stringify(built)))
  });

  module._e1_set_input(1, 0, 0, 0);
  for (let tick = 1; tick <= TICKS_PER_CYCLE; tick++) {
    const ok = module._e1_step();
    if (!ok) throw new Error(`e1_step returned 0 at cycle ${cycle} tick ${tick}: ` +
                             module.UTF8ToString(module._e1_last_error()));
  }
  const final = state();
  record('drive', cycle, { ...snapshot(), position: final.position, speed: final.speed, finite: final.finite });
  return { built, final };
};

try {
  const ok = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
                               TICK0_LIMITS.x, TICK0_LIMITS.z, TICK0_LIMITS.heading);
  if (!ok) throw new Error('initial e1_create returned 0: ' + module.UTF8ToString(module._e1_last_error()));
  record('build', 0, { via: 'e1_create', ...snapshot(), position: state().position });

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    const useReset = MODE === 'reset' ? true : MODE === 'create' ? false : cycle % 2 === 1;
    runCycle(cycle, useReset);
  }
} catch (error) {
  failure = {
    message: String(error && error.message ? error.message : error),
    name: error && error.name,
    stack: String(error && error.stack ? error.stack : '').split('\n').slice(0, 8),
    lastError: utf8OrEmpty(() => module._e1_last_error),
    stepsDone: steps.length,
    heapAfterFailure: module.HEAPU8.length
  };
}

const result = {
  tool: 'probes/e1-drive/tools/repro_reset.mjs',
  car: { slug: car.slug, name: car.name, fieldsSha256: car.fields.sha256 },
  module: {
    path: path.relative(ROOT, ACTIVE_MODULE).split(path.sep).join('/'),
    wasmSha256: sha256(readFileSync(ACTIVE_MODULE.replace(/\.mjs$/, '.wasm')))
  },
  config: { cycles: CYCLES, mode: MODE, ticksPerCycle: TICKS_PER_CYCLE },
  initialHeapBytes: steps[0]?.heapBytes ?? module.HEAPU8.length,
  steps,
  cyclesCompleted: steps.filter((step) => step.phase === 'drive').length,
  failure,
  status: failure ? 'ABORT' : 'PASS'
};

if (JSON_OUT && JSON_OUT !== true) {
  const target = path.resolve(String(JSON_OUT));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(result, null, 2) + '\n', 'utf8');
}
const logFile = path.join(LOGS, 'repro_reset.log');
writeFileSync(logFile, JSON.stringify(result, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({
  status: result.status,
  car: result.car.slug,
  cyclesCompleted: result.cyclesCompleted,
  requested: CYCLES,
  heap: { start: result.initialHeapBytes, end: result.failure?.heapAfterFailure ?? steps.at(-1)?.heapBytes },
  steps: steps.map((step) => `${step.cycle}:${step.phase}:${step.via ?? ''}${step.resets !== undefined ? ' resets=' + step.resets : ''}${step.heapBytes !== undefined ? ' heap=' + step.heapBytes : ''}`),
  failure: failure && { message: failure.message, lastError: failure.lastError, stepsDone: failure.stepsDone }
}, null, 2));
console.log('log: ' + path.relative(ROOT, logFile));
if (failure) process.exitCode = 1;
