# Game shell — menu, garage, lobby, results

Status: design, 7 November 2026. The PoC is URL-driven; a game needs a shell
around the same engine, without changing physics or the map/car packages.

## 1. Front end flow

```
BOOT (asset check)
  -> MAIN MENU
       Play Solo  -> MAP SELECT -> CAR SELECT -> LOADING -> RACE -> RESULTS
       Play Online -> LOBBY (create/join) -> CAR/MAP SELECT -> READY -> RACE -> RESULTS
       Garage (cars + stats)
       Settings (audio, steering, camera)
       Credits / build info
```

- Keyboard/gamepad navigation; the existing keys stay as shortcuts.
- Every screen has a deep link equivalent (the current `?car=`, `?map=`,
  `?course=`, `?mp=`), so tests and the capture tools can bypass the menus.

## 2. Screens

| screen | content | data source |
|---|---|---|
| Boot | loading bar, package hashes, error panel | map registry + car roster |
| Main | title, music/engine ambience, version | static + build info |
| Map select | 3 maps with measured length, coverage, package size, load state | map registry |
| Car select | 15 cars, class/drivetrain/mass, best time per map | roster + localStorage |
| Lobby | room code, players, host, ready, car/map, connection | room state |
| Loading | map package + selected car, progress | chunks |
| Race | existing HUD, power-up HUD, MP remote tag | engine |
| Results | positions, total/best lap, DNF, rematch | R1 ResultModel |
| Garage | car model viewer, stats, texture/diagnostic counts | car chunks |
| Settings | master/engine/tyre volume, mute, steer invert, camera | localStorage |

## 3. Implementation shape

- New `web/shell.js` + `web/screens/*` (or one module with screen functions);
  the existing `app.js` exposes a `startRace(config)` entry instead of only
  reading URL params at load.
- State machine: `boot → menu → select → loading → race → results`; no engine
  step outside race/loading.
- UI is DOM overlays (the current HUD already uses them); no new WebGPU
  pipeline.
- Persistence: `localStorage` per car/map/course for best times; no accounts.
- Asset loading: use the chunking plan (`VEHICLE_CHUNKING.md`) so the menu
  loads the level + selected car only.

## 4. Acceptance

1. A new player can go menu → solo → map → car → race → results without typing
   a URL.
2. Online: create/join by code, car/map select, ready, race, rematch.
3. Deep links still work for captures.
4. Settings persist and are applied (audio/steer/camera).
5. Console 0, keyboard + gamepad navigation, screenshots per screen.

## 5. Limits

- No account/profile/leaderboard backend in the first shell.
- No retail menu art; use real car/map renders where possible, otherwise a
  labelled placeholder.
- The shell must not change physics, packet or record semantics.
