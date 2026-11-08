// Map package loader / validator for the E1 drive page.
//
// The map documents and layouts are produced by
// `probes/e1-drive/tools/map_package_builder.mjs` (instantiated as
// `build_map_amboy.mjs` and `build_map_gracia.mjs`) from the committed
// map-slice render packages. This module only verifies the pins and merges the
// map half with the existing car-body/material/camera document; it derives no
// map data.

import { hashOf } from './packet-hash.js';
import { sha256Hex } from './sha256.js';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function checkPins(map, layout, pins) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (map?.kind !== 'e1-drive.map-package' || map.version !== 1) fail('map document kind/version is not e1-drive.map-package v1');
  if (layout?.kind !== 'e1-drive.sprint' || layout.version !== 1) fail('layout kind/version is not e1-drive.sprint v1');
  if (typeof map?.hash !== 'string' || !SHA256.test(map.hash)) fail('map content hash is missing');
  if (typeof layout?.hash !== 'string' || !SHA256.test(layout.hash)) fail('layout content hash is missing');
  if (map?.hash !== pins.mapContentHash) fail('map content hash does not match the registry pin');
  if (layout?.hash !== pins.layoutContentHash) fail('layout content hash does not match the registry pin');
  if (map?.source?.render?.sha256 !== pins.renderFileSha256) fail('map source render file does not match the package pin');
  if (map?.source?.render?.contentHash !== pins.renderContentHash) fail('map source render content does not match the package pin');
  if (map?.source?.slice?.sha256 !== pins.sliceFileSha256) fail('map source slice file does not match the package pin');
  if (map?.source?.slice?.contentHash !== pins.sliceContentHash) fail('map source slice content does not match the package pin');
  if (map?.source?.physics?.sha256 !== pins.physicsFileSha256) fail('map physics source does not match the package pin');
  if (map?.source?.physics?.bytes !== pins.physicsBytes) fail('map physics byte length does not match the package pin');
  if (layout?.source?.render?.contentHash !== pins.renderContentHash) fail('layout render source does not match the package pin');
  if (layout?.source?.physics?.sha256 !== pins.physicsFileSha256) fail('layout physics source does not match the package pin');
  return errors;
}

function checkMapShape(map, pins) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const render = map.mapRender;
  if (!render || render.label !== pins.renderLabel) return ['map has no ' + pins.renderLabel + ' render block'];
  const counts = map.counts ?? {};
  if (counts.draws !== pins.draws || render.draws.length !== pins.draws) fail('opaque draw count is not ' + pins.draws);
  if (counts.drawTriangles !== pins.drawTriangles) fail('opaque triangle count is not ' + pins.drawTriangles);
  if (counts.textures !== pins.textures || render.textures.length !== pins.textures) fail('texture count is not ' + pins.textures);
  if (counts.textureBytes !== pins.textureBytes) fail('texture byte count is not ' + pins.textureBytes);
  if (counts.vertices !== pins.vertices || render.vertexCount !== pins.vertices) fail('vertex count is not ' + pins.vertices);
  if (counts.indices !== pins.indices) fail('index count is not ' + pins.indices);
  if (counts.blockedDraws !== pins.blockedDraws) fail('blocked draw count is not ' + pins.blockedDraws);
  if (counts.decalDraws !== pins.decalDraws) fail('decal draw count is not ' + pins.decalDraws);
  if (counts.diagnosticDraws !== pins.diagnosticDraws) fail('diagnostic draw count is not ' + pins.diagnosticDraws);
  if (counts.collisionTriangles !== pins.collisionTriangles) fail('collision triangle count is not ' + pins.collisionTriangles);
  if (render.blocked?.effectDecal?.draws !== pins.decalDraws) fail('the separate decal list is not ' + pins.decalDraws + ' draws');
  if (render.blocked?.diagnosticOnly?.draws !== pins.diagnosticDraws) fail('the diagnostic list is not ' + pins.diagnosticDraws + ' draws');
  if (render.instances?.applied !== false || render.instances?.descriptions !== pins.instanceDescriptions) {
    fail('map does not declare the skipped ' + pins.instanceDescriptions + ' instance descriptions');
  }
  if (render.unsupportedSections !== pins.unsupportedSections) fail('unsupported section count is not ' + pins.unsupportedSections);
  if (render.normals?.vertexNormals !== 0 || !/derivative/i.test(render.normals?.fallback ?? '')) {
    fail('map does not declare the no-vertex-normal / derivative-normal fallback');
  }
  if (!Array.isArray(map.meshes) || map.meshes.length !== 1 || map.meshes[0].id !== render.meshId) fail('map mesh set is not the single merged mesh');
  if (!map.meshes?.[0]?.uv || map.meshes[0].uv.vertexCount !== pins.vertices) fail('map UV0 stream is missing or the wrong length');
  const textureIds = new Set(render.textures.map((texture) => texture.id));
  for (const draw of render.draws) {
    if (draw.indexCount % 3 !== 0 || draw.indexOffset + draw.indexCount > pins.indices) {
      fail('draw ' + draw.id + ' has an invalid index range');
      break;
    }
    if (!textureIds.has(draw.textureId)) {
      fail('draw ' + draw.id + ' names an unknown texture');
      break;
    }
  }
  for (const texture of render.textures) {
    if (!texture.rgbaBase64 || texture.rgbaBytes !== texture.width * texture.height * 4) {
      fail('texture ' + texture.id + ' has no usable RGBA payload');
      break;
    }
  }
  return errors;
}

function checkLayoutShape(layout, pins) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const courseId = pins.courseId;
  if (layout.courseId !== courseId) fail('layout courseId is not ' + courseId);
  if (layout.course?.sampleCount !== pins.sampleCount || layout.course?.samples?.length !== pins.sampleCount) {
    fail('layout is not the ' + pins.sampleCount + '-point measured path');
  }
  if (!(Math.abs(layout.course?.lengthMetres - pins.pathLengthMetres) < 2e-6)) fail('layout length is not the measured path');
  if (!Array.isArray(layout.gates) || layout.gates.length !== 4) fail('layout needs a start, two checkpoints and a finish');
  else {
    const kinds = layout.gates.map((gate) => gate.kind);
    if (kinds.join(',') !== 'start,checkpoint,checkpoint,finish') fail('layout gate order is not start..finish');
    for (let index = 0; index < layout.gates.length; index++) {
      const gate = layout.gates[index];
      if (gate.index !== index) fail('gate ' + gate.id + ' has the wrong index');
      if (!Number.isFinite(gate.x) || !Number.isFinite(gate.z) || !Number.isFinite(gate.arc) || !Number.isFinite(gate.headingRad)) {
        fail('gate ' + gate.id + ' is not finite');
      }
      if (index > 0 && !(gate.arc > layout.gates[index - 1].arc)) fail('gate ' + gate.id + ' is not ahead of the previous gate');
      if (!Array.isArray(gate.a) || !Array.isArray(gate.b) || gate.a.some((v) => !Number.isFinite(v))) {
        fail('gate ' + gate.id + ' has no finite line');
      }
      const dot = gate.tangent.tx * (gate.b[0] - gate.a[0]) + gate.tangent.tz * (gate.b[1] - gate.a[1]);
      if (Math.abs(dot) > 0.02) fail('gate ' + gate.id + ' line is not perpendicular to the measured tangent');
    }
    if (Math.abs(layout.gates[1].arc - pins.checkpointArcs[0]) > 2e-5) {
      fail('checkpoint 1 arc is not the measured ' + pins.checkpointArcs[0] + ' m');
    }
    if (Math.abs(layout.gates[2].arc - pins.checkpointArcs[1]) > 2e-5) {
      fail('checkpoint 2 arc is not the measured ' + pins.checkpointArcs[1] + ' m');
    }
    if (Math.abs(layout.gates[3].arc - layout.course.finishArc) > 1e-9) fail('finish gate is not the path end');
  }
  for (let index = 0; index < layout.course.samples.length; index++) {
    const sample = layout.course.samples[index];
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.z) || !Number.isFinite(sample.groundY) || !Number.isFinite(sample.arc)) {
      fail('sample ' + index + ' is not finite');
      break;
    }
    if (index > 0 && !(sample.arc >= layout.course.samples[index - 1].arc)) {
      fail('sample arcs are not monotonic at ' + index);
      break;
    }
  }
  if (layout.course?.band?.halfWidthMetres !== 6) fail('layout band is not the declared 6 m controller/respawn band');
  if (layout.countdown?.ticks !== 90) fail('layout countdown is not 90 ticks');
  if (!layout.rules?.respawn) fail('layout has no respawn rule');
  return errors;
}

/**
 * Validate the fetched map and layout documents against the registry pins.
 * Returns `{ ok, errors }`; the page throws on any error (no fallback map).
 */
export function validateMapPackage(map, layout, pins) {
  const errors = [
    ...checkPins(map, layout, pins),
    ...checkMapShape(map, pins),
    ...checkLayoutShape(layout, pins)
  ];
  if (typeof layout.hash === 'string') {
    const body = { ...layout };
    delete body.hash;
    if (hashOf(body) !== layout.hash) errors.push('layout hash does not match its content (hand-edited layout.json?)');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Merge the map half with the existing car-body/material/camera document.
 * River fields that the packet adapter would otherwise read are replaced with
 * empty/map values, never left as River data.
 */
export function mergeMapGeometry(base, map, meta) {
  const render = map.mapRender;
  const mapId = meta?.id ?? map.mapRender?.label?.replace(/-direct-draws$/, '') ?? 'map';
  const label = meta?.label ?? mapId;
  const level = meta?.level ?? map.level;
  const packageLabel = map.source?.render?.path?.split('/')[2] ?? (render.label.replace(/-direct-draws$/, '') + '-render');
  return {
    ...base,
    version: 6,
    source: map.source,
    map: {
      id: mapId,
      label,
      level,
      packageLabel,
      renderLabel: render.label,
      hash: map.hash,
      counts: map.counts,
      source: map.source,
      limits: render.limits
    },
    meshes: map.meshes,
    mapRender: render,
    levelDraws: [],
    levelTextures: [],
    levelPropTexturePack: null,
    levelInstances: { emitted: 0, omitted: 0, culled: 0 },
    textures: render.textures,
    lightmaps: Array.isArray(render.lightmaps) ? render.lightmaps : [],
    texturePack: render.texturePack,
    trackVisual: render,
    collisionSurface: render.collisionSurface
  };
}

/** SHA-256 of a fetched text body, for the layout/package file pins. */
export function textSha256(text) {
  return 'sha256:' + sha256Hex(text);
}

/** SHA-256 of fetched bytes through WebCrypto (native, async). */
export async function bytesSha256(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('crypto.subtle is unavailable: the map physics pin cannot be verified');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return 'sha256:' + Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}
