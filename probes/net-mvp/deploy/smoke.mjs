// Remote smoke test for a deployed room service.
//
//   node probes/net-mvp/deploy/smoke.mjs --url wss://play.example.com/ws
//   node probes/net-mvp/deploy/smoke.mjs --url ws://127.0.0.1:8810/ws
//   node probes/net-mvp/deploy/smoke.mjs --url wss://play.example.com/ws --insecure
//
// Checks /healthz over the matching HTTP(S) origin, opens a real WebSocket,
// creates a room, verifies the roster/capacity, leaves (which deletes the empty
// room) and exits 0. It never reads or prints a resume token, env file or game
// data. `--insecure` disables certificate verification for a self-signed test
// host only; a public deployment should use a real certificate.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const url = option('--url', 'ws://127.0.0.1:8810/ws');
const timeoutMs = Number(option('--timeout', '10000'));
const insecure = args.includes('--insecure');

if (insecure) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  process.on('warning', () => {});
}

const { NetClient, NetError } = await import('../client.mjs');

function parseTarget(raw) {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('--url must start with ws:// or wss://');
  }
  const httpProtocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  const health = new URL(parsed.toString());
  health.protocol = httpProtocol;
  health.pathname = '/healthz';
  health.search = '';
  return { wsUrl: parsed.toString(), healthUrl: health.toString(), tls: parsed.protocol === 'wss:' };
}

function fetchJson(raw, timeout) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(raw);
    const request = (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(
      parsed,
      parsed.protocol === 'https:' ? { rejectUnauthorized: insecure ? false : true } : {},
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (error) {
            reject(new Error('health response is not JSON: ' + String(error?.message || error)));
          }
        });
      }
    );
    request.setTimeout(timeout, () => request.destroy(new Error('health request timed out')));
    request.on('error', reject);
    request.end();
  });
}

async function main() {
  const target = parseTarget(url);
  const startedAt = Date.now();
  const health = await fetchJson(target.healthUrl, timeoutMs);
  if (health.status !== 200 || health.json?.status !== 'ok') {
    throw new Error('health check failed: status ' + health.status + ' ' + JSON.stringify(health.json));
  }
  if (target.tls && health.json.tls !== true) {
    throw new Error('wss:// URL but health reports tls=false');
  }
  const net = new NetClient({ url: target.wsUrl, name: 'Smoke', autoReconnect: false });
  try {
    await net.connect();
    const created = await net.createRoom({ name: 'Smoke', maxPlayers: 4, map: 'usa_la_river', car: 'corvette-zr1-stock' });
    if (!created.room?.code || created.room.players.length !== 1) {
      throw new Error('room create returned an unexpected roster');
    }
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await net.leave();
    const stats = net.stats();
    console.log('PASS net-mvp remote smoke');
    console.log('  url:          ' + target.wsUrl);
    console.log('  health:       ' + health.json.status + ' · tls ' + health.json.tls +
      ' · rooms ' + health.json.rooms + ' · default players ' + health.json.limits?.defaultMaxPlayers);
    console.log('  room:         ' + created.room.code + ' · maxPlayers ' + created.room.maxPlayers);
    console.log('  control RTT:  ' + (stats.rtt.control.p50 === null ? 'n/a' : stats.rtt.control.p50.toFixed(1) + ' ms'));
    console.log('  elapsed:      ' + (Date.now() - startedAt) + ' ms');
    return 0;
  } finally {
    net.close();
  }
}

try {
  process.exit(await main());
} catch (error) {
  console.error('FAIL net-mvp remote smoke: ' +
    (error instanceof NetError ? JSON.stringify(error.toJSON()) : String(error?.stack || error)));
  process.exit(1);
}
