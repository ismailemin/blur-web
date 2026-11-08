# net-mvp — room service for localhost, LAN and internet play

Dependency-free room service and state-sync harness for the project's
multiplayer transport. It is an original project protocol; it is not a retail
Blur protocol, does not carry game assets and is not integrated into `e1-drive`.

Scope labels: `engineIntegration:false`, `retailProtocol:false`,
`webrtc:false`, `turn:false`, `accounts:false`, `database:false`,
`gameAssets:none`, `gameImplemented:false`, `tls:'native-or-reverse-proxy'`,
`wss:true`, `defaultMaxPlayers:8`, `hardMaxPlayers:20`,
`statePersistence:'optional-json'`.

## What runs

```text
Node 22+ (global WebSocket, fetch, TextEncoder)      Edge headless
┌──────────────────────────────────────────┐        ┌──────────────────────┐
│ server.mjs                               │        │ index.html           │
│  HTTP static (probes/net-mvp/web)        │◄──────►│  iframe Host  ──────┐│
│  RFC 6455 WebSocket /ws                  │  ws    │  iframe Guest ──────┤│
│  rooms, roster, ready/start, relay,      │        │  visible readout     ││
│  heartbeat, resume token                 │        └──────────────────────┘
└──────────────────────────────────────────┘
        ▲              ▲              ▲
        │              │              │
   harness.mjs     client.mjs      selftest.mjs
   2–4 Node clients  shared library  fast unit + negative paths
```

`client.mjs` is an ES module with no Node imports. It runs unchanged in Node and
in the browser. Hashing is a local SHA-256 implementation so the browser never
needs `node:crypto` or a secure context.

## Commands

Use the bundled Python only if a different tool needs it; these commands need
only Node.

```powershell
# Fast unit + typed-error paths (24 checks)
node probes/net-mvp/selftest.mjs

# 2–20 Node clients, 30 s, 1% loss + 80 ms latency on one state channel,
# one forced disconnect/resume, final-hash and sequence gate (21 checks)
node probes/net-mvp/harness.mjs

# Capacity/bandwidth: 4, 6 and 8 clients in one room (10 s each)
node probes/net-mvp/capacity.mjs

# Reconnect matrix: forced drop, 5 s stall, 15 s stall through a proxy
node probes/net-mvp/reconnect-matrix.mjs

# Safety/policy gate: capacity, full room, join limit, message cap,
# idle reaping, room cap, state-file restart
node probes/net-mvp/limits.mjs

# Reverse-proxy assumption: /healthz headers + a real WS through a proxy
node probes/net-mvp/proxy-test.mjs

# Native wss:// (self-signed local test material in _work, ignored by Git)
node probes/net-mvp/tls-test.mjs --pfx _work/net-mvp/tls/localhost.pfx --passphrase netmvp-test

# 8-client 5-minute soak
node probes/net-mvp/soak.mjs

# Two browser iframes, 30 s, headless Edge, screenshots + console gate
node probes/net-mvp/capture.mjs

# Manual server on port 8810 (LAN only unless TLS/proxy is in front)
node probes/net-mvp/server.mjs --port 8810
# then open http://127.0.0.1:8810/
# health: http://127.0.0.1:8810/healthz
```

Internet deployment is in [`deploy/`](deploy/): Docker/systemd, Caddy/nginx,
Cloudflare Tunnel and a remote smoke test. No `npm install`, no database, no
game-data file is read.

## Protocol (v1, JSON text frames)

Every message has `type`. Requests add `requestId`; the reply echoes it. An
error reply is

```json
{ "type": "error", "code": "NET_NOT_HOST", "message": "...", "detail": null,
  "requestId": "rq_3", "fatal": false }
```

### Client → server

| type | fields | purpose |
|---|---|---|
| `ping` | `id,t` | app heartbeat / control RTT |
| `room.create` | `name,maxPlayers,map,car` | create room, become host |
| `room.join` | `code,name,car?,resumeToken?` | join or resume |
| `room.leave` | — | explicit leave |
| `player.ready` | `ready` | lobby ready flag |
| `player.select` | `car?,map?` | car any player; map host only |
| `room.start` | `seed?` | host starts when all connected ready |
| `input` | `channel:'input',seq,tick,input` | 60 Hz controls |
| `state` | `channel:'state',seq,tick,state` | 20 Hz snapshot |
| `ack` | `channel,to,seq,sentAt` | applied up to `seq` |
| `resync` | `channel,to,fromSeq` | replay from a bounded cache |
| `stream.final` | `channel,lastSeq,tick` | broadcast final target |
| `stream.error` | `channel,to,code,detail` | sender cannot fulfil resync |
| `client.finished` | `tick,hash` | final-tick result |

### Server → client

| type | fields | purpose |
|---|---|---|
| `welcome` | `protocol,schema,connectionId,heartbeatMs,resumeWindowMs` | first frame |
| `room.created` / `room.joined` | `room,you,resumed?` | request result |
| `room.state` | `room` | roster/host/phase refresh |
| `room.started` | `room,startTick,seed,tickHz` | shared start identity |
| `room.finished` | `room,results` | all clients reported |
| `state` / `input` | `from,channel,seq,tick,sentAt,authority,state?/input?` | relay |
| `ack` / `resync` / `stream.final` / `stream.error` | targeted or broadcast | sync control |
| `player.joined/resumed/disconnected/left/finished` | ids | roster events |
| `heartbeat` / `pong` | `serverTime` | liveness |
| `server.shutdown` | `reason,resumeWindowMs,serverTime` | graceful drain; close code 1012 |
| `ok` | `requestId,action` | mutation accepted |
| `error` | see above | typed rejection |

`GET /healthz` (and `/readyz`) returns the health schema without secrets:

```json
{ "schema":"blur.net-mvp.health/1", "status":"ok", "uptimeMs":1234,
  "tls":false, "rooms":1, "sessions":2, "connections":2,
  "limits":{ "defaultMaxPlayers":8, "hardMaxPlayers":20, "maxRooms":64,
             "maxMessageBytes":65536, "resumeWindowMs":30000, ... },
  "proxy":{ "trusted":true, "source":"x-forwarded-for", "clientIpHash":"…" } }
```

During shutdown it answers `503` with `status:"shutting-down"`; new upgrades
get an HTTP `503` with `X-Net-Error: NET_SHUTDOWN`.

Room snapshot:

```json
{ "code":"ABCDE", "phase":"lobby|running|finished", "hostId":"pl_…",
  "map":"usa_la_river", "maxPlayers":4, "seed":"…", "startTick":1, "tickHz":60,
  "players":[ { "id":"pl_…", "slot":1, "name":"Host", "car":"…",
                "ready":true, "connected":true, "host":true, "resumedCount":0 } ] }
```

`you` also contains the secret `resumeToken` (24 random bytes, hex). It is
never included in another player's view or in `room.state`.

## Room / join / start flow

1. Client connects to `/ws`; server sends `welcome` with protocol/schema.
2. `room.create` allocates a 5-character code from a 32-character unambiguous
   alphabet, makes the creator host, slot 1, and returns `room.created`.
3. `room.join` (lobby only) adds a player to the lowest free slot; the server
   counts **reserved** seats (a disconnected player keeps its seat for 30 s), so
   a join cannot oversubscribe `maxPlayers`. A full room is `NET_ROOM_FULL`.
4. Host/guest call `player.ready`; when every connected player is ready,
   `room.start` (host only) assigns a seed (or the requested test seed), sets
   `phase:'running'`, `startTick:1`, and broadcasts `room.started`.
5. Clients send `input` at 60 Hz and `state` at 20 Hz. The server relays to every
   other connected player; the sender's `authority` flag is true only for the
   host. The server does not echo to the sender.
6. Receiver applies only `seq == last+1`; a gap is buffered but not applied, and
   a `resync` request asks the sender to replay from its bounded cache. Every
   applied message is acked.
7. At the final tick each client broadcasts `stream.final`, waits until every
   sender's target is applied, builds the final table, hashes it, and sends
   `client.finished`. When every connected player has reported, the server
   broadcasts `room.finished`.
8. On socket loss the player is marked `connected:false` but retained for 30 s.
   `room.join` with `resumeToken` restores the same player id, slot, host role
   and ready/car state; the application sequence numbers continue.
9. After the resume window the player is removed; if the host expired, the
   earliest connected slot is promoted and `room.state` is broadcast.
10. A room with no activity for `idleRoomMs` (5 min default) is reaped with a
    typed `NET_ROOM_IDLE` error, and a room older than `roomTtlMs` (2 h) with
    `NET_ROOM_EXPIRED`. An empty room is deleted after 60 s.

### Capacity

`room.create` accepts `maxPlayers` from **2 to 20**; omitted means the server
default (**8**). A value outside the range is `NET_CAPACITY` with
`detail:{requested,min,max}`. The hard maximum exists because the relay is a
full mesh: each snapshot is sent to every other player. It is never silently
clamped.

## State shape and hashing

Snapshots use the existing E1 state shape, quantized to 1e-6:

```json
{ "tick":1800, "position":[-19,0.35,4.8],
  "quaternion":[0,-0.045453,0,0.998966], "speed":22.6 }
```

Inputs are `{throttle,brake,steer,handbrake}` in `[-1,1]`, quantized to 1e-4.

The final hash is canonical JSON → SHA-256 over:

```text
{ kind:"blur.net-mvp.final", version:1, seed, tick,
  players:[ {slot,car,tick,position,quaternion,speed} ] }   (sorted by slot)
```

It deliberately excludes the random room code, random player id and sequence
number, so two clean runs with the same seed produce the same hash. Sequence
convergence is verified separately.

## Client API (what `e1-drive` will consume)

```js
// The probe serves the module at /client.mjs. The final import specifier is
// integration-owned (copy or serve the file from the e1-drive web tree).
import { NetClient, NetError } from '/client.mjs';

const net = new NetClient({
  url: 'ws://127.0.0.1:8810/ws',
  name: 'Player',
  autoReconnect: true,
  // optional test-only: { lossRate: 0.01, latencyMs: 80, seed: 123 }
});

const welcome = await net.connect();                 // {protocol,schema,...}

// Host:
const { room, you } = await net.createRoom({
  name: 'Host', maxPlayers: 4, map: 'usa_la_river', car: 'corvette-zr1-stock'
});
// Guest:
const joined = await net.joinRoom({ code: 'ABCDE', name: 'Guest', car: 'lotus-exige-cup260' });
// Resume (the reconnect path uses this automatically):
// await net.joinRoom({ code, name, resumeToken });

await net.setReady(true);
await net.select({ car: 'audi-r8v10-stock' });       // map: host only
const started = await net.start({ seed: 'optional-test-seed' });

net.on('room', ({ room, you, resumed }) => { /* roster, host, ready, phase */ });
net.on('started', ({ startTick, seed, tickHz }) => { /* begin fixed-step */ });
net.on('stateApplied', ({ from, seq, tick, state, authority }) => { /* remote car */ });
net.on('inputApplied', ({ from, seq, tick, input }) => { /* remote controls */ });
net.on('finished', ({ room, results }) => { /* final tick reached */ });
net.on('resumed', ({ room, you }) => { /* same player id restored */ });
net.on('error', (netError) => { /* all errors are typed NetError */ });

// Per fixed step (60 Hz):
net.sendInput({ throttle: 1, brake: 0, steer: 0.1, handbrake: 0 }, tick);
// Per state step (20 Hz):
net.sendState({ tick, position: [x, y, z], quaternion: [x, y, z, w], speed });

// Interpolated remote view; never extrapolates, clamps outside the buffer:
const view = net.sampleRemote(remotePlayerId, renderTick);
const latest = net.latestRemote(remotePlayerId);

// Bounded correction (maxPositionSpeed m/s, maxAngularSpeed rad/s):
const corrector = net.correctorFor(remotePlayerId, { maxPositionSpeed: 2.5, maxAngularSpeed: 2 });
const step = corrector.correct(latest.state, dt);

// Finish:
net.finalizeStreams();
await net.waitForStreams(10000);
const table = net.buildFinalTable(1800);
await net.reportFinished({ tick: 1800, hash });

net.stats();   // sent/received/applied, streams, duplicates, RTT, impairment,
               // reconnect counters, final targets
net.close();
```

Typed errors use `error.code`, for example `NET_ROOM_NOT_FOUND`,
`NET_ROOM_FULL`, `NET_ROOM_STARTED`, `NET_NOT_HOST`, `NET_NOT_READY`,
`NET_RESUME_UNKNOWN`, `NET_RESUME_IN_USE`, `NET_NOT_CONNECTED`, `NET_TIMEOUT`,
`NET_RATE_LIMIT`, `NET_BUFFER_OVERFLOW`, `NET_RESYNC_RANGE`,
`NET_FINAL_MISSING`, plus the internet/safety codes `NET_CAPACITY`,
`NET_JOIN_RATE_LIMIT`, `NET_CREATE_RATE_LIMIT`, `NET_ROOM_IDLE`,
`NET_ROOM_EXPIRED`, `NET_MESSAGE_TOO_LARGE`, `NET_BINARY_UNSUPPORTED`,
`NET_SHUTDOWN`. A malformed relay, unknown message, oversized frame or overflow
is an error, never a silent drop.

## Harness checks

`harness.mjs` (default 4 clients; `--players` accepts 2–20) asserts:

* room create/join/start/finish with the expected host and slots;
* every receiver applied every other sender's state and input exactly once,
  with `lastApplied == appliedSeqCount` and 0 violations;
* every applied state/input equals the deterministic expected value for that
  sender's slot/car/tick;
* the forced drop resumed the same player id, host stayed stable, and the room
  still has the same number of players;
* at least one state packet was dropped by the 1% impairment and the 80 ms
  channel is visible in state RTT;
* exactly the expected state/input messages per client (20/60 Hz), heartbeat
  and ack samples exist, and the room phase reaches `finished`;
* all clients produce the same final-tick hash and no async/listener/send
  error occurred.

`capacity.mjs` adds the 4/6/8-client fan-out and byte-rate measurements.
`reconnect-matrix.mjs` adds a forced drop, a 5 s stall and a 15 s stall through
a real reverse proxy (same player, no duplicate, inside the 30 s window).
`limits.mjs` covers typed safety rejections and a state-file restart.
`proxy-test.mjs` proves `/healthz` header/IP handling and a WebSocket through a
plain proxy. `soak.mjs` runs an 8-client 5-minute race.

## Layout

```text
probes/net-mvp/
  server.mjs       HTTP/HTTPS + RFC 6455 WebSocket + room service
                   + health, TLS, reverse-proxy IPs, state file, graceful drain
  client.mjs       NetClient, OrderedStream, InterpolationBuffer,
                   BoundedCorrector, LossLatencyImpairment, reconnect policy
  protocol.mjs     constants, validation, NetError, quantization, capacity
  hash.mjs         dependency-free SHA-256 + canonical JSON
  race.mjs         deterministic synthetic state/input/final hash
  harness.mjs      2–20 client transport gate
  scenario.mjs     shared headless drivers/reporters
  capacity.mjs     4/6/8-client fan-out + bandwidth model
  reconnect-matrix.mjs  forced drop / 5 s / 15 s stall timings
  limits.mjs       capacity, rate, size, idle, shutdown/state-file gate
  proxy.mjs        dependency-free HTTP/WS reverse proxy + stall control
  proxy-test.mjs   reverse-proxy header/IP/WS assumption
  tls-test.mjs     native wss:// end-to-end (self-signed local cert)
  soak.mjs         8-client 5-minute soak
  selftest.mjs     fast unit + typed-error/negative paths (24)
  capture.mjs      headless Edge two-iframe capture
  deploy/          Docker, Compose, systemd, Caddy, nginx, cloudflared, smoke
  web/             parent page, two client iframes, visible readout
```

## Evidence

Written under `_work/` (ignored by Git):

```text
_work/net-mvp/selftest.json
_work/net-mvp/harness-report.json             latest full run
_work/net-mvp/harness-report-final.json       repeat A
_work/net-mvp/harness-report-repeat.json      repeat B
_work/net-mvp/browser-evidence.json           latest full run
_work/net-mvp/browser-evidence-final.json
_work/net-mvp/browser-evidence-run1.json
_work/net-mvp/browser-evidence-run2.json
_work/net-mvp/browser-two-clients-mid.png
_work/net-mvp/browser-two-clients-finish.png
_work/net-mvp/browser-host-finish.png
_work/net-mvp/browser-guest-finish.png
_work/logs/net-mvp/harness.log
_work/logs/net-mvp/browser.log
_work/net-mvp/capacity-report.json
_work/net-mvp/reconnect-matrix.json
_work/net-mvp/limits-report.json
_work/net-mvp/proxy-report.json
_work/net-mvp/tls-report.json
_work/net-mvp/soak-report.json
_work/logs/net-mvp/capacity.log
_work/logs/net-mvp/reconnect-matrix.log
_work/logs/net-mvp/soak.log
```

The measured results and limits are in
[`docs/work/analysis/net-mvp.md`](../../docs/work/analysis/net-mvp.md) and
[`docs/work/analysis/net-multiplayer-internet.md`](../../docs/work/analysis/net-multiplayer-internet.md).

## Limits

* **WebSocket reliable/ordered, not UDP.** Loss/latency is injected in the
  client library on one state channel; the real socket itself is clean. This
  gate proves rooms, sequencing, ack/resync, interpolation, correction,
  reconnect and hashing, not SCTP/UDP behavior.
* **No WebRTC, STUN or TURN.** No NAT traversal test; the internet path is
  WSS through a reverse proxy or a Cloudflare Tunnel, not a peer-to-peer path.
* **No game.** The race is a deterministic synthetic function of
  (seed, slot, car, tick), not engine physics or retail state.
* **No e1-drive integration yet.** `client.mjs` is the API that integration
  will consume.
* **Host authority is a flag plus a sequence target**, not an authoritative
  simulation; host migration exists but was not exercised.
* **Resume window 30 s, replay cache 20 s / 2000 messages.** A resync older
  than the cache returns `NET_RESYNC_RANGE`; the gate treats that as an error.
* **Capacity default 8, hard 20, 64 rooms, 512 connections.**
* **Message cap 64 KiB (configurable down to 1 KiB); 12,000 messages/s per
  socket**, enough for the 20 s replay burst after a 15 s stall.
* **In-memory by default.** An optional `--state-file` JSON snapshot restores
  rooms across a graceful `SIGTERM` restart (mode 0600). A crash loses them.
* **TLS only for public play.** Native cert/key is supported; the deployment
  bundle terminates TLS in Caddy/nginx or uses a Cloudflare Tunnel. The room
  code is a lookup key, not an authorization secret. No accounts, anti-cheat or
  database.
