// Harness for probes/audio/web/engine-audio.js.
//
// The page exists to drive the module and expose its state to the headless
// verifier (probes/audio/capture_module.mjs). It adds no audio logic of its
// own: every gain/rate shown here comes from the module's diagnostics.
//
// The AudioContext is created only inside the click handler for "Start audio".

import {
  createEngineAudio,
  RETAIL_RACE_V8_ENGINE,
  RETAIL_RACE_V8_ENGINE_CURVES,
} from './engine-audio.js';

const BASE_URL = '/_work/audio/';
const MODEL_URL = '/_work/audio/engine-model.json';

const els = {
  mode: document.getElementById('mode'),
  statusDetail: document.getElementById('statusDetail'),
  rpm: document.getElementById('rpm'),
  rpmNum: document.getElementById('rpmNum'),
  rpmOut: document.getElementById('rpmOut'),
  xOut: document.getElementById('xOut'),
  setRpm: document.getElementById('setRpm'),
  play: document.getElementById('play'),
  mute: document.getElementById('mute'),
  dispose: document.getElementById('dispose'),
  sweep: document.getElementById('sweep'),
  failure: document.getElementById('failure'),
  failureNote: document.getElementById('failureNote'),
  note: document.getElementById('note'),
  rmsBar: document.getElementById('rmsBar'),
  rmsOut: document.getElementById('rmsOut'),
  peakOut: document.getElementById('peakOut'),
  rows: document.getElementById('rows'),
  provenance: document.getElementById('provenance'),
  log: document.getElementById('log'),
};

const errors = [];
const logLines = [];
let engine = null;
let model = null;
let curveCheck = null;
let ready = false;
let sweepHandle = 0;
let frameHandle = 0;
let lastRpm = null;
let failureResult = null;

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
    els.note.textContent = 'Playing six decoded retail loops. No autoplay: the context was '
      + 'created by the Start-audio gesture.';
  } else if (status.state === 'unavailable') {
    els.note.className = 'note warn';
    els.note.textContent = `Unavailable (${status.reason}). The module reports this explicitly; `
      + 'it never substitutes different audio.';
  }
}

function newEngine() {
  if (engine) engine.dispose();
  engine = createEngineAudio({ baseUrl: BASE_URL, initialRpm: 0 });
  engine.onStatusChange((status) => {
    setStatus(status);
    log(`status ${status.state}${status.reason ? ` (${status.reason})` : ''}`);
    syncButtons();
  });
  return engine;
}

function syncButtons() {
  const state = engine ? engine.state : 'none';
  els.play.disabled = state === 'loading' || state === 'running';
  els.play.textContent = state === 'running'
    ? 'Audio running'
    : (state === 'disposed' ? 'Start audio (new instance)' : 'Start audio');
  els.mute.disabled = state !== 'running';
  els.dispose.disabled = state === 'idle' || state === 'disposed';
  els.sweep.disabled = state !== 'running';
}

function buildRows() {
  els.rows.textContent = '';
  for (const layer of RETAIL_RACE_V8_ENGINE_CURVES) {
    const tr = document.createElement('tr');
    tr.id = `row-${layer.slot}`;
    tr.innerHTML =
      `<td>${layer.wave}</td><td class="num">${layer.rpmLabel}</td>` +
      '<td class="num" data-gain>0.0000</td><td class="num" data-live-gain>0.0000</td>' +
      '<td class="num" data-rate>0.0000</td><td class="num" data-live-rate>0.0000</td>' +
      '<td><div class="bar"><i data-bar></i></div></td>';
    els.rows.appendChild(tr);
  }
}

function readRpm() {
  const value = Number(els.rpmNum.value);
  return Number.isFinite(value) ? Math.min(8000, Math.max(0, value)) : 0;
}

function applyRpm(value) {
  const rpm = Math.min(8000, Math.max(0, Math.round(Number(value) || 0)));
  els.rpm.value = String(rpm);
  els.rpmNum.value = String(rpm);
  lastRpm = rpm;
  if (engine) engine.setRpm(rpm);
}

function updateReadout(diagnostics) {
  const rpm = diagnostics ? diagnostics.rpm : readRpm();
  els.rpmOut.textContent = String(rpm);
  els.xOut.textContent = (rpm * 0.0001).toFixed(6);

  const live = new Map((diagnostics?.layers ?? []).map((layer) => [layer.slot, layer]));
  const targets = new Map((diagnostics?.targets ?? engine.sampleAt(rpm).layers)
    .map((layer) => [layer.slot, layer]));
  for (const layer of RETAIL_RACE_V8_ENGINE_CURVES) {
    const tr = document.getElementById(`row-${layer.slot}`);
    if (!tr) continue;
    const target = targets.get(layer.slot);
    const actual = live.get(layer.slot);
    const gain = target ? target.gain : 0;
    const rate = target ? target.rate : 0;
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
}

function frame() {
  const diagnostics = engine ? engine.getDiagnostics() : null;
  updateReadout(diagnostics);
  frameHandle = requestAnimationFrame(frame);
}

function setMuteButton() {
  const muted = engine ? engine.getDiagnostics().muted : false;
  els.mute.textContent = muted ? 'Unmute' : 'Mute';
  els.mute.classList.toggle('toggled', muted);
}

async function fetchModel() {
  try {
    const response = await fetch(MODEL_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${MODEL_URL}: HTTP ${response.status}`);
    model = await response.json();
    curveCheck = compareCurves(model.loops, RETAIL_RACE_V8_ENGINE_CURVES);
    log(`model ${model.object}: ${curveCheck.layersCompared} layers compared`);
    if (!curveCheck.ok) {
      errors.push(`module curves differ from ${MODEL_URL}: ${JSON.stringify(curveCheck.mismatches)}`);
      els.provenance.className = 'note bad';
      els.provenance.textContent = `Curve mismatch against ${MODEL_URL}: `
        + JSON.stringify(curveCheck.mismatches);
    } else {
      els.provenance.textContent = `Curves identical to ${MODEL_URL} (dat SHA-256 `
        + `${String(model.datSha256).slice(0, 16)}…) within 1e-12; six layers, slot 7 `
        + '(decel) excluded by design.';
    }
  } catch (error) {
    errors.push(error.message);
    els.provenance.className = 'note warn';
    els.provenance.textContent = `Reference model unavailable (${error.message}). The module still `
      + 'has its own frozen curve table; the verifier compares against the file independently.';
  }
}

function compareCurves(modelLoops, moduleCurves) {
  const mismatches = [];
  const active = modelLoops.filter((loop) => loop.rpmLabel !== null);
  for (const loop of active) {
    const layer = moduleCurves.find((candidate) => candidate.slot === loop.slot);
    if (!layer) {
      mismatches.push({ slot: loop.slot, field: 'missing-in-module' });
      continue;
    }
    for (const field of ['volume', 'pitch']) {
      if (loop[field].length !== layer[field].length) {
        mismatches.push({ slot: loop.slot, field, reason: 'length' });
        continue;
      }
      loop[field].forEach(([x, y], index) => {
        const [mx, my] = layer[field][index];
        if (Math.abs(x - mx) > 1e-12 || Math.abs(y - my) > 1e-12) {
          mismatches.push({ slot: loop.slot, field, index, model: [x, y], module: [mx, my] });
        }
      });
    }
    if (loop.rpmLabel !== layer.rpmLabel) {
      mismatches.push({ slot: loop.slot, field: 'rpmLabel', model: loop.rpmLabel, module: layer.rpmLabel });
    }
  }
  return { ok: mismatches.length === 0, layersCompared: active.length, mismatches };
}

window.engineAudioProbe = {
  get ready() { return ready; },
  get errors() { return errors.slice(); },
  get model() { return model; },
  get curveCheck() { return curveCheck; },
  get provenance() { return RETAIL_RACE_V8_ENGINE; },
  get diagnostics() { return engine ? engine.getDiagnostics() : null; },
  get state() { return engine ? engine.state : 'none'; },
  get failureResult() { return failureResult; },
  sampleAt(rpm) {
    return engine ? engine.sampleAt(rpm) : null;
  },
  start() {
    return engine ? engine.ensureStarted() : Promise.resolve(null);
  },
  testUnavailable() {
    return runUnavailableTest();
  },
  setRpm(value) {
    applyRpm(value);
    return engine ? engine.getDiagnostics() : null;
  },
  setMuted(value) {
    if (engine) engine.setMuted(value);
    setMuteButton();
    return engine ? engine.getDiagnostics() : null;
  },
  dispose() {
    if (engine) engine.dispose();
    syncButtons();
    setMuteButton();
    return engine ? engine.getDiagnostics() : null;
  },
  reset() {
    newEngine();
    applyRpm(0);
    syncButtons();
    setMuteButton();
    return engine.getDiagnostics();
  },
  log() { return logLines.slice(); },
};

function runUnavailableTest() {
  failureResult = { pending: true, results: [] };

  // Two explicit failure modes, both started inside the click so the gesture is
  // valid. Neither may produce a substituted sound or a silent "success".
  const offline = createEngineAudio({
    baseUrl: '/web/',
    initialRpm: 1500,
    fetchImpl: async () => { throw new Error('simulated network failure'); },
  });
  const notAudio = createEngineAudio({
    baseUrl: '/web/',
    initialRpm: 1500,
    resolveUrl: () => '/web/index.html', // HTTP 200, not decodable audio
  });

  return Promise.all([offline.ensureStarted(), notAudio.ensureStarted()]).then((statuses) => {
    const engines = [offline, notAudio];
    const results = statuses.map((status, index) => ({
      state: status.state,
      reason: status.reason,
      detail: status.detail,
      contextState: status.contextState,
      decoded: engines[index].getDiagnostics().decoded.length,
    }));
    failureResult = { pending: false, results };
    els.failureNote.hidden = false;
    els.failureNote.className = failureResult.results.every((entry) => entry.state === 'unavailable')
      ? 'note warn'
      : 'note bad';
    els.failureNote.textContent = `Failure paths: ${results.map((entry) =>
      `${entry.state}/${entry.reason} decoded=${entry.decoded}`).join(' · ')}`;
    for (const engineInstance of engines) engineInstance.dispose();
    return failureResult;
  });
}

els.rpm.addEventListener('input', () => applyRpm(els.rpm.value));
els.rpmNum.addEventListener('change', () => applyRpm(els.rpmNum.value));
els.setRpm.addEventListener('click', () => applyRpm(els.rpmNum.value));

// The gesture. AudioContext creation happens synchronously inside this handler.
els.play.addEventListener('click', () => {
  if (!engine || engine.state === 'disposed') newEngine();
  syncButtons();
  engine.ensureStarted().then(() => {
    if (engine.state === 'running') applyRpm(lastRpm ?? 0);
    syncButtons();
    setMuteButton();
  });
});

els.mute.addEventListener('click', () => {
  if (!engine) return;
  engine.setMuted(!engine.getDiagnostics().muted);
  setMuteButton();
});

els.dispose.addEventListener('click', () => {
  cancelAnimationFrame(sweepHandle);
  if (engine) engine.dispose();
  syncButtons();
  setMuteButton();
});

els.failure.addEventListener('click', () => {
  runUnavailableTest();
});

els.sweep.addEventListener('click', () => {
  cancelAnimationFrame(sweepHandle);
  const start = performance.now();
  const duration = 5000;
  const from = 800;
  const to = 7600;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    applyRpm(from + (to - from) * t);
    if (t < 1) sweepHandle = requestAnimationFrame(tick);
  };
  sweepHandle = requestAnimationFrame(tick);
});

buildRows();
newEngine();
applyRpm(0);
syncButtons();
frame();

// The page is "ready" when the module exists and the reference model either
// loaded or definitively failed; the verifier waits on this.
fetchModel().finally(() => {
  ready = true;
  log('harness ready; no AudioContext created yet');
  if (!model) els.provenance.textContent += ' Press Start audio to load the six WAVs.';
});
