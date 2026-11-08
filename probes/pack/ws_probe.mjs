// Minimal WebSocket room-service smoke probe (Node 18+ global WebSocket).
//
// Usage: node probes/pack/ws_probe.mjs ws://127.0.0.1:8811/ws [--timeout 10000]
//
// Connects, waits for the welcome frame, creates a room and prints one JSON
// line: {ok, code, players, protocol, ms}. Exit 0 only when room.created is
// observed; any timeout or error is exit 1 with a typed `code`.

const url = process.argv[2];
if (!url || !/^wss?:\/\//.test(url)) {
  console.error('usage: node ws_probe.mjs ws://host:port/ws');
  process.exit(2);
}
const timeoutIndex = process.argv.indexOf('--timeout');
const timeoutMs = timeoutIndex >= 0 ? Number(process.argv[timeoutIndex + 1]) : 10000;
const started = Date.now();

if (typeof WebSocket !== 'function') {
  console.log(JSON.stringify({ ok: false, code: 'WS_GLOBAL_MISSING' }));
  process.exit(1);
}

const ws = new WebSocket(url);
let settled = false;
const timer = setTimeout(() => finish({ ok: false, code: 'WS_TIMEOUT' }), timeoutMs);

function finish(result) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  console.log(JSON.stringify({ ...result, ms: Date.now() - started }));
  try { ws.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(result.ok ? 0 : 1), 20);
}

ws.addEventListener('error', () => finish({ ok: false, code: 'WS_ERROR' }));
ws.addEventListener('message', (event) => {
  let message;
  try {
    message = JSON.parse(String(event.data));
  } catch {
    finish({ ok: false, code: 'WS_BAD_JSON' });
    return;
  }
  if (message.type === 'welcome') {
    ws.send(JSON.stringify({
      type: 'room.create',
      name: 'pack-test',
      maxPlayers: 2,
      map: 'usa_la_river',
      car: 'corvette-zr1-stock'
    }));
    return;
  }
  if (message.type === 'error') {
    finish({ ok: false, code: 'WS_ROOM_ERROR', error: message.code || message.message });
    return;
  }
  if (message.type === 'room.created') {
    finish({
      ok: true,
      code: message.room?.code ?? null,
      players: message.room?.players?.length ?? null,
      protocol: message.room?.tickHz ?? null
    });
  }
});
