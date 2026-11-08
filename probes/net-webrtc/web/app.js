// Parent page for the two-iframe WebRTC loopback capture.
//
// The host iframe creates the room; the parent starts the guest iframe with the
// code. Both iframes connect to the net-mvp room service (lobby/roster) and
// exchange SDP/ICE over a same-origin BroadcastChannel, so the loopback test
// needs no signaling extension to the committed server. The DataChannels
// themselves are real browser WebRTC.

const query = new URLSearchParams(location.search);
const wsUrl = query.get('ws') ?? ('ws://' + location.hostname + ':8852/ws');
const snapshots = Number(query.get('snapshots') ?? '1000');
const events = Number(query.get('events') ?? '500');
const dropAt = Number(query.get('drop') ?? '300');
const failAt = Number(query.get('failure') ?? '600');

const elements = {
  summary: document.getElementById('summary'),
  host: document.getElementById('host'),
  guest: document.getElementById('guest'),
  log: document.getElementById('log')
};

const probe = {
  schema: 'blur.net-webrtc.browser/1',
  state: 'booting',
  startedAt: Date.now(),
  wsUrl,
  snapshots,
  events,
  dropAt,
  failAt,
  host: null,
  guest: null,
  checks: null,
  messages: [],
  error: null
};
window.__webrtcProbe = probe;

function setState(state, text, tone = 'wait') {
  probe.state = state;
  elements.summary.textContent = text;
  elements.summary.className = 'summary ' + (tone === 'ok' ? 'ok' : tone === 'bad' ? 'bad' : '');
}

function append(line) {
  elements.log.textContent += line + '\n';
}

function params(role, code = '') {
  const search = new URLSearchParams({
    role,
    ws: wsUrl,
    snapshots: String(snapshots),
    events: String(events),
    drop: String(dropAt),
    failure: String(failAt)
  });
  if (code) search.set('code', code);
  return '/web/solo.html?' + search.toString();
}

elements.host.src = params('host');

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'room' && data.code) {
    if (!elements.guest.src) elements.guest.src = params('guest', data.code);
    append('host room ' + data.code);
    return;
  }
  if (data.type === 'status') {
    if (data.role === 'host') probe.hostStatus = data;
    else probe.guestStatus = data;
    setState('running', data.role + ' · tick ' + data.tick + ' / ' + snapshots + ' · ' + data.transport, 'wait');
    return;
  }
  if (data.type === 'error') {
    probe.messages.push({ role: data.role, code: data.code, message: data.message });
    append('ERROR ' + data.role + ' ' + data.code + ' ' + data.message);
    setState('failed', data.role + ' failed: ' + data.code, 'bad');
    return;
  }
  if (data.type === 'result') {
    if (data.role === 'host') probe.host = data;
    else probe.guest = data;
    append(data.role + ' finished · ' + data.hash + ' · states ' + data.stateCount + ' · inputs ' + data.inputCount);
    evaluateResult();
  }
});

function evaluateResult() {
  if (!probe.host || !probe.guest) return;
  const host = probe.host;
  const guest = probe.guest;
  const checks = {
    hostTick: host.tick === snapshots,
    guestTick: guest.tick === snapshots,
    hostHashMatch: host.hash === guest.hash,
    hostStatesApplied: host.stateCount >= snapshots,
    guestStatesApplied: guest.stateCount >= snapshots,
    hostInputsApplied: host.inputCount >= events,
    guestInputsApplied: guest.inputCount >= events,
    hostTransportUsed: host.transportAtReady === 'webrtc',
    guestTransportUsed: guest.transportAtReady === 'webrtc',
    fallbackObserved: host.fallbackReason !== null && guest.fallbackReason !== null,
    reconnectObserved: host.reconnects >= 1,
    hostViolationsZero: host.violations === 0,
    guestViolationsZero: guest.violations === 0,
    hostErrorsZero: host.errors.length === 0,
    guestErrorsZero: guest.errors.length === 0,
    messagesClean: probe.messages.length === 0
  };
  probe.checks = checks;
  const ok = Object.values(checks).every(Boolean);
  probe.state = ok ? 'finished' : 'failed';
  if (!ok) {
    probe.error = 'failed checks: ' + Object.entries(checks).filter(([, value]) => !value).map(([key]) => key).join(', ');
  }
  setState(probe.state, (ok ? 'PASS' : 'FAIL') + ' · ' + host.hash.slice(0, 20) + '…', ok ? 'ok' : 'bad');
}

setState('booting', 'starting host', 'wait');
