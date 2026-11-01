import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,open,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {decodePacketZlib} from '../web/packet.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const pak=path.join(root,'game-data/Blur/cache/root.pak');
const index=JSON.parse(execFileSync(path.join(root,'_work/build/asset-reader-native/Release/pak_inspect.exe'),[pak],{encoding:'utf8',maxBuffer:8*1024*1024}));
const models=index.entries.filter(e=>!e.isDirectory&&e.path.endsWith('.model')&&e.logicalBytes>65536&&e.logicalBytes<=2*1024*1024).sort((a,b)=>a.logicalBytes-b.logicalBytes);
assert.ok(models.length>=3);
const selection=[models[0],models[Math.floor(models.length/2)],models.at(-1)];
const python=path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const file=await open(pak);const evidence=[];
try{
  for(const entry of selection){
    const independent=JSON.parse(execFileSync(python,[path.join(root,'tools/prepare_asset_fixture.py'),'--path',entry.path],{encoding:'utf8'}));
    const packed=Buffer.alloc(entry.physicalBytes);assert.equal((await file.read(packed,0,packed.length,entry.dataOffset)).bytesRead,packed.length);
    const decoded=await decodePacketZlib(packed,entry.logicalBytes);
    assert.deepEqual(Buffer.from(decoded),await readFile(independent.decodedFile));
    assert.equal(createHash('sha256').update(decoded).digest('hex'),independent.sha256);
    evidence.push({path:entry.path,packedBytes:packed.length,decodedBytes:decoded.length,packets:independent.packetCount,pythonJavascriptBytesEqual:true,sha256:independent.sha256});
  }
}finally{await file.close();}
await writeFile(path.join(root,'_work/verification/packet-reference.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
