// Minimal read-only static server for the retail-parity reference page.
//
// Serves only GET/HEAD, only under the repository root, and only for the path
// prefixes this probe needs. It never writes and never lists a directory.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const ALLOW = ['/probes/retail-parity/', '/probes/e1-drive/web/', '/_work/e1-drive/', '/_work/retail-parity/', '/_work/drivable-path/'];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8'
};

export function startServer({ port }) {
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405).end('method not allowed');
        return;
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
      if (!ALLOW.some((prefix) => pathname.startsWith(prefix))) {
        response.writeHead(403).end('path not allowed by the parity probe');
        return;
      }
      const file = resolve(join(ROOT, normalize(pathname)));
      if (!file.startsWith(ROOT + sep)) {
        response.writeHead(403).end('path escapes the repository');
        return;
      }
      const info = await stat(file);
      if (!info.isFile()) {
        response.writeHead(404).end('not a file');
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store'
      });
      if (request.method === 'HEAD') response.end();
      else response.end(body);
    } catch (error) {
      response.writeHead(error?.code === 'ENOENT' ? 404 : 500).end(String(error?.message ?? error));
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(port, '127.0.0.1', () => resolvePromise({ server, origin: `http://127.0.0.1:${port}` }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const port = Number(process.argv[2] ?? 8844);
  const { origin } = await startServer({ port });
  console.log('retail-parity server: ' + origin);
}
