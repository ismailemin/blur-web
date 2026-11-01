import assert from 'node:assert/strict';
import { multiply, cameraMatrix, normalizeGeometry,fitCameraDistance } from '../web/mesh-viewer.js';
const identity=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
const matrix=cameraMatrix(16/9,0.7,0.25,3.6);
assert.deepEqual(multiply(identity,matrix),matrix);
const transform=(m,p)=>[0,1,2,3].map(row=>p.reduce((sum,v,column)=>sum+m[column*4+row]*v,0));
const center=transform(matrix,[0,0,0,1]);
assert.ok(Math.abs(center[0])<1e-5&&Math.abs(center[1])<1e-5&&center[3]>0);
assert.ok(center[2]/center[3]>0&&center[2]/center[3]<1,'WebGPU clip depth must be 0..1');
const data=normalizeGeometry([10,20,30,12,20,30,10,24,30],[0,1,2]);
assert.deepEqual(data.bounds,{min:[10,20,30],max:[12,24,30]});
assert.ok([...data.vertices].every(Number.isFinite));
assert.throws(()=>normalizeGeometry([0,0,0,1,1,1,2,2,2],[0,1,3]));
assert.throws(()=>normalizeGeometry([0,0,0,1,1,1,NaN,2,2],[0,1,2]));
assert.throws(()=>normalizeGeometry([0,0,0,0,0,0,0,0,0],[0,1,2]));
for(const aspect of [0.6,1,2.5])for(const extents of [[0.4,0.25,1],[0.04,1,0.04],[0.58,0.58,0.58]]){
  const vertices=[];for(const x of [-extents[0],extents[0]])for(const y of [-extents[1],extents[1]])for(const z of [-extents[2],extents[2]])vertices.push(x,y,z);
  const distance=fitCameraDistance(vertices,aspect,0.7,0.25),fitted=cameraMatrix(aspect,0.7,0.25,distance);
  for(let i=0;i<vertices.length;i+=3){const clip=transform(fitted,[...vertices.slice(i,i+3),1]);assert.ok(Math.abs(clip[0]/clip[3])<=0.851&&Math.abs(clip[1]/clip[3])<=0.851,'Actual bounds must fit camera margin');assert.ok(clip[2]/clip[3]>0&&clip[2]/clip[3]<1);}
}
console.log('PASS: camera centering/depth, matrix composition, bounds normalization, invalid geometry rejection');
