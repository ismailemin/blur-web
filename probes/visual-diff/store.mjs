// Baseline store: `<root>/manifest.json` + one PNG per scene/build.
//
// Layout:
//   baselines/
//     manifest.json
//     <scene>/<buildShort>.png
//
// The manifest is keyed by scene id and stores the build hash the baseline was
// captured at, the PNG SHA-256/size, the viewport, the capture evidence, the
// mask rectangles actually used, and a bounded `builds` history (newest 5).
// Comparison uses `current`; a changed build hash is reported but does not by
// itself fail the gate (that would make every code change fail), unless
// `--require-build-match` is passed.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';

export const BASELINE_KIND = 'blur-web.visual-diff.baselines';
export const BASELINE_VERSION = 1;
export const MAX_BUILD_HISTORY = 5;

export function manifestPath(root) {
  return path.join(root, 'manifest.json');
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Reject absolute paths, `..` escapes and backslash traversal in manifest file names. */
export function safeBaselinePath(root, relative) {
  if (typeof relative !== 'string' || !relative.trim()) throw new Error('baseline entry has no file');
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    throw new Error('baseline file must be relative: ' + relative);
  }
  const normalized = path.posix.normalize(relative.replace(/\\/g, '/'));
  if (normalized.startsWith('../') || normalized === '..' || normalized.includes('/../')) {
    throw new Error('baseline file escapes the store: ' + relative);
  }
  const absolute = path.resolve(root, normalized);
  const base = path.resolve(root);
  if (absolute !== base && !absolute.startsWith(base + path.sep)) {
    throw new Error('baseline file escapes the store: ' + relative);
  }
  return absolute;
}

export function emptyManifest() {
  return {
    kind: BASELINE_KIND,
    version: BASELINE_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    build: null,
    scenes: {}
  };
}

/**
 * Load and validate a manifest. Returns `{ exists, manifest, error }`; a corrupt
 * manifest is an error (never silently treated as an empty store).
 */
export function loadManifest(root) {
  const file = manifestPath(root);
  if (!existsSync(file)) return { exists: false, manifest: emptyManifest(), error: null, file };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { exists: true, manifest: null, error: 'baseline manifest is not JSON: ' + error.message, file };
  }
  if (parsed.kind !== BASELINE_KIND) {
    return { exists: true, manifest: null, error: 'baseline manifest kind is ' + JSON.stringify(parsed.kind), file };
  }
  if (parsed.version !== BASELINE_VERSION) {
    return { exists: true, manifest: null, error: 'baseline manifest version is ' + JSON.stringify(parsed.version), file };
  }
  if (!parsed.scenes || typeof parsed.scenes !== 'object') {
    return { exists: true, manifest: null, error: 'baseline manifest has no scenes object', file };
  }
  return { exists: true, manifest: parsed, error: null, file };
}

export function saveManifest(root, manifest) {
  mkdirSync(root, { recursive: true });
  manifest.updatedAt = new Date().toISOString();
  const file = manifestPath(root);
  const temporary = file + '.tmp';
  writeFileSync(temporary, JSON.stringify(manifest, null, 1) + '\n', 'utf8');
  renameSync(temporary, file);
  return file;
}

/**
 * Store one captured PNG as the current baseline for a scene.
 *
 * `capture` is the capture-manifest scene record: `{ id, file, sha256, width,
 * height, viewport, masks, mechanism, url, capturedAt, evidence }`.
 * The PNG is read from `captureFile` and copied into `<root>/<scene>/<build>.png`.
 */
export function writeBaselineScene({ root, manifest, scene, capture, pngBuffer, build }) {
  if (!scene || !scene.id) throw new Error('writeBaselineScene needs a scene');
  if (!capture) throw new Error('writeBaselineScene needs a capture record for ' + scene.id);
  if (!Buffer.isBuffer(pngBuffer) || !pngBuffer.length) throw new Error('writeBaselineScene needs PNG bytes');
  const image = decodePng(pngBuffer);
  const buildHash = build?.hash ?? null;
  if (!buildHash) throw new Error('writeBaselineScene needs a build hash');
  const directory = path.join(root, scene.id);
  mkdirSync(directory, { recursive: true });
  const fileName = scene.id + '/' + buildHash.slice(0, 12) + '.png';
  const absolute = safeBaselinePath(root, fileName);
  writeFileSync(absolute, pngBuffer);
  const digest = sha256(pngBuffer);
  const capturedAt = new Date().toISOString();
  const entry = {
    currentBuild: buildHash,
    current: {
      file: fileName,
      sha256: digest,
      bytes: pngBuffer.length,
      width: image.width,
      height: image.height,
      buildHash,
      capturedAt,
      viewport: capture.viewport ?? null,
      mechanism: scene.mechanism ?? null,
      url: capture.url ?? null,
      masks: capture.masks ?? [],
      overlays: scene.overlays ?? null,
      evidence: capture.evidence ?? null
    },
    builds: []
  };
  const previous = manifest.scenes[scene.id];
  const history = [
    { buildHash, file: fileName, sha256: digest, capturedAt },
    ...((previous?.builds ?? []).filter((entry_) => entry_.buildHash !== buildHash))
  ];
  entry.builds = history.slice(0, MAX_BUILD_HISTORY);
  // Drop files that fell out of the bounded history (never the current file).
  for (const stale of history.slice(MAX_BUILD_HISTORY)) {
    if (stale.file === fileName) continue;
    try {
      const staleAbsolute = safeBaselinePath(root, stale.file);
      if (existsSync(staleAbsolute)) rmSync(staleAbsolute);
    } catch {
      // A stale file that cannot be removed is not a correctness problem.
    }
  }
  manifest.scenes[scene.id] = entry;
  return entry;
}

/**
 * Verify that the baseline file on disk still matches the manifest digest.
 * Returns `{ ok, reason, bytes, image }`.
 */
export function readBaselineScene({ root, sceneId, entry }) {
  if (!entry || !entry.current) return { ok: false, reason: 'no current baseline entry', bytes: null, image: null };
  let absolute;
  try {
    absolute = safeBaselinePath(root, entry.current.file);
  } catch (error) {
    return { ok: false, reason: error.message, bytes: null, image: null };
  }
  if (!existsSync(absolute)) return { ok: false, reason: 'baseline file is missing: ' + entry.current.file, bytes: null, image: null };
  const bytes = readFileSync(absolute);
  const digest = sha256(bytes);
  if (entry.current.sha256 && digest !== entry.current.sha256) {
    return {
      ok: false,
      reason: 'baseline SHA-256 mismatch (manifest ' + entry.current.sha256.slice(0, 12) +
        '…, file ' + digest.slice(0, 12) + '…)',
      bytes,
      image: null
    };
  }
  let image;
  try {
    image = decodePng(bytes);
  } catch (error) {
    return { ok: false, reason: 'baseline PNG is not decodable: ' + error.message, bytes, image: null };
  }
  return { ok: true, reason: null, bytes, image, absolute };
}

/** Scene ids in a manifest that are not in the current catalogue. */
export function unusedBaselines(manifest, sceneIds) {
  return Object.keys(manifest?.scenes ?? {}).filter((id) => !sceneIds.includes(id)).sort();
}
