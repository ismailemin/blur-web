// Static server for the E1 drive slice.
//
// Serves these trees, all read-only:
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
//   /_work/map-slice/ -> _work/map-slice/               (committed map-slice packages, read-only)
//   /map-data/       -> game-data/Blur/levels/          (level physics bytes, read-only; not committed)
//
// `/_powerups/relay` is a project-specific, ordered in-memory control relay for
// the power-up slice: the host posts sequenced events, the guest posts use
// intents (the host validates them). It is not a retail protocol and it does not
// touch `probes/net-mvp/**`.
//
// `/_mp-ai/relay` is the equivalent ordered channel for the host's AI roster,
// 20 Hz AI poses and AI result rows. Only the host page publishes; guests poll.
// It carries no AI simulation to a client and is not a retail protocol either.
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
// The game shell module (menu/mode/car/map/lobby) is served read-only; the
// e1-drive page mounts it from `/game-shell/shell.js` on a bare load.
const GAME_SHELL = path.join(ROOT, 'probes/game-shell');
// Measured lap layouts (Amboy loop-01) are committed data under probes/map-laps.
const MAP_LAPS = path.join(ROOT, 'probes/map-laps');
// Amboy/Gracia prop colliders (built by probes/map-props) live in _work.
const MAP_PROPS_WORK = path.join(ROOT, '_work/map-props');
// The runtime HUD module (DOM-only) is served read-only from probes/hud-ui.
const HUD_UI = path.join(ROOT, 'probes/hud-ui');
// Runtime lighting / material tables (data-only modules) are served read-only.
const LIGHTING = path.join(ROOT, 'probes/lighting');
const CAR_MATERIALS = path.join(ROOT, 'probes/car-materials');
// PWR1 read-only inputs for the power-up slice: the manifest the model consumes
// and the committed rules prototype (never copied or edited here).
const POWERUPS_WORK = path.join(ROOT, '_work/powerups');
const POWERUPS_RULES = path.join(ROOT, 'probes/powerups/rules');
const POWERUPS_RULE_FILES = new Set(['engine.js', 'projectiles.js']);
// M3 map packages and the read-only level physics bytes. The map-slice tree is
// generated game-data output; `game-data/` is the installed game tree. Neither
// is copied into the repository or written by the server.
const MAP_SLICE_WORK = path.join(ROOT, '_work/map-slice');
const MAP_DATA_LEVELS = path.join(ROOT, 'game-data/Blur/levels');
// The page only needs the dependency-free client half of the transport probe.
const NET_MVP_MODULES = new Set(['client.mjs', 'protocol.mjs', 'hash.mjs', 'race.mjs']);

const RELAY_ROOM_LIMIT = 512;
const AI_RELAY_ROOM_LIMIT = 1500;
const RELAY_BODY_LIMIT = 512 * 1024;
const RELAY_ROOM = /^[A-Za-z0-9_-]{1,32}$/;
const RELAY_FROM = /^[A-Za-z0-9_.:-]{1,64}$/;
const AI_RELAY_KINDS = new Set(['roster', 'pose', 'result']);

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

/**
 * Ordered host→guest AI relay: roster (lobby), 20 Hz poses (race) and the final
 * AI result rows. The room code is the key; the host is the only publisher in
 * the page. Poses are latest-state traffic and the ring is bounded.
 */
function createMpAiRelay() {
  const rooms = new Map();
  const roomState = (code) => {
    let state = rooms.get(code);
    if (!state) {
      state = {
        seq: 0,
        messages: [],
        stats: { roster: 0, pose: 0, result: 0, polls: 0, delivered: 0, dropped: 0, lastAt: null }
      };
      rooms.set(code, state);
    }
    return state;
  };
  return {
    post({ room, from, kind, payload }) {
      if (!RELAY_ROOM.test(room ?? '')) throw new Error('invalid relay room');
      if (!RELAY_FROM.test(from ?? '')) throw new Error('invalid relay sender');
      if (!AI_RELAY_KINDS.has(kind)) throw new Error('AI relay kind must be roster, pose or result');
      const state = roomState(room);
      state.seq += 1;
      state.messages.push({ seq: state.seq, from, kind, payload, at: Date.now() });
      if (state.messages.length > AI_RELAY_ROOM_LIMIT) {
        const removed = state.messages.splice(0, state.messages.length - AI_RELAY_ROOM_LIMIT);
        state.stats.dropped += removed.length;
      }
      state.stats[kind] += 1;
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
  const aiRelay = createMpAiRelay();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    // Host→guest AI relay (M4): roster, 20 Hz poses and the final AI rows. It is
    // a project-specific ordered channel beside the unchanged room service; the
    // host page publishes, guests poll, and no client ever receives AI inputs or
    // runs an AI simulation.
    if (pathname === '/_mp-ai/relay' || pathname === '/_mp-ai/relay/stats') {
      try {
        if (pathname === '/_mp-ai/relay' && request.method === 'POST') {
          const body = await readJsonBody(request);
          const result = aiRelay.post(body ?? {});
          sendJson(response, 200, { ok: true, seq: result.seq });
          return;
        }
        if (pathname === '/_mp-ai/relay' && request.method === 'GET') {
          const result = aiRelay.poll({
            room: url.searchParams.get('room'),
            after: Number(url.searchParams.get('after') ?? 0),
            exclude: url.searchParams.get('exclude')
          });
          sendJson(response, 200, result);
          return;
        }
        if (pathname === '/_mp-ai/relay/stats' && request.method === 'GET') {
          sendJson(response, 200, aiRelay.stats(url.searchParams.get('room')));
          return;
        }
        sendJson(response, 405, { ok: false, error: 'method not allowed' });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }
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
    else if (pathname.startsWith('/_work/map-slice/')) file = safeJoin(MAP_SLICE_WORK, pathname.slice('/_work/map-slice/'.length));
    else if (pathname.startsWith('/map-data/')) file = safeJoin(MAP_DATA_LEVELS, pathname.slice('/map-data/'.length));
    else if (pathname.startsWith('/powerups/')) {
      const name = pathname.slice('/powerups/'.length);
      if (POWERUPS_RULE_FILES.has(name)) file = path.join(POWERUPS_RULES, name);
    }
    else if (pathname.startsWith('/ghosts/')) file = safeJoin(GHOSTS, pathname.slice('/ghosts/'.length));
    else if (pathname.startsWith('/prop-collision/')) file = safeJoin(PROP, pathname.slice('/prop-collision/'.length));
    else if (pathname.startsWith('/_work/prop-collision/')) file = safeJoin(PROP_WORK, pathname.slice('/_work/prop-collision/'.length));
    else if (pathname.startsWith('/_work/free-roam-prop/')) file = safeJoin(FREE_PROP_WORK, pathname.slice('/_work/free-roam-prop/'.length));
    else if (pathname.startsWith('/_work/map-props/')) file = safeJoin(MAP_PROPS_WORK, pathname.slice('/_work/map-props/'.length));
    else if (pathname.startsWith('/audio/')) file = safeJoin(AUDIO, pathname.slice('/audio/'.length));
    else if (pathname.startsWith('/_work/audio/')) file = safeJoin(AUDIO_WORK, pathname.slice('/_work/audio/'.length));
    else if (pathname.startsWith('/net-mvp/')) {
      const name = pathname.slice('/net-mvp/'.length);
      if (NET_MVP_MODULES.has(name)) file = path.join(NET_MVP, name);
    } else if (pathname.startsWith('/race-rules/')) {
      const relative = pathname.slice('/race-rules/'.length);
      if (relative.endsWith('.mjs')) file = safeJoin(RACE_RULES, relative);
    } else if (pathname.startsWith('/game-shell/')) {
      const relative = pathname.slice('/game-shell/'.length);
      if (relative.endsWith('.js') || relative.endsWith('.css') || relative.endsWith('.json')) {
        file = safeJoin(GAME_SHELL, relative);
      }
    } else if (pathname.startsWith('/map-laps/')) {
      const relative = pathname.slice('/map-laps/'.length);
      if (relative.endsWith('.json')) file = safeJoin(MAP_LAPS, relative);
    } else if (pathname.startsWith('/hud-ui/')) {
      const relative = pathname.slice('/hud-ui/'.length);
      if (relative.endsWith('.mjs') || relative.endsWith('.js')) file = safeJoin(HUD_UI, relative);
    } else if (pathname.startsWith('/lighting/')) {
      const relative = pathname.slice('/lighting/'.length);
      if (relative.endsWith('.mjs')) file = safeJoin(LIGHTING, relative);
    } else if (pathname.startsWith('/car-materials/')) {
      const relative = pathname.slice('/car-materials/'.length);
      if (relative.endsWith('.mjs')) file = safeJoin(CAR_MATERIALS, relative);
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
      resolve({ server, origin: 'http://127.0.0.1:' + actualPort, port: actualPort, relay, aiRelay });
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
