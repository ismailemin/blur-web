// WebGPU consumer for render packet v1.
//
// It only reads the packet contract: camera, lights, meshes, draws. It never
// reaches into a reader or an engine. Materials are not applied, so every draw is
// shaded with a neutral albedo under the packet's directional light — a declared
// diagnostic fallback, not a guessed material colour.

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
};

@vertex fn vertexMain(@location(0) position: vec3f) -> VertexOut {
  var result: VertexOut;
  let worldPosition = draw.world * vec4f(position, 1.0);
  result.world = worldPosition.xyz;
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
  return vec4f(pow(clamp(radiance, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), 1.0);
}
`;

const NEUTRAL_ALBEDO = 0.8;
const DRAW_UNIFORM_STRIDE = 256; // minUniformBufferOffsetAlignment default

export const MATRIX_CONVENTION =
  'column-major 16-float array; column-vector; right-handed view; WebGPU clip depth 0..1';

/** Column-major a*b, matching WGSL mat4x4f * vec4f. */
export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

export function orbitView(target, distance, yaw, pitch) {
  const z = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
  const eye = [target[0] + distance * z[0], target[1] + distance * z[1], target[2] + distance * z[2]];
  const normalize = (vector) => {
    const length = Math.hypot(...vector);
    return vector.map((value) => value / length);
  };
  const x = normalize([z[2], 0, -z[0]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const view = new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1
  ]);
  return { view, eye, direction: z };
}

export function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (near - far), -1,
    0, 0, (near * far) / (near - far), 0
  ]);
}

/** Smallest orbit distance that keeps every vertex of the given meshes in frame. */
export function fitVertexDistance(positionArrays, target, yaw, pitch, fovY, aspect, margin) {
  const z = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
  const normalize = (vector) => { const length = Math.hypot(...vector); return vector.map((value) => value / length); };
  const x = normalize([z[2], 0, -z[0]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const slopeY = Math.tan(fovY / 2);
  const slopeX = slopeY * aspect;
  let distance = 1e-3;
  for (const positions of positionArrays) {
    for (let index = 0; index < positions.length; index += 3) {
      const vx = positions[index] - target[0];
      const vy = positions[index + 1] - target[1];
      const vz = positions[index + 2] - target[2];
      const depth = x[0] * vx + x[1] * vy + x[2] * vz;
      const up = y[0] * vx + y[1] * vy + y[2] * vz;
      const along = z[0] * vx + z[1] * vy + z[2] * vz;
      distance = Math.max(distance, along + Math.abs(depth) / slopeX, along + Math.abs(up) / slopeY, along + 0.05);
    }
  }
  return distance * margin;
}

function boundsOfDraws(draws) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const draw of draws) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], draw.bounds.min[axis]);
      max[axis] = Math.max(max[axis], draw.bounds.max[axis]);
    }
  }
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
  return { min, max, center, radius };
}

export class PacketConsumer {
  constructor(canvas, onState) {
    this.canvas = canvas;
    this.onState = onState ?? (() => {});
    this.draws = [];
    this.meshes = new Map();
    this.buffers = [];
    this.device = null;
    this.orbit = null;
    this.usePacketCamera = true;
    this.focusMeshId = null;
    this.frames = 0;
    this.drag = null;

    canvas.addEventListener('pointerdown', (event) => {
      this.drag = [event.clientX, event.clientY];
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!this.drag || !this.orbit) return;
      const scale = 0.005 * (this.orbit.distance / 40);
      this.orbit.yaw -= (event.clientX - this.drag[0]) * scale;
      this.orbit.pitch = Math.max(-1.45, Math.min(1.45, this.orbit.pitch + (event.clientY - this.drag[1]) * scale));
      this.drag = [event.clientX, event.clientY];
      this.usePacketCamera = false;
      this.render();
    });
    canvas.addEventListener('pointerup', () => { this.drag = null; });
    canvas.addEventListener('pointercancel', () => { this.drag = null; });
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      if (!this.orbit) return;
      this.orbit.distance = Math.max(this.orbit.radius * 0.2, Math.min(this.orbit.radius * 12, this.orbit.distance * Math.exp(event.deltaY * 0.001)));
      this.usePacketCamera = false;
      this.render();
    }, { passive: false });
  }

  async init() {
    if (this.device) return;
    if (!navigator.gpu) throw new Error('navigator.gpu is not available in this browser session');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    this.device = await adapter.requestDevice();
    this.adapterInfo = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } : {};
    this.device.lost.then((info) => this.onState({ state: 'error', message: 'WebGPU device lost: ' + info.message }));
    this.device.addEventListener('uncapturederror', (event) => this.onState({ state: 'error', message: 'WebGPU uncaptured error: ' + event.error.message }));

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
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 144 }
      }]
    });
    const sceneLayout = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 48 } }]
    });
    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [drawLayout, sceneLayout] });
    this.pipeline = await this.device.createRenderPipelineAsync({
      layout: pipelineLayout,
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
    this.sceneLayout = sceneLayout;
  }

  async load(packet) {
    if (packet.kind !== 'blur.render-packet') throw new Error('packet kind ' + packet.kind + ' is not blur.render-packet');
    if (packet.version !== 1) throw new Error('packet version ' + packet.version + ' is not supported');
    if (packet.camera.matrixConvention !== MATRIX_CONVENTION) throw new Error('packet camera matrix convention is not the documented v1 convention');
    this.packet = packet;
    await this.init();

    for (const mesh of packet.meshes) {
      if (mesh.storage !== 'inline-json') throw new Error('mesh ' + mesh.id + ' uses unsupported storage ' + mesh.storage);
      if (mesh.positions.length !== mesh.vertexCount * 3) throw new Error('mesh ' + mesh.id + ' position count mismatch');
      if (mesh.indices.length !== mesh.indexCount) throw new Error('mesh ' + mesh.id + ' index count mismatch');
      const vertexBuffer = this.device.createBuffer({
        size: Math.ceil(mesh.positions.length * 4 / 4) * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(vertexBuffer, 0, Float32Array.from(mesh.positions));
      const indexBuffer = this.device.createBuffer({
        size: Math.max(4, Math.ceil(mesh.indices.length * 4 / 4) * 4),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(indexBuffer, 0, Uint32Array.from(mesh.indices));
      this.buffers.push(vertexBuffer, indexBuffer);
      this.meshes.set(mesh.id, { vertexBuffer, indexBuffer, vertexCount: mesh.vertexCount, indexCount: mesh.indexCount });
    }

    const drawCount = packet.draws.length;
    this.uniformBuffer = this.device.createBuffer({
      size: drawCount * DRAW_UNIFORM_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.buffers.push(this.uniformBuffer);
    this.drawBindGroup = this.device.createBindGroup({
      layout: this.drawLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: 144 } }]
    });

    const light = packet.lights[0];
    const direction = light.direction;
    const sceneBytes = new Float32Array(12);
    sceneBytes.set([direction[0], direction[1], direction[2], 0], 0);
    sceneBytes.set([light.colour[0], light.colour[1], light.colour[2], light.colour[3] * light.intensity], 4);
    sceneBytes.set([0.16, 0, 0, 0], 8);
    this.sceneBuffer = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.sceneBuffer, 0, sceneBytes);
    this.buffers.push(this.sceneBuffer);
    this.sceneBindGroup = this.device.createBindGroup({
      layout: this.sceneLayout,
      entries: [{ binding: 0, resource: { buffer: this.sceneBuffer, offset: 0, size: 48 } }]
    });

    this.draws = packet.draws.map((draw) => ({ ...draw, mesh: this.meshes.get(draw.meshId) }));
    for (const draw of this.draws) {
      if (!draw.mesh) throw new Error('draw ' + draw.id + ' references unknown mesh ' + draw.meshId);
      if (draw.indexOffset + draw.indexCount > draw.mesh.indexCount) throw new Error('draw ' + draw.id + ' index range exceeds mesh');
      if (!Number.isInteger(draw.indexOffset) || !Number.isInteger(draw.indexCount) || draw.indexCount % 3) throw new Error('draw ' + draw.id + ' has an invalid index range');
    }

    const camera = packet.camera;
    const offset = [camera.position[0] - camera.target[0], camera.position[1] - camera.target[1], camera.position[2] - camera.target[2]];
    const distance = Math.hypot(...offset);
    const pitch = Math.asin(offset[1] / distance);
    const yaw = Math.atan2(offset[0], offset[2]);
    this.orbit = {
      target: camera.target.slice(),
      distance,
      yaw,
      pitch,
      radius: Math.max(1e-3, boundsOfDraws(packet.draws).radius)
    };
    this.cameraShape = {
      near: camera.near,
      far: camera.far,
      fovY: camera.verticalFovRadians,
      aspect: camera.aspect
    };
    this.depth = null;
    this.usePacketCamera = true;
    return this.render();
  }

  /** Debug camera that frames one mesh instead of the whole packet scene. */
  focusMesh(meshId) {
    if (!this.packet) throw new Error('no packet loaded');
    const subset = this.packet.draws.filter((draw) => draw.meshId === meshId);
    if (!subset.length) throw new Error('no draw uses mesh ' + meshId);
    const bounds = boundsOfDraws(subset);
    const mesh = this.packet.meshes.find((entry) => entry.id === meshId);
    // Fit in world space: a mesh may be object-local, so bake each distinct
    // draw world transform into a temporary vertex set for the camera fit only.
    const matrices = new Map();
    for (const draw of subset) matrices.set(draw.world.join(','), draw.world);
    const worldSets = [];
    for (const matrix of matrices.values()) {
      const out = new Float64Array(mesh.positions.length);
      for (let index = 0; index < mesh.positions.length; index += 3) {
        const x = mesh.positions[index], y = mesh.positions[index + 1], z = mesh.positions[index + 2];
        out[index] = x * matrix[0] + y * matrix[4] + z * matrix[8] + matrix[12];
        out[index + 1] = x * matrix[1] + y * matrix[5] + z * matrix[9] + matrix[13];
        out[index + 2] = x * matrix[2] + y * matrix[6] + z * matrix[10] + matrix[14];
      }
      worldSets.push(out);
    }
    this.orbit.target = bounds.center;
    this.orbit.radius = Math.max(1e-3, bounds.radius);
    this.orbit.distance = fitVertexDistance(worldSets, bounds.center, this.orbit.yaw, this.orbit.pitch, this.cameraShape.fovY, this.cameraShape.aspect, 1.18);
    this.usePacketCamera = false;
    this.focusMeshId = meshId;
    return this.render();
  }

  currentCamera() {
    if (this.usePacketCamera) {
      return { view: Float32Array.from(this.packet.camera.view), projection: Float32Array.from(this.packet.camera.projection) };
    }
    const view = orbitView(this.orbit.target, this.orbit.distance, this.orbit.yaw, this.orbit.pitch).view;
    const projection = perspective(this.cameraShape.fovY, this.cameraShape.aspect, this.cameraShape.near, this.cameraShape.far);
    return { view, projection };
  }

  writeUniforms(view, projection) {
    const viewProjection = multiply(projection, view);
    const bytes = new Float32Array(this.draws.length * (DRAW_UNIFORM_STRIDE / 4));
    for (let index = 0; index < this.draws.length; index++) {
      const draw = this.draws[index];
      const base = index * (DRAW_UNIFORM_STRIDE / 4);
      bytes.set(viewProjection, base);
      bytes.set(draw.world, base + 16);
      bytes.set([NEUTRAL_ALBEDO, NEUTRAL_ALBEDO, NEUTRAL_ALBEDO, 1], base + 32);
    }
    this.device.queue.writeBuffer(this.uniformBuffer, 0, bytes);
    return viewProjection;
  }

  render() {
    if (!this.device || !this.packet) return null;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height || !this.depth) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.depth?.destroy();
      this.depth = this.device.createTexture({ size: [width, height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    const { view, projection } = this.currentCamera();
    const viewProjection = this.writeUniforms(view, projection);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.043, g: 0.075, b: 0.106, a: 1 },
        loadOp: 'clear',
        storeOp: 'store'
      }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' }
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(1, this.sceneBindGroup);
    let activeMesh = null;
    for (let index = 0; index < this.draws.length; index++) {
      const draw = this.draws[index];
      if (activeMesh !== draw.meshId) {
        pass.setVertexBuffer(0, draw.mesh.vertexBuffer);
        pass.setIndexBuffer(draw.mesh.indexBuffer, 'uint32');
        activeMesh = draw.meshId;
      }
      pass.setBindGroup(0, this.drawBindGroup, [index * DRAW_UNIFORM_STRIDE]);
      pass.drawIndexed(draw.indexCount, 1, draw.indexOffset, 0, 0);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.frames++;
    this.onState({
      state: 'rendered',
      frames: this.frames,
      width,
      height,
      viewProjection: Array.from(viewProjection)
    });
    return { width, height };
  }
}

export { boundsOfDraws };
