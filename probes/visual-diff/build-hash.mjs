// Build hash for the visual-diff baseline store.
//
// The hash answers one question: "do these two captures come from the same
// visual build?" It hashes the bytes of every input that can change a pixel:
//
//   * the whole page module set (probes/e1-drive/web/*.js|mjs|css|html) — the
//     consumer, adapter, app, scene scripts, styles;
//   * the committed geometry chunks and the wasm engine that drives the state;
//   * the course/layout documents that decide the held tick;
//   * the map packages and their layouts (Amboy / Gracia);
//   * the retail-parity fixed-pose page and its inventory;
//   * the power-up manifests and rules used by the HUD scene;
//   * this harness's own scene catalogue.
//
// A file that is absent is recorded as `missing` and does NOT abort the hash;
// the manifest makes the gap explicit so a baseline cannot silently claim more
// inputs than it actually hashed. `missing` files are a hard failure in
// `verify.mjs` for the files this repository always ships.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const BUILD_HASH_VERSION = 1;

const FIXED_INPUTS = [
  '_work/e1-drive/level.geometry.json',
  '_work/e1-drive/base.geometry.json',
  '_work/e1-drive/cars/corvette-zr1-stock.geometry.json',
  '_work/e1-drive/car-bodies.index.json',
  '_work/e1-drive/spawn.json',
  '_work/e1-drive/module/e1_drive.wasm',
  '_work/e1-drive/sprint.json',
  '_work/e1-drive/sprint-lap.json',
  '_work/e1-drive/sprint-free.json',
  '_work/e1-drive/amboy/map.json',
  '_work/e1-drive/amboy/layout.json',
  '_work/e1-drive/gracia/map.json',
  '_work/e1-drive/gracia/layout.json',
  '_work/powerups/powerups.json',
  '_work/powerups/projectiles.json',
  'probes/powerups/rules/engine.js',
  'probes/powerups/rules/projectiles.js',
  'probes/retail-parity/web/index.html',
  '_work/retail-parity/inventory.json',
  'probes/visual-diff/scenes.mjs'
];

const PAGE_DIR = 'probes/e1-drive/web';

function listPageInputs(root) {
  const directory = path.join(root, PAGE_DIR);
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /\.(js|mjs|css|html)$/.test(name))
    .sort()
    .map((name) => PAGE_DIR + '/' + name);
}

/** Enumerate the input list in a stable order. */
export function buildInputList(root) {
  return [...listPageInputs(root), ...FIXED_INPUTS].sort();
}

/**
 * Hash the inputs. Returns `{ hash, version, algorithm, parts, missing, bytes }`.
 * `parts` are `{ path, bytes, sha256 }` in sorted path order so the manifest can
 * be reviewed without re-hashing.
 */
export function computeBuildHash(root) {
  const inputs = buildInputList(root);
  const parts = [];
  const missing = [];
  let bytes = 0;
  for (const relative of inputs) {
    const absolute = path.join(root, relative);
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      missing.push(relative);
      parts.push({ path: relative, bytes: null, sha256: null });
      continue;
    }
    if (!stat.isFile()) {
      missing.push(relative);
      parts.push({ path: relative, bytes: null, sha256: null });
      continue;
    }
    const sha256 = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    bytes += stat.size;
    parts.push({ path: relative, bytes: stat.size, sha256 });
  }
  const canonical = parts
    .map((part) => part.path + ' ' + (part.sha256 ?? 'missing'))
    .join('\n') + '\n';
  const hash = createHash('sha256').update(canonical).digest('hex');
  return {
    hash,
    version: BUILD_HASH_VERSION,
    algorithm: 'sha256(path + " " + file-sha256, sorted, LF-joined)',
    inputs: inputs.length,
    bytes,
    missing,
    parts
  };
}

/** Short prefix used in baseline file names. */
export function shortHash(hash, length = 10) {
  return String(hash ?? '').slice(0, length);
}
