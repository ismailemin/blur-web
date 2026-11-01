import assert from 'node:assert/strict';
import { open, readdir, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import createPakModule from '../web/generated/pak_reader.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const native = path.join(root, '_work/build/asset-reader-native/Release/pak_inspect.exe');
const cache = path.join(root, 'game-data/Blur/cache');
const mod = await createPakModule();
function inspect(data, size) {
  const input = mod._malloc(Math.max(data.length, 1));
  assert.ok(input);
  let output = 0;
  try {
    mod.HEAPU8.set(data, input);
    output = mod._pak_inspect(input, data.length, size);
    assert.ok(output);
    return JSON.parse(mod.UTF8ToString(output));
  } finally { if (output) mod._pak_free(output); mod._free(input); }
}

const results = [];
for (const name of (await readdir(cache)).filter(name => name.endsWith('.pak')).sort()) {
  const filename = path.join(cache, name);
  const file = await open(filename);
  let report;
  let readBytes = 0;
  try {
    const { size } = await file.stat();
    let length = Math.min(64, size);
    for (let step = 0; step < 8; step++) {
      const data = Buffer.alloc(length);
      const read = await file.read(data, 0, length, 0);
      assert.equal(read.bytesRead, length);
      report = inspect(data, size);
      readBytes += length;
      if (report.status !== 'need_more') break;
      assert.ok(Number.isSafeInteger(report.requiredBytes) && report.requiredBytes > length && report.requiredBytes <= Math.min(size, 64 * 1024 * 1024));
      length = report.requiredBytes;
    }
    assert.equal(report.status, 'ok', `${name}: ${JSON.stringify(report)}`);
    const comparison = JSON.parse(execFileSync(native, [filename], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    assert.deepEqual(report, comparison, `${name}: native/WASM mismatch`);
    assert.equal(report.validationPerformed, false);
    results.push({ name, version: report.header.version, entries: report.entries.length, metadataBytes: report.header.metadataBytes, transferredBytes: readBytes, totalBytes: size, nativeWasmEqual: true });
  } finally { await file.close(); }
}
assert.notEqual(inspect(new Uint8Array(64), 64).status, 'ok');
assert.notEqual(inspect(new Uint8Array(1), NaN).status, 'ok');
assert.notEqual(inspect(new Uint8Array(1), Number.MAX_SAFE_INTEGER + 1).status, 'ok');
const output = path.join(root, '_work/verification');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'pak-native-wasm.json'), JSON.stringify({ results, invalidInputsRejected: true, scope: 'Metadata only; payload authenticity not validated' }, null, 2));
console.log(JSON.stringify({ results, invalidInputsRejected: true }, null, 2));
