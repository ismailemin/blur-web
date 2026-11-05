// Standalone WebGPU preview for the car-part manifest.
//
// The shader, per-draw dynamic uniform layout, camera maths and upload-once
// discipline are adapted from the committed packet consumer
// (`probes/e1-drive/web/packet-consumer.js`, itself a copy of
// `probes/render-packet/web/packet-consumer.js`). This file does not edit
// either probe. Materials are diagnostic colours, not game materials.

import { identity, multiply, orbitView, perspective, rotationX, translation } from './math.js';

const SHADER = /* wgsl */ `
struct DrawUniforms {
  viewProjection: mat4x4f,
  world: mat4x4f,
  albedo: vec4f,
};
struct Scene {
  lightDirection: vec4f,
  lightColour: vec4f,
  ambient: vec4f,
};
@group(0) @binding(0) var<uniform> draw: DrawUniforms;
@group(1) @binding(0) var<uniform> scene: Scene;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) local: vec3f,
};

@vertex fn vertexMain(@location(0) position: vec3f) -> VertexOut {
  var result: VertexOut;
  let worldPosition = draw.world * vec4f(position, 1.0);
  result.world = worldPosition.xyz;
  result.local = position;
  result.position = draw.viewProjection * worldPosition;
  return result;
}

@fragment fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
  let raw = cross(dpdx(input.world), dpdy(input.world));
  let length = length(raw);
  let face = select(vec3f(0.0, 1.0, 0.0), raw / max(length, 1e-20), length > 0.0);
  let lambert = abs(dot(face, normalize(scene.lightDirection.xyz)));
  let brightness = scene.ambient.x + (1.0 - scene.ambient.x) * lambert;
  let radiance = scene.lightColour.rgb * scene.lightColour.a * draw.albedo.rgb * brightness;
  // Diagnostic spin marker: a band fixed in element-local space. It is not a
  // material; it makes the wheel rotation visible on rotationally symmetric
  // tyre/rim/disc geometry. draw.albedo.a is 0 for every non-spinning draw.
  let angle = atan2(input.local.z, input.local.y);
  let band = smoothstep(0.86, 0.98, cos(angle)) * draw.albedo.a;
  let marked = mix(radiance, vec3f(1.0, 0.94, 0.72), band * 0.72);
  return vec4f(pow(clamp(marked, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), 1.0);
}
`;

const DRAW_UNIFORM_STRIDE = 256;
const DRAW_UNIFORM_BYTES = 144;

const KIND_HUE = {
  body: [200, 232],
  interior: [22, 46],
  glass: [172, 196],
  light: [44, 66],
  unclassified: [0, 12]
};

function stableHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function hslToRgb(hue, saturation, lightness) {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const h = ((hue % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r1, g1, b1] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x]
    : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const m = lightness - c / 2;
  return [r1 + m, g1 + m, b1 + m];
}

const WHEEL_MEMBER_COLORS = {
  tyre: [0.18, 0.72, 0.30],
  rim: [0.80, 0.82, 0.88],
  brakeDisc: [0.86, 0.22, 0.22],
  brakeCaliper: [1.0, 0.80, 0.20]
};

function colorFor(part) {
  if (part.partKind === 'wheel') {
    const corner = part.id.split('.').at(-1);
    const wheelColours = {
      frontleft: [0.24, 0.90, 0.44],
      frontright: [0.88, 0.34, 0.88],
      backleft: [0.20, 0.60, 0.96],
      backright: [0.96, 0.50, 0.20]
    };
    return wheelColours[corner] ?? [0.30, 0.85, 0.50];
  }
  const range = KIND_HUE[part.partKind] ?? KIND_HUE.unclassified;
  const hash = stableHash(part.id);
  const hue = range[0] + (hash % (range[1] - range[0] + 1));
  const saturation = 0.55 + ((hash >>> 8) % 16) / 100;
  const lightness = 0.52 + ((hash >>> 16) % 16) / 100;
  return hslToRgb(hue, saturation, lightness);
}

export class CarPartRenderer {
  constructor(canvas, onState) {
    this.canvas = canvas;
    this.onState = onState ?? (() => {});
    this.device = null;
    this.parts = [];
    this.draws = [];
    this.uniformBuffer = null;
    this.depth = null;
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.drawBindGroup = null;
    this.sceneBindGroup = null;
    this.angle = 0;
    this.spin = true;
    this.spinRate = 1.8;
    this.orbit = { target: [0, 0.18, 0], distance: 8.2, yaw: 0.86, pitch: 0.30 };
    this.frame = 0;
    this.stats = {
      geometryUploads: 0,
      geometryUploadBytes: 0,
      uniformWrites: 0,
      drawsIssued: 0
    };
    this.lastTime = null;
    this.running = false;
    this.drag = null;
    this.pointer = null;

    canvas.addEventListener('pointerdown', (event) => {
      this.drag = [event.clientX, event.clientY];
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!this.drag) return;
      const scale = 0.006 * (this.orbit.distance / 10);
      this.orbit.yaw -= (event.clientX - this.drag[0]) * scale;
      this.orbit.pitch = Math.max(-1.35, Math.min(1.35,
        this.orbit.pitch + (event.clientY - this.drag[1]) * scale));
      this.drag = [event.clientX, event.clientY];
    });
    canvas.addEventListener('pointerup', () => { this.drag = null; });
    canvas.addEventListener('pointercancel', () => { this.drag = null; });
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.orbit.distance = Math.max(2.4, Math.min(40, this.orbit.distance * Math.exp(event.deltaY * 0.001)));
    }, { passive: false });
  }

  async init() {
    if (this.device) return;
    if (!navigator.gpu) throw new Error('navigator.gpu is not available');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    this.device = await adapter.requestDevice();
    this.adapterInfo = adapter.info
      ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
          device: adapter.info.device, description: adapter.info.description }
      : {};
    this.device.lost.then((info) => {
      this.onState({ state: 'error', message: 'WebGPU device lost: ' + info.message });
    });
    this.device.addEventListener('uncapturederror', (event) => {
      this.onState({ state: 'error', message: 'WebGPU uncaptured error: ' + event.error.message });
    });

    this.context = this.canvas.getContext('webgpu');
    if (!this.context) throw new Error('canvas has no webgpu context');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });

    const module = this.device.createShaderModule({ code: SHADER });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((message) => message.type === 'error');
    if (errors.length) throw new Error('shader: ' + errors.map((message) => message.message).join('; '));

    const drawLayout = this.device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: DRAW_UNIFORM_BYTES }
      }]
    });
    const sceneLayout = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 48 } }]
    });
    this.pipeline = await this.device.createRenderPipelineAsync({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [drawLayout, sceneLayout] }),
      vertex: {
        module,
        entryPoint: 'vertexMain',
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }]
      },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' }
    });
    this.drawLayout = drawLayout;

    const sceneBytes = new Float32Array(12);
    sceneBytes.set([-0.35, 0.86, 0.37, 0], 0);
    sceneBytes.set([1.0, 0.97, 0.92, 1.0], 4);
    sceneBytes.set([0.30, 0, 0, 0], 8);
    this.sceneBuffer = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.sceneBuffer, 0, sceneBytes);
    this.sceneBindGroup = this.device.createBindGroup({
      layout: sceneLayout,
      entries: [{ binding: 0, resource: { buffer: this.sceneBuffer, offset: 0, size: 48 } }]
    });
  }

  async load(manifest, mesh) {
    if (manifest.kind !== 'blur.car-part-manifest' || manifest.version !== 1) {
      throw new Error('manifest kind/version is not blur.car-part-manifest v1');
    }
    if (mesh.vertexCount * 3 !== mesh.positions.length || mesh.indexCount !== mesh.indices.length) {
      throw new Error('mesh counts disagree with the flat arrays');
    }
    await this.init();

    const positions = Float32Array.from(mesh.positions);
    const indices = Uint32Array.from(mesh.indices);
    this.vertexBuffer = this.device.createBuffer({
      size: Math.ceil(positions.byteLength / 4) * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.indexBuffer = this.device.createBuffer({
      size: Math.max(4, Math.ceil(indices.byteLength / 4) * 4),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, positions);
    this.device.queue.writeBuffer(this.indexBuffer, 0, indices);
    this.stats.geometryUploads = 2;
    this.stats.geometryUploadBytes = positions.byteLength + indices.byteLength;

    this.parts = manifest.parts.map((part) => ({
      ...part,
      color: colorFor(part),
      worldStatic: Float32Array.from(part.worldTransform?.matrixColumnMajor ?? identity()),
      wheels: part.partKind === 'wheel'
    }));
    this.draws = [];
    for (const part of this.parts) {
      for (const drawIndex of part.draws) {
        const draw = manifest.draws[drawIndex];
        if (!draw) throw new Error(`part ${part.id} references missing draw ${drawIndex}`);
        this.draws.push({
          drawIndex,
          firstIndex: draw.firstIndex,
          indexCount: draw.indexCount,
          part,
          member: draw.evidence?.wheelPart ?? null,
          color: part.wheels && draw.evidence?.wheelPart && draw.evidence.wheelPart !== 'tyre'
            ? (WHEEL_MEMBER_COLORS[draw.evidence.wheelPart] ?? part.color)
            : part.color
        });
      }
    }
    if (this.draws.length !== manifest.draws.length) {
      throw new Error(`draw list covers ${this.draws.length} of ${manifest.draws.length} draws`);
    }

    this.uniformBuffer = this.device.createBuffer({
      size: this.draws.length * DRAW_UNIFORM_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.drawBindGroup = this.device.createBindGroup({
      layout: this.drawLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: DRAW_UNIFORM_BYTES } }]
    });
    this.uniformData = new Float32Array(this.draws.length * DRAW_UNIFORM_STRIDE / 4);

    this.depth = null;
    this.manifest = manifest;
    this.mesh = mesh;
    return this;
  }

  buildWorld(draw, angle) {
    const part = draw.part;
    if (!part.wheels) return part.worldStatic;
    const t = part.worldTransform.translation;
    // VehicleActor.cpp: brake calipers must not rotate; tyre/rim/disc do.
    if (draw.member === 'brakeCaliper') return translation(t[0], t[1], t[2]);
    return multiply(translation(t[0], t[1], t[2]), rotationX(angle));
  }

  writeUniforms(viewProjection, angle) {
    const data = this.uniformData;
    data.fill(0);
    for (let index = 0; index < this.draws.length; index++) {
      const draw = this.draws[index];
      const offset = index * (DRAW_UNIFORM_STRIDE / 4);
      data.set(viewProjection, offset);
      data.set(this.buildWorld(draw, angle), offset + 16);
      data[offset + 32] = draw.color[0];
      data[offset + 33] = draw.color[1];
      data[offset + 34] = draw.color[2];
      // w = diagnostic spin-marker strength, not opacity.
      data[offset + 35] = draw.part.wheels && draw.member !== 'brakeCaliper' ? 0.85 : 0.0;
    }
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
    this.stats.uniformWrites++;
  }

  ensureTarget() {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    if (this.canvas.width === width && this.canvas.height === height && this.depth) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.depth?.destroy();
    this.depth = this.device.createTexture({
      size: [width, height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    this.depthView = this.depth.createView();
  }

  renderFrame() {
    if (!this.device || !this.uniformBuffer) return;
    this.ensureTarget();
    const aspect = this.canvas.width / this.canvas.height;
    const projection = perspective(45 * Math.PI / 180, aspect, 0.08, 120);
    const { view } = orbitView(this.orbit.target, this.orbit.distance, this.orbit.yaw, this.orbit.pitch);
    const viewProjection = multiply(projection, view);
    this.writeUniforms(viewProjection, this.angle);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.055, g: 0.065, b: 0.080, a: 1 },
        loadOp: 'clear',
        storeOp: 'store'
      }],
      depthStencilAttachment: {
        view: this.depthView,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store'
      }
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(1, this.sceneBindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    for (let index = 0; index < this.draws.length; index++) {
      const draw = this.draws[index];
      pass.setBindGroup(0, this.drawBindGroup, [index * DRAW_UNIFORM_STRIDE]);
      pass.drawIndexed(draw.indexCount, 1, draw.firstIndex);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.stats.drawsIssued += this.draws.length;
    this.frame++;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = (time) => {
      if (!this.running) return;
      const dt = this.lastTime === null ? 0 : Math.min(0.05, (time - this.lastTime) / 1000);
      this.lastTime = time;
      if (this.spin) this.angle += this.spinRate * dt;
      this.renderFrame();
      this.onState({ state: 'running', angle: this.angle, frame: this.frame });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
  }
}
