// Record deterministic per-tick physics data for the suspension visualiser.
//
// Inputs (read-only, all local artifacts that already exist in this repository):
//   _work/e1-drive/module/e1_drive.mjs      emscripten factory for e1_get_state
//   _work/e1-drive/Level.levelphysics       the River collision mesh used by e1-drive
//   _work/e1-drive/cars.json                roster entry (field file path)
//   _work/e1-drive/cars/<slug>.fields       RP_CarDynamics field list
//   _work/car-parts/manifest.json           committed wheel groups (rest + bounds)
//
// Output: _work/suspension/scenarios/<scenario>.json plus a `.sha256` sidecar.
// The fixture is evidence, not a committed build input; the verifier reads it.
//
// Usage:
//   node probes/suspension/tools/record_scenario.mjs [--car=corvette-zr1-stock]
//        [--only=rest,brake,turn,rise] [--out=_work/suspension/scenarios]
//
// This tool does not modify e1-drive: it only calls the exported C API.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseFields, configFromFields, cornersFromManifest } from '../lib/car-config.mjs';
import { provisionalSteer, steerByCorner, PROVISIONAL_STEER_SOURCE } from '../lib/steer.mjs';
import { createVisualState, setSettled, advanceSpin, cornerTransforms } from '../lib/transform.mjs';

const ROOT = path.resolve('.');
const E1 = path.join(ROOT, '_work/e1-drive');
const DEFAULT_OUT = path.join(ROOT, '_work/suspension/scenarios');

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) args.set(match[1], match[2]);
  else if (arg.startsWith('--')) args.set(arg.slice(2), 'true');
}
const slug = args.get('car') ?? 'corvette-zr1-stock';
const outDir = path.resolve(args.get('out') ?? DEFAULT_OUT);

const sha256 = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const round = (value, digits = 6) => {
  if (!Number.isFinite(value)) throw new Error('non-finite value in recorded data');
  return Number(value.toFixed(digits));
};
const roundArray = (values, digits = 6) => values.map((value) => round(value, digits));

const scenarioDefinitions = {
  rest: {
    note: 'zero input for 1 s on the settled spawn; proves the visual chain does not move the rest pose',
    lastTick: 60,
    input: () => [0, 0, 0, 0]
  },
  brake: {
    note: 'full throttle 4 s, then full brake 1.5 s; front compression and rear droop',
    lastTick: 330,
    input: (tick) => (tick <= 240 ? [1, 0, 0, 0] : [0, 1, 0, 0])
  },
  turn: {
    note: 'full throttle 2 s, then full throttle with steer=+1 for 1.3 s: a limit corner; the run stops before the slide dominates',
    lastTick: 200,
    input: (tick) => (tick <= 120 ? [1, 0, 0, 0] : [1, 0, 1, 0])
  },
  rise: {
    note: 'full throttle along +X toward the measured 6.36 cm section join at sprint arc 52.19 m; stops before the 57.82 m cliff',
    lastTick: 420,
    input: () => [1, 0, 0, 0],
    stopWhen: (state) => state.position[0] > -32.0
  }
};

function requireFile(file) {
  try {
    return readFileSync(file);
  } catch (error) {
    throw new Error('missing input ' + file + ': ' + error.message);
  }
}

async function main() {
  const roster = JSON.parse(requireFile(path.join(E1, 'cars.json')).toString('utf8')).roster.cars;
  const car = roster.find((entry) => entry.slug === slug);
  if (!car) throw new Error('roster has no car ' + slug);
  const fieldBytes = requireFile(path.join(ROOT, car.fields.path));
  const config = configFromFields(parseFields(fieldBytes.toString('utf8')), {
    slug: car.slug,
    name: car.name,
    record: car.record,
    drivetrain: car.drivetrain
  });
  if (config.missing.some((entry) => !entry.includes('WheelMaxTravel'))) {
    throw new Error('field list is missing required values: ' + config.missing.join(', '));
  }
  const manifestBytes = requireFile(path.join(ROOT, '_work/car-parts/cars', slug, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest?.source?.sourceModelPakPath && !manifest.source.sourceModelPakPath.toLowerCase().includes(slug.replaceAll('-', '_'))) {
    throw new Error('per-car manifest ' + slug + ' names model ' + manifest.source.sourceModelPakPath + '; refusing a cross-car rest pose');
  }
  const corners = cornersFromManifest(manifest);
  const levelBytes = requireFile(path.join(E1, 'Level.levelphysics'));
  const modulePath = path.join(E1, 'module/e1_drive.mjs');
  const wasmBytes = requireFile(path.join(E1, 'module/e1_drive.wasm'));

  const spawn = {
    x: -88,
    z: 1050,
    heading: Math.PI / 2,
    source: 'e1-drive sprint spawn (-88, 1050, heading pi/2); heading aims the car down +X on the short course'
  };

  const factory = (await import(pathToFileURL(modulePath).href)).default;
  const wanted = (args.get('only') ?? Object.keys(scenarioDefinitions).join(',')).split(',').map((value) => value.trim()).filter(Boolean);
  mkdirSync(outDir, { recursive: true });

  for (const name of wanted) {
    const definition = scenarioDefinitions[name];
    if (!definition) throw new Error('unknown scenario ' + name);

    const module = await factory();
    const levelPtr = module._malloc(levelBytes.length);
    const fieldsPtr = module._malloc(fieldBytes.length + 1);
    module.HEAPU8.set(levelBytes, levelPtr);
    module.HEAPU8.set(fieldBytes, fieldsPtr);
    if (!module._e1_create(levelPtr, levelBytes.length, fieldsPtr, fieldBytes.length, spawn.x, spawn.z, spawn.heading)) {
      throw new Error('e1_create failed: ' + module.UTF8ToString(module._e1_last_error()));
    }
    const info = JSON.parse(module.UTF8ToString(module._e1_info()));
    const readState = () => JSON.parse(module.UTF8ToString(module._e1_get_state()));
    const probe = (x, z) => JSON.parse(module.UTF8ToString(module._e1_ground_probe(x, z)));

    const ticks = [];
    let visual = null;
    let previousSteer = 0;
    let settledSuspension = null;
    let stoppedAt = null;

    for (let tick = 0; tick <= definition.lastTick; tick++) {
      if (tick > 0) {
        module._e1_set_input(...definition.input(tick));
        module._e1_step();
      }
      const state = readState();
      if (state.status !== 'ok') throw new Error('state error at tick ' + tick + ': ' + JSON.stringify(state));
      if (!state.finite) throw new Error('non-finite physics state at tick ' + tick);

      if (tick === 0) {
        visual = createVisualState(config.config, corners);
        settledSuspension = setSettled(visual, state.wheels);
      }
      advanceSpin(visual, state.tick, state.wheels, state.dt);

      // Provisional steer, computed once per tick from the exported body state.
      const provisional = provisionalSteer(state.wheels[0], state, config.config, previousSteer, state.dt);
      previousSteer = provisional.steer;
      const steer = steerByCorner(provisional.steer);
      const frame = cornerTransforms(
        {
          tick: state.tick,
          body: {
            position: state.position,
            axisX: state.axisX,
            axisY: state.axisY,
            axisZ: state.axisZ
          },
          wheels: state.wheels
        },
        visual,
        { steerByCorner: steer }
      );

      const wheels = state.wheels.map((wheel, index) => {
        const corner = frame.corners[['frontleft', 'frontright', 'backleft', 'backright'][index]];
        // Independent measured surface under the *visual* wheel centre, so the
        // contact check is not circular with the physics suspension query.
        const ground = probe(corner.centre[0], corner.centre[2]);
        return {
          onGround: wheel.onGround,
          suspension: round(wheel.suspension),
          position: roundArray(wheel.position),
          angular: round(wheel.angular),
          groundNormal: roundArray(wheel.groundNormal),
          visualXZ: [round(corner.centre[0]), round(corner.centre[2])],
          probe: ground.hit
            ? { hit: 1, y: round(ground.y), normal: roundArray(ground.normal) }
            : { hit: 0 }
        };
      });

      ticks.push({
        tick: state.tick,
        dt: round(state.dt),
        body: {
          position: roundArray(state.position),
          axisX: roundArray(state.axisX),
          axisY: roundArray(state.axisY),
          axisZ: roundArray(state.axisZ),
          velocity: roundArray(state.velocity),
          angular: roundArray(state.angular),
          speed: round(state.speed)
        },
        wheels,
        steer: {
          frontleft: round(steer.frontleft),
          frontright: round(steer.frontright),
          backleft: 0,
          backright: 0
        },
        steerMeta: {
          raw: round(provisional.raw),
          filtered: round(provisional.filtered),
          clamped: provisional.clamped,
          valid: provisional.valid,
          source: PROVISIONAL_STEER_SOURCE
        }
      });

      if (definition.stopWhen?.(state)) {
        stoppedAt = { tick: state.tick, position: roundArray(state.position), reason: 'stopped before the measured cliff' };
        break;
      }
    }

    const document = {
      kind: 'blur.suspension.scenario',
      version: 1,
      scenario: name,
      note: definition.note,
      car: {
        slug: car.slug,
        name: car.name,
        record: car.record,
        drivetrain: car.drivetrain,
        fieldsPath: car.fields.path,
        fieldsSha256: sha256(fieldBytes)
      },
      config: config.config,
      configMissing: config.missing,
      corners,
      settled: { suspension: settledSuspension, spin: { frontleft: 0, frontright: 0, backleft: 0, backright: 0 } },
      provenance: {
        module: {
          path: path.relative(ROOT, modulePath).replaceAll('\\', '/'),
          wasm: path.relative(ROOT, path.join(E1, 'module/e1_drive.wasm')).replaceAll('\\', '/'),
          wasmSha256: sha256(wasmBytes)
        },
        level: {
          path: path.relative(ROOT, path.join(E1, 'Level.levelphysics')).replaceAll('\\', '/'),
          sha256: sha256(levelBytes)
        },
        roster: {
          path: path.relative(ROOT, path.join(E1, 'cars.json')).replaceAll('\\', '/'),
          sha256: sha256(requireFile(path.join(E1, 'cars.json')))
        },
        manifest: {
          path: path.relative(ROOT, path.join(ROOT, '_work/car-parts/cars', slug, 'manifest.json')).replaceAll('\\', '/'),
          sha256: sha256(manifestBytes),
          note: 'per-car car-parts manifest used by e1-drive build_geometry; the root _work/car-parts/manifest.json is a different model and is not used'
        },
        warmupTicks: info.warmupTicks,
        dt: info.dt,
        spawn,
        recordedBy: 'probes/suspension/tools/record_scenario.mjs',
        node: process.version
      },
      tickCount: ticks.length,
      stoppedAt,
      ticks
    };

    const file = path.join(outDir, name + '.json');
    const text = JSON.stringify(document);
    writeFileSync(file, text);
    const hash = sha256(Buffer.from(text, 'utf8'));
    writeFileSync(file + '.sha256', hash + '\n');
    console.log(JSON.stringify({
      scenario: name,
      file: path.relative(ROOT, file).replaceAll('\\', '/'),
      ticks: ticks.length,
      bytes: Buffer.byteLength(text),
      sha256: hash,
      stoppedAt
    }));
  }
}

await main();
