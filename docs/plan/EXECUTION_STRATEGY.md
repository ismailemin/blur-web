# Execution strategy — DeepSeek V4.1 Flash, quality-first speed

Status: adopted 8 November 2026. This document records how work is parallelised
and why.

## Model policy

- **Only DeepSeek V4.1 Flash.** No premium models; the account limits are low.
- Reasoning effort is **not** the bottleneck. The bottlenecks are asset
  decoding, shared integration files, browser captures and deterministic gates.
- Speed comes from **pipelines and parallelism**, not from a bigger model.

## Why not one agent per car/map

Every car/map integration touches shared files:

- `cars/roster.json`, material/texture guards, one chunk index;
- `ghosts/index.json` (two records per car);
- `verify_e1_drive` anchors, the asset suite, one browser profile/port;
- for maps: the map registry, packet producer, shared consumer.

Twenty-five agents writing those files in parallel overwrite each other and
invalidate evidence. "Green" would become meaningless.

## Concurrency policy

| Work type | Parallel? | Limit |
|---|---|---|
| Read-only audits / staging into separate dirs | yes | 10–15 |
| Per-car data staging (`_work/<batch>/<slug>`) | yes | 10–15 |
| Per-map package extraction (separate packages) | yes | 2–3 |
| Shared `probes/e1-drive` integration | **no** | 1 owner |
| Browser captures | **no** | 1 at a time (port/profile) |
| Full suite / verify gates | **no** | 1 at a time |

Target: **5–6 active agents** on disjoint areas, plus data-only staging if
useful. More than that queues on CPU/GPU and creates merge review cost.

## Speed levers (ordered by impact)

1. **Vehicle batch compiler** — one tool takes a roster list and emits
   manifest/chunk/ghost/capture/verify for each car. Adding a car becomes a
   config line, not an agent. This is how 25 → 61 cars scale.
2. **Map package compiler** — already generalised; adding a B map is a command.
3. **1:1 vertical slice** — one car + one map section fully matched, then reuse
   the same material/instance/lighting pipeline everywhere.
4. **Sharded evidence** — per-car/per-map artifacts already exist; avoid
   rebuilding the 106 MB combined geometry (chunking landed).
5. **Parallel data staging** — manifests/previews/textures in separate dirs,
   one integrator.
6. **Worktrees** only when two changes must touch the same shared file; merge
   with the main agent reviewing.

## 1:1 parity target

- **Car:** Corvette ZR1 stock.
- **Map section:** River 0–100 m (start corridor).
- **Streams:** PARITY1 audit/harness; PARITY2 material/colour/blend + lighting;
  PARITY3 instances/decals producer; PARITY4 normals/shadows/diff.
- **Acceptance:** four fixed camera poses, our capture vs retail capture, a
  per-feature match/partial/missing table, and a documented remaining gap.
- **User input:** retail reference frames at the poses PARITY1 defines. Without
  them, 1:1 cannot be measured; source-data work can still proceed.

## Quality rules (non-negotiable)

- No invented values, textures, normals, colours or collision.
- Typed failures and labelled fallbacks; never silent substitution.
- Every change: command output, hashes, screenshots and a documented limit.
- One owner per shared file; main agent reviews the diff and commits only when
  the full gate is green.
- Historical docs are marked Superseded, not deleted.

## Current wave

| Agent | Area | Scope |
|---|---|---|
| V5 | `probes/e1-drive` | batch 2 → 25 cars |
| PM1 | `probes/map-props` | Amboy/Gracia prop colliders |
| LM1 | `probes/map-laps` | Amboy/Gracia closed-loop search |
| PARITY1 | `probes/retail-parity` | 1:1 audit + camera/reference protocol |

Next: PARITY2/3/4, vehicle batch compiler, game shell, Longbeach integration.
