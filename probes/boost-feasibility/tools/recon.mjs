// Reconnaissance run: where does the T-005d straight end, and what does the
// engine do at full throttle from the committed fixture point?
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MODULE = path.join(ROOT, '_work/boost-feasibility/module/boost_probe.mjs');
const LEVEL = path.join(ROOT, 'game-data/Blur/levels/usa_la_river/Level.levelphysics');
const FIELDS = path.join(ROOT, '_work/e1-drive/cars/corvette-zr1-stock.fields');

const factory = (await import(pathToFileURL(MODULE).href)).default;
const module = await factory();
const levelBytes = readFileSync(LEVEL);
const fieldBytes = readFileSync(FIELDS);
const levelPtr = module._malloc(levelBytes.length);
const fieldsPtr = module._malloc(fieldBytes.length + 1);
module.HEAPU8.set(levelBytes, levelPtr);
module.HEAPU8.set(fieldBytes, fieldsPtr);
const create = module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length, 281.2833, 1823.6890, 0);
if (!create) throw new Error(module.UTF8ToString(module._e1_last_error()));
const read = () => JSON.parse(module.UTF8ToString(module._e1_get_state()));
const extra = () => JSON.parse(module.UTF8ToString(module._b_extra()));
const info = JSON.parse(module.UTF8ToString(module._e1_info()));
console.log('info', info);
console.log('ray', module.UTF8ToString(module._e1_ray_probe(281.2833, info.startY, 1823.6890, 0, 0, 1, 200)));

let s = read();
console.log('tick0', JSON.stringify({ tick: s.tick, position: s.position, speed: s.speed, contacts: s.contacts }));
module._e1_set_input(1, 0, 0, 0);
let maxSpeed = 0;
let edgeTick = null;
for (let i = 0; i < 500; i++) {
  module._b_step();
  s = read();
  const e = extra();
  if (s.speed > maxSpeed) maxSpeed = s.speed;
  if (edgeTick === null && s.anyContact === 0) edgeTick = s.tick;
  if (i % 30 === 0 || (edgeTick !== null && s.tick <= edgeTick + 3)) {
    console.log(JSON.stringify({
      tick: s.tick, x: +s.position[0].toFixed(3), y: +s.position[1].toFixed(3), z: +s.position[2].toFixed(3),
      speed: +s.speed.toFixed(3), contacts: s.contacts.join(''), rpm: +e.rpm.toFixed(0), gear: e.gear,
      throttle: +e.throttle.toFixed(3), applied: e.applied, finite: s.finite
    }));
  }
  if (edgeTick !== null && s.tick > edgeTick + 6) break;
}
console.log('summary', JSON.stringify({ maxSpeed, edgeTick, final: read() }));
