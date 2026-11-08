// Tiny static server for the input-layer manual check.
//
//   node probes/input/serve.mjs --port 8812
//   open http://127.0.0.1:8812/
//
// Serves only probes/input/**. No directory listing, no writes, no path escape.
// It is intentionally separate from the e1 drive server: the manual page needs
// the Gamepad API and a real user gesture, while the e1 captures are headless.

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const PORT = Number(option('--port', 8812));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('bad --port');

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end('method not allowed');
    return;
  }
  const relative = decodeURIComponent(url.pathname === '/' ? '/manual.html' : url.pathname);
  const file = path.resolve(ROOT, '.' + relative);
  if (!file.startsWith(ROOT + path.sep) || file.includes(`${path.sep}..${path.sep}`)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  let stat;
  try {
    stat = statSync(file);
  } catch {
    response.writeHead(404).end('not found');
    return;
  }
  if (!stat.isFile()) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-store'
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`input manual check: http://127.0.0.1:${PORT}/`);
  console.log('open it with a physical controller, then follow the on-page steps');
});
