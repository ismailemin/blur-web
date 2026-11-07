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
//   /_work/powerups/ -> _work/powerups/                 (PWR1 manifest, read-only)
//   /powerups/       -> probes/powerups/rules/engine.js (PWR1 rules prototype, read-only)
//
// `/_powerups/relay` is a project-specific, ordered in-memory control relay for
// the power-up slice: the host posts sequenced events, the guest posts use
// intents (the host validates them). It is not a retail protocol and it does not
// touch `probes/net-mvp/**`.
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
// PWR1 read-only inputs for the power-up slice: the manifest the model consumes
// and the committed rules prototype (never copied or edited here).
const POWERUPS_WORK = path.join(ROOT, '_work/powerups');
const POWERUPS_RULES = path.join(ROOT, 'probes/powerups/rules');
const POWERUPS_RULE_FILES = new Set(['engine.js']);
// The page only needs the dependency-free client half of the transport probe.
const NET_MVP_MODULES = new Set(['client.mjs', 'protocol.mjs', 'hash.mjs', 'race.mjs']);

const RELAY_ROOM_LIMIT = 512;
const RELAY_BODY_LIMIT = 512 * 1024;
const RELAY_ROOM = /^[A-Za-z0-9_-]{1,32}$/;
const RELAY_FROM = /^[A-Za-z0-9_.:-]{1,64}$/;

/** In-memory, ordered power-up control relay (project-specific, not retail). */
function createPowerupRelay() {
  const rooms = new Map();
  const roomState = (code) => {
    let state = rooms.get(code);
    if (!state) {
      state = {
        seq: 0,
        messages: [],
        stats: {
          events: 0,
          intents: 0,
          polls: 0,
          delivered: 0,
          dropped: 0,
          lastAt: null
        }
      };
      rooms.set(code, state);
    }
    return state;
  };
  return {
    post({ room, from, kind, payload }) {
      if (!RELAY_ROOM.test(room ?? '')) throw new Error('invalid relay room');
      if (!RELAY_FROM.test(from ?? '')) throw new Error('invalid relay sender');
      if (kind !== 'event' && kind !== 'intent') throw new Error('relay kind must be event or intent');
      const state = roomState(room);
      state.seq += 1;
      state.messages.push({ seq: state.seq, from, kind, payload, at: Date.now() });
      if (state.messages.length > RELAY_ROOM_LIMIT) {
        const removed = state.messages.splice(0, state.messages.length - RELAY_ROOM_LIMIT);
        state.stats.dropped += removed.length;
      }
      if (kind === 'event') state.stats.events += 1;
      else state.stats.intents += 1;
      state.stats.lastAt = Date.now();
      return { seq: state.seq };
    },
    poll({ room, after = 0, exclude = null }) {
      if (!RELAY_ROOM.test(room ?? '')) throw new Error('invalid relay room');
      const state = roomState(room);
      const cursor = Number.isFinite(after) && after >= 0 ? after : 0;
      state.stats.polls += 1;
      const messages = state.messages.filter((message) =>
        message.seq > cursor && (exclude === null || message.from !== exclude));
      state.stats.delivered += messages.length;
      return {
        messages,
        next: state.messages.length ? state.messages[state.messages.length - 1].seq : cursor,
        now: Date.now()
      };
    },
    stats(room) {
      const state = rooms.get(room);
      if (!state) return { room, seq: 0, pending: 0, stats: null };
      return { room, seq: state.seq, pending: state.messages.length, stats: { ...state.stats } };
    },
    clear(room) {
      rooms.delete(room);
    }
  };
}

function readJsonBody(request, limit = RELAY_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > limit) {
        reject(new Error('request body exceeds ' + limit + ' bytes'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(new Error('request body is not JSON: ' + error.message)); }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(text);
}


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
  const relay = createPowerupRelay();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    // Power-up control relay: a project-specific ordered channel beside the
    // unchanged room service. Host posts events, guest posts use intents; the
    // host remains the only authority that validates and emits events.
    if (pathname === '/_powerups/relay' || pathname === '/_powerups/relay/stats') {
      try {
        if (pathname === '/_powerups/relay' && request.method === 'POST') {
          const body = await readJsonBody(request);
          const result = relay.post(body ?? {});
          sendJson(response, 200, { ok: true, seq: result.seq });
          return;
        }
        if (pathname === '/_powerups/relay' && request.method === 'GET') {
          const result = relay.poll({
            room: url.searchParams.get('room'),
            after: Number(url.searchParams.get('after') ?? 0),
            exclude: url.searchParams.get('exclude')
          });
          sendJson(response, 200, result);
          return;
        }
        if (pathname === '/_powerups/relay/stats' && request.method === 'GET') {
          sendJson(response, 200, relay.stats(url.searchParams.get('room')));
          return;
        }
        sendJson(response, 405, { ok: false, error: 'method not allowed' });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }
    let file;
    if (pathname === '/' || pathname === '/index.html') file = path.join(WEB, 'index.html');
    else if (pathname.startsWith('/_work/e1-drive/')) file = safeJoin(WORK, pathname.slice('/_work/e1-drive/'.length));
    else if (pathname.startsWith('/_work/powerups/')) file = safeJoin(POWERUPS_WORK, pathname.slice('/_work/powerups/'.length));
    else if (pathname.startsWith('/powerups/')) {
      const name = pathname.slice('/powerups/'.length);
      if (POWERUPS_RULE_FILES.has(name)) file = path.join(POWERUPS_RULES, name);
    }
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
      resolve({ server, origin: 'http://127.0.0.1:' + actualPort, port: actualPort, relay });
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
  console.log('multiplayer power-ups: append &powerups=1 to either URL (Mine/Shield/Repair slice)');
  if (room) {
    const closeRoom = room.close;
    const shut = async () => { try { await closeRoom(); } catch {} process.exit(0); };
    process.on('SIGINT', shut);
    process.on('SIGTERM', shut);
  }
}
