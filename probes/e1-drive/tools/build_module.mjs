// Build the E1 drive-slice wasm module.
//
// The module is the T-005d 186-object closure with one substitution: the batch
// harness (`vehicle_harness.cpp`, which carries a 32 MiB output buffer) is
// replaced by `probes/e1-drive/native/e1_drive_lib.cpp`, the library ABI this
// slice drives. The other 185 objects are reused from the verified T-005d build
// (`_work/engine-vehicle-spike/out/obj_a/`), which was produced by
// `engine/verify_vehicle.py --fresh` from the patched tree with the flag set
// repeated below.
//
// Usage: node probes/e1-drive/tools/build_module.mjs [--force-objects] [--debug]
//
// `--debug` builds a second, diagnostic-only pair (`e1_drive_debug.mjs`/`.wasm`)
// with `-g` and a symbol map so a wasm trap can be resolved to a function name.
// The shipped `e1_drive.*` artifacts are unchanged by that flag.
//
// Outputs (never committed):
//   _work/e1-drive/module/e1_drive.mjs
//   _work/e1-drive/module/e1_drive.wasm
//   _work/e1-drive/module/build.json
//   _work/e1-drive/module/e1_drive_debug.mjs + .wasm + .symbols   (--debug only)
//   _work/logs/e1-drive/build_*.log

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, '_work/e1-drive/module');
const LOGS = path.join(ROOT, '_work/logs/e1-drive');
const TREE = path.join(ROOT, '_work/engine-vehicle-spike/tree');
const OBJECTS = path.join(ROOT, '_work/engine-vehicle-spike/out/obj_a');
const PYTHON = 'C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const EM = path.join(ROOT, '_work/toolchains/emsdk/upstream/emscripten/em++.py');

const COMMON = path.join(TREE, 'code/mercury/library/common');
const GRAVITY = path.join(TREE, 'code/mercury/library/physics/gravity');
const RP = path.join(TREE, 'code/mercury/library/physics/racingphysics');

const OURS = path.join(ROOT, 'probes/e1-drive/native/e1_drive_lib.cpp');

const FLAGS = [
  '-DBUILD_CONFIG_SPEED', '-DPLATFORM_WEB', '-std=c++14', '-O2',
  '-fno-fast-math', '-ffp-contract=off',
  '-fdelayed-template-parsing', '-D__restrict=', '-fdeclspec',
  '-DUSE_SOLVER_2',
  '-Wno-nonportable-include-path', '-Wno-ignored-attributes',
  '-Wno-deprecated-register', '-Wno-return-type', '-Wno-c++20-extensions',
  '-include', path.join(ROOT, 'engine/harness/t005b/msvc_crt_web.h'),
  '-include', path.join(ROOT, 'engine/harness/t005c/web_platform.h')
];

// Chassis collision proxy lift (metres). The shipped module uses the source's
// default; `--proxy-lift=<m>` builds a measurement variant only and records it in
// build.json so no run can be confused about which proxy it used.
const proxyLiftArg = process.argv.find((arg) => arg.startsWith('--proxy-lift='));
const proxyLift = proxyLiftArg === undefined ? null : Number(proxyLiftArg.split('=')[1]);
if (proxyLiftArg !== undefined && !(Number.isFinite(proxyLift) && proxyLift >= 0 && proxyLift <= 10)) {
  throw new Error('--proxy-lift must be a number in [0, 10]');
}
if (proxyLift !== null) {
  const literal = Number.isInteger(proxyLift) ? proxyLift.toFixed(1) : String(proxyLift);
  FLAGS.push('-DE1_CHASSIS_PROXY_LIFT=' + literal + 'f');
}

const INCLUDE_DIRS = [
  path.join(ROOT, 'engine/harness/t005d-vehicle/display_shim'),
  RP, path.join(RP, 'include'),
  path.join(COMMON, 'core/include'), path.join(COMMON, 'core'),
  path.join(COMMON, 'system/include'), path.join(COMMON, 'btl/include'),
  path.join(COMMON, 'system'), path.join(COMMON, 'system/source/scheduler'),
  path.join(COMMON, 'misc_shared'), path.join(COMMON, 'misc_shared/include'),
  path.join(COMMON, 'xt2/include'),
  GRAVITY, path.join(GRAVITY, 'include')
].map((dir) => '-I' + dir);

const EXPORTS = [
  '_e1_create', '_e1_reset', '_e1_set_input', '_e1_step',
  '_e1_get_state', '_e1_info', '_e1_engine_rpm', '_e1_ground_probe', '_e1_last_error', '_e1_diag',
  '_e1_ray_probe', '_e1_boost_queue', '_e1_boost_state',
  '_malloc', '_free'
];

const LINK = [
  '-O2', '-fno-fast-math', '-ffp-contract=off',
  '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=node,web',
  '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=268435456',
  '-sMAXIMUM_MEMORY=1073741824', '-sSTACK_SIZE=8388608', '--no-entry',
  '-sERROR_ON_UNDEFINED_SYMBOLS=1',
  '-sEXPORTED_FUNCTIONS=' + EXPORTS.join(','),
  '-sEXPORTED_RUNTIME_METHODS=UTF8ToString,HEAPU8,HEAPF32,HEAPU32'
];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const DEBUG = process.argv.includes('--debug');

function run(label, args) {
  mkdirSync(LOGS, { recursive: true });
  const file = path.join(LOGS, label + '.log');
  const stamp = '$ ' + [PYTHON, ...args].join(' ');
  const result = spawnSync(PYTHON, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  writeFileSync(file, stamp + '\n' + (result.stdout ?? '') + (result.stderr ?? ''), 'utf8');
  if (result.status !== 0) {
    const tail = ((result.stdout ?? '') + (result.stderr ?? '')).split('\n').slice(-40).join('\n');
    throw new Error(label + ' failed (' + result.status + ')\n' + tail + '\nlog: ' + path.relative(ROOT, file));
  }
  return result;
}

if (!existsSync(EM)) throw new Error('emscripten missing: ' + EM);
if (!existsSync(OBJECTS)) throw new Error('T-005d objects missing (run `python engine/verify_vehicle.py --fresh`): ' + OBJECTS);

mkdirSync(OUT, { recursive: true });

const reused = readdirSync(OBJECTS)
  .filter((name) => name.endsWith('.o') && !name.includes('vehicle_harness'))
  .sort();
if (reused.length !== 185) {
  throw new Error('expected 185 reusable T-005d objects, found ' + reused.length);
}

const harnessObject = path.join(OUT, 'e1_drive_lib.o');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// Always recompile the harness object: the file is one translation unit, and a
// cached object would silently keep a different proxy lift after a flag change.
// (This cost 5 s and one wrong measurement once: the reuse rule was "compile only
// when missing".)
run('build_object', [EM, ...FLAGS, ...INCLUDE_DIRS, '-c', OURS, '-o', harnessObject]);

const objects = reused.map((name) => path.join(OBJECTS, name)).concat([harnessObject]);

const links = [];
for (const tag of ['a', 'b']) {
  const js = path.join(OUT, 'e1_drive_' + tag + '.mjs');
  run('build_link_' + tag, [EM, ...objects, ...LINK, '-o', js]);
  links.push(js);
}

if (DEBUG) {
  // Diagnostic build only: keep every function name so a trap stack resolves to
  // a symbol, and keep assertions on. Same objects, same optimisation flags.
  const js = path.join(OUT, 'e1_drive_debug.mjs');
  run('build_link_debug', [EM, ...objects, ...LINK, '-g', '-sASSERTIONS=1',
                           '--emit-symbol-map', '-o', js]);
  links.push(js);
}

const wasmA = path.join(OUT, 'e1_drive_a.wasm');
const wasmB = path.join(OUT, 'e1_drive_b.wasm');
const hashA = sha256(readFileSync(wasmA));
const hashB = sha256(readFileSync(wasmB));

// Keep the stable names the page and the verifier load.
for (const suffix of ['.mjs', '.wasm']) {
  const src = path.join(OUT, 'e1_drive_a' + suffix);
  const dst = path.join(OUT, 'e1_drive' + suffix);
  writeFileSync(dst, readFileSync(src));
}

const report = {
  module: rel(path.join(OUT, 'e1_drive.mjs')),
  wasm: rel(path.join(OUT, 'e1_drive.wasm')),
  wasmBytes: statSync(path.join(OUT, 'e1_drive.wasm')).size,
  wasmSha256: hashA,
  rebuildSha256: hashB,
  buildDeterministic: hashA === hashB,
  objects: objects.length,
  reusedObjects: reused.length,
  ownObjects: 1,
  ownSource: rel(OURS),
  ownSourceSha256: sha256(readFileSync(OURS)),
  chassisProxyLiftMetres: proxyLift,
  debugModule: DEBUG ? rel(path.join(OUT, 'e1_drive_debug.mjs')) : null,
  debugSymbols: DEBUG ? rel(path.join(OUT, 'e1_drive_debug.symbols')) : null,
  reusedObjectsFrom: rel(OBJECTS),
  harnessObjectExcluded: '185_vehicle_harness.o (T-005d batch harness, 32 MiB static buffer)',
  exports: EXPORTS,
  flags: FLAGS,
  link: LINK,
  commands: [
    'node probes/e1-drive/tools/build_module.mjs',
    'python em++ ' + FLAGS.join(' ') + ' -c ' + rel(OURS),
    'python em++ <185 T-005d objects + e1_drive_lib.o> ' + LINK.join(' ') + ' -o e1_drive_a.mjs (and _b)'
  ]
};
writeFileSync(path.join(OUT, 'build.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
if (hashA !== hashB) {
  console.error('the wasm build is not deterministic');
  process.exitCode = 1;
}

