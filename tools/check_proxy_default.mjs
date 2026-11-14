// Prove that a page derives the right room-service URL from its own origin.
//
// HTTPS: the supported internet topology is a TLS reverse proxy that terminates
// both routes on one origin, so `defaultRoomUrl` returns
// `wss://<host>[:port]/ws` and a guest never appends `?mpServer=`.
// Plain HTTP (LAN, direct `serve.mjs`): the room service keeps its own port.
//
// This check loads two real pages, joins them into one room, races to the finish
// and requires the same shared result on both pages.
//
//   node tools/check_proxy_default.mjs --port 8443
//   node tools/check_proxy_default.mjs --origin http://127.0.0.1:8801/ \
//       --expect-room ws://127.0.0.1:8811/ws
//
// Exit code 0 only when the derived URL matches and both pages finish with an
// identical result hash.

import path from 'node:path';
import { CdpBrowser, findBrowser, sleep } from '../probes/e2e/cdp.mjs';

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
};

const PORT = Number(option('--port', '8443'));
const MAP = option('--map', 'river');
const ORIGIN = option('--origin', 'https://localhost:' + PORT + '/');
const EXPECTED_ROOM = option('--expect-room', 'wss://localhost:' + PORT + '/ws');
const SECURE = ORIGIN.startsWith('https:');
const HOST_CAR = 'corvette-zr1-stock';
const GUEST_CAR = 'audi-r8v10-stock';

const failures = [];
const check = (label, ok, detail) => {
  if (!ok) failures.push(label + (detail === undefined ? '' : ': ' + detail));
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (detail === undefined ? '' : ' :: ' + detail));
};

const probe = (page) => page.evaluate(`(() => {
  const p = window.e1DriveProbe;
  if (!p) return { probe: false };
  return {
    probe: true,
    consumer: p.consumer,
    error: p.error ?? null,
    url: p.mp?.url ?? null,
    phase: p.mp?.phase ?? null,
    status: p.mp?.status ?? null,
    code: p.mp?.room?.code ?? null,
    players: p.mp?.players?.length ?? 0,
    result: p.mp?.result ?? null,
    engineTick: p.engineTick ?? null
  };
})()`);

async function waitFor(page, predicate, { timeoutMs, label }) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await probe(page);
    if (last?.error) throw new Error(label + ': page error ' + last.error);
    if (predicate(last)) return last;
    await sleep(250);
  }
  throw new Error(label + ': timed out after ' + timeoutMs + ' ms; last ' + JSON.stringify(last));
}

const browser = await CdpBrowser.launch({
  executable: findBrowser(),
  profileDir: path.resolve('_work/profile-proxy-default'),
  viewport: { width: 1280, height: 800 },
  extraArgs: SECURE ? ['--ignore-certificate-errors'] : []
});

try {
  const host = await browser.newPage({ label: 'host', url: 'about:blank' });
  await host.init();
  const hostUrl = ORIGIN + '?mp=1&host=1&script=sprint&car=' + HOST_CAR +
    '&map=' + MAP + '&name=Host&audio=0';
  await host.navigate(hostUrl);
  const hostLobby = await waitFor(host, (p) => p.phase === 'lobby' && Boolean(p.code),
    { timeoutMs: 180000, label: 'host lobby' });

  check('host page derived the expected room URL with no ?mpServer=',
    hostLobby.url === EXPECTED_ROOM, hostLobby.url + ' vs ' + EXPECTED_ROOM);
  check('host page reached the lobby and allocated a room code',
    typeof hostLobby.code === 'string' && hostLobby.code.length === 5, hostLobby.code);

  const guest = await browser.newPage({ label: 'guest', url: 'about:blank' });
  await guest.init();
  const guestUrl = ORIGIN + '?mp=1&room=' + hostLobby.code + '&script=sprint&car=' + GUEST_CAR +
    '&mpPace=0.85&name=Guest&audio=0';
  await guest.navigate(guestUrl);
  const guestLobby = await waitFor(guest, (p) => p.phase === 'lobby' && p.players === 2,
    { timeoutMs: 180000, label: 'guest lobby' });

  check('guest page derived the same room URL with no ?mpServer=',
    guestLobby.url === EXPECTED_ROOM, guestLobby.url + ' vs ' + EXPECTED_ROOM);
  check('both pages see the same two-player roster',
    guestLobby.code === hostLobby.code && guestLobby.players === 2,
    JSON.stringify({ host: hostLobby.code, guest: guestLobby.code, players: guestLobby.players }));

  await host.evaluate('window.__mp.setReady(true)');
  await guest.evaluate('window.__mp.setReady(true)');
  await waitFor(host, (p) => p.players === 2 && p.phase === 'lobby',
    { timeoutMs: 30000, label: 'ready propagation' });
  await sleep(1000);
  await host.evaluate('window.__mp.start()');

  const resultTimeout = 300000;
  const hostDone = await waitFor(host, (p) => p.result !== null,
    { timeoutMs: resultTimeout, label: 'host result' });
  const guestDone = await waitFor(guest, (p) => p.result !== null,
    { timeoutMs: resultTimeout, label: 'guest result' });

  check('both pages finished the race',
    hostDone.phase === 'finished' && guestDone.phase === 'finished',
    JSON.stringify({ host: hostDone.phase, guest: guestDone.phase }));
  check('both pages render the same shared result hash',
    typeof hostDone.result?.hash === 'string' && hostDone.result.hash === guestDone.result?.hash,
    hostDone.result?.hash + ' / ' + guestDone.result?.hash);
  check('the result has one row per player',
    hostDone.result?.rows?.length === 2 && guestDone.result?.rows?.length === 2,
    JSON.stringify({ host: hostDone.result?.rows?.length, guest: guestDone.result?.rows?.length }));

  const consoleErrors = [...host.messages, ...guest.messages]
    .filter((m) => m.type === 'error' || m.source === 'exception');
  check('no console error on either page', consoleErrors.length === 0,
    JSON.stringify(consoleErrors.map((m) => m.text).slice(0, 3)));
} finally {
  await browser.close();
}

if (failures.length) {
  console.log('\nDERIVED-ROOM CHECK FAILED');
  for (const failure of failures) console.log('  - ' + failure);
  process.exit(1);
}
console.log('\nDERIVED-ROOM CHECK PASSED: two pages raced with no ?mpServer= override.');
console.log('  page  ' + ORIGIN);
console.log('  room  ' + EXPECTED_ROOM + '  (derived from the page origin)');
