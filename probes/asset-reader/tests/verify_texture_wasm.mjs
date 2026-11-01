import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import createModule from '../web/generated/pak_reader.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const mod=await createModule();
function inspect(bytes,raw=false){const pointer=mod._malloc(bytes.length||1);let output=0;try{mod.HEAPU8.set(bytes,pointer);output=(raw?mod._texture_raw_inspect:mod._texture_inspect)(pointer,bytes.length);assert.ok(output);return JSON.parse(mod.UTF8ToString(output));}finally{if(output)mod._texture_free(output);mod._free(pointer);}}
const evidence=[];
for(const name of ['arrow','debugframe','splash']){
  const fixture=path.join(root,`_work/texture-probe/${name}.texture`);
  const bytes=await readFile(fixture);
  const report=inspect(bytes);
  assert.equal(report.status,'ok');
  const native=JSON.parse(execFileSync(path.join(root,'_work/build/asset-reader-native/Release/texture_inspect.exe'),[fixture],{encoding:'utf8',maxBuffer:8*1024*1024}));
  assert.deepEqual(report,native);
  const rgba=Buffer.from(report.rgba),reference=await readFile(path.join(root,`_work/texture-probe/${name}.rgba`));
  assert.equal(rgba.length,reference.length);
  let differences=0,maxDifference=0;
  for(let i=0;i<rgba.length;++i){const difference=Math.abs(rgba[i]-reference[i]);if(difference){++differences;maxDifference=Math.max(maxDifference,difference);assert.ok(name==='splash'&&i%4===3&&difference<=1,'Unexpected RGBA disagreement with independent Pillow decoder');}}
  assert.equal(inspect(bytes.subarray(0,-1)).status,'error');
  evidence.push({name,width:report.width,height:report.height,format:report.metadata.format,nativeWasmEqual:true,independentPillowComparison:{differentChannels:differences,maxDifference,reason:differences?'BC3 alpha integer rounding: source-defined rounded interpolation vs Pillow floor':'byte equal'},rgbaSha256:createHash('sha256').update(rgba).digest('hex')});
}
const rawFile=path.join(root,'_work/material-binding/trafficcylinder_diff.rawtexture');
const rawReport=inspect(await readFile(rawFile),true);
assert.equal(rawReport.status,'ok');assert.equal(rawReport.metadata.container,'PC embedded texture');
assert.deepEqual(rawReport,JSON.parse(execFileSync(path.join(root,'_work/build/asset-reader-native/Release/texture_inspect.exe'),[rawFile,'--raw'],{encoding:'utf8'})));
assert.deepEqual(Buffer.from(rawReport.rgba),await readFile(path.join(root,'_work/material-binding/trafficcylinder_diff.rgba')));
evidence.push({name:'embedded trafficcylinder_diff',width:rawReport.width,height:rawReport.height,format:rawReport.metadata.format,nativeWasmEqual:true,independentPillowBytesEqual:true,rgbaSha256:createHash('sha256').update(Buffer.from(rawReport.rgba)).digest('hex')});
await writeFile(path.join(root,'_work/verification/texture-native-wasm.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
