// Static-serving tests for the deploy path.
//
// The page fetches its assets by URL, and a Linux host (the VPS deploy) is
// case-sensitive where Windows and macOS are not. Five retail level directories
// ship `level.levelphysics` while the registry asks for `Level.levelphysics`, so
// a case-sensitive server would 404 highrise, amboy-mp, downtown-mp, bowl and
// showroom. These tests pin the resolver and every registry asset URL against
// the real trees:
//
//   * an exact match is returned unchanged;
//   * a case-only mismatch resolves to the file that exists;
//   * a name that matches nothing stays missing (a 404, never a substitute);
//   * every `physicsUrl` in the registry resolves to a real file.
//
// Usage:
//   node probes/e1-drive/tools/serve_static_tests.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveStaticFile } from './serve.mjs';
import { MAPS, MAP_IDS } from '../web/map-registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

let checks = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  checks += 1;
  if (!ok) failures.push(label + (detail ? ': ' + detail : ''));
};

// ---------------------------------------------------------------- resolver
const scratch = mkdtempSync(path.join(os.tmpdir(), 'blur-static-'));
try {
  mkdirSync(path.join(scratch, 'level'), { recursive: true });
  writeFileSync(path.join(scratch, 'level', 'level.levelphysics'), 'physics');
  writeFileSync(path.join(scratch, 'level', 'Upper.JSON'), '{}');

  const exact = path.join(scratch, 'level', 'Upper.JSON');
  check('an exact match is returned unchanged', resolveStaticFile(exact) === exact,
    resolveStaticFile(exact));

  const wanted = path.join(scratch, 'level', 'Level.levelphysics');
  const resolved = resolveStaticFile(wanted);
  check('a case-only mismatch resolves to the file that exists',
    resolved === path.join(scratch, 'level', 'level.levelphysics'), resolved);

  const missing = path.join(scratch, 'level', 'Absent.levelphysics');
  check('a name that matches nothing stays missing',
    resolveStaticFile(missing) === missing && !existsSync(resolveStaticFile(missing)), missing);

  check('a null path is returned as null', resolveStaticFile(null) === null);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------- registry
// Every map's physics URL must resolve on a case-sensitive host.
const levelRoots = {
  '/map-data/': path.join(ROOT, 'game-data/Blur/levels'),
  '/_work/e1-drive/': path.join(ROOT, '_work/e1-drive')
};
for (const id of MAP_IDS) {
  const map = MAPS[id];
  const url = map.physicsUrl;
  const prefix = Object.keys(levelRoots).find((candidate) => url.startsWith(candidate));
  if (!prefix) {
    check(id + ': physicsUrl uses a served prefix', false, url);
    continue;
  }
  const relative = url.slice(prefix.length);
  const target = path.join(levelRoots[prefix], relative);
  const resolved = resolveStaticFile(target);
  check(id + ': physicsUrl resolves on a case-sensitive host',
    existsSync(resolved), url + ' -> ' + path.relative(ROOT, resolved));
}

if (failures.length) {
  console.error('FAIL ' + failures.length + '/' + checks + ' checks');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}
console.log('ok ' + checks + '/' + checks + ' static-serving checks');
