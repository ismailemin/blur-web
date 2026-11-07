# M1 — online race integration design (two browsers, one map)

Status: design, 7 November 2026. Depends on `probes/net-mvp/` (room service +
client transport) and the current e1-drive baseline (838/838).

## Goal

Two browsers open the same URL, join a room by code, pick a car, both ready,
race the existing `usa_la_river` 310 m course, see each other, and finish with a
shared result. No accounts, no database.

## URL and flow

```
/?mp=1&room=ABC123&host=1        host
/?mp=1&room=ABC123              second player
```

1. Page connects to the room service (same origin `/mp` WebSocket route or a
   documented `?mpServer=` origin).
2. Lobby: player list, car select, ready toggle, host marker.
3. Host presses start when all ready; the room broadcasts `start` with a start
   tick and the race settings (course `310`, car per player).
4. Both clients run the deterministic sprint; host is authoritative.
5. Finish: host broadcasts `result`; both overlays show positions/times.

## Authority and sync (first gate)

- **Host authoritative simulation.** Only the host's engine result is
  authoritative. Clients run the same deterministic step for their own car and
  send inputs; the host broadcasts a snapshot at 20 Hz.
- **Snapshot:** `{tick, seq, players:[{id, x,y,z, qx,qy,qz,qw, speed, stateHash}]}`.
- **Remote rendering:** the existing ghost draw path is reused for the remote
  car (same mesh; selected car per player if the body is already loaded, else
  the same car with a documented fallback). Interpolate between snapshots.
- **Correction:** if the local host position delta exceeds 0.5 m or 0.25 rad,
  hard-set; below that, blend over 3 ticks. Never teleport silently without a
  counter.
- **Input:** 60 Hz local, sent at 30 Hz with sequence; host applies the last
  input per player. Missing input holds the previous for at most 6 ticks.
- **Finish:** host validates the finish tick; clients accept the host result.
- **Reconnect:** room token resumes within 30 s; a returning client starts from
  the next snapshot and does not re-finish.

## Files (owned by the integration agent)

| File | Change |
|---|---|
| `probes/e1-drive/web/mp-client.js` (new) | room connect, lobby state, snapshot buffer, input send |
| `probes/e1-drive/web/mp-remote.js` (new) | remote car pose/interpolation, HUD tag |
| `probes/e1-drive/web/app.js` | `?mp=1` branch, lobby overlay, host start, snapshot apply, results |
| `probes/e1-drive/web/index.html` | lobby/room UI, player list |
| `probes/e1-drive/tools/serve.mjs` | serve `probes/net-mvp/` client and `/mp` proxy/route |
| `probes/e1-drive/tools/verify_e1_drive.mjs` | MP layout/room/snapshot/finish checks (Node harness) |
| `probes/e1-drive/tools/capture_browser.mjs` | `--mode mp`: two pages, join/start/finish |

`packet-consumer.js` reuse: the ghost pipeline already draws a second car with a
separate uniform slot; extend it to N remote slots (one per player) only after
the 2-player gate passes.

## Acceptance tests

1. Room: create/join by code, player list, ready, host start, leave.
2. Two headless pages, same course: both reach `finished`, host result equals the
   client result, both state hashes at start/finish match.
3. Remote car visible and within 0.5 m of the host pose at the sampled ticks.
4. Console 0 on both pages; screenshots of lobby, mid-race, finish.
5. Disconnect one page mid-race, reconnect within 30 s, race continues.
6. Determinism: host and client replay the same inputs to the same state hashes
   with the room layer disabled.
7. Existing 310/lap/free/audio/ghost gates unchanged.

## Explicit limits

- WebSocket transport (reliable/ordered) for M1; WebRTC unreliable channel is a
  later measured step.
- One map, the five current cars, one race mode. Power-ups are M2.
- No retail network protocol claim; this is an original room + snapshot layer.
- Cross-network NAT testing needs a reachable host and is the only expected
  manual step.
