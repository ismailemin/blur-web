// Diagnostic WebGPU surface renderer. Input is real decoded vertex/index data.
const SHADER = `
struct Camera { mvp: mat4x4f };
@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var diffuseSampler: sampler;
@group(1) @binding(1) var diffuseTexture: texture_2d<f32>;
struct VertexOut { @builtin(position) position: vec4f, @location(0) world: vec3f, @location(1) uv: vec2f };
@vertex fn vertexMain(@location(0) position: vec3f, @location(1) uv: vec2f) -> VertexOut {
  var result: VertexOut;
  result.position = camera.mvp * vec4f(position, 1.0);
  result.world = position;
  result.uv = uv;
  return result;
}
@fragment fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
  let face = normalize(cross(dpdx(input.world), dpdy(input.world)));
  let light = normalize(vec3f(0.4, 0.8, 0.6));
  let brightness = 0.28 + 0.72 * abs(dot(face, light));
  return vec4f(vec3f(0.23, 0.73, 0.86) * brightness, 1.0);
}
@fragment fn lineMain() -> @location(0) vec4f { return vec4f(0.45,0.85,1.0,1.0); }
@fragment fn texturedMain(input: VertexOut) -> @location(0) vec4f {
  let albedo=textureSample(diffuseTexture,diffuseSampler,input.uv);
  let normal=normalize(cross(dpdx(input.world),dpdy(input.world)));
  let brightness=0.4+0.6*abs(dot(normal,normalize(vec3f(0.4,0.8,0.6))));
  return vec4f(pow(max(albedo.rgb*brightness,vec3f(0.0)),vec3f(1.0/2.2)),1.0);
}
`;

export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  }
  return out;
}

export function cameraMatrix(aspect, yaw, pitch, distance) {
  const eye = [distance * Math.cos(pitch) * Math.sin(yaw), distance * Math.sin(pitch), distance * Math.cos(pitch) * Math.cos(yaw)];
  const normalize = v => { const length = Math.hypot(...v); return v.map(x => x / length); };
  const z = normalize(eye);
  const x = normalize([z[2], 0, -z[0]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const view = new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1]);
  const near = 0.05, far = 50, f = 1 / Math.tan(Math.PI / 8);
  const projection = new Float32Array([f/aspect,0,0,0,0,f,0,0,0,0,far/(near-far),-1,0,0,near*far/(near-far),0]);
  return multiply(projection, view);
}

export function normalizeGeometry(positions, indices) {
  if (!positions || positions.length < 9 || positions.length % 3 || positions.length > 3000000 || !indices || indices.length < 3 || indices.length % 3 || indices.length > 6000000) throw new Error('Geometri boyutları desteklenmiyor.');
  const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new Error('Geometride geçersiz konum var.');
    min[i%3] = Math.min(min[i%3], positions[i]); max[i%3] = Math.max(max[i%3], positions[i]);
  }
  for (const index of indices) if (!Number.isSafeInteger(index) || index < 0 || index >= positions.length / 3) throw new Error('Geometri indeksi sınır dışında.');
  const center = min.map((value,i)=>(value+max[i])/2);
  const radius = Math.hypot(...max.map((value,i)=>(value-min[i])/2));
  if (!(radius > 0)) throw new Error('Modelin uzamsal boyutu sıfır.');
  return { vertices: Float32Array.from(positions, (value,i)=>(value-center[i%3])/radius), indices: Uint32Array.from(indices), bounds: {min,max}, radius };
}

export function fitCameraDistance(vertices,aspect,yaw,pitch){
  if(!(aspect>0)||!Number.isFinite(aspect))throw new Error('Kamera en-boy oranı geçersiz.');
  const z=[Math.cos(pitch)*Math.sin(yaw),Math.sin(pitch),Math.cos(pitch)*Math.cos(yaw)];
  const x=[Math.cos(yaw),0,-Math.sin(yaw)],y=[-Math.sin(pitch)*Math.sin(yaw),Math.cos(pitch),-Math.sin(pitch)*Math.cos(yaw)];
  const slope=Math.tan(Math.PI/8)*0.85;let distance=0.2;
  for(let i=0;i<vertices.length;i+=3){
    const dot=axis=>axis[0]*vertices[i]+axis[1]*vertices[i+1]+axis[2]*vertices[i+2];
    const depth=dot(z);distance=Math.max(distance,depth+Math.abs(dot(x))/(slope*aspect),depth+Math.abs(dot(y))/slope,depth+0.1);
  }
  return Math.max(1.3,distance);
}

export class MeshViewer {
  constructor(canvas, status) {
    this.canvas = canvas; this.status = status; this.yaw = 0.7; this.pitch = 0.25; this.distance = 2.8; this.mode = 'texture'; this.generation = 0; this.buffers = [];
    let drag = null;
    canvas.addEventListener('pointerdown', event => { drag = [event.clientX,event.clientY]; canvas.setPointerCapture(event.pointerId); });
    canvas.addEventListener('pointermove', event => { if (!drag) return; this.yaw += (event.clientX-drag[0])*0.01; this.pitch = Math.max(-1.3,Math.min(1.3,this.pitch+(event.clientY-drag[1])*0.01)); drag=[event.clientX,event.clientY]; this.draw(); });
    canvas.addEventListener('pointerup', () => { drag=null; });
    canvas.addEventListener('pointercancel', () => { drag=null; });
    canvas.addEventListener('wheel', event => { event.preventDefault(); this.distance=Math.max(1.3,Math.min(12,this.distance*Math.exp(event.deltaY*0.001))); this.draw(); },{passive:false});
    this.observer = new ResizeObserver(() => this.draw()); this.observer.observe(canvas);
  }
  reset() { this.yaw=0.7;this.pitch=0.25;this.distance=this.geometry?fitCameraDistance(this.geometry.vertices,Math.max(1,this.canvas.clientWidth)/Math.max(1,this.canvas.clientHeight),this.yaw,this.pitch):2.8;this.draw(); }
  setMode(mode) { this.mode=mode;this.draw(); }
  async init() {
    if (this.device) return;
    if (!navigator.gpu) throw new Error('Bu tarayıcıda WebGPU etkin değil. Güncel Chrome veya Brave ile açın.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU ekran kartı erişimi sağlanamadı.');
    this.device = await adapter.requestDevice();
    this.device.lost.then(info => { this.device=null;this.status.textContent=`GPU bağlantısı kesildi: ${info.message}`; });
    this.device.addEventListener('uncapturederror', event => { this.status.textContent=`GPU hatası: ${event.error.message}`; });
    this.context = this.canvas.getContext('webgpu');
    if (!this.context) throw new Error('WebGPU çizim yüzeyi oluşturulamadı.');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({device:this.device,format:this.format,alphaMode:'opaque'});
    const module = this.device.createShaderModule({code:SHADER});
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter(message=>message.type==='error');
    if (errors.length) throw new Error(errors.map(message=>message.message).join('; '));
    const common={layout:'auto',vertex:{module,entryPoint:'vertexMain',buffers:[{arrayStride:12,attributes:[{shaderLocation:0,offset:0,format:'float32x3'}]},{arrayStride:8,attributes:[{shaderLocation:1,offset:0,format:'float32x2'}]}]},depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less'}};
    this.surface = await this.device.createRenderPipelineAsync({...common,fragment:{module,entryPoint:'fragmentMain',targets:[{format:this.format}]},primitive:{topology:'triangle-list',cullMode:'none'}});
    this.lines = await this.device.createRenderPipelineAsync({...common,fragment:{module,entryPoint:'lineMain',targets:[{format:this.format}]},primitive:{topology:'line-list'}});
    this.textured = await this.device.createRenderPipelineAsync({...common,fragment:{module,entryPoint:'texturedMain',targets:[{format:this.format}]},primitive:{topology:'triangle-list',cullMode:'none'}});
    this.uniform = this.device.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.groups = [this.surface,this.lines,this.textured].map(pipeline=>this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}}]}));
  }
  async load(positions, indices, {uv0=[],draws=[],textures=[]}={}) {
    const generation=++this.generation;
    const geometry=normalizeGeometry(positions,indices);
    await this.init();
    if(generation!==this.generation)return;
    for(const buffer of this.buffers)buffer.destroy(); this.buffers=[];
    for(const texture of this.textures||[])texture?.destroy();this.textures=[];this.textureGroups=[];
    const upload=(array,usage)=>{const buffer=this.device.createBuffer({size:Math.max(4,Math.ceil(array.byteLength/4)*4),usage:usage|GPUBufferUsage.COPY_DST});this.device.queue.writeBuffer(buffer,0,array);this.buffers.push(buffer);return buffer;};
    const edges=new Uint32Array(geometry.indices.length*2);
    for(let i=0;i<geometry.indices.length;i+=3){const[a,b,c]=geometry.indices.subarray(i,i+3);edges.set([a,b,b,c,c,a],i*2);}
    this.vertexBuffer=upload(geometry.vertices,GPUBufferUsage.VERTEX);
    if(uv0.length&&uv0.length!==positions.length/3*2)throw new Error('UV0 vertex sayısı eşleşmiyor.');
    if(uv0.some(value=>!Number.isFinite(value)))throw new Error('UV0 geçersiz.');
    this.uvBuffer=upload(uv0.length?Float32Array.from(uv0):new Float32Array(positions.length/3*2),GPUBufferUsage.VERTEX);
    this.indexBuffer=upload(geometry.indices,GPUBufferUsage.INDEX);
    this.edgeBuffer=upload(edges,GPUBufferUsage.INDEX);
    this.indexCount=geometry.indices.length;this.edgeCount=edges.length;
    this.geometry=geometry;
    this.draws=draws.length?draws:[{firstIndex:0,indexCount:this.indexCount,albedoTexture:null}];
    for(const draw of this.draws)if(!Number.isSafeInteger(draw.firstIndex)||!Number.isSafeInteger(draw.indexCount)||draw.firstIndex<0||draw.indexCount<0||draw.firstIndex%3||draw.indexCount%3||draw.firstIndex+draw.indexCount>this.indexCount)throw new Error('Çizim aralığı geçersiz.');
    for(let i=0;i<textures.length;i++){
      const source=textures[i];if(!source)continue;
      if(!uv0.length||!Number.isInteger(source.width)||!Number.isInteger(source.height)||source.width<1||source.height<1||source.width>512||source.height>512||source.rgba.length!==source.width*source.height*4)throw new Error('Materyal dokusu sınırları geçersiz.');
      const texture=this.device.createTexture({size:[source.width,source.height],format:'rgba8unorm-srgb',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      this.device.queue.writeTexture({texture},Uint8Array.from(source.rgba),{bytesPerRow:source.width*4,rowsPerImage:source.height},[source.width,source.height]);
      this.textures[i]=texture;
      const sampler=this.device.createSampler({addressModeU:'repeat',addressModeV:'repeat',magFilter:'linear',minFilter:'linear'});
      this.textureGroups[i]=this.device.createBindGroup({layout:this.textured.getBindGroupLayout(1),entries:[{binding:0,resource:sampler},{binding:1,resource:texture.createView()}]});
    }
    this.reset();
    const texturedDraws=this.draws.filter(draw=>this.textureGroups[draw.albedoTexture]).length;
    this.status.textContent=`WebGPU · ${positions.length/3} vertex · ${indices.length/3} üçgen · gerçek model geometrisi${texturedDraws?` · ${texturedDraws}/${this.draws.length} çizimde özgün albedo`:''}`;
    await this.device.queue.onSubmittedWorkDone();
    return geometry;
  }
  draw() {
    if(!this.device||!this.vertexBuffer)return;
    const ratio=Math.min(devicePixelRatio||1,2),width=Math.max(1,Math.round(this.canvas.clientWidth*ratio)),height=Math.max(1,Math.round(this.canvas.clientHeight*ratio));
    if(this.canvas.width!==width||this.canvas.height!==height||!this.depth){this.canvas.width=width;this.canvas.height=height;this.depth?.destroy();this.depth=this.device.createTexture({size:[width,height],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});}
    this.device.queue.writeBuffer(this.uniform,0,cameraMatrix(width/height,this.yaw,this.pitch,this.distance));
    const encoder=this.device.createCommandEncoder();
    const pass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),clearValue:{r:0.035,g:0.065,b:0.1,a:1},loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:this.depth.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
    const wire=this.mode==='wire';pass.setVertexBuffer(0,this.vertexBuffer);pass.setVertexBuffer(1,this.uvBuffer);pass.setIndexBuffer(wire?this.edgeBuffer:this.indexBuffer,'uint32');
    if(wire){pass.setPipeline(this.lines);pass.setBindGroup(0,this.groups[1]);pass.drawIndexed(this.edgeCount);}
    else for(const draw of this.draws){const group=this.mode==='surface'?null:this.textureGroups[draw.albedoTexture];pass.setPipeline(group?this.textured:this.surface);pass.setBindGroup(0,this.groups[group?2:0]);if(group)pass.setBindGroup(1,group);pass.drawIndexed(draw.indexCount,1,draw.firstIndex);}
    pass.end();this.device.queue.submit([encoder.finish()]);
  }
}


