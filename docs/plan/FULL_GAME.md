# Full game roadmap — from the E1 PoC to a multiplayer-testable build

Status: active plan, 7 November 2026. This is a plan, not a claim. Every milestone
below requires recorded evidence before it is marked done.

## 1. Baseline (what actually works today)

- **Engine:** wasm RacingPhysics on `usa_la_river/Level.levelphysics`, 5 roster
  cars, 60 Hz fixed step, deterministic state hashes.
- **Renderer:** WebGPU consumer of render packet v1.1; real track draws, car
  meshes and UV0/albedo, 18 textured level props (trucks/wrecks), camera
  occlusion, ghost replay.
- **Modes:** 310 m sprint (default), 29 m regression, 3-lap loop-01, free-roam
  (7,702 m²) with 431/447 solid props.
- **Audio:** six retail V8 engine loops driven by `Engine().RPM()`.
- **Gates:** `verify_e1_drive` 838/838, asset probe 31/31, CTest 15/15,
  `check_e1_poc.py` 23/23, captures console 0.
- **Missing for a game:** multiplayer transport/rooms, power-ups (weapons,
  mines, shields, nitro…), AI/opponents, other maps, the other 57 vehicles,
  menus/lobby/results, damage/respawn rules, full audio mix.

## 2. Definition of "multiplayer-testable"

A build where two browsers on different machines (or different tabs for the
local gate) can:

1. open the page, create/join a room with a short code;
2. pick a car and a map from the content that is actually available;
3. start together after a ready countdown;
4. see each other's cars moving with bounded correction;
5. finish the race with a shared result (positions, times, laps);
6. survive disconnect/reconnect and late join without a crash.

The first shipping target is **one map, all five current cars, two players**.
Content expands after that gate, not before.

## 3. Milestones

| Milestone | Scope | Acceptance evidence |
|---|---|---|
| **M0 Inventory** | All levels, all 62 vehicle records, all power-up entities audited | Content manifests + coverage matrices + verifier |
| **M0 Net** | Room server + two-client transport harness | 2 headless clients, join/ready/state/ack/reconnect, loss/latency test |
| **M1 Online race** | `?mp=1` in e1-drive: room, car select, start countdown, remote car state, finish | **DONE** — 874/874, two-browser capture, console 0, shared result |
| **M2 Power-ups** | Pickups, weapons, mines, shield, nitro, damage/respawn online | Rules prototype + 2-client event sync tests |
| **M3 Maps** | At least 3 additional maps with collision/road/draws | Per-map layout + capture + finish |
| **M4 Vehicles** | All 62 records: model/fields/textures or an explicit unsupported reason | Coverage matrix 62/62 classified |
| **M5 Game shell** | Lobby, car/map select, results, restart, reconnect, 4–8 players | Reproducible group session |

M1 is the critical path. M2/M3/M4 run in parallel only where file sets are
disjoint.

## 4. Workstreams and ownership

| Stream | Owns | Output |
|---|---|---|
| Net core | `probes/net-mvp/**`, `_work/net-mvp/**` | room server, client transport, tests |
| Net integration | `probes/e1-drive/**` (later) | `?mp=1`, remote cars, results |
| Content audit | `probes/full-content/**` | levels/cars/power-ups manifests |
| Maps | `probes/map-pipeline/**` | per-level physics/draw/road coverage |
| Vehicles | `probes/vehicle-pipeline/**` | 62-record coverage, missing data reasons |
| Power-ups | `probes/powerups/**` | definitions + rules prototype |
| Renderer/quality | `probes/e1-drive/web/**` | textures, effects, HUD |
| Audio | `probes/audio/**` | engine + tyre/collision mix |

Rules:

- One owner per file. Shared `e1-drive` files are main-agent owned; only one
  integration agent works there at a time.
- Agents that write probes never touch `_work/e1-drive` or run
  `verify_e1_drive`; the integration agent owns that gate.
- Capture ports are allocated per agent (`8801` user server, `8802+` agents) and
  each agent uses its own `edge-profile` / output prefix.
- No concurrent `verify_e1_drive` or `verify_asset_probe` runs. Data-only
  probes may run concurrently with each other.
- Every agent records commands, counts, hashes, screenshots and limits in a doc
  under `docs/work/analysis/` or `docs/work/verification/`.

## 5. Network architecture (first gate)

- **Room service:** small Node HTTPS/WebSocket service; room code, join/leave,
  ready, car/map selection, host assignment, signaling. No game assets.
- **Transport:** WebSocket for the first local gate (reliable, ordered). Add a
  second unordered/unreliable channel (WebRTC DataChannel) only after the
  packet budget is measured. Do not stack two reliability layers blindly.
- **Authority:** host-authoritative simulation first. The host runs the wasm
  step, broadcasts the authoritative input/state summary; clients run the same
  deterministic step and reconcile. This matches the existing deterministic
  state hashes; it is not a retail-protocol claim.
- **Sync:** 60 Hz input, 20–30 Hz state snapshots with sequence numbers,
  interpolation buffer, bounded correction; heartbeat and reconnect window.
- **Security:** room code + ephemeral token; no accounts, no database in M1.
- **Test:** two headless browser clients in one process on the same machine
  first, then two tabs, then two machines. Cross-network NAT testing needs the
  user's network; that is the only expected manual step and it comes after the
  local gate.

## 6. Content plan

- **Levels:** 19 directories are present (including `showroom` and multiplayer
  variants). The audit must classify each: physics file, collision mesh, road
  path, draw blocks, spawn, coverage. Do not promise all 19 until measured.
- **Vehicles:** 62 records in `cars.json`; only 5 have full fields/mesh/UV and
  proof. The audit classifies all 62 and lists missing data per car.
- **Power-ups:** Blur has weapons, mines, shields, nitro, repair, shock and
  boost variants. The definitions live in XT/gamedata; extract the entity
  schema and the state machine before simulating. Unknown behavior stays
  labelled, never guessed.
- **Maps/cars are local game data:** not committed. Builders must read
  `game-data/` and fail explicitly when a file is missing.

## 7. Risks and limits

- The retail C++ game logic (power-ups, AI, race director) is not ported; this
  plan builds an original rules layer from recovered definitions, not a retail
  binary claim.
- Full-engine WASM still has platform gaps recorded in T-005; the PoC uses the
  proven vehicle physics subset.
- Real cross-network multiplayer needs a reachable host/TURN and the user's
  network; local two-client play does not.
- "All maps/cars" may include assets that the proven readers cannot decode;
  those are reported as unsupported with the exact reason, not faked.

## 8. Immediate queue (this wave)

1. Content inventory (levels, 62 vehicles, power-ups).
2. Map pipeline audit (19 levels).
3. Vehicle pipeline audit (62 records).
4. Power-up extraction + rules prototype.
5. Net MVP: room server + two-client transport harness.

After the wave: integrate V2 prop colliders, finish texture quality, then M1
online race integration.
