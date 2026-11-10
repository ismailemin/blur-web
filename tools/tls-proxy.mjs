// TLS reverse proxy for the Blur Web page and the WebSocket room service.
//
// It is the local stand-in for the production Caddy/nginx config in `deploy/`:
// the same two routes, the same TLS termination, so the internet path can be
// proven before a VPS exists.
//
//   https://<host>:8443/      -> http://127.0.0.1:8801/   (the page)
//   wss://<host>:8443/ws      -> ws://127.0.0.1:8811/ws    (the room service)
//
// The certificate is a local development certificate (see
// `tools/deploy_local.ps1`); it is never a production certificate.
//
// Usage:
//   node tools/tls-proxy.mjs --pfx deploy/local-dev.pfx --passphrase blur
//
// Options:
//   --port 8443          listen port
//   --page 127.0.0.1:8801 upstream page origin
//   --room 127.0.0.1:8811 upstream room origin
//   --pfx <file>          PKCS#12 certificate + key
//   --passphrase <text>   PKCS#12 passphrase
//   --cert <file> --key <file>  PEM certificate + key instead of a PFX
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const PORT = Number(option('--port', '8443'));
const PAGE = option('--page', '127.0.0.1:8801');
const ROOM = option('--room', '127.0.0.1:8811');
const PFX = option('--pfx', 'deploy/local-dev.pfx');
const PASSPHRASE = option('--passphrase', 'blur');
const CERT = option('--cert', null);
const KEY = option('--key', null);

const tlsOptions = CERT && KEY
  ? { cert: readFileSync(path.resolve(CERT)), key: readFileSync(path.resolve(KEY)) }
  : { pfx: readFileSync(path.resolve(PFX)), passphrase: PASSPHRASE };

const [pageHost, pagePort] = PAGE.split(':');
const [roomHost, roomPort] = ROOM.split(':');

const server = createHttpsServer(tlsOptions, (req, res) => {
  const upstream = httpRequest({
    host: pageHost,
    port: Number(pagePort),
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: PAGE, 'x-forwarded-proto': 'https' }
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('upstream page error: ' + error.message);
  });
  req.pipe(upstream);
});

// WebSocket upgrade: `/ws` goes to the room service, everything else is refused.
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const upstream = netConnect(Number(roomPort), roomHost, () => {
    const headers = Object.entries(req.headers)
      .filter(([name]) => name.toLowerCase() !== 'host')
      .map(([name, value]) => name + ': ' + value)
      .join('\r\n');
    upstream.write(req.method + ' ' + req.url + ' HTTP/1.1\r\n' +
      'Host: ' + ROOM + '\r\n' + headers + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => {
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    socket.destroy();
  });
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('tls proxy: https://localhost:' + PORT + '/  ->  http://' + PAGE + '/');
  console.log('tls proxy: wss://localhost:' + PORT + '/ws  ->  ws://' + ROOM + '/ws');
  console.log('tls proxy: certificate ' + (CERT ? CERT + ' + ' + KEY : PFX) +
    ' (local development certificate, not a production one)');
});

// A tiny health endpoint on plain HTTP keeps the launcher's readiness check
// independent of the certificate trust store.
const health = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('tls-proxy-ok');
});
health.listen(PORT + 1, '127.0.0.1');
