import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir,open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import createPakModule from '../web/generated/pak_reader.mjs';
import { inspectXtBytes } from '../web/xt.js';
import { decodeAsset } from '../web/packet.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureDirectory = path.join(root, '_work/xt-probe');
const manifest = JSON.parse(await readFile(path.join(fixtureDirectory, 'manifest.json'), 'utf8'));
const executable = path.join(root, '_work/build/asset-reader-native/Release/xt_inspect.exe');
const mod = await createPakModule();
assert.equal(typeof mod._xt_inspect, 'function', 'Rebuild the WASM module with xt_reader.cpp and XT exports first');
assert.equal(typeof mod._xt_free, 'function');
const cases = [];
let firstFixture;
let firstReport;
for (const fixture of manifest) {
  const input = await readFile(path.join(fixtureDirectory, fixture.file));
  const packageFile=await open(path.join(root,'game-data/Blur/cache',fixture.pak));
  const packed=Buffer.alloc(fixture.entry.stored_bytes);
  try{assert.equal((await packageFile.read(packed,0,packed.length,fixture.entry.offset)).bytesRead,packed.length);}
  finally{await packageFile.close();}
  assert.deepEqual(Buffer.from(await decodeAsset(packed,fixture.entry.logical_bytes,2)),input,'Browser-compatible zlib decoder differs from independent Python bytes');
  assert.equal(input.length, fixture.decodedBytes);
  assert.equal(createHash('sha256').update(input).digest('hex'), fixture.sha256);
  const report = inspectXtBytes(mod, input);
  const native = JSON.parse(execFileSync(executable, [path.join(fixtureDirectory, fixture.file)], { encoding: 'utf8' }));
  const reference = JSON.parse(await readFile(path.join(fixtureDirectory, fixture.file.replace(/\.xt$/, '.reference.json')), 'utf8'));
  assert.deepEqual(report, native, `${fixture.file}: native/WASM mismatch`);
  assert.deepEqual(report, reference, `${fixture.file}: independent Python mismatch`);
  assert.equal(report.schemaBoundsValidated, true);
  assert.equal(report.recordPayloadValidated, false);
  assert.equal(report.runtimeObjectsCreated, false);
  assert.equal(report.integrityValidated, false);
  assert.equal(report.types.length, fixture.types);
  assert.equal(report.fields.length, fixture.fields);
  assert.equal(report.records.length, fixture.records);
  cases.push({ file: fixture.file, bytes: input.length, sha256: fixture.sha256,
    types: report.types.length, fields: report.fields.length, records: report.records.length,
    nativeWasmEqual: true, independentPythonEqual: true,compressedPythonJavascriptBytesEqual:true });
  if (!firstFixture) { firstFixture = input; firstReport = report; }
}
assert.equal(cases.length, 3);

const mutations = [
  ['unsupported version', bytes => bytes.writeUInt32LE(99, 4)],
  ['unsupported endian/tag', bytes => { bytes[0] = 0x46; }],
  ['unaligned type table', bytes => bytes.writeUInt32LE(73, 8)],
  ['overlapping field table', bytes => bytes.writeUInt32LE(bytes.readUInt32LE(8), 24)],
  ['type count limit', bytes => bytes.writeUInt32LE(4097, 12)],
  ['data blob outside file', bytes => bytes.writeUInt32LE(0xfffffffc, 64)],
  ['invalid ref type', bytes => bytes.writeUInt16LE(65535, bytes.readUInt32LE(40) + 4)],
  ['invalid component type', bytes => bytes.writeUInt16LE(65535, bytes.readUInt32LE(56))],
  ['invalid record size', bytes => { const at = bytes.readUInt32LE(48) + 8; bytes.writeUInt32LE(bytes.readUInt32LE(at) + 4, at); }],
];
for (const [name, mutate] of mutations) {
  const input = Buffer.from(firstFixture);
  mutate(input);
  assert.throws(() => inspectXtBytes(mod, input), undefined, name);
}
assert.throws(() => inspectXtBytes(mod, new Uint8Array(71)));
assert.throws(() => inspectXtBytes(mod, []));

// Metadata must neither interpret payload bytes nor authenticate them by accident.
const changedPayload = Buffer.from(firstFixture);
changedPayload[firstReport.tables.data.offset] ^= 1;
assert.deepEqual(inspectXtBytes(mod, changedPayload), firstReport);

const evidence = { cases, malformedInputsRejected: mutations.length + 2,
  opaquePayloadChangeLeavesMetadataEqual: true, runtimeObjectsCreated: false };
await mkdir(path.join(root, '_work/verification'), { recursive: true });
await writeFile(path.join(root, '_work/verification/xt-native-wasm.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
