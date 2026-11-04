// Render packet v1 — canonical serialisation, stable hash and structural conformance.
// This file is the single definition of "the packet hash"; the producer, the
// validator and any future engine exporter must agree with it byte for byte.
//
// Version family: `version: 1` is the static single-frame packet. `version: 1.1`
// adds the additive timeline (`nodes`, `updates`, `tickDurationSeconds`) and must
// still parse as a v1 packet by ignoring those members. A v1.1 packet without a
// timeline is rejected: the bump has to mean something.

import { createHash } from 'node:crypto';
import { MATRIX_CONVENTION, cameraFromOrbit } from './packet-camera.mjs';
import { isRigid } from '../web/interpolate.js';

export const PACKET_KIND = 'blur.render-packet';
export const PACKET_VERSION = 1.1;
export const SUPPORTED_VERSIONS = Object.freeze([1, 1.1]);

const SHA256 = /^sha256:[0-9a-f]{64}$/;

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

/** sha256 over any value's canonical JSON. `undefined` members are dropped. */
export function hashOf(value) {
  return 'sha256:' + createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** sha256 over the packet body (everything except the `hash` member). */
export function packetHash(packet) {
  const body = { ...packet };
  delete body.hash;
  return hashOf(body);
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

const TIMELINE_MEMBERS = Object.freeze(['nodes', 'updates', 'tickDurationSeconds']);

function checkCamera(where, camera, fail) {
  const need = (member, condition, message) => { if (!condition) fail(where + '.' + member, message); };
  need('mode', camera.mode === 'orbit' || camera.mode === 'explicit', 'must be orbit or explicit');
  need('view', isMat4(camera.view), 'must be 16 finite numbers');
  need('projection', isMat4(camera.projection), 'must be 16 finite numbers');
  need('position', isVec3(camera.position), 'must be 3 finite numbers');
  need('target', isVec3(camera.target), 'must be 3 finite numbers');
  need('up', isVec3(camera.up), 'must be 3 finite numbers');
  need('near', Number.isFinite(camera.near) && camera.near > 0, 'must be positive');
  need('far', Number.isFinite(camera.far) && camera.far > camera.near, 'must exceed near');
  need('aspect', Number.isFinite(camera.aspect) && camera.aspect > 0, 'must be positive');
  need('verticalFovRadians', Number.isFinite(camera.verticalFovRadians) && camera.verticalFovRadians > 0 && camera.verticalFovRadians < Math.PI, 'must be within (0, pi)');
  need('matrixConvention', camera.matrixConvention === MATRIX_CONVENTION, 'must document the matrix convention');
  if (camera.mode === 'orbit') {
    const orbit = camera.orbit ?? {};
    need('orbit.yaw', Number.isFinite(orbit.yaw), 'an orbit camera must expose a finite yaw');
    need('orbit.pitch', Number.isFinite(orbit.pitch) && Math.abs(orbit.pitch) < Math.PI / 2, 'an orbit camera must expose a pitch within (-pi/2, pi/2)');
    need('orbit.distance', Number.isFinite(orbit.distance) && orbit.distance > 0, 'an orbit camera must expose a positive distance');
  }
}

function checkClose(where, expected, actual, tolerance, fail) {
  if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
    fail(where, 'cannot compare arrays of different shapes');
    return;
  }
  for (let index = 0; index < expected.length; index++) {
    if (!(Math.abs(expected[index] - actual[index]) <= tolerance)) {
      fail(where, 'component ' + index + ' is ' + actual[index] + ' but the declared parameters give ' + expected[index]);
      return;
    }
  }
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
  if (!SUPPORTED_VERSIONS.includes(packet.version)) fail('version', 'expected one of ' + SUPPORTED_VERSIONS.join(', '));
  const isTimeline = packet.version === 1.1;
  need('tick', isInt(packet.tick) && packet.tick >= 0, 'must be a non-negative integer');
  need('alpha', Number.isFinite(packet.alpha) && packet.alpha >= 0 && packet.alpha <= 1, 'must be within 0..1');
  if (isTimeline) {
    for (const key of TIMELINE_MEMBERS) if (!(key in packet)) fail('packet', 'version 1.1 requires member ' + key);
  } else {
    for (const key of TIMELINE_MEMBERS) if (key in packet) fail('packet', 'version 1 must not carry the timeline member ' + key);
  }

  const camera = packet.camera ?? {};
  checkCamera('camera', camera, fail);
  if (camera.mode === 'orbit' && camera.orbit) {
    const rebuilt = cameraFromOrbit({
      target: camera.target,
      distance: camera.orbit.distance,
      yaw: camera.orbit.yaw,
      pitch: camera.orbit.pitch,
      near: camera.near,
      far: camera.far,
      verticalFovRadians: camera.verticalFovRadians,
      aspect: camera.aspect
    });
    checkClose('camera.view', rebuilt.view, camera.view, 1e-5, fail);
    checkClose('camera.projection', rebuilt.projection, camera.projection, 1e-5, fail);
    checkClose('camera.position', rebuilt.position, camera.position, 1e-4, fail);
  }

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

  const drawById = new Map();
  const nodeOwner = new Map();
  if (!Array.isArray(packet.draws) || packet.draws.length === 0) fail('draws', 'must be a non-empty array');
  else packet.draws.forEach((draw, index) => {
    const where = `draws[${index}]`;
    const mesh = meshes.get(draw?.meshId);
    need(where + '.meshId', Boolean(mesh), 'references an unknown mesh');
    need(where + '.id', typeof draw?.id === 'string' && draw.id.length > 0, 'must be a non-empty string');
    if (drawById.has(draw?.id)) fail(where + '.id', 'duplicate draw id');
    drawById.set(draw?.id, draw);
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

  const nodes = new Map();
  if (isTimeline) {
    if (!Array.isArray(packet.nodes) || packet.nodes.length === 0) fail('nodes', 'must be a non-empty array');
    else packet.nodes.forEach((node, index) => {
      const where = `nodes[${index}]`;
      need(where + '.id', typeof node?.id === 'string' && node.id.length > 0, 'must be a non-empty string');
      if (nodes.has(node?.id)) fail(where + '.id', 'duplicate node id');
      need(where + '.meshId', meshes.has(node?.meshId), 'references an unknown mesh');
      need(where + '.drawIds', Array.isArray(node?.drawIds) && node.drawIds.length > 0, 'must name the draws it moves');
      if (Array.isArray(node?.drawIds)) {
        for (const drawId of node.drawIds) {
          if (!drawById.has(drawId)) fail(where + '.drawIds', 'references unknown draw ' + drawId);
          if (nodeOwner.has(drawId)) fail(where + '.drawIds', 'draw ' + drawId + ' is already moved by node ' + nodeOwner.get(drawId));
          nodeOwner.set(drawId, node?.id);
        }
      }
      need(where + '.reason', typeof node?.reason === 'string' && node.reason.length > 0, 'must state why these draws share a transform');
      nodes.set(node?.id, node);
    });
  }

  if (isTimeline) {
    need('tickDurationSeconds', Number.isFinite(packet.tickDurationSeconds) && packet.tickDurationSeconds > 0, 'must be positive');
    if (!Array.isArray(packet.updates) || packet.updates.length < 2) fail('updates', 'must be an array of at least two ticks');
    else {
      const seen = new Set();
      let previousTick = -1;
      packet.updates.forEach((update, index) => {
        const where = `updates[${index}]`;
        need(where + '.tick', isInt(update?.tick) && update.tick >= 0, 'must be a non-negative integer');
        if (isInt(update?.tick)) {
          if (update.tick <= previousTick) fail(where + '.tick', 'ticks must strictly increase');
          previousTick = update.tick;
        }
        need(where + '.alpha', Number.isFinite(update?.alpha) && update.alpha >= 0 && update.alpha <= 1, 'must be within 0..1');
        checkCamera(where + '.camera', update?.camera ?? {}, fail);
        if (update?.camera?.mode === 'orbit' && update.camera.orbit) {
          const rebuilt = cameraFromOrbit({
            target: update.camera.target,
            distance: update.camera.orbit.distance,
            yaw: update.camera.orbit.yaw,
            pitch: update.camera.orbit.pitch,
            near: update.camera.near,
            far: update.camera.far,
            verticalFovRadians: update.camera.verticalFovRadians,
            aspect: update.camera.aspect
          });
          checkClose(where + '.camera.view', rebuilt.view, update.camera.view, 1e-5, fail);
          checkClose(where + '.camera.projection', rebuilt.projection, update.camera.projection, 1e-5, fail);
        }
        if (!Array.isArray(update?.matrices)) fail(where + '.matrices', 'must be an array');
        else update.matrices.forEach((entry, matrixIndex) => {
          const at = `${where}.matrices[${matrixIndex}]`;
          const hasNode = typeof entry?.nodeId === 'string';
          const hasDraw = typeof entry?.drawId === 'string';
          need(at, hasNode !== hasDraw, 'must name exactly one of nodeId or drawId');
          if (hasNode) need(at + '.nodeId', nodes.has(entry.nodeId), 'references an unknown node');
          if (hasDraw) need(at + '.drawId', drawById.has(entry.drawId), 'references an unknown draw');
          if (!isMat4(entry?.world)) {
            fail(at + '.world', 'must be 16 finite numbers');
            return;
          }
          // Interpolation is only defined for rigid transforms, so it is a
          // contract requirement rather than a consumer convenience.
          need(at + '.world', isRigid(entry.world), 'must be a rigid transform (rotation + translation, no scale or shear)');
          const key = hasNode ? 'node:' + entry.nodeId : 'draw:' + entry.drawId;
          if (seen.has(update.tick + '|' + key)) fail(at, 'duplicate transform for ' + key + ' at tick ' + update.tick);
          seen.add(update.tick + '|' + key);
        });
        need(where + '.hash', SHA256.test(update?.hash ?? ''), 'must be a sha256 string');
        if (SHA256.test(update?.hash ?? '')) {
          const recomputed = hashOf({ ...update, hash: undefined });
          need(where + '.hash', recomputed === update.hash, 'does not match the canonical tick hash (' + recomputed + ')');
        }
      });

      const first = packet.updates[0];
      if (first) {
        need('updates[0].tick', first.tick === packet.tick, 'must equal the packet reference tick');
        need('updates[0].alpha', first.alpha === packet.alpha, 'must equal the packet reference alpha');
        checkClose('updates[0].camera.view', packet.camera.view, first.camera?.view, 1e-9, fail);
        checkClose('updates[0].camera.projection', packet.camera.projection, first.camera?.projection, 1e-9, fail);
      }
      const sequence = packet.diagnostics?.sequence ?? {};
      need('diagnostics.sequence.tickCount', sequence.tickCount === packet.updates.length, 'must equal updates.length');
      need('diagnostics.sequence.tickHz', isInt(sequence.tickHz) && sequence.tickHz > 0, 'must be a positive integer');
      if (isInt(sequence.tickHz)) {
        need('tickDurationSeconds', Math.abs(packet.tickDurationSeconds - 1 / sequence.tickHz) <= 1e-12, 'must equal 1/tickHz');
      }
      need('diagnostics.sequence.motion', typeof sequence.motion === 'string' && sequence.motion.length > 0, 'must name the motion source');
      need('diagnostics.sequence.motionReason', typeof sequence.motionReason === 'string' && sequence.motionReason.length > 0, 'must state that this is not physics');
    }
  }

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
