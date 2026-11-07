// Orchestrates the two same-origin iframes. The host creates the room, the
// parent then creates the guest iframe with the code, and both clients run the
// same 60 Hz synthetic race. The page exposes `window.__netMvpProbe` for the
// headless capture and renders a visible state readout.
//
// No console output is produced. If a client fails it posts a typed error,
// which becomes a visible failure and a `state:'failed'` probe.

const seconds = Number(new URLSearchParams(location.search).get('seconds') ?? 30);
const finalTick = Math.round(seconds * 60);
const gateElement = document.getElementById('gate');
const guestShell = document.getElementById('guest-shell');
const hostFrame = document.getElementById('host');
// The iframe markup has a default; replace it immediately so a short smoke run
// and the 30 s evidence run both use the requested duration.
hostFrame.src = '/solo.html?role=a&seconds=' + encodeURIComponent(seconds);
const summary = {
  code: document.getElementById('sum-code'),
  host: document.getElementById('sum-host'),
  seed: document.getElementById('sum-seed'),
  tick: document.getElementById('sum-tick'),
  final: document.getElementById('sum-final'),
  hash: document.getElementById('sum-hash'),
  console: document.getElementById('sum-console')
};
summary.final.textContent = String(finalTick);

const probe = {
  state: 'booting',
  seconds,
  finalTick,
  code: null,
  seed: null,
  statuses: {},
  results: {},
  messages: [],
  checks: {},
  mid: false,
  error: null
};
window.__netMvpProbe = probe;

function record(kind, text) {
  probe.messages.push({ kind, text: String(text) });
}
window.addEventListener('error', (event) => {
  record('error', event.message || 'window error');
  probe.state = 'failed';
  probe.error = event.message || 'window error';
  render();
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason?.stack || event.reason?.message || String(event.reason);
  record('rejection', reason);
  probe.state = 'failed';
  probe.error = reason;
  render();
});

function render() {
  const hostStatus = probe.statuses.a;
  const guestStatus = probe.statuses.b;
  const tick = Math.max(hostStatus?.tick ?? 0, guestStatus?.tick ?? 0);
  summary.code.textContent = probe.code ?? '—';
  summary.host.textContent = hostStatus?.playerId ?? '—';
  summary.seed.textContent = probe.seed ?? '—';
  summary.tick.textContent = String(tick);
  summary.hash.textContent = probe.checks.hashMatch === true ? 'PASS' : probe.checks.hashMatch === false ? 'FAIL' : '—';
  summary.console.textContent = String(probe.messages.length);
  const classes = { finished: 'ok', failed: 'bad', racing: '', booting: '', joining: '' };
  gateElement.className = 'gate ' + (classes[probe.state] ?? '');
  if (probe.state === 'finished') gateElement.textContent = 'PASS · both clients finished the same tick with the same hash';
  else if (probe.state === 'failed') gateElement.textContent = 'FAIL · ' + (probe.error ?? 'see client readout');
  else if (probe.state === 'racing') gateElement.textContent = 'racing · ' + tick + ' / ' + finalTick;
  else if (probe.state === 'joining') gateElement.textContent = 'room joined · waiting for both clients to be ready';
  else gateElement.textContent = 'waiting for host';
}

function createGuest(code) {
  if (probe.statuses.b) return;
  const frame = document.createElement('iframe');
  frame.id = 'guest';
  frame.title = 'guest client';
  frame.src = '/solo.html?role=b&seconds=' + encodeURIComponent(seconds) + '&code=' + encodeURIComponent(code);
  guestShell.replaceChildren(frame);
}

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return;
  const message = event.data;
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
  if (message.type === 'room' && message.role === 'a' && typeof message.code === 'string') {
    probe.code = message.code;
    probe.state = probe.state === 'booting' ? 'joining' : probe.state;
    createGuest(message.code);
    render();
    return;
  }
  if (message.type === 'status' && (message.role === 'a' || message.role === 'b')) {
    probe.statuses[message.role] = message;
    if (message.seed) probe.seed = message.seed;
    if (message.phase === 'running') probe.state = probe.state === 'finished' || probe.state === 'failed' ? probe.state : 'racing';
    const hostTick = probe.statuses.a?.tick ?? 0;
    const guestTick = probe.statuses.b?.tick ?? 0;
    probe.mid = probe.mid || (hostTick >= Math.min(300, Math.round(finalTick * 0.4)) &&
      guestTick >= Math.min(300, Math.round(finalTick * 0.4)));
    render();
    return;
  }
  if (message.type === 'result' && (message.role === 'a' || message.role === 'b')) {
    probe.results[message.role] = message;
    if (probe.results.a && probe.results.b) {
      const host = probe.results.a;
      const guest = probe.results.b;
      const hashMatch = typeof host.hash === 'string' && host.hash === guest.hash;
      const tickMatch = host.tick === finalTick && guest.tick === finalTick;
      const appliedMatch = host.checks?.appliedMatch !== false && guest.checks?.appliedMatch !== false;
      const sequenceMatch = host.checks?.converged === true && guest.checks?.converged === true;
      probe.checks = { hashMatch, tickMatch, appliedMatch, sequenceMatch, hostHash: host.hash, guestHash: guest.hash };
      probe.state = hashMatch && tickMatch && appliedMatch && sequenceMatch ? 'finished' : 'failed';
      if (probe.state === 'failed') probe.error = 'final checks failed: ' + JSON.stringify(probe.checks);
      render();
    }
    return;
  }
  if (message.type === 'error') {
    const detail = typeof message.detail === 'string' ? message.detail : message.detail ? JSON.stringify(message.detail) : '';
    const text = (message.message || 'client error') + (detail ? ' · ' + detail : '');
    record('client-error', text);
    probe.state = 'failed';
    probe.error = text;
    render();
  }
});
