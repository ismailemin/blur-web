// Node driver for the wasm32 build of the T-005c fixed-step probe.
//
// Usage:
//   node probes/scheduler-probe/tests/verify_scheduler_wasm.mjs <module.mjs> <out.json>
//
// Writes the suite JSON emitted by the wasm module and exits non-zero if the
// module's own self test fails.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [modulePathArg, outPathArg] = process.argv.slice(2);
if (!modulePathArg || !outPathArg) {
  console.error('usage: verify_scheduler_wasm.mjs <module.mjs> <out.json>');
  process.exit(2);
}

const modulePath = resolve(modulePathArg);
const outPath = resolve(outPathArg);

const factory = (await import(pathToFileURL(modulePath).href)).default;
const module = await factory();

const jsonPointer = module._sched_probe_json();
if (!jsonPointer) {
  console.error('FAIL: sched_probe_json returned a null pointer');
  process.exit(1);
}
const text = module.UTF8ToString(jsonPointer);
if (!text || text[0] !== '{') {
  console.error('FAIL: sched_probe_json did not return a JSON object');
  process.exit(1);
}

const failures = module._sched_probe_selftest();
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, text.endsWith('\n') ? text : `${text}\n`, 'utf8');

const parsed = JSON.parse(text);
console.log(JSON.stringify({
  module: modulePathArg,
  out: outPathArg,
  bytes: text.length,
  target: parsed.build?.target,
  compiler: parsed.build?.compiler,
  scenarios: parsed.scenarios?.length,
  selfTestFailures: failures,
}, null, 2));

// Touch the file once so a stale artefact is never silently reused.
await readFile(outPath);
process.exit(failures === 0 ? 0 : 1);
