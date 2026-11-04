// Loopback static server for the render-packet spike.
//
// Two roots only:
//   /          -> probes/render-packet/web
//   /packet/   -> _work/render-packet   (generated packet output)
//
// No game data, no PAK ranges and no shell access are served.

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WEB_ROOT = path.join(ROOT, 'probes/render-packet/web');
const PACKET_ROOT = path.join(ROOT, '_work/render-packet');

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
}));

function resolveRequest(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  if (clean.includes('\0')) return null;
  if (clean === '/' || clean === '') return path.join(WEB_ROOT, 'index.html');
  if (clean.startsWith('/packet/')) {
    const relative = path.normalize(clean.slice('/packet/'.length)).replace(/^([/\\])+/, '');
    if (relative.includes('..')) return null;
    return path.join(PACKET_ROOT, relative);
  }
  const relative = path.normalize(clean).replace(/^([/\\])+/, '');
  if (relative.includes('..')) return null;
  return path.join(WEB_ROOT, relative);
}

export function startServer({ host = '127.0.0.1', port = 8791 } = {}) {
  const server = createServer((request, response) => {
    const target = resolveRequest(request.url ?? '/');
    if (!target || !existsSync(target) || !statSync(target).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found\n');
      return;
    }
    response.writeHead(200, {
      'content-type': TYPES.get(path.extname(target).toLowerCase()) ?? 'application/octet-stream',
      'cache-control': 'no-store'
    });
    createReadStream(target).pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, origin: `http://${host}:${port}` }));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8791);
  const { origin } = await startServer({ port });
  console.log('serving ' + path.relative(ROOT, WEB_ROOT).split(path.sep).join('/') + ' and _work/render-packet at ' + origin);
}
