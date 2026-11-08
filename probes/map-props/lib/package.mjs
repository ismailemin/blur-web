/*
 * package.mjs — read-only loader for a committed map-slice render package.
 *
 * This module only reads committed inputs:
 *   _work/map-slice/<map>-render/{render.json,diagnostics.json,*.bin}
 *   _work/map-slice/<map>/{slice.json,collision.*.bin}
 *
 * Nothing is decoded, transformed or invented.  Buffer hashes are checked
 * against the package manifest, and the draw index ranges (opaque list plus
 * diagnostics list) must tile the shared index buffer exactly once.  A failed
 * check throws; there is no silent fallback.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

export const MAPS = Object.freeze({
  amboy: {
    level: "usa_amboy",
    packageDir: "_work/map-slice/amboy-render",
    sliceDir: "_work/map-slice/amboy",
  },
  gracia: {
    level: "spa_barcelona_gracia",
    packageDir: "_work/map-slice/gracia-render",
    sliceDir: "_work/map-slice/gracia",
  },
});

export const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
export const sha256Text = (text) => sha256(Buffer.from(text, "utf8"));

/** Copy a Buffer into an aligned typed array (byteOffset may be pooled). */
function toFloat32(buf, count) {
  const copy = new Uint8Array(buf.length);
  copy.set(buf);
  return new Float32Array(copy.buffer, 0, count);
}
function toUint32(buf, count) {
  const copy = new Uint8Array(buf.length);
  copy.set(buf);
  return new Uint32Array(copy.buffer, 0, count);
}

export function readBuffer(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath));
}

export function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), "utf8"));
}

function requireEqual(name, actual, expected, checks) {
  const ok = actual === expected;
  checks.push({ name, ok, actual, expected });
  if (!ok) throw new Error(`${name}: actual ${actual} !== expected ${expected}`);
  return ok;
}

/** Load and validate one map package.  Returns typed arrays plus raw manifests. */
export function loadMapPackage(mapKey) {
  const meta = MAPS[mapKey];
  if (!meta) throw new Error(`unknown map "${mapKey}"`);
  const checks = [];

  const render = readJson(`${meta.packageDir}/render.json`);
  const diagnostics = readJson(`${meta.packageDir}/diagnostics.json`);
  const slice = readJson(`${meta.sliceDir}/slice.json`);

  requireEqual("render.level", render.level, meta.level, checks);
  requireEqual("diagnostics.level", diagnostics.level, meta.level, checks);
  requireEqual("slice.level", slice.level, meta.level, checks);

  // ---- shared geometry buffers (opaque + diagnostics share one buffer) ----
  const posRel = `${meta.packageDir}/${render.buffers.positions.path}`;
  const idxRel = `${meta.packageDir}/${render.buffers.indices.path}`;
  const posBytes = readBuffer(posRel);
  const idxBytes = readBuffer(idxRel);
  requireEqual("positions.bytes", posBytes.length, render.buffers.positions.bytes, checks);
  requireEqual("positions.sha256", sha256(posBytes), render.buffers.positions.sha256, checks);
  requireEqual("indices.bytes", idxBytes.length, render.buffers.indices.bytes, checks);
  requireEqual("indices.sha256", sha256(idxBytes), render.buffers.indices.sha256, checks);
  requireEqual(
    "positions.count*12", posBytes.length,
    render.buffers.positions.count * 12, checks,
  );
  requireEqual(
    "indices.count*4", idxBytes.length,
    render.buffers.indices.count * 4, checks,
  );

  const positions = toFloat32(posBytes, render.buffers.positions.count * 3);
  const indices = toUint32(idxBytes, render.buffers.indices.count);

  // ---- index range tiling: opaque draws + diagnostics draw exactly once ----
  const ranges = [];
  for (const d of render.draws) ranges.push({ list: "opaque", id: d.drawId, first: d.firstIndex, count: d.indexCount });
  for (const d of diagnostics.draws) ranges.push({ list: "diagnostics", id: d.drawId, first: d.firstIndex, count: d.indexCount });
  ranges.sort((a, b) => (a.first === b.first ? a.count - b.count : a.first - b.first));
  let cursor = 0;
  let gapRows = 0;
  let overlapRows = 0;
  for (const r of ranges) {
    if (r.first > cursor) gapRows += 1;
    if (r.first < cursor) overlapRows += 1;
    cursor = Math.max(cursor, r.first + r.count);
  }
  requireEqual("indexRanges.gaps", gapRows, 0, checks);
  requireEqual("indexRanges.overlaps", overlapRows, 0, checks);
  requireEqual("indexRanges.end", cursor, render.buffers.indices.count, checks);
  requireEqual("indexRanges.count", ranges.length, render.counts.draws, checks);

  // ---- collision triangle mesh (ground reference only) ----
  const colPosRel = `${meta.sliceDir}/${slice.collision.positions.file}`;
  const colIdxRel = `${meta.sliceDir}/${slice.collision.indices.file}`;
  const colPosBytes = readBuffer(colPosRel);
  const colIdxBytes = readBuffer(colIdxRel);
  requireEqual("collision.positions.bytes", colPosBytes.length, slice.collision.positions.bytes, checks);
  requireEqual("collision.positions.sha256", sha256(colPosBytes), slice.collision.positions.sha256, checks);
  requireEqual("collision.indices.bytes", colIdxBytes.length, slice.collision.indices.bytes, checks);
  requireEqual("collision.indices.sha256", sha256(colIdxBytes), slice.collision.indices.sha256, checks);
  requireEqual("collision.positions.count*4", colPosBytes.length, slice.collision.positions.count * 4, checks);
  requireEqual("collision.indices.count*4", colIdxBytes.length, slice.collision.indices.count * 4, checks);
  // The slice collision `positions.count` is a float count (3 per vertex).
  requireEqual("collision.positions.count%3", slice.collision.positions.count % 3, 0, checks);
  requireEqual("collision.vertices", slice.collision.positions.count / 3, slice.collision.vertices, checks);
  requireEqual("collision.triangles", slice.collision.indices.count / 3, slice.collision.triangles, checks);

  const collisionMesh = {
    positions: toFloat32(colPosBytes, slice.collision.positions.count),
    indices: toUint32(colIdxBytes, slice.collision.indices.count),
    vertexCount: slice.collision.positions.count / 3,
    indexCount: slice.collision.indices.count,
  };

  // ---- measured layout polyline ----
  const layoutRel = `${meta.packageDir}/${render.layout.pointsFile}`;
  const layoutBytes = readBuffer(layoutRel);
  requireEqual("layout.bytes", layoutBytes.length, render.layout.pointsBytes, checks);
  requireEqual("layout.sha256", sha256(layoutBytes), render.layout.pointsSha256, checks);
  requireEqual(
    "layout.count*12", layoutBytes.length,
    render.layout.pointCount * 12, checks,
  );
  const layoutPoints = toFloat32(layoutBytes, render.layout.pointCount * 3);

  // The measured polyline is (x, z); the third float is the recorded ground.
  const pathPolyline = [];
  const pathGround = new Float32Array(render.layout.pointCount);
  for (let i = 0; i < render.layout.pointCount; i++) {
    pathPolyline.push([layoutPoints[3 * i], layoutPoints[3 * i + 1]]);
    pathGround[i] = layoutPoints[3 * i + 2];
  }

  return {
    mapKey,
    meta,
    checks,
    render,
    diagnostics,
    slice,
    positions,
    indices,
    vertexCount: render.buffers.positions.count,
    indexCount: render.buffers.indices.count,
    collisionMesh,
    layout: render.layout,
    path: pathPolyline,
    pathGround,
    files: {
      render: { path: `${meta.packageDir}/render.json`, sha256: sha256(readBuffer(`${meta.packageDir}/render.json`)) },
      diagnostics: { path: `${meta.packageDir}/diagnostics.json`, sha256: sha256(readBuffer(`${meta.packageDir}/diagnostics.json`)) },
      positions: { path: posRel, bytes: posBytes.length, sha256: sha256(posBytes) },
      indices: { path: idxRel, bytes: idxBytes.length, sha256: sha256(idxBytes) },
      collisionPositions: { path: colPosRel, bytes: colPosBytes.length, sha256: sha256(colPosBytes) },
      collisionIndices: { path: colIdxRel, bytes: colIdxBytes.length, sha256: sha256(colIdxBytes) },
      layout: { path: layoutRel, bytes: layoutBytes.length, sha256: sha256(layoutBytes) },
      slice: {
        path: `${meta.sliceDir}/slice.json`,
        bytes: fs.statSync(path.join(ROOT, `${meta.sliceDir}/slice.json`)).size,
        sha256: sha256(fs.readFileSync(path.join(ROOT, `${meta.sliceDir}/slice.json`))),
      },
    },
  };
}

export function packageFileBytes(relPath) {
  return readBuffer(relPath);
}
