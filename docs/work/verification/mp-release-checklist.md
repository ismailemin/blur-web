# Multiplayer release checklist

Status: gate definition, 8 November 2026. This is the acceptance test for the
first build that can be handed to other people. It is not a claim that any item
passes yet; each line must be filled with a command, a result and a hash.

## A. Boot and shell

| # | Check | Evidence |
|---|---|---|
| A1 | One URL reaches a main menu; no query string required | screenshot + URL |
| A2 | Car select lists every integrated car with its real name | roster count vs shell count |
| A3 | Map select lists every playable map with measured length and modes | map list vs map batch report |
| A4 | Unsupported map/mode/car combinations are disabled with a reason | matrix screenshot |
| A5 | Car and map change without a page reload | chunk load log, timing |
| A6 | Back/ESC navigation restores focus; no console errors | console capture |

## B. Solo

| # | Check | Evidence |
|---|---|---|
| B1 | 310 m sprint finishes deterministically for every car | per-car time table |
| B2 | Lap mode runs 3 laps on a proven loop with lap splits | lap times |
| B3 | Free roam has no gates/finish and respects solid props | run log |
| B4 | Visible structures block the car on every playable map | contact test per map |
| B5 | Wreck → respawn keeps time/lap state | respawn log |
| B6 | Ghost replay matches the recorded run | Δt/Δd |

## C. Multiplayer

| # | Check | Evidence |
|---|---|---|
| C1 | Host creates a room; guest joins by code over WSS | server log + client log |
| C2 | 2 humans + 2 AI start and finish with a shared result | result JSON |
| C3 | 8-slot room accepts 8 and rejects the 9th with a typed error | server log |
| C4 | Remote cars interpolate with bounded correction (no rubber-band snap) | metrics |
| C5 | Guest disconnect → reconnect mid-race resumes the same slot | session log |
| C6 | Map/layout/physics hash mismatch is rejected, not silently played | rejection log |
| C7 | Host authority holds: guest cannot spawn power-ups or finish early | negative test |

## D. Power-ups and damage

| # | Check | Evidence |
|---|---|---|
| D1 | All 8 MP types are placeable and collectable on every playable map | placement manifest |
| D2 | Each type's effect is host-authoritative and replicated once | event log |
| D3 | Health/shield/wreck use the recovered damage values | damage table |
| D4 | Shield/nitro/mine interactions match the recovered rules | rule tests |
| D5 | SuperShield is opt-in only and never spawns by default | config check |

## E. Visual

| # | Check | Evidence |
|---|---|---|
| E1 | Material colour/blend/alpha applied per draw | material coverage count |
| E2 | Instance and decal layers drawn | draw count delta |
| E3 | Lighting/shadow from recovered values; normals serialized or documented | lighting manifest |
| E4 | HUD shows retail-exact elements or labelled provisional ones | HUD coverage table |
| E5 | 1:1 slice: 4 fixed poses vs user retail frames | side-by-side images |

## F. Engineering gates

| # | Check | Evidence |
|---|---|---|
| F1 | `verify_asset_probe --skip-build` green | log |
| F2 | CTest 15/15 | log |
| F3 | `check_e1_poc` green | log |
| F4 | `verify_e1_drive` green | log |
| F5 | E2E scenarios green, console 0 errors/0 warnings | e2e report |
| F6 | Release bundle builds and runs from a clean folder; hashes verified | pack report |
| F7 | Performance budget within limits for 8 cars | perf report |
| F8 | Malformed input cases fail loudly with typed errors | robustness report |

## G. Distribution

| # | Check | Evidence |
|---|---|---|
| G1 | Friend can open the URL and see the menu (browser support matrix) | compat report |
| G2 | Room server deployed with TLS and a health endpoint | deploy log |
| G3 | Version stamp shown in the UI; mismatched client refused | rejection test |
| G4 | No game data, secrets or `_work/` in the bundle | pack manifest |

## Sign-off rule

The build is "multiplayer-testable" only when A–G are all recorded. Any item
that fails stays open with the exact failure; nothing is marked pass by
inspection.
