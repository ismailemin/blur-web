// Node driver for the T-005d gravity overlay module.
//
//   node run_gravity_wasm.mjs <gravity.mjs> <Level.levelphysics> <out.json>
//
// Exit codes: 0 ok, 1 self-test failure or missing argument, 2 module failure.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [modulePath, inputPath, outputPath] = process.argv.slice(2);
if (!modulePath || !inputPath || !outputPath) {
  console.error('usage: node run_gravity_wasm.mjs <gravity.mjs> <Level.levelphysics> <out.json>');
  process.exit(1);
}

const factory = (await import(pathToFileURL(modulePath).href)).default;
const module = await factory();

const selftest = module.UTF8ToString(module._gravity_selftest());
if (selftest !== 'PASS') {
  console.error(`wasm selftest: FAIL ${selftest}`);
  process.exit(1);
}
console.log('wasm selftest: PASS');
console.log(`wasm flags: ${module.UTF8ToString(module._gravity_flags())}`);

const bytes = await readFile(inputPath);
const ptr = module._malloc(bytes.length);
if (ptr === 0) {
  console.error('wasm malloc failed');
  process.exit(2);
}
module.HEAPU8.set(bytes, ptr);

const jsonPtr = module._gravity_run(ptr, bytes.length);
module._free(ptr);
if (jsonPtr === 0) {
  console.error('gravity_run returned null');
  process.exit(2);
}

const json = module.UTF8ToString(jsonPtr);
module._gravity_free(jsonPtr);
await writeFile(outputPath, json, 'utf8');
console.log(`wrote ${outputPath} (${json.length} bytes)`);

const parsed = JSON.parse(json);
if (parsed.status !== 'ok') {
  console.error(`gravity_run status: ${parsed.status} ${JSON.stringify(parsed.error ?? {})}`);
  process.exit(3);
}
console.log(`queryHash ${parsed.hashes.queryHash}`);
console.log(`canonicalRecordBytes ${parsed.hashes.canonicalRecordBytes}`);
