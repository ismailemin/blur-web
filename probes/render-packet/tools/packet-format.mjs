// Render packet v1 — canonical serialisation, stable hash and structural conformance.
// This file is the single definition of "the packet hash"; the producer, the
// validator and any future engine exporter must agree with it byte for byte.

import { createHash } from 'node:crypto';

export const PACKET_KIND = 'blur.render-packet';
export const PACKET_VERSION = 1;

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MATRIX_CONVENTION =
  'column-major 16-float array; column-vector; right-handed view; WebGPU clip depth 0..1';

/** Recursively sort object keys so key order can never change the hash. */
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

/** Compact, key-sorted JSON. Numbers use the engine's shortest round-trip form. */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

/** sha256 over the packet body (everything except the `hash` member). */
export function packetHash(packet) {
  const body = { ...packet };
  delete body.hash;
  return 'sha256:' + createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

/** Pretty formatter that keeps short numeric arrays on one line, for review. */
export function formatPacket(value, indent = 2) {
  const pad = (depth) => ' '.repeat(depth * indent);
  const numeric = (array) => array.length > 0 && array.every((item) => typeof item === 'number');
  const walk = (node, depth) => {
    if (Array.isArray(node)) {
      if (node.length === 0) return '[]';
      if (numeric(node)) {
        const text = JSON.stringify(node);
        if (text.length <= 110) return text;
        // Long numeric runs (positions, indices) are wrapped, never one per line.
        const perLine = 12;
        const rows = [];
        for (let start = 0; start < node.length; start += perLine) {
          rows.push(pad(depth + 1) + node.slice(start, start + perLine).map((item) => JSON.stringify(item)).join(', '));
        }
        return '[\n' + rows.join(',\n') + '\n' + pad(depth) + ']';
      }
      const items = node.map((item) => pad(depth + 1) + walk(item, depth + 1));
      return '[\n' + items.join(',\n') + '\n' + pad(depth) + ']';
    }
    if (node && typeof node === 'object') {
      const keys = Object.keys(node).sort();
      if (keys.length === 0) return '{}';
      const rows = keys.map((key) => pad(depth + 1) + JSON.stringify(key) + ': ' + walk(node[key], depth + 1));
      return '{\n' + rows.join(',\n') + '\n' + pad(depth) + '}';
    }
    return JSON.stringify(node);
  };
  return walk(value, 0) + '\n';
}

function isVec3(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}
function isVec4(value) {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite);
}
function isMat4(value) {
  return Array.isArray(value) && value.length === 16 && value.every(Number.isFinite);
}
function isInt(value) {
  return Number.isSafeInteger(value);
}

/**
 * Structural conformance check for packet v1. It is deliberately stricter than a
 * generic JSON-Schema pass: every draw range must land inside its mesh and every
 * index inside the mesh vertex count, because the consumer trusts those ranges.
 */
export function validatePacket(packet) {
  const errors = [];
  const fail = (where, message) => errors.push(where + ': ' + message);
  const need = (where, condition, message) => { if (!condition) fail(where, message); };

  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    return { ok: false, errors: ['packet: not an object'] };
  }

  const required = ['kind','version','generator','tick','alpha','camera','lights','meshes','materials','draws','placedObjects','diagnostics','hash'];
  for (const key of required) if (!(key in packet)) fail('packet', 'missing member ' + key);

  if (packet.kind !== PACKET_KIND) fail('kind', 'expected ' + PACKET_KIND);
  if (packet.version !== PACKET_VERSION) fail('version', 'expected ' + PACKET_VERSION);
  need('tick', isInt(packet.tick) && packet.tick >= 0, 'must be a non-negative integer');
  need('alpha', Number.isFinite(packet.alpha) && packet.alpha >= 0 && packet.alpha <= 1, 'must be within 0..1');

  const camera = packet.camera ?? {};
  need('camera.mode', camera.mode === 'orbit' || camera.mode === 'explicit', 'must be orbit or explicit');
  need('camera.view', isMat4(camera.view), 'must be 16 finite numbers');
  need('camera.projection', isMat4(camera.projection), 'must be 16 finite numbers');
  need('camera.position', isVec3(camera.position), 'must be 3 finite numbers');
  need('camera.target', isVec3(camera.target), 'must be 3 finite numbers');
  need('camera.up', isVec3(camera.up), 'must be 3 finite numbers');
  need('camera.near', Number.isFinite(camera.near) && camera.near > 0, 'must be positive');
  need('camera.far', Number.isFinite(camera.far) && camera.far > camera.near, 'must exceed near');
  need('camera.aspect', Number.isFinite(camera.aspect) && camera.aspect > 0, 'must be positive');
  need('camera.verticalFovRadians', Number.isFinite(camera.verticalFovRadians) && camera.verticalFovRadians > 0 && camera.verticalFovRadians < Math.PI, 'must be within (0, pi)');
  need('camera.matrixConvention', camera.matrixConvention === MATRIX_CONVENTION, 'must document the matrix convention');

  if (!Array.isArray(packet.lights)) fail('lights', 'must be an array');
  else packet.lights.forEach((light, index) => {
    const where = `lights[${index}]`;
    need(where + '.type', light?.type === 'directional', 'only directional is defined in v1');
    if (light?.type === 'directional') {
      need(where + '.direction', isVec3(light.direction), 'must be 3 finite numbers');
      const length = isVec3(light.direction) ? Math.hypot(...light.direction) : 0;
      need(where + '.direction', Math.abs(length - 1) <= 1e-4, 'must be a unit vector');
    }
    need(where + '.colour', isVec4(light?.colour), 'must be 4 finite numbers');
    need(where + '.intensity', Number.isFinite(light?.intensity), 'must be finite');
    need(where + '.source', typeof light?.source === 'string' && light.source.length > 0, 'must state where the light came from');
  });

  const meshes = new Map();
  if (!Array.isArray(packet.meshes) || packet.meshes.length === 0) fail('meshes', 'must be a non-empty array');
  else packet.meshes.forEach((mesh, index) => {
    const where = `meshes[${index}]`;
    need(where + '.id', typeof mesh?.id === 'string' && mesh.id.length > 0, 'must be a non-empty string');
    if (meshes.has(mesh?.id)) fail(where + '.id', 'duplicate mesh id');
    need(where + '.storage', mesh?.storage === 'inline-json', 'v1 only defines inline-json storage');
    need(where + '.vertexCount', isInt(mesh?.vertexCount) && mesh.vertexCount > 0, 'must be a positive integer');
    need(where + '.indexCount', isInt(mesh?.indexCount) && mesh.indexCount > 0 && mesh.indexCount % 3 === 0, 'must be a positive multiple of 3');
    need(where + '.positions', Array.isArray(mesh?.positions) && mesh.positions.length === mesh.vertexCount * 3, 'length must be vertexCount*3');
    need(where + '.indices', Array.isArray(mesh?.indices) && mesh.indices.length === mesh.indexCount, 'length must equal indexCount');
    need(where + '.positionsSha256', SHA256.test(mesh?.positionsSha256 ?? ''), 'must be a sha256 of the little-endian float32 positions');
    need(where + '.indicesSha256', SHA256.test(mesh?.indicesSha256 ?? ''), 'must be a sha256 of the little-endian uint32 indices');
    need(where + '.coordinateSpace', typeof mesh?.coordinateSpace === 'string' && mesh.coordinateSpace.length > 0, 'must state the coordinate space');
    need(where + '.source', mesh?.source && typeof mesh.source === 'object', 'must record the source tool');
    if (Array.isArray(mesh?.positions) && mesh.positions.length === mesh.vertexCount * 3) {
      if (!mesh.positions.every(Number.isFinite)) fail(where + '.positions', 'contains a non-finite value');
    }
    if (Array.isArray(mesh?.indices) && Array.isArray(mesh?.positions) && mesh.indices.length === mesh.indexCount) {
      for (const value of mesh.indices) {
        if (!isInt(value) || value < 0 || value >= mesh.vertexCount) {
          fail(where + '.indices', 'index ' + value + ' is outside the vertex range');
          break;
        }
      }
    }
    meshes.set(mesh?.id, mesh);
  });

  const materialIds = new Set();
  if (!Array.isArray(packet.materials)) fail('materials', 'must be an array');
  else packet.materials.forEach((material, index) => {
    const where = `materials[${index}]`;
    need(where + '.id', typeof material?.id === 'string' && material.id.length > 0, 'must be a non-empty string');
    if (materialIds.has(material?.id)) fail(where + '.id', 'duplicate material id');
    materialIds.add(material?.id);
    need(where + '.albedoTextureIndex', material?.albedoTextureIndex === null || isInt(material.albedoTextureIndex), 'must be an integer or null');
    need(where + '.pixelsIncluded', material?.pixelsIncluded === false, 'v1 does not carry texture pixels');
    need(where + '.source', typeof material?.source === 'string' && material.source.length > 0, 'must record the source');
  });

  if (!Array.isArray(packet.draws) || packet.draws.length === 0) fail('draws', 'must be a non-empty array');
  else packet.draws.forEach((draw, index) => {
    const where = `draws[${index}]`;
    const mesh = meshes.get(draw?.meshId);
    need(where + '.meshId', Boolean(mesh), 'references an unknown mesh');
    need(where + '.id', typeof draw?.id === 'string' && draw.id.length > 0, 'must be a non-empty string');
    need(where + '.world', isMat4(draw?.world), 'must be 16 finite numbers');
    need(where + '.worldKind', draw?.worldKind === 'baked-into-mesh' || draw?.worldKind === 'packet-transform', 'must be baked-into-mesh or packet-transform');
    need(where + '.layer', draw?.layer === 'opaque' || draw?.layer === 'transparent', 'must be opaque or transparent');
    need(where + '.materialReason', typeof draw?.materialReason === 'string' && draw.materialReason.length > 0, 'must state why the material is or is not bound');
    if (draw?.materialId !== null) {
      need(where + '.materialId', materialIds.has(draw?.materialId), 'references an unknown material');
    }
    need(where + '.bounds.min', isVec3(draw?.bounds?.min), 'must be 3 finite numbers');
    need(where + '.bounds.max', isVec3(draw?.bounds?.max), 'must be 3 finite numbers');
    if (isVec3(draw?.bounds?.min) && isVec3(draw?.bounds?.max)) {
      for (let axis = 0; axis < 3; axis++) {
        need(where + '.bounds', draw.bounds.min[axis] <= draw.bounds.max[axis], 'min must not exceed max on axis ' + axis);
      }
    }
    need(where + '.source', draw?.source && typeof draw.source === 'object', 'must record the source offset/instance');
    if (mesh) {
      need(where + '.vertexOffset', isInt(draw?.vertexOffset) && draw.vertexOffset >= 0, 'must be a non-negative integer');
      need(where + '.vertexCount', isInt(draw?.vertexCount) && draw.vertexCount > 0, 'must be a positive integer');
      need(where + '.indexOffset', isInt(draw?.indexOffset) && draw.indexOffset >= 0, 'must be a non-negative integer');
      need(where + '.indexCount', isInt(draw?.indexCount) && draw.indexCount > 0 && draw.indexCount % 3 === 0, 'must be a positive multiple of 3');
      need(where + '.vertexRange', draw.vertexOffset + draw.vertexCount <= mesh.vertexCount, 'exceeds mesh vertexCount');
      need(where + '.indexRange', draw.indexOffset + draw.indexCount <= mesh.indexCount, 'exceeds mesh indexCount');
    }
  });

  if (!Array.isArray(packet.placedObjects)) fail('placedObjects', 'must be an array');
  else packet.placedObjects.forEach((placed, index) => {
    const where = `placedObjects[${index}]`;
    need(where + '.meshId', meshes.has(placed?.meshId), 'references an unknown mesh');
    need(where + '.world', isMat4(placed?.world), 'must be 16 finite numbers');
    need(where + '.placement', typeof placed?.placement === 'string' && placed.placement.length > 0, 'must name the placement');
    need(where + '.reason', typeof placed?.reason === 'string' && placed.reason.length > 0, 'must state why this placement exists');
  });

  const diagnostics = packet.diagnostics ?? {};
  for (const key of ['drawCount','meshCount','vertexTotal','triangleTotal','culled','instancesEmitted','instancesOmitted']) {
    need('diagnostics.' + key, isInt(diagnostics[key]) && diagnostics[key] >= 0, 'must be a non-negative integer');
  }
  need('diagnostics.materialsApplied', typeof diagnostics.materialsApplied === 'boolean', 'must be a boolean');
  need('diagnostics.lighting', typeof diagnostics.lighting === 'string' && diagnostics.lighting.length > 0, 'must name the lighting model');
  for (const key of ['approximations','notRecovered','limits']) {
    need('diagnostics.' + key, Array.isArray(diagnostics[key]) && diagnostics[key].every((text) => typeof text === 'string' && text.length > 0), 'must be an array of non-empty strings');
  }
  if (Array.isArray(packet.draws) && isInt(diagnostics.drawCount)) need('diagnostics.drawCount', diagnostics.drawCount === packet.draws.length, 'must equal draws.length');
  if (Array.isArray(packet.meshes) && isInt(diagnostics.meshCount)) need('diagnostics.meshCount', diagnostics.meshCount === packet.meshes.length, 'must equal meshes.length');

  need('hash', SHA256.test(packet.hash ?? ''), 'must be a sha256 string');
  if (SHA256.test(packet.hash ?? '')) {
    const recomputed = packetHash(packet);
    need('hash', recomputed === packet.hash, 'does not match the canonical body hash (' + recomputed + ')');
  }

  return { ok: errors.length === 0, errors };
}

export { MATRIX_CONVENTION };
