// Native WSS gate.
//
//   node probes/net-mvp/tls-test.mjs --pfx _work/net-mvp/tls/localhost.pfx --passphrase netmvp-test
//
// Starts the room service with native TLS (`https.Server` + the same WebSocket
// upgrade handler), fetches /healthz over https, then joins two real NetClients
// over wss:// and relays one state message. The test certificate is self-signed;
// this is a local transport gate, not a production trust-chain claim. The
// deployment bundle uses Caddy/nginx or a real cert/key.
//
// Evidence: _work/net-mvp/tls-report.json

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRoomServer } from './server.mjs';
import { NetClient } from './client.mjs';
import { waitEvent } from './scenario.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/net-mvp');
mkdirSync(OUT, { recursive: true });
const REPORT_FILE = path.join(OUT, 'tls-report.json');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const pfx = option('--pfx', path.join(OUT, 'tls', 'localhost.pfx'));
const cert = option('--cert', null);
const key = option('--key', null);
const passphrase = option('--passphrase', 'netmvp-test');
const insecure = !args.includes('--verify');

// The generated certificate is self-signed. Disable verification only in this
// test process; the browser/Node production path uses a real trust chain.
if (insecure) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  process.on('warning', () => {});
}

function httpsJson(url) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { rejectUnauthorized: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function main() {
  const startedAt = Date.now();
  if (!cert && !existsSync(pfx)) {
    const report = {
      schema: 'blur.net-mvp.tls/1',
      command: 'node probes/net-mvp/tls-test.mjs',
      startedAt: new Date(startedAt).toISOString(),
      passed: false,
      skipped: true,
      reason: 'no TLS material at ' + pfx + '; pass --pfx or --cert/--key'
    };
    writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
    console.error('SKIP net-mvp tls: ' + report.reason);
    return 2;
  }
  const tls = cert && key ? { cert, key } : { pfx, passphrase };
  const server = await startRoomServer({ port: 0, host: '127.0.0.1', tls });
  const clients = [];
  const checks = {};
  const errors = [];
  try {
    checks.scheme = server.wsUrl.startsWith('wss://') && server.origin.startsWith('https://');
    checks.tlsFlag = server.tls === true;
    const health = await httpsJson(server.origin + '/healthz');
    checks.health = health.status === 200 && health.json.status === 'ok';
    checks.healthTls = health.json.tls === true;
    checks.healthCapacity = health.json.limits?.defaultMaxPlayers === 8 && health.json.limits?.hardMaxPlayers === 20;

    const a = new NetClient({ url: server.wsUrl, name: 'TlsA', autoReconnect: false });
    const b = new NetClient({ url: server.wsUrl, name: 'TlsB', autoReconnect: false });
    clients.push(a, b);
    a.on('error', (error) => errors.push(error?.toJSON?.() ?? String(error)));
    b.on('error', (error) => errors.push(error?.toJSON?.() ?? String(error)));
    await Promise.all([a.connect(), b.connect()]);
    checks.wssConnected = a.connected && b.connected;
    const created = await a.createRoom({ name: 'TlsA', maxPlayers: 4, map: 'usa_la_river', car: 'corvette-zr1-stock' });
    await b.joinRoom({ code: created.room.code, name: 'TlsB', car: 'lotus-exige-cup260' });
    checks.join = created.room.players.length === 1 && b.room.players.length === 2;
    await a.setReady(true);
    await b.setReady(true);
    const guestStarted = waitEvent(b, 'started', 5000);
    const started = await a.start({ seed: 'tls-test-seed' });
    await guestStarted;
    checks.started = started.startTick === 1 && b.room.phase === 'running';
    a.sendState({ tick: 1, position: [0, 0.35, 0], quaternion: [0, 0, 0, 1], speed: 1 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    checks.relay = b.stats().received.state === 1;

    const report = {
      schema: 'blur.net-mvp.tls/1',
      command: 'node probes/net-mvp/tls-test.mjs ' + args.join(' '),
      startedAt: new Date(startedAt).toISOString(),
      elapsedMs: Date.now() - startedAt,
      server: { port: server.port, origin: server.origin, wsUrl: server.wsUrl },
      tlsMaterial: cert ? { mode: 'cert-key', cert, key } : { mode: 'pfx', pfx },
      certificateVerification: insecure ? 'disabled for self-signed local test' : 'enabled',
      health: { status: health.status, tls: health.json.tls, limits: health.json.limits },
      room: { code: created.room.code, players: 2, startTick: started.startTick },
      checks,
      errors,
      passed: Object.values(checks).every(Boolean) && errors.length === 0
    };
    writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
    console.log((report.passed ? 'PASS' : 'FAIL') + ' net-mvp tls · ' +
      Object.values(checks).filter(Boolean).length + '/' + Object.keys(checks).length +
      ' · ' + server.wsUrl.replace(/:\d+/, ':PORT'));
    if (!report.passed) {
      console.error('  failed: ' + Object.entries(checks).filter(([, value]) => !value).map(([name]) => name).join(', '));
    }
    return report.passed ? 0 : 1;
  } catch (error) {
    const report = {
      schema: 'blur.net-mvp.tls/1',
      command: 'node probes/net-mvp/tls-test.mjs ' + args.join(' '),
      startedAt: new Date(startedAt).toISOString(),
      elapsedMs: Date.now() - startedAt,
      checks,
      errors,
      passed: false,
      failure: { message: String(error?.stack || error), code: error?.code ?? null }
    };
    writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
    console.error('FAIL net-mvp tls: ' + (error?.message || error));
    return 1;
  } finally {
    for (const client of clients) client.close();
    await server.close({ drainMs: 50, save: false }).catch(() => {});
  }
}

process.exit(await main());
