#!/usr/bin/env node
// Deterministic builder for the committed browser car-material table.
//
//   node probes/car-materials/tools/build_runtime_materials.mjs
//   node probes/car-materials/tools/build_runtime_materials.mjs --manifest <json> --module-out <mjs>
//
// Input (committed):
//   probes/car-materials/data/runtime-materials.json
//     schema `blur.car-materials-runtime-manifest/1`, produced by
//     probes/car-materials/tools/build_runtime_materials_table.py
//
// Outputs (committed):
//   probes/car-materials/runtime-materials.mjs
//
// The builder copies the manifest's `derived` blocks verbatim. It never rounds,
// scales, interpolates or synthesises a value. A field the retail format does
// not serialize is already absent from the manifest and listed in `missing`;
// the builder does not fill it in.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const DEFAULT_MANIFEST = path.join(ROOT, 'probes/car-materials/data/runtime-materials.json');
const DEFAULT_MODULE = path.join(ROOT, 'probes/car-materials/runtime-materials.mjs');
const TEMPLATE = path.join(HERE, 'runtime_materials_module.template.mjs');
const DATA_PLACEHOLDER = '/*__RUNTIME_MATERIALS_DATA__*/';

const MANIFEST_SCHEMA = 'blur.car-materials-runtime-manifest/1';
const RUNTIME_SCHEMA = 'blur.car-materials-runtime/1';
const CAR_COUNT = 25;

function parseArgs(argv) {
  const options = { manifest: DEFAULT_MANIFEST, module: DEFAULT_MODULE, quiet: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--manifest') {
      options.manifest = path.resolve(argv[++index]);
    } else if (arg === '--module-out') {
      options.module = path.resolve(argv[++index]);
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else {
      throw new Error('unknown argument ' + JSON.stringify(arg));
    }
  }
  return options;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function fail(message) {
  throw new Error(message);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(label + ' is not an object');
  }
  return value;
}

function requireArray(value, label, length = null) {
  if (!Array.isArray(value)) fail(label + ' is not an array');
  if (length !== null && value.length !== length) {
    fail(label + ' has length ' + value.length + ', expected ' + length);
  }
  return value;
}

function requireNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(label + ' is not a finite number: ' + JSON.stringify(value));
  }
  return value;
}

function requireVector(value, label, length) {
  requireArray(value, label, length);
  return value.map((entry, index) => requireNumber(entry, label + '[' + index + ']'));
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(label + ' is not a non-empty string: ' + JSON.stringify(value));
  }
  return value;
}

function buildCar(slug, entry) {
  requireObject(entry, slug);
  if (entry.slug !== slug) fail(slug + ': car slug is ' + JSON.stringify(entry.slug));

  const paint = requireObject(entry.paint, slug + '.paint');
  const paintDerived = requireObject(paint.derived, slug + '.paint.derived');
  const glass = requireObject(entry.glass, slug + '.glass');
  const glassDerived = requireObject(glass.derived, slug + '.glass.derived');
  const light = requireObject(entry.light, slug + '.light');
  const lightDerived = requireObject(light.derived, slug + '.light.derived');
  const alloy = requireObject(entry.alloy, slug + '.alloy');
  const alloyDerived = requireObject(alloy.derived, slug + '.alloy.derived');

  const blend = requireObject(glassDerived.blend, slug + '.glass.derived.blend');

  return {
    schema: RUNTIME_SCHEMA,
    slug,
    baseColour: requireVector(paintDerived.baseColour, slug + '.baseColour', 4),
    glass: {
      tint: requireVector(glassDerived.tint, slug + '.glass.tint', 3),
      minAlpha: requireNumber(glassDerived.minAlpha, slug + '.glass.minAlpha'),
      maxAlpha: requireNumber(glassDerived.maxAlpha, slug + '.glass.maxAlpha'),
      minReflectivity: requireNumber(glassDerived.minReflectivity,
        slug + '.glass.minReflectivity'),
      maxReflectivity: requireNumber(glassDerived.maxReflectivity,
        slug + '.glass.maxReflectivity'),
      blend: {
        src: requireString(blend.src, slug + '.glass.blend.src'),
        dest: requireString(blend.dest, slug + '.glass.blend.dest'),
        alphaTest: blend.alphaTest === true
      }
    },
    emissive: requireVector(lightDerived.emissive, slug + '.emissive', 3),
    emissiveStrength: requireNumber(lightDerived.emissiveStrength,
      slug + '.emissiveStrength'),
    alloy: {
      colour: requireVector(alloyDerived.colour, slug + '.alloy.colour', 3),
      specPow: requireNumber(alloyDerived.specPow, slug + '.alloy.specPow'),
      specInt: requireNumber(alloyDerived.specInt, slug + '.alloy.specInt')
    },
    missing: requireArray(entry.missing, slug + '.missing').map((row, index) => {
      requireObject(row, slug + '.missing[' + index + ']');
      return {
        field: requireString(row.field, slug + '.missing[' + index + '].field'),
        sourceField: requireString(row.sourceField,
          slug + '.missing[' + index + '].sourceField'),
        present: row.present === true,
        searchedFields: requireArray(row.searchedFields,
          slug + '.missing[' + index + '].searchedFields').map((name, at) =>
          requireString(name, slug + '.missing[' + index + '].searchedFields[' + at + ']')),
        reason: requireString(row.reason, slug + '.missing[' + index + '].reason')
      };
    }),
    source: requireObject(entry.source, slug + '.source')
  };
}

function buildDocument(manifest, manifestSha256) {
  if (manifest.schema !== MANIFEST_SCHEMA) {
    fail('unexpected manifest schema ' + JSON.stringify(manifest.schema));
  }
  const roster = requireObject(manifest.roster, 'roster');
  const order = requireArray(roster.order, 'roster.order', CAR_COUNT);
  const cars = requireObject(manifest.cars, 'cars');
  const keys = Object.keys(cars).sort();
  const expected = [...order].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    fail('manifest cars ' + JSON.stringify(keys) +
      ' do not match roster order ' + JSON.stringify(expected));
  }

  const runtimeCars = {};
  for (const slug of order) {
    runtimeCars[slug] = buildCar(slug, cars[slug]);
  }

  return {
    schema: RUNTIME_SCHEMA,
    kind: 'blur.car-materials-runtime',
    version: 1,
    generatedBy: 'probes/car-materials/tools/build_runtime_materials.mjs',
    manifest: {
      path: 'probes/car-materials/data/runtime-materials.json',
      schema: manifest.schema,
      cars: order.length,
      sha256: manifestSha256
    },
    scope: 'Retail paint, glass, light and alloy material values for the 25-car ' +
      'roster, decoded from the shipped XT packs. Values are copied verbatim or ' +
      'derived by the documented rule in `baseColour.sample`; fields the format ' +
      'does not serialize are absent and listed in `missing`.',
    colourSpace: manifest.colourSpace,
    slugs: order,
    cars: runtimeCars
  };
}

function generateModule(document, template) {
  if (!template.includes(DATA_PLACEHOLDER)) {
    fail('module template is missing ' + DATA_PLACEHOLDER);
  }
  return template.replace(DATA_PLACEHOLDER, JSON.stringify(document, null, 2));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const buffer = readFileSync(options.manifest);
  const manifest = JSON.parse(buffer.toString('utf8'));
  const document = buildDocument(manifest, sha256(buffer));
  const template = readFileSync(TEMPLATE, 'utf8');
  const moduleText = generateModule(document, template);

  mkdirSync(path.dirname(options.module), { recursive: true });
  writeFileSync(options.module, moduleText);

  if (!options.quiet) {
    console.log('runtime-materials: ' + document.slugs.length + ' cars, manifest sha256 ' +
      document.manifest.sha256);
    console.log('wrote ' + path.relative(ROOT, options.module) + ' sha256 ' +
      sha256(Buffer.from(moduleText, 'utf8')));
  }
}

main();
