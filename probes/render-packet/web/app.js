// Browser host for the render-packet consumer.
//
// Owns the fixed-step loop from docs/work/analysis/t005-scheduler-design.md §4.3:
// integer-microsecond accumulator, 1/60 tick, 4-tick cap, backlog drop and the
// 0.25 s pause rule — the same logic as probes/scheduler-probe, so this page and
// the scheduler probe agree frame by frame (tools/verify_tick_loop.mjs proves it).
//
// URL parameters:
//   ?hold=<tick>   advance the driver until that tick, then hold it exactly.
//                  Used by the screenshot evidence; not a packet feature.
//   ?focus=<mesh>  debug camera framed on one mesh (camera only, all draws still run).
//   ?packet=<url>  load a different packet file.

import { PacketConsumer } from './packet-consumer.js';
import { FixedStepDriver, FLAG } from './fixed-step.js';

const params = new URLSearchParams(location.search);
const PACKET_URL = params.get('packet') ?? '/packet/packet.json';
const FOCUS = params.get('focus') ?? '';
const HOLD = params.has('hold') ? Number(params.get('hold')) : null;
if (HOLD !== null && (!Number.isInteger(HOLD) || HOLD < 0)) throw new Error('hold must be a non-negative integer tick');
// Evidence option: pin the camera to the packet's tick-0 camera so two frames of
// different ticks differ only by the moving object.
const PIN_CAMERA = params.get('pinCamera') === '1';

const canvas = document.getElementById('scene');
const driver = new FixedStepDriver();

const state = {
  consumer: 'idle',
  packet: null,
  error: null,
  adapter: null,
  hold: HOLD,
  holdReached: false,
  pinCamera: PIN_CAMERA,
  cursor: 0,
  alpha: 0,
  renderTick: 0,
  ticksExecuted: 0,
  frames: 0,
  cappedFrames: 0,
  pauseDrops: 0,
  zeroTickFrames: 0,
  geometryUploads: 0,
  geometryUploadBytes: 0,
  uniformWrites: 0,
  uniformBytes: 0,
  drawsIssued: 0,
  matrixChecksum: null,
  tickHash: null,
  movedScreen: null,
  sequence: null,
  camera: 'packet'
};

function publish() {
  document.documentElement.dataset.consumer = state.consumer;
  document.documentElement.dataset.renderState = state.consumer;
  document.documentElement.dataset.holdReached = String(state.holdReached);
  window.renderPacketProbe = state;
  const sequence = state.sequence;
  const rows = [
    ['packet', state.packet ? state.packet.hash.slice(0, 23) + '…' : '—'],
    ['version', state.packet ? state.packet.version.toFixed(1) : '—'],
    ['draws', state.packet ? String(state.packet.diagnostics.drawCount) : '—'],
    ['vertices', state.packet ? state.packet.diagnostics.vertexTotal.toLocaleString('en-US') : '—'],
    ['triangles', state.packet ? state.packet.diagnostics.triangleTotal.toLocaleString('en-US') : '—'],
    ['materials', state.packet ? (state.packet.diagnostics.materialsApplied ? 'applied' : 'not applied') : '—'],
    ['sequence', sequence ? sequence.tickCount + ' ticks @ ' + sequence.tickHz + ' Hz · ' + sequence.motion : 'static'],
    ['tick', sequence ? state.renderTick + ' + ' + state.alpha.toFixed(4) : '—'],
    ['ticks run', String(state.ticksExecuted)],
    ['frames', String(state.frames)],
    ['uploads', state.geometryUploads + ' geometry · ' + state.uniformWrites + ' uniform'],
    ['bytes', state.geometryUploadBytes.toLocaleString('en-US') + ' geometry · ' + state.uniformBytes.toLocaleString('en-US') + ' uniform'],
    ['checksum', state.matrixChecksum ?? '—'],
    ['tick hash', state.tickHash ? state.tickHash.slice(7, 19) + '…' : '—'],
    ['capped/paused', state.cappedFrames + ' / ' + state.pauseDrops],
    ['gpu', state.adapter ?? '—'],
    ['hold', state.hold === null ? 'off' : String(state.hold) + (state.holdReached ? ' reached' : ' pending')]
  ];
  document.getElementById('hud').textContent = rows.map(([key, value]) => key + '  ' + value).join('\n');
}

function fail(message) {
  state.consumer = 'error';
  state.error = message;
  document.getElementById('error').hidden = false;
  document.getElementById('error').textContent = message;
  publish();
}

const consumer = new PacketConsumer(canvas, (event) => {
  if (event.state === 'error') fail(event.message);
});

window.addEventListener('error', (event) => fail('page error: ' + event.message));
window.addEventListener('unhandledrejection', (event) => fail('unhandled rejection: ' + (event.reason?.message ?? String(event.reason))));

let cursor = 0;
let holdReached = HOLD !== null && HOLD === 0;
let lastTick = 0;

function frame(nowMs) {
  if (!holdReached) {
    const sample = driver.advanceTo(Math.round(nowMs * 1000));
    state.ticksExecuted += sample.ticks;
    if (sample.flags & FLAG.CAPPED) state.cappedFrames++;
    if (sample.flags & FLAG.PAUSED) state.pauseDrops++;
    if (sample.flags & FLAG.ZERO_TICK) state.zeroTickFrames++;
    if (sample.ticks > 0) {
      cursor += sample.ticks;
      if (HOLD !== null && cursor >= HOLD) {
        cursor = HOLD;
        holdReached = true;
      } else if (cursor >= lastTick) {
        // The synthetic sequence is finite; hold the last tick rather than wrap.
        cursor = lastTick;
        holdReached = true;
      }
    }
  }
  const alpha = holdReached ? 0 : driver.currentAlpha();
  const rendered = consumer.renderFrame({ cursor: cursor + alpha });
  if (rendered) {
    state.frames = consumer.stats.renders;
    state.cursor = rendered.frame.cursor;
    state.alpha = rendered.frame.alpha;
    state.renderTick = rendered.frame.tickFloor;
    state.tickHash = rendered.frame.tickHash;
    state.matrixChecksum = consumer.stats.matrixChecksum;
    state.movedScreen = consumer.stats.movedScreen;
    state.geometryUploads = consumer.stats.geometryUploads;
    state.geometryUploadBytes = consumer.stats.geometryUploadBytes;
    state.uniformWrites = consumer.stats.uniformWrites;
    state.uniformBytes = consumer.stats.uniformBytes;
    state.drawsIssued = consumer.stats.drawsIssued;
    state.holdReached = holdReached;
    if (state.consumer !== 'error') state.consumer = 'running';
    publish();
  }
  requestAnimationFrame(frame);
}

async function main() {
  state.consumer = 'loading';
  publish();

  const response = await fetch(PACKET_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error('packet fetch failed: HTTP ' + response.status + ' for ' + PACKET_URL);
  const packet = await response.json();
  state.packet = packet;

  consumer.pinCamera = PIN_CAMERA;
  await consumer.load(packet);
  state.adapter = consumer.adapterInfo
    ? [consumer.adapterInfo.vendor, consumer.adapterInfo.architecture, consumer.adapterInfo.device].filter(Boolean).join(' / ') || 'unnamed adapter'
    : 'unnamed adapter';
  state.sequence = consumer.timeline
    ? { tickCount: consumer.timeline.tickCount, tickHz: consumer.timeline.tickHz, motion: consumer.timeline.motion, lastTick: consumer.timeline.lastTick }
    : null;
  lastTick = consumer.timeline ? consumer.timeline.lastTick : 0;

  const canvasAspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  if (Math.abs(canvasAspect - packet.camera.aspect) > 0.01) {
    throw new Error('canvas aspect ' + canvasAspect.toFixed(4) + ' does not match the packet camera aspect ' + packet.camera.aspect.toFixed(4));
  }

  if (FOCUS) {
    consumer.focusMesh(FOCUS === 'car' ? 'corvette.c3.race.body' : FOCUS);
    state.camera = 'debug-focus:' + FOCUS;
  }

  if (HOLD !== null && HOLD > lastTick) throw new Error('hold tick ' + HOLD + ' is beyond the sequence last tick ' + lastTick);

  state.cursor = 0;
  state.consumer = 'running';
  publish();
  if (consumer.device) await consumer.device.queue.onSubmittedWorkDone();
  requestAnimationFrame(frame);
}

main().catch((error) => fail(error.message));
