// What a deploy actually has to copy.
//
// `probes/e1-drive/tools/serve.mjs` serves the page and every asset the page
// fetches. Some of those trees are generated (`_work/`) or come from the
// installed game (`game-data/`) and are deliberately not committed, so a fresh
// clone is not enough to run the game on a host.
//
// This tool lists exactly the trees the server reads, checks that they exist,
// reports the deploy size, and can write the path list for `rsync --files-from`.
// Trees the page never fetches (build/verify inputs) are reported but kept out
// of the deploy list.
//
//   node tools/deploy_assets.mjs                 # check + size report
//   node tools/deploy_assets.mjs --list deploy/assets.txt
//   node tools/deploy_assets.mjs --json
//
// Exit code 1 when a required tree is missing, so a deploy can gate on it.

import { existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every tree `serve.mjs` reads, with the reason it is needed.
//   only:    keep only files whose basename is listed (recursive)
//   exclude: skip these direct children (verification-only artifacts)
//   deploy:  false when the page never fetches the tree (build/verify input)
const TREES = [
  { path: 'probes/e1-drive/web', why: 'the page, its ES modules and the shell mount' },
  { path: 'probes/e1-drive/ghosts', why: 'committed reference ghost traces' },
  { path: 'probes/game-shell', why: 'the menu/mode/car/map shell' },
  { path: 'probes/hud-ui', why: 'the DOM HUD module' },
  { path: 'probes/net-mvp', why: 'the room client/protocol modules' },
  { path: 'probes/race-rules', why: 'the M1 rules modules' },
  { path: 'probes/prop-collision', why: 'the P66 prop resolver' },
  { path: 'probes/map-laps', why: 'measured lap layouts (Amboy loop-01)' },
  { path: 'probes/audio', why: 'the retail event catalog + engine-audio module' },
  { path: 'probes/audio/web', why: 'the engine-audio ES module' },
  { path: 'probes/lighting', why: 'runtime lighting/material tables' },
  { path: 'probes/car-materials', why: 'retail paint and light-colour tables' },
  { path: 'probes/powerups', why: 'the power-up manifest and rules prototype' },
  { path: '_work/e1-drive', why: 'module WASM, map packages, layouts, car bodies, base geometry',
    exclude: ['verify-materials-a', 'verify-materials-b'] },
  { path: '_work/lighting', why: 'decoded retail lightmap RGBA (17 maps)' },
  { path: '_work/audio', why: 'decoded retail WAVs' },
  { path: '_work/powerups', why: 'the PWR1 runtime manifest' },
  { path: '_work/map-props', why: 'Amboy/Gracia prop colliders' },
  { path: '_work/prop-collision', why: 'prop-collision work documents the resolver reads' },
  { path: '_work/free-roam-prop', why: 'the free-roam collider manifest' },
  { path: 'game-data/Blur/levels', why: 'level physics bytes (`/map-data/...`); installed game data',
    only: ['Level.levelphysics'] },
  { path: '_work/map-slice', why: 'build/verify only: the page never fetches it', deploy: false },
  { path: '_work/map-batch', why: 'build/verify only: the page never fetches it', deploy: false }
];

function measure(tree) {
  const absolute = path.join(ROOT, tree.path);
  if (!existsSync(absolute)) return { files: 0, bytes: 0, missing: true };
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path.dirname(full) === absolute && tree.exclude?.includes(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (tree.only && !tree.only.includes(entry.name)) continue;
        files += 1;
        bytes += statSync(full).size;
      }
    }
  };
  walk(absolute);
  return { files, bytes, missing: false };
}

const mib = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';

const rows = TREES.map((tree) => ({ ...tree, ...measure(tree) }));
const missing = rows.filter((row) => row.missing);
const deployRows = rows.filter((row) => row.deploy !== false);
const deployFiles = deployRows.reduce((sum, row) => sum + row.files, 0);
const deployBytes = deployRows.reduce((sum, row) => sum + row.bytes, 0);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ root: ROOT, trees: rows, deployFiles, deployBytes }, null, 2));
} else {
  for (const row of rows) {
    const state = row.missing
      ? 'MISSING'.padEnd(24)
      : (mib(row.bytes) + '  ' + row.files + ' files').padEnd(24);
    const tag = row.deploy === false ? 'skip ' : (row.missing ? 'FAIL ' : 'ok   ');
    console.log(tag + row.path.padEnd(30) + state + '  ' + row.why);
  }
  console.log('');
  console.log('deploy payload: ' + mib(deployBytes) + ' in ' + deployFiles + ' files across ' +
    deployRows.length + ' trees');
}

const listIndex = process.argv.indexOf('--list');
if (listIndex >= 0) {
  const target = process.argv[listIndex + 1];
  if (!target) throw new Error('--list needs a file path');
  const absolute = path.resolve(ROOT, target);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute,
    deployRows.filter((row) => !row.missing).map((row) => row.path + '/').join('\n') + '\n',
    'utf8');
  console.log('wrote ' + target + ' for `rsync --files-from`');
}

if (missing.length) {
  console.error('\nmissing trees: ' + missing.map((row) => row.path).join(', '));
  console.error('Build them locally first: see docs/work/verification/refresh-work-artifacts.md');
  process.exit(1);
}
