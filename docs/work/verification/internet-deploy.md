# Internet deploy — verified locally, waiting only on credentials

Status: the deploy path is built and **verified locally**. 10 November 2026.
The only missing inputs are the user's host, domain and certificate.

## What is proven

`tools/verify_proxy.ps1` starts the game server (8801), the room service (8811)
and a TLS reverse proxy (8443), then runs the `mp-two` e2e scenario against
`https://localhost:8443/` with `wss://localhost:8443/ws`:

```text
PASS mp-two · 49/49 assertions · 19.2 s · 7 screenshots
PROXY CHECK PASSED: two pages raced through the TLS reverse proxy.
  page  https://localhost:8443/
  room  wss://localhost:8443/ws
```

Two real browser pages loaded the page over HTTPS, joined the same room over
WSS, finished the 310 m race and rendered the same shared result table. The
proxy is the same two routes the production configs use:

| route | upstream | purpose |
| --- | --- | --- |
| `/` (everything else) | `127.0.0.1:8801` | the page, JS modules and `_work` assets |
| `/ws` (WebSocket upgrade) | `127.0.0.1:8811` | the room service (RFC 6455) |

## Artifacts

| file | purpose |
| --- | --- |
| `deploy/Caddyfile` | production Caddy config: automatic Let's Encrypt certificate, `/ws` → 8811, everything else → 8801 |
| `deploy/nginx.conf` | production nginx config: `certbot` certificate, `map $http_upgrade` for `/ws`, everything else → 8801 |
| `tools/tls-proxy.mjs` | the local stand-in: HTTPS + WSS termination for the same two routes |
| `tools/deploy_local.ps1` | one command: development certificate (if missing), game + room, TLS proxy, printed URLs |
| `tools/verify_proxy.ps1` | one command: the self-check above |
| `deploy/local-dev.pfx` | local development certificate (passphrase `blur`), **not committed** |

## Commands

```powershell
# Start everything (certificate, game, room, TLS proxy)
powershell -ExecutionPolicy Bypass -File tools/deploy_local.ps1

# Prove the proxied path (two pages, one shared result)
powershell -ExecutionPolicy Bypass -File tools/verify_proxy.ps1
```

## What only the user can provide

These are infrastructure decisions/credentials, not code. Nothing else is
missing.

| input | why | example |
| --- | --- | --- |
| **Host** | a reachable machine to run the Node process | a VPS with 1 vCPU / 1 GB RAM, Ubuntu 22.04+ |
| **Domain** | the hostname the certificate is issued for | `play.example.com` |
| **DNS record** | the A/AAAA record that points the domain at the host | `play.example.com A 203.0.113.10` |
| **Certificate** | Caddy obtains it automatically from Let's Encrypt; nginx needs `certbot` or an existing certificate | `certbot --nginx -d play.example.com` |
| **Firewall** | open 443 only; 8801/8811 stay on loopback | security group: inbound TCP 443 |

Optional: SSH access to the host, or the user runs the two commands below.

## Server steps once the inputs exist

```bash
# 1. Clone the repository on the host and build the WASM module if it is absent.
# 2. Start the game process on loopback only:
node probes/e1-drive/tools/serve.mjs --port 8801 --with-room --room-port 8811 --host 127.0.0.1
# 3. Put the proxy in front of it:
caddy run --config deploy/Caddyfile        # replace play.example.com first
#    or: nginx -c /etc/nginx/nginx.conf
```

The page derives the room URL from its own hostname
(`defaultRoomUrl()` → `wss://<page-host>:8811/ws`), so behind the proxy the
guest must pass `?mpServer=wss://play.example.com/ws` or the page needs the
`/ws` default. The verified proxied run uses `--room-url wss://localhost:8443/ws`,
which is exactly that override.

## Limits

- The development certificate is for `localhost` only; a public host must use a
  real certificate.
- No accounts, anti-cheat or persistence; the room code and resume token are the
  only identity.
- No TURN/WebRTC: the reliable WebSocket carries the measured packet budget.
- The game assets are not uploaded; each client uses its local game data.
