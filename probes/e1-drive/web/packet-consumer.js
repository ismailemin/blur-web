// WebGPU consumer for render packet v1 / v1.1.
//
// COPIED FROM probes/render-packet/web/packet-consumer.js (committed at
// 5 November 2026). The E1 drive slice must not edit the committed probe, so the
// copy lives here. E1 drive-slice deltas, both additive:
//   * `syncTimeline()` accepts ticks appended after `load()`, because the drive
//     slice produces its timeline live instead of pre-building the sequence;
//   * a draw may carry `diagnosticColour` + `spins`, which set a debug albedo and
//     a local-angle spin marker. Materials are still not applied;
//   * a draw with `visible:false` is not submitted (the P31 packet keeps the
//     collision surface out of `draws` entirely, so this is a safety path);
//   * a mesh may carry `uv` (base64 float32 LE, 2 components, P45 UV0) and the
//     packet may carry `textures` (decoded static g_tAlbedo RGBA) + `texturePack`
//     (producer sampler metadata). A draw with `textureId` samples that texture
//     with its own UV; a draw without one keeps the diagnostic albedo. The
//     producer metadata declares the source data as raw mip0 `rgba8unorm`; this
//     consumer uploads it as `rgba8unorm-srgb` with a deterministic derived mip
//     chain, trilinear filtering and anisotropy 8 where supported. The sRGB
//     decision and its evidence are documented on TEXTURE_SAMPLER;
//   * a draw may set `uvFlipU` / `uvFlipV` (car packs). The car pack declares
//     `uvFlipU:true, uvFlipV:false`, i.e. it samples (1-u, v): the model U axis
//     runs opposite to the decoded image's reading direction on every readable
//     island, while V already matches the image's top-down rows. The UV values
//     are not modified; see geometry.carTextures.uvConvention;
//   * P63 ghost replay: `setGhostFrame(nodeMatrices)` re-draws the *already
//     uploaded* car mesh a second time with the ghost record's per-tick node
//     matrices and a translucent diagnostic tint. It adds draw calls and uniform
//     slots, never a buffer, a texture or a geometry upload, and it is outside the
//     packet timeline, so the packet hash, the physics and the player's matrices
//     are untouched.
// Everything else (pipeline, upload counting, interpolation, camera handling) is
// unchanged from the committed consumer.
//
// It only reads the packet contract: camera, lights, meshes, draws, and (for
// v1.1) nodes + updates. It never reaches into a reader or an engine.
//
// Static geometry is uploaded exactly once. A frame only writes per-draw uniforms
// (view-projection, world, albedo) and resubmits draw calls, so the upload counter
// staying flat is a testable property rather than a hope.
//
// Materials are not applied, so every draw is shaded with a neutral albedo under
// the packet's directional light — a declared diagnostic fallback, not a guessed
// material colour. E1 drive-slice delta: a draw may carry `diagnosticColour` and
// `spins` (the car parts do). Those are debug colours, still with
// materialsApplied:false, and `spins` only enables a local-angle marker band so
// the wheel rotation is visible on rotationally symmetric tyre/rim/disc
// geometry. Neither is a game material or a texture sample. A draw may also carry
// `textureId`, which is the P44/P45/P47 static albedo texture measured for that
// draw: it is sampled with the mesh's real UV0 stream. It is still not the full
// game material (no material colour, blend state or shader stages); the consumer
// now adds the proven sRGB decode and a derived mip chain (see TEXTURE_SAMPLER).
// A car draw additionally carries `uvFlipU` / `uvFlipV`, the declared per-axis
// sampling direction (the P52 car pack uses u' = 1-u, v' = v).

import { interpolateRigid, isRigid, matrixChecksum } from './interpolate.js';

const SHADER = /* wgsl */ `
struct DrawUniforms {
  viewProjection: mat4x4f,
  world: mat4x4f,
  albedo: vec4f,
  texParams: vec4f,
};
struct Scene {
  lightDirection: vec4f,
  lightColour: vec4f,
  ambient: vec4f,
};
@group(0) @binding(0) var<uniform> draw: DrawUniforms;
@group(1) @binding(0) var<uniform> scene: Scene;
@group(2) @binding(0) var albedoSampler: sampler;
@group(2) @binding(1) var albedoTexture: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) local: vec3f,
  @location(2) uv: vec2f,
};

@vertex fn vertexMain(@location(0) position: vec3f, @location(1) uv: vec2f) -> VertexOut {
  var result: VertexOut;
  let worldPosition = draw.world * vec4f(position, 1.0);
  result.world = worldPosition.xyz;
  result.local = position;
  // texParams.y / texParams.z declare the per-draw U / V direction. The car pack
  // samples (1-u, v): the model U axis is opposite to the decoded image's reading
  // direction on the readable islands (plates, badges, emblems), while V already
  // matches the image's top-down rows (see geometry.carTextures.uvConvention).
  // Track and level draws keep the raw stream. UV values are never modified.
  result.uv = vec2f(
    select(uv.x, 1.0 - uv.x, draw.texParams.y > 0.5),
    select(uv.y, 1.0 - uv.y, draw.texParams.z > 0.5));
  result.position = draw.viewProjection * worldPosition;
  return result;
}

// Exact sRGB opto-electronic transfer function. The swap chain is non-sRGB, so
// linear radiance must be encoded here; sRGB is not pow(1/2.2).
fn linearToSrgb(value: vec3f) -> vec3f {
  let c = clamp(value, vec3f(0.0), vec3f(1.0));
  let low = c * 12.92;
  let high = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, c <= vec3f(0.0031308));
}

@fragment fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
  let raw = cross(dpdx(input.world), dpdy(input.world));
  let length = length(raw);
  let face = select(vec3f(0.0, 1.0, 0.0), raw / max(length, 1e-20), length > 0.0);
  let lambert = abs(dot(face, normalize(scene.lightDirection.xyz)));
  let brightness = scene.ambient.x + (1.0 - scene.ambient.x) * lambert;
  // texParams.x is 1 for a draw with a bound static g_tAlbedo texture and 0
  // otherwise. The sample is unconditional (a white 1x1 placeholder is bound for
  // untextured draws), so there is no non-uniform control flow around
  // textureSample; mix() then selects the diagnostic albedo. The sampled value is
  // the decoded albedo texel: the texture is rgba8unorm-srgb, so the hardware
  // decodes the stored sRGB texel to linear before filtering; the mip chain is
  // generated in linear light too. It is not multiplied by a material colour,
  // because none is recovered.
  let sampled = textureSample(albedoTexture, albedoSampler, input.uv).rgb;
  let base = mix(draw.albedo.rgb, sampled, draw.texParams.x);
  let radiance = scene.lightColour.rgb * scene.lightColour.a * base * brightness;
  // Diagnostic spin marker: a band fixed in element-local space. It is not a
  // material; it makes the wheel rotation visible on rotationally symmetric
  // geometry. draw.albedo.a is 0 for every non-spinning draw.
  let angle = atan2(input.local.z, input.local.y);
  let band = smoothstep(0.86, 0.98, cos(angle)) * draw.albedo.a;
  let marked = mix(radiance, vec3f(1.0, 0.94, 0.72), band * 0.72);
  // The swap chain is non-sRGB and the lighting above is linear, so this is the
  // exact sRGB OETF (not a pow(1/2.2) approximation, which is not its inverse).
  return vec4f(linearToSrgb(marked), 1.0);
}
`;

const NEUTRAL_ALBEDO = 0.8;
const DRAW_UNIFORM_STRIDE = 256; // minUniformBufferOffsetAlignment default
const DRAW_UNIFORM_BYTES = 160; // mat4 + mat4 + albedo vec4 + texParams vec4
const SUPPORTED_VERSIONS = [1, 1.1];

// Ghost replay (P63): the same car mesh, per-tick ghost node matrices and a
// labelled translucent diagnostic tint. It samples no texture (texParams is 0),
// writes no depth and never contributes to the packet. The tint is presentation
// only: it is not a material colour and no material is recovered.
const GHOST_SHADER = /* wgsl */ `
struct DrawUniforms {
  viewProjection: mat4x4f,
  world: mat4x4f,
  albedo: vec4f,
  texParams: vec4f,
};
struct Scene {
  lightDirection: vec4f,
  lightColour: vec4f,
  ambient: vec4f,
};
@group(0) @binding(0) var<uniform> draw: DrawUniforms;
@group(1) @binding(0) var<uniform> scene: Scene;
@group(2) @binding(0) var albedoSampler: sampler;
@group(2) @binding(1) var albedoTexture: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) local: vec3f,
};

@vertex fn vertexMain(@location(0) position: vec3f, @location(1) uv: vec2f) -> VertexOut {
  var result: VertexOut;
  let worldPosition = draw.world * vec4f(position, 1.0);
  result.world = worldPosition.xyz;
  result.local = position;
  result.position = draw.viewProjection * worldPosition;
  return result;
}

fn linearToSrgb(value: vec3f) -> vec3f {
  let c = clamp(value, vec3f(0.0), vec3f(1.0));
  let low = c * 12.92;
  let high = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, c <= vec3f(0.0031308));
}

@fragment fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
  let raw = cross(dpdx(input.world), dpdy(input.world));
  let length = length(raw);
  let face = select(vec3f(0.0, 1.0, 0.0), raw / max(length, 1e-20), length > 0.0);
  let lambert = abs(dot(face, normalize(scene.lightDirection.xyz)));
  let brightness = 0.55 + 0.45 * lambert;
  let tint = draw.albedo.rgb * brightness;
  // The same element-local spin band as the live car, so a ghost's wheels are
  // visibly rotating rather than four static discs.
  let angle = atan2(input.local.z, input.local.y);
  let band = smoothstep(0.86, 0.98, cos(angle)) * draw.albedo.a;
  let marked = mix(tint, vec3f(0.92, 0.99, 1.0), band * 0.55);
  return vec4f(linearToSrgb(marked), 0.34);
}
`;

/** Diagnostic ghost tint (linear-ish RGB; the consumer applies its own gamma). */
export const GHOST_TINT = Object.freeze([0.10, 0.62, 0.92]);
export const GHOST_ALPHA = 0.34;

/**
 * The PoC sampling policy, now split into what the source data *is* and what the
 * consumer does with it on the GPU.
 *
 * Source data (unchanged, produced by `build_geometry.mjs`):
 *   `packet.textures[]` carries the committed BC1/BC2 decode of the stored
 *   mip0 texel values; `packet.texturePack.sampler` records that the producer
 *   declares repeat + linear + mip0 + `rgba8unorm` and does not recover the
 *   engine sampler. That is still true of the data.
 *
 * Consumer policy (this file):
 *   * `rgba8unorm-srgb`: the stored texels are sRGB-encoded. Proof: the committed
 *     `SamplerState version1` records for the 16 car resource-block albedos are
 *     `[0,0,0,1,1,1,0,0,0,1]` (address U/V/W = WRAP, mag/min/mip = LINEAR,
 *     maxAnisotropy 0, maxMipLevel 0, lodBias 0, **sRGB = 1**) in
 *     `_work/car-materials/roster/cars/<slug>/materials.json`; the same
 *     `SamplerState version1` for the level scene shared texture
 *     `trafficcylinder_diff` is `sRGB=1` (`docs/plan/material-binding.md` line 34);
 *     and the committed asset-reader viewer already uploads decoded textures as
 *     `rgba8unorm-srgb` (`probes/asset-reader/web/mesh-viewer.js`). The
 *     per-source sampler records for the 136 track and 4 level sources are not
 *     in the committed P47/P73a manifests, so that pack is covered by the same
 *     serialized sampler class, not by a per-source row; the record says so.
 *   * full deterministic mip chain derived from mip0 (the source descriptors
 *     record 3-10 levels; a 16x16 source has 5). The kernel is a 2x2 box filter
 *     in linear light (sRGB decode -> average -> sRGB encode, odd edges clamp the
 *     last tap), so the derived levels match the sRGB filtering the hardware
 *     would do. No source detail is invented or upscaled.
 *   * trilinear minification: `mipmapFilter: 'linear'` (retail mipFilter = LINEAR).
 *   * `maxAnisotropy` 8 where the adapter supports it. This is a rendering-quality
 *     choice for this PoC: the recovered sampler record declares maxAnisotropy 0,
 *     so the value is reported as applied, not as retail state.
 */
export const TEXTURE_SAMPLER = Object.freeze({
  addressModeU: 'repeat',
  addressModeV: 'repeat',
  magFilter: 'linear',
  minFilter: 'linear',
  mipmapFilter: 'linear',
  maxAnisotropy: 8,
  mipLevels: 'full-chain-derived-from-mip0',
  format: 'rgba8unorm-srgb',
  colourSpace: 'srgb-decoded-to-linear',
  sourceFormat: 'rgba8unorm (raw-decoded-texel source data)',
  mipKernel: '2x2 box in linear light, odd edges clamp'
});

/** sRGB EOTF table (byte -> linear light). */
const SRGB_TO_LINEAR = new Float32Array(256);
for (let code = 0; code < 256; code++) {
  const value = code / 255;
  SRGB_TO_LINEAR[code] = value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** Linear light -> sRGB byte (the inverse of the table above). */
function linearToSrgbByte(value) {
  if (!(value > 0)) return 0;
  if (value >= 1) return 255;
  const encoded = value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  const rounded = Math.round(encoded * 255);
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

function fnv1a32(hash, bytes) {
  for (let index = 0; index < bytes.length; index++) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Derive the full mip chain from one RGBA8 mip0 image.
 *
 * Deterministic: no randomness, no wall clock, no GPU readback. Each level is a
 * 2x2 box in linear light for RGB (sRGB decode -> average -> sRGB encode) and a
 * straight byte average for alpha. When a source dimension is odd the last
 * destination texel samples the last source texel twice (clamped edge), exactly
 * the documented kernel. Returns every level (level 0 is the original bytes) and
 * a FNV-1a 32 of the derived levels for the evidence hash.
 */
export function buildMipChain(rgba, width, height) {
  if (!(rgba instanceof Uint8Array) || rgba.length !== width * height * 4) {
    throw new Error('mip chain needs an RGBA8 mip0 of the declared size');
  }
  const levels = [{ width, height, bytes: rgba }];
  let current = rgba;
  let currentWidth = width;
  let currentHeight = height;
  while (currentWidth > 1 || currentHeight > 1) {
    const nextWidth = Math.max(1, currentWidth >> 1);
    const nextHeight = Math.max(1, currentHeight >> 1);
    const next = new Uint8Array(nextWidth * nextHeight * 4);
    for (let y = 0; y < nextHeight; y++) {
      const y0 = Math.min(currentHeight - 1, y * 2);
      const y1 = Math.min(currentHeight - 1, y * 2 + 1);
      for (let x = 0; x < nextWidth; x++) {
        const x0 = Math.min(currentWidth - 1, x * 2);
        const x1 = Math.min(currentWidth - 1, x * 2 + 1);
        const taps = [
          (y0 * currentWidth + x0) * 4,
          (y0 * currentWidth + x1) * 4,
          (y1 * currentWidth + x0) * 4,
          (y1 * currentWidth + x1) * 4
        ];
        const out = (y * nextWidth + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          const linear = (SRGB_TO_LINEAR[current[taps[0] + channel]] +
            SRGB_TO_LINEAR[current[taps[1] + channel]] +
            SRGB_TO_LINEAR[current[taps[2] + channel]] +
            SRGB_TO_LINEAR[current[taps[3] + channel]]) / 4;
          next[out + channel] = linearToSrgbByte(linear);
        }
        next[out + 3] = Math.round(
          (current[taps[0] + 3] + current[taps[1] + 3] + current[taps[2] + 3] + current[taps[3] + 3]) / 4);
      }
    }
    levels.push({ width: nextWidth, height: nextHeight, bytes: next });
    current = next;
    currentWidth = nextWidth;
    currentHeight = nextHeight;
  }
  let hash = 0x811c9dc5;
  let derivedBytes = 0;
  for (let level = 1; level < levels.length; level++) {
    hash = fnv1a32(hash, levels[level].bytes);
    derivedBytes += levels[level].bytes.length;
  }
  return { levels, derivedBytes, hash: '0x' + hash.toString(16).padStart(8, '0') };
}

const PLACEHOLDER_TEXTURE_ID = '__untextured__';

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

/** Column-major translate * uniform-scale matrix for a diagnostic marker. */
function markerMatrix(position, scale) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return new Float32Array([
    s, 0, 0, 0,
    0, s, 0, 0,
    0, 0, s, 0,
    position[0], position[1], position[2], 1
  ]);
}

const shortestAngle = (delta) => {
  let value = delta;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
};

export class PacketConsumer {
  constructor(canvas, onState) {
    this.canvas = canvas;
    this.onState = onState ?? (() => {});
    this.draws = [];
    this.meshes = new Map();
    this.buffers = [];
    this.textures = [];
    this.textureGroups = new Map();
    this.device = null;
    this.orbit = null;
    this.usePacketCamera = true;
    this.focusMeshId = null;
    this.drag = null;
    this.updates = null;
    this.updateMaps = null;
    this.drawMovers = null;
    this.lastTick = 0;
    // Ghost replay (P63): a second draw set over the uploaded car mesh. The
    // matrices are supplied per frame by the page; the consumer never simulates.
    this.ghostDraws = [];
    this.ghostMatrices = null;
    this.ghostEnabled = false;
    // Multi-slot remote rendering (M4): the ghost pipeline can draw N cars
    // (one human peer + 0-3 AI). Each slot reuses the same car mesh and reserves
    // its own per-draw uniforms; `ghostSlotCount` defaults to 1 so the
    // single-player ghost and the M1 two-player page are unchanged.
    this.ghostSlotCount = 1;
    this.ghostDrawsPerCar = 0;
    this.ghostFrames = [];
    // Chunked remote cars (M1.1): one uploaded body per distinct peer car. The
    // ghost pipeline draws the peer's own mesh/draw set; textures are not sampled
    // by that diagnostic pass, so only vertex/index/UV buffers are created.
    this.remoteCars = new Map();
    // Power-up diagnostics (M2/PWR2): a small marker mesh injected by the page,
    // drawn in a separate translucent pass. Presentation only; never in updates,
    // the packet hash or the physics.
    this.powerupDraws = [];
    this.powerupRingDraws = [];
    this.powerupMarkers = null;
    this.powerupRingMarkers = null;
    this.powerupEnabled = false;
    this.powerupSlotCount = 0;
    this.stats = {
      renders: 0,
      geometryUploads: 0,
      geometryUploadBytes: 0,
      uniformWrites: 0,
      uniformBytes: 0,
      drawsIssued: 0,
      // Ghost instrumentation: draw slots per packet, draws issued and frames
      // where the ghost was visible. Ghost draws reuse the same buffers, so
      // `geometryUploads` stays flat when the ghost is toggled.
      ghostDraws: 0,
      ghostDrawsIssued: 0,
      ghostFrames: 0,
      ghostEnabled: false,
      ghostSlotCount: 1,
      ghostActiveSlots: 0,
      ghostLocalDraws: 0,
      ghostDrawBand: 0,
      remoteCars: 0,
      remoteCarDraws: 0,
      // Power-up diagnostic marker pass (separate from packet draws).
      powerupSlots: 0,
      powerupMarkerSlots: 0,
      powerupRingSlots: 0,
      powerupDrawsIssued: 0,
      powerupRingDrawsIssued: 0,
      powerupFrames: 0,
      powerupEnabled: false,
      powerupDropped: 0,
      ticksExecuted: 0,
      alpha: 0,
      renderTick: 0,
      matrixChecksum: '0x00000000',
      tickHash: null,
      // E1 drive-slice soak delta: counts every GPU buffer this consumer owns
      // and destroys them when a new packet is loaded. A rebuild/restart otherwise
      // re-uploads geometry into fresh buffers and leaves the old ones alive; the
      // soak gate measures created - destroyed == live and that live does not grow.
      packetLoads: 0,
      buffersCreated: 0,
      buffersDestroyed: 0,
      // Texture instrumentation: one GPUTexture + bind group per static albedo
      // source, plus the 1x1 placeholder. Destroyed with the packet, so a soak
      // restart cannot grow GPU texture memory either.
      texturesCreated: 0,
      texturesDestroyed: 0,
      texturesUploaded: 0,
      // `textureUploadBytes` keeps its original meaning (mip0 RGBA bytes), so the
      // existing capture gates stay comparable; the derived mip chain is counted
      // separately and `textureTotalBytes` is what the GPU actually receives.
      textureUploadBytes: 0,
      textureMipLevels: 0,
      textureMipBytes: 0,
      textureTotalBytes: 0,
      mipChainHash: null,
      uvUploadBytes: 0,
      texturedDraws: 0
    };

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
      this.renderFrame({ cursor: this.stats.cursor ?? 0 });
    });
    canvas.addEventListener('pointerup', () => { this.drag = null; });
    canvas.addEventListener('pointercancel', () => { this.drag = null; });
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      if (!this.orbit) return;
      this.orbit.distance = Math.max(this.orbit.radius * 0.2, Math.min(this.orbit.radius * 12, this.orbit.distance * Math.exp(event.deltaY * 0.001)));
      this.usePacketCamera = false;
      this.renderFrame({ cursor: this.stats.cursor ?? 0 });
    }, { passive: false });
  }

  async init() {
    if (this.device) return;
    if (!navigator.gpu) throw new Error('navigator.gpu is not available in this browser session');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    this.device = await adapter.requestDevice();
    // Anisotropy is optional in WebGPU (default limit 1). The policy asks for 8
    // and the applied value is reported; a 1-limit device stays at 1.
    this.adapterAnisotropyLimit = adapter.limits?.maxSamplerAnisotropy ?? 1;
    const anisotropyLimit = this.device.limits?.maxSamplerAnisotropy ?? 1;
    this.deviceAnisotropyLimit = anisotropyLimit;
    this.maxAnisotropy = Math.max(1, Math.min(TEXTURE_SAMPLER.maxAnisotropy, anisotropyLimit));
    this.adapterInfo = adapter.info
      ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description }
      : {};
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
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: DRAW_UNIFORM_BYTES }
      }]
    });
    const sceneLayout = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 48 } }]
    });
    const textureLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }
      ]
    });
    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [drawLayout, sceneLayout, textureLayout]
    });
    this.pipeline = await this.device.createRenderPipelineAsync({
      layout: pipelineLayout,
      vertex: {
        module,
        entryPoint: 'vertexMain',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }] }
        ]
      },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' }
    });
    // Ghost pipeline (P63): same bind groups, vertex buffers and depth format as
    // the main pipeline, but a translucent tint, no depth write and no texture
    // sample. Drawing it after the opaque draws keeps the track/props in front of
    // it (depthCompare less) without a sort.
    const ghostModule = this.device.createShaderModule({ code: GHOST_SHADER });
    const ghostInfo = await ghostModule.getCompilationInfo();
    const ghostErrors = ghostInfo.messages.filter((message) => message.type === 'error');
    if (ghostErrors.length) throw new Error('ghost shader: ' + ghostErrors.map((message) => message.message).join('; '));
    this.ghostPipeline = await this.device.createRenderPipelineAsync({
      layout: pipelineLayout,
      vertex: {
        module: ghostModule,
        entryPoint: 'vertexMain',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }] }
        ]
      },
      fragment: {
        module: ghostModule,
        entryPoint: 'fragmentMain',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
          }
        }]
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' }
    });
    this.drawLayout = drawLayout;
    this.sceneLayout = sceneLayout;
    this.textureLayout = textureLayout;

    // The sampler is the consumer policy documented on TEXTURE_SAMPLER:
    // repeat/linear/trilinear with anisotropy 8 where the adapter allows it. The
    // 1x1 white placeholder is bound for every draw without a static albedo
    // texture, so the fragment shader can sample unconditionally and select with
    // mix(). It uses the same sRGB format as the real textures.
    const samplerDescriptor = {
      addressModeU: TEXTURE_SAMPLER.addressModeU,
      addressModeV: TEXTURE_SAMPLER.addressModeV,
      magFilter: TEXTURE_SAMPLER.magFilter,
      minFilter: TEXTURE_SAMPLER.minFilter,
      mipmapFilter: TEXTURE_SAMPLER.mipmapFilter
    };
    if (this.maxAnisotropy > 1) samplerDescriptor.maxAnisotropy = this.maxAnisotropy;
    this.sampler = this.device.createSampler(samplerDescriptor);
    this.placeholderTexture = this.device.createTexture({
      size: [1, 1, 1],
      format: TEXTURE_SAMPLER.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    this.device.queue.writeTexture(
      { texture: this.placeholderTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1, 1]
    );
    this.placeholderGroup = this.device.createBindGroup({
      layout: this.textureLayout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.placeholderTexture.createView() }
      ]
    });
  }

  /**
   * Release the GPU buffers owned by the previous packet (soak instrumentation).
   * Called at the start of every `load`; the first load is a no-op. Destroying a
   * buffer still referenced by an already-submitted command is legal in WebGPU,
   * and the soak restarts `load` from an animation frame, so the queue has
   * completed the prior frame.
   */
  releaseGeometry() {
    for (const buffer of this.buffers) {
      try { buffer.destroy(); } catch { /* already lost: not a leak */ }
      this.stats.buffersDestroyed++;
    }
    this.buffers = [];
    for (const texture of this.textures) {
      try { texture.destroy(); } catch { /* already lost: not a leak */ }
      this.stats.texturesDestroyed++;
    }
    this.textures = [];
    this.textureGroups = new Map();
    this.meshes = new Map();
    this.meshBounds = null;
    this.draws = [];
    this.visibleDraws = [];
    this.uniformBuffer = null;
    this.sceneBuffer = null;
    this.drawBindGroup = null;
    this.sceneBindGroup = null;
    this.timeline = null;
    this.updateMaps = null;
    this.drawMovers = null;
    this.ghostDraws = [];
    this.ghostMatrices = null;
    this.ghostEnabled = false;
    this.ghostSlotCount = 1;
    this.ghostDrawsPerCar = 0;
    this.ghostFrames = [];
    this.remoteCars = new Map();
    this.stats.ghostDraws = 0;
    this.stats.ghostEnabled = false;
    this.stats.ghostSlotCount = 1;
    this.stats.ghostActiveSlots = 0;
    this.stats.remoteCars = 0;
    this.stats.remoteCarDraws = 0;
    this.powerupDraws = [];
    this.powerupRingDraws = [];
    this.powerupMarkers = null;
    this.powerupRingMarkers = null;
    this.powerupEnabled = false;
    this.powerupSlotCount = 0;
    this.stats.powerupSlots = 0;
    this.stats.powerupMarkerSlots = 0;
    this.stats.powerupRingSlots = 0;
    this.stats.powerupEnabled = false;
  }

  async load(packet) {
    if (packet.kind !== 'blur.render-packet') throw new Error('packet kind ' + packet.kind + ' is not blur.render-packet');
    if (!SUPPORTED_VERSIONS.includes(packet.version)) throw new Error('packet version ' + packet.version + ' is not supported');
    if (packet.camera.matrixConvention !== MATRIX_CONVENTION) throw new Error('packet camera matrix convention is not the documented v1 convention');
    this.packet = packet;
    await this.init();
    // E1 drive-slice soak delta: one page can rebuild its timeline many times
    // (mode switches / restarts). Wait for queued work, then release the previous
    // packet's buffers so GPU memory is bounded by one packet, not by load count.
    if (this.device) await this.device.queue.onSubmittedWorkDone();
    this.releaseGeometry();
    this.stats.packetLoads++;

    for (const mesh of packet.meshes) {
      if (mesh.storage !== 'inline-json') throw new Error('mesh ' + mesh.id + ' uses unsupported storage ' + mesh.storage);
      if (mesh.positions.length !== mesh.vertexCount * 3) throw new Error('mesh ' + mesh.id + ' position count mismatch');
      if (mesh.indices.length !== mesh.indexCount) throw new Error('mesh ' + mesh.id + ' index count mismatch');
      const positions = Float32Array.from(mesh.positions);
      const indices = Uint32Array.from(mesh.indices);
      const vertexBuffer = this.device.createBuffer({
        size: Math.ceil(positions.byteLength / 4) * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(vertexBuffer, 0, positions);
      const indexBuffer = this.device.createBuffer({
        size: Math.max(4, Math.ceil(indices.byteLength / 4) * 4),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(indexBuffer, 0, indices);
      // UV0: the track mesh carries the real P45 stream (base64 float32 LE). Every
      // other mesh (level props, car body) has no TEXCOORD0 binding in this slice;
      // it gets an explicit zero buffer so the pipeline's second vertex buffer is
      // always valid, and the shader selects the diagnostic albedo anyway.
      let uvs;
      if (mesh.uv) {
        if (mesh.uv.storage !== 'base64-float32le' || mesh.uv.components !== 2 ||
            typeof mesh.uv.data !== 'string') {
          throw new Error('mesh ' + mesh.id + ' has an unsupported uv stream');
        }
        const binary = atob(mesh.uv.data);
        if (binary.length !== mesh.uv.bytes || binary.length !== mesh.vertexCount * 8) {
          throw new Error('mesh ' + mesh.id + ' uv byte length does not match its vertex count');
        }
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        uvs = new Float32Array(bytes.buffer);
      } else {
        uvs = new Float32Array(mesh.vertexCount * 2);
      }
      const uvBuffer = this.device.createBuffer({
        size: Math.max(16, Math.ceil(uvs.byteLength / 4) * 4),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(uvBuffer, 0, uvs);
      this.buffers.push(vertexBuffer, indexBuffer, uvBuffer);
      this.stats.buffersCreated += 3;
      this.stats.uvUploadBytes += uvs.byteLength;
      this.meshes.set(mesh.id, {
        vertexBuffer,
        indexBuffer,
        uvBuffer,
        vertexCount: mesh.vertexCount,
        indexCount: mesh.indexCount
      });
      // Mesh AABB, used only to frame the moving body for screenshot evidence.
      if (!this.meshBounds) this.meshBounds = new Map();
      const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (let index = 0; index < positions.length; index += 3) {
        for (let axis = 0; axis < 3; axis++) {
          bounds.min[axis] = Math.min(bounds.min[axis], positions[index + axis]);
          bounds.max[axis] = Math.max(bounds.max[axis], positions[index + axis]);
        }
      }
      this.meshBounds.set(mesh.id, bounds);
      // Counted separately from per-frame work: this must never grow at runtime.
      this.stats.geometryUploads++;
      this.stats.geometryUploadBytes += positions.byteLength + indices.byteLength + uvs.byteLength;
    }

    // Static albedo textures: one rgba8unorm-srgb texture per P34/P47 source,
    // with a deterministic full mip chain derived from the committed BC1 decode.
    // The producer still declares the source data as raw mip0 (geometry v6
    // `texturePack.sampler`); this is the consumer's GPU sampling policy, with the
    // sRGB decision and its evidence documented on TEXTURE_SAMPLER.
    const textureRecords = Array.isArray(packet.textures) ? packet.textures : [];
    if (textureRecords.length === 0) {
      throw new Error('packet carries no static albedo textures; rebuild geometry with build_geometry.mjs');
    }
    let loadBaseBytes = 0;
    let loadMipLevels = 0;
    let loadMipBytes = 0;
    let loadMipBuildMs = 0;
    let aggregateHash = 0x811c9dc5;
    for (const record of textureRecords) {
      if (record.width <= 0 || record.height <= 0 || typeof record.rgbaBase64 !== 'string') {
        throw new Error('texture ' + record.id + ' has no usable RGBA payload');
      }
      const binary = atob(record.rgbaBase64);
      if (binary.length !== record.rgbaBytes || binary.length !== record.width * record.height * 4) {
        throw new Error('texture ' + record.id + ' RGBA byte length does not match its size');
      }
      const rgba = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) rgba[index] = binary.charCodeAt(index);
      const mipStart = globalThis.performance?.now?.() ?? 0;
      const chain = buildMipChain(rgba, record.width, record.height);
      loadMipBuildMs += (globalThis.performance?.now?.() ?? 0) - mipStart;
      const texture = this.device.createTexture({
        size: [record.width, record.height, 1],
        format: TEXTURE_SAMPLER.format,
        mipLevelCount: chain.levels.length,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      for (let level = 0; level < chain.levels.length; level++) {
        const image = chain.levels[level];
        this.device.queue.writeTexture(
          { texture, mipLevel: level },
          image.bytes,
          { bytesPerRow: image.width * 4, rowsPerImage: image.height },
          [image.width, image.height, 1]
        );
      }
      this.textures.push(texture);
      this.stats.texturesCreated++;
      this.textureGroups.set(record.id, this.device.createBindGroup({
        layout: this.textureLayout,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: texture.createView() }
        ]
      }));
      this.stats.texturesUploaded++;
      this.stats.textureUploadBytes += rgba.length;
      loadBaseBytes += rgba.length;
      loadMipLevels += chain.levels.length;
      loadMipBytes += chain.derivedBytes;
      this.stats.textureMipLevels += chain.levels.length;
      this.stats.textureMipBytes += chain.derivedBytes;
      this.stats.textureTotalBytes += rgba.length + chain.derivedBytes;
      // Aggregate over `id` + the derived-level hash, so a changed kernel or a
      // reordered pack changes the evidence hash instead of hiding in a total.
      for (let index = 0; index < record.id.length; index++) {
        aggregateHash = fnv1a32(aggregateHash, [record.id.charCodeAt(index) & 255]);
      }
      for (let shift = 24; shift >= 0; shift -= 8) {
        aggregateHash = fnv1a32(aggregateHash, [(parseInt(chain.hash.slice(2), 16) >>> shift) & 255]);
      }
    }
    this.stats.mipChainHash = '0x' + aggregateHash.toString(16).padStart(8, '0');
    const sampling = Object.freeze({
      ...TEXTURE_SAMPLER,
      textures: textureRecords.length,
      mipLevelsTotal: loadMipLevels,
      mipBytes: loadMipBytes,
      baseBytes: loadBaseBytes,
      totalBytes: loadBaseBytes + loadMipBytes,
      mipChainHash: this.stats.mipChainHash,
      mipBuildMs: +loadMipBuildMs.toFixed(2),
      anisotropyApplied: this.maxAnisotropy,
      adapterMaxSamplerAnisotropy: this.adapterAnisotropyLimit,
      deviceMaxSamplerAnisotropy: this.deviceAnisotropyLimit
    });
    this.textureSampling = sampling;
    this.stats.textureSampling = sampling;
    if (typeof globalThis !== 'undefined') globalThis.__e1TextureSampling = sampling;

    // Ghost draw slots (P63): one ghost copy per visible draw of the selected
    // car's body mesh. Slots are reserved in the existing uniform buffer, so the
    // buffer count is unchanged (the soak gate stays at 11) and enabling the ghost
    // uploads nothing.
    const carBodyMeshId = packet.diagnostics?.extras?.drive?.car?.bodyMesh ?? null;
    const localGhostDraws = carBodyMeshId
      ? packet.draws.filter((draw) => draw.meshId === carBodyMeshId && draw.visible !== false).length
      : 0;
    // M1.1: a peer car has its own draw count. The page declares the band size
    // (`extras.remotes.drawSlots` = the roster maximum); without it the band is
    // exactly the local car, which keeps the single-player/ghost path unchanged.
    const remoteConfigEarly = packet.diagnostics?.extras?.remotes ?? null;
    const declaredDrawSlots = remoteConfigEarly && Number.isInteger(remoteConfigEarly.drawSlots) &&
      remoteConfigEarly.drawSlots > 0 ? remoteConfigEarly.drawSlots : 0;
    const ghostDrawCount = Math.max(localGhostDraws, declaredDrawSlots);
    const drawCount = packet.draws.length;
    // Multi-slot remotes: the page declares the number of remote car slots it
    // will draw through the ghost pipeline (one human peer + 0-3 AI). The
    // default is one slot, which is the P63/M1 path.
    const remoteConfig = packet.diagnostics?.extras?.remotes ?? null;
    const ghostSlotCount = remoteConfig && Number.isInteger(remoteConfig.slots) && remoteConfig.slots > 0
      ? Math.min(8, remoteConfig.slots) : 1;
    this.ghostSlotCount = ghostSlotCount;
    this.ghostDrawsPerCar = ghostDrawCount;
    this.ghostFrames = [];
    this.stats.ghostSlotCount = ghostSlotCount;
    this.stats.ghostLocalDraws = localGhostDraws;
    this.stats.ghostDrawBand = ghostDrawCount;
    // Power-up diagnostic marker slots: injected mesh + a fixed number of
    // translucent draw slots. They are not packet draws and never enter the
    // packet hash or the physics. `?powerups=0` (the default) leaves this at 0.
    const powerupConfig = packet.diagnostics?.extras?.powerups ?? null;
    const powerupSlots = powerupConfig && Number.isInteger(powerupConfig.slots) && powerupConfig.slots > 0
      ? powerupConfig.slots : 0;
    const powerupRingSlots = powerupConfig && Number.isInteger(powerupConfig.ringSlots) &&
      powerupConfig.ringSlots > 0 ? powerupConfig.ringSlots : 0;
    this.ghostDraws = [];
    this.stats.ghostDraws = ghostDrawCount;
    this.uniformBuffer = this.device.createBuffer({
      size: (drawCount + ghostDrawCount * ghostSlotCount + powerupSlots + powerupRingSlots) * DRAW_UNIFORM_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.buffers.push(this.uniformBuffer);
    this.stats.buffersCreated++;
    this.drawBindGroup = this.device.createBindGroup({
      layout: this.drawLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: DRAW_UNIFORM_BYTES } }]
    });

    const light = packet.lights[0];
    const direction = light.direction;
    const sceneBytes = new Float32Array(12);
    sceneBytes.set([direction[0], direction[1], direction[2], 0], 0);
    sceneBytes.set([light.colour[0], light.colour[1], light.colour[2], light.colour[3] * light.intensity], 4);
    sceneBytes.set([0.16, 0, 0, 0], 8);
    this.sceneBuffer = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.sceneBuffer, 0, sceneBytes);
    // A map may have supplied its committed retail ambient before the scene
    // buffer existed; apply it now.
    if (Number.isFinite(this.pendingAmbient)) {
      this.device.queue.writeBuffer(this.sceneBuffer, 32,
        new Float32Array([this.pendingAmbient, 0, 0, 0]));
      this.stats.ambient = this.pendingAmbient;
      this.stats.ambientSource = 'retail-upNormalAmbientScaled-luminance';
    }
    this.buffers.push(this.sceneBuffer);
    this.stats.buffersCreated++;
    this.sceneBindGroup = this.device.createBindGroup({
      layout: this.sceneLayout,
      entries: [{ binding: 0, resource: { buffer: this.sceneBuffer, offset: 0, size: 48 } }]
    });

    this.draws = packet.draws.map((draw) => ({ ...draw, mesh: this.meshes.get(draw.meshId) }));
    for (const draw of this.draws) {
      if (!draw.mesh) throw new Error('draw ' + draw.id + ' references unknown mesh ' + draw.meshId);
      if (!Number.isInteger(draw.indexOffset) || !Number.isInteger(draw.indexCount) || draw.indexCount % 3) throw new Error('draw ' + draw.id + ' has an invalid index range');
      if (draw.indexOffset + draw.indexCount > draw.mesh.indexCount) throw new Error('draw ' + draw.id + ' index range exceeds mesh');
      if (!isRigid(draw.world)) throw new Error('draw ' + draw.id + ' world matrix is not rigid');
      if (draw.textureId != null && !this.textureGroups.has(draw.textureId)) {
        throw new Error('draw ' + draw.id + ' names texture ' + draw.textureId + ' that the packet did not upload');
      }
    }
    this.stats.texturedDraws = this.draws.filter((draw) => draw.textureId != null).length;
    // Power-up marker draw slots (PWR2): one synthetic draw over the injected
    // octahedron mesh. Nothing is in packet.draws, so the packet's own draw
    // count/hash/camera framing are unchanged.
    this.powerupDraws = [];
    this.powerupRingDraws = [];
    this.powerupMarkers = null;
    this.powerupRingMarkers = null;
    this.powerupEnabled = false;
    this.powerupSlotCount = powerupSlots + powerupRingSlots;
    this.stats.powerupSlots = powerupSlots + powerupRingSlots;
    this.stats.powerupMarkerSlots = powerupSlots;
    this.stats.powerupRingSlots = powerupRingSlots;
    this.stats.powerupDrawsIssued = 0;
    this.stats.powerupRingDrawsIssued = 0;
    this.stats.powerupFrames = 0;
    this.stats.powerupEnabled = false;
    if (powerupSlots > 0) {
      const markerMesh = this.meshes.get(powerupConfig.markerMeshId);
      if (!markerMesh) throw new Error('power-up marker mesh ' + powerupConfig.markerMeshId + ' was not uploaded');
      const indexOffset = Number.isInteger(powerupConfig.indexOffset) ? powerupConfig.indexOffset : 0;
      const indexCount = Number.isInteger(powerupConfig.indexCount) ? powerupConfig.indexCount : markerMesh.indexCount;
      if (indexOffset < 0 || indexCount <= 0 || indexCount % 3 || indexOffset + indexCount > markerMesh.indexCount) {
        throw new Error('power-up marker index range is invalid');
      }
      for (let index = 0; index < powerupSlots; index++) {
        this.powerupDraws.push({
          id: 'powerup.marker.' + index,
          meshId: powerupConfig.markerMeshId,
          mesh: markerMesh,
          indexOffset,
          indexCount
        });
      }
    }
    if (powerupRingSlots > 0) {
      const ringMesh = this.meshes.get(powerupConfig.ringMeshId);
      if (!ringMesh) throw new Error('power-up ring mesh ' + powerupConfig.ringMeshId + ' was not uploaded');
      const ringIndexOffset = Number.isInteger(powerupConfig.ringIndexOffset) ? powerupConfig.ringIndexOffset : 0;
      const ringIndexCount = Number.isInteger(powerupConfig.ringIndexCount)
        ? powerupConfig.ringIndexCount : ringMesh.indexCount;
      if (ringIndexOffset < 0 || ringIndexCount <= 0 || ringIndexCount % 3 ||
          ringIndexOffset + ringIndexCount > ringMesh.indexCount) {
        throw new Error('power-up ring index range is invalid');
      }
      for (let index = 0; index < powerupRingSlots; index++) {
        this.powerupRingDraws.push({
          id: 'powerup.ring.' + index,
          meshId: powerupConfig.ringMeshId,
          mesh: ringMesh,
          indexOffset: ringIndexOffset,
          indexCount: ringIndexCount
        });
      }
    }
    // Ghost draw list: the same mesh, index ranges, textures and node ids as the
    // live car. Nothing is uploaded; only the per-frame node matrix differs.
    if (ghostDrawCount > 0) {
      this.ghostDraws = this.draws.filter((draw) => draw.meshId === carBodyMeshId && draw.visible !== false);
      if (this.ghostDraws.length !== localGhostDraws) {
        throw new Error('ghost draw slots ' + localGhostDraws + ' but ' + this.ghostDraws.length + ' car draws');
      }
      if (this.ghostDraws.length > ghostDrawCount) {
        throw new Error('ghost draw band ' + ghostDrawCount + ' is smaller than the local car (' +
          this.ghostDraws.length + ')');
      }
      for (const draw of this.ghostDraws) {
        if (!draw.nodeId) throw new Error('ghost draw ' + draw.id + ' has no node id');
      }
    }
    // E1 drive-slice delta: a draw may be explicitly hidden (`visible:false`).
    // The hidden physics collision surface is not a draw in this packet, but the
    // flag keeps the contract honest if a producer carries it here.
    this.visibleDraws = this.draws.filter((draw) => draw.visible !== false);

    this.timeline = null;
    if (packet.version === 1.1) {
      const updates = packet.updates;
      if (!Array.isArray(updates) || updates.length < 2) throw new Error('version 1.1 requires at least two ticks');
      const nodeByDraw = new Map();
      for (const node of packet.nodes) for (const drawId of node.drawIds) nodeByDraw.set(drawId, node.id);
      this.updateMaps = updates.map((update) => {
        const map = new Map();
        for (const entry of update.matrices) {
          const key = entry.nodeId ? 'node:' + entry.nodeId : 'draw:' + entry.drawId;
          if (!isRigid(entry.world)) throw new Error('tick ' + update.tick + ' matrix for ' + key + ' is not rigid');
          map.set(key, entry.world);
        }
        return map;
      });
      // Each draw resolves its transform through at most one key per tick.
      this.drawMovers = this.draws.map((draw) => {
        if (this.updateMaps[0].has('draw:' + draw.id)) return 'draw:' + draw.id;
        const nodeId = nodeByDraw.get(draw.id);
        if (nodeId && this.updateMaps[0].has('node:' + nodeId)) return 'node:' + nodeId;
        return null;
      });
      this.updates = updates;
      this.lastTick = updates[updates.length - 1].tick;
      this.timeline = {
        tickCount: updates.length,
        tickHz: packet.diagnostics?.sequence?.tickHz ?? null,
        motion: packet.diagnostics?.sequence?.motion ?? 'unstated',
        firstTick: updates[0].tick,
        lastTick: this.lastTick
      };
    }

    const camera = packet.camera;
    const offset = [camera.position[0] - camera.target[0], camera.position[1] - camera.target[1], camera.position[2] - camera.target[2]];
    const distance = Math.hypot(...offset);
    this.orbit = {
      target: camera.target.slice(),
      distance,
      yaw: Math.atan2(offset[0], offset[2]),
      pitch: Math.asin(offset[1] / distance),
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
    return this.renderFrame({ cursor: 0 });
  }

  /**
   * E1 drive-slice delta: accept ticks appended to `packet.updates` after load().
   *
   * The live page steps the engine once per fixed tick and pushes one `updates[]`
   * entry; this re-reads the tail of that array into the per-tick matrix maps and
   * moves the timeline end. It validates every appended matrix as rigid, exactly
   * like load() does, so a malformed tick still fails loudly. No geometry,
   * bind group or draw list is touched.
   */
  syncTimeline() {
    if (!this.timeline) return this.timeline;
    const updates = this.packet.updates;
    while (this.updateMaps.length < updates.length) {
      const index = this.updateMaps.length;
      const update = updates[index];
      if (index > 0 && !(update.tick > updates[index - 1].tick)) {
        throw new Error('appended tick ' + update.tick + ' does not increase');
      }
      const map = new Map();
      for (const entry of update.matrices) {
        const key = entry.nodeId ? 'node:' + entry.nodeId : 'draw:' + entry.drawId;
        if (!isRigid(entry.world)) throw new Error('tick ' + update.tick + ' matrix for ' + key + ' is not rigid');
        map.set(key, entry.world);
      }
      this.updateMaps.push(map);
    }
    this.updates = updates;
    this.lastTick = updates[updates.length - 1].tick;
    this.timeline.lastTick = this.lastTick;
    this.timeline.tickCount = updates.length;
    return this.timeline;
  }

  /**
   * Upload one peer car body for the remote/ghost pass (M1.1 chunking). The ghost
   * shader samples no texture, so only the mesh buffers and the body's own draw
   * list are needed. Calling it twice with the same key returns the existing
   * handle; two different peer cars stay resident together (one level + 1-2 cars).
   */
  ensureRemoteCar(key, body) {
    if (!this.device) throw new Error('cannot upload a remote car before the consumer is initialised');
    if (typeof key !== 'string' || !key) throw new Error('remote car needs a key');
    if (this.remoteCars.has(key)) return this.remoteCars.get(key);
    const mesh = body?.mesh;
    if (!mesh || typeof mesh.id !== 'string' || !Array.isArray(body.carDraws)) {
      throw new Error('remote car ' + key + ' has no mesh/carDraws');
    }
    let meshRecord = this.meshes.get(mesh.id);
    if (!meshRecord) {
      if (mesh.positions.length !== mesh.vertexCount * 3 || mesh.indices.length !== mesh.indexCount) {
        throw new Error('remote car ' + key + ' mesh counts do not match its arrays');
      }
      const positions = Float32Array.from(mesh.positions);
      const indices = Uint32Array.from(mesh.indices);
      const vertexBuffer = this.device.createBuffer({
        size: Math.ceil(positions.byteLength / 4) * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(vertexBuffer, 0, positions);
      const indexBuffer = this.device.createBuffer({
        size: Math.max(4, Math.ceil(indices.byteLength / 4) * 4),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(indexBuffer, 0, indices);
      let uvs;
      if (mesh.uv) {
        if (mesh.uv.storage !== 'base64-float32le' || mesh.uv.components !== 2 ||
            typeof mesh.uv.data !== 'string') {
          throw new Error('remote car ' + key + ' has an unsupported uv stream');
        }
        const binary = atob(mesh.uv.data);
        if (binary.length !== mesh.uv.bytes || binary.length !== mesh.vertexCount * 8) {
          throw new Error('remote car ' + key + ' uv byte length does not match its vertex count');
        }
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        uvs = new Float32Array(bytes.buffer);
      } else {
        uvs = new Float32Array(mesh.vertexCount * 2);
      }
      const uvBuffer = this.device.createBuffer({
        size: Math.max(16, Math.ceil(uvs.byteLength / 4) * 4),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
      });
      this.device.queue.writeBuffer(uvBuffer, 0, uvs);
      this.buffers.push(vertexBuffer, indexBuffer, uvBuffer);
      this.stats.buffersCreated += 3;
      this.stats.uvUploadBytes += uvs.byteLength;
      this.stats.geometryUploads++;
      this.stats.geometryUploadBytes += positions.byteLength + indices.byteLength + uvs.byteLength;
      meshRecord = {
        vertexBuffer,
        indexBuffer,
        uvBuffer,
        vertexCount: mesh.vertexCount,
        indexCount: mesh.indexCount
      };
      this.meshes.set(mesh.id, meshRecord);
    }
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const draws = body.carDraws.map((draw) => {
      if (!Number.isInteger(draw.indexOffset) || !Number.isInteger(draw.indexCount) ||
          draw.indexCount % 3 || draw.indexOffset < 0 ||
          draw.indexOffset + draw.indexCount > meshRecord.indexCount) {
        throw new Error('remote car ' + key + ' draw ' + draw.id + ' has an invalid index range');
      }
      if (typeof draw.nodeId !== 'string') throw new Error('remote car draw ' + draw.id + ' has no node id');
      return { ...draw, mesh: meshRecord, world: identity.slice(), worldKind: 'packet-transform' };
    });
    const handle = {
      key,
      slug: body.slug ?? key,
      meshId: mesh.id,
      mesh: meshRecord,
      draws,
      drawCount: draws.length
    };
    this.remoteCars.set(key, handle);
    this.stats.remoteCars = this.remoteCars.size;
    this.stats.remoteCarDraws = draws.length;
    return handle;
  }

  /**
   * Ghost replay (P63): supply the ghost's node matrices for the next frame.
   *
   * `nodeMatrices` is a Map of nodeId -> column-major 16-float world matrix (the
   * same nine node ids the packet's car nodes use), or null to hide the ghost.
   * The consumer only re-draws geometry it already uploaded for this packet, so
   * a ghost frame costs draw calls and uniform bytes but never a buffer, a
   * texture or a geometry upload. The ghost is not part of `updates[]`, the
   * packet hash, the physics or the player's matrices.
   */
  setGhostFrame(nodeMatrices) {
    if (!nodeMatrices) {
      this.ghostMatrices = null;
      this.ghostEnabled = false;
      this.ghostFrames = [];
      this.stats.ghostEnabled = false;
      this.stats.ghostActiveSlots = 0;
      return;
    }
    if (!(nodeMatrices instanceof Map)) throw new Error('ghost frame needs a Map of node matrices');
    for (const [nodeId, world] of nodeMatrices) {
      if (!isRigid(world)) throw new Error('ghost matrix for ' + nodeId + ' is not rigid');
    }
    this.ghostMatrices = nodeMatrices;
    this.ghostEnabled = true;
    this.ghostFrames = [{ nodeMatrices, tint: null }];
    this.stats.ghostEnabled = true;
    this.stats.ghostActiveSlots = 1;
  }

  /**
   * N-slot remote rendering (M4): supply one frame per remote car, in slot
   * order. Each frame is `{ nodeMatrices, tint }` (tint is an optional
   * presentation colour), or null to leave that slot hidden. Slots are reserved
   * from `packet.diagnostics.extras.remotes.slots`; a page without that field
   * keeps the single P63 slot.
   */
  setGhostFrames(frames) {
    if (!Array.isArray(frames)) throw new Error('ghost frames need an array');
    const slots = [];
    let active = 0;
    for (let index = 0; index < this.ghostSlotCount; index++) {
      const frame = frames[index] ?? null;
      if (!frame) { slots.push(null); continue; }
      const nodeMatrices = frame.nodeMatrices ?? frame;
      if (!(nodeMatrices instanceof Map)) throw new Error('ghost slot ' + index + ' needs a Map of node matrices');
      for (const [nodeId, world] of nodeMatrices) {
        if (!isRigid(world)) throw new Error('ghost matrix for ' + nodeId + ' is not rigid');
      }
      const remoteCar = frame.car ?? null;
      if (remoteCar) {
        if (!this.remoteCars.has(remoteCar.key)) {
          throw new Error('ghost slot ' + index + ' names an unloaded remote car ' + remoteCar.key);
        }
        if (remoteCar.drawCount > this.ghostDrawsPerCar) {
          throw new Error('ghost slot ' + index + ' remote car ' + remoteCar.key + ' has ' +
            remoteCar.drawCount + ' draws, the band reserves ' + this.ghostDrawsPerCar);
        }
        for (const draw of remoteCar.draws) {
          if (!nodeMatrices.has(draw.nodeId)) {
            throw new Error('ghost slot ' + index + ' remote car draw ' + draw.id + ' has no matrix for ' + draw.nodeId);
          }
        }
      }
      slots.push({
        nodeMatrices,
        tint: Array.isArray(frame.tint) && frame.tint.length >= 3 ? frame.tint : null,
        car: remoteCar
      });
      active++;
    }
    this.ghostFrames = slots;
    this.ghostMatrices = slots.find((slot) => slot !== null)?.nodeMatrices ?? null;
    this.ghostEnabled = active > 0;
    this.stats.ghostEnabled = this.ghostEnabled;
    this.stats.ghostActiveSlots = active;
  }

  /**
   * Power-up diagnostics (PWR2): supply visible mine/pickup/shield markers for
   * the next frame. Each marker is `{kind, position:[x,y,z], scale, colour}`.
   * This is a labelled presentation overlay only: it never writes a physics or
   * packet value, and the default `null` hides it.
   */
  /**
   * Replace the diagnostic ambient floor with the committed retail ambient.
   * `value` is the luminance of `lighting.ambient.upNormalAmbientScaled` for the
   * loaded map; the shader uses it as `ambient + (1 - ambient) * lambert`.
   * Returns false when the scene buffer does not exist yet.
   */
  setAmbient(value) {
    if (!Number.isFinite(value) || value < 0 || value > 1) return false;
    // Keep it as the pending value so a later scene creation applies it too.
    this.pendingAmbient = value;
    if (this.sceneBuffer) {
      this.device.queue.writeBuffer(this.sceneBuffer, 32, new Float32Array([value, 0, 0, 0]));
      this.stats.ambient = value;
      this.stats.ambientSource = 'retail-upNormalAmbientScaled-luminance';
    }
    return true;
  }

  setPowerupMarkers(markers) {
    if (!markers) {
      this.powerupMarkers = null;
      this.powerupRingMarkers = null;
      this.powerupEnabled = false;
      this.stats.powerupEnabled = false;
      return;
    }
    if (!Array.isArray(markers)) throw new Error('power-up markers need an array');
    const markerRows = [];
    const ringRows = [];
    markers.forEach((marker, index) => {
      const position = Array.isArray(marker.position)
        ? marker.position
        : [marker.position?.x ?? 0, marker.position?.y ?? 0, marker.position?.z ?? 0];
      if (!position.every((value) => Number.isFinite(value))) {
        throw new Error('power-up marker ' + index + ' has a non-finite position');
      }
      const colour = Array.isArray(marker.colour) && marker.colour.length >= 3
        ? marker.colour.slice(0, 3)
        : [1, 1, 1];
      const row = {
        kind: marker.kind ?? 'marker',
        shape: marker.shape === 'ring' ? 'ring' : 'marker',
        position,
        scale: Number.isFinite(marker.scale) ? marker.scale : 1,
        colour
      };
      (row.shape === 'ring' ? ringRows : markerRows).push(row);
    });
    if (markerRows.length > this.powerupDraws.length) {
      this.stats.powerupDropped += markerRows.length - this.powerupDraws.length;
      throw new Error('power-up marker slots ' + this.powerupDraws.length + ' but ' + markerRows.length + ' markers');
    }
    if (ringRows.length > this.powerupRingDraws.length) {
      this.stats.powerupDropped += ringRows.length - this.powerupRingDraws.length;
      throw new Error('power-up ring slots ' + this.powerupRingDraws.length + ' but ' + ringRows.length + ' rings');
    }
    this.powerupMarkers = markerRows;
    this.powerupRingMarkers = ringRows;
    this.powerupEnabled = markerRows.length > 0 || ringRows.length > 0;
    this.stats.powerupEnabled = this.powerupEnabled;
  }

  /** Interpolate the per-tick orbit camera; f = 0 returns tick A's stored matrices. */
  interpolateCamera(a, b, f) {
    if (!(f > 0)) return { view: Float32Array.from(a.view), projection: Float32Array.from(a.projection) };
    const oa = a.orbit;
    const ob = b.orbit;
    const yaw = oa.yaw + shortestAngle(ob.yaw - oa.yaw) * f;
    const pitch = oa.pitch + (ob.pitch - oa.pitch) * f;
    const distance = oa.distance + (ob.distance - oa.distance) * f;
    const target = [
      a.target[0] + (b.target[0] - a.target[0]) * f,
      a.target[1] + (b.target[1] - a.target[1]) * f,
      a.target[2] + (b.target[2] - a.target[2]) * f
    ];
    const { view } = orbitView(target, distance, yaw, pitch);
    return {
      view,
      projection: perspective(a.verticalFovRadians, a.aspect, a.near, a.far)
    };
  }

  /** Resolve the render state for a fractional tick. Pure: no GPU calls. */
  resolveFrame(cursor) {
    const clampCursor = Math.max(0, Math.min(this.lastTick, cursor));
    if (!this.timeline) {
      return {
        cursor: clampCursor,
        alpha: 0,
        tickFloor: 0,
        tickCeil: 0,
        view: Float32Array.from(this.packet.camera.view),
        projection: Float32Array.from(this.packet.camera.projection),
        worlds: this.draws.map((draw) => Float32Array.from(draw.world)),
        tickHash: null
      };
    }
    const floor = Math.min(Math.floor(clampCursor), this.lastTick);
    const ceil = Math.min(floor + 1, this.lastTick);
    const f = clampCursor - floor;
    const a = this.updates[floor];
    const b = this.updates[ceil];
    // `pinCamera` is a screenshot/debug option: hold the packet's tick-0 camera so
    // two frames of different ticks differ only by the moving object.
    const camera = this.usePacketCamera
      ? (this.pinCamera ? { view: Float32Array.from(this.updates[0].camera.view), projection: Float32Array.from(this.updates[0].camera.projection) } : this.interpolateCamera(a.camera, b.camera, f))
      : this.currentOverrideCamera();
    const from = this.updateMaps[floor];
    const to = this.updateMaps[ceil];
    const worlds = this.draws.map((draw, index) => {
      const key = this.drawMovers[index];
      if (!key) return Float32Array.from(draw.world);
      const worldA = from.get(key) ?? draw.world;
      const worldB = to.get(key) ?? worldA;
      return interpolateRigid(worldA, worldB, f);
    });
    return {
      cursor: clampCursor,
      alpha: f,
      tickFloor: floor,
      tickCeil: ceil,
      view: camera.view,
      projection: camera.projection,
      worlds,
      tickHash: a.hash
    };
  }

  currentOverrideCamera() {
    const view = orbitView(this.orbit.target, this.orbit.distance, this.orbit.yaw, this.orbit.pitch).view;
    const projection = perspective(this.cameraShape.fovY, this.cameraShape.aspect, this.cameraShape.near, this.cameraShape.far);
    return { view, projection };
  }

  /** Debug camera that frames one mesh instead of the whole packet scene. */
  focusMesh(meshId) {
    if (!this.packet) throw new Error('no packet loaded');
    const subset = this.packet.draws.filter((draw) => draw.meshId === meshId);
    if (!subset.length) throw new Error('no draw uses mesh ' + meshId);
    const bounds = boundsOfDraws(subset);
    const mesh = this.packet.meshes.find((entry) => entry.id === meshId);
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
    return this.renderFrame({ cursor: this.stats.cursor });
  }

  renderFrame({ cursor = 0 } = {}) {
    if (!this.device || !this.packet) return null;
    const frame = this.resolveFrame(cursor);
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height || !this.depth) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.depth?.destroy();
      this.depth = this.device.createTexture({ size: [width, height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }

    const viewProjection = multiply(frame.projection, frame.view);
    const ghostFrames = this.ghostEnabled
      ? this.ghostFrames.map((entry) => entry ?? null)
      : [];
    const activeGhostSlots = ghostFrames.filter((entry) => entry !== null).length;
    const ghostActive = activeGhostSlots > 0 && this.ghostDrawsPerCar > 0;
    const ghostDrawCount = this.ghostDrawsPerCar;
    const powerupMarkerActive = this.powerupEnabled && Array.isArray(this.powerupMarkers) &&
      this.powerupMarkers.length > 0 && this.powerupDraws.length > 0;
    const powerupRingActive = this.powerupEnabled && Array.isArray(this.powerupRingMarkers) &&
      this.powerupRingMarkers.length > 0 && this.powerupRingDraws.length > 0;
    const powerupActive = powerupMarkerActive || powerupRingActive;
    // Ghost and marker slots are reserved at load; offsets are stable even when
    // one of the passes is inactive.
    const ghostSlotStride = ghostDrawCount * (this.ghostSlotCount ?? 1);
    const slotCount = this.draws.length + ghostSlotStride + this.powerupSlotCount;
    const bytes = new Float32Array(slotCount * (DRAW_UNIFORM_STRIDE / 4));
    for (let index = 0; index < this.draws.length; index++) {
      const draw = this.draws[index];
      const base = index * (DRAW_UNIFORM_STRIDE / 4);
      bytes.set(viewProjection, base);
      bytes.set(frame.worlds[index], base + 16);
      const colour = draw.textureId != null
        ? [1, 1, 1]
        : (Array.isArray(draw.diagnosticColour) && draw.diagnosticColour.length >= 3
          ? draw.diagnosticColour
          : [NEUTRAL_ALBEDO, NEUTRAL_ALBEDO, NEUTRAL_ALBEDO]);
      // w = diagnostic spin-marker strength, not opacity. Zero for every draw
      // that does not spin (body, caliper, level, collision surface).
      bytes.set([colour[0], colour[1], colour[2], draw.spins ? 0.85 : 0], base + 32);
      // texParams.x = 1 only when a static albedo texture is bound. A textured
      // draw is tinted white so the sampled texel is used unchanged; no material
      // colour is invented. texParams.y/z are the declared U/V flip flags; the
      // car pack sets u' = 1-u and leaves v raw, while level and track packs keep
      // the raw UV0 stream.
      bytes.set([
        draw.textureId != null ? 1 : 0,
        draw.uvFlipU === true ? 1 : 0,
        draw.uvFlipV === true ? 1 : 0,
        0
      ], base + 36);
    }
    if (ghostActive) {
      // Ghost slots follow the packet's own draw uniforms in the same buffer.
      // Each remote slot has its own reserved band (ghostSlotCount × car draws).
      // The tint is the labelled diagnostic colour; texParams stays 0 because the
      // ghost shader does not sample a texture.
      for (let slot = 0; slot < ghostFrames.length; slot++) {
        const frameEntry = ghostFrames[slot];
        if (!frameEntry) continue;
        const tint = frameEntry.tint ?? GHOST_TINT;
        const drawList = frameEntry.car?.draws ?? this.ghostDraws;
        const frameDrawCount = frameEntry.car?.drawCount ?? this.ghostDraws.length;
        for (let index = 0; index < frameDrawCount; index++) {
          const draw = drawList[index];
          const base = (this.draws.length + slot * ghostDrawCount + index) * (DRAW_UNIFORM_STRIDE / 4);
          bytes.set(viewProjection, base);
          bytes.set(frameEntry.nodeMatrices.get(draw.nodeId) ?? draw.world, base + 16);
          bytes.set([tint[0], tint[1], tint[2], draw.spins ? 0.85 : 0], base + 32);
          bytes.set([0, 0, 0, 0], base + 36);
        }
      }
    }
    if (powerupActive) {
      // Diagnostic marker slots follow the ghost slots. Colour is presentation
      // only; the marker mesh/scale never enters the packet or the physics.
      const markerBase = this.draws.length + ghostSlotStride;
      const activeMarkers = (this.powerupMarkers ?? []).slice(0, this.powerupDraws.length);
      for (let index = 0; index < activeMarkers.length; index++) {
        const marker = activeMarkers[index];
        const base = (markerBase + index) * (DRAW_UNIFORM_STRIDE / 4);
        bytes.set(viewProjection, base);
        bytes.set(markerMatrix(marker.position, marker.scale), base + 16);
        bytes.set([marker.colour[0], marker.colour[1], marker.colour[2], 0], base + 32);
        bytes.set([0, 0, 0, 0], base + 36);
      }
      const ringBase = markerBase + this.powerupDraws.length;
      const activeRings = (this.powerupRingMarkers ?? []).slice(0, this.powerupRingDraws.length);
      for (let index = 0; index < activeRings.length; index++) {
        const ring = activeRings[index];
        const base = (ringBase + index) * (DRAW_UNIFORM_STRIDE / 4);
        bytes.set(viewProjection, base);
        bytes.set(markerMatrix(ring.position, ring.scale), base + 16);
        bytes.set([ring.colour[0], ring.colour[1], ring.colour[2], 0], base + 32);
        bytes.set([0, 0, 0, 0], base + 36);
      }
    }
    this.device.queue.writeBuffer(this.uniformBuffer, 0, bytes);

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
    let activeTexture = null;
    for (let index = 0; index < this.draws.length; index++) {
      const draw = this.draws[index];
      if (draw.visible === false) continue;
      if (activeMesh !== draw.meshId) {
        pass.setVertexBuffer(0, draw.mesh.vertexBuffer);
        pass.setVertexBuffer(1, draw.mesh.uvBuffer);
        pass.setIndexBuffer(draw.mesh.indexBuffer, 'uint32');
        activeMesh = draw.meshId;
      }
      const textureKey = draw.textureId != null ? draw.textureId : PLACEHOLDER_TEXTURE_ID;
      if (activeTexture !== textureKey) {
        pass.setBindGroup(2, draw.textureId != null ? this.textureGroups.get(draw.textureId) : this.placeholderGroup);
        activeTexture = textureKey;
      }
      pass.setBindGroup(0, this.drawBindGroup, [index * DRAW_UNIFORM_STRIDE]);
      pass.drawIndexed(draw.indexCount, 1, draw.indexOffset, 0, 0);
    }
    if (ghostActive) {
      // Second pass over the same vertex/index/UV buffers: each remote car with
      // the translucent diagnostic tint. No geometry is uploaded; the ghost
      // shader samples no texture, so the placeholder bind group is enough.
      pass.setPipeline(this.ghostPipeline);
      pass.setBindGroup(2, this.placeholderGroup);
      let ghostMesh = null;
      for (let slot = 0; slot < ghostFrames.length; slot++) {
        if (!ghostFrames[slot]) continue;
        const frameEntry = ghostFrames[slot];
        const drawList = frameEntry.car?.draws ?? this.ghostDraws;
        const frameDrawCount = frameEntry.car?.drawCount ?? this.ghostDraws.length;
        for (let index = 0; index < frameDrawCount; index++) {
          const draw = drawList[index];
          if (ghostMesh !== draw.meshId) {
            pass.setVertexBuffer(0, draw.mesh.vertexBuffer);
            pass.setVertexBuffer(1, draw.mesh.uvBuffer);
            pass.setIndexBuffer(draw.mesh.indexBuffer, 'uint32');
            ghostMesh = draw.meshId;
          }
          pass.setBindGroup(0, this.drawBindGroup,
            [(this.draws.length + slot * ghostDrawCount + index) * DRAW_UNIFORM_STRIDE]);
          pass.drawIndexed(draw.indexCount, 1, draw.indexOffset, 0, 0);
        }
        this.stats.ghostDrawsIssued += frameDrawCount;
      }
      this.stats.ghostFrames++;
    }
    if (powerupActive) {
      // Third pass: the diagnostic marker/ring meshes with the same translucent
      // pipeline. Draw slots are capped at load; no buffer or texture is created.
      pass.setPipeline(this.ghostPipeline);
      pass.setBindGroup(2, this.placeholderGroup);
      const markerBase = this.draws.length + ghostSlotStride;
      let activeMarkers = 0;
      if (powerupMarkerActive) {
        const marker = this.powerupDraws[0];
        pass.setVertexBuffer(0, marker.mesh.vertexBuffer);
        pass.setVertexBuffer(1, marker.mesh.uvBuffer);
        pass.setIndexBuffer(marker.mesh.indexBuffer, 'uint32');
        activeMarkers = Math.min(this.powerupMarkers.length, this.powerupDraws.length);
        for (let index = 0; index < activeMarkers; index++) {
          const draw = this.powerupDraws[index];
          pass.setBindGroup(0, this.drawBindGroup, [(markerBase + index) * DRAW_UNIFORM_STRIDE]);
          pass.drawIndexed(draw.indexCount, 1, draw.indexOffset, 0, 0);
        }
        this.stats.powerupDrawsIssued += activeMarkers;
      }
      let activeRings = 0;
      if (powerupRingActive) {
        const ring = this.powerupRingDraws[0];
        pass.setVertexBuffer(0, ring.mesh.vertexBuffer);
        pass.setVertexBuffer(1, ring.mesh.uvBuffer);
        pass.setIndexBuffer(ring.mesh.indexBuffer, 'uint32');
        activeRings = Math.min(this.powerupRingMarkers.length, this.powerupRingDraws.length);
        const ringBase = markerBase + this.powerupDraws.length;
        for (let index = 0; index < activeRings; index++) {
          const draw = this.powerupRingDraws[index];
          pass.setBindGroup(0, this.drawBindGroup, [(ringBase + index) * DRAW_UNIFORM_STRIDE]);
          pass.drawIndexed(draw.indexCount, 1, draw.indexOffset, 0, 0);
        }
        this.stats.powerupRingDrawsIssued += activeRings;
      }
      this.stats.powerupFrames++;
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    this.stats.renders++;
    this.stats.uniformWrites++;
    this.stats.uniformBytes += bytes.byteLength;
    this.stats.drawsIssued += this.visibleDraws.length + (ghostActive ? ghostDrawCount * activeGhostSlots : 0) +
      (powerupMarkerActive ? Math.min(this.powerupMarkers.length, this.powerupDraws.length) : 0) +
      (powerupRingActive ? Math.min(this.powerupRingMarkers.length, this.powerupRingDraws.length) : 0);
    this.stats.ghostEnabled = ghostActive;
    this.stats.ghostActiveSlots = ghostActive ? activeGhostSlots : 0;
    this.stats.powerupEnabled = powerupActive;
    this.stats.cursor = frame.cursor;
    this.stats.renderTick = frame.tickFloor;
    this.stats.alpha = frame.alpha;
    this.stats.matrixChecksum = matrixChecksum(frame.worlds);
    this.stats.tickHash = frame.tickHash;

    // Where the first moved object projects on screen, in CSS pixels. Used by the
    // screenshot harness to crop on the moving body; also a cheap "it moved" probe.
    this.stats.movedScreen = null;
    const movedIndex = this.drawMovers ? this.drawMovers.findIndex(Boolean) : -1;
    if (movedIndex >= 0) {
      const world = frame.worlds[movedIndex];
      const draw = this.draws[movedIndex];
      const meshBounds = this.meshBounds?.get(draw.meshId);
      const cssWidth = this.canvas.clientWidth || 1;
      const cssHeight = this.canvas.clientHeight || 1;
      const project = (point) => {
        const clip = [0, 0, 0, 0];
        for (let row = 0; row < 4; row++) {
          clip[row] = point[0] * viewProjection[row] + point[1] * viewProjection[4 + row] + point[2] * viewProjection[8 + row] + point[3] * viewProjection[12 + row];
        }
        if (!(clip[3] > 0)) return null;
        return {
          x: ((clip[0] / clip[3]) * 0.5 + 0.5) * cssWidth,
          y: (1 - ((clip[1] / clip[3]) * 0.5 + 0.5)) * cssHeight,
          depth: clip[2] / clip[3]
        };
      };
      const origin = project([world[12], world[13], world[14], 1]);
      if (origin && meshBounds) {
        // Screen box of the moved mesh: project its AABB corners through the
        // current transform, so the screenshot harness can crop on the object.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let corner = 0; corner < 8; corner++) {
          const local = [
            corner & 1 ? meshBounds.max[0] : meshBounds.min[0],
            corner & 2 ? meshBounds.max[1] : meshBounds.min[1],
            corner & 4 ? meshBounds.max[2] : meshBounds.min[2]
          ];
          const point = [
            local[0] * world[0] + local[1] * world[4] + local[2] * world[8] + world[12],
            local[0] * world[1] + local[1] * world[5] + local[2] * world[9] + world[13],
            local[0] * world[2] + local[1] * world[6] + local[2] * world[10] + world[14],
            1
          ];
          const projected = project(point);
          if (!projected) continue;
          minX = Math.min(minX, projected.x);
          minY = Math.min(minY, projected.y);
          maxX = Math.max(maxX, projected.x);
          maxY = Math.max(maxY, projected.y);
        }
        this.stats.movedScreen = {
          x: Number(origin.x.toFixed(2)),
          y: Number(origin.y.toFixed(2)),
          depth: Number(origin.depth.toFixed(5)),
          width: Number.isFinite(minX) ? Number((maxX - minX).toFixed(2)) : 0,
          height: Number.isFinite(minY) ? Number((maxY - minY).toFixed(2)) : 0,
          drawId: draw.id
        };
      }
    }

    this.onState({ state: 'rendered', frames: this.stats.renders, width, height, frame });
    return { width, height, frame };
  }
}

export { boundsOfDraws };
