// Static server for the standalone game-shell demo.
//
//   node probes/game-shell/tools/serve-demo.mjs --port 8805
//   open http://127.0.0.1:8805/probes/game-shell/demo.html
//
// Serves the repository root read-only so the demo can import the real map
// registry and fetch the real roster. No writes, no directory listing, no path
// escapes. This is an agent-local server; it is not the e1-drive server and it
// never binds 8801.

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8805;
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('port must be an integer in [1024, 65535]');
}

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.wasm', 'application/wasm']
]);

function send(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(body);
}

const server = createServer((request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.writeHead(302, { location: '/probes/game-shell/demo.html', 'cache-control': 'no-store' });
      response.end();
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const resolved = path.resolve(ROOT, relative);
    if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
      send(response, 403, 'forbidden');
      return;
    }
    const stats = statSync(resolved);
    if (stats.isDirectory()) {
      send(response, 404, 'not found');
      return;
    }
    const type = TYPES.get(path.extname(resolved).toLowerCase()) ?? 'application/octet-stream';
    response.writeHead(200, {
      'content-type': type,
      'content-length': stats.size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    createReadStream(resolved).pipe(response);
  } catch {
    send(response, 404, 'not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write('game-shell demo: http://127.0.0.1:' + port + '/probes/game-shell/demo.html\n');
});
