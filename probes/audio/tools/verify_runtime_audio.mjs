#!/usr/bin/env node
// Verify the runtime audio catalog and the runtime module.
//
// Checks:
//   * catalog schema, event vocabulary, summary counts
//   * every source file exists, has the recorded SHA-256 and byte size
//   * every source agrees with audio-manifest.json / tyre-collision-model.json
//   * every source re-decodes from the retail PAK to the same SHA-256
//   * every retail gain/rate agrees with the retail graph component
//   * every neutral gain/rate is marked provisional and has no retail literal
//   * engine/tyre/impact curves agree with the decoded graph curves
//   * the builder is deterministic and matches the committed catalog
//   * the runtime module returns the documented API and plays every event
//   * the README documents the import contract and event table
//
// Exit code 0 only when every check passes. Prints "N/M checks passed".

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AUDIO_SCHEMA, EVENT_IDS, MIN_PLAYBACK_RATE, createAudio } from '../runtime-audio.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const AUDIO = join(ROOT, '_work', 'audio');
const CATALOG_PATH = join(ROOT, 'probes', 'audio', 'data', 'runtime-audio.json');
const BUILDER = join(ROOT, 'probes', 'audio', 'tools', 'build_runtime_audio.mjs');
const REDECODE = join(ROOT, 'probes', 'audio', 'tools', 'redecode_runtime_sources.py');
const PYTHON = 'C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const SOURCE_ROOT = '_work/audio/';

const CHECKS = [];
let currentGroup = 'general';

function group(name) {
  currentGroup = name;
}

function check(name, ok, detail) {
  CHECKS.push({
    group: currentGroup,
    name,
    ok: Boolean(ok),
    detail: detail === undefined ? null : detail,
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// audio-catalog.json contains bare -Infinity in unused graph curves.
function readJsonTolerant(path) {
  const text = readFileSync(path, 'utf8')
    .replace(/(?<![\w"])-?Infinity(?![\w"])/g, 'null')
    .replace(/(?<![\w"])NaN(?![\w"])/g, 'null');
  return JSON.parse(text);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function rel(path) {
  return relative(ROOT, path).replaceAll('\\', '/');
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function approx(a, b, tolerance = 1e-9) {
  return Math.abs(a - b) <= tolerance;
}

function hex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function sourcesOf(catalog) {
  const rows = [];
  for (const id of EVENT_IDS) {
    const event = catalog.events[id];
    for (const variant of event.variants ?? []) rows.push({ id, event, kind: 'variant', source: variant });
    for (const layer of event.layers ?? []) rows.push({ id, event, kind: 'layer', source: layer });
  }
  return rows;
}

function findManifest(manifestByUid, manifestByBankWave, source) {
  const byUid = manifestByUid.get(source.waveUid);
  if (byUid) return byUid;
  return manifestByBankWave.get(`${source.bank.toLowerCase()}\u0000${source.wave.toLowerCase()}`) ?? null;
}

function findModel(model, source) {
  for (const bank of Object.values(model.banks)) {
    if (bank.bankName.toLowerCase() !== source.bank.toLowerCase()) continue;
    const wave = bank.waves.find((item) => item.name.toLowerCase() === source.wave.toLowerCase());
    if (wave) return { bank, wave };
  }
  return null;
}

function graphSound(audioCatalog, graphFile, component) {
  const graph = audioCatalog.graphs[String(graphFile).toLowerCase()];
  if (!graph) return null;
  return graph.sounds.find((item) => item.name === component) ?? null;
}

async function main() {
  const catalog = readJson(CATALOG_PATH);
  const manifest = readJson(join(AUDIO, 'audio-manifest.json'));
  const model = readJson(join(AUDIO, 'tyre-collision-model.json'));
  const audioCatalog = readJsonTolerant(join(AUDIO, 'audio-catalog.json'));
  const contract = readJson(join(AUDIO, 'integration-contract.json'));
  const engineModel = readJson(join(AUDIO, 'engine-model.json'));

  const manifestByUid = new Map(manifest.entries.map((entry) => [entry.waveUid, entry]));
  const manifestByBankWave = new Map();
  for (const entry of manifest.entries) {
    manifestByBankWave.set(`${entry.bank.toLowerCase()}\u0000${entry.wave.toLowerCase()}`, entry);
  }
  const sources = sourcesOf(catalog);

  // ---------------------------------------------------------------- catalog
  group('catalog');
  check('catalog schema', catalog.schema === AUDIO_SCHEMA, catalog.schema);
  check('catalog generatedBy', catalog.generatedBy === 'probes/audio/tools/build_runtime_audio.mjs',
    catalog.generatedBy);
  check('catalog sourceRoot', catalog.sourceRoot === SOURCE_ROOT, catalog.sourceRoot);
  check('catalog baseUrl', catalog.baseUrl === '/_work/audio/', catalog.baseUrl);
  check('catalog eventIds array', Array.isArray(catalog.eventIds));
  check('catalog eventIds match module', deepEqual(catalog.eventIds, [...EVENT_IDS]),
    catalog.eventIds);
  check('catalog events object', catalog.events && typeof catalog.events === 'object'
    && !Array.isArray(catalog.events));
  check('catalog event key order', deepEqual(Object.keys(catalog.events), [...EVENT_IDS]),
    Object.keys(catalog.events));
  check('catalog event count', Object.keys(catalog.events).length === EVENT_IDS.length,
    Object.keys(catalog.events).length);
  check('catalog unsupported object', catalog.unsupported && typeof catalog.unsupported === 'object'
    && !Array.isArray(catalog.unsupported));
  check('catalog summary events', catalog.summary?.events === EVENT_IDS.length, catalog.summary?.events);
  check('catalog summary supported + unsupported',
    catalog.summary?.supported + catalog.summary?.unsupported === EVENT_IDS.length,
    catalog.summary);
  check('catalog summary uniqueSources', catalog.summary?.uniqueSources
    === new Set(sources.map((row) => row.source.file)).size, catalog.summary?.uniqueSources);
  check('catalog summary variants', catalog.summary?.variants
    === sources.filter((row) => row.kind === 'variant').length, catalog.summary?.variants);
  check('catalog summary layers', catalog.summary?.layers
    === sources.filter((row) => row.kind === 'layer').length, catalog.summary?.layers);
  check('catalog has no generatedAt timestamp', !Object.prototype.hasOwnProperty.call(catalog, 'generatedAt'));

  const categories = new Set(['engine', 'tyre', 'collision', 'pickup', 'weapon', 'ui', 'race']);
  for (const id of EVENT_IDS) {
    const event = catalog.events[id];
    check(`event ${id}: id matches key`, event.id === id, event.id);
    check(`event ${id}: category`, categories.has(event.category), event.category);
    check(`event ${id}: kind`, ['engine', 'loop', 'one-shot'].includes(event.kind), event.kind);
    check(`event ${id}: loop boolean`, typeof event.loop === 'boolean', event.loop);
    check(`event ${id}: status`, event.status === 'ok' || event.status === 'unsupported', event.status);
    check(`event ${id}: gain`, event.gain && typeof event.gain === 'object');
    check(`event ${id}: pitch`, event.pitch && typeof event.pitch === 'object');
    if (event.status === 'unsupported') {
      check(`event ${id}: unsupported reason`, typeof event.reason === 'string' && event.reason.length > 0,
        event.reason);
      check(`event ${id}: unsupported has no sources`,
        (event.variants ?? []).length === 0 && (event.layers ?? []).length === 0);
      check(`event ${id}: listed under unsupported`,
        catalog.unsupported && Object.prototype.hasOwnProperty.call(catalog.unsupported, id));
    } else {
      check(`event ${id}: has a source`,
        (event.variants ?? []).length + (event.layers ?? []).length > 0
        || (event.routes && Object.keys(event.routes).length > 0));
      check(`event ${id}: not listed under unsupported`,
        !catalog.unsupported || !Object.prototype.hasOwnProperty.call(catalog.unsupported, id));
    }
  }
  for (const key of Object.keys(catalog.unsupported ?? {})) {
    check(`unsupported key ${key}: known event`, EVENT_IDS.includes(key), key);
    check(`unsupported key ${key}: typed reason`,
      typeof catalog.unsupported[key].reason === 'string' && catalog.unsupported[key].reason.length > 0);
  }

  // ---------------------------------------------------------------- sources
  group('sources');
  const fileHashes = new Map();
  for (const row of sources) {
    const { id, source } = row;
    const tag = `${id}:${source.wave}`;
    check(`${tag}: file under sourceRoot`, typeof source.file === 'string'
      && source.file.startsWith(SOURCE_ROOT), source.file);
    check(`${tag}: url relative to sourceRoot`,
      source.url === source.file.slice(SOURCE_ROOT.length), source.url);
    check(`${tag}: sha256 format`, hex64(source.sha256), source.sha256);
    const path = join(ROOT, source.file);
    check(`${tag}: file exists`, existsSync(path), source.file);
    if (existsSync(path)) {
      const actualHash = sha256File(path);
      const actualBytes = statSync(path).size;
      check(`${tag}: file hash`, actualHash === source.sha256, [actualHash, source.sha256]);
      check(`${tag}: file bytes`, actualBytes === source.bytes, [actualBytes, source.bytes]);
      const previous = fileHashes.get(source.file);
      check(`${tag}: no conflicting file hash`, previous === undefined || previous === source.sha256,
        [previous, source.sha256]);
      fileHashes.set(source.file, source.sha256);
    }
    check(`${tag}: loop boolean`, typeof source.loop === 'boolean', source.loop);
    check(`${tag}: loopStart 0`, source.loopStart === 0, source.loopStart);
    if (source.loop) {
      check(`${tag}: loopEnd == samples`, source.loopEnd === source.samples,
        [source.loopEnd, source.samples]);
    } else {
      check(`${tag}: one-shot loopEnd null`, source.loopEnd === null, source.loopEnd);
    }
    check(`${tag}: sampleRate`, source.sampleRate === 48000 || source.sampleRate === 36000,
      source.sampleRate);
    check(`${tag}: channels`, source.channels === 1 || source.channels === 2, source.channels);
    check(`${tag}: samples > 0`, Number.isInteger(source.samples) && source.samples > 0, source.samples);
    check(`${tag}: duration`, Number.isFinite(source.durationSeconds)
      && approx(source.durationSeconds, source.samples / source.sampleRate, 1e-6),
    source.durationSeconds);

    const provenance = source.provenance ?? {};
    check(`${tag}: provenance pak`, provenance.pak === 'root.pak'
      || provenance.pak === 'root_streaming.pak', provenance.pak);
    check(`${tag}: provenance asset`, typeof provenance.asset === 'string'
      && provenance.asset.startsWith('\\audio\\') && provenance.asset.endsWith('.baf'),
    provenance.asset);
    check(`${tag}: provenance bank`, typeof provenance.bank === 'string'
      && provenance.bank.length > 0, provenance.bank);
    check(`${tag}: provenance bankSha256`, hex64(provenance.bankSha256), provenance.bankSha256);
    check(`${tag}: provenance bankLogicalBytes`, Number.isInteger(provenance.bankLogicalBytes)
      && provenance.bankLogicalBytes > 0, provenance.bankLogicalBytes);
    check(`${tag}: provenance waveIndex`, Number.isInteger(provenance.waveIndex)
      && provenance.waveIndex >= 0, provenance.waveIndex);
    check(`${tag}: provenance dataStart`, Number.isInteger(provenance.dataStart)
      && provenance.dataStart >= 0, provenance.dataStart);
    check(`${tag}: provenance dataLength`, Number.isInteger(provenance.dataLength)
      && provenance.dataLength > 0, provenance.dataLength);
    check(`${tag}: provenance data range`, provenance.dataStart + provenance.dataLength
      <= provenance.bankLogicalBytes, [provenance.dataStart, provenance.dataLength,
      provenance.bankLogicalBytes]);
    check(`${tag}: provenance codec`, provenance.codec === 'uADPCM4Bit', provenance.codec);
    check(`${tag}: provenance graph path`, typeof provenance.graph === 'string'
      && provenance.graph.startsWith('root.pak:\\audio\\dat\\')
      && provenance.graph.endsWith('.dat'), provenance.graph);
    check(`${tag}: provenance graphSha256`, hex64(provenance.graphSha256), provenance.graphSha256);
    check(`${tag}: provenance graphBytes`, Number.isInteger(provenance.graphBytes)
      && provenance.graphBytes > 0, provenance.graphBytes);
    check(`${tag}: provenance component`, typeof provenance.component === 'string'
      && provenance.component.length > 0, provenance.component);
    check(`${tag}: provenance trigger`, typeof provenance.trigger === 'string'
      && provenance.trigger.length > 0, provenance.trigger);
    check(`${tag}: provenance entity`, typeof provenance.entity === 'string'
      && provenance.entity.length > 0, provenance.entity);

    const graph = audioCatalog.graphs[String(provenance.graphFile).toLowerCase()];
    check(`${tag}: graph exists in catalog`, Boolean(graph), provenance.graphFile);
    if (graph) {
      check(`${tag}: graph hash`, graph.sha256 === provenance.graphSha256,
        [graph.sha256, provenance.graphSha256]);
      check(`${tag}: graph bytes`, graph.byteLength === provenance.graphBytes,
        [graph.byteLength, provenance.graphBytes]);
      const sound = graph.sounds.find((item) => item.name === provenance.component);
      check(`${tag}: graph component exists`, Boolean(sound), provenance.component);
      if (sound) {
        check(`${tag}: graph component references wave`, sound.waves.includes(source.wave),
          [sound.waves, source.wave]);
        check(`${tag}: graph component bank`, sound.bank === source.bank,
          [sound.bank, source.bank]);
      }
    }

    const manifestEntry = findManifest(manifestByUid, manifestByBankWave, source);
    if (manifestEntry) {
      check(`${tag}: manifest hash`, manifestEntry.sha256 === source.sha256,
        [manifestEntry.sha256, source.sha256]);
      check(`${tag}: manifest bytes`, manifestEntry.bytes === source.bytes,
        [manifestEntry.bytes, source.bytes]);
      check(`${tag}: manifest loop`, Boolean(manifestEntry.loop) === source.loop,
        [manifestEntry.loop, source.loop]);
      check(`${tag}: manifest sampleRate`, manifestEntry.sampleRate === source.sampleRate,
        [manifestEntry.sampleRate, source.sampleRate]);
      check(`${tag}: manifest channels`, manifestEntry.channels === source.channels,
        [manifestEntry.channels, source.channels]);
      check(`${tag}: manifest samples`, manifestEntry.samples === source.samples,
        [manifestEntry.samples, source.samples]);
      check(`${tag}: manifest file`, manifestEntry.file === source.file,
        [manifestEntry.file, source.file]);
    } else {
      const found = findModel(model, source);
      check(`${tag}: model source exists`, Boolean(found), `${source.bank}:${source.wave}`);
      if (found) {
        check(`${tag}: model hash`, found.wave.wavSha256 === source.sha256,
          [found.wave.wavSha256, source.sha256]);
        check(`${tag}: model bytes`, found.wave.wavBytes === source.bytes,
          [found.wave.wavBytes, source.bytes]);
        check(`${tag}: model loop`, Boolean(found.wave.loop) === source.loop,
          [found.wave.loop, source.loop]);
        check(`${tag}: model sampleRate`, found.wave.sampleRate === source.sampleRate,
          [found.wave.sampleRate, source.sampleRate]);
        check(`${tag}: model channels`, found.wave.channels === source.channels,
          [found.wave.channels, source.channels]);
        check(`${tag}: model samples`, found.wave.samples === source.samples,
          [found.wave.samples, source.samples]);
      }
    }
  }

  // ------------------------------------------------------------ gain / pitch
  group('gain-pitch');
  for (const id of EVENT_IDS) {
    const event = catalog.events[id];
    check(`event ${id}: gain value`, Number.isFinite(event.gain?.value) && event.gain.value >= 0,
      event.gain?.value);
    check(`event ${id}: gain source`, ['retail', 'neutral'].includes(event.gain?.source),
      event.gain?.source);
    check(`event ${id}: gain provisional boolean`, typeof event.gain?.provisional === 'boolean');
    if (event.gain?.source === 'neutral') {
      check(`event ${id}: neutral gain is 1.0`, event.gain.value === 1, event.gain.value);
      check(`event ${id}: neutral gain provisional`, event.gain.provisional === true);
    } else {
      check(`event ${id}: retail gain not provisional`, event.gain.provisional === false);
      check(`event ${id}: retail gain basis`, typeof event.gain.basis === 'string'
        && event.gain.basis.length > 0);
    }
    check(`event ${id}: pitch min/max`, Number.isFinite(event.pitch?.min)
      && Number.isFinite(event.pitch?.max) && event.pitch.min > 0
      && event.pitch.max >= event.pitch.min, [event.pitch?.min, event.pitch?.max]);
    check(`event ${id}: pitch floor`, event.pitch.min >= MIN_PLAYBACK_RATE, event.pitch.min);
    check(`event ${id}: pitch ceiling`, event.pitch.max <= 4, event.pitch.max);
    check(`event ${id}: pitch source`, ['retail-literal', 'retail-curve', 'neutral']
      .includes(event.pitch?.source), event.pitch?.source);
    if (event.pitch?.source === 'neutral') {
      check(`event ${id}: neutral pitch 1.0`, event.pitch.min === 1 && event.pitch.max === 1);
      check(`event ${id}: neutral pitch provisional`, event.pitch.provisional === true);
    } else {
      check(`event ${id}: retail pitch not provisional`, event.pitch.provisional === false);
    }
    const first = (event.variants ?? event.layers ?? [])[0];
    if (first) {
      check(`event ${id}: event gain == first source gain`,
        event.gain.value === first.gain.value, [event.gain.value, first.gain.value]);
    }
  }

  for (const row of sources) {
    const { id, source } = row;
    const tag = `${id}:${source.wave}`;
    check(`${tag}: gain value`, Number.isFinite(source.gain?.value) && source.gain.value >= 0,
      source.gain?.value);
    check(`${tag}: gain source`, ['retail', 'neutral'].includes(source.gain?.source),
      source.gain?.source);
    check(`${tag}: gain provisional boolean`, typeof source.gain?.provisional === 'boolean');
    if (source.gain?.source === 'neutral') {
      check(`${tag}: neutral gain 1.0`, source.gain.value === 1, source.gain.value);
      check(`${tag}: neutral gain provisional`, source.gain.provisional === true);
    } else {
      check(`${tag}: retail gain not provisional`, source.gain.provisional === false);
      check(`${tag}: retail gain basis`, typeof source.gain.basis === 'string'
        && source.gain.basis.length > 0);
    }
    check(`${tag}: rate value`, Number.isFinite(source.rate?.value) && source.rate.value > 0,
      source.rate?.value);
    check(`${tag}: rate source`, ['retail-literal', 'neutral'].includes(source.rate?.source),
      source.rate?.source);
    if (source.rate?.source === 'neutral') {
      check(`${tag}: neutral rate provisional`, source.rate.provisional === true);
    } else {
      check(`${tag}: retail rate not provisional`, source.rate.provisional === false);
    }
    check(`${tag}: variant pitch`, source.pitch && Number.isFinite(source.pitch.min)
      && Number.isFinite(source.pitch.max) && source.pitch.min > 0
      && source.pitch.max >= source.pitch.min, source.pitch);
    check(`${tag}: variant pitch floor`, source.pitch.min >= MIN_PLAYBACK_RATE, source.pitch.min);
    check(`${tag}: variant pitch ceiling`, source.pitch.max <= 4, source.pitch.max);
    if (source.pitch.source === 'neutral') {
      check(`${tag}: variant neutral pitch 1.0`, source.pitch.min === 1 && source.pitch.max === 1);
      check(`${tag}: variant neutral pitch provisional`, source.pitch.provisional === true);
    } else {
      check(`${tag}: variant retail pitch not provisional`, source.pitch.provisional === false);
    }

    const sound = graphSound(audioCatalog, source.provenance.graphFile, source.provenance.component);
    if (sound) {
      if (source.gain.source === 'retail') {
        check(`${tag}: retail gain matches graph`, approx(sound.literalGain, source.gain.value, 1e-9),
          [sound.literalGain, source.gain.value]);
      } else {
        check(`${tag}: neutral gain only when graph gain is control-linked`,
          sound.literalGain === null || sound.literalGain === undefined, sound.literalGain);
      }
      if (source.rate.source === 'retail-literal') {
        check(`${tag}: retail rate matches graph`, approx(sound.literalRate, source.rate.value, 1e-9),
          [sound.literalRate, source.rate.value]);
      } else {
        check(`${tag}: neutral rate only when graph rate is control-linked`,
          sound.literalRate === null || sound.literalRate === undefined, sound.literalRate);
      }
    }
  }

  // --------------------------------------------------------------- curves
  group('curves');
  const engine = catalog.events.engine;
  check('engine: six layers', engine.layers.length === 6, engine.layers.length);
  check('engine: pitch floor', engine.pitch.min === MIN_PLAYBACK_RATE, engine.pitch.min);
  check('engine: pitch ceiling', engine.pitch.max === 2, engine.pitch.max);
  for (const loop of engineModel.loops) {
    if (loop.rpmLabel === null) continue;
    const layer = engine.layers.find((item) => item.slot === loop.slot);
    check(`engine layer ${loop.slot}: present`, Boolean(layer));
    if (layer) {
      check(`engine layer ${loop.slot}: wave`, layer.wave === loop.wave, layer.wave);
      check(`engine layer ${loop.slot}: rpmLabel`, layer.rpmLabel === loop.rpmLabel);
      check(`engine layer ${loop.slot}: volume curve`, deepEqual(layer.volumeCurve, loop.volume));
      check(`engine layer ${loop.slot}: pitch curve`, deepEqual(layer.pitchCurve, loop.pitch));
    }
  }
  check('engine: decel excluded', engine.excluded.some((item) => item.wave === 'RaceV8_Engine_decel'));
  check('engine: 720 excluded', engine.excluded.some((item) => item.wave === 'RaceV8_Engine_720'));

  const tyre = catalog.events['tyre-squeal'];
  check('tyre: three layers', tyre.layers.length === 3, tyre.layers.length);
  const wheelCurves = model.graphs.wheel_dry.curves;
  for (const [key, name] of [
    ['skidSpeedVolume', 'SkidSpeedVolume'],
    ['skidSpeedPitch', 'SkidSpeedPitch'],
    ['skidSlidePitchModifier', 'Asphalt_SkidSlidePitchModifier'],
  ]) {
    const curve = wheelCurves.find((item) => item.name === name);
    check(`tyre: ${key} present`, Boolean(curve));
    if (curve) check(`tyre: ${key} points`, deepEqual(tyre.curves[key].points, curve.points));
  }
  for (let i = 0; i < 3; i += 1) {
    const curve = wheelCurves.find((item) => item.name === `Asphalt_Skid${i}VolumePLF`);
    check(`tyre: skidVolume[${i}] points`, curve && deepEqual(tyre.curves.skidVolume[i].points, curve.points));
  }
  const pitchMin = Math.min(...tyre.curves.skidSpeedPitch.points.map((p) => p[1]))
    * Math.min(...tyre.curves.skidSlidePitchModifier.points.map((p) => p[1]));
  const pitchMax = Math.max(...tyre.curves.skidSpeedPitch.points.map((p) => p[1]))
    * Math.max(...tyre.curves.skidSlidePitchModifier.points.map((p) => p[1]));
  check('tyre: pitch range', approx(tyre.pitch.min, pitchMin, 1e-6)
    && approx(tyre.pitch.max, pitchMax, 1e-6), [tyre.pitch.min, tyre.pitch.max, pitchMin, pitchMax]);

  const impact = catalog.events.impact;
  check('impact: 59 variants', impact.variants.length === 59, impact.variants.length);
  check('impact: 17 routes', Object.keys(impact.routes).length === 17,
    Object.keys(impact.routes).length);
  check('impact: 3 car routes', ['car-large', 'car-medium', 'car-small']
    .every((key) => Boolean(impact.routes[key])));
  check('impact: 14 world routes', Object.keys(impact.routes)
    .filter((key) => key.startsWith('world-')).length === 14);
  check('impact: default route', impact.defaultRoute === 'car-medium', impact.defaultRoute);
  check('impact: selection provisional', impact.selectionProvisional === true);
  for (const [key, name] of [['car', 'CollisionVolume'], ['world', 'CollisionVolume']]) {
    const graphKey = key === 'car' ? 'collisioncar' : 'collisionworld';
    const curve = model.graphs[graphKey].curves.find((item) => item.name === name);
    check(`impact: ${key} volume curve`, curve && deepEqual(impact.volumeCurves[key].points, curve.points));
  }
  const carSounds = audioCatalog.graphs['collisioncar.dat'].sounds;
  for (const [route, component] of [
    ['car-large', 'LargeCarCollisionSound'],
    ['car-medium', 'MediumCarCollisionSound'],
    ['car-small', 'SmallCarCollisionSound'],
  ]) {
    const sound = carSounds.find((item) => item.name === component);
    const info = impact.routes[route];
    check(`impact ${route}: table`, info.table === component, info.table);
    check(`impact ${route}: variant count`, info.variantIds.length === sound.waves.length,
      [info.variantIds.length, sound.waves.length]);
    for (const index of info.variantIds) {
      const variant = impact.variants[index];
      check(`impact ${route}: variant ${index} route`, variant.route === route, variant.route);
      check(`impact ${route}: variant ${index} wave`, sound.waves.includes(variant.wave), variant.wave);
    }
  }
  const worldSounds = audioCatalog.graphs['collisionworld.dat'].sounds;
  for (const [route, info] of Object.entries(impact.routes)) {
    if (!route.startsWith('world-')) continue;
    const sound = worldSounds.find((item) => item.name === info.table);
    check(`impact ${route}: table exists`, Boolean(sound), info.table);
    if (sound) {
      check(`impact ${route}: variant count`, info.variantIds.length === sound.waves.length,
        [info.variantIds.length, sound.waves.length]);
      for (const index of info.variantIds) {
        const variant = impact.variants[index];
        check(`impact ${route}: variant ${index} route`, variant.route === route, variant.route);
        check(`impact ${route}: variant ${index} wave`, sound.waves.includes(variant.wave), variant.wave);
      }
    }
  }
  for (const material of impact.materials) {
    check(`impact material ${material.name}: route exists`, Boolean(impact.routes[material.route]),
      material.route);
    const routing = model.graphs.collisionworld.collisionRouting
      .find((item) => Math.trunc(item.surfaceValue) === material.index);
    check(`impact material ${material.name}: retail routing`, Boolean(routing), material.index);
    if (routing) {
      check(`impact material ${material.name}: table`,
        impact.routes[material.route].table === routing.targetName, routing.targetName);
    }
  }
  for (const [surface, route] of Object.entries(impact.surfaces)) {
    check(`impact surface ${surface}: route exists`, Boolean(impact.routes[route]), route);
  }

  // -------------------------------------------------------- event specifics
  group('events');
  for (const type of ['bolt', 'shunt', 'barge', 'mine', 'shock', 'nitro', 'shield', 'repair']) {
    const pickup = catalog.events[`pickup-${type}`];
    check(`pickup-${type}: ok`, pickup.status === 'ok', pickup.status);
    check(`pickup-${type}: shared source`, pickup.sharedSource === true);
    check(`pickup-${type}: not type specific`, pickup.typeSpecific === false);
    check(`pickup-${type}: type-specific typed unsupported`,
      pickup.typeSpecificStatus === 'unsupported'
      && pickup.typeSpecificReason === 'no-type-specific-pickup-wave');
    check(`pickup-${type}: PerkPickup`, pickup.variants.length === 1
      && pickup.variants[0].wave === 'PerkPickup', pickup.variants.map((v) => v.wave));

    const weapon = catalog.events[`weapon-${type}`];
    check(`weapon-${type}: ok`, weapon.status === 'ok', weapon.status);
    check(`weapon-${type}: has source`, (weapon.layers ?? []).length > 0);
  }
  check('weapon-shock: two layers', catalog.events['weapon-shock'].layers.length === 2);
  check('weapon-nitro: three layers', catalog.events['weapon-nitro'].layers.length === 3);
  check('weapon-shield: loop', catalog.events['weapon-shield'].loop === true);
  check('weapon-shield: kind loop', catalog.events['weapon-shield'].kind === 'loop');
  check('countdown: two variants', catalog.events.countdown.variants.length === 2);
  check('countdown: default short', catalog.events.countdown.defaultVariant === 'short');
  check('countdown: short id', catalog.events.countdown.variants[0].variantId === 'short');
  check('countdown: long id', catalog.events.countdown.variants[1].variantId === 'long');
  check('ui-click: FE_Forward', catalog.events['ui-click'].variants[0].wave === 'FE_Forward');
  check('finish: HUD_MPFinishIn', catalog.events.finish.variants[0].wave === 'HUD_MPFinishIn');
  check('wreck: HUD_Wrecked', catalog.events.wreck.variants[0].wave === 'HUD_Wrecked');
  check('unique source count 85', new Set(sources.map((row) => row.source.file)).size === 85,
    new Set(sources.map((row) => row.source.file)).size);

  // ------------------------------------------------------------ determinism
  group('determinism');
  const tempDir = mkdtempSync(join(tmpdir(), 'blur-runtime-audio-'));
  try {
    const first = join(tempDir, 'first.json');
    const second = join(tempDir, 'second.json');
    const run = (out) => spawnSync(process.execPath, [BUILDER, '--out', out], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const run1 = run(first);
    const run2 = run(second);
    check('builder run 1 exit 0', run1.status === 0, run1.stderr?.slice(0, 400));
    check('builder run 2 exit 0', run2.status === 0, run2.stderr?.slice(0, 400));
    if (run1.status === 0 && run2.status === 0) {
      // Git may check the committed JSON out with CRLF on Windows; compare the
      // logical content, not the line-ending bytes.
      const normalize = (path) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
      const a = normalize(first);
      const b = normalize(second);
      const committed = normalize(CATALOG_PATH);
      check('builder deterministic', a === b);
      check('builder matches committed catalog', a === committed);
      check('catalog has no Date.now token', !committed.includes('Date.now'));
      check('catalog has no random token', !committed.includes('Math.random'));
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  // --------------------------------------------------- independent re-decode
  group('redecode');
  if (!existsSync(PYTHON)) {
    check('bundled Python exists', false, PYTHON);
  } else if (!existsSync(REDECODE)) {
    check('redecode helper exists', false, REDECODE);
  } else {
    const unique = new Map();
    for (const row of sources) {
      const { source } = row;
      const key = [
        source.provenance.pak,
        source.provenance.asset,
        source.provenance.dataStart,
        source.provenance.dataLength,
        source.channels,
        source.samples,
        source.sampleRate,
      ].join('|');
      if (!unique.has(key)) {
        unique.set(key, {
          key,
          pak: source.provenance.pak,
          asset: source.provenance.asset,
          dataStart: source.provenance.dataStart,
          dataLength: source.provenance.dataLength,
          channels: source.channels,
          samples: source.samples,
          sampleRate: source.sampleRate,
          expectedSha256: source.sha256,
          expectedBytes: source.bytes,
        });
      }
    }
    const request = { sources: [...unique.values()].map(({ expectedSha256, expectedBytes, ...rest }) => rest) };
    const result = spawnSync(PYTHON, [REDECODE], {
      cwd: ROOT,
      input: JSON.stringify(request),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    check('redecode exit 0', result.status === 0, result.stderr?.slice(0, 800));
    if (result.status === 0) {
      let payload = null;
      try {
        payload = JSON.parse(result.stdout);
      } catch (error) {
        check('redecode JSON', false, error.message);
      }
      if (payload) {
        check('redecode result count', payload.results.length === unique.size,
          [payload.results.length, unique.size]);
        const byKey = new Map(payload.results.map((item) => [item.key, item]));
        for (const [key, expected] of unique) {
          const actual = byKey.get(key);
          check(`redecode ${expected.asset}:${expected.dataStart}: present`, Boolean(actual));
          if (actual) {
            check(`redecode ${expected.asset}:${expected.dataStart}: no error`, !actual.error, actual.error);
            if (!actual.error) {
              check(`redecode ${expected.asset}:${expected.dataStart}: hash`,
                actual.sha256 === expected.expectedSha256,
                [actual.sha256, expected.expectedSha256]);
              check(`redecode ${expected.asset}:${expected.dataStart}: bytes`,
                actual.bytes === expected.expectedBytes,
                [actual.bytes, expected.expectedBytes]);
            }
          }
        }
      }
    }
  }

  // --------------------------------------------------------- module contract
  group('module');
  check('module AUDIO_SCHEMA', AUDIO_SCHEMA === catalog.schema, AUDIO_SCHEMA);
  check('module EVENT_IDS', deepEqual([...EVENT_IDS], catalog.eventIds));

  const mock = createMockContext();
  const audio = createAudio({
    ctx: mock.ctx,
    baseUrl: '/_work/audio/',
    catalog,
    fetchImpl: makeFetch(),
  });
  check('module returns play', typeof audio.play === 'function');
  check('module returns setEngine', typeof audio.setEngine === 'function');
  check('module returns stop', typeof audio.stop === 'function');
  check('module returns snapshot', typeof audio.snapshot === 'function');

  const ui = await audio.play('ui-click').ready;
  check('module ui-click playing', ui.status === 'playing', [ui.status, ui.reason]);
  check('module ui-click variant', deepEqual(ui.variants, ['FE_Forward']), ui.variants);
  check('module ui-click gain', approx(ui.gain, 0.794328235, 1e-9), ui.gain);

  const pickup = await audio.play('pickup-bolt').ready;
  check('module pickup-bolt playing', pickup.status === 'playing', [pickup.status, pickup.reason]);
  check('module pickup-bolt shared wave', deepEqual(pickup.variants, ['PerkPickup']), pickup.variants);

  const metal = await audio.play('impact', { material: 'Metal', strength: 16 }).ready;
  check('module impact material route', metal.route === 'world-metal_sheet', metal.route);
  check('module impact strength applied', metal.dynamicGainApplied === true);
  check('module impact strength db', approx(metal.dynamicGainDb, -2.528455285892364, 1e-9),
    metal.dynamicGainDb);
  check('module impact gain', approx(metal.gain, 10 ** (-2.528455285892364 / 20), 1e-9), metal.gain);

  const small = await audio.play('impact', { size: 'small' }).ready;
  check('module impact size route', small.route === 'car-small', small.route);

  const tyreHandle = await audio.play('tyre-squeal', { slip: 0.2, speed: 12 }).ready;
  check('module tyre-squeal playing', tyreHandle.status === 'playing', [tyreHandle.status, tyreHandle.reason]);
  check('module tyre-squeal three voices', tyreHandle._voices.size === 3, tyreHandle._voices.size);
  check('module tyre-squeal gain', approx(tyreHandle.gain, 0.3666666666666667, 1e-9), tyreHandle.gain);

  const engineHandle = await audio.play('engine').ready;
  check('module engine playing', engineHandle.status === 'playing', [engineHandle.status, engineHandle.reason]);
  check('module engine six layers', engineHandle.variants.length === 6, engineHandle.variants.length);
  const sample = audio.setEngine({ rpm: 4200 });
  check('module setEngine six layers', sample.layers.length === 6, sample.layers.length);
  check('module setEngine finite gains', sample.layers.every((layer) => Number.isFinite(layer.gain)));
  check('module setEngine finite rates', sample.layers.every((layer) => Number.isFinite(layer.rate)));
  check('module setEngine rpm', sample.rpm === 4200, sample.rpm);
  check('module setEngine x', approx(sample.x, 0.42, 1e-12), sample.x);

  const shield = await audio.play('weapon-shield').ready;
  check('module weapon-shield loop', shield.loop === true);
  check('module weapon-shield playing', shield.status === 'playing', [shield.status, shield.reason]);

  const unknown = await audio.play('unknown-event').ready;
  check('module unknown event unsupported', unknown.status === 'unsupported', unknown.status);
  check('module unknown event reason', unknown.reason === 'unknown-event', unknown.reason);

  const snapshot = audio.snapshot();
  check('module snapshot schema', snapshot.schema === AUDIO_SCHEMA);
  check('module snapshot state', snapshot.state === 'ready', snapshot.state);
  check('module snapshot catalog', snapshot.catalog.events === EVENT_IDS.length, snapshot.catalog.events);
  check('module snapshot engine started', snapshot.engine.started === true);
  check('module snapshot engine rpm', snapshot.engine.rpm === 4200, snapshot.engine.rpm);
  check('module snapshot engine layers', snapshot.engine.layers.length === 6,
    snapshot.engine.layers.length);
  check('module snapshot engine exclusions', snapshot.engine.excluded.length === 2,
    snapshot.engine.excluded.map((item) => item.wave));
  check('module snapshot voices', snapshot.voices.length > 0, snapshot.voices.length);
  check('module snapshot decoded', snapshot.decoded.length > 0, snapshot.decoded.length);
  check('module snapshot hash verified',
    snapshot.decoded.some((entry) => entry.hashVerified === true));
  check('module no oscillator', mock.oscillatorCalls === 0, mock.oscillatorCalls);

  audio.stop();
  const stopped = audio.snapshot();
  check('module stop clears voices', stopped.voices.length === 0, stopped.voices.length);
  check('module stop clears engine', stopped.engine.started === false);

  let negativeThrew = false;
  try {
    audio.setEngine(-1);
  } catch (error) {
    negativeThrew = error instanceof RangeError;
  }
  check('module setEngine rejects negative RPM', negativeThrew);

  let missingCtxThrew = false;
  try {
    createAudio({});
  } catch (error) {
    missingCtxThrew = error instanceof TypeError;
  }
  check('module createAudio requires ctx', missingCtxThrew);

  const emptyCatalog = JSON.parse(JSON.stringify(catalog));
  emptyCatalog.events['ui-click'].variants = [];
  const emptyAudio = createAudio({
    ctx: createMockContext().ctx,
    catalog: emptyCatalog,
    fetchImpl: makeFetch(),
  });
  const emptyHandle = await emptyAudio.play('ui-click').ready;
  check('module rejects ok event with no sources',
    emptyHandle.status === 'unsupported' && emptyHandle.reason === 'catalog-unavailable',
    [emptyHandle.status, emptyHandle.reason]);

  // Suspended context must be a typed block, not a silent play.
  const suspended = createMockContext();
  suspended.ctx.state = 'suspended';
  const blockedAudio = createAudio({
    ctx: suspended.ctx,
    baseUrl: '/_work/audio/',
    catalog,
    fetchImpl: makeFetch(),
  });
  const blocked = await blockedAudio.play('ui-click').ready;
  check('module suspended context typed', blocked.status === 'unsupported', blocked.status);
  check('module suspended context reason', blocked.reason === 'context-not-running', blocked.reason);

  // A tampered file must fail the hash check, not play.
  const tampered = createAudio({
    ctx: createMockContext().ctx,
    baseUrl: '/_work/audio/',
    catalog,
    fetchImpl: makeTamperedFetch(),
  });
  const tamperedHandle = await tampered.play('ui-click').ready;
  check('module tampered file fails', tamperedHandle.status === 'failed', tamperedHandle.status);
  check('module tampered file reason', tamperedHandle.reason === 'hash-mismatch',
    tamperedHandle.reason);

  // ---------------------------------------------------------------- README
  group('readme');
  const readme = readFileSync(join(ROOT, 'probes', 'audio', 'README.md'), 'utf8');
  for (const token of [
    'runtime-audio.mjs',
    'runtime-audio.json',
    'AUDIO_SCHEMA',
    'createAudio',
    'setEngine',
    'snapshot',
    'play(event',
    'blur.audio-runtime/1',
  ]) {
    check(`README contains ${token}`, readme.includes(token));
  }
  for (const id of EVENT_IDS) {
    check(`README event table contains ${id}`, readme.includes(`\`${id}\``));
  }

  // ---------------------------------------------------------------- summary
  const passed = CHECKS.filter((item) => item.ok).length;
  const failed = CHECKS.filter((item) => !item.ok);
  const byGroup = {};
  for (const item of CHECKS) {
    byGroup[item.group] = byGroup[item.group] ?? { passed: 0, failed: 0 };
    byGroup[item.group][item.ok ? 'passed' : 'failed'] += 1;
  }
  const result = {
    generatedBy: 'probes/audio/tools/verify_runtime_audio.mjs',
    catalog: rel(CATALOG_PATH),
    checks: CHECKS.length,
    passed,
    failed: failed.length,
    byGroup,
    failures: failed.slice(0, 50),
  };
  console.log(JSON.stringify(result, null, 1));
  for (const item of failed.slice(0, 30)) {
    console.log(`FAIL [${item.group}] ${item.name}`, item.detail ?? '');
  }
  console.log(`${passed}/${CHECKS.length} checks passed`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

// ------------------------------------------------------------- mock Web Audio
function createMockContext() {
  class Param {
    constructor(value = 0) { this.value = value; }
    setTargetAtTime(value) { this.value = value; }
    setValueAtTime(value) { this.value = value; }
  }
  class Node {
    connect(destination) { this.destination = destination; return destination; }
    disconnect() {}
  }
  class Gain extends Node {
    constructor() { super(); this.gain = new Param(); }
  }
  class Source extends Node {
    constructor() {
      super();
      this.buffer = null;
      this.loop = false;
      this.loopStart = 0;
      this.loopEnd = 0;
      this.playbackRate = new Param();
      this.started = false;
      this.stopped = false;
    }
    start() { this.started = true; }
    stop() { this.stopped = true; if (this.onended) this.onended(); }
  }
  class Analyser extends Node {
    constructor() { super(); this.fftSize = 2048; }
    getFloatTimeDomainData(array) { array.fill(0); }
  }
  class Compressor extends Node {
    constructor() {
      super();
      this.threshold = new Param();
      this.knee = new Param();
      this.ratio = new Param();
      this.attack = new Param();
      this.release = new Param();
    }
  }
  const state = {
    ctx: {
      state: 'running',
      currentTime: 0,
      sampleRate: 48000,
      destination: new Node(),
      createGain() { return new Gain(); },
      createBufferSource() { return new Source(); },
      createAnalyser() { return new Analyser(); },
      createDynamicsCompressor() { return new Compressor(); },
      async decodeAudioData() {
        return {
          duration: 1,
          sampleRate: 48000,
          numberOfChannels: 1,
          length: 48000,
          getChannelData() { return new Float32Array(48000); },
        };
      },
      async resume() {},
    },
    oscillatorCalls: 0,
  };
  state.ctx.createOscillator = () => {
    state.oscillatorCalls += 1;
    throw new Error('runtime-audio must not create an oscillator');
  };
  return state;
}

function makeFetch() {
  return async (url) => {
    const key = url.replace(/^\/_work\/audio\//, '');
    const bytes = readFileSync(join(ROOT, SOURCE_ROOT, key));
    return {
      ok: true,
      status: 200,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  };
}

function makeTamperedFetch() {
  const base = makeFetch();
  return async (url) => {
    const response = await base(url);
    const original = await response.arrayBuffer();
    const bytes = new Uint8Array(original);
    bytes[Math.min(100, bytes.length - 1)] ^= 0xff;
    return {
      ok: true,
      status: 200,
      async arrayBuffer() { return bytes.buffer; },
    };
  };
}

await main();
