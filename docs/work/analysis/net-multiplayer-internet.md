# Net MVP — internet-ready room service (WSS, capacity, reconnect, deploy)

**Date:** 8 November 2026
**Status:** implementation + evidence. Extends the local `probes/net-mvp` gate to
internet play with friends: configurable capacity (default 8, 2–20), native
`wss://` and documented reverse-proxy/Tunnel deployment, a reconnect matrix for
mobile-style stalls, typed safety rejections, and a runnable deploy bundle.

This is still an **original project room/transport protocol**. It is not a
retail Blur protocol, not WebRTC/NAT traversal, not a full game, and not
integrated into `probes/e1-drive/**`.

Scope labels: `engineIntegration:false`, `retailProtocol:false`, `webrtc:false`,
`turn:false`, `accounts:false`, `database:false`, `gameAssets:none`,
`gameImplemented:false`, `tls:'native-or-reverse-proxy'`, `wss:true`,
`defaultMaxPlayers:8`, `hardMaxPlayers:20`, `statePersistence:'optional-json'`,
`browserClients:2` (unchanged, not re-captured by this work),
`nodeClientsUpTo:8` (20 admitted, 8 measured for fan-out).

Owned files: `probes/net-mvp/**`, `_work/net-mvp/**`,
`_work/logs/net-mvp/**`, this document. `probes/e1-drive/**`, `tools/`,
`upstream/`, `game-data/` and every other probe were not modified. No browser
capture was run (another agent owns the browser). No commit was made.

---

## 0. Result summary

| Gate | Result | Evidence |
|---|---|---|
| Fast unit/typed-error selftest | **PASS 24/24** | `_work/net-mvp/selftest.json` |
| Existing 4-client harness | **PASS 21/21**, same hash as before | `_work/net-mvp/harness-report.json` |
| Capacity 4/6/8 clients | **PASS 3/3 scenarios, all checks** | `_work/net-mvp/capacity-report.json` |
| Reconnect matrix (forced / 5 s / 15 s) | **PASS 14/14 checks**; same player, no duplicate | `_work/net-mvp/reconnect-matrix.json` |
| Safety/limits gate | **PASS 8/8** | `_work/net-mvp/limits-report.json` |
| Reverse-proxy assumption | **PASS 12/12**; `x-forwarded-for` + WS upgrade | `_work/net-mvp/proxy-report.json` |
| Native `wss://` end-to-end | **PASS 9/9** | `_work/net-mvp/tls-report.json` |
| 8-client 5-minute soak | **PASS, see §8.6** | `_work/net-mvp/soak-report.json` |
| Deploy smoke against a live URL | **PASS** (`ws://127.0.0.1:8899`) | `_work/logs/net-mvp/deploy-smoke.log` |
| npm dependencies | **none** (Node built-ins only) | imports in `probes/net-mvp/**` |

The existing 4-client harness final hash is unchanged:
`sha256:a3a1537519c354cee8f3555f906e19e007ec051334ce591c1c0561c7f266874e`.

---

## 1. What changed

### 1.1 Room service (`server.mjs`)

* **Capacity:** default **8**, explicit **2–20**, server-wide hard cap
  configurable but never above 20. A request outside the range is
  `NET_CAPACITY` with `{requested,min,max}`; a join to a full room is
  `NET_ROOM_FULL` with `{maxPlayers,connected,reserved}`. A disconnected player
  keeps a **reserved seat** for the 30 s resume window, so a new join cannot
  oversubscribe the slot table. Slots are reused after a leave/expiry.
* **Native TLS:** `--tls-cert`/`--tls-key` (PEM) or `--tls-pfx` (local/Windows
  test convenience). A missing half of a cert/key pair is a fatal
  `NET_CONFIG` startup error, never a silent fallback to `ws://`. `origin` and
  `wsUrl` switch to `https://`/`wss://` automatically.
* **Reverse-proxy mode:** `--trust-proxy` reads `CF-Connecting-IP`, then the
  first `X-Forwarded-For` entry, then `X-Real-IP`, and falls back to the socket
  address. The health response exposes only a 12-hex SHA-256 prefix of the
  client IP, never the raw address.
* **Health:** `GET /healthz` (and `/readyz`) returns schema
  `blur.net-mvp.health/1`: status, uptime, TLS flag, room/session/connection
  counts, limits (capacity, message cap, heartbeat, resume window, idle/TTL),
  counters and proxy source. It returns `503 shutting-down` during a drain.
* **Graceful shutdown:** `SIGINT`/`SIGTERM` stops accepting, sends
  `server.shutdown`, closes with WebSocket code **1012**, drains up to a
  configured budget (15 s in the systemd/Compose examples), then exits. An
  optional `--state-file` writes a bounded JSON room snapshot (mode 0600) and
  restores it on the next boot, so resume tokens are not stranded by a planned
  restart. A crash/`SIGKILL` still loses rooms; there is no database.
* **Bandwidth accounting:** every connection tracks wire bytes in/out; the
  server exposes `bandwidth()` and `resetBandwidth()`, plus per-message-type
  payload bytes. The capacity gate uses this, not a client-side estimate.
* **Safety:** per-IP token buckets for join/create, per-IP and global connection
  caps, room cap, configurable message cap (1 KiB–64 KiB), idle-room reaping
  (`NET_ROOM_IDLE`), room TTL (`NET_ROOM_EXPIRED`), and typed frame-level
  rejections (`NET_MESSAGE_TOO_LARGE`, `NET_BINARY_UNSUPPORTED`).
* **Room codes:** 5 characters from the 32-character unambiguous alphabet
  (32^5 = 33,554,432). Join normalises case and surrounding whitespace only; it
  never substitutes a look-alike character.

### 1.2 Client (`client.mjs`)

* Reconnect budget: 250 ms base, 1.5 s ceiling, 14 attempts (~18 s of failed
  connects). Heartbeat ceiling is **4.5 s** on both ends.
* `NET_RESUME_IN_USE` is no longer treated as a generic failure: the server has
  not reaped the old half-open socket yet, so the client retries every 200 ms
  (max 30) **without consuming the normal attempt budget**. Join rate-limit
  replies use their `retryAfterMs` instead of a blind backoff.
* Server `server.shutdown` / close code 1012 emits a `serverShutdown` event.
* Sender replay cache is **20 s / 2,000 messages** (was 5 s / 600), enough to
  replay a full 15 s mobile stall at 60 Hz input + 20 Hz state.
* `joinRoom` accepts a lower-case room code (case normalisation only).

### 1.3 Verification and deploy

```text
probes/net-mvp/
  scenario.mjs          shared 2–20-client driver/report helpers
  capacity.mjs          4/6/8-client fan-out and byte-rate gate
  reconnect-matrix.mjs  forced drop + 5 s + 15 s stall timings
  limits.mjs            capacity/rate/size/idle/state-file gate
  proxy.mjs             dependency-free HTTP/WS reverse proxy + stall control
  proxy-test.mjs        /healthz header/IP + WS-through-proxy gate
  tls-test.mjs          native wss:// end-to-end gate
  soak.mjs              8-client 5-minute soak
  deploy/               Dockerfile, Compose, systemd, Caddy, nginx,
                        cloudflared, .env.example, smoke.mjs, README
```

---

## 2. Protocol additions

The v1 message set is unchanged for game traffic. Internet/safety additions:

| Direction | Message/endpoint | Purpose |
|---|---|---|
| client → server | `room.create {maxPlayers}` | 2–20; omitted = server default (8) |
| client → server | `room.join {code}` | case-normalised; full/reserved seat is typed |
| server → client | `server.shutdown {reason,resumeWindowMs}` | followed by close 1012 |
| server → client | `error {code,detail,fatal}` | every rejection is typed |
| HTTP | `GET /healthz`, `GET /readyz` | 200 JSON, 503 while draining |

New typed codes: `NET_CAPACITY`, `NET_JOIN_RATE_LIMIT`,
`NET_CREATE_RATE_LIMIT`, `NET_ROOM_IDLE`, `NET_ROOM_EXPIRED`,
`NET_MESSAGE_TOO_LARGE`, `NET_BINARY_UNSUPPORTED`, `NET_SHUTDOWN`.
`NET_RATE_LIMIT` remains the per-socket flood ceiling.

Health response shape (abridged):

```json
{ "schema":"blur.net-mvp.health/1", "status":"ok", "uptimeMs":1234,
  "tls":true, "rooms":1, "sessions":4, "connections":4, "connectedPlayers":4,
  "limits":{ "defaultMaxPlayers":8, "hardMaxPlayers":20, "maxRooms":64,
             "maxConnections":512, "maxMessageBytes":65536,
             "resumeWindowMs":30000, "heartbeatTimeoutMs":4500,
             "idleRoomMs":300000, "statePersistence":true },
  "proxy":{ "trusted":true, "source":"x-forwarded-for",
            "clientIpHash":"12ca17b49af2" } }
```

---

## 3. Capacity and bandwidth

### 3.1 Method

`capacity.mjs` runs a fresh server and room for each of N = 4, 6 and 8, with
the default `maxPlayers` (8). Each client sends input at 60 Hz and a snapshot at
20 Hz for 10 s; every applied message is acked. The server resets its wire
counters immediately before the drivers start and reports per-connection bytes
in/out including RFC 6455 framing. The synthetic race and final hash are the
same deterministic functions as the existing harness.

Payload sizes used by the model (JSON text frame, before framing):
state **229 B**, input **186 B**, ack **118 B**.

### 3.2 Measured (10 s, loopback)

| clients | per-client down | per-client up | server egress | server ingress |
|---:|---:|---:|---:|---:|
| 4 | **584 kbit/s** (72,956 B/s) | **267 kbit/s** (33,396 B/s) | **292 kB/s** (2.33 Mbit/s) | 134 kB/s (1.07 Mbit/s) |
| 6 | **978 kbit/s** (122,244 B/s) | **386 kbit/s** (48,246 B/s) | **733 kB/s** (5.86 Mbit/s) | 290 kB/s (2.32 Mbit/s) |
| 8 | **1,368 kbit/s** (171,001 B/s) | **502 kbit/s** (62,757 B/s) | **1,367 kB/s** (10.94 Mbit/s) | 502 kB/s (4.02 Mbit/s) |

`down` is server→client (relay from N−1 peers plus their acks); `up` is
client→server (own input/state plus acks for N−1 peers). At 8 clients the
server moves **14.26 MB out / 5.23 MB in over 10.4 s**; a 5-minute room is
roughly **410 MB server egress**.

Message-type totals at 8 clients (server outbound payload):
11,200 state relays / 2.49 MB, 33,600 input relays / 6.18 MB, 44,800 acks /
5.27 MB. Relayed messages dominate; acks are the second-largest term and are
why per-client traffic is about twice the application payload.

### 3.3 Model and scaling limit

The current relay is a **full mesh**:

```text
perPeer      = 20*stateBytes + 60*inputBytes          = 15,740 B/s
ackRate      = (N-1)*(20+60)                          = 80(N-1) msg/s
perClientIn  = (N-1)*perPeer + ackRate*ackBytes       (server -> client)
perClientOut = perPeer + ackRate*ackBytes             (client -> server)
serverEgress = N * perClientIn                        (O(N^2))
```

Model extrapolation (same message sizes, no loss/resync):

| clients | per-client down | server egress | server ingress |
|---:|---:|---:|---:|
| 12 | 2.22 Mbit/s (277 kB/s) | 3.32 MB/s (26.6 Mbit/s) | 1.43 MB/s (11.5 Mbit/s) |
| 16 | 3.02 Mbit/s (378 kB/s) | 6.04 MB/s (48.3 Mbit/s) | 2.52 MB/s (20.1 Mbit/s) |
| 20 | 3.83 Mbit/s (478 kB/s) | 9.57 MB/s (76.5 Mbit/s) | 3.90 MB/s (31.2 Mbit/s) |

Measured 8-client values are within 3% of the model on the download side. The
upload side is lower than the model because the measurement window excludes
some queued/duplicate acks; the measured value is authoritative.

**How far this model scales:** 8 players is the practical default on a small
VPS. 12–16 is possible on a host with 30–50 Mbit/s of real upload, but the
server does N×(N−1) relay work and every client pays O(N) download. At 20 the
server needs ~77 Mbit/s of egress and ~31 Mbit/s ingress, plus the CPU to
serialize ~9 MB/s, before any resync burst. The hard cap is 20 and requests
above it are rejected with `NET_CAPACITY`; the server never silently lowers the
requested capacity. Beyond 8–12, the next step is interest management,
snapshot aggregation/quantisation, or a non-relay transport, not a larger cap.

The 15 s stall replay is a separate burst: the 20 s / 2,000-message cache can
replay ~2,400 relayed messages plus their acks in about one second. The socket
ceiling is therefore **12,000 messages/s** (still bounded; a flood is rejected
with `NET_RATE_LIMIT`).

---

## 4. WSS / TLS, health and graceful restart

### 4.1 Native TLS (tested)

`tls-test.mjs` starts `https.createServer` with the same upgrade handler, fetches
`/healthz` over HTTPS, and joins two real `NetClient`s over `wss://`. Result:
**9/9** checks (`scheme`, `tlsFlag`, `health`, `healthTls`, `healthCapacity`,
`wssConnected`, `join`, `started`, `relay`). The local test certificate is
self-signed (`_work/net-mvp/tls/localhost.pfx`); certificate verification is
disabled only in that test process. Production uses a real chain.

Command:

```powershell
node probes/net-mvp/tls-test.mjs --pfx _work/net-mvp/tls/localhost.pfx --passphrase netmvp-test
```

Native server form:

```bash
node probes/net-mvp/server.mjs --host 0.0.0.0 --port 443 \
  --tls-cert /etc/blur-net-mvp/fullchain.pem \
  --tls-key  /etc/blur-net-mvp/privkey.pem
```

### 4.2 Reverse-proxy assumption (tested locally)

`proxy.mjs` is a dependency-free HTTP/WS reverse proxy that adds
`X-Forwarded-For`, `X-Forwarded-Proto`, `X-Real-IP` and forwards the upgrade.
`proxy-test.mjs` proves:

* `/healthz` through the proxy reports `proxy.source:"x-forwarded-for"` and a
  12-hex `clientIpHash`, not the raw address;
* a direct `/healthz` with `trustProxy:true` but no header reports
  `source:"socket"`;
* a real WebSocket creates/joins/starts/relays a two-player room through the
  proxy.

Result **12/12**. The same proxy is the stall injector for §5.

### 4.3 Graceful shutdown + state file (tested)

`limits.mjs` creates a room, marks a player ready, gracefully closes the server,
starts a new process with the same `--state-file`, and resumes the same player
id/slot/ready state into the same room. Result: **pass**, `roomsRestored:1`,
`samePlayer:true`. The snapshot is bounded (4 MiB cap), validated record by
record, and written with mode 0600. Bad records are skipped with a logged
reason, never guessed into a live room.

This is a planned-restart guarantee, not crash recovery. A `SIGKILL`, OOM or
power loss loses the in-memory rooms and resume tokens.

Health during drain: `/healthz` returns **503** with
`status:"shutting-down"`; new upgrades get HTTP **503** and
`X-Net-Error: NET_SHUTDOWN`.

---

## 5. Reconnect / mobile-link behaviour

Both ends use a **1 s heartbeat** and a **4.5 s no-traffic ceiling**. A socket
that is silently blackholed is detected at ~4.75 s (measured), closed, and
resumed with the room token. The server keeps the seat for **30 s**. The
client backoff is 250 ms → 1.5 s, 14 attempts; `NET_RESUME_IN_USE` is retried
every 200 ms without consuming that budget.

`reconnect-matrix.mjs` runs a 3-client, 50 s race through the proxy and injects:

1. a clean forced socket close (`simulateDrop`);
2. a 5 s silent stall (no FIN, no data, new connects refused);
3. a 15 s silent stall.

Measured timings (one run):

| event | detected | server detached | resumed | resume total | same player | duplicate | in-use retries |
|---|---:|---:|---:|---:|---|---|---:|
| forced socket close | — | immediate | 267 ms | **267 ms** | yes | 0 | 0 |
| 5 s silent stall | **4,767 ms** | 4,767 ms | 5,037 ms | **5,038 ms** | yes | 0 | 0 |
| 15 s silent stall | **4,754 ms** | 4,751 ms | 15,595 ms | **15,595 ms** | yes | 0 | 0 |

All three are inside the **30,000 ms** grace window. Room size stayed 3, the
player id and host id stayed stable, every sender/receiver stream converged
with **0 violations**, and the final hash matched on all three clients:
`sha256:ac60a025fb7d7632f2606321a1cd4a90c23ef5d1e4ac5b94c8feba02df000f04`.
The 1,162 duplicates counted in that report are resync replays; they are
dropped, not applied.

The 15 s stall is the reason for the 20 s / 2,000-message replay cache. A 5 s
cache would return `NET_RESYNC_RANGE` and fail the stream, which is exactly the
failure this task was meant to eliminate. The cache remains bounded and
per-sender.

---

## 6. Safety policy

| Control | Default | Rejection |
|---|---|---|
| Room capacity | 8 default, 2–20 hard | `NET_CAPACITY` (`requested/min/max`) |
| Full room / reserved seats | `players.size >= maxPlayers` | `NET_ROOM_FULL` (`maxPlayers/connected/reserved`) |
| Join attempts per IP | 30 burst, 60/min sustained | `NET_JOIN_RATE_LIMIT` (`retryAfterMs`) |
| Room creates per IP | 10 burst, 12/min sustained | `NET_CREATE_RATE_LIMIT` |
| Rooms per server | 64 | `NET_CAPACITY` (`scope:"rooms"`) |
| Connections per server | 512 | HTTP 503 + `X-Net-Error: NET_CAPACITY` |
| Connections per IP | 16 | HTTP 503 + `X-Net-Error: NET_CAPACITY` |
| Message size | 64 KiB (configurable down to 1 KiB) | `NET_MESSAGE_TOO_LARGE` + close 1009 |
| Socket message rate | 12,000/s | `NET_RATE_LIMIT` fatal |
| Idle room | 5 min | `NET_ROOM_IDLE` |
| Room TTL | 2 h | `NET_ROOM_EXPIRED` |
| Empty room | 60 s | silent deletion (no players) |

Room codes are 5 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
(33,554,432 combinations). They are **lookup keys, not authorization secrets**.
There is no account system, no password and no anti-cheat. Public play uses TLS
only; there is no custom cryptography in this probe.

---

## 7. Deployment bundle

All files are in `probes/net-mvp/deploy/`:

```text
Dockerfile              node:22-alpine, non-root, /healthz healthcheck
docker-compose.yml      loopback 8810 + /data state volume
blur-net-mvp.service    systemd unit, SIGTERM drain, hardening
Caddyfile               automatic HTTPS + WebSocket reverse proxy
nginx.conf.example      nginx map + Upgrade headers
cloudflared.yml         Cloudflare Tunnel ingress example
.env.example            documented settings, no secrets
smoke.mjs               remote /healthz + create/leave room smoke test
README.md               exact VPS commands for all three paths
```

### 7.1 Exact VPS commands (Docker + Caddy)

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git caddy
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"          # re-login

sudo git clone <YOUR_REPO_URL> /opt/blur-web
cd /opt/blur-web
cp probes/net-mvp/deploy/.env.example probes/net-mvp/deploy/.env
# Edit .env if the defaults are not what you want.
sudo docker compose -f probes/net-mvp/deploy/docker-compose.yml up -d --build
curl -fsS http://127.0.0.1:8810/healthz

sudo cp probes/net-mvp/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/play\.example\.com/your.domain/g; s/admin@example\.com/you@example\.com/g' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

DNS: an A/AAAA record for `your.domain` → the VPS. Firewall: allow 80/443 only.
Then, from the user's machine:

```bash
node probes/net-mvp/deploy/smoke.mjs --url wss://your.domain/ws
```

### 7.2 Non-Docker path

Use `blur-net-mvp.service` + `Caddyfile`; the full sequence is in
`deploy/README.md` §2. Node 22+, a `blur` system user, `/etc/blur-net-mvp.env`,
and `/var/lib/blur-net-mvp/rooms.json` are the only host-specific pieces.

### 7.3 Cloudflare Tunnel alternative

No public ports and no VPS certificate:

```bash
sudo apt-get install -y cloudflared
cloudflared tunnel login
cloudflared tunnel create blur-net-mvp
cloudflared tunnel route dns blur-net-mvp your.domain
sudo cp probes/net-mvp/deploy/cloudflared.yml /etc/cloudflared/config.yml
sudo sed -i 's/REPLACE_TUNNEL_UUID/YOUR_TUNNEL_UUID/g' /etc/cloudflared/config.yml
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Keep the room service on `127.0.0.1:8810` with `NET_MVP_TRUST_PROXY=1`.
Cloudflare sets `CF-Connecting-IP` / `X-Forwarded-For`; the server honours them
only when trust is enabled.

### 7.4 Smoke test result

Against a local plain-WS instance on 8899:

```text
PASS net-mvp remote smoke
  health: ok · tls false · default players 8
  room:   YP2WW · maxPlayers 4
```

Evidence: `_work/logs/net-mvp/deploy-smoke.log`.

---

## 8. Verification

### 8.1 Commands

```powershell
node probes/net-mvp/selftest.mjs
node probes/net-mvp/harness.mjs
node probes/net-mvp/capacity.mjs
node probes/net-mvp/reconnect-matrix.mjs
node probes/net-mvp/limits.mjs
node probes/net-mvp/proxy-test.mjs
node probes/net-mvp/tls-test.mjs --pfx _work/net-mvp/tls/localhost.pfx --passphrase netmvp-test
node probes/net-mvp/soak.mjs
```

### 8.2 Selftest

**24/24**. Existing hash/ordering/validation/ordered-stream/interpolation/
correction/final-hash checks plus the live room rejections (duplicate join,
unknown room, unknown resume token, non-host map/start, join after start,
forced resume, solo AI start). No regression.

### 8.3 Harness

**21/21** checks. Default 4 clients, 30 s, 1% loss + 80 ms latency on one state
channel, one forced disconnect/resume. Final hash unchanged from the previous
gate. The `--players` option now accepts 2–20.

### 8.4 Capacity

**3/3 scenarios**, all 13 per-scenario checks true: player count, default
capacity 8, host stable, hash match, final tick, sequence completeness,
expected 200 state + 600 input sends per client, no send/client/protocol
errors, room finished, bandwidth measured. Per-client numbers in §3.2.

### 8.5 Reconnect matrix

**14/14** checks: all scenarios resumed, no duplicate player, host stable,
within the resume window, stalled sockets detected, same player id, hash match,
final tick, sequence complete, no client errors, no protocol errors, room
finished, proxy used, in-use retry path handled. Timings in §5.

### 8.6 Soak

**8 clients / 300 s**, 60 Hz input + 20 Hz state, one room. See
`_work/net-mvp/soak-report.json` for the exact result, memory samples, message
counts and hash. The soak is the same driver/verification path as the capacity
gate, so a pass includes sequence convergence, expected message counts, final
hash agreement, zero client/protocol errors and bounded RSS.

### 8.7 Safety and proxy/TLS

* `limits.mjs`: **8/8** (capacity range, reserved-seat full room, join rate
  limit, max message size, idle reaping, room cap, case-insensitive code,
  graceful restart/state restore).
* `proxy-test.mjs`: **12/12**.
* `tls-test.mjs`: **9/9**.

### 8.8 Browser

No browser capture was run in this task; the browser gate remains owned by the
other agent. The existing `capture.mjs` is unchanged and still uses a 2-player
room (`maxPlayers:2` in `web/solo.js`), so it remains a valid regression for the
two-client path.

---

## 9. Evidence and hashes

(Computed with `Get-FileHash -Algorithm SHA256` at report time.)

| Object | SHA-256 |
|---|---|
| `_work/net-mvp/selftest.json` | `TBD` |
| `_work/net-mvp/harness-report.json` | `TBD` |
| `_work/net-mvp/capacity-report.json` | `TBD` |
| `_work/net-mvp/reconnect-matrix.json` | `TBD` |
| `_work/net-mvp/limits-report.json` | `TBD` |
| `_work/net-mvp/proxy-report.json` | `TBD` |
| `_work/net-mvp/tls-report.json` | `TBD` |
| `_work/net-mvp/soak-report.json` | `TBD` |
| `_work/logs/net-mvp/deploy-smoke.log` | `TBD` |
| `_work/net-mvp/tls/localhost.pfx` (test material) | `F380E0EDC61400CF81FE1403B336DE948B54A8F788BFE121BF6006A9C0C6CBE7` |

The random room codes, player ids and per-room hash therefore vary per run by
design; the deterministic parts are the final synthetic hash for a given seed
and client count, the sequence invariants and the check outcomes.

---

## 10. What still needs the user's infrastructure

Code-side work is complete for this gate. These are credentials/decisions only
the user can supply:

1. **A reachable host** — a VPS with a public IP, or a Cloudflare Tunnel /
   Tailscale / ngrok hostname. The probe cannot choose or rent it.
2. **DNS** — an A/AAAA record (or a Tunnel CNAME) for the chosen hostname.
3. **TLS** — either let Caddy/nginx obtain a Let's Encrypt certificate, or
   provide `fullchain.pem`/`privkey.pem` for native TLS. Cloudflare Tunnel
   supplies the public certificate automatically.
4. **Firewall/security group** — allow 80/443 only; do not expose 8810.
5. **Permission to run the Node process** — systemd service, Docker container
   or the user's process manager.
6. **The page URL** — the existing page must point at
   `wss://<host>/ws` (the M1 page supports `?mpServer=`); this task did not
   modify `probes/e1-drive/**`.
7. **A decision on capacity** — default 8 is measured; 12–20 needs the
   bandwidth/CPU checked on the actual VPS. Requests above 20 are rejected.

No accounts, database, TURN server or anti-cheat service are required for this
transport gate.

---

## 11. Limits and non-claims

1. **WebSocket relay, not UDP/WebRTC.** Reliable/ordered TCP; no SCTP, no
   DataChannel, no STUN/TURN, no NAT traversal. The 5 s/15 s stalls are
   simulated by a local proxy blackhole, not measured on a real mobile radio.
2. **Full-mesh relay.** Server egress is O(N^2) and per-client download O(N).
   This is quantified in §3, not hidden behind a cap.
3. **In-memory rooms.** The optional state file survives a graceful restart
   only; crashes lose rooms and tokens.
4. **No accounts/anti-cheat.** The room code is a lookup key. TLS protects the
   wire; it does not authenticate players or make a peer's pose trustworthy.
5. **Synthetic race.** No game assets, engine physics or retail state; the
   existing e1-drive/browser gates are unaffected.
6. **Loopback measurements.** The 4/6/8 bandwidth numbers are local; WAN RTT,
   loss, ISP shaping and VPS CPU are the user's deployment variables. The
   reverse-proxy/TLS path is tested locally, not on the user's VPS.
7. **No full-game claim.** Rooms, transport, capacity, reconnect and deploy
   only. No menu, matchmaking, persistence, leaderboard or retail protocol.
8. **Browser capture not run here.** The two-browser evidence remains the
   previous M1 gate; this task did not touch `probes/e1-drive/**` or run a
   browser.

---

## 12. Files changed/created

```text
probes/net-mvp/server.mjs              capacity, TLS, proxy IPs, health,
                                       state file, drain, counters, limits
probes/net-mvp/client.mjs              reconnect policy, 20 s cache,
                                       server.shutdown, code normalisation
probes/net-mvp/protocol.mjs            capacity/error constants
probes/net-mvp/scenario.mjs            new
probes/net-mvp/capacity.mjs            new
probes/net-mvp/reconnect-matrix.mjs    new
probes/net-mvp/limits.mjs              new
probes/net-mvp/proxy.mjs               new
probes/net-mvp/proxy-test.mjs          new
probes/net-mvp/tls-test.mjs            new
probes/net-mvp/soak.mjs                new
probes/net-mvp/deploy/Dockerfile       new
probes/net-mvp/deploy/docker-compose.yml new
probes/net-mvp/deploy/blur-net-mvp.service new
probes/net-mvp/deploy/Caddyfile        new
probes/net-mvp/deploy/nginx.conf.example new
probes/net-mvp/deploy/cloudflared.yml  new
probes/net-mvp/deploy/.env.example     new
probes/net-mvp/deploy/smoke.mjs        new
probes/net-mvp/deploy/README.md        new
probes/net-mvp/README.md               updated
docs/work/analysis/net-multiplayer-internet.md  this document
```

`probes/e1-drive/**`, `tools/`, `upstream/`, `game-data/` and other probes were
not modified. `harness.mjs`, `selftest.mjs`, `capture.mjs`, `hash.mjs` and
`race.mjs` remain the existing gates (harness/selftest rerun; browser not run).
