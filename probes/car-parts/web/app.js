// Car-part manifest preview: load the deterministic manifest + mesh, render
// every part in a diagnostic colour, and spin the four wheel groups around the
// documented local X axis.
//
// No engine, no game data and no committed probe is modified. The only inputs
// are `_work/car-parts/manifest.json` and `_work/car-parts/mesh.json` produced
// by `probes/car-parts/tools/build_manifest.py`.

import { CarPartRenderer } from './renderer.js';

const params = new URLSearchParams(location.search);
const numberParam = (name, fallback) => {
  const value = Number(params.get(name));
  return Number.isFinite(value) ? value : fallback;
};

const probe = {
  state: 'loading',
  error: null,
  frame: 0,
  angle: 0,
  spin: params.get('spin') !== '0',
  manifest: null,
  mesh: null,
  diagnostics: null,
  parts: null,
  draws: null,
  wheelGroups: [],
  adapter: null,
  geometryUploads: 0,
  geometryUploadBytes: 0,
  drawsIssued: 0,
  uniformWrites: 0
};
window.carPartsProbe = probe;

const statusElement = document.getElementById('status');
const legendElement = document.getElementById('legend');
const wheelElement = document.getElementById('wheel-groups');
const countElement = document.getElementById('counts');

function fail(error) {
  probe.state = 'error';
  probe.error = error instanceof Error ? error.message : String(error);
  statusElement.textContent = 'Hata: ' + probe.error;
  statusElement.classList.add('error');
}

async function loadJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

function addLegendRow(part, color) {
  const row = document.createElement('div');
  row.className = 'legend-row';
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = `rgb(${color.map((value) => Math.round(value * 255)).join(' ')})`;
  const label = document.createElement('span');
  label.className = 'legend-label';
  label.textContent = part.name ?? part.id;
  const meta = document.createElement('span');
  meta.className = 'legend-meta';
  meta.textContent = `${part.partKind} · ${part.draws.length} draw · ${part.triangleCount.toLocaleString('tr-TR')} üçgen`;
  row.append(swatch, label, meta);
  legendElement.append(row);
}

function addWheelRow(group) {
  const row = document.createElement('div');
  row.className = 'wheel-row';
  const title = document.createElement('strong');
  title.textContent = group.name;
  const detail = document.createElement('span');
  const t = group.worldTransform.translation;
  detail.textContent =
    `T=(${t.map((value) => value.toFixed(3)).join(', ')}) · eksen +X · ` +
    `${group.provenDraws.length} kanıtlı / ${group.ambiguousDraws.length} sunum draw`;
  row.append(title, detail);
  wheelElement.append(row);
}

async function main() {
  const manifest = await loadJson('/_work/car-parts/manifest.json');
  const mesh = await loadJson('/_work/car-parts/mesh.json');
  if (manifest.kind !== 'blur.car-part-manifest' || manifest.version !== 1) {
    throw new Error('manifest is not blur.car-part-manifest v1');
  }
  if (mesh.kind !== 'blur.car-part-mesh' || mesh.version !== 1) {
    throw new Error('mesh is not blur.car-part-mesh v1');
  }

  probe.manifest = {
    kind: manifest.kind,
    version: manifest.version,
    modelSha256: manifest.source.modelSha256,
    sceneReaderOutputSha256: manifest.source.sceneReaderOutputSha256,
    mesh: manifest.mesh
  };
  probe.mesh = {
    vertexCount: mesh.vertexCount,
    indexCount: mesh.indexCount,
    positionsFloat32LESha256: mesh.positionsFloat32LESha256,
    indicesUint32LESha256: mesh.indicesUint32LESha256
  };
  probe.diagnostics = manifest.diagnostics;
  probe.parts = manifest.parts.length;
  probe.draws = manifest.draws.length;
  probe.wheelGroups = manifest.wheelGroups.map((group) => group.id);

  const renderer = new CarPartRenderer(document.getElementById('canvas'), (state) => {
    if (state.state === 'error') { fail(new Error(state.message)); return; }
    probe.state = 'running';
    probe.frame = state.frame;
    probe.angle = state.angle;
    probe.adapter = renderer.adapterInfo ?? null;
    probe.geometryUploads = renderer.stats.geometryUploads;
    probe.geometryUploadBytes = renderer.stats.geometryUploadBytes;
    probe.drawsIssued = renderer.stats.drawsIssued;
    probe.uniformWrites = renderer.stats.uniformWrites;
  });

  await renderer.load(manifest, mesh);

  renderer.angle = numberParam('angle', 0);
  renderer.spin = params.get('spin') !== '0';
  renderer.spinRate = numberParam('rate', 1.8);
  renderer.orbit.yaw = numberParam('yaw', renderer.orbit.yaw);
  renderer.orbit.pitch = numberParam('pitch', renderer.orbit.pitch);
  renderer.orbit.distance = numberParam('dist', renderer.orbit.distance);
  probe.spin = renderer.spin;

  const sortedParts = [...renderer.parts].sort((a, b) => a.id.localeCompare(b.id));
  for (const part of sortedParts) addLegendRow(part, part.color);

  for (const group of manifest.wheelGroups) addWheelRow(group);

  const diagnostics = manifest.diagnostics;
  countElement.textContent =
    `${diagnostics.partCount} parça · ${diagnostics.drawCount} draw · ` +
    `${diagnostics.provenDrawCount} kanıtlı · ${diagnostics.unclassifiedDrawCount} sınıflandırılmamış · ` +
    `${diagnostics.wheelDrawCount} teker draw`;
  statusElement.textContent =
    `${mesh.vertexCount.toLocaleString('tr-TR')} vertex / ${mesh.indexCount.toLocaleString('tr-TR')} index · ` +
    `WebGPU · teker ekseni +X`;

  const spinToggle = document.getElementById('spin');
  spinToggle.checked = renderer.spin;
  spinToggle.addEventListener('change', () => {
    renderer.spin = spinToggle.checked;
    probe.spin = renderer.spin;
  });

  const rateInput = document.getElementById('rate');
  rateInput.value = String(renderer.spinRate);
  rateInput.addEventListener('input', () => {
    renderer.spinRate = Number(rateInput.value);
  });

  const angleInput = document.getElementById('angle');
  const syncAngle = () => {
    let degrees = ((renderer.angle * 180 / Math.PI + 180) % 360 + 360) % 360 - 180;
    degrees = Math.round(degrees);
    angleInput.value = String(degrees);
    document.getElementById('angle-value').textContent = `${degrees}°`;
  };
  angleInput.addEventListener('input', () => {
    renderer.angle = Number(angleInput.value) * Math.PI / 180;
    renderer.spin = false;
    spinToggle.checked = false;
    probe.spin = false;
    syncAngle();
    renderer.renderFrame();
  });

  document.getElementById('reset-camera').addEventListener('click', () => {
    renderer.orbit = { target: [0, 0.18, 0], distance: 8.2, yaw: 0.86, pitch: 0.30 };
  });

  document.getElementById('spin-90').addEventListener('click', () => {
    renderer.spin = false;
    spinToggle.checked = false;
    probe.spin = false;
    renderer.angle += Math.PI / 2;
    syncAngle();
    renderer.renderFrame();
  });

  setInterval(syncAngle, 250);
  syncAngle();
  renderer.start();
}

main().catch(fail);
