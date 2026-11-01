import assert from 'node:assert/strict';
import { open, readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import createPakModule from '../web/generated/pak_reader.mjs';
import { decodeSinglePacket } from '../web/model.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const file = await open(path.join(root, 'game-data/Blur/cache/root.pak'));
const packed = Buffer.alloc(3424);
try { assert.equal((await file.read(packed, 0, 3424, 261296128)).bytesRead, 3424); } finally { await file.close(); }
const decoded = await decodeSinglePacket(packed, 8015);
const expectedHash = '57f28fb4026a638c2a93469148b8597ebf93ac79c22acd3c836d58e32fc1565b';
assert.equal(createHash('sha256').update(decoded).digest('hex'), expectedHash);
const independent = await readFile(path.join(root, '_work/model-probe/trafficcylinder.model'));
assert.deepEqual(Buffer.from(decoded), independent);
const mod = await createPakModule();
const ptr = mod._malloc(decoded.length);
let output = 0;
let report;
try {
  mod.HEAPU8.set(decoded, ptr);
  output = mod._model_inspect(ptr, decoded.length);
  assert.ok(output);
  report = JSON.parse(mod.UTF8ToString(output));
} finally { if (output) mod._model_free(output); mod._free(ptr); }
assert.equal(report.status, 'ok');
const native = JSON.parse(execFileSync(path.join(root, '_work/build/asset-reader-native/Release/model_inspect.exe'), [path.join(root, '_work/model-probe/trafficcylinder.model')], { encoding: 'utf8' }));
assert.deepEqual(report, native);
assert.equal(report.chunks[0].id, 'Model');
assert.equal(report.chunks[0].children.find(chunk => chunk.id === 'Render').offset, 650);
assert.equal(report.integrityValidated, false);
await assert.rejects(() => decodeSinglePacket(packed.subarray(0, packed.length - 1), 8015));
await assert.rejects(() => decodeSinglePacket(packed, 8014));
await assert.rejects(() => decodeSinglePacket(packed, 65537));
const bomb = deflateRawSync(Buffer.alloc(65536));
const bombPacket = Buffer.alloc(bomb.length + 8); bombPacket.writeUInt32LE(65536); bombPacket.writeUInt32LE(bomb.length, 4); bomb.copy(bombPacket, 8);
await assert.rejects(() => decodeSinglePacket(bombPacket, 16));
const evidence = { source: 'root.pak', entry: '\\models\\objects\\usa_la_river\\misc\\trafficcylinder.model', packedBytes: packed.length, decodedBytes: decoded.length, sha256: expectedHash, independentPythonBytesEqual: true, nativeWasmEqual: true, malformedPacketsRejected: true, model: report };
await mkdir(path.join(root, '_work/verification'), { recursive: true });
await writeFile(path.join(root, '_work/verification/model-native-wasm.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
