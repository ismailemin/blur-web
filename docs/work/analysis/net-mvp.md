# Net MVP — room service and two-client state-sync gate

**Date:** 7 November 2026
**Status:** implementation + evidence. First working multiplayer transport gate
for the web project. This is an original project protocol, not a retail-protocol
claim; it is not integrated into `e1-drive`.
**Scope:** `probes/net-mvp/**`, `_work/net-mvp/**`, `_work/logs/net-mvp/**`.
No `e1-drive`, engine, `tools/`, other probe, `upstream/` or `game-data/` file
was modified. No commit was made by this subagent.

Scope labels: `engineIntegration:false`, `retailProtocol:false`,
`webrtc:false`, `turn:false`, `accounts:false`, `database:false`,
`gameAssets:none`, `gameImplemented:false`, `realNetwork:none`,
`browserClients:2`, `nodeClientsUpTo:4`.

---

## 0. Result summary

| Gate | Result | Evidence |
|---|---|---|
| Fast unit + typed-error paths | **PASS 22/22** | `_work/net-mvp/selftest.json` |
| 4 Node clients, 30 s race | **PASS 21/21 checks** | `_work/net-mvp/harness-report.json` |
| Deterministic repeat hash | **same hash in two full runs** | `harness-report-final.json`, `harness-report-repeat.json` |
| 2 browser iframes, 30 s race | **PASS; console 0** | `_work/net-mvp/browser-evidence.json` |
| Browser repeat hash | **same hash in two full runs** | `browser-evidence-run1.json`, `browser-evidence-run2.json` |
| Reconnect/resume | **same player id, host stable, 1 reconnect** | harness report `reconnect`, `sequences` |
| No duplicate/out-of-order application | **0 violations; applied count == last seq** | harness report `sequences` |
| npm dependencies | **none** (Node built-ins only) | imports in `probes/net-mvp/*.mjs` |

Final Node harness hash:

```text
sha256:a3a1537519c354cee8f3555f906e19e007ec051334ce591c1c0561c7f266874e
```

Final browser harness hash:

```text
sha256:a6c2522716427fcabbb8bc81833d1972a51ef8c00523d06ff150140391456e32
```

The two hashes differ because the harnesses use different seeds
(`blur-net-mvp-harness-v1` vs `blur-net-mvp-browser-v1`) and client counts
(4 vs 2). Each harness's own clients agree exactly.

---

## 1. What was built

```text
probes/net-mvp/
  server.mjs       HTTP static server + minimal RFC 6455 WebSocket server
                   + in-memory room service
  client.mjs       NetClient + OrderedStream + InterpolationBuffer
                   + BoundedCorrector + LossLatencyImpairment
  protocol.mjs     wire constants, validation, quantization, typed NetError
  hash.mjs         dependency-free SHA-256 + canonical JSON
  race.mjs         deterministic synthetic state/input/final hash
  harness.mjs      2–4 Node clients, 30 s, impairment + reconnect + checks
  selftest.mjs     22 fast unit/negative-path checks
  capture.mjs      headless Edge 2-iframe capture + console gate
  web/             index.html (parent), solo.html/solo.js (one client each),
                   visible state readout, style.css
  README.md        usage, protocol, API, limits
```

Outputs: `_work/net-mvp/`, logs: `_work/logs/net-mvp/`.

### 1.1 Room service

* **HTTP static** for `probes/net-mvp/web` plus `/client.mjs`, `/protocol.mjs`,
  `/hash.mjs`, `/race.mjs`. No directory listing; path-escape check; `no-store`.
* **Minimal RFC 6455 WebSocket** on `/ws`: HTTP upgrade with SHA-1 accept,
  masked client frames, text frames, fragmentation/continuation, ping/pong,
  close frames, 64 KiB message cap, binary frames rejected with 1003. No
  extensions, no compression, no third-party package.
* **Rooms:** 5-character code from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
  (no I/O/0/1), create/join, host = first player, slot = join order, roster,
  ready, host-only start, per-player car, host-only map, room phase
  `lobby → running → finished`.
* **Heartbeat:** server `heartbeat` every 1 s; client `ping`/`pong`; stale
  socket closed after 5 s without traffic.
* **Disconnect/resume:** socket loss marks `connected:false` but keeps the
  player for 30 s. A `room.join` with the 24-byte hex `resumeToken` restores the
  same id/slot/host/ready/car. Expiry removes the player and promotes the
  earliest connected slot if the host expired (promotion exists; not exercised
  by the acceptance harness).
* **Limits:** 8 players hard cap (default 4), 64 rooms, 64 KiB messages,
  2000 messages/s/socket, 2 h room TTL. In-memory only.

### 1.2 Client library

`client.mjs` has no Node imports and uses only global `WebSocket`,
`TextEncoder`/`TextDecoder` and timers. It exposes:

* typed `NetError` for every rejection (`NET_ROOM_NOT_FOUND`, `NET_ROOM_FULL`,
  `NET_ROOM_STARTED`, `NET_NOT_HOST`, `NET_NOT_READY`, `NET_RESUME_UNKNOWN`,
  `NET_RESUME_IN_USE`, `NET_NOT_CONNECTED`, `NET_TIMEOUT`, `NET_RATE_LIMIT`,
  `NET_BUFFER_OVERFLOW`, `NET_RESYNC_RANGE`, `NET_FINAL_MISSING`, …);
* input at caller-selected 60 Hz and state at caller-selected 20 Hz, with
  per-sender sequence numbers and a bounded sender cache;
* `OrderedStream`: `seq == last+1` applies; a future sequence is buffered but
  **not applied**; duplicates are counted and dropped; buffer overflow is an
  error; `appliedSeqCount == lastApplied` and `violations == 0` by construction;
* ack for every applied message; `resync` request on a gap; sender replays from
  its 5 s / 600-message cache; unrecoverable range is `NET_RESYNC_RANGE`;
* `stream.final` target and a wait-for-convergence helper;
* `InterpolationBuffer`: position lerp, quaternion slerp, no extrapolation;
  outside the buffer it returns the nearest sample with `clamped:true`;
* `BoundedCorrector`: at most `maxPositionSpeed` m/s and `maxAngularSpeed` rad/s;
* heartbeat, dead-socket detection and resume via the room token; the application
  sequence continues across the new socket;
* `stats()` with sent/received/applied counts, per-stream sequence state,
  duplicates, out-of-order buffered, retransmits, RTT percentiles, impairment
  counters and reconnect counters.

### 1.3 Deterministic synthetic race

No game assets and no engine physics are used. For a given
`(seed, slot, car, tick)` the state is:

```text
tick      absolute race tick (1..1800 at 60 Hz)
position  straight x from the E1 spawn area, deterministic lane/z and y
quaternion normalized (0, s, 0, 1), s from an integer sequence
speed     deterministic base + small integer-sequence term
```

Only IEEE-754 `+ - * / %` and `Math.sqrt` are used; no `Math.sin/cos/atan2`, so
Node and Edge agree bit-for-bit. Values are quantized to 1e-6 before transmission
and hashing. Inputs are `{throttle,brake,steer,handbrake}` in `[-1,1]`.

The final hash is canonical JSON → SHA-256 over
`{kind,version,seed,tick,players:[{slot,car,tick,position,quaternion,speed}]}`,
sorted by slot. It excludes the random room code, player id and sequence number.
That is why two clean runs with the same seed produce the same hash; sequence
convergence is checked separately.

---

## 2. Protocol

JSON text frames. Requests carry `requestId`; replies echo it. Errors are typed:

```json
{ "type":"error", "code":"NET_NOT_HOST", "message":"only the host can start",
  "requestId":"rq_4", "detail":null, "fatal":false }
```

### 2.1 Client → server

| type | fields |
|---|---|
| `ping` | `id,t` |
| `room.create` | `name,maxPlayers,map,car` |
| `room.join` | `code,name,car?,resumeToken?` |
| `room.leave` | — |
| `player.ready` | `ready` |
| `player.select` | `car?,map?` |
| `room.start` | `seed?` |
| `input` | `channel:'input',seq,tick,input` |
| `state` | `channel:'state',seq,tick,state` |
| `ack` | `channel,to,seq,sentAt` |
| `resync` | `channel,to,fromSeq` |
| `stream.final` | `channel,lastSeq,tick` |
| `stream.error` | `channel,to,code,detail` |
| `client.finished` | `tick,hash` |

### 2.2 Server → client

| type | fields |
|---|---|
| `welcome` | `protocol:1,schema:'blur.net-mvp/1',connectionId,heartbeatMs,resumeWindowMs` |
| `room.created` / `room.joined` | `room,you,resumed?` |
| `room.state` | `room` |
| `room.started` | `room,startTick,seed,tickHz:60` |
| `room.finished` | `room,results` |
| `state` / `input` | `from,channel,seq,tick,sentAt,authority,state?/input?` |
| `ack` / `resync` | targeted sync control |
| `stream.final` | broadcast final target |
| `stream.error` | targeted range failure |
| `player.joined/resumed/disconnected/left/finished` | ids |
| `heartbeat` / `pong` | `serverTime` |
| `ok` | `requestId,action` |
| `error` | typed rejection |

Room snapshot:

```json
{ "code":"ABCDE", "phase":"lobby|running|finished", "hostId":"pl_…",
  "map":"usa_la_river", "maxPlayers":4, "seed":"…", "startTick":1, "tickHz":60,
  "players":[ { "id":"pl_…", "slot":1, "name":"Host", "car":"…",
                "ready":true, "connected":true, "host":true, "resumedCount":0 } ] }
```

`you` additionally carries `resumeToken`. It is never included in another
player's view.

### 2.3 Room / join / start flow

```text
connect → welcome
room.create → room.created (host, slot 1, code, resumeToken)
room.join (lobby only) → room.joined + room.state broadcast
player.ready × N → room.state
room.start (host, all connected ready) → room.started {startTick:1, seed, 60 Hz}
input 60 Hz / state 20 Hz → server relays to other connected players
receiver: seq==last+1 apply else buffer; ack; gap → resync; sender replays cache
final tick: stream.final broadcast → wait targets → final table → SHA-256
client.finished × N → room.finished {results}
socket loss → connected:false + resume token valid 30 s
room.join {resumeToken} → same player id/slot/host; sequences continue
expiry → remove player; promote earliest connected slot if host
```

---

## 3. Harness results (Node, 4 clients, 30 s)

Command:

```powershell
node probes/net-mvp/harness.mjs
```

Config: 4 clients (Host + 3), seed `blur-net-mvp-harness-v1`, 30 s = tick 1800,
input 1800 messages/client, state 600 messages/client, forced disconnect at
15 s, 1% loss + 80 ms latency on **Bravo's outbound state channel only**.
Control (`ack`/`resync`/`final`) is not impaired, so recovery is measurable.

### 3.1 Checks

All 21 true:

```text
playerCount, roomCodeMatch, hostStable, hashMatch, finalTick,
sequenceComplete, streamsConverged, appliedPayloadMatchesDeterministic,
reconnectResumed, reconnectSamePlayer, lossInjected, latencyObserved,
noDuplicateApplication, hostAuthoritySequence, noAsyncErrors,
noListenerErrors, noSendErrors, expectedMessageCounts,
heartbeatObserved, ackObserved, roomPhaseFinished
```

(`expectedMessageCounts` checks 600 state + 1800 input per client;
`heartbeatObserved` checks control ping/pong samples; `ackObserved` checks state
ack samples; `roomPhaseFinished` checks the room broadcast was received.)

### 3.2 Counts

| client | sent state | sent input | received state | received input | duplicate (not applied) | out-of-order buffered | retransmits |
|---|---:|---:|---:|---:|---:|---:|---:|
| Host | 600 | 1800 | 1800 | 5400 | 372 | 30 | 22 |
| Bravo (impaired) | 600 | 1800 | 1800 | 5400 | 0 | 0 | 339 |
| Charlie | 600 | 1800 | 1800 | 5400 | 372 | 30 | 22 |
| Delta | 600 | 1800 | 1800 | 5400 | 372 | 30 | 22 |

`received state = 3 senders × 600`; `received input = 3 × 1800`. Duplicate counts
come from resync replays after Bravo's 9 injected state drops; they are **counted
and dropped, not applied**. `out-of-order buffered` messages were held until the
gap was filled. The exact duplicate/buffered/retransmit counts vary with resync
timing between runs; the applied-sequence invariants below do not. Every stream:

```text
target = 600, lastApplied = 600, appliedSeqCount = 600, violations = 0
```

for every receiver/sender pair. This is the authoritative-sequence convergence
check (`hostAuthoritySequence` also verifies the host stream specifically).

### 3.3 Loss, latency, reconnect

| measurement | value |
|---|---|
| state packets dropped by the 1% impairment | **9** (of 600 Bravo states) |
| state packets delayed 80 ms | **930** (includes resync replays) |
| Bravo state RTT p50 / p95 | **94.4 / 141.2 ms** |
| Bravo state RTT max | 563 ms (old cached replay) |
| unimpaired state RTT p50 / p95 | ~0.7–0.8 / ~1.1–1.2 ms |
| control RTT p50 | ~0.19–0.37 ms |
| reconnect | 1 forced drop, 1 resume, same player id, 1 reconnect |
| room after resume | 4 players, host unchanged |
| async/listener/send errors | 0 |

The 80 ms channel is visible in Bravo's state RTT (80 ms outbound + ack path).
Resync replays occasionally produce a long-tail RTT; that is a measurement of
the recovery path, not the steady-state latency.

### 3.4 Applied-data integrity

Each client independently compared every applied message with the deterministic
expected value for the sender's slot/car/tick:

```text
Host    states 1800, mismatches 0, inputs 5400, input mismatches 0
Bravo   states 1800, mismatches 0, inputs 5400, input mismatches 0
Charlie states 1800, mismatches 0, inputs 5400, input mismatches 0
Delta   states 1800, mismatches 0, inputs 5400, input mismatches 0
```

### 3.5 Server counters

```text
connections 5 (4 initial + 1 resume)
messagesIn 39010, messagesOut 59121, messagesRelayed 58813
protocolErrors 0, roomsCreated 1, roomsFinished 1
resumes 1, disconnects 1, expiredPlayers 0, maxPlayersSeen 4
```

### 3.6 Determinism

Two full 30 s runs (each in a fresh process and room) produced the same final
hash:

```text
run A  sha256:a3a1537519c354cee8f3555f906e19e007ec051334ce591c1c0561c7f266874e
run B  sha256:a3a1537519c354cee8f3555f906e19e007ec051334ce591c1c0561c7f266874e
elapsedMs 30517
```

Evidence: `_work/net-mvp/harness-report-final.json`,
`_work/net-mvp/harness-report-repeat.json`.

---

## 4. Browser harness (two iframes, 30 s)

Command:

```powershell
node probes/net-mvp/capture.mjs
```

* Server on port **8810**; Edge debug port 9345; profile
  `_work/net-mvp/edge-profile-8810` (deleted and recreated per run).
* Parent `index.html` creates the host iframe, receives its room code, then
  creates the guest iframe with that code. Host starts when both are ready.
* Each iframe joins/readies, sends input at 60 Hz and state at 20 Hz, applies
  remote state with sequence checks/interpolation, and exposes a visible readout
  (room, player, host, car/map, phase, tick, seq sent/applied, dedup/out-of-order,
  RTT, interpolation sample, final hash, error).
* The capture waits for a mid-race frame and for both clients to finish; it
  fails on any `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` or
  `Log.entryAdded`, any page-recorded error, hash mismatch or wrong tick.

### 4.1 Result

```text
room 566WY (random per run), seed blur-net-mvp-browser-v1, tick 1800 / 1800
host  hash sha256:a6c2522716427fcabbb8bc81833d1972a51ef8c00523d06ff150140391456e32
guest hash sha256:a6c2522716427fcabbb8bc81833d1972a51ef8c00523d06ff150140391456e32
```

| client | sent state | sent input | received state | received input | duplicate | out-of-order | violations |
|---|---:|---:|---:|---:|---:|---:|---:|
| Host | 600 | 1800 | 600 | 1800 | 0 | 0 | 0 |
| Guest | 600 | 1800 | 600 | 1800 | 0 | 0 | 0 |

State RTT p50/p95: host 0.9/1.5 ms, guest 0.7/1.1 ms (loopback, no impairment in
the browser case). Applied-state verification: 600 remote states checked per
client, 0 mismatches; 0 input mismatches.

Console: **0** messages. Page-recorded errors: **0**. Both iframes report
`phase:"finished"`.

Browser: Microsoft Edge headless `Edg/156.0.0.0` on Windows NT 10.0 x64
(`navigator.userAgent`, recorded in `browser-evidence.json`).

Two full browser runs produced the same hash
(`browser-evidence-run1.json`, `browser-evidence-run2.json`).

### 4.2 Screenshots

| file | content |
|---|---|
| `_work/net-mvp/browser-two-clients-mid.png` | both clients mid-race, tick ~312, visible state readout |
| `_work/net-mvp/browser-two-clients-finish.png` | both clients finished, tick 1800, matching hashes, PASS banner |
| `_work/net-mvp/browser-host-finish.png` | host iframe crop |
| `_work/net-mvp/browser-guest-finish.png` | guest iframe crop |

The finish screenshot is the browser evidence required by `AGENTS.md`; the
console gate is `consoleClean:true,pageMessagesClean:true`.

---

## 5. Fast self-test

Command:

```powershell
node probes/net-mvp/selftest.mjs
```

22/22 pass. It covers SHA-256 known vectors, canonical JSON/hash key order, room
code rules, state/input validation, quantization stability, ordered-stream gap
buffering/duplicate/overflow, interpolation/clamping, bounded correction, final
hash slot order/tick binding, and live room rejections:

* host map selection and player car selection accepted;
* duplicate join → `NET_ALREADY_IN_ROOM`;
* unknown room → `NET_ROOM_NOT_FOUND`;
* unknown resume token → `NET_RESUME_UNKNOWN`;
* non-host map select → `NET_NOT_HOST`;
* non-host start → `NET_NOT_HOST`;
* join after start → `NET_ROOM_STARTED`;
* forced drop/resume preserves player id, room and `phase:'running'`;
* state/input send works while running.

Evidence: `_work/net-mvp/selftest.json`.

---

## 6. API the `e1-drive` integration will consume

```js
// The probe serves the module at /client.mjs. The final import specifier is
// integration-owned (copy or serve the file from the e1-drive web tree).
import { NetClient, NetError } from '/client.mjs';

const net = new NetClient({
  url: 'ws://127.0.0.1:8810/ws',
  name: 'Player',
  autoReconnect: true
  // test-only option: impairment: { lossRate, latencyMs, seed }
});

const welcome = await net.connect();          // protocol/schema/heartbeat info

// Host
const { room, you } = await net.createRoom({
  name: 'Host', maxPlayers: 4, map: 'usa_la_river', car: 'corvette-zr1-stock'
});
// Guest
const joined = await net.joinRoom({ code, name: 'Guest', car: 'lotus-exige-cup260' });
// Resume (the reconnect path does this automatically)
// await net.joinRoom({ code, name, resumeToken });

await net.setReady(true);
await net.select({ car: 'audi-r8v10-stock' });   // map / host only
const started = await net.start({ seed: 'optional-test-seed' });

net.on('room', ({ room, you, resumed }) => {});
net.on('started', ({ startTick, seed, tickHz }) => {});
net.on('stateApplied', ({ from, seq, tick, state, authority }) => {});
net.on('inputApplied', ({ from, seq, tick, input }) => {});
net.on('finished', ({ room, results }) => {});
net.on('resumed', ({ room, you }) => {});
net.on('error', (netError) => {});               // typed; never ignore

// engine fixed step, 60 Hz:
net.sendInput({ throttle: 1, brake: 0, steer: 0.1, handbrake: 0 }, tick);
// snapshot step, 20 Hz:
net.sendState({ tick, position: [x, y, z], quaternion: [x, y, z, w], speed });

// remote display:
const view = net.sampleRemote(remotePlayerId, renderTick); // lerp + slerp
const latest = net.latestRemote(remotePlayerId);

// bounded correction, no teleport:
const corrector = net.correctorFor(remotePlayerId, {
  maxPositionSpeed: 2.5, maxAngularSpeed: 2
});
const step = corrector.correct(latest.state, dt);

// finish:
net.finalizeStreams();
await net.waitForStreams(10000);
const table = net.buildFinalTable(1800);
await net.reportFinished({ tick: 1800, hash });

net.stats();
net.close();
```

What integration still has to provide:

1. A real engine snapshot → `{tick, position, quaternion, speed}` extraction.
   The e1-drive native snapshot already exposes position and body axes; the
   quaternion conversion can reuse the existing `quaternionFromAxes` approach,
   but that file is owned by the main agent and was not touched here.
2. A remote-car renderer that consumes `sampleRemote` and applies
   `BoundedCorrector` to its display pose.
3. Host-authoritative correction rules (the gate only marks host messages with
   `authority:true` and verifies host sequence convergence).
4. A room/lobby UI and car/map selection wiring.
5. WebRTC/STUN/TURN if the transport is moved off a local WebSocket relay.

---

## 7. Reproduction

```powershell
node probes/net-mvp/selftest.mjs
node probes/net-mvp/harness.mjs
node probes/net-mvp/capture.mjs
```

Short smoke variants:

```powershell
node probes/net-mvp/harness.mjs --seconds 3 --reconnect-at 1
node probes/net-mvp/harness.mjs --players 2 --seconds 2 --reconnect-at 0.5
node probes/net-mvp/capture.mjs --seconds 3
```

Both short harness variants passed during development. The 2-player run
(`--players 2`) covers the exact "server + 2 clients" acceptance case; the
default 4-player run is the harder sequence/impairment case.

Manual:

```powershell
node probes/net-mvp/server.mjs --port 8810
# open http://127.0.0.1:8810/
```

No `npm install`; no game data; no `upstream/` write; no `_work/e1-drive` touch.

---

## 8. Limits and non-claims

* **Reliable/ordered WebSocket, not UDP.** The 1% loss / 80 ms latency is
  injected in `client.mjs` on one outbound state channel. The real socket is
  loopback TCP. This gate does not measure SCTP, WebRTC or WAN behavior.
* **No WebRTC/STUN/TURN.** Same machine only; no NAT traversal test.
* **No engine or game.** The race is a deterministic synthetic function of
  `(seed, slot, car, tick)`, not Blur physics, not retail state.
* **No retail protocol claim.** Message names, fields and codes are project
  definitions. The E1-shaped snapshot is the only borrowed shape.
* **Host authority is a flag + sequence target**, not an authoritative
  simulation. Host migration code exists but was not exercised.
* **Browser test uses two iframes in one headless Edge process**, not two
  machines or two tabs on different profiles.
* **Resume/cache bounds:** 30 s resume window; sender cache ~5 s / 600 messages;
  older resync is `NET_RESYNC_RANGE` and fails explicitly. Late join while
  running is rejected (`NET_ROOM_STARTED`).
* **Rate/queue bounds:** 64 KiB message, 2000 messages/s/socket, 128 pending
  sequences per stream, 8 players, 64 rooms. Overflow is an error, not a drop.
* **No TLS/auth/accounts/database.** Room code is a lookup key, not an
  authorization secret. Local `ws://` only.
* **`buffer`/clock assumptions:** both browser clients share one machine clock;
  cross-machine clock skew is not tested. Game timing remains the caller's
  fixed-step clock; the room service heartbeat is only liveness.
* **Untested:** host expiry/promotion, room TTL, rate-limit response under a
  malicious flood, 60 s+ soak, 3–4 browser clients, mobile browsers.
* **No e1-drive integration and no `verify_e1_drive` run.** The main agent owns
  that gate.

---

## 9. Files and evidence

Committed-code candidate (all new):

```text
probes/net-mvp/server.mjs
probes/net-mvp/client.mjs
probes/net-mvp/protocol.mjs
probes/net-mvp/hash.mjs
probes/net-mvp/race.mjs
probes/net-mvp/harness.mjs
probes/net-mvp/selftest.mjs
probes/net-mvp/capture.mjs
probes/net-mvp/README.md
probes/net-mvp/web/index.html
probes/net-mvp/web/app.js
probes/net-mvp/web/solo.html
probes/net-mvp/web/solo.js
probes/net-mvp/web/style.css
```

Evidence (ignored by Git):

```text
_work/net-mvp/selftest.json
_work/net-mvp/selftest-final.json
_work/net-mvp/harness-report.json
_work/net-mvp/harness-report-final.json
_work/net-mvp/harness-report-repeat.json
_work/net-mvp/harness-report-run1.json
_work/net-mvp/harness-report-run2.json
_work/net-mvp/browser-evidence.json
_work/net-mvp/browser-evidence-final.json
_work/net-mvp/browser-evidence-run1.json
_work/net-mvp/browser-evidence-run2.json
_work/net-mvp/browser-two-clients-mid.png
_work/net-mvp/browser-two-clients-finish.png
_work/net-mvp/browser-host-finish.png
_work/net-mvp/browser-guest-finish.png
_work/logs/net-mvp/harness.log
_work/logs/net-mvp/browser.log
```

---

## 10. Next integration step (not in this task)

The first `e1-drive` change should be a small, main-agent-owned adapter that:

1. creates `NetClient` with the page's `ws://` room URL;
2. maps the engine tick to `sendInput` at 60 Hz and a snapshot to `sendState`
   at 20 Hz;
3. draws remote cars from `sampleRemote` and applies `BoundedCorrector`;
4. uses the room roster/car selection as the lobby state;
5. runs two browsers on `?mp=1` and verifies the same final-tick hash shape
   with real `usa_la_river` physics.

That step is out of scope here; this probe deliberately stops before touching
`probes/e1-drive/**`.
