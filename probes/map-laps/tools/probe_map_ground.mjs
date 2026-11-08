// Engine ground coverage of a map: does the engine's own collision cache see
// the measured point-to-point path and the candidate loop lines?
//
// Creates one world at the map spawn (which needs ground under it) and then
// calls `e1_ground_probe` at every measured path sample (2 m spacing) and at
// every candidate loop start / quarter / half / three-quarter point. It records
// `hit` and `cachedTriangles`, the number of collision triangles the engine's
// FillCache put in the probe box.
//
// Read-only use of the committed e1_drive wasm. No e1-drive file is modified.
//
//   node probes/map-laps/tools/probe_map_ground.mjs --level spa_barcelona_gracia
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const E1 = path.join(ROOT, '_work/e1-drive');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf('--' + name);
  return at >= 0 ? argv[at + 1] : fallback;
};
const level = arg('level', 'usa_amboy');
const dir = path.resolve(ROOT, arg('dir', '_work/map-laps/' + level));
const outArg = arg('out', '_work/map-laps/' + level + '/ground-coverage.json');

const loopsDoc = JSON.parse(readFileSync(path.join(dir, 'loops.json'), 'utf8'));
const pathDoc = JSON.parse(readFileSync(path.join(ROOT, loopsDoc.inputs.pathDoc.path), 'utf8'));
const levelBytes = readFileSync(path.join(ROOT, loopsDoc.inputs.physics.path));
const roster = JSON.parse(readFileSync(path.join(E1, 'cars.json'), 'utf8'));
const car = roster.roster.cars.find((entry) => entry.slug === 'corvette-zr1-stock');
const fieldBytes = readFileSync(path.join(ROOT, car.fields.path));

const factory = (await import(pathToFileURL(path.join(E1, 'module/e1_drive.mjs')).href)).default;
const module = await factory();
const levelPtr = module._malloc(levelBytes.length);
const fieldsPtr = module._malloc(fieldBytes.length);
module.HEAPU8.set(levelBytes, levelPtr);
module.HEAPU8.set(fieldBytes, fieldsPtr);

const spawn = loopsDoc.inputs.spawn;
const created = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length,
  spawn.x, spawn.z, spawn.heading);
if (!created) throw new Error('create failed: ' + module.UTF8ToString(module._e1_last_error()));
const info = JSON.parse(module.UTF8ToString(module._e1_info()));
const probe = (x, z) => JSON.parse(module.UTF8ToString(module._e1_ground_probe(x, z)));

function summarise(samples) {
  let hit = 0;
  let miss = 0;
  let zeroCache = 0;
  const misses = [];
  for (const s of samples) {
    const p = probe(s.x, s.z);
    if (p.hit) {
      hit += 1;
      s.ground = p.y;
      s.cache = p.cachedTriangles;
    } else {
      miss += 1;
      if (!p.cachedTriangles) zeroCache += 1;
      if (misses.length < 40) misses.push({ x: s.x, z: s.z, cache: p.cachedTriangles });
    }
  }
  return { samples: samples.length, hit, miss, missWithZeroCache: zeroCache, firstMisses: misses };
}

const pathPts = pathDoc.samples.map((p) => ({ x: p.x, z: p.z }));
const pathSummary = summarise(pathPts.slice(0, Math.min(pathPts.length, 400)));

const loopSummary = [];
for (const loop of loopsDoc.loops) {
  const n = loop.points.length;
  const picks = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4)]
    .map((i) => ({ x: loop.points[i][0], z: loop.points[i][1] }));
  loopSummary.push({ id: loop.id, component: loop.component,
    probes: picks.map((p) => {
      const r = probe(p.x, p.z);
      return { x: p.x, z: p.z, hit: r.hit ? 1 : 0, ground: r.hit ? r.y : null,
               cachedTriangles: r.cachedTriangles };
    }),
  });
}

module._free(levelPtr);
module._free(fieldsPtr);

const doc = {
  kind: 'map-laps.ground-coverage',
  version: 1,
  level,
  engine: { created: Boolean(created), info },
  spawn,
  path: { doc: loopsDoc.inputs.pathDoc.path, pointsTested: pathSummary.samples, ...pathSummary },
  loops: loopSummary,
};
writeFileSync(path.resolve(ROOT, outArg), JSON.stringify(doc, null, 1) + '\n');
console.log(JSON.stringify({
  level,
  created: Boolean(created),
  info,
  path: { tested: pathSummary.samples, hit: pathSummary.hit, miss: pathSummary.miss,
          missWithZeroCache: pathSummary.missWithZeroCache },
  loops: loopSummary.map((l) => ({
    id: l.id,
    probes: l.probes.map((p) => (p.hit ? 'hit' : 'miss:' + p.cachedTriangles)),
  })),
}, null, 1));
