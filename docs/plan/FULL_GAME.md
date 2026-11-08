# Full game roadmap — from the E1 PoC to a multiplayer-testable build

Status: active plan, 8 November 2026. This is a plan, not a claim. Every milestone
below requires recorded evidence before it is marked done.

## 1. Baseline (what actually works today)

- **Engine:** wasm RacingPhysics on `usa_la_river/Level.levelphysics`, 15 roster
  cars integrated (25 in flight), 60 Hz fixed step, deterministic state hashes.
- **Renderer:** WebGPU consumer of render packet v1.1; real track draws, per-car
  meshes and UV0/albedo, sRGB + mip chain, 18 textured level props, camera
  occlusion, ghost replay.
- **Modes:** 310 m sprint (default), 29 m regression, 3-lap loop-01, free-roam
  with solid props; Amboy (2,060.6 m) and Gracia (624.9 m) point-to-point; MP map
  selection (River/Amboy/Gracia).
- **Audio:** six retail V8 engine loops plus 53 tyre/collision waves.
- **Multiplayer:** 2 humans + 0–3 host-simulated AI, room codes, 20 Hz snapshots,
  shared results, reconnect. Local/LAN only.
- **Power-ups:** 8 of 9 types host-authoritative on River (Bomb, Shield, Repair,
  Nitrous, Shock, Blindfire, Shunt, Barge); SuperShield recovered as a project
  extension.
- **Missing for a game:** game shell (menu/car/map select), 47 of 62 cars, 16 of
  19 maps, map prop collision outside River, real laps outside River, power-up
  placement outside River, retail paint/light materials, normals/shadows,
  instances/decals, retail HUD, damage model, full audio mix, internet transport.

## 2. Definition of "multiplayer-testable"

A build where two or more browsers on **different machines** can:

1. open one URL and reach a main menu — no hand-written query strings;
2. create/join a room with a short code;
3. pick a car and a map from the content that is actually available;
4. start together after a ready countdown;
5. see each other's cars moving with bounded correction;
6. use the power-ups placed on that map, with a correct health/damage state;
7. finish with a shared, host-authoritative result (positions, times, laps);
8. survive disconnect/reconnect and late join without a crash;
9. see a consistent HUD (speed, lap/position, power-up slot, damage).

The gate is **one map + all integrated cars + 2–8 players + power-ups + a real
lap**, then content expands. No milestone is claimed without a reproducible
command, a recorded result and a clean console.

## 3. Milestones

| Milestone | Scope | Acceptance evidence |
|---|---|---|
| **M0 Inventory** | All levels, all 62 vehicle records, all power-up entities audited | Content manifests + coverage matrices + verifier |
| **M0 Net** | Room server + multi-client transport harness | 4–8 headless clients, join/ready/state/ack/reconnect, loss/latency test |
| **M1 Online race** | Room, car select, start countdown, remote car state, finish | **DONE** — 874/874, two-browser capture, console 0, shared result |
| **M2 Power-ups** | Pickups, weapons, mines, shield, nitro, damage/respawn online | **PARTIAL** — 8 types on River; all-map placement + damage model in flight |
| **M3 Maps** | Every map that the proven readers can decode, with props and a lap | Per-map layout + collision + capture + finish |
| **M4 Vehicles** | All 62 records: model/fields/textures or an explicit unsupported reason | Coverage matrix 62/62 classified, all drivable |
| **M5 Game shell** | Menu, lobby, car/map select, results, restart, reconnect, 4–8 players | Reproducible group session, no URL editing |
| **M6 Parity slice** | Corvette ZR1 + River 0–100 m, 4 fixed cameras, retail comparison | Per-feature match/partial/missing table |

## 4. Workstreams and ownership

| Stream | Owns | Output |
|---|---|---|
| Net core | `probes/net-mvp/**` | room server, WSS/TLS, 8-player transport, deploy bundle |
| Net integration | `probes/e1-drive/**` (one owner) | `?mp=1`, remote cars, results, lobby wiring |
| Content audit | `probes/map-pipeline/**` | level/car/power-up coverage, blocked-map proof |
| Maps | `probes/map-slice/**` | per-level physics/draw/road/textures |
| Map props | `probes/map-props/**` | per-map static colliders + path clearance |
| Map laps | `probes/map-laps/**` | closed-loop search per map |
| Map streaming | `probes/map-stream/**` | sector chunks, load order |
| Vehicles | `probes/vehicle-pipeline/**` | 62-record coverage, batch staging |
| Vehicle materials | `probes/car-materials/**` | paint/light recipes, runtime material data |
| Power-ups | `probes/powerups/**` | definitions, rules, placement on all maps |
| Damage | `probes/damage/**` | health/wreck/respawn model |
| Game modes | `probes/race-rules/**` | mode catalogue + rules layer |
| AI | `probes/ai-driver/**` | drivers, profiles, power-up policy |
| Camera | `probes/camera/**` | retail camera parameters |
| Renderer/quality | `probes/e1-drive/web/**` | textures, materials, HUD, shell |
| HUD | `probes/hud/**` | HUD art/layout/state bindings |
| Game shell | `probes/game-shell/**` | menu/lobby/select module |
| Audio | `probes/audio/**` | full event catalogue and mix |
| Parity | `probes/retail-parity/**` | audit, camera poses, retail protocol |

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

## 5. Network architecture

- **Room service:** small Node HTTPS/WebSocket service; room code, join/leave,
  ready, car/map selection, host assignment. No game assets.
- **Transport:** WebSocket for the local/LAN gate; WSS for internet. Add an
  unordered/unreliable channel (WebRTC DataChannel) only after the packet budget
  is measured. Do not stack two reliability layers blindly.
- **Authority:** host-authoritative simulation. The host runs the wasm step and
  broadcasts snapshots; clients interpolate and reconcile. This matches the
  existing deterministic state hashes; it is not a retail-protocol claim.
- **Sync:** 60 Hz input, 20–30 Hz snapshots with sequence numbers, interpolation
  buffer, bounded correction, heartbeat and reconnect window.
- **Scale:** room capacity 2–20 (default 8); measure bandwidth per peer before
  promising a number.
- **Security:** room code + ephemeral token; TLS only; no accounts, no database.
- **Deploy:** Docker/systemd/Caddy or Cloudflare Tunnel; the user supplies the
  host and domain. Everything else must be automated.

## 6. Content plan

- **Levels:** 19 directories exist (including `showroom` and multiplayer
  variants). Classify each: physics file, collision mesh, road path, draw blocks,
  props, spawn, coverage. Do not promise all 19 until measured; a blocked map
  ships with the exact missing stream.
- **Vehicles:** 62 records in `cars.json`. A batch compiler turns a roster list
  into chunk + ghost + capture + verify, so adding a car is a config line, not
  an agent. 61/62 are proven reachable; the remaining one is typed unsupported.
- **Power-ups:** 8 MP types plus the SuperShield extension. Placement is retail
  data projected onto the measured path; provisional values are labelled.
- **Maps/cars are local game data:** not committed. Builders read `game-data/`
  and fail explicitly when a file is missing.

## 7. Risks and limits

- The retail C++ game logic is not ported; this plan builds an original rules
  layer from recovered definitions, not a retail binary claim.
- Full-engine WASM still has platform gaps recorded in T-005; the PoC uses the
  proven vehicle physics subset.
- Real cross-network multiplayer needs a reachable host/TLS; local two-client
  play does not.
- "All maps/cars" may include assets the proven readers cannot decode; those are
  reported as unsupported with the exact reason, not faked.
- Retail parity is a vertical slice, not a whole-game claim; it is measured only
  against user-captured retail frames.

## 8. Current wave (8 November 2026)

| Agent | Area | Scope |
|---|---|---|
| V5 | `probes/e1-drive` | batch 2 → 25 cars, ghosts, pins |
| PM1 | `probes/map-props` | Amboy/Gracia prop colliders |
| LM1 | `probes/map-laps` | Amboy/Gracia closed-loop search |
| PARITY1 | `probes/retail-parity` | 1:1 audit + retail capture protocol |
| NET1 | `probes/net-mvp` | WSS/TLS, 8 players, deploy bundle |
| PWR6 | `probes/powerups` | pickup placement on Amboy/Gracia |
| MAPC1 | `probes/map-pipeline` | blocked-map proof, 19-map ranking |
| MAT1 | `probes/car-materials` | paint/light recipes |
| AUDIO1 | `probes/audio` | full event/audio catalogue |
| HUD1 | `probes/hud` | retail HUD art/layout |
| SHELL1 | `probes/game-shell` | menu/lobby/select module |
| AI4 | `probes/ai-driver` | AI power-up policy |
| MODE1 | `probes/race-rules` | retail mode catalogue |
| CAM1 | `probes/camera` | retail camera parameters |
| DMG1 | `probes/damage` | health/wreck/respawn model |
| STREAM1 | `probes/map-stream` | sector chunking |

After this wave the main agent integrates in this order: 25-car roster → shell →
net 8-player → prop colliders → power-up placement → material/HUD/camera →
damage/modes/AI policy → map streaming → parity slice.
