import { PacketConsumer } from './packet-consumer.js';

const PACKET_URL = new URLSearchParams(location.search).get('packet') ?? '/packet/packet.json';
const FOCUS = new URLSearchParams(location.search).get('focus') ?? '';
const canvas = document.getElementById('scene');
const state = {
  consumer: 'idle',
  packet: null,
  frames: 0,
  error: null,
  adapter: null,
  camera: 'packet',
  aspect: null,
  gpu: null
};

function publish() {
  document.documentElement.dataset.consumer = state.consumer;
  document.documentElement.dataset.renderState = state.consumer;
  window.renderPacketProbe = state;
  const rows = [
    ['packet', state.packet ? state.packet.hash.slice(0, 23) + '…' : '—'],
    ['draws', state.packet ? String(state.packet.diagnostics.drawCount) : '—'],
    ['vertices', state.packet ? state.packet.diagnostics.vertexTotal.toLocaleString('en-US') : '—'],
    ['triangles', state.packet ? state.packet.diagnostics.triangleTotal.toLocaleString('en-US') : '—'],
    ['materials', state.packet ? (state.packet.diagnostics.materialsApplied ? 'applied' : 'not applied') : '—'],
    ['lighting', state.packet ? state.packet.diagnostics.lighting : '—'],
    ['camera', state.camera],
    ['frames', String(state.frames)],
    ['gpu', state.gpu ?? '—'],
    ['canvas', state.aspect ? state.aspect.toFixed(4) : '—']
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
  if (event.state === 'rendered') {
    state.frames = event.frames;
    state.consumer = 'rendered';
    publish();
  } else if (event.state === 'error') {
    fail(event.message);
  }
});

window.addEventListener('error', (event) => fail('page error: ' + event.message));
window.addEventListener('unhandledrejection', (event) => fail('unhandled rejection: ' + (event.reason?.message ?? String(event.reason))));

async function main() {
  state.consumer = 'loading';
  publish();

  const response = await fetch(PACKET_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error('packet fetch failed: HTTP ' + response.status + ' for ' + PACKET_URL);
  const packet = await response.json();
  state.packet = packet;

  await consumer.load(packet);
  state.gpu = consumer.adapterInfo
    ? [consumer.adapterInfo.vendor, consumer.adapterInfo.architecture, consumer.adapterInfo.device].filter(Boolean).join(' / ') || 'unnamed adapter'
    : 'unnamed adapter';
  state.aspect = packet.camera.aspect;
  const canvasAspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  if (Math.abs(canvasAspect - packet.camera.aspect) > 0.01) {
    throw new Error('canvas aspect ' + canvasAspect.toFixed(4) + ' does not match the packet camera aspect ' + packet.camera.aspect.toFixed(4));
  }

  if (FOCUS) {
    const meshId = FOCUS === 'car' ? 'corvette.c3.race.body' : FOCUS;
    consumer.focusMesh(meshId);
    state.camera = 'debug-focus:' + meshId;
  } else {
    state.camera = 'packet';
  }
  publish();

  if (consumer.device) await consumer.device.queue.onSubmittedWorkDone();
  if (state.consumer !== 'error') {
    state.consumer = 'ready';
    document.documentElement.dataset.renderState = 'ready';
    publish();
  }
}

main().catch((error) => fail(error.message));
