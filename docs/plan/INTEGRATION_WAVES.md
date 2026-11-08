# Integration waves — turning the PoC into a game

Status: active, 8 November 2026. Owner: main agent. This file lists the exact
edits to the shared `probes/e1-drive` tree, in order, with the contract each
patch depends on. One wave at a time; each wave ends with the full gate and a
commit. No wave starts while another owns `app.js`.

## Why waves and not parallel patching

`web/app.js` (~6k lines), `web/index.html` and the packet consumer are the only
shared files. Every feature below must touch them. Parallel agents would
overwrite each other, so the rule stays: **probes are parallel, the integration
tree is serial**.

## Wave 0 — land the current batch (V5)

- 25-car roster, ghosts, chunk rebuild, pin updates.
- Update `check_e1_poc.py` expectations (15 → 25 cars), `prop-collision-v2`
  geometry pin, material-manifest totals.
- Gate: `verify_e1_drive`, `verify_asset_probe --skip-build`, CTest, checker,
  one sprint capture per new car family, console 0.
- Commit: `feat(e1): integrate the batch 2 vehicle set`.

## Wave 1 — game shell (SHELL1 → e1-drive)

Files: `web/index.html` (mount points, remove the URL-only banner),
`web/app.js` (expose `window.E1` handles instead of const-only globals),
new `web/shell.js` + `web/shell.css` (from `probes/game-shell/`).

Contract:
- `E1.start({ carId, mapId, mode })` replaces boot-time URL parsing.
- URL parameters remain as deep links but are no longer required.
- Unsupported mode/map/car combinations are disabled with a visible reason.
- No reload when changing car or map (chunk loader already supports this).

Acceptance: from `/`, reach a 310 m race on River with a chosen car in ≤ 4
clicks; switch to Amboy and to lap mode without a reload; back/ESC restores
focus; console 0; `verify_e1_drive` green; one capture per screen.

## Wave 2 — multiplayer scale-out (NET1 → e1-drive)

Files: `web/app.js` (lobby UI, room capacity, ready rules), `net-mvp` client
imports, lobby markup in `index.html`.

Contract: `wss://` URL from the shell or the room code field; 2–8 slots; host
map select; AI count 0–7; typed rejection messages (no bare "start rejected").

Acceptance: 4 browser tabs (one machine) complete one race with 2 humans + 2 AI;
8-slot room creates and rejects the 9th with a typed error; reconnect mid-race;
console 0.

## Wave 3 — world solidity (PM1 → e1-drive)

Files: `web/app.js` (collider manifest load), `map-registry.js` (per-map
collider path), packet consumer unchanged.

Contract: per-map collider JSON with hash pin; missing manifest = typed error for
that map, never a silently empty world. Path clearance pre-verified by PM1.

Acceptance: driving into a visible silo/building on Amboy/Gracia stops the car;
the measured point-to-point path is still clear; 0 respawn on the reference run.

## Wave 4 — power-ups on every map (PWR6 → e1-drive)

Files: `web/app.js` (placement data load, host spawn list), `map-registry.js`.

Contract: per-map pickup list with type/position/yaw/group; host-authoritative;
client never spawns; SuperShield stays opt-in.

Acceptance: on Amboy and Gracia, a host + 1 guest collect and fire at least 4
distinct types; HUD slot updates; console 0.

## Wave 5 — real laps and modes (LM1 + MODE1 → e1-drive)

Files: `sprint-script.js` (layout selection), `web/app.js` (mode config),
`map-registry.js` (`courses` arrays).

Contract: mode id → rules config; lap layouts only where a closed loop is proven;
otherwise the map stays point-to-point with a visible label.

Acceptance: 2–3 lap race on any map that has a proven loop; checkpoint/destruction
modes only if MODE1 produced their rules and the map data supports them.

## Wave 6 — visual parity (MAT1 + CAM1 + HUD1 → e1-drive)

Files: `web/app.js` shader/material path, `web/hud.js`, camera block.

Contract: paint/light recipes from data only; camera parameters from CAM1 with
provenance tags; HUD elements marked retail-exact vs provisional.

Acceptance: Corvette 0–100 m capture at the PARITY1 poses; per-feature table
updated; no double-gamma regression (physics/packet hashes unchanged).

## Wave 7 — damage, AI weapons, audio (DMG1 + AI4 + AUDIO1 → e1-drive)

Files: `web/app.js` (health/wreck/respawn), host AI policy call, audio event map.

Acceptance: AI uses at least 3 weapon types; wreck → respawn invariant holds;
audio events fire once; determinism hashes stable.

## Wave 8 — map streaming and the remaining maps (STREAM1 + MAPC1 + LONG1)

Files: `web/app.js` loader, `map-registry.js`, new chunk fetch paths.

Acceptance: a map loads sector-by-sector; Longbeach reaches playable coverage or
ships with a typed partial label; the two blocked maps either unblock or are
documented as unsupported with byte evidence.

## Wave 9 — vehicle batch compiler (61 cars)

Files: `tools/` inside `probes/e1-drive`, roster/chunk/ghost builders.

Contract: one command takes a roster list and emits chunks, ghosts, pins and
captures; no per-car hand editing.

Acceptance: adding a car is a config line; 61/62 integrated with typed reasons
for the rest; page stays under the byte budget.

## Gate for every wave

```powershell
python tools/verify_asset_probe.py --skip-build
ctest --test-dir _work/build/asset-reader-native -C Release --output-on-failure
python tools/check_e1_poc.py
node probes/e1-drive/tools/verify_e1_drive.mjs
```

Plus: no console errors in the captured flow, hashes recorded in the wave's
verification doc, and `docs/handoff/CURRENT.md` updated.

## Definitions used in the waves

- **retail-exact:** value read from game data, with offset, and applied unchanged.
- **provisional:** value not serialized anywhere; documented, labelled in code and
  in the docs, and never presented as retail.
- **unsupported:** explicit typed failure with the byte position or source reason.
- **playable:** measured path + collision + spawn + finish, verified by a run.
