# Deploying the net-mvp room service for internet play

This bundle runs the dependency-free room service on a VPS so friends on
different networks can join a room over `wss://`. The service is an original
project transport probe, not a retail Blur service, and it is not a full game.

Two facts decide the setup:

1. **The browser page must be served over HTTPS** and connect to `wss://`. A
   public `ws://` listener is not acceptable.
2. **The room service is a plain HTTP/WebSocket origin.** Terminate TLS in Caddy,
   nginx or Cloudflare Tunnel; the service stays on `127.0.0.1:8810`. Native TLS
   (`NET_MVP_TLS_CERT`/`NET_MVP_TLS_KEY`) is also supported if you already have
   certificates and do not want a proxy.

Nothing in this directory creates accounts, stores game assets or invents
cryptography. TLS is the only security boundary; the room code is a lookup key,
not an authorization secret.

---

## 0. What you need

- A VPS with a public IPv4/IPv6 address (Ubuntu 22.04/24.04 used below).
- A DNS name whose A/AAAA record points at the VPS, e.g. `play.example.com`.
- Ports **80 and 443** open in the firewall/security group. Nothing else needs
  to be public.
- Node 22+ (Docker path: Docker Engine 24+ and Compose v2.24+), or Caddy 2.
- About 100 MB RAM for a room of 8 players; the process is single-threaded and
  bandwidth-bound (see §7).

Placeholders used below: `play.example.com`, `/opt/blur-web`, `blur` user.
Replace them with your own values.

---

## 1. Fast path: Docker + Caddy on the host

```bash
# On the VPS, as a sudo-capable user.
sudo apt-get update
sudo apt-get install -y ca-certificates curl git caddy
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # re-login after this

sudo git clone <YOUR_REPO_URL> /opt/blur-web
cd /opt/blur-web

# No secrets in this file. Review the capacity/proxy values.
cp probes/net-mvp/deploy/.env.example probes/net-mvp/deploy/.env
sudo install -d -o "$USER" -g "$USER" /opt/blur-web/_work-net-mvp-state

sudo docker compose -f probes/net-mvp/deploy/docker-compose.yml up -d --build
curl -fsS http://127.0.0.1:8810/healthz | head -c 400
```

Caddy:

```bash
sudo cp probes/net-mvp/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/play\.example\.com/YOUR_DOMAIN/g' /etc/caddy/Caddyfile
sudo sed -i 's/admin@example\.com/YOUR_EMAIL/g' /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo journalctl -u caddy -n 30 --no-pager
```

Caddy obtains a Let's Encrypt certificate automatically. Verify from your own
machine:

```bash
curl -fsS https://play.example.com/healthz
node probes/net-mvp/deploy/smoke.mjs --url wss://play.example.com/ws
```

The room service is published only on `127.0.0.1:8810`. Do **not** expose that
port publicly.

The Compose file uses a named volume for `/data/rooms.json`, so a graceful
restart restores rooms that were live at shutdown. Remove the volume to start
clean.

---

## 2. Non-Docker path: systemd + Caddy

```bash
# Node 22 from NodeSource (or your distro package).
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs caddy git

sudo useradd --system --home /opt/blur-web --shell /usr/sbin/nologin blur
sudo git clone <YOUR_REPO_URL> /opt/blur-web
sudo chown -R blur:blur /opt/blur-web

sudo install -d -o blur -g blur /var/lib/blur-net-mvp
sudo cp /opt/blur-web/probes/net-mvp/deploy/.env.example /etc/blur-net-mvp.env
sudo sed -i 's|NET_MVP_STATE_FILE=.*|NET_MVP_STATE_FILE=/var/lib/blur-net-mvp/rooms.json|' /etc/blur-net-mvp.env
# Edit /etc/blur-net-mvp.env: NET_MVP_TRUST_PROXY=1, capacity, etc.

sudo cp /opt/blur-web/probes/net-mvp/deploy/blur-net-mvp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blur-net-mvp
curl -fsS http://127.0.0.1:8810/healthz
sudo journalctl -u blur-net-mvp -f
```

Then install the Caddyfile exactly as in §1 and run the smoke test. On a manual
restart:

```bash
sudo systemctl restart blur-net-mvp
```

The unit sends `SIGTERM`, the server drains for up to 15 s, writes
`/var/lib/blur-net-mvp/rooms.json`, closes sockets with WebSocket code `1012`
("service restart"), and exits. A client with a resume token reconnects and
resumes the same player after the new process starts. Without the state file a
restart loses rooms by design; the client gets a typed
`NET_ROOM_NOT_FOUND`/`NET_RESUME_UNKNOWN` and stops retrying.

---

## 3. Cloudflare Tunnel (no public ports, no VPS certificate)

The tunnel connects outbound from the VPS to Cloudflare; you do not open 80/443
or install a certificate.

```bash
sudo apt-get install -y cloudflared
cloudflared tunnel login
cloudflared tunnel create blur-net-mvp
cloudflared tunnel route dns blur-net-mvp play.example.com
sudo cp probes/net-mvp/deploy/cloudflared.yml /etc/cloudflared/config.yml
sudo sed -i 's/REPLACE_TUNNEL_UUID/YOUR_TUNNEL_UUID/g' /etc/cloudflared/config.yml
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Keep the room service on `127.0.0.1:8810` with `NET_MVP_TRUST_PROXY=1`.
Cloudflare sets `CF-Connecting-IP` and `X-Forwarded-For`; the server reads
`CF-Connecting-IP` first, then the first `X-Forwarded-For` entry, then
`X-Real-IP`, and only when `trustProxy` is enabled. WebSockets are proxied by
default. Then run:

```bash
node probes/net-mvp/deploy/smoke.mjs --url wss://play.example.com/ws
```

Cloudflare's proxy idle timeout is well above the 1 s heartbeat, so a quiet
lobby stays open.

---

## 4. Native TLS (no reverse proxy)

Use this only when you already have certificate files and want the Node process
to listen directly. Both files are required; one missing is a fatal startup
error, never a silent downgrade to `ws://`.

```bash
sudo NET_MVP_TLS_CERT=/etc/blur-net-mvp/fullchain.pem \
     NET_MVP_TLS_KEY=/etc/blur-net-mvp/privkey.pem \
     NET_MVP_HOST=0.0.0.0 NET_MVP_PORT=443 \
     node probes/net-mvp/server.mjs
```

The process needs permission to bind port 443 (`CAP_NET_BIND_SERVICE` or a
systemd `AmbientCapabilities` line). Open 443 in the firewall. The health and
WebSocket URLs become `https://`/`wss://` automatically. `NET_MVP_TRUST_PROXY`
should stay `0` in this mode.

For a local self-signed test:

```powershell
node probes/net-mvp/tls-test.mjs --pfx _work/net-mvp/tls/localhost.pfx --passphrase netmvp-test
```

---

## 5. Smoke test from the user's machine

```bash
# Public WSS deployment
node probes/net-mvp/deploy/smoke.mjs --url wss://play.example.com/ws

# Local/LAN plain WS (not for internet)
node probes/net-mvp/deploy/smoke.mjs --url ws://192.168.1.20:8810/ws

# Self-signed test host only
node probes/net-mvp/deploy/smoke.mjs --url wss://play.example.com/ws --insecure
```

The script fetches `/healthz`, opens a real WebSocket, creates a room, checks the
roster/capacity, leaves (deleting the empty room) and exits 0. It prints the
control RTT and the health TLS/capacity flags.

`--insecure` disables certificate verification for one process. Do not use it
against a public deployment with a real certificate.

---

## 6. Health, logs and operations

```bash
curl -fsS https://play.example.com/healthz | jq .
```

The response includes `status`, `uptimeMs`, `tls`, `rooms`, `sessions`,
`connections`, `limits` (default/hard players, rooms, message cap, heartbeat,
resume window, idle TTL) and proxy details. No player id, resume token or raw IP
is exposed; the proxy IP is only a 12-hex SHA-256 prefix.

Useful checks:

```bash
# Compose
docker compose -f probes/net-mvp/deploy/docker-compose.yml ps
docker compose -f probes/net-mvp/deploy/docker-compose.yml logs -f room

# systemd
sudo systemctl status blur-net-mvp
sudo journalctl -u blur-net-mvp -n 100 --no-pager

# Caddy
sudo journalctl -u caddy -n 100 --no-pager
```

During shutdown the server returns `503` from `/healthz` and rejects new
upgrades with `X-Net-Error: NET_SHUTDOWN`. Wait for the process to exit before
starting a replacement; the systemd unit and Compose both send `SIGTERM` and
allow 15 s.

---

## 7. Capacity and bandwidth (measured)

The default room is **8 seats**, configurable 2..20. A request for 21 is rejected
with `NET_CAPACITY`; it is never clamped. The server relays every snapshot to
every other connected player and acks every applied message, so per-client
traffic grows linearly with room size and server egress grows quadratically.

Measured with 4/6/8 headless clients, 20 Hz state + 60 Hz input, on loopback
(see `_work/net-mvp/capacity-report.json`):

| clients | per-client down | per-client up | server egress |
|---:|---:|---:|---:|
| 4 | 584 kbit/s | 267 kbit/s | 292 kB/s |
| 6 | 978 kbit/s | 386 kbit/s | 733 kB/s |
| 8 | 1,368 kbit/s | 502 kbit/s | 1,367 kB/s (~10.9 Mbit/s) |

Practical internet guidance:

- 8 players is comfortable on a small VPS with a 100 Mbit/s uplink.
- 12–16 players is roughly 3.3–6.0 MB/s server egress (27–48 Mbit/s); verify
  the VPS bandwidth and NIC before promising it.
- 20 players is roughly 9.6 MB/s (~77 Mbit/s) server egress and ~3.8 Mbit/s per
  client down. The hard cap exists so the server never silently degrades; for
  larger rooms, add interest management or a different transport (WebRTC mesh /
  regional relays) instead of raising the cap.
- The room code entropy is 32^5 = 33,554,432. Join attempts are limited per IP
  (30 burst, 60/min sustained) so enumeration is impractical; a full room
  returns `NET_ROOM_FULL` including reserved disconnected seats.

---

## 8. Security checklist

- [ ] Only 443 (and 80 for ACME) is public. `8810` is bound to loopback.
- [ ] `NET_MVP_TRUST_PROXY=1` only when a trusted proxy is the sole path in.
- [ ] A real certificate is used; no `--insecure` in production.
- [ ] `.env` is not committed; `.env.example` contains no secret.
- [ ] The state file (`rooms.json`) is mode 0600 and not in a public directory.
- [ ] You accept that this probe has no accounts, anti-cheat, database or
      persistence beyond the optional room snapshot.
- [ ] You have not published game data or `_work/`.

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Caddy 502 | Room service is not on `127.0.0.1:8810`. Check `curl http://127.0.0.1:8810/healthz`. |
| Browser WebSocket 1006 | Page is HTTPS but the URL is `ws://`, or the proxy is not forwarding `Upgrade`. Use `wss://` and the Caddy/nginx config above. |
| `NET_JOIN_RATE_LIMIT` | More than 30 join attempts from one IP in a burst. Wait for the `retryAfterMs` in the error detail. |
| `NET_ROOM_FULL` | All seats are reserved, including players still inside the 30 s resume window. Wait 30 s or create a new room. |
| `NET_ROOM_IDLE` | The room had no activity for `NET_MVP_IDLE_ROOM_MS` (5 min default). The client must create/join a new room. |
| Restart lost the room | `NET_MVP_STATE_FILE` is unset/unwritable, or the restart was a crash (`SIGKILL`), not a graceful `SIGTERM`. |
| Health says `source: socket` behind Caddy | `NET_MVP_TRUST_PROXY=1` is not set. The room still works; only per-IP policy uses the wrong address. |

---

## 10. Files in this bundle

```text
Dockerfile              node:22-alpine, non-root, /healthz healthcheck
docker-compose.yml      loopback port + /data state volume
blur-net-mvp.service    systemd unit with hardening and SIGTERM drain
Caddyfile               automatic HTTPS + WebSocket reverse proxy
nginx.conf.example      nginx equivalent (map + Upgrade headers)
cloudflared.yml         Cloudflare Tunnel ingress example
.env.example            documented settings, no secrets
smoke.mjs               remote health + room smoke test
README.md               this file
```
