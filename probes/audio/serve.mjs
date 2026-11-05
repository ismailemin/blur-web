// Read-only server for the engine-audio feasibility harness.
//
//   /                     -> probes/audio/harness/index.html
//   /harness.js           -> probes/audio/harness/harness.js
//   /_work/audio/<file>   -> _work/audio/<file>  (.wav/.json only)
//
// No directory listing, no writes, no path escapes. Callable as a module or:
//   node probes/audio/serve.mjs [--port 8810]

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HARNESS = path.join(ROOT, 'probes/audio/harness');
const AUDIO = path.join(ROOT, '_work/audio');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
};

function safeJoin(base, relative) {
  const resolved = path.resolve(base, '.' + path.posix.normalize('/' + relative));
  return resolved === base || resolved.startsWith(base + path.sep) ? resolved : null;
}

export function startServer({ port = 8810 } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    let file;

    if (pathname === '/' || pathname === '/index.html') {
      file = path.join(HARNESS, 'index.html');
    } else if (pathname === '/harness.js') {
      file = path.join(HARNESS, 'harness.js');
    } else if (pathname.startsWith('/_work/audio/')) {
      const relative = pathname.slice('/_work/audio/'.length);
      if (!/\.(wav|json)$/i.test(relative)) {
        response.writeHead(403).end('only .wav and .json');
        return;
      }
      file = safeJoin(AUDIO, relative);
    } else {
      response.writeHead(404).end('not found');
      return;
    }

    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end('not found');
      return;
    }
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    response.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'content-length': statSync(file).size,
    });
    createReadStream(file).pipe(response);
  });

  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    console.log(`audio harness: http://127.0.0.1:${address.port}/`);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--port');
  startServer({ port: index >= 0 ? Number(process.argv[index + 1]) : 8810 });
}
