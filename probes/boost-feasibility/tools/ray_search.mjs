// Find a static wall near the fixture straight so a force vs post-tick velocity
// collision test can be aimed at it. Read-only probe; writes nothing.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MODULE = path.join(ROOT, '_work/boost-feasibility/module/boost_probe.mjs');
const LEVEL = path.join(ROOT, 'game-data/Blur/levels/usa_la_river/Level.levelphysics');
const FIELDS = path.join(ROOT, '_work/e1-drive/cars/corvette-zr1-stock.fields');

const factory = (await import(pathToFileURL(MODULE).href)).default;
const m = await factory();
const levelBytes = readFileSync(LEVEL);
const fieldBytes = readFileSync(FIELDS);
const levelPtr = m._malloc(levelBytes.length);
const fieldsPtr = m._malloc(fieldBytes.length + 1);
m.HEAPU8.set(levelBytes, levelPtr);
m.HEAPU8.set(fieldBytes, fieldsPtr);
if (!m._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length, 281.2833, 1823.6890, 0)) {
  throw new Error(m.UTF8ToString(m._e1_last_error()));
}
const info = JSON.parse(m.UTF8ToString(m._e1_info()));
const probe = (x, y, z, dx, dy, dz, dist) =>
  JSON.parse(m.UTF8ToString(m._e1_ray_probe(x, y, z, dx, dy, dz, dist)));

const hits = [];
for (let deg = -180; deg < 180; deg += 5) {
  const yaw = (deg * Math.PI) / 180;
  const r = probe(info.startX, info.startY + 0.5, info.startZ, Math.sin(yaw), 0, Math.cos(yaw), 250);
  if (r.hit === 1 && r.distance < 120) hits.push({ deg, distance: +r.distance.toFixed(2), point: r.point.map((v) => +v.toFixed(2)) });
}
hits.sort((a, b) => a.distance - b.distance);
console.log(JSON.stringify(hits.slice(0, 30), null, 1));
