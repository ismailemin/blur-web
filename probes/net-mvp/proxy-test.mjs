// Reverse-proxy assumption gate.
//
//   node probes/net-mvp/proxy-test.mjs
//
// Proves that the room service behind a plain HTTP/WS reverse proxy:
//   * serves /healthz over the proxied HTTP path;
//   * honours X-Forwarded-For when `trustProxy:true` (source is reported, the
//     raw IP is never put in the report, only a 12-hex hash);
//   * upgrades a real WebSocket through the proxy and runs a two-client room.
//
// This is the same assumption Caddy/nginx/Cloudflare Tunnel make in deploy/.
// Evidence: _work/net-mvp/proxy-report.json

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRoomServer } from './server.mjs';
import { startReverseProxy } from './proxy.mjs';
import { NetClient } from './client.mjs';
import { waitEvent } from './scenario.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '_work/net-mvp');
mkdirSync(OUT, { recursive: true });
const REPORT_FILE = path.join(OUT, 'proxy-report.json');

async function main() {
  const server = await startRoomServer({ port: 0, trustProxy: true });
  const proxy = await startReverseProxy({ targetPort: server.port });
  const clients = [];
  const checks = {};
  const startedAt = Date.now();
  try {
    const healthResponse = await fetch(proxy.origin + '/healthz');
    const health = await healthResponse.json();
    checks.healthStatus = healthResponse.status === 200 && health.status === 'ok';
    checks.trustProxy = health.proxy?.trusted === true;
    checks.forwardedForSource = health.proxy?.source === 'x-forwarded-for';
    checks.ipHash = typeof health.proxy?.clientIpHash === 'string' && /^[0-9a-f]{12}$/.test(health.proxy.clientIpHash);
    checks.capacityDefaults = health.limits?.defaultMaxPlayers === 8 && health.limits?.hardMaxPlayers === 20;

    const directResponse = await fetch(server.origin + '/healthz');
    const direct = await directResponse.json();
    checks.directSource = direct.proxy?.source === 'socket';

    const a = new NetClient({ url: proxy.wsUrl, name: 'ProxyA', autoReconnect: false });
    const b = new NetClient({ url: proxy.wsUrl, name: 'ProxyB', autoReconnect: false });
    clients.push(a, b);
    await Promise.all(clients.map((client) => client.connect()));
    const created = await a.createRoom({ name: 'ProxyA', maxPlayers: 4, map: 'usa_la_river', car: 'corvette-zr1-stock' });
    await b.joinRoom({ code: created.room.code, name: 'ProxyB', car: 'lotus-exige-cup260' });
    checks.websocketThroughProxy = b.room.players.length === 2 && b.room.code === created.room.code;
    checks.hostThroughProxy = b.hostId === a.playerId;
    await a.setReady(true);
    await b.setReady(true);
    const guestStarted = waitEvent(b, 'started', 5000);
    const started = await a.start({ seed: 'proxy-test-seed' });
    await guestStarted;
    checks.startThroughProxy = started.startTick === 1 && b.room.phase === 'running';
    a.sendState({ tick: 1, position: [0, 0.35, 0], quaternion: [0, 0, 0, 1], speed: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    checks.relayThroughProxy = b.stats().received.state === 1;
    await a.leave();
    await b.leave();

    const proxyStats = proxy.stats();
    checks.proxyUpgrades = proxyStats.upgrades >= 2;
    checks.forwardedHeaders = proxyStats.forwardedHeaderCount >= 2;

    const report = {
      schema: 'blur.net-mvp.proxy/1',
      command: 'node probes/net-mvp/proxy-test.mjs',
      startedAt: new Date(startedAt).toISOString(),
      elapsedMs: Date.now() - startedAt,
      server: { port: server.port, origin: server.origin, trustProxy: true },
      proxy: { port: proxy.port, origin: proxy.origin, stats: proxyStats },
      health: {
        status: health.status,
        source: health.proxy?.source ?? null,
        clientIpHash: health.proxy?.clientIpHash ?? null,
        limits: health.limits
      },
      room: { code: created.room.code, players: 2, startTick: started.startTick },
      checks,
      passed: Object.values(checks).every(Boolean)
    };
    writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
    console.log((report.passed ? 'PASS' : 'FAIL') + ' net-mvp proxy · ' +
      Object.values(checks).filter(Boolean).length + '/' + Object.keys(checks).length +
      ' · source ' + health.proxy?.source + ' · upgrades ' + proxyStats.upgrades);
    if (!report.passed) {
      console.error('  failed: ' + Object.entries(checks).filter(([, value]) => !value).map(([name]) => name).join(', '));
    }
    return report.passed ? 0 : 1;
  } catch (error) {
    const report = {
      schema: 'blur.net-mvp.proxy/1',
      command: 'node probes/net-mvp/proxy-test.mjs',
      startedAt: new Date(startedAt).toISOString(),
      elapsedMs: Date.now() - startedAt,
      checks,
      passed: false,
      failure: { message: String(error?.stack || error), code: error?.code ?? null }
    };
    writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n');
    console.error('FAIL net-mvp proxy: ' + (error?.message || error));
    return 1;
  } finally {
    for (const client of clients) client.close();
    await proxy.close().catch(() => {});
    await server.close({ drainMs: 50 }).catch(() => {});
  }
}

process.exit(await main());
