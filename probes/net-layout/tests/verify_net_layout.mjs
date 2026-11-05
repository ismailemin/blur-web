// T-006b layout probe — run the wasm32 module in node and write its JSON.
//
//   node verify_net_layout.mjs <module.mjs> <out.json>
//
// Exit codes: 0 ok, 1 self-test failure, 2 usage, 3 module/IO failure.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [modulePath, outPath] = process.argv.slice(2);
if (!modulePath || !outPath) {
  console.error('usage: node verify_net_layout.mjs <module.mjs> <out.json>');
  process.exit(2);
}

let factory;
try {
  factory = (await import(pathToFileURL(modulePath).href)).default;
} catch (err) {
  console.error(`cannot import ${modulePath}: ${err}`);
  process.exit(3);
}

const module = await factory();

const rc = module._wire_layout_selftest();
if (rc !== 0) {
  console.error(`wire_layout_selftest() returned ${rc}`);
  process.exit(1);
}

const ptr = module._wire_layout_json();
const json = module.UTF8ToString(ptr);
if (!json || !json.startsWith('{')) {
  console.error('wire_layout_json() did not return a JSON object');
  process.exit(3);
}

// Determinism inside the module: a second call must produce the same bytes.
const json2 = module.UTF8ToString(module._wire_layout_json());
if (json !== json2) {
  console.error('wire_layout_json() is not deterministic within the module');
  process.exit(1);
}

writeFileSync(outPath, json, 'utf8');

// Record the module size next to the output for the evidence log.
let bytes = 0;
try {
  bytes = readFileSync(modulePath.replace(/\.mjs$/, '.wasm')).length;
} catch {
  bytes = 0;
}
console.log(`net-layout wasm: selftest PASS, wrote ${outPath} (${json.length} chars, wasm ${bytes} B)`);
