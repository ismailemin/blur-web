// Browser-audio feasibility harness for the retail Blur engine loops.
//
// Data path:
//   _work/audio/engine-model.json  (probes/audio/dump_engine_curves.py)
//   _work/audio/<wave>.wav         (probes/audio/extract_baf.py)
//
// The model is not hard-coded here. If the files cannot be fetched the page
// reports MOCK mode and only demonstrates the scheduling/curve evaluation.

const MODEL_URL = '/_work/audio/engine-model.json';
const WAV_BASE = '/_work/audio/';

const els = {
  mode: document.getElementById('mode'),
  rpm: document.getElementById('rpm'),
  rpmOut: document.getElementById('rpmOut'),
  xOut: document.getElementById('xOut'),
  play: document.getElementById('play'),
  stop: document.getElementById('stop'),
  sweep: document.getElementById('sweep'),
  pick: document.getElementById('pick'),
  files: document.getElementById('files'),
  note: document.getElementById('note'),
  mockNote: document.getElementById('mockNote'),
  rows: document.getElementById('rows'),
  plot: document.getElementById('plot'),
  log: document.getElementById('log'),
};

let model = null;
let loops = [];
let ctx = null;
let master = null;
let limiter = null;
let analyser = null;
let sources = [];
let buffers = new Map();
let playing = false;
let sweepHandle = 0;
let rafHandle = 0;
let mode = 'loading';

// Automation/debug surface. Read-only except for the explicit controls.
window.audioHarnessProbe = {
  get mode() { return mode; },
  get playing() { return playing; },
  get contextState() { return ctx ? ctx.state : 'none'; },
  get sampleRate() { return ctx ? ctx.sampleRate : null; },
  get model() { return model; },
  get loops() { return loops; },
  get decoded() {
    return [...buffers.entries()].map(([slot, buffer]) => {
      const data = buffer.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < data.length; i += 97) peak = Math.max(peak, Math.abs(data[i]));
      return {
        slot, duration: buffer.duration, sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels, samplePeak: peak,
      };
    });
  },
  get sources() {
    return sources.map((entry) => ({
      slot: entry.slot, gain: entry.gain.gain.value,
      rate: entry.source.playbackRate.value,
    }));
  },
  get levels() {
    if (!analyser) return null;
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    let peak = 0;
    for (const value of data) { sum += value * value; peak = Math.max(peak, Math.abs(value)); }
    return { rms: Math.sqrt(sum / data.length), peak };
  },
  setRpm(value) { els.rpm.value = String(value); els.rpm.dispatchEvent(new Event('input')); },
  async resume() { if (ctx) await ctx.resume(); },
  async testOscillator() {
    const c = getContext();
    await c.resume();
    const osc = c.createOscillator();
    const gain = c.createGain();
    const tap = c.createAnalyser();
    tap.fftSize = 2048;
    gain.gain.value = 0.2;
    osc.connect(gain).connect(tap).connect(c.destination);
    osc.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const data = new Float32Array(tap.fftSize);
    tap.getFloatTimeDomainData(data);
    let sum = 0;
    for (const value of data) sum += value * value;
    const rms = Math.sqrt(sum / data.length);
    osc.stop();
    osc.disconnect();
    gain.disconnect();
    tap.disconnect();
    return { rms, state: c.state, time: c.currentTime };
  },
  async testBuffer(slot = 1) {
    const c = getContext();
    await c.resume();
    const buffer = buffers.get(slot);
    if (!buffer) return { error: `no buffer for slot ${slot}` };
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = c.createGain();
    gain.gain.value = 1;
    const tap = c.createAnalyser();
    tap.fftSize = 2048;
    source.connect(gain).connect(tap).connect(c.destination);
    source.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const data = new Float32Array(tap.fftSize);
    tap.getFloatTimeDomainData(data);
    let sum = 0;
    let peak = 0;
    for (const value of data) { sum += value * value; peak = Math.max(peak, Math.abs(value)); }
    const result = {
      rms: Math.sqrt(sum / data.length), peak, state: c.state,
      duration: buffer.duration, sampleRate: buffer.sampleRate,
      time: c.currentTime,
    };
    source.stop();
    source.disconnect();
    gain.disconnect();
    tap.disconnect();
    return result;
  },
  async testMaster() {
    const c = getContext();
    await c.resume();
    const osc = c.createOscillator();
    osc.frequency.value = 330;
    osc.connect(master);
    osc.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const value of data) sum += value * value;
    const result = {
      rms: Math.sqrt(sum / data.length), state: c.state,
      masterGain: master.gain.value, reduction: limiter.reduction,
      time: c.currentTime,
    };
    osc.stop();
    osc.disconnect();
    return result;
  },
  start() { return startDecoded(); },
  stop() { stopDecoded(); },
};

function log(message) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
  els.log.textContent = `${line}\n${els.log.textContent}`.slice(0, 4000);
}

function setMode(value, text) {
  mode = value;
  els.mode.textContent = text;
  els.mode.className = `mode ${value}`;
}

// Piecewise-linear evaluation with endpoint clamping (the retail PLF holds
// the first/last value outside its stored points).
function evalPlf(points, x) {
  if (!points || points.length === 0) return 0;
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) {
      if (x1 === x0) return y1;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

function rpmToX(rpm) {
  return rpm * 0.0001; // BaseMessageHandler.cpp: DynamicsRPM = RPM * .0001
}

function activeLoops() {
  return loops.filter((loop) => loop.rpmLabel !== null);
}

function updateReadout() {
  const rpm = Number(els.rpm.value);
  const x = rpmToX(rpm);
  els.rpmOut.textContent = String(rpm);
  els.xOut.textContent = x.toFixed(6);
  return { rpm, x };
}

function updateRows(x) {
  const rpm = Number(els.rpm.value);
  for (const loop of activeLoops()) {
    const gain = evalPlf(loop.volume, x);
    const rate = Math.max(0.00390625, evalPlf(loop.pitch, x));
    const row = document.getElementById(`row-${loop.slot}`);
    if (!row) continue;
    row.classList.toggle('inactive', gain <= 0.0001);
    row.querySelector('[data-gain]').textContent = gain.toFixed(4);
    row.querySelector('[data-rate]').textContent = rate.toFixed(4);
    row.querySelector('[data-bar]').style.width = `${Math.min(100, gain * 100)}%`;
  }
  els.note.textContent =
    `x=${x.toFixed(6)} · ${rpm} RPM · ` +
    activeLoops().map((l) => `${l.wave}:${evalPlf(l.volume, x).toFixed(2)}`).join('  ');
}

function applyAudio() {
  if (!playing || !ctx) return;
  const { x } = updateReadout();
  const now = ctx.currentTime;
  for (const loop of activeLoops()) {
    const entry = sources.find((s) => s.slot === loop.slot);
    if (!entry) continue;
    const gain = evalPlf(loop.volume, x);
    const rate = Math.max(0.00390625, evalPlf(loop.pitch, x));
    entry.gain.gain.setTargetAtTime(gain, now, 0.02);
    entry.source.playbackRate.setTargetAtTime(rate, now, 0.02);
  }
  updateRows(x);
}

function frame() {
  applyAudio();
  rafHandle = requestAnimationFrame(frame);
}

function buildRows() {
  els.rows.textContent = '';
  for (const loop of activeLoops()) {
    const tr = document.createElement('tr');
    tr.id = `row-${loop.slot}`;
    tr.innerHTML =
      `<td>${loop.wave}</td><td class="num">${loop.rpmLabel}</td>` +
      `<td class="num" data-gain>0.0000</td>` +
      `<td class="num" data-rate>0.0000</td>` +
      `<td><div class="bar"><i data-bar></i></div></td>`;
    els.rows.appendChild(tr);
  }
  log(`model ${model.object}: ${activeLoops().length} RPM loops, declared ` +
      `${model.header.declaredComponents} components / parsed ${model.header.parsedComponents}`);
}

async function loadModel() {
  const response = await fetch(MODEL_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${MODEL_URL}: HTTP ${response.status}`);
  model = await response.json();
  loops = model.loops;
  buildRows();
  drawPlot();
  updateReadout();
  updateRows(rpmToX(Number(els.rpm.value)));
}

async function loadBuffers() {
  const audioCtx = getContext();
  for (const loop of activeLoops()) {
    const url = `${WAV_BASE}${encodeURIComponent(loop.wave)}.wav`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const buffer = await audioCtx.decodeAudioData(bytes);
    buffers.set(loop.slot, buffer);
    log(`decoded ${loop.wave}.wav: ${buffer.numberOfChannels}ch ` +
        `${buffer.sampleRate}Hz ${buffer.duration.toFixed(3)}s`);
  }
}

function getContext() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = 0.5;
    // Safety only: the retail graph has its own bus/limiter. This is not a
    // claim of original mix behaviour.
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    // Keep the analyser in the signal path: a branch with no output is not
    // guaranteed to be pulled in every implementation.
    master.connect(analyser).connect(limiter).connect(ctx.destination);
  }
  return ctx;
}

async function startDecoded() {
  const audioCtx = getContext();
  await audioCtx.resume();
  if (buffers.size === 0) await loadBuffers();
  if (sources.length) stopDecoded();

  const now = audioCtx.currentTime + 0.06;
  sources = activeLoops().map((loop) => {
    const source = audioCtx.createBufferSource();
    source.buffer = buffers.get(loop.slot);
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = source.buffer.duration;
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(master);
    const x = rpmToX(Number(els.rpm.value));
    source.playbackRate.value = Math.max(0.00390625, evalPlf(loop.pitch, x));
    gain.gain.setTargetAtTime(evalPlf(loop.volume, x), now, 0.02);
    source.start(now);
    return { slot: loop.slot, source, gain };
  });
  playing = true;
  els.play.disabled = true;
  els.stop.disabled = false;
  els.sweep.disabled = false;
  els.pick.disabled = false;
  setMode('live', 'DECODED · Web Audio');
  els.mockNote.hidden = true;
  log(`playing ${sources.length} loops at ${audioCtx.sampleRate} Hz output`);
  cancelAnimationFrame(rafHandle);
  frame();
}

function stopDecoded() {
  for (const entry of sources) {
    try { entry.source.stop(); } catch { /* already stopped */ }
    entry.source.disconnect();
    entry.gain.disconnect();
  }
  sources = [];
  playing = false;
  cancelAnimationFrame(rafHandle);
  rafHandle = 0;
  els.play.disabled = false;
  els.stop.disabled = true;
  els.sweep.disabled = true;
  log('stopped');
}

function startMock(reason) {
  setMode('mock', 'MOCK · scheduling only');
  els.mockNote.hidden = false;
  els.mockNote.textContent =
    `No decoded audio: ${reason}. The page is evaluating the retail RPM curves ` +
    `and logging the schedule only — it does not produce sound. Run ` +
    `\`node probes/audio/serve.mjs\` and extract the WAVs with extract_baf.py.`;
  els.play.disabled = true;
  els.stop.disabled = true;
  els.sweep.disabled = false;
  els.pick.disabled = false;
  playing = false;
  if (!model) return;
  cancelAnimationFrame(rafHandle);
  const tick = () => {
    const { x, rpm } = updateReadout();
    updateRows(x);
    drawPlot(rpm);
    rafHandle = requestAnimationFrame(tick);
  };
  tick();
  log(`MOCK mode: ${reason}`);
}

function sweep() {
  cancelAnimationFrame(sweepHandle);
  const start = performance.now();
  const duration = 6500;
  const from = 700;
  const to = 7600;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    els.rpm.value = String(Math.round(from + (to - from) * t));
    updateReadout();
    updateRows(rpmToX(Number(els.rpm.value)));
    drawPlot(Number(els.rpm.value));
    if (t < 1) sweepHandle = requestAnimationFrame(tick);
  };
  sweepHandle = requestAnimationFrame(tick);
}

function drawPlot(rpm = Number(els.rpm.value)) {
  const canvas = els.plot;
  const g = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  g.clearRect(0, 0, w, h);
  const padL = 34, padR = 10, padT = 10, padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const xMax = 0.8; // 8000 RPM
  const yMax = 1.2;

  g.strokeStyle = '#30363d';
  g.lineWidth = 1;
  for (let r = 0; r <= 8000; r += 2000) {
    const px = padL + (r / 10000 / xMax) * plotW;
    g.beginPath(); g.moveTo(px, padT); g.lineTo(px, padT + plotH); g.stroke();
    g.fillStyle = '#8b949e'; g.font = '10px ui-monospace';
    g.fillText(String(r), px - 10, h - 6);
  }
  for (let v = 0; v <= 1; v += 0.5) {
    const py = padT + plotH - (v / yMax) * plotH;
    g.beginPath(); g.moveTo(padL, py); g.lineTo(padL + plotW, py); g.stroke();
    g.fillStyle = '#8b949e'; g.fillText(v.toFixed(1), 6, py + 3);
  }

  const colours = ['#58a6ff', '#3fb950', '#d29922', '#f778ba', '#a371f7', '#ff7b72'];
  activeLoops().forEach((loop, index) => {
    g.strokeStyle = colours[index % colours.length];
    g.lineWidth = 1.4;
    g.beginPath();
    let first = true;
    for (let px = 0; px <= plotW; px += 2) {
      const x = (px / plotW) * xMax;
      const y = evalPlf(loop.volume, x);
      const py = padT + plotH - (Math.min(yMax, Math.max(0, y)) / yMax) * plotH;
      if (first) { g.moveTo(padL + px, py); first = false; } else { g.lineTo(padL + px, py); }
    }
    g.stroke();
  });

  const x = rpmToX(rpm);
  const px = padL + (Math.min(xMax, x) / xMax) * plotW;
  g.strokeStyle = '#f85149';
  g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(px, padT); g.lineTo(px, padT + plotH); g.stroke();
  g.fillStyle = '#f85149';
  g.beginPath(); g.arc(px, padT + 6, 3, 0, Math.PI * 2); g.fill();
}

els.rpm.addEventListener('input', () => {
  updateReadout();
  updateRows(rpmToX(Number(els.rpm.value)));
  drawPlot(Number(els.rpm.value));
});
els.play.addEventListener('click', () => {
  startDecoded().catch((error) => {
    log(`decode failed: ${error.message}`);
    startMock(error.message);
  });
});
els.stop.addEventListener('click', () => {
  cancelAnimationFrame(sweepHandle);
  stopDecoded();
});
els.sweep.addEventListener('click', sweep);
els.pick.addEventListener('click', () => els.files.click());
els.files.addEventListener('change', async () => {
  const audioCtx = getContext();
  for (const file of els.files.files) {
    const wave = file.name.replace(/\.wav$/i, '');
    const loop = loops.find((l) => l.wave === wave);
    if (!loop) { log(`ignored ${file.name}: not in model`); continue; }
    const buffer = await audioCtx.decodeAudioData(await file.arrayBuffer());
    buffers.set(loop.slot, buffer);
    log(`loaded ${file.name}: ${buffer.duration.toFixed(3)}s`);
  }
  if (buffers.size === activeLoops().length) startDecoded().catch((e) => startMock(e.message));
});

(async () => {
  try {
    await loadModel();
    setMode('loading', 'READY · press Play');
    els.note.textContent = 'Model loaded. Press Play to fetch/decode the WAVs.';
    els.play.disabled = false;
    els.pick.disabled = false;
  } catch (error) {
    log(error.message);
    startMock(error.message);
  }
})();
