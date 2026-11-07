# Multiplayer deployment plan (LAN now, internet next)

Status: design, 7 November 2026. The M1 room service is a local Node process;
this document defines how to reach it from other machines without changing the
game code.

## 1. What works today (verified)

- `tools/run_e1_poc.ps1` starts the game server on **8801** and the unchanged
  room service on **8811** in one process.
- Host: `?mp=1&host=1`; guest: `?mp=1&room=<CODE>`; both must use
  `&powerups=1` for M2.
- Two headless pages finish the 310 m race with console 0 and a shared result.
- The page connects to `ws://<page-host>:8811/ws` by default; `?mpServer=`
  overrides it.

## 2. Same LAN (no new infrastructure)

Host:

```powershell
ipconfig | Select-String 'IPv4'          # e.g. 192.168.1.20
New-NetFirewallRule -DisplayName "Blur Web MP" -Direction Inbound `
  -Protocol TCP -LocalPort 8801,8811 -Action Allow
```

Guest: `http://192.168.1.20:8801/?mp=1&room=<CODE>`.

Limits: same subnet, no NAT traversal, no TLS, no accounts.

## 3. Internet (a reachable host is required)

The browser must reach both the page (HTTP) and the room WebSocket. Options in
order of effort:

### A. Single VPS, WebSocket only (recommended for the first public test)

- Node process runs the game + room on a VPS, behind a reverse proxy with TLS
  (Caddy/nginx), e.g. `https://play.example.com` → 8801 and
  `wss://play.example.com/ws` → 8811.
- The page must use `?mpServer=wss://play.example.com/ws` (or the default host
  once the proxy path is configured).
- Open 443 only; 8801/8811 stay private.
- No WebRTC/TURN yet: the reliable WebSocket is enough for the M1/M2 packet
  budget measured in N1 (600 state + 1,800 input per client per 30 s).

### B. WebRTC DataChannel + TURN (later, if latency demands it)

- Add STUN/TURN (coturn) and a signaling path over the same WSS service.
- Keep the room protocol; swap the transport adapter.
- Measure RTT/loss before adding a second reliability layer.

## 4. What only the user can provide

These are infrastructure credentials/decisions, not code:

1. A reachable host: VPS/cloud instance or a tunnel (Cloudflare Tunnel,
   ngrok, Tailscale) with a stable hostname.
2. DNS/TLS for that hostname (Caddy can automate Let's Encrypt).
3. Firewall/security-group rules for 443 (and TURN ports if B).
4. Permission to run the Node process on that host.

No accounts, database, leaderboard or AMAX integration are needed for this
gate.

## 5. Acceptance for the public test

1. Two browsers on different networks join the same room code.
2. Both finish the 310 m race; results agree with the host.
3. Console 0; reconnect after a forced disconnect within 30 s.
4. RTT p50/p95 and loss recorded; no room-code collision or stale room.
5. The same build works on LAN if the VPS is unavailable.

## 6. Security / limits

- Room code + resume token only; no auth, anti-cheat or persistence.
- Host is the rules/result authority; clients send intents.
- No game assets are uploaded; each client uses its local game data.
- WSS only for the public host; plain WS is LAN-only.
- No full-game or retail-network claim.
