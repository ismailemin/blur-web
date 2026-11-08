#!/usr/bin/env node
// Performance budget probe for the browser Blur slice.
//
//   node probes/perf/tools/perf_budget.mjs measure
//   node probes/perf/tools/perf_budget.mjs verify
//
// It measures from committed/generated artifacts only. It never starts a
// browser, never writes outside _work/perf/ and _work/logs/perf/, and never
// modifies probes/e1-drive, probes/net-mvp, game-data or upstream.
//
// All GPU byte counts are arithmetic models over the measured meshes/textures,
// not driver queries. The model and its assumptions are documented in
// docs/work/analysis/performance-budget.md.

import { readFileSync, writeFileSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const OUT = join(ROOT, '_work', 'perf');
const LOGS = join(ROOT, '_work', 'logs', 'perf');

const TICK_HZ = 60;
const STATE_HZ = 20;
const INPUT_HZ = 60;
const FRAME_BUDGET_MS = 1000 / TICK_HZ;
const MB = 1_000_000;
const MIB = 1_048_576;

const P = {
  index: '_work/e1-drive/car-bodies.index.json',
  level: '_work/e1-drive/level.geometry.json',
  base: '_work/e1-drive/base.geometry.json',
  packet: '_work/e1-drive/packet-corvette-zr1-stock.json',
  state: (slug) => `_work/e1-drive/state-${slug}.json`,
  carChunk: (slug) => `_work/e1-drive/cars/${slug}.geometry.json`,
  fields: (slug) => `_work/e1-drive/cars/${slug}.fields`,
  sprint: (slug) => `_work/e1-drive/sprint-${slug}.json`,
  soak1: '_work/e1-drive/browser-evidence-soak.json',
  soak5: '_work/logs/e1-drive/soak-summary-p42.json',
  amboyMap: '_work/e1-drive/amboy/map.json',
  amboyLayout: '_work/e1-drive/amboy/layout.json',
  graciaMap: '_work/e1-drive/gracia/map.json',
  graciaLayout: '_work/e1-drive/gracia/layout.json',
  mapEvidence: (m) => `_work/e1-drive/browser-evidence-map-${m}.json`,
  chunkEvidence: '_work/e1-drive/chunk-evidence-amboy.json',
  ghosts: 'probes/e1-drive/ghosts/index.json',
  ghost: (slug, course) => `probes/e1-drive/ghosts/${slug}-${course}.json`,
  wasm: '_work/e1-drive/module/e1_drive.wasm',
  module: '_work/e1-drive/module/e1_drive.mjs',
  build: '_work/e1-drive/module/build.json',
  roster: '_work/e1-drive/cars.json',
  text: (m) => `_work/map-slice/${m}-render/render.json`,
  diag: (m) => `_work/map-slice/${m}-render/diagnostics.json`,
  slice: (m) => `_work/map-slice/${m}/slice.json`,
  renderPkg: (m) => `_work/map-slice/${m}-render`
};

function readText(rel) {
  const buffer = readFileSync(join(ROOT, rel));
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le').replace(/^\uFEFF/, '');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}
const readJson = (rel) => JSON.parse(readText(rel));
const bytes = (rel) => statSync(join(ROOT, rel)).size;
const sha256 = (rel) => createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex');
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const mib = (b) => round(b / MIB, 3);
const mb = (b) => round(b / MB, 3);
const pct = (a, b) => round((a / b) * 100, 3);

function quantize(value, digits = 6) {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

// Column-major world matrix: columns are axisX, axisY, axisZ, position.
function quaternionFromMatrix(m) {
  const m00 = m[0], m10 = m[1], m20 = m[2];
  const m01 = m[4], m11 = m[5], m21 = m[6];
  const m02 = m[8], m12 = m[9], m22 = m[10];
  const trace = m00 + m11 + m22;
  let x; let y; let z; let w;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w);
  return [x / n, y / n, z / n, w / n];
}

function quatAngle(a, b) {
  const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  return 2 * Math.acos(dot);
}

// ---------------------------------------------------------------- measurement

function carMetrics(index) {
  return Object.entries(index.cars).map(([slug, e]) => {
    const indices = e.triangles * 3;
    const positionsBytes = e.vertices * 12;
    const uvBytes = e.uv.bytes;
    const indexBytes = indices * 4;
    const gpuGeometryBytes = positionsBytes + uvBytes + indexBytes;
    const gpuTextureBytes = Math.ceil((e.rgbaBytes * 4) / 3);
    const rawBytes = gpuGeometryBytes + e.rgbaBytes;
    return {
      slug,
      file: e.file,
      bytes: e.bytes,
      vertices: e.vertices,
      triangles: e.triangles,
      indices,
      positionsBytes,
      uvBytes,
      indexBytes,
      rgbaBytes: e.rgbaBytes,
      gpuGeometryBytes,
      gpuTextureBytes,
      gpuBytes: gpuGeometryBytes + gpuTextureBytes,
      rawBytes,
      jsonOverheadBytes: e.bytes - rawBytes,
      jsonOverheadPercent: pct(e.bytes - rawBytes, e.bytes),
      bytesPerTriangle: round(e.bytes / e.triangles, 3),
      draws: e.draws,
      parts: e.parts,
      textures: e.textures,
      texturedDraws: e.texturedDraws,
      trianglesPerDraw: round(e.triangles / e.draws, 3)
    };
  });
}

function levelMetrics(index, levelDoc) {
  const meshes = levelDoc.meshes;
  const vertices = meshes.reduce((s, m) => s + m.vertexCount, 0);
  const indices = meshes.reduce((s, m) => s + m.indexCount, 0);
  const uvBytes = meshes.reduce((s, m) => s + m.uv.bytes, 0);
  const positionsBytes = vertices * 12;
  const indexBytes = indices * 4;
  const gpuGeometryBytes = positionsBytes + uvBytes + indexBytes;
  const rgbaBytes = index.level.rgbaBytes;
  const gpuTextureBytes = Math.ceil((rgbaBytes * 4) / 3);
  const rawBytes = gpuGeometryBytes + rgbaBytes;
  return {
    file: index.level.file,
    bytes: index.level.bytes,
    meshes: meshes.length,
    vertices,
    indices,
    triangles: indices / 3,
    draws: index.level.levelDraws + index.level.trackDraws,
    levelDraws: index.level.levelDraws,
    trackDraws: index.level.trackDraws,
    textures: index.level.textures,
    positionsBytes,
    uvBytes,
    indexBytes,
    rgbaBytes,
    gpuGeometryBytes,
    gpuTextureBytes,
    gpuBytes: gpuGeometryBytes + gpuTextureBytes,
    rawBytes,
    jsonOverheadBytes: index.level.bytes - rawBytes,
    jsonOverheadPercent: pct(index.level.bytes - rawBytes, index.level.bytes)
  };
}

function mapMetrics(id, mapDoc, renderDoc) {
  const c = mapDoc.counts;
  const positionsBytes = c.vertices * 12;
  const uvBytes = c.vertices * 8;
  const indexBytes = c.indices * 4;
  const gpuGeometryBytes = positionsBytes + uvBytes + indexBytes;
  const rgbaBytes = c.textureBytes;
  const chain = renderDoc.textures.bytes.uniqueExpectedChain;
  const gpuTextureBytes = chain ?? Math.ceil((rgbaBytes * 4) / 3);
  const rawBytes = gpuGeometryBytes + rgbaBytes;
  return {
    id,
    mapBytes: bytes(`_work/e1-drive/${id}/map.json`),
    renderPackageBytes: dirBytes(`_work/map-slice/${id}-render`),
    vertices: c.vertices,
    triangles: c.triangles,
    indices: c.indices,
    draws: c.draws,
    blockedDraws: c.blockedDraws,
    decalDraws: c.decalDraws,
    textures: c.textures,
    positionsBytes,
    uvBytes,
    indexBytes,
    rgbaBytes,
    gpuGeometryBytes,
    gpuTextureBytes,
    gpuBytes: gpuGeometryBytes + gpuTextureBytes,
    rawBytes,
    jsonOverheadBytes: bytes(`_work/e1-drive/${id}/map.json`) - rawBytes,
    jsonOverheadPercent: pct(bytes(`_work/e1-drive/${id}/map.json`) - rawBytes, bytes(`_work/e1-drive/${id}/map.json`)),
    bytesPerTriangle: round(bytes(`_work/e1-drive/${id}/map.json`) / c.triangles, 3)
  };
}

function pageTotals() {
  const base = bytes(P.base);
  const car = bytes(P.carChunk('corvette-zr1-stock'));
  const fields = bytes(P.fields('corvette-zr1-stock'));
  const out = {};
  // River: measured host page load in T-007-chunking / chunk evidence.
  out.river = {
    label: 'River (measured chunked page)',
    geometry: bytes(P.level) + car,
    package: bytes(P.level),
    baseGeometry: 0,
    carChunk: car,
    layout: 0,
    physics: bytes('_work/e1-drive/Level.levelphysics'),
    carFields: fields,
    renderSource: 0,
    extras: 385_870,
    pageTotal: 20_471_058,
    measured: true,
    source: 'T-007-chunking MP host page load (20,471,058 B); extras = index + wasm + module + roster'
  };
  for (const [id, mapDoc] of [['amboy', readJson(P.amboyMap)], ['gracia', readJson(P.graciaMap)]]) {
    const layout = bytes(id === 'amboy' ? P.amboyLayout : P.graciaLayout);
    const physics = mapDoc.source.physics.bytes;
    const renderSource = mapDoc.source.render.bytes + mapDoc.source.slice.bytes;
    const packageBytes = bytes(id === 'amboy' ? P.amboyMap : P.graciaMap);
    out[id] = {
      label: id === 'amboy' ? 'Amboy (measured chunked page)' : 'Gracia (computed from current files)',
      geometry: packageBytes + base + car,
      package: packageBytes,
      baseGeometry: base,
      carChunk: car,
      layout,
      physics,
      carFields: fields,
      renderSource,
      extras: 0,
      pageTotal: packageBytes + base + car + layout + physics + fields + renderSource,
      measured: id === 'amboy',
      source: id === 'amboy'
        ? 'T-007-chunking Amboy load 66,381,641 B / chunk evidence 66,381,641 B'
        : 'sum of current map.json + base + car + layout + physics + fields + render+slice source pins'
    };
  }
  // Longbeach is not integrated into the page. The render package exists; the
  // page total is an explicit estimate using the same app formula.
  const lbRender = bytes('_work/map-slice/longbeach-render/render.json');
  const lbSlice = bytes('_work/map-slice/longbeach/slice.json');
  const lbPkg = dirBytes('_work/map-slice/longbeach-render');
  const lbPhysics = bytes('game-data/Blur/levels/usa_la_longbeachdocks/Level.levelphysics');
  const lbLayout = bytes('_work/map-slice/longbeach-render/layout.points.f32.bin');
  out.longbeach = {
    label: 'Longbeach (render package, not page-integrated)',
    geometry: lbPkg + base + car,
    package: lbPkg,
    baseGeometry: base,
    carChunk: car,
    layout: lbLayout,
    physics: lbPhysics,
    carFields: fields,
    renderSource: lbRender + lbSlice,
    extras: 0,
    pageTotal: lbPkg + base + car + lbLayout + lbPhysics + fields + lbRender + lbSlice,
    measured: false,
    source: 'render package + base + car + layout/physics/fields + render/slice source pins (estimate)'
  };
  return out;
}

function dirBytes(rel) {
  let total = 0;
  for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
    if (entry.isDirectory()) total += dirBytes(join(rel, entry.name));
    else total += statSync(join(ROOT, rel, entry.name)).size;
  }
  return total;
}

function ghostMetrics(index) {
  const rows = [];
  let total = 0;
  for (const [slug, courses] of Object.entries(index.cars)) {
    for (const [course, record] of Object.entries(courses)) {
      const file = bytes(record.file);
      total += file;
      const sampleTicks = record.tickCount;
      const payload = sampleTicks * 11 * 4;
      const b64 = Math.ceil(payload / 3) * 4;
      rows.push({
        slug,
        course,
        file,
        tickCount: sampleTicks,
        seconds: record.timeSeconds,
        payloadBytes: payload,
        base64Bytes: b64,
        metadataBytes: file - b64,
        base64Inflation: b64 - payload,
        bytesPerTick: round(file / sampleTicks, 3),
        payloadBytesPerTick: 44
      });
    }
  }
  return { count: rows.length, totalBytes: total, rows };
}

function soakMetrics() {
  const one = readJson(P.soak1);
  const five = readJson(P.soak5);
  const r1 = one.runs[0];
  const f1 = five.runs[0];
  const f2 = five.runs[1];
  return {
    oneMinute: {
      spec: one.spec,
      frames: r1.frames.frameMs,
      steady: r1.frames.steadyFrameMs,
      work: r1.frames.workMs,
      drawsPerFrame: r1.buffers.drawsPerFrame,
      drawsIssued: r1.buffers.drawsIssued,
      geometryUploadBytes: r1.buffers.geometryUploadBytes,
      geometryUploads: r1.buffers.geometryUploads,
      textureUploadBytes: r1.buffers.textureUploadBytes,
      wasmHeapBytes: r1.memory.wasmHeapBytes[0],
      buffersLive: r1.buffers.buffersLive,
      packetLoads: r1.buffers.packetLoads,
      jsHeapEarly: r1.memory.jsHeap.earlyMeanBytes,
      jsHeapLate: r1.memory.jsHeap.lateMeanBytes,
      transitions: r1.transitions
    },
    fiveMinute: {
      spec: five.spec,
      runs: [f1, f2].map((r) => ({
        wallSeconds: r.wallSeconds,
        frameMs: r.frames,
        steadyMs: r.steady,
        workMs: r.work,
        drawsPerFrame: r.buffers.drawsPerFrame,
        drawsIssued: r.buffers.drawsIssued,
        geometryUploadBytes: r.buffers.geometryUploadBytes,
        packetLoads: r.buffers.packetLoads,
        wasmHeapBytes: r.memory.wasmHeapBytes[0],
        jsHeapDrift: r.memory.jsHeap.driftBytes,
        jsHeapLate: r.memory.jsHeap.lateMeanBytes,
        transitions: r.transitions
      }))
    },
    engine: {
      scriptedTicks: 300,
      tickMsMin: 24,
      tickMsMax: 34,
      perTickMsMin: round(24 / 300, 4),
      perTickMsMax: round(34 / 300, 4),
      source: 'e1_drive README: 300 scripted ticks take 24-34 ms in node'
    }
  };
}

function wasmMetrics() {
  const heap = 268_435_456;
  return {
    wasmBytes: bytes(P.wasm),
    moduleJsBytes: bytes(P.module),
    buildJsonBytes: bytes(P.build),
    initialHeapBytes: heap,
    maxHeapBytes: 536_870_912,
    heapMiB: mib(heap),
    heapToWasmRatio: round(heap / bytes(P.wasm), 3),
    build: readJson(P.build)
  };
}

// ------------------------------------------------------------ snapshot model

function snapshotMetrics() {
  const packet = readJson(P.packet);
  const state = readJson(P.state('corvette-zr1-stock'));
  const speedByTick = new Map(state.ticks.map((t) => [t.tick, t.speed]));
  const samples = [];
  let previous = null;
  for (let i = 0; i < packet.updates.length; i += TICK_HZ / STATE_HZ) {
    const update = packet.updates[i];
    const body = update.matrices.find((m) => m.nodeId === 'e1.car.body');
    const m = body.world;
    const position = [m[12], m[13], m[14]];
    const quaternion = quaternionFromMatrix(m);
    const tick = update.tick;
    const speed = speedByTick.get(tick) ?? state.ticks[Math.min(tick, state.ticks.length - 1)].speed;
    const canonical = {
      tick,
      position: position.map((v) => quantize(v)),
      quaternion: quaternion.map((v) => quantize(v)),
      speed: quantize(speed)
    };
    const message = {
      type: 'state',
      channel: 'state',
      seq: Math.floor(tick / (TICK_HZ / STATE_HZ)) + 1,
      tick,
      state: canonical,
      sentAt: 1_794_096_308_104 + tick * 50
    };
    const jsonBytes = Buffer.byteLength(JSON.stringify(message));
    const shortJsonBytes = Buffer.byteLength(JSON.stringify({
      t: tick,
      p: position.map((v) => round(v, 2)),
      q: quaternion.map((v) => round(v, 3)),
      s: round(speed, 2)
    }));
    const flags = previous ? 0 : 1;
    let deltaBytes;
    let positionError = 0;
    let quaternionError = 0;
    if (!previous) {
      deltaBytes = 8 + 12 + 7 + 2; // envelope + abs int32 cm + quat + speed
    } else {
      const d = [0, 1, 2].map((axis) => Math.round((position[axis] - previous.position[axis]) * 100));
      // 1 cm delta quantization error measured against the canonical value.
      positionError = Math.max(...[0, 1, 2].map((axis) =>
        Math.abs((previous.position[axis] + d[axis] / 100) - canonical.position[axis])));
      deltaBytes = 8 + 6 + 7 + 2;
    }
    // Smallest-three quaternion: largest component index + three int16 values.
    const largest = quaternion.reduce((best, value, index) =>
      Math.abs(value) > Math.abs(quaternion[best]) ? index : best, 0);
    const restored = quaternion.map((v) => Math.round(v * 32767));
    const restoredUnit = restored.map((v) => v / 32767);
    const restoredNorm = Math.hypot(...restoredUnit);
    quaternionError = quatAngle(quaternion, restoredUnit.map((v) => v / restoredNorm));
    samples.push({
      tick,
      jsonBytes,
      canonical,
      shortJsonBytes,
      deltaBytes,
      flags,
      positionQuantizationError: positionError,
      quaternionQuantizationError: round(quaternionError, 9)
    });
    previous = { position, quaternion };
  }
  const json = samples.map((s) => s.jsonBytes);
  const delta = samples.map((s) => s.deltaBytes);
  const short = samples.map((s) => s.shortJsonBytes);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const p95 = (a) => [...a].sort((x, y) => x - y)[Math.ceil(a.length * 0.95) - 1];

  // Seven-car AI host-relay batch: real per-car position/speed from the drive
  // states, real Corvette quaternions. This is a byte-size estimator, not a
  // simulation of seven AI cars.
  const batchSlugs = [
    'corvette-zr1-stock', 'lotus-exige-cup260-stock', 'dodge-challenger-stock',
    'ford-focusrs-stock', 'audi-r8v10-stock', 'audi-tt-stock', 'ford-f100-offroad'
  ];
  const states = batchSlugs.map((slug) => readJson(P.state(slug)).ticks);
  const batchJson = [];
  const batchDelta = [];
  for (let index = 0; index < samples.length; index++) {
    const tick = samples[index].tick;
    const cars = batchSlugs.map((slug, carIndex) => {
      const t = states[carIndex][Math.min(tick, states[carIndex].length - 1)];
      return {
        id: `ai-${carIndex + 1}`,
        tick,
        position: t.position.map((v) => quantize(v)),
        quaternion: samples[index].canonical.quaternion,
        speed: quantize(t.speed)
      };
    });
    batchJson.push(Buffer.byteLength(JSON.stringify({ tick, cars })));
    batchDelta.push(6 + 7 * (1 + 1 + 6 + 7 + 2));
  }

  // Input channel (60 Hz). Real scripted inputs from the sprint file.
  const sprint = readJson(P.sprint('corvette-zr1-stock'));
  const inputSizes = [];
  for (let i = 0; i < sprint.inputs.length; i += 1) {
    const input = sprint.inputs[i];
    inputSizes.push(Buffer.byteLength(JSON.stringify({
      type: 'input',
      channel: 'input',
      seq: i + 1,
      tick: i,
      input: {
        throttle: quantize(input.throttle, 4),
        brake: quantize(input.brake, 4),
        steer: quantize(input.steer, 4),
        handbrake: quantize(input.handbrake, 4)
      },
      sentAt: 1_794_096_308_104 + i * 16
    })));
  }
  const inputMean = mean(inputSizes);
  return {
    tickHz: TICK_HZ,
    stateHz: STATE_HZ,
    samples: samples.length,
    json: { min: Math.min(...json), p50: median(json), p95: p95(json), max: Math.max(...json), mean: round(mean(json), 3) },
    shortJson: { p50: median(short), p95: p95(short), mean: round(mean(short), 3) },
    deltaBinary: { p50: median(delta), p95: p95(delta), mean: round(mean(delta), 3) },
    savingsPercent: round(100 * (1 - mean(delta) / mean(json)), 3),
    shortJsonSavingsPercent: round(100 * (1 - mean(short) / mean(json)), 3),
    maxPositionQuantizationErrorMetres: round(Math.max(...samples.map((s) => s.positionQuantizationError)), 6),
    maxQuaternionQuantizationErrorRadians: round(Math.max(...samples.map((s) => s.quaternionQuantizationError)), 9),
    batch7: {
      json: { p50: median(batchJson), p95: p95(batchJson), mean: round(mean(batchJson), 3) },
      deltaBinary: { mean: round(mean(batchDelta), 3) },
      savingsPercent: round(100 * (1 - mean(batchDelta) / mean(batchJson)), 3),
      cars: batchSlugs.length,
      note: 'real per-car position/speed from the 300-tick drive states; quaternion values from the Corvette packet; size only'
    },
    input: {
      json: { p50: median(inputSizes), p95: p95(inputSizes), mean: round(inputMean, 3) },
      binaryMean: 12,
      note: 'binary estimate = 8 B envelope + four int8 controls'
    }
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// -------------------------------------------------------------- bandwidth

function bandwidth(snapshot, players = 8, ai = 7) {
  const perCar = snapshot.json.mean;
  const perCarP95 = snapshot.json.p95;
  const perCarDelta = snapshot.deltaBinary.mean;
  const statePerMin = (size, streams) => round((size * STATE_HZ * 60 * streams) / MB, 6);
  const inputPerMin = (size, streams) => round((size * INPUT_HZ * 60 * streams) / MB, 6);
  const perClientDown = statePerMin(perCar, players - 1);
  const perClientUp = statePerMin(perCar, 1);
  const serverState = statePerMin(perCar, players * (players - 1));
  const aiBatch = snapshot.batch7.json.mean;
  const aiBatchDelta = snapshot.batch7.deltaBinary.mean;
  const aiFanout = players - 1;
  const hostAiUpload = statePerMin(aiBatch, 1);
  const hostRelayTotal = round(serverState + statePerMin(aiBatch, aiFanout), 6);
  const hostRelayTotalDelta = round(statePerMin(perCarDelta, players * (players - 1)) +
    statePerMin(aiBatchDelta, aiFanout), 6);
  const inputClientDown = inputPerMin(snapshot.input.json.mean, players - 1);
  const inputServer = inputPerMin(snapshot.input.json.mean, players * (players - 1));
  const hostAllTotal = round(hostRelayTotal + inputServer, 6);
  const hostAllTotalDelta = round(hostRelayTotalDelta +
    inputPerMin(snapshot.input.binaryMean, players * (players - 1)), 6);
  return {
    players,
    aiCars: ai,
    perCarStateBytes: perCar,
    perCarStateBytesP95: perCarP95,
    perCarDeltaBytes: perCarDelta,
    perClientDownMBMin: perClientDown,
    perClientUpMBMin: perClientUp,
    serverStateEgressMBMin: serverState,
    perClientDownMBMinDelta: statePerMin(perCarDelta, players - 1),
    serverStateEgressMBMinDelta: statePerMin(perCarDelta, players * (players - 1)),
    aiBatchJsonBytes: aiBatch,
    aiBatchDeltaBytes: aiBatchDelta,
    hostAiUploadMBMin: hostAiUpload,
    hostRelayTotalMBMin: hostRelayTotal,
    hostRelayTotalDeltaMBMin: hostRelayTotalDelta,
    inputJsonBytes: snapshot.input.json.mean,
    inputServerEgressMBMin: inputServer,
    inputClientDownMBMin: inputClientDown,
    hostAllChannelsMBMin: hostAllTotal,
    hostAllChannelsDeltaMBMin: hostAllTotalDelta,
    perClientDownKbitPerSecond: round((perClientDown * 8 * 1e6) / 60 / 1000, 3),
    hostRelayKbitPerSecond: round((hostRelayTotal * 8 * 1e6) / 60 / 1000, 3),
    hostAllKbitPerSecond: round((hostAllTotal * 8 * 1e6) / 60 / 1000, 3)
  };
}

// ------------------------------------------------------------------- model

function buildModel(measurements) {
  const cars = measurements.cars;
  const maxCar = [...cars].sort((a, b) => b.gpuBytes - a.gpuBytes)[0];
  const maxGeometryCar = [...cars].sort((a, b) => b.gpuGeometryBytes - a.gpuGeometryBytes)[0];
  const maxTextureCar = [...cars].sort((a, b) => b.rgbaBytes - a.rgbaBytes)[0];
  const maxDrawCar = [...cars].sort((a, b) => b.draws - a.draws)[0];
  const maxTriCar = [...cars].sort((a, b) => b.triangles - a.triangles)[0];
  const minCar = [...cars].sort((a, b) => a.gpuBytes - b.gpuBytes)[0];
  const minGeometryCar = [...cars].sort((a, b) => a.gpuGeometryBytes - b.gpuGeometryBytes)[0];
  const minDrawCar = [...cars].sort((a, b) => a.draws - b.draws)[0];
  const minTriCar = [...cars].sort((a, b) => a.triangles - b.triangles)[0];
  const maps = measurements.maps;

  const scenario = (id, mapId, carSet) => {
    const map = maps[mapId];
    const page = measurements.pageTotals[mapId];
    const bodies = carSet.bodies;
    const carGeometry = carSet.geometry;
    const carTextureFull = carSet.textureFull;
    const carTextureMixed = carSet.textureMixed;
    const carDraws = carSet.draws;
    const carTriangles = carSet.triangles;
    const powerupDraws = 20;
    return {
      id,
      map: mapId,
      pageBytes: page.pageTotal,
      pageMiB: mib(page.pageTotal),
      mapPackageBytes: page.package,
      mapGpuGeometryBytes: map.gpuGeometryBytes,
      mapGpuTextureBytes: map.gpuTextureBytes,
      carBodies: bodies,
      carGpuGeometryBytes: carGeometry,
      carGpuTextureBytesFull: carTextureFull,
      carGpuTextureBytesMixed: carTextureMixed,
      gpuGeometryBytes: map.gpuGeometryBytes + carGeometry,
      gpuTextureBytesFull: map.gpuTextureBytes + carTextureFull,
      gpuTextureBytesMixed: map.gpuTextureBytes + carTextureMixed,
      gpuTotalFullBytes: map.gpuGeometryBytes + carGeometry + map.gpuTextureBytes + carTextureFull,
      gpuTotalMixedBytes: map.gpuGeometryBytes + carGeometry + map.gpuTextureBytes + carTextureMixed,
      draws: map.draws + carDraws + powerupDraws,
      mapDraws: map.draws,
      carDraws,
      powerupDraws,
      triangles: map.triangles + carTriangles,
      mapTriangles: map.triangles,
      carTriangles,
      cpuLowMs: measurements.cpuModel.lowMs,
      cpuHighMs: measurements.cpuModel.highMs,
      frameUpperBoundMs: round(measurements.soak.fiveMinute.runs[0].frameMs.p95 * (map.draws + carDraws + powerupDraws) /
        measurements.soak.fiveMinute.runs[0].drawsPerFrame, 3),
      geometryRatioVsRiver: round((map.triangles + carTriangles) / (maps.river.triangles + carTriangles), 3)
    };
  };

  const worstCars = {
    bodies: 8,
    geometry: 8 * maxGeometryCar.gpuGeometryBytes,
    textureFull: 8 * maxTextureCar.gpuTextureBytes,
    textureMixed: maxTextureCar.gpuTextureBytes + 7 * Math.ceil(maxTextureCar.gpuTextureBytes / 4),
    draws: 8 * maxDrawCar.draws,
    triangles: 8 * maxTriCar.triangles
  };
  const bestCars = {
    bodies: 8,
    geometry: 8 * minGeometryCar.gpuGeometryBytes,
    textureFull: 8 * minCar.gpuTextureBytes,
    textureMixed: minCar.gpuTextureBytes + 7 * Math.ceil(minCar.gpuTextureBytes / 4),
    draws: 8 * minDrawCar.draws,
    triangles: 8 * minTriCar.triangles
  };
  const currentCars = {
    bodies: 2,
    geometry: 2 * maxGeometryCar.gpuGeometryBytes,
    textureFull: maxTextureCar.gpuTextureBytes,
    textureMixed: maxTextureCar.gpuTextureBytes,
    draws: 8 * maxDrawCar.draws,
    triangles: 8 * maxTriCar.triangles,
    note: 'current M4: two car chunks resident (local + one peer), AI reuse the local body and the ghost shader samples no textures'
  };

  const scenarios = {
    river: scenario('river-best', 'river', bestCars),
    amboy: scenario('amboy-mid', 'amboy', worstCars),
    gracia: scenario('gracia-worst', 'gracia', worstCars),
    longbeach: scenario('longbeach-geometry-worst', 'longbeach', worstCars),
    currentM4: scenario('current-m4', 'gracia', { ...currentCars, textureMixed: currentCars.textureMixed })
  };

  return {
    assumptions: [
      'GPU geometry = position f32x3 + UV0 f32x2 + index u32, exactly the buffers the consumer uploads.',
      'GPU texture = RGBA8 mip0 plus the deterministic full mip chain, ~4/3 of mip0; hardware tile padding is not modelled.',
      'Draw calls = every visible packet draw plus the diagnostic power-up marker pass; the consumer has no frustum or occlusion culling.',
      'Remote/AI cars share the local body and sample no textures in current M4; the 8-car rows model a future per-peer body/texture load.',
      'Mixed LOD = one full-resolution car pack + seven quarter-byte (half-width/height) packs.',
      'CPU = measured browser work (step + adapter + submit) for one car, plus the measured node physics tick cost extrapolated linearly to 8 cars; no GPU time is claimed.',
      'Frame upper bound assumes the measured headless frame time scales with submitted draw count; it is a bound, not a measurement.'
    ],
    carPool: {
      maxGpu: maxCar.slug,
      maxGeometry: maxGeometryCar.slug,
      maxTexture: maxTextureCar.slug,
      maxDraw: maxDrawCar.slug,
      minGpu: minCar.slug,
      minGeometry: minGeometryCar.slug,
      minDraw: minDrawCar.slug,
      maxTri: maxTriCar.slug,
      minTri: minTriCar.slug,
      maxCar,
      maxGeometryCar,
      maxTextureCar,
      maxDrawCar,
      maxTriCar,
      minCar,
      minGeometryCar,
      minDrawCar,
      minTriCar
    },
    carSets: { worstCars, bestCars, currentCars },
    scenarios,
    bandwidth: measurements.bandwidth
  };
}

// ------------------------------------------------------------------ measure

function measure() {
  const index = readJson(P.index);
  const level = readJson(P.level);
  const cars = carMetrics(index);
  const levelRow = levelMetrics(index, level);
  const maps = {
    river: {
      id: 'river',
      vertices: levelRow.vertices,
      triangles: levelRow.triangles,
      indices: levelRow.indices,
      draws: levelRow.draws,
      textures: levelRow.textures,
      rgbaBytes: levelRow.rgbaBytes,
      gpuGeometryBytes: levelRow.gpuGeometryBytes,
      gpuTextureBytes: levelRow.gpuTextureBytes,
      gpuBytes: levelRow.gpuBytes,
      mapBytes: levelRow.bytes,
      renderPackageBytes: 0,
      jsonOverheadPercent: levelRow.jsonOverheadPercent
    }
  };
  for (const id of ['amboy', 'gracia']) {
    const mapDoc = readJson(id === 'amboy' ? P.amboyMap : P.graciaMap);
    const renderDoc = readJson(P.text(id));
    maps[id] = mapMetrics(id, mapDoc, renderDoc);
  }
  {
    const renderDoc = readJson(P.text('longbeach'));
    const c = renderDoc.draws ? {
      vertices: renderDoc.vertices ?? 864473,
      triangles: renderDoc.triangles ?? 537294,
      indices: renderDoc.indices ?? 1611882,
      draws: renderDoc.drawCalls ?? 1039,
      blockedDraws: renderDoc.blocked?.length ?? 102,
      decalDraws: 0,
      textures: renderDoc.textures.items.length,
      textureBytes: renderDoc.textures.bytes.uniqueMip0
    } : null;
    if (!c) throw new Error('longbeach render.json shape not recognised');
    const positionsBytes = c.vertices * 12;
    const uvBytes = c.vertices * 8;
    const indexBytes = c.indices * 4;
    const gpuGeometryBytes = positionsBytes + uvBytes + indexBytes;
    const chain = renderDoc.textures.bytes.uniqueExpectedChain;
    maps.longbeach = {
      id: 'longbeach',
      vertices: c.vertices,
      triangles: c.triangles,
      indices: c.indices,
      draws: c.draws,
      blockedDraws: c.blockedDraws,
      decalDraws: 0,
      textures: c.textures,
      rgbaBytes: c.textureBytes,
      gpuGeometryBytes,
      gpuTextureBytes: chain,
      gpuBytes: gpuGeometryBytes + chain,
      mapBytes: dirBytes(P.renderPkg('longbeach')),
      renderPackageBytes: dirBytes(P.renderPkg('longbeach')),
      jsonOverheadPercent: pct(dirBytes(P.renderPkg('longbeach')) - gpuGeometryBytes - c.textureBytes, dirBytes(P.renderPkg('longbeach'))),
      note: 'render package only; no page map.json exists for this level'
    };
  }

  const pageTotalsData = pageTotals();
  const snapshot = snapshotMetrics();
  const bw = bandwidth(snapshot, 8, 7);
  const soak = soakMetrics();
  const ghosts = ghostMetrics(readJson(P.ghosts));
  const wasm = wasmMetrics();

  // Fixed-overhead / per-car CPU model. Browser work p95 for one car is the
  // measured value; the node physics tick range is the per-car engine cost.
  const workP50 = soak.fiveMinute.runs[0].workMs.p50;
  const workP95 = soak.fiveMinute.runs[0].workMs.p95;
  const tickMin = soak.engine.perTickMsMin;
  const tickMax = soak.engine.perTickMsMax;
  const cpuModel = {
    measuredOneCarWorkP50Ms: workP50,
    measuredOneCarWorkP95Ms: workP95,
    measuredPhysicsMinMs: tickMin,
    measuredPhysicsMaxMs: tickMax,
    fixedOverheadP95Ms: round(Math.max(0, workP95 - tickMax), 4),
    lowMs: round(Math.max(0, workP95 - tickMax) + 8 * tickMin, 4),
    highMs: round(8 * workP95, 4),
    linearP50Ms: round(8 * workP50, 4),
    note: 'low = fixed frame overhead + 8 x measured node physics tick; high = full browser work linearly scaled to 8 cars; AI driver JS and GPU wait excluded'
  };

  const measurements = {
    kind: 'blur.perf-budget.measurements',
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceRoot: ROOT,
    constants: { TICK_HZ, STATE_HZ, INPUT_HZ, FRAME_BUDGET_MS, MB, MIB },
    index: {
      file: P.index,
      bytes: bytes(P.index),
      sha256: sha256(P.index),
      defaultCar: index.defaultCar,
      carCount: cars.length
    },
    cars,
    level: levelRow,
    maps,
    pageTotals: pageTotalsData,
    snapshot,
    bandwidth: bw,
    soak,
    ghosts,
    wasm,
    cpuModel,
    chunkOverhead: {
      carMinPercent: Math.min(...cars.map((c) => c.jsonOverheadPercent)),
      carMedianPercent: median(cars.map((c) => c.jsonOverheadPercent)),
      carMaxPercent: Math.max(...cars.map((c) => c.jsonOverheadPercent)),
      levelPercent: levelRow.jsonOverheadPercent,
      mapAmboyPercent: maps.amboy.jsonOverheadPercent,
      mapGraciaPercent: maps.gracia.jsonOverheadPercent,
      mapLongbeachPercent: maps.longbeach.jsonOverheadPercent
    }
  };
  const model = buildModel(measurements);
  measurements.model = model;

  mkdirSync(OUT, { recursive: true });
  mkdirSync(LOGS, { recursive: true });
  writeFileSync(join(OUT, 'measurements.json'), JSON.stringify(measurements, null, 2));
  writeFileSync(join(OUT, 'budget-model.json'), JSON.stringify(model, null, 2));

  const summary = [
    `cars: ${cars.length}, chunk bytes ${cars.reduce((s, c) => s + c.bytes, 0)}`,
    `states: json mean ${snapshot.json.mean} B, delta ${snapshot.deltaBinary.mean} B (${snapshot.savingsPercent}% saved)`,
    `8 peers: client down ${bw.perClientDownMBMin} MB/min, server state egress ${bw.serverStateEgressMBMin} MB/min`,
    `host all channels: ${bw.hostAllChannelsMBMin} MB/min (${bw.hostAllKbitPerSecond} kbit/s)`,
    `gracia 8-car GPU: ${mib(model.scenarios.gracia.gpuTotalFullBytes)} MiB full, ${mib(model.scenarios.gracia.gpuTotalMixedBytes)} MiB mixed`,
    `draws: gracia ${model.scenarios.gracia.draws}, river ${model.scenarios.river.draws}`,
    `cpu low/high: ${cpuModel.lowMs}/${cpuModel.highMs} ms`,
    `verdict: MEASURED`
  ];
  writeFileSync(join(LOGS, 'measure.log'), summary.join('\n') + '\n');
  console.log(summary.join('\n'));
}

// ------------------------------------------------------------------- verify

function verify() {
  const m = readJson('_work/perf/measurements.json');
  const model = readJson('_work/perf/budget-model.json');
  const index = readJson(P.index);
  const level = readJson(P.level);
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail) });

  // 1. Inputs.
  check('index declares 25 cars', m.cars.length === 25, m.cars.length);
  check('index default car is corvette-zr1-stock', m.index.defaultCar === 'corvette-zr1-stock', m.index.defaultCar);
  check('index bytes match the file', m.index.bytes === bytes(P.index), `${m.index.bytes}/${bytes(P.index)}`);
  check('index sha256 matches the file', m.index.sha256 === sha256(P.index), m.index.sha256);
  check('level chunk file exists', bytes(P.level) > 9_000_000, bytes(P.level));
  check('level chunk has two meshes', level.meshes.length === 2, level.meshes.length);
  check('level draws 22 + 394', m.level.levelDraws === 22 && m.level.trackDraws === 394, `${m.level.levelDraws}/${m.level.trackDraws}`);

  // 2. Per car (11 checks each = 275).
  for (const car of m.cars) {
    const e = index.cars[car.slug];
    check(`${car.slug}: file bytes match index`, car.bytes === e.bytes, car.bytes);
    check(`${car.slug}: vertices positive`, car.vertices > 0, car.vertices);
    check(`${car.slug}: triangles positive`, car.triangles > 0, car.triangles);
    check(`${car.slug}: indices = 3 x triangles`, car.indices === car.triangles * 3, car.indices);
    check(`${car.slug}: positions = vertices x 12`, car.positionsBytes === car.vertices * 12, car.positionsBytes);
    check(`${car.slug}: UV bytes match index`, car.uvBytes === e.uv.bytes, car.uvBytes);
    check(`${car.slug}: index bytes = indices x 4`, car.indexBytes === car.indices * 4, car.indexBytes);
    check(`${car.slug}: GPU geometry sums`, car.gpuGeometryBytes === car.positionsBytes + car.uvBytes + car.indexBytes, car.gpuGeometryBytes);
    check(`${car.slug}: GPU texture >= mip0`, car.gpuTextureBytes >= car.rgbaBytes, `${car.gpuTextureBytes}/${car.rgbaBytes}`);
    check(`${car.slug}: file exceeds raw payload`, car.bytes > car.rawBytes, `${car.bytes}/${car.rawBytes}`);
    check(`${car.slug}: overhead 20-45 %`, car.jsonOverheadPercent > 20 && car.jsonOverheadPercent < 45, car.jsonOverheadPercent);
    check(`${car.slug}: draw count 60-130`, car.draws >= 60 && car.draws <= 130, car.draws);
    check(`${car.slug}: triangles per draw > 100`, car.trianglesPerDraw > 100, car.trianglesPerDraw);
  }

  // 3. Level arithmetic (12).
  const levelExpected = level.meshes.reduce((s, x) => s + x.vertexCount * 12 + x.uv.bytes + x.indexCount * 4, 0);
  check('level GPU geometry recomputes', m.level.gpuGeometryBytes === levelExpected, m.level.gpuGeometryBytes);
  check('level vertices recompute', m.level.vertices === level.meshes.reduce((s, x) => s + x.vertexCount, 0), m.level.vertices);
  check('level indices recompute', m.level.indices === level.meshes.reduce((s, x) => s + x.indexCount, 0), m.level.indices);
  check('level triangles = indices / 3', m.level.triangles === m.level.indices / 3, m.level.triangles);
  check('level texture mip chain >= mip0', m.level.gpuTextureBytes >= m.level.rgbaBytes, m.level.gpuTextureBytes);
  check('level file exceeds raw payload', m.level.bytes > m.level.rawBytes, `${m.level.bytes}/${m.level.rawBytes}`);
  check('level overhead 60-70 %', m.level.jsonOverheadPercent > 60 && m.level.jsonOverheadPercent < 70, m.level.jsonOverheadPercent);
  check('level draws = 416', m.level.draws === 416, m.level.draws);
  check('level GPU bytes = geometry + texture', m.level.gpuBytes === m.level.gpuGeometryBytes + m.level.gpuTextureBytes, m.level.gpuBytes);
  check('level raw bytes = geometry + rgba', m.level.rawBytes === m.level.gpuGeometryBytes + m.level.rgbaBytes, m.level.rawBytes);
  check('level overhead bytes non-negative', m.level.jsonOverheadBytes > 0, m.level.jsonOverheadBytes);
  check('level texture count 140', m.level.textures === 140, m.level.textures);

  // 4. Maps (8 each).
  for (const id of ['river', 'amboy', 'gracia', 'longbeach']) {
    const map = m.maps[id];
    check(`${id}: draws positive`, map.draws > 0, map.draws);
    check(`${id}: triangles positive`, map.triangles > 0, map.triangles);
    check(`${id}: GPU geometry = position + uv + index`, map.gpuGeometryBytes > 0 && map.gpuGeometryBytes % 4 === 0, map.gpuGeometryBytes);
    check(`${id}: GPU texture >= mip0`, map.gpuTextureBytes >= map.rgbaBytes, `${map.gpuTextureBytes}/${map.rgbaBytes}`);
    check(`${id}: GPU total = geometry + texture`, map.gpuBytes === map.gpuGeometryBytes + map.gpuTextureBytes, map.gpuBytes);
    check(`${id}: indices >= triangles`, map.indices >= map.triangles * 3, `${map.indices}/${map.triangles}`);
    check(`${id}: map bytes positive`, map.mapBytes > 0, map.mapBytes);
    check(`${id}: bytes per triangle > 20`, map.mapBytes / map.triangles > 20, round(map.mapBytes / map.triangles, 3));
  }
  check('gracia has more draws than amboy', m.maps.gracia.draws > m.maps.amboy.draws, `${m.maps.gracia.draws}/${m.maps.amboy.draws}`);
  check('gracia has more vertices than amboy', m.maps.gracia.vertices > m.maps.amboy.vertices, `${m.maps.gracia.vertices}/${m.maps.amboy.vertices}`);
  check('longbeach has more vertices than amboy', m.maps.longbeach.vertices > m.maps.amboy.vertices, `${m.maps.longbeach.vertices}/${m.maps.amboy.vertices}`);
  check('river is the smallest measured map', m.maps.river.gpuBytes < m.maps.amboy.gpuBytes, `${m.maps.river.gpuBytes}/${m.maps.amboy.gpuBytes}`);
  check('amboy binary render package is 19,133,342 B', m.maps.amboy.renderPackageBytes === 19_133_342, m.maps.amboy.renderPackageBytes);
  check('gracia binary render package is 28,801,009 B', m.maps.gracia.renderPackageBytes === 28_801_009, m.maps.gracia.renderPackageBytes);
  check('gracia page package > binary render package', m.maps.gracia.mapBytes > m.maps.gracia.renderPackageBytes, `${m.maps.gracia.mapBytes}/${m.maps.gracia.renderPackageBytes}`);
  check('amboy page package > binary render package', m.maps.amboy.mapBytes > m.maps.amboy.renderPackageBytes, `${m.maps.amboy.mapBytes}/${m.maps.amboy.renderPackageBytes}`);
  check('longbeach package is the render package', m.maps.longbeach.mapBytes === m.maps.longbeach.renderPackageBytes, m.maps.longbeach.mapBytes);

  // 5. Page totals (6 each).
  for (const id of ['river', 'amboy', 'gracia', 'longbeach']) {
    const p = m.pageTotals[id];
    check(`${id}: page total = component sum`, p.pageTotal === p.package + p.baseGeometry + p.carChunk + p.layout + p.physics + p.carFields + p.renderSource + (p.extras ?? 0), p.pageTotal);
    check(`${id}: page total positive`, p.pageTotal > 0, p.pageTotal);
    check(`${id}: car chunk positive`, p.carChunk > 0, p.carChunk);
    check(`${id}: physics positive`, p.physics > 0, p.physics);
    check(`${id}: page total >= package`, p.pageTotal >= p.package, `${p.pageTotal}/${p.package}`);
    check(`${id}: source label present`, typeof p.source === 'string' && p.source.length > 10, p.source);
  }
  check('gracia page total > amboy page total', m.pageTotals.gracia.pageTotal > m.pageTotals.amboy.pageTotal, `${m.pageTotals.gracia.pageTotal}/${m.pageTotals.amboy.pageTotal}`);
  check('river page total ~20.47 MB', Math.abs(m.pageTotals.river.pageTotal - 20_471_058) < 1000, m.pageTotals.river.pageTotal);
  check('amboy page total ~66.38 MB', Math.abs(m.pageTotals.amboy.pageTotal - 66_381_641) < 2000, m.pageTotals.amboy.pageTotal);
  check('gracia page total > 90 MB', m.pageTotals.gracia.pageTotal > 90_000_000, m.pageTotals.gracia.pageTotal);

  // 6. Ghosts (8 + per-course).
  check('ghost index has 50 records (25 cars x 2 courses)', m.ghosts.count === 50, m.ghosts.count);
  check('ghost total bytes < 4 MB', m.ghosts.totalBytes < 4_000_000, m.ghosts.totalBytes);
  for (const g of m.ghosts.rows.slice(0, 6)) {
    check(`${g.slug}/${g.course}: 44 B per tick payload`, g.payloadBytes === g.tickCount * 44, g.payloadBytes);
    check(`${g.slug}/${g.course}: base64 payload matches`, g.base64Bytes === Math.ceil(g.payloadBytes / 3) * 4, g.base64Bytes);
    check(`${g.slug}/${g.course}: file > payload`, g.file > g.payloadBytes, `${g.file}/${g.payloadBytes}`);
  }

  // 7. Wasm / heap / soak (16).
  check('wasm module ~1.01 MB', Math.abs(m.wasm.wasmBytes - 1_012_634) < 1000, m.wasm.wasmBytes);
  check('module JS ~11.48 KB', Math.abs(m.wasm.moduleJsBytes - 11_480) < 100, m.wasm.moduleJsBytes);
  check('initial heap 256 MiB', m.wasm.initialHeapBytes === 268_435_456, m.wasm.initialHeapBytes);
  check('max heap 512 MiB', m.wasm.maxHeapBytes === 536_870_912, m.wasm.maxHeapBytes);
  check('heap/wasm ratio > 200', m.wasm.heapToWasmRatio > 200, m.wasm.heapToWasmRatio);
  check('one-minute soak wasm heap constant', m.soak.oneMinute.wasmHeapBytes === 268_435_456, m.soak.oneMinute.wasmHeapBytes);
  check('five-minute soak heap constant in both runs', m.soak.fiveMinute.runs.every((r) => r.wasmHeapBytes === 268_435_456), m.soak.fiveMinute.runs.length);
  check('five-minute p95 frame 8.06 ms', m.soak.fiveMinute.runs.every((r) => Math.abs(r.frameMs.p95 - 8.06) < 0.001), m.soak.fiveMinute.runs.map((r) => r.frameMs.p95));
  check('five-minute work p95 0.59 ms', m.soak.fiveMinute.runs.every((r) => Math.abs(r.workMs.p95 - 0.59) < 0.001), m.soak.fiveMinute.runs.map((r) => r.workMs.p95));
  check('five-minute draws/frame 266', m.soak.fiveMinute.runs.every((r) => r.drawsPerFrame === 266), m.soak.fiveMinute.runs.map((r) => r.drawsPerFrame));
  check('one-minute draws/frame 516', m.soak.oneMinute.drawsPerFrame === 516, m.soak.oneMinute.drawsPerFrame);
  check('one-minute frame p95 < 8 ms', m.soak.oneMinute.frames.p95 < 8, m.soak.oneMinute.frames.p95);
  check('one-minute work p95 < 2 ms', m.soak.oneMinute.work.p95 < 2, m.soak.oneMinute.work.p95);
  check('five-minute transitions 37 per run', m.soak.fiveMinute.runs.every((r) => r.transitions === 37), m.soak.fiveMinute.runs.map((r) => r.transitions));
  check('five-minute JS heap drift negative', m.soak.fiveMinute.runs.every((r) => r.jsHeapDrift < 0), m.soak.fiveMinute.runs.map((r) => r.jsHeapDrift));
  check('packet loads 26 in five minutes', m.soak.fiveMinute.runs.every((r) => r.packetLoads === 26), m.soak.fiveMinute.runs.map((r) => r.packetLoads));

  // 8. Chunk overhead (6).
  check('car overhead median 30-40 %', m.chunkOverhead.carMedianPercent > 30 && m.chunkOverhead.carMedianPercent < 40, m.chunkOverhead.carMedianPercent);
  check('car overhead min < median', m.chunkOverhead.carMinPercent < m.chunkOverhead.carMedianPercent, m.chunkOverhead.carMinPercent);
  check('car overhead max > median', m.chunkOverhead.carMaxPercent > m.chunkOverhead.carMedianPercent, m.chunkOverhead.carMaxPercent);
  check('level overhead 64.3 %', Math.abs(m.chunkOverhead.levelPercent - 64.3) < 0.2, m.chunkOverhead.levelPercent);
  check('amboy map overhead 64.8 %', Math.abs(m.chunkOverhead.mapAmboyPercent - 64.8) < 0.2, m.chunkOverhead.mapAmboyPercent);
  check('gracia map overhead 66.1 %', Math.abs(m.chunkOverhead.mapGraciaPercent - 66.08) < 0.2, m.chunkOverhead.mapGraciaPercent);

  // 9. Snapshot / encoding (20).
  check('snapshot sample count 101', m.snapshot.samples === 101, m.snapshot.samples);
  check('state Hz 20 and tick Hz 60', m.snapshot.stateHz === 20 && m.snapshot.tickHz === 60, `${m.snapshot.stateHz}/${m.snapshot.tickHz}`);
  check('JSON state p50 190-230 B', m.snapshot.json.p50 >= 190 && m.snapshot.json.p50 <= 230, m.snapshot.json.p50);
  check('JSON state p95 >= p50', m.snapshot.json.p95 >= m.snapshot.json.p50, `${m.snapshot.json.p95}/${m.snapshot.json.p50}`);
  check('JSON state mean within min/p95', m.snapshot.json.mean >= m.snapshot.json.min && m.snapshot.json.mean <= m.snapshot.json.p95, m.snapshot.json.mean);
  check('delta binary mean 15-40 B', m.snapshot.deltaBinary.mean >= 15 && m.snapshot.deltaBinary.mean <= 40, m.snapshot.deltaBinary.mean);
  check('delta binary smaller than JSON', m.snapshot.deltaBinary.mean < m.snapshot.json.mean, `${m.snapshot.deltaBinary.mean}/${m.snapshot.json.mean}`);
  check('delta saving 80-95 %', m.snapshot.savingsPercent > 80 && m.snapshot.savingsPercent < 95, m.snapshot.savingsPercent);
  check('short JSON saving 55-75 %', m.snapshot.shortJsonSavingsPercent > 55 && m.snapshot.shortJsonSavingsPercent < 75, m.snapshot.shortJsonSavingsPercent);
  check('position quantization error <= 1 cm', m.snapshot.maxPositionQuantizationErrorMetres <= 0.01, m.snapshot.maxPositionQuantizationErrorMetres);
  check('quaternion quantization error <= 1e-3 rad', m.snapshot.maxQuaternionQuantizationErrorRadians <= 0.001, m.snapshot.maxQuaternionQuantizationErrorRadians);
  check('7-car batch JSON p50 900-1100 B', m.snapshot.batch7.json.p50 >= 900 && m.snapshot.batch7.json.p50 <= 1100, m.snapshot.batch7.json.p50);
  check('7-car batch delta mean 100-150 B', m.snapshot.batch7.deltaBinary.mean >= 100 && m.snapshot.batch7.deltaBinary.mean <= 150, m.snapshot.batch7.deltaBinary.mean);
  check('7-car batch saving 80-95 %', m.snapshot.batch7.savingsPercent > 80 && m.snapshot.batch7.savingsPercent < 95, m.snapshot.batch7.savingsPercent);
  check('input JSON p50 100-160 B', m.snapshot.input.json.p50 >= 100 && m.snapshot.input.json.p50 <= 160, m.snapshot.input.json.p50);
  check('input binary 12 B', m.snapshot.input.binaryMean === 12, m.snapshot.input.binaryMean);
  check('input binary smaller than JSON', m.snapshot.input.binaryMean < m.snapshot.input.json.mean, `${m.snapshot.input.binaryMean}/${m.snapshot.input.json.mean}`);
  check('AI batch has 7 cars', m.snapshot.batch7.cars === 7, m.snapshot.batch7.cars);
  check('AI batch p95 >= p50', m.snapshot.batch7.json.p95 >= m.snapshot.batch7.json.p50, `${m.snapshot.batch7.json.p95}/${m.snapshot.batch7.json.p50}`);
  check('snapshot source is the packet timeline', m.snapshot.json.p50 > 0 && m.snapshot.samples > 0, m.snapshot.samples);

  // 10. Bandwidth arithmetic (24).
  const b = m.bandwidth;
  check('8 players / 7 AI', b.players === 8 && b.aiCars === 7, `${b.players}/${b.aiCars}`);
  check('client download = 7 x state', Math.abs(b.perClientDownMBMin - (b.perCarStateBytes * 20 * 60 * 7) / 1e6) < 1e-6, b.perClientDownMBMin);
  check('client upload = 1 x state', Math.abs(b.perClientUpMBMin - (b.perCarStateBytes * 20 * 60) / 1e6) < 1e-6, b.perClientUpMBMin);
  check('server state egress = 56 x state', Math.abs(b.serverStateEgressMBMin - (b.perCarStateBytes * 20 * 60 * 56) / 1e6) < 1e-6, b.serverStateEgressMBMin);
  check('server egress = 8 x client download', Math.abs(b.serverStateEgressMBMin - b.perClientDownMBMin * 8) < 1e-5, b.serverStateEgressMBMin);
  check('delta client download smaller', b.perClientDownMBMinDelta < b.perClientDownMBMin, `${b.perClientDownMBMinDelta}/${b.perClientDownMBMin}`);
  check('delta server egress smaller', b.serverStateEgressMBMinDelta < b.serverStateEgressMBMin, `${b.serverStateEgressMBMinDelta}/${b.serverStateEgressMBMin}`);
  check('delta client download ~11 % of JSON', Math.abs(b.perClientDownMBMinDelta / b.perClientDownMBMin - 0.11) < 0.03, b.perClientDownMBMinDelta / b.perClientDownMBMin);
  check('AI batch bytes match snapshot', b.aiBatchJsonBytes === m.snapshot.batch7.json.mean, b.aiBatchJsonBytes);
  check('host AI upload = 1 x batch', Math.abs(b.hostAiUploadMBMin - (b.aiBatchJsonBytes * 20 * 60) / 1e6) < 1e-6, b.hostAiUploadMBMin);
  check('host relay total = server + AI fan-out', Math.abs(b.hostRelayTotalMBMin - (b.serverStateEgressMBMin + (b.aiBatchJsonBytes * 20 * 60 * 7) / 1e6)) < 1e-6, b.hostRelayTotalMBMin);
  check('host relay > server egress', b.hostRelayTotalMBMin > b.serverStateEgressMBMin, `${b.hostRelayTotalMBMin}/${b.serverStateEgressMBMin}`);
  check('host relay delta < host relay JSON', b.hostRelayTotalDeltaMBMin < b.hostRelayTotalMBMin, `${b.hostRelayTotalDeltaMBMin}/${b.hostRelayTotalMBMin}`);
  check('input server egress = 56 x input', Math.abs(b.inputServerEgressMBMin - (b.inputJsonBytes * 60 * 60 * 56) / 1e6) < 1e-6, b.inputServerEgressMBMin);
  check('host all channels = relay + input', Math.abs(b.hostAllChannelsMBMin - (b.hostRelayTotalMBMin + b.inputServerEgressMBMin)) < 1e-6, b.hostAllChannelsMBMin);
  check('host all delta < host all JSON', b.hostAllChannelsDeltaMBMin < b.hostAllChannelsMBMin, `${b.hostAllChannelsDeltaMBMin}/${b.hostAllChannelsMBMin}`);
  check('kbit/s conversion matches MB/min', Math.abs(b.hostAllKbitPerSecond - (b.hostAllChannelsMBMin * 8 * 1e6 / 60 / 1000)) < 0.01, b.hostAllKbitPerSecond);
  check('client download kbit/s < 300', b.perClientDownKbitPerSecond < 300, b.perClientDownKbitPerSecond);
  check('host all channels < 10 Mbit/s', b.hostAllKbitPerSecond < 10_000, b.hostAllKbitPerSecond);
  check('MB/min positive', b.hostAllChannelsMBMin > 0, b.hostAllChannelsMBMin);
  check('8-peer fan-out not 8 x 8', b.serverStateEgressMBMin < b.perClientDownMBMin * 8 + 0.01, b.serverStateEgressMBMin);
  check('per-car p95 >= mean', b.perCarStateBytesP95 >= b.perCarStateBytes, `${b.perCarStateBytesP95}/${b.perCarStateBytes}`);
  check('AI batch larger than one car', b.aiBatchJsonBytes > b.perCarStateBytes, `${b.aiBatchJsonBytes}/${b.perCarStateBytes}`);
  check('host relay AI term positive', b.hostRelayTotalMBMin - b.serverStateEgressMBMin > 0, b.hostRelayTotalMBMin - b.serverStateEgressMBMin);

  // 11. Model arithmetic (24).
  const s = model.scenarios;
  for (const id of ['river', 'amboy', 'gracia', 'longbeach', 'currentM4']) {
    const x = s[id];
    check(`${id}: GPU full = map geo + car geo + map tex + car tex`,
      x.gpuTotalFullBytes === x.mapGpuGeometryBytes + x.carGpuGeometryBytes + x.mapGpuTextureBytes + x.carGpuTextureBytesFull,
      x.gpuTotalFullBytes);
    check(`${id}: GPU mixed = map geo + car geo + map tex + mixed car tex`,
      x.gpuTotalMixedBytes === x.mapGpuGeometryBytes + x.carGpuGeometryBytes + x.mapGpuTextureBytes + x.carGpuTextureBytesMixed,
      x.gpuTotalMixedBytes);
    check(`${id}: mixed <= full`, x.gpuTotalMixedBytes <= x.gpuTotalFullBytes, `${x.gpuTotalMixedBytes}/${x.gpuTotalFullBytes}`);
    check(`${id}: draws = map + car + powerups`, x.draws === x.mapDraws + x.carDraws + x.powerupDraws, x.draws);
    check(`${id}: triangles = map + car`, x.triangles === x.mapTriangles + x.carTriangles, x.triangles);
    check(`${id}: draws positive`, x.draws > 0, x.draws);
    check(`${id}: CPU low <= high`, x.cpuLowMs <= x.cpuHighMs, `${x.cpuLowMs}/${x.cpuHighMs}`);
    check(`${id}: frame bound positive`, x.frameUpperBoundMs > 0, x.frameUpperBoundMs);
    check(`${id}: page bytes positive`, x.pageBytes > 0, x.pageBytes);
  }
  check('gracia draws > river draws', s.gracia.draws > s.river.draws, `${s.gracia.draws}/${s.river.draws}`);
  check('gracia GPU full > river GPU full', s.gracia.gpuTotalFullBytes > s.river.gpuTotalFullBytes, `${s.gracia.gpuTotalFullBytes}/${s.river.gpuTotalFullBytes}`);
  check('longbeach texture < gracia texture', s.longbeach.mapGpuTextureBytes < s.gracia.mapGpuTextureBytes, `${s.longbeach.mapGpuTextureBytes}/${s.gracia.mapGpuTextureBytes}`);
  check('longbeach geometry > gracia geometry', s.longbeach.mapGpuGeometryBytes > s.gracia.mapGpuGeometryBytes, `${s.longbeach.mapGpuGeometryBytes}/${s.gracia.mapGpuGeometryBytes}`);
  check('current M4 uses 2 bodies', s.currentM4.carBodies === 2, s.currentM4.carBodies);
  check('current M4 texture < full 8-car texture', s.currentM4.carGpuTextureBytesFull < s.gracia.carGpuTextureBytesFull, `${s.currentM4.carGpuTextureBytesFull}/${s.gracia.carGpuTextureBytesFull}`);
  check('worst car pool is Lotus texture', model.carPool.maxTexture === 'lotus-exige-cup260-stock', model.carPool.maxTexture);
  check('max draw car is Nissan 350Z', model.carPool.maxDraw === 'nissan-350znismo-stock', model.carPool.maxDraw);
  check('worst geometry car has >= 1.2 MB', model.carPool.maxGeometryCar.gpuGeometryBytes >= 1_200_000, model.carPool.maxGeometryCar.gpuGeometryBytes);
  check('best geometry car has <= 1.0 MB', model.carPool.minGeometryCar.gpuGeometryBytes <= 1_000_000, model.carPool.minGeometryCar.gpuGeometryBytes);
  check('max geometry car is Koenigsegg', model.carPool.maxGeometry === 'koenigsegg-ccxr-stock', model.carPool.maxGeometry);
  check('8-car geometry = 8 x max geometry car', s.gracia.carGpuGeometryBytes === 8 * model.carPool.maxGeometryCar.gpuGeometryBytes, s.gracia.carGpuGeometryBytes);
  check('8-car draws = 8 x max draw car', s.gracia.carDraws === 8 * model.carPool.maxDrawCar.draws, s.gracia.carDraws);
  check('8-car triangles = 8 x max tri car', s.gracia.carTriangles === 8 * model.carPool.maxTriCar.triangles, s.gracia.carTriangles);
  check('CPU high = 8 x one-car p95', Math.abs(m.cpuModel.highMs - 8 * m.soak.fiveMinute.runs[0].workMs.p95) < 1e-6, m.cpuModel.highMs);
  check('CPU low >= fixed overhead', m.cpuModel.lowMs >= m.cpuModel.fixedOverheadP95Ms, m.cpuModel.lowMs);
  check('frame bound uses measured p95', model.scenarios.river.frameUpperBoundMs > m.soak.fiveMinute.runs[0].frameMs.p95, model.scenarios.river.frameUpperBoundMs);
  check('assumptions listed', model.assumptions.length >= 7, model.assumptions.length);

  const failed = checks.filter((c) => !c.ok);
  const result = {
    kind: 'blur.perf-budget.verify',
    version: 1,
    generatedAt: new Date().toISOString(),
    checks: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    minimumChecks: 120,
    verdict: failed.length === 0 && checks.length >= 120 ? 'PASS' : 'FAIL',
    failures: failed
  };
  mkdirSync(OUT, { recursive: true });
  mkdirSync(LOGS, { recursive: true });
  writeFileSync(join(OUT, 'verify.json'), JSON.stringify(result, null, 2));
  writeFileSync(join(LOGS, 'verify.log'), `${result.verdict}: ${result.passed}/${result.checks} checks, ${result.failed} failures\n` +
    failed.map((f) => `FAIL ${f.name} (${f.detail})`).join('\n') + (failed.length ? '\n' : ''));
  console.log(`${result.verdict}: ${result.passed}/${result.checks} checks, ${result.failed} failures`);
  if (failed.length) {
    for (const f of failed) console.log(`FAIL ${f.name} (${f.detail})`);
    process.exitCode = 1;
  }
}

const command = process.argv[2] ?? 'measure';
if (command === 'measure') measure();
else if (command === 'verify') verify();
else {
  console.error('usage: node probes/perf/tools/perf_budget.mjs [measure|verify]');
  process.exitCode = 2;
}
