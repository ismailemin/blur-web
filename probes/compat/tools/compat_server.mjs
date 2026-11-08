// Read-only test server for the browser capability probe.
//
// Two jobs, both read-only with respect to the repository:
//   1. Serve probes/compat/* (the capability page, the requirement model, the
//      committed wasm feature probes) at /compat/*.
//   2. Proxy every other path to the unmodified E1 page server
//      (probes/e1-drive/tools/serve.mjs, started separately on 127.0.0.1:8810).
//      Proxying lets the same page be opened from 127.0.0.1 (a secure context)
//      and from the machine's LAN address (not a secure context) without
//      touching tools/ or probes/e1-drive/.
//
// It also answers one WebSocket handshake at /compat/echo so the capability
// page can prove a real socket connection, not just the constructor.
//
// Usage: node probes/compat/tools/compat_server.mjs [--port 8812] [--upstream http://127.0.0.1:8810]

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const COMPAT_ROOT = path.resolve(HERE, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png'
};

function compatFile(pathname) {
  if (pathname === '/compat' || pathname === '/compat/') return path.join(COMPAT_ROOT, 'web', 'capability.html');
  const rel = pathname.slice('/compat/'.length);
  const candidates = [
    path.join(COMPAT_ROOT, 'web', rel),
    path.join(COMPAT_ROOT, 'reference', rel)
  ];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(COMPAT_ROOT)) return null;
    if (existsSync(resolved) && statSync(resolved).isFile()) return resolved;
  }
  return null;
}

export function lanAddresses() {
  const out = [];
  for (const [name, records] of Object.entries(networkInterfaces())) {
    for (const record of records || []) {
      if (record.family === 'IPv4' && !record.internal) out.push({ name, address: record.address });
    }
  }
  return out;
}

function websocketAccept(key) {
  return createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

export function startCompatServer({ port = 8812, upstream = 'http://127.0.0.1:8810', host = '0.0.0.0' } = {}) {
  const upstreamUrl = new URL(upstream);
  const sockets = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://placeholder');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/compat/')) {
      const file = compatFile(pathname);
      if (!file) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('compat file not found: ' + pathname);
        return;
      }
      response.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      createReadStream(file).pipe(response);
      return;
    }

    // Everything else is the real E1 page, proxied unchanged.
    const headers = { ...request.headers, host: upstreamUrl.host };
    const forwarded = httpRequest({
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port,
      method: request.method,
      path: request.url,
      headers
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    forwarded.on('error', (error) => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('upstream ' + upstream + ' error: ' + error.message);
    });
    request.pipe(forwarded);
  });

  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const url = new URL(request.url, 'http://placeholder');
    if (url.pathname !== '/compat/echo') {
      socket.write('HTTP/1.1 501 Not Implemented\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + websocketAccept(key),
      '', ''
    ].join('\r\n'));
    // One unmasked text frame: FIN + opcode 1, length 12, "compat-echo".
    const payload = Buffer.from('compat-echo', 'utf8');
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        host,
        origin: 'http://127.0.0.1:' + actualPort,
        lanOrigins: lanAddresses().map((record) => 'http://' + record.address + ':' + actualPort),
        close: () => new Promise((done) => {
          for (const socket of sockets) { try { socket.destroy(); } catch {} }
          sockets.clear();
          try { server.closeAllConnections?.(); } catch {}
          server.close(done);
        })
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--port');
  const upstreamIndex = args.indexOf('--upstream');
  const started = await startCompatServer({
    port: portIndex >= 0 ? Number(args[portIndex + 1]) : 8812,
    upstream: upstreamIndex >= 0 ? args[upstreamIndex + 1] : 'http://127.0.0.1:8810'
  });
  console.log('compat probe  ->  ' + started.origin + '/compat/capability.html');
  for (const origin of started.lanOrigins) console.log('LAN (insecure) ->  ' + origin + '/compat/capability.html');
}
