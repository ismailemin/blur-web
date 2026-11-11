// Build the E1 map artifacts for a committed map-batch level.
//
//   node probes/e1-drive/tools/build_map_batch.mjs
//   node probes/e1-drive/tools/build_map_batch.mjs --map observatory
//   node probes/e1-drive/tools/build_map_batch.mjs --check   (re-build and compare)
//
// This is the E1 entry point for the map-batch packages. The conversion itself
// lives in `probes/map-batch/tools/build_e1_package.py` (it needs the committed
// collision buffers and the JavaScript-compatible canonical JSON serializer);
// this wrapper resolves the bundled Python, forwards the arguments, and then
// re-checks the generated documents with the page's own hash:
//
//   * `map.json` content hash == `hashOf(map body)`;
//   * `layout.json` content hash == `hashOf(layout body)`;
//   * the layout is the committed `probes/map-laps/data/<map>-path.json` verbatim.
//
// Inputs (read-only): `_work/map-batch/<level>/` and the committed path document.
// Outputs (generated game data, never committed):
//   _work/e1-drive/<map>/map.json
//   _work/e1-drive/<map>/layout.json
// A changed package is a hard failure: the file and content hashes are also the
// page's pin set.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashOf } from '../web/packet-hash.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BUILDER = path.join(ROOT, 'probes/map-batch/tools/build_e1_package.py');

const MAPS = Object.freeze({
  observatory: Object.freeze({
    id: 'observatory',
    level: 'usa_la_observatory',
    outDir: '_work/e1-drive/observatory',
    layout: 'probes/map-laps/data/observatory-path.json'
  }),
  downtown: Object.freeze({
    id: 'downtown',
    level: 'usa_la_downtown',
    outDir: '_work/e1-drive/downtown',
    layout: 'probes/map-laps/data/downtown-path.json'
  }),
  mharuna: Object.freeze({
    id: 'mharuna',
    level: 'jpn_mharuna',
    outDir: '_work/e1-drive/mharuna',
    layout: 'probes/map-laps/data/mharuna-path.json'
  }),
  highrise: Object.freeze({
    id: 'highrise',
    level: 'usa_la_multiplayer_highrise',
    outDir: '_work/e1-drive/highrise',
    layout: 'probes/map-laps/data/highrise-path.json'
  }),
  shutoko: Object.freeze({
    id: 'shutoko',
    level: 'jpn_tokyo_shutoko',
    outDir: '_work/e1-drive/shutoko',
    layout: 'probes/map-laps/data/shutoko-path.json'
  }),
  oval: Object.freeze({
    id: 'oval',
    level: 'spa_barcelona_oval',
    outDir: '_work/e1-drive/oval',
    layout: 'probes/map-laps/data/oval-path.json'
  }),
  'amboy-mp': Object.freeze({
    id: 'amboy-mp',
    level: 'usa_amboy_multiplayer',
    outDir: '_work/e1-drive/amboy-mp',
    layout: 'probes/map-laps/data/amboy-mp-path.json'
  }),
  dumbo: Object.freeze({
    id: 'dumbo',
    level: 'usa_ny_dumbo',
    outDir: '_work/e1-drive/dumbo',
    layout: 'probes/map-laps-aid/data/dumbo-aid-path.json'
  }),
  'downtown-mp': Object.freeze({
    id: 'downtown-mp',
    level: 'usa_la_downtown_multiplayer',
    outDir: '_work/e1-drive/downtown-mp',
    layout: 'probes/map-laps-aid/data/downtown-mp-aid-path.json'
  }),
  sausalito: Object.freeze({
    id: 'sausalito',
    level: 'usa_sanfran_sausalito',
    outDir: '_work/e1-drive/sausalito',
    layout: 'probes/map-laps-aid/data/sausalito-raster-layout.json'
  }),
  // Hackney's course is the draw-covered component path truncated at 640 m: the
  // full geodesic has a ~4 m hairpin at arc 660 that the committed controller
  // cannot drive (the AI stops there). It is not the retail .aid line.
  hackney: Object.freeze({
    id: 'hackney',
    level: 'uk_london_hackney',
    outDir: '_work/e1-drive/hackney',
    layout: 'probes/map-laps-aid/data/hackney-covered-path.json'
  })
});

function resolvePython() {
  const index = process.argv.indexOf('--python');
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (process.env.BLUR_PYTHON) return process.env.BLUR_PYTHON;
  const bundled = 'C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
  return existsSync(bundled) ? bundled : 'python';
}

const sha256 = (buffer) => 'sha256:' + createHash('sha256').update(buffer).digest('hex');
const readJson = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));

const argv = process.argv.slice(2);
const args = [];
for (let index = 0; index < argv.length; index++) {
  if (argv[index] === '--python') { index++; continue; }
  args.push(argv[index]);
}
const check = args.includes('--check');
const mapArg = args.includes('--map') ? args[args.indexOf('--map') + 1] : 'all';
const keys = mapArg === 'all' ? Object.keys(MAPS) : [mapArg];
if (keys.some((key) => !MAPS[key])) {
  throw new Error('unknown --map ' + JSON.stringify(mapArg) + ' (use ' + Object.keys(MAPS).join(', ') + ')');
}

const python = resolvePython();
const result = spawnSync(python, [BUILDER, '--map', mapArg, ...(check ? ['--check'] : [])], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024
});
if (result.status !== 0) {
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  process.exit(result.status ?? 1);
}

const report = [];
for (const key of keys) {
  const config = MAPS[key];
  const mapBytes = readFileSync(path.join(ROOT, config.outDir, 'map.json'));
  const layoutBytes = readFileSync(path.join(ROOT, config.outDir, 'layout.json'));
  const map = JSON.parse(mapBytes.toString('utf8'));
  const layout = JSON.parse(layoutBytes.toString('utf8'));
  const mapBody = { ...map };
  delete mapBody.hash;
  const layoutBody = { ...layout };
  delete layoutBody.hash;
  if (hashOf(mapBody) !== map.hash) {
    throw new Error(config.outDir + '/map.json content hash does not match its body');
  }
  if (hashOf(layoutBody) !== layout.hash) {
    throw new Error(config.outDir + '/layout.json content hash does not match its body');
  }
  const committedLayout = readFileSync(path.join(ROOT, config.layout));
  if (!layoutBytes.equals(committedLayout)) {
    throw new Error(config.outDir + '/layout.json is not the committed ' + config.layout);
  }
  report.push({
    mapId: config.id,
    level: config.level,
    files: {
      map: { path: config.outDir + '/map.json', bytes: mapBytes.byteLength, sha256: sha256(mapBytes), contentHash: map.hash },
      layout: { path: config.outDir + '/layout.json', bytes: layoutBytes.byteLength, sha256: sha256(layoutBytes), contentHash: layout.hash }
    },
    counts: map.counts,
    pins: {
      mapFileSha256: sha256(mapBytes),
      mapContentHash: map.hash,
      layoutFileSha256: sha256(layoutBytes),
      layoutContentHash: layout.hash,
      renderFileSha256: map.source.render.sha256,
      renderContentHash: map.source.render.contentHash,
      sliceFileSha256: map.source.slice.sha256,
      sliceContentHash: map.source.slice.contentHash,
      physicsFileSha256: map.source.physics.sha256,
      physicsBytes: map.source.physics.bytes,
      draws: map.counts.draws,
      drawTriangles: map.counts.drawTriangles,
      textures: map.counts.textures,
      textureBytes: map.counts.textureBytes,
      vertices: map.counts.vertices,
      indices: map.counts.indices,
      decalDraws: map.counts.decalDraws,
      diagnosticDraws: map.counts.diagnosticDraws,
      blockedDraws: map.counts.blockedDraws,
      unsupportedSections: map.mapRender.unsupportedSections,
      instanceDescriptions: map.mapRender.instances.descriptions,
      collisionTriangles: map.counts.collisionTriangles,
      pathLengthMetres: layout.course.lengthMetres,
      checkpointArcs: [layout.gates[1].arc, layout.gates[2].arc],
      sampleCount: layout.course.sampleCount,
      renderLabel: map.mapRender.label,
      courseId: layout.courseId
    }
  });
}

console.log(JSON.stringify({ mode: check ? 'check' : 'build', ok: true, maps: report }, null, 2));
