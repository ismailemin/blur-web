// Dependency-free reverse proxy used by the net-mvp tests and deployment docs.
//
// It forwards HTTP and RFC 6455 upgrades to a plain `ws://` room service,
// adds the standard proxy headers (X-Forwarded-For / X-Forwarded-Proto /
// X-Real-IP) and can blackhole every socket for N milliseconds. The stall is
// how the reconnect matrix simulates a mobile link that silently disappears:
// no FIN is delivered, so both ends must use their heartbeat timeout.
//
// This is a test/verification proxy, not a production TLS terminator. Caddy or
// nginx terminate TLS in the deployment bundle; this file proves that the room
// service's `--trust-proxy` IP handling works behind one.

import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';

function forwardedHeaders(request) {
  const headers = { ...request.headers };
  for (const name of [
    'connection', 'proxy-connection', 'proxy-authorization',
    'transfer-encoding', 'te', 'trailer', 'keep-alive'
  ]) delete headers[name];
  const remote = request.socket?.remoteAddress ?? '127.0.0.1';
  const existing = request.headers['x-forwarded-for'];
  headers['x-forwarded-for'] = existing ? String(existing) + ', ' + remote : remote;
  headers['x-forwarded-proto'] = 'http';
  headers['x-forwarded-host'] = request.headers.host ?? '';
  headers['x-real-ip'] = remote;
  return headers;
}

function rawRequestHead(request, headers) {
  const lines = [request.method + ' ' + request.url + ' HTTP/1.1'];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) lines.push(name + ': ' + item);
    else lines.push(name + ': ' + value);
  }
  return lines.join('\r\n') + '\r\n\r\n';
}

/**
 * Start a reverse proxy. `stall(ms)` pauses forwarding on every websocket; new
 * upgrades are rejected while stalled and all pre-stall sockets are destroyed
 * when the stall ends, which is a deterministic model of a mobile radio loss.
 */
export async function startReverseProxy({
  targetHost = '127.0.0.1',
  targetPort,
  host = '127.0.0.1',
  port = 0,
  addForwardedHeaders = true,
  log = () => {}
} = {}) {
  if (!Number.isInteger(targetPort) || targetPort <= 0) {
    throw new Error('targetPort is required');
  }

  const stats = {
    httpRequests: 0,
    upgrades: 0,
    rejectedDuringStall: 0,
    stalls: 0,
    stallStartedAt: null,
    stallEndedAt: null,
    droppedBytes: 0,
    bytesFromClient: 0,
    bytesFromServer: 0,
    forwardedHeaderCount: 0
  };

  const pairs = new Set();
  let stalled = false;
  let stallTimer = null;
  let resolveStall = null;

  function makePair(client, upstream) {
    const pair = { client, upstream, preStall: false };
    pairs.add(pair);
    const close = () => {
      if (!pairs.has(pair)) return;
      pairs.delete(pair);
      try { client.destroy(); } catch { /* noop */ }
      try { upstream.destroy(); } catch { /* noop */ }
    };
    client.on('close', close);
    client.on('error', close);
    upstream.on('close', close);
    upstream.on('error', close);
    return pair;
  }

  function killPair(pair) {
    pairs.delete(pair);
    try { pair.client.destroy(); } catch { /* noop */ }
    try { pair.upstream.destroy(); } catch { /* noop */ }
  }

  function stall(ms) {
    if (!(ms > 0)) return Promise.resolve({ ms: 0 });
    if (stallTimer) clearTimeout(stallTimer);
    stalled = true;
    stats.stalls++;
    stats.stallStartedAt = Date.now();
    for (const pair of pairs) pair.preStall = true;
    log({ event: 'proxy-stall-start', ms });
    return new Promise((resolve) => {
      resolveStall = resolve;
      stallTimer = setTimeout(() => {
        stallTimer = null;
        stalled = false;
        stats.stallEndedAt = Date.now();
        for (const pair of [...pairs]) {
          if (pair.preStall) killPair(pair);
        }
        log({ event: 'proxy-stall-end', ms, droppedBytes: stats.droppedBytes });
        const result = { startedAt: stats.stallStartedAt, endedAt: stats.stallEndedAt, ms };
        resolveStall?.(result);
        resolveStall = null;
      }, ms);
    });
  }

  const server = createServer((request, response) => {
    if (stalled) {
      const body = JSON.stringify({ type: 'error', code: 'NET_TIMEOUT', message: 'proxy is stalled' });
      response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
      response.end(body);
      return;
    }
    stats.httpRequests++;
    const headers = addForwardedHeaders ? forwardedHeaders(request) : { ...request.headers };
    if (addForwardedHeaders) stats.forwardedHeaderCount++;
    const upstream = requestToTarget(request, headers, response);
    if (!upstream) return;
  });

  function requestToTarget(request, headers, response) {
    const target = httpRequest({
      host: targetHost,
      port: targetPort,
      method: request.method,
      path: request.url,
      headers
    }, (upstreamResponse) => {
      stats.bytesFromServer += Number(upstreamResponse.headers['content-length'] ?? 0) || 0;
      response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    target.on('error', () => {
      try { response.writeHead(502, { connection: 'close' }); response.end('proxy upstream error'); } catch { /* noop */ }
    });
    request.on('error', () => target.destroy());
    response.on('close', () => target.destroy());
    request.pipe(target);
    return target;
  }

  server.on('upgrade', (request, socket, head) => {
    if (stalled) {
      stats.rejectedDuringStall++;
      try {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      } catch { /* noop */ }
      socket.destroy();
      return;
    }
    stats.upgrades++;
    const headers = addForwardedHeaders ? forwardedHeaders(request) : { ...request.headers };
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    if (addForwardedHeaders) stats.forwardedHeaderCount++;

    const upstream = connect(targetPort, targetHost, () => {
      upstream.write(rawRequestHead(request, headers));
      if (head && head.length) upstream.write(head);
    });
    const pair = makePair(socket, upstream);

    socket.on('data', (chunk) => {
      stats.bytesFromClient += chunk.length;
      if (stalled) { stats.droppedBytes += chunk.length; return; }
      upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      stats.bytesFromServer += chunk.length;
      if (stalled) { stats.droppedBytes += chunk.length; return; }
      socket.write(chunk);
    });
    socket.on('end', () => upstream.end());
    upstream.on('end', () => socket.end());
    socket.on('error', () => killPair(pair));
    upstream.on('error', () => killPair(pair));
  });

  server.on('clientError', (error, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* noop */ }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;

  async function close() {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
    stalled = false;
    for (const pair of [...pairs]) killPair(pair);
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return {
    server,
    port: actualPort,
    origin: 'http://' + host + ':' + actualPort,
    wsUrl: 'ws://' + host + ':' + actualPort + '/ws',
    stall,
    stats: () => ({ ...stats, stalled, activePairs: pairs.size }),
    close
  };
}
