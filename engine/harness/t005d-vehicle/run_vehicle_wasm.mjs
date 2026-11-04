// Node driver for the T-005d vehicle spike module.
//
//   node run_vehicle_wasm.mjs <vehicle.mjs> <Level.levelphysics> <car.fields> <out.json>
//
// Exit codes: 0 ok, 1 usage, 2 module failure / document error.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [modulePath, levelPath, fieldsPath, outputPath] = process.argv.slice(2);
if (!modulePath || !levelPath || !fieldsPath || !outputPath) {
  console.error('usage: node run_vehicle_wasm.mjs <vehicle.mjs> <Level.levelphysics> <car.fields> <out.json>');
  process.exit(1);
}

const factory = (await import(pathToFileURL(modulePath).href)).default;
const module = await factory();

const level = await readFile(levelPath);
const fields = await readFile(fieldsPath, 'utf8');

const levelPtr = module._malloc(level.length);
const fieldsPtr = module._malloc(fields.length + 1);
if (!levelPtr || !fieldsPtr) {
  console.error('wasm malloc failed');
  process.exit(2);
}
module.HEAPU8.set(level, levelPtr);
module.HEAPU8.set(Buffer.from(fields, 'utf8'), fieldsPtr);

// scenario: the fixed start point is the contact x/z of the committed collision
// oracle fixture `ray-random-21`, whose surface normal is (0, 0.999, 0): a flat
// piece of usa_la_river road. 180 ticks at rest, then 300 ticks of full throttle.
const jsonPtr = module._vehicle_run(levelPtr, level.length, fieldsPtr, fields.length,
                                    281.2833, 1823.6890, 180, 300, 1.0, 0.0, 1.0 / 60.0);
module._free(levelPtr);
module._free(fieldsPtr);
if (jsonPtr === 0) {
  console.error('vehicle_run returned null');
  process.exit(2);
}
const json = module.UTF8ToString(jsonPtr);
await writeFile(outputPath, json, 'utf8');

const parsed = JSON.parse(json);
if (parsed.status !== 'ok') {
  console.error(`vehicle_run status: ${parsed.status} ${JSON.stringify(parsed.error ?? parsed.stage ?? {})}`);
  process.exit(3);
}
console.log(`ticks ${parsed.summary.settleTicks}+${parsed.summary.driveTicks} contactTicks=${parsed.summary.contactTicks} nanTicks=${parsed.summary.nanTicks}`);
console.log(`settleStateHash ${parsed.summary.settleStateHash}`);
console.log(`driveStateHash  ${parsed.summary.driveStateHash}`);
console.log(`allStateHash    ${parsed.summary.allStateHash}`);
