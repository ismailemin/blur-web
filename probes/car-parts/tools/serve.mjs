// Static server for the car-part manifest probe.
//
// Serves exactly two read-only trees:
//   /                  -> probes/car-parts/web/
//   /_work/car-parts/  -> _work/car-parts/
//
// No directory listing, no writes, no path escapes. Callable as a module
// (`startServer({port})`) or directly (`node probes/car-parts/tools/serve.mjs`).

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WEB = path.join(ROOT, 'probes/car-parts/web');
const WORK = path.join(ROOT, '_work/car-parts');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function safeJoin(base, relative) {
  const resolved = path.resolve(base, '.' + path.posix.normalize('/' + relative));
  return resolved === base || resolved.startsWith(base + path.sep) ? resolved : null;
}

export function startServer({ port = 8806 } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    let file;
    if (pathname === '/' || pathname === '/index.html') file = path.join(WEB, 'index.html');
    else if (pathname.startsWith('/_work/car-parts/')) file = safeJoin(WORK, pathname.slice('/_work/car-parts/'.length));
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
  const port = Number(index >= 0 ? args[index + 1] : 8806);
  const { origin } = await startServer({ port });
  console.log('car-part probe: ' + origin + '/');
}
