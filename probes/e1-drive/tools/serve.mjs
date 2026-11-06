// Static server for the E1 drive slice.
//
// Serves exactly four trees, all read-only:
//   /                -> probes/e1-drive/web/            (the page)
//   /_work/e1-drive/ -> _work/e1-drive/                 (module, geometry, level, packet)
//   /ghosts/         -> probes/e1-drive/ghosts/         (committed reference ghost traces)
//   /prop-collision/ -> probes/prop-collision/          (read-only P66 resolver + lib)
//
// No directory listing, no writes, no path escapes. Callable as a module
// (`startServer({port})`) or directly (`node probes/e1-drive/tools/serve.mjs [--port 8801]`).

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

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.fields': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.levelphysics': 'application/octet-stream'
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
    else file = safeJoin(WEB, pathname.slice(1));

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
      resolve({ server, origin: 'http://127.0.0.1:' + port, port });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--port');
  const port = Number(index >= 0 ? args[index + 1] : 8801);
  const { origin } = await startServer({ port });
  console.log('E1 drive slice: ' + origin + '/?script=drive');
  console.log('manual keyboard drive: ' + origin + '/');
}
