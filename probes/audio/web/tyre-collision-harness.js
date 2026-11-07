// Harness for probes/audio/web/tyre-collision-audio.js.
//
// The page drives the module and exposes its state to the headless verifier
// (probes/audio/capture_tyre_collision.mjs). It adds no audio logic: every
// gain/rate shown comes from the module's diagnostics.
//
// The AudioContext is created only inside the click handler for "Start audio".

import {
  createTyreCollisionAudio,
  sampleCollision,
  sampleTyreCurves,
  COLLISION_SURFACES,
  COLLISION_VOLUME_DB,
  DRY_TYRE,
  EFFECT_MATERIALS,
  MATERIAL_TO_SURFACE,
  OFFROAD_TYRE,
  RETAIL_TYRE_COLLISION,
} from './tyre-collision-audio.js';

const BASE_URL = '/_work/audio/';

const els = {
  mode: document.getElementById('mode'),
  statusDetail: document.getElementById('statusDetail'),
  note: document.getElementById('note'),
  failureNote: document.getElementById('failureNote'),
  play: document.getElementById('play'),
  mute: document.getElementById('mute'),
  dispose: document.getElementById('dispose'),
  failure: document.getElementById('failure'),
  surface: document.getElementById('surface'),
  substrate: document.getElementById('substrate'),
  slip: document.getElementById('slip'),
  slipOut: document.getElementById('slipOut'),
  speed: document.getElementById('speed'),
  speedOut: document.getElementById('speedOut'),
  rows: document.getElementById('rows'),
  rmsOut: document.getElementById('rmsOut'),
  peakOut: document.getElementById('peakOut'),
  rmsBar: document.getElementById('rmsBar'),
  material: document.getElementById('material'),
  strength: document.getElementById('strength'),
  impact: document.getElementById('impact'),
  impactMaterial: document.getElementById('impactMaterial'),
  impactSurface: document.getElementById('impactSurface'),
  impactWave: document.getElementById('impactWave'),
  impactGain: document.getElementById('impactGain'),
  impactGate: document.getElementById('impactGate'),
  impactPlayed: document.getElementById('impactPlayed'),
  provenance: document.getElementById('provenance'),
  log: document.getElementById('log'),
};

const errors = [];
const logLines = [];
let audio = null;
let ready = false;
let frameHandle = 0;
let failureResult = null;
let lastDiagnostics = null;

window.addEventListener('error', (event) => {
  errors.push(String(event.message ?? event.error ?? 'error'));
});
window.addEventListener('unhandledrejection', (event) => {
  errors.push(String(event.reason?.message ?? event.reason ?? 'unhandledrejection'));
});

function log(message) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
  logLines.unshift(line);
  els.log.textContent = logLines.slice(0, 40).join('\n');
}

function setStatus(status) {
  els.mode.textContent = status.state;
  els.mode.className = `mode ${status.state}`;
  const parts = [];
  if (status.contextState) parts.push(`ctx ${status.contextState}`);
  if (status.reason) parts.push(status.reason);
  if (status.detail) parts.push(status.detail);
  els.statusDetail.textContent = parts.join(' · ');
  if (status.state === 'running') {
    els.note.className = 'note';
    els.note.textContent = 'Playing decoded retail tyre loops and collision tables. '
      + 'The context was created by the Start-audio gesture.';
  } else if (status.state === 'unavailable') {
    els.note.className = 'note warn';
    els.note.textContent = `Unavailable (${status.reason}). The module reports this; it never substitutes audio.`;
  }
}

function newAudio() {
  if (audio) audio.dispose();
  audio = createTyreCollisionAudio({ baseUrl: BASE_URL });
  audio.onStatusChange((status) => {
    setStatus(status);
    log(`status ${status.state}${status.reason ? ` (${status.reason})` : ''}`);
    syncButtons();
  });
  audio.onImpact((event) => {
    if (event.ended) {
      log(`impact ended ${event.wave}`);
    } else if (event.triggered) {
      log(`impact ${event.wave} ${event.gain.toFixed(3)} (${event.name})`);
    } else {
      log(`impact rejected ${event.reason} (${event.name})`);
    }
  });
  return audio;
}

function syncButtons() {
  const state = audio ? audio.state : 'none';
  const running = state === 'running';
  els.play.disabled = state === 'loading' || running;
  els.play.textContent = running ? 'Audio running'
    : (state === 'disposed' ? 'Start audio (new instance)' : 'Start audio');
  els.mute.disabled = !running;
  els.dispose.disabled = state === 'idle' || state === 'disposed';
  els.failure.disabled = state !== 'running';
  els.impact.disabled = !running;
  els.surface.disabled = !running;
  els.substrate.disabled = !running || els.surface.value !== 'offroad';
}

function buildRows() {
  els.rows.textContent = '';
  for (const layer of sampleTyreCurves({ surface: 'dry', slip: 0, speed: 0 }).layers) {
    const tr = document.createElement('tr');
    tr.id = `row-${layer.wave}`;
    tr.innerHTML =
      `<td>${layer.id} · ${layer.wave}</td>` +
      '<td class="num" data-gain>0.0000</td><td class="num" data-live-gain>—</td>' +
      '<td class="num" data-rate>0.0000</td><td class="num" data-live-rate>—</td>' +
      '<td><div class="bar"><i data-bar></i></div></td>';
    els.rows.appendChild(tr);
  }
  for (const substrate of ['gravel', 'grass', 'sand', 'foliage']) {
    for (const layer of sampleTyreCurves({ surface: 'offroad', substrate, slip: 0, speed: 0 }).layers) {
      if (document.getElementById(`row-${layer.wave}`)) continue;
      const tr = document.createElement('tr');
      tr.id = `row-${layer.wave}`;
      tr.innerHTML =
        `<td>${layer.id} · ${layer.wave}</td>` +
        '<td class="num" data-gain>0.0000</td><td class="num" data-live-gain>—</td>' +
        '<td class="num" data-rate>0.0000</td><td class="num" data-live-rate>—</td>' +
        '<td><div class="bar"><i data-bar></i></div></td>';
      els.rows.appendChild(tr);
    }
  }
}

function readState() {
  return {
    surface: els.surface.value,
    substrate: els.substrate.value,
    slip: Number(els.slip.value),
    speed: Number(els.speed.value),
  };
}

function applyState() {
  const state = readState();
  els.slipOut.textContent = state.slip.toFixed(2);
  els.speedOut.textContent = state.speed.toFixed(1);
  els.substrate.disabled = state.surface !== 'offroad';
  if (!audio) return null;
  audio.setSurface(state.surface, state.substrate);
  return audio.setSlip(state.slip, state.speed);
}

function updateReadout(diagnostics) {
  lastDiagnostics = diagnostics;
  const sample = diagnostics?.tyreTargets ?? sampleTyreCurves(readState()).layers;
  const targets = new Map(sample.map((layer) => [layer.wave, layer]));
  const live = new Map((diagnostics?.tyreLayers ?? []).map((layer) => [layer.wave, layer]));
  for (const tr of els.rows.querySelectorAll('tr')) {
    const wave = tr.id.replace(/^row-/, '');
    const target = targets.get(wave);
    const actual = live.get(wave);
    const gain = target ? target.gain : 0;
    const rate = target ? target.rate : 1;
    tr.querySelector('[data-gain]').textContent = gain.toFixed(4);
    tr.querySelector('[data-live-gain]').textContent = actual ? actual.gain.toFixed(4) : '—';
    tr.querySelector('[data-rate]').textContent = rate.toFixed(4);
    tr.querySelector('[data-live-rate]').textContent = actual ? actual.rate.toFixed(4) : '—';
    tr.querySelector('[data-bar]').style.width = `${Math.min(100, gain * 100)}%`;
    tr.classList.toggle('inactive', gain <= 0.0001);
    tr.classList.toggle('active', gain > 0.0001);
  }

  const levels = diagnostics?.levels;
  const rms = levels ? levels.rms : 0;
  const peak = levels ? levels.peak : 0;
  els.rmsOut.textContent = rms.toFixed(4);
  els.peakOut.textContent = peak.toFixed(4);
  els.rmsBar.style.width = `${Math.min(100, rms * 250)}%`;

  const collision = diagnostics?.collision;
  if (collision?.last) {
    const last = collision.last;
    els.impactMaterial.textContent = last.name ?? '—';
    els.impactSurface.textContent = last.surface ? `${last.surface} · ${last.bank ?? ''}` : 'unsupported';
    els.impactWave.textContent = last.wave ?? '—';
    els.impactGain.textContent = last.gain === null || last.gain === undefined
      ? '—' : `${last.gain.toFixed(4)} (${last.gainDb.toFixed(2)} dB)`;
    els.impactPlayed.textContent = String(collision.played);
  }
  els.impactGate.textContent = collision ? (collision.active ? `active · ${collision.activeWave}` : 'idle') : 'idle';
}

function frame() {
  const diagnostics = audio ? audio.getDiagnostics() : null;
  updateReadout(diagnostics);
  frameHandle = requestAnimationFrame(frame);
}

function setMuteButton() {
  const muted = audio ? audio.getDiagnostics().muted : false;
  els.mute.textContent = muted ? 'Unmute' : 'Mute';
  els.mute.classList.toggle('toggled', muted);
}

function failureTest() {
  failureResult = { pending: true, results: [] };
  const offline = createTyreCollisionAudio({
    baseUrl: '/web/',
    fetchImpl: async () => { throw new Error('simulated network failure'); },
  });
  const notAudio = createTyreCollisionAudio({
    baseUrl: '/web/',
    resolveUrl: () => '/web/tyre-collision.html', // HTTP 200, not decodable audio
  });
  return Promise.all([offline.ensureStarted(), notAudio.ensureStarted()]).then((statuses) => {
    const instances = [offline, notAudio];
    const results = statuses.map((status, index) => ({
      state: status.state,
      reason: status.reason,
      detail: status.detail,
      contextState: status.contextState,
      decoded: instances[index].getDiagnostics().decoded.length,
    }));
    failureResult = { pending: false, results };
    els.failureNote.hidden = false;
    els.failureNote.className = results.every((entry) => entry.state === 'unavailable')
      ? 'note warn' : 'note bad';
    els.failureNote.textContent = `Failure paths: ${results.map((entry) =>
      `${entry.state}/${entry.reason} decoded=${entry.decoded}`).join(' · ')}`;
    for (const instance of instances) instance.dispose();
    return failureResult;
  });
}

function resolveImpact(material) {
  const materialSelect = typeof material === 'string' && EFFECT_MATERIALS.includes(material);
  return materialSelect ? material : material;
}

window.tyreCollisionProbe = {
  get ready() { return ready; },
  get errors() { return errors.slice(); },
  get provenance() { return RETAIL_TYRE_COLLISION; },
  get diagnostics() { return audio ? audio.getDiagnostics() : null; },
  get state() { return audio ? audio.state : 'none'; },
  get failureResult() { return failureResult; },
  get surfaces() { return COLLISION_SURFACES; },
  get materials() { return EFFECT_MATERIALS; },
  get tables() {
    return {
      dry: DRY_TYRE,
      offroad: OFFROAD_TYRE,
      collisionVolumeDb: COLLISION_VOLUME_DB,
      surfaces: COLLISION_SURFACES,
      materialMap: MATERIAL_TO_SURFACE,
    };
  },
  sampleCollision(strength, material) { return sampleCollision(strength, material); },
  sampleTyre(state) { return sampleTyreCurves(state); },
  start() { return audio ? audio.ensureStarted() : Promise.resolve(null); },
  setSurface(surface, substrate) {
    els.surface.value = surface;
    if (substrate) els.substrate.value = substrate;
    return applyState();
  },
  setSlip(slip, speed) {
    els.slip.value = String(slip);
    els.speed.value = String(speed);
    return applyState();
  },
  setMuted(value) {
    if (audio) audio.setMuted(value);
    setMuteButton();
    return audio ? audio.getDiagnostics() : null;
  },
  triggerImpact(strength, material) {
    return audio ? audio.triggerImpact(strength, resolveImpact(material)) : null;
  },
  waitForImpactIdle(timeout = 4000) {
    const start = performance.now();
    return new Promise((resolve) => {
      const tick = () => {
        const active = audio ? audio.getDiagnostics().collision.active : false;
        if (!active) { resolve(true); return; }
        if (performance.now() - start > timeout) { resolve(false); return; }
        setTimeout(tick, 20);
      };
      tick();
    });
  },
  testUnavailable() { return failureTest(); },
  dispose() {
    cancelAnimationFrame(frameHandle);
    if (audio) audio.dispose();
    syncButtons();
    setMuteButton();
    return audio ? audio.getDiagnostics() : null;
  },
  reset() {
    newAudio();
    applyState();
    syncButtons();
    setMuteButton();
    return audio.getDiagnostics();
  },
  log() { return logLines.slice(); },
};

els.surface.addEventListener('change', () => {
  applyState();
  syncButtons();
  log(`surface ${els.surface.value}`);
});
els.substrate.addEventListener('change', () => {
  applyState();
  log(`substrate ${els.substrate.value}`);
});
els.slip.addEventListener('input', () => applyState());
els.speed.addEventListener('input', () => applyState());

els.play.addEventListener('click', () => {
  if (!audio || audio.state === 'disposed') newAudio();
  syncButtons();
  audio.ensureStarted().then(() => {
    if (audio.state === 'running') applyState();
    syncButtons();
    setMuteButton();
    ready = true;
  });
});

els.mute.addEventListener('click', () => {
  if (!audio) return;
  audio.setMuted(!audio.getDiagnostics().muted);
  setMuteButton();
});

els.dispose.addEventListener('click', () => {
  if (audio) audio.dispose();
  syncButtons();
  setMuteButton();
});

els.failure.addEventListener('click', () => failureTest());

els.impact.addEventListener('click', () => {
  if (!audio) return;
  const strength = Number(els.strength.value);
  const material = els.material.value;
  audio.triggerImpact(strength, material);
});

buildRows();
newAudio();
applyState();
syncButtons();
setMuteButton();
els.provenance.textContent =
  `Wheel_Dry ${RETAIL_TYRE_COLLISION.wheelDry.sha256.slice(0, 16)}… · `
  + `Wheel_OffRoad ${RETAIL_TYRE_COLLISION.wheelOffroad.sha256.slice(0, 16)}… · `
  + `CollisionWorld ${RETAIL_TYRE_COLLISION.collisionWorld.sha256.slice(0, 16)}… · `
  + `${Object.keys(COLLISION_SURFACES).length} surface tables · reference `
  + RETAIL_TYRE_COLLISION.modelReference;
frame();
ready = true;
log('harness ready; no AudioContext created yet');
