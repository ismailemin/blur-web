// Static server for the E1 drive slice.
//
// Serves exactly nine trees, all read-only:
//   /                -> probes/e1-drive/web/            (the page)
//   /_work/e1-drive/ -> _work/e1-drive/                 (module, geometry, level, packet, layouts)
//   /ghosts/         -> probes/e1-drive/ghosts/         (committed reference ghost traces)
//   /prop-collision/ -> probes/prop-collision/          (read-only P66 resolver + lib)
//   /_work/free-roam-prop/ -> _work/free-roam-prop/     (P74 R04-V2 free-roam collider manifest)
//   /audio/          -> probes/audio/web/               (the committed engine-audio ES module)
//   /_work/audio/    -> _work/audio/                    (decoded retail WAVs, read-only, not committed)
//   /net-mvp/        -> probes/net-mvp/                 (client/protocol modules, read-only)
//   /race-rules/     -> probes/race-rules/              (M1 rules ES modules, read-only)
//
// No directory listing, no writes, no path escapes. Callable as a module
// (`startServer({port})`) or directly
// (`node probes/e1-drive/tools/serve.mjs [--port 8801] [--with-room] [--room-port 8811]`).
//
// `--with-room` starts the unmodified `probes/net-mvp/server.mjs` room service
// beside the game server. The page's default multiplayer WebSocket target is
// `ws://<page-host>:8811/ws`; `?mpServer=ws://host:port/ws` overrides it.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WEB = path.join(ROOT, 'probes/e1-drive/web');
const WORK = path.join(ROOT, '_work/e1-drive');
const GHOSTS = path.join(ROOT, 'probes/e1-drive/ghosts');
const PROP = path.join(ROOT, 'probes/prop-collision');
const PROP_WORK = path.join(ROOT, '_work/prop-collision');
const FREE_PROP_WORK = path.join(ROOT, '_work/free-roam-prop');
const AUDIO = path.join(ROOT, 'probes/audio/web');
const AUDIO_WORK = path.join(ROOT, '_work/audio');
const NET_MVP = path.join(ROOT, 'probes/net-mvp');
const RACE_RULES = path.join(ROOT, 'probes/race-rules');
// The page only needs the dependency-free client half of the transport probe.
const NET_MVP_MODULES = new Set(['client.mjs', 'protocol.mjs', 'hash.mjs', 'race.mjs']);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.fields': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.levelphysics': 'application/octet-stream',
  '.wav': 'audio/wav'
};

function safeJoin(base, relative) {
  const resolved = path.resolve(base, '.' + path.posix.normalize('/' + relative));
  return resolved === base || resolved.startsWith(base + path.sep) ? resolved : null;
}

export function startServer({ port = 8801 } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    let file;
    if (pathname === '/' || pathname === '/index.html') file = path.join(WEB, 'index.html');
    else if (pathname.startsWith('/_work/e1-drive/')) file = safeJoin(WORK, pathname.slice('/_work/e1-drive/'.length));
    else if (pathname.startsWith('/ghosts/')) file = safeJoin(GHOSTS, pathname.slice('/ghosts/'.length));
    else if (pathname.startsWith('/prop-collision/')) file = safeJoin(PROP, pathname.slice('/prop-collision/'.length));
    else if (pathname.startsWith('/_work/prop-collision/')) file = safeJoin(PROP_WORK, pathname.slice('/_work/prop-collision/'.length));
    else if (pathname.startsWith('/_work/free-roam-prop/')) file = safeJoin(FREE_PROP_WORK, pathname.slice('/_work/free-roam-prop/'.length));
    else if (pathname.startsWith('/audio/')) file = safeJoin(AUDIO, pathname.slice('/audio/'.length));
    else if (pathname.startsWith('/_work/audio/')) file = safeJoin(AUDIO_WORK, pathname.slice('/_work/audio/'.length));
    else if (pathname.startsWith('/net-mvp/')) {
      const name = pathname.slice('/net-mvp/'.length);
      if (NET_MVP_MODULES.has(name)) file = path.join(NET_MVP, name);
    } else if (pathname.startsWith('/race-rules/')) {
      const relative = pathname.slice('/race-rules/'.length);
      if (relative.endsWith('.mjs')) file = safeJoin(RACE_RULES, relative);
    } else file = safeJoin(WEB, pathname.slice(1));

    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found: ' + pathname);
      return;
    }
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    response.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp'
    });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      resolve({ server, origin: 'http://127.0.0.1:' + actualPort, port: actualPort });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--port');
  const port = Number(index >= 0 ? args[index + 1] : 8801);
  const roomIndex = args.indexOf('--room-port');
  const roomPort = Number(roomIndex >= 0 ? args[roomIndex + 1] : 8811);
  const { origin } = await startServer({ port });
  let room = null;
  if (args.includes('--with-room')) {
    const { startRoomServer } = await import('../../net-mvp/server.mjs');
    room = await startRoomServer({
      port: roomPort,
      log: (event) => console.log('[net-mvp]', JSON.stringify(event))
    });
    console.log('room service:        ' + room.wsUrl + ' (unchanged probes/net-mvp/server.mjs)');
  } else {
    console.log('room service:        start probes/net-mvp/server.mjs on ' + roomPort +
      ' or rerun with --with-room');
  }
  console.log('E1 drive slice: ' + origin + '/?script=drive');
  console.log('manual keyboard drive: ' + origin + '/');
  console.log('multiplayer host: ' + origin + '/?mp=1&host=1&script=sprint' +
    ' (lobby shows the allocated room code)');
  console.log('multiplayer guest: ' + origin + '/?mp=1&room=CODE&script=sprint');
  if (room) {
    const closeRoom = room.close;
    const shut = async () => { try { await closeRoom(); } catch {} process.exit(0); };
    process.on('SIGINT', shut);
    process.on('SIGTERM', shut);
  }
}
