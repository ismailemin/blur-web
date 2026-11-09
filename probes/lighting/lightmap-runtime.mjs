// probes/lighting/lightmap-runtime.mjs
//
// Renderer-facing resolver for the exported static-world lightmap pixels.
//
// The committed runtime table (`./runtime-lighting.mjs`) records the decoded
// `g_tLightmap` texture set: names, dimensions, byte counts and hashes. It does
// not carry pixels. `probes/lighting/tools/export_lightmap_rgba.py` writes the
// mip-0 RGBA8 buffers under `_work/lighting/<map>/lightmap/` (gitignored) and an
// `index.json` beside them. This module joins the two: it returns the URL, byte
// count and sha256 of each exported `.rgba` file, plus the committed shader
// rule, without copying or inventing a pixel.
//
// Contract:
//   import {
//     LIGHTMAP_RUNTIME_SCHEMA,
//     LIGHTMAP_MAPS,
//     lightmapSetFor,
//     lightmapTextureFor,
//     lightmapShaderFor
//   } from './probes/lighting/lightmap-runtime.mjs';
//
//   const set = lightmapSetFor('river');
//   // { mapId, count, complete, partial, unsupportedReferences, uvSet:
//   //   'luxlightmap', shader, textures: [...], unsupported: [...] }
//   const texture = lightmapTextureFor('river', 'lightmap_main_000-a');
//   // { name, width, height, url, bytes, sha256 } or null
//   const shader = lightmapShaderFor('river');
//   // { uvSource, sunSky, rgbNormalisedGamma }, verbatim from the table
//
// `url` is `/_work/lighting/<map>/lightmap/<name>.rgba`. The file is raw mip-0
// RGBA8, `width * height * 4` bytes, row-major, row 0 first, channels R,G,B,A,
// no colour transform applied (`colorTransformApplied: false` in the export
// index). `bytes` is that file size and `sha256` is that file's hash, so a
// consumer can verify the download before uploading it as an RGBA8 texture.
//
// Scope labels (do not drop them):
//   - mip 0 only; no mip chain is exported.
//   - no sRGB/codec transform is applied; the bytes are the raw DXT5 texels.
//   - no shader term is applied. `shader.sunSky` and
//     `shader.rgbNormalisedGamma` are the two retail decode rules; which one a
//     material uses is a per-material effect decision.
//   - the set covers the whole level, not the measured map-slice. A renderer
//     that draws a subset still needs the per-material `g_tLightmap` name.
//   - the lightmap UV is `TEXCOORD0.zw` (`uvSet: 'luxlightmap'`); this module
//     does not supply or fabricate a UV stream.
//   - `complete: false` / `partial: true` means the decoded texture set is real
//     but one or more `g_tLightmap` references resolve outside it. Those
//     references are listed in `unsupported` (name, key, count, reason,
//     bytePosition) and have no texture here: a draw that binds one must use its
//     ambient term. `unsupportedReferences` is the number of such references.
//
// Returned objects are deep-frozen. `lightmapSetFor` throws a
// `LightmapRuntimeError` with `code === 'invalid-map-id'`, `'unknown-map'` or
// `'lightmap-unavailable'`. `lightmapTextureFor` returns `null` for a name that
// is not in the set (including a non-string name).

import { LIGHTING_MAPS, lightingFor } from './runtime-lighting.mjs';

export const LIGHTMAP_RUNTIME_SCHEMA = 'blur.lightmap-runtime/1';

/** URL prefix of the exported `.rgba` files, relative to the web root. */
export const LIGHTMAP_URL_PREFIX = '/_work/lighting';

/** Lightmap UV set name (TEXCOORD0.zw, shader/common/Parameters.h:11). */
export const LIGHTMAP_UV_SET = 'luxlightmap';

/** Map ids with a committed runtime entry, in manifest build order. Every map
 * has a decoded lightmap set; `downtown` and `highrise` are partial
 * (`complete: false`) and list their unsupported `g_tLightmap` references.
 * `lightmapSetFor` throws `lightmap-unavailable` for a map with no decoded set
 * instead of returning a placeholder. */
export const LIGHTMAP_MAPS = LIGHTING_MAPS;

/**
 * Typed error raised by the lightmap resolver.
 *
 * `code` is `'invalid-map-id'`, `'unknown-map'`, `'lightmap-unavailable'` or
 * `'invalid-texture-record'`.
 */
export class LightmapRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LightmapRuntimeError';
    this.code = code;
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LightmapRuntimeError('invalid-texture-record',
      'lightmap-runtime: ' + label + ' is not a non-empty string');
  }
  return value;
}

function requireCount(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new LightmapRuntimeError('invalid-texture-record',
      'lightmap-runtime: ' + label + ' is not a positive integer');
  }
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new LightmapRuntimeError('invalid-texture-record',
      'lightmap-runtime: ' + label + ' is not a non-negative integer');
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new LightmapRuntimeError('invalid-texture-record',
      'lightmap-runtime: ' + label + ' is not a lowercase sha256 hex digest');
  }
  return value;
}

function mapLighting(mapId) {
  if (typeof mapId !== 'string') {
    throw new LightmapRuntimeError('invalid-map-id',
      'lightmap-runtime: map id must be a string, got ' + typeof mapId);
  }
  if (!LIGHTING_MAPS.includes(mapId)) {
    throw new LightmapRuntimeError('unknown-map',
      'lightmap-runtime: unknown map ' + JSON.stringify(mapId) +
      ' (use ' + LIGHTING_MAPS.join(', ') + ')');
  }
  return lightingFor(mapId);
}

function buildShader(mapId, lightmap) {
  const shader = lightmap.shader;
  if (!shader || typeof shader !== 'object') {
    throw new LightmapRuntimeError('lightmap-unavailable',
      'lightmap-runtime: map ' + JSON.stringify(mapId) + ' records no shader rule');
  }
  return deepFreeze({
    uvSource: requireString(shader.uvSource, mapId + ' lightmap.shader.uvSource'),
    sunSky: requireString(shader.sunSky, mapId + ' lightmap.shader.sunSky'),
    rgbNormalisedGamma: requireString(shader.rgbNormalisedGamma,
      mapId + ' lightmap.shader.rgbNormalisedGamma')
  });
}

function buildTexture(mapId, texture) {
  const name = requireString(texture.name, mapId + ' lightmap.texture.name');
  const width = requireCount(texture.width, mapId + ' ' + name + ' width');
  const height = requireCount(texture.height, mapId + ' ' + name + ' height');
  const bytes = requireCount(texture.decodedRgbaBytes, mapId + ' ' + name + ' decodedRgbaBytes');
  if (bytes !== width * height * 4) {
    throw new LightmapRuntimeError('invalid-texture-record',
      'lightmap-runtime: ' + mapId + ' ' + name + ' decodedRgbaBytes ' + bytes +
      ' does not equal width*height*4 (' + (width * height * 4) + ')');
  }
  return {
    name,
    width,
    height,
    url: LIGHTMAP_URL_PREFIX + '/' + mapId + '/lightmap/' + name + '.rgba',
    bytes,
    sha256: requireSha256(texture.decodedRgbaSha256,
      mapId + ' ' + name + ' decodedRgbaSha256')
  };
}

function buildUnsupported(mapId, lightmap) {
  const rows = lightmap.unsupported;
  if (!Array.isArray(rows)) {
    throw new LightmapRuntimeError('invalid-texture-record',
      'lightmap-runtime: ' + mapId + ' lightmap.unsupported is not a list');
  }
  return rows.map((row) => ({
    name: row.name ?? null,
    key: row.key ?? null,
    count: requireCount(row.count, mapId + ' lightmap.unsupported.count'),
    reason: requireString(row.reason, mapId + ' lightmap.unsupported.reason'),
    bytePosition: row.bytePosition ?? null
  }));
}

function buildSet(mapId) {
  const lightmap = mapLighting(mapId).lightmap;
  if (!lightmap || lightmap.decoded !== true) {
    throw new LightmapRuntimeError('lightmap-unavailable',
      'lightmap-runtime: map ' + JSON.stringify(mapId) + ' has no decoded lightmap set');
  }
  if (lightmap.uvSet !== LIGHTMAP_UV_SET) {
    throw new LightmapRuntimeError('lightmap-unavailable',
      'lightmap-runtime: map ' + JSON.stringify(mapId) + ' uvSet is ' +
      JSON.stringify(lightmap.uvSet) + ', expected ' + JSON.stringify(LIGHTMAP_UV_SET));
  }
  const textures = lightmap.textures.map((texture) => buildTexture(mapId, texture));
  if (lightmap.count !== textures.length) {
    throw new LightmapRuntimeError('invalid-texture-record',
      'lightmap-runtime: ' + mapId + ' lightmap.count ' + lightmap.count +
      ' does not equal the texture list length ' + textures.length);
  }
  const unsupported = buildUnsupported(mapId, lightmap);
  const complete = lightmap.complete === true;
  if (complete !== (unsupported.length === 0)) {
    throw new LightmapRuntimeError('invalid-texture-record',
      'lightmap-runtime: ' + mapId + ' lightmap.complete ' + complete +
      ' disagrees with ' + unsupported.length + ' unsupported reference(s)');
  }
  const unsupportedReferences = requireNonNegativeInteger(lightmap.unsupportedReferences,
    mapId + ' lightmap.unsupportedReferences');
  const expectedReferences = unsupported.reduce((sum, row) => sum + row.count, 0);
  if (unsupportedReferences !== expectedReferences) {
    throw new LightmapRuntimeError('invalid-texture-record',
      'lightmap-runtime: ' + mapId + ' lightmap.unsupportedReferences ' +
      unsupportedReferences + ' does not equal the typed reference count ' +
      expectedReferences);
  }
  return deepFreeze({
    mapId,
    count: textures.length,
    complete,
    partial: lightmap.partial === true,
    unsupportedReferences,
    uvSet: LIGHTMAP_UV_SET,
    shader: buildShader(mapId, lightmap),
    textures,
    unsupported
  });
}

const CACHE = new Map();

/**
 * Return the exported lightmap set for one map.
 *
 * @param {'river'|'amboy'|'gracia'|'longbeach'|'observatory'|'downtown'|'mharuna'|'highrise'|'shutoko'|'oval'|'amboy-mp'|'dumbo'|'downtown-mp'} mapId
 * @returns {{mapId:string, count:number, complete:boolean, partial:boolean,
 *   unsupportedReferences:number, uvSet:'luxlightmap',
 *   shader:{uvSource:string, sunSky:string, rgbNormalisedGamma:string},
 *   textures:Array<{name:string, width:number, height:number, url:string,
 *     bytes:number, sha256:string}>,
 *   unsupported:Array<{name:string|null, key:number[]|null, count:number,
 *     reason:string, bytePosition:Object|null}>}}
 * @throws {LightmapRuntimeError} `invalid-map-id`, `unknown-map` or
 *   `lightmap-unavailable`.
 */
export function lightmapSetFor(mapId) {
  const cached = CACHE.get(mapId);
  if (cached) return cached;
  const set = buildSet(mapId);
  CACHE.set(mapId, set);
  return set;
}

/**
 * Return one exported lightmap texture record, or `null` when the name is not
 * in the map's set.
 *
 * @param {'river'|'amboy'|'gracia'|'longbeach'|'observatory'|'downtown'|'mharuna'|'highrise'|'shutoko'|'oval'|'amboy-mp'|'dumbo'|'downtown-mp'} mapId
 * @param {string} name retail `g_tLightmap` texture name
 * @returns {{name:string, width:number, height:number, url:string, bytes:number,
 *   sha256:string}|null}
 * @throws {LightmapRuntimeError} for an invalid or unknown map id.
 */
export function lightmapTextureFor(mapId, name) {
  const set = lightmapSetFor(mapId);
  if (typeof name !== 'string') return null;
  return set.textures.find((texture) => texture.name === name) ?? null;
}

/**
 * Return the committed lightmap shader rule for one map, verbatim from the
 * runtime table.
 *
 * @param {'river'|'amboy'|'gracia'|'longbeach'|'observatory'|'downtown'|'mharuna'|'highrise'|'shutoko'|'oval'|'amboy-mp'|'dumbo'|'downtown-mp'} mapId
 * @returns {{uvSource:string, sunSky:string, rgbNormalisedGamma:string}}
 * @throws {LightmapRuntimeError} for an invalid or unknown map id.
 */
export function lightmapShaderFor(mapId) {
  return lightmapSetFor(mapId).shader;
}
