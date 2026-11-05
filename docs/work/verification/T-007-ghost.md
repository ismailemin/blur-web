# T-007 ghost / rival replay — a deterministic replay of one completed sprint

**Date:** 6 November 2026
**Owner:** P63 (sub-agent)
**Scope:** `probes/e1-drive/**`, `_work/e1-drive/**`, `_work/logs/e1-drive/**`,
`docs/work/analysis/e1-drive-slice.md` §25 and this record. No change to
`probes/car-materials/`, `probes/car-parts/`, `probes/drivable-path/`, the engine,
`probes/render-packet/`, `tools/`, `upstream/` or `game-data/`. **No physics
change:** the five drive and ten sprint state sequence anchors are byte-identical
to P59, and the verifier re-derives every committed reference ghost from those
anchored runs on every normal run.

## Result

`G` replays one completed run as a ghost on the measured 310 m P48 sprint (and on
the 29 m regression course): the player's fastest clean run for that car and
course, or — before the player has finished — the **committed deterministic
reference trace** generated from the same scripted sprint run, labelled
`reference ghost - committed deterministic sprint trace`.

- `verify_e1_drive.mjs`: **PASS, 678/678 checks, 0 failures** (was 570/570; 108
  new ghost checks and the anchor block grouped before the ghost block).
- Ghost determinism: two derivations of the same run produce the **same canonical
  hash and the same sample payload**; the page's recorded sequence hash equals the
  pinned sprint anchor for that car and course.
- The compact record rebuilds the run's own body pose and every wheel matrix:
  **max |body delta| 5.0e-6, max |wheel delta| 3.1e-5** (float32 sample
  quantization; the verifier decodes and re-composes with the same functions the
  page uses, then compares with the run's packet matrices).
- Browser: **5 cars × 1 ghost-visible frame + 1 G-toggle pair**, 1600×900,
  headless Edge/WebGPU, **0 console messages of any kind**, **0 assertion
  failures**, 3 geometry uploads per page, **no upload growth with the ghost on**.
- Best time, restart, respawn, telemetry, soak and drive behaviour are untouched:
  the ghost is off by default, is not a packet field, is not stepped by the
  engine, and `R`/respawn only change the playback clock.

## 1. What a ghost is

A ghost is a **recording of one completed run**, not a second simulation:

| element | value |
| --- | --- |
| sample | one per engine tick, settled tick 0 … finish tick inclusive |
| payload | position (3 × f32) + rotation quaternion (4 × f32) + four wheel angles (4 × f32) |
| stride | 11 × f32 = **44 B/tick**, little-endian, base64 |
| record | `kind`, `version`, car slug, course, course id, layout hash, source, source label, tickHz, countdown ticks, finish tick, finish time, tick count, run state-sequence hash, sample |
| hash | canonical-JSON SHA-256 of the whole record including the sample payload |

The body matrix is `matrixFromQuaternion(position, quaternion)`; every wheel is
`body × manifest rest × Rx(recorded angle)`, using the same
`packet-adapter.js` composition (`multiplyMat4`, `rotationXMatrix`, rest pose from
the car's own committed manifest in `geometry.json`). The verifier reconstructs
all nine node matrices at every tick and compares them with the run's own packet
matrices, so the compact form is proven against the live car rather than assumed.

The record is read-only for the run: after deriving it the verifier re-hashes every
packet update and re-aggregates the state sequence, and both still match. The ghost
is never in `updates[]`, `nodes[]`, `draws[]`, `meshes[]` or the packet hash.

## 2. Storage, fallback and the played-back clock

- **Store:** `localStorage` key `e1-drive.sprint.ghost.v1.310m` or `…v1.short`, a
  map `car slug → ghost record` (one per car and course). Only a **clean** finish
  is recorded (`respawns === 0`), only if it is faster than the stored ghost, and
  the record carries the layout hash, so a ghost from an older course is rejected
  rather than replayed. A tampered record fails its own canonical hash and is
  dropped with `lastError` recorded; a throwing storage degrades to memory-only.
- **Fallback:** when the store has no record, the page fetches
  `ghosts/index.json` and `ghosts/<slug>-<course>.json` from the committed
  reference set (served read-only by `tools/serve.mjs` at `/ghosts/`). The page
  re-hashes the fetched bytes against the index SHA-256, re-hashes the record, and
  requires the layout hash to match. A missing or failing reference leaves the
  ghost off and states the reason in the HUD — there is no guessed pose.
- **Clock:** playback follows the **race clock**, not the engine tick:
  `tick = countdownTicks − remaining` during the countdown, else
  `countdownTicks + elapsedTicks`, minus one tick plus the fixed-step alpha (the
  same interpolation the player's frame uses). A respawn restarts the engine tick
  axis but the rules keep `elapsedTicks`, so the ghost keeps its place.
- **HUD delta:** `Δt = player race time − ghost race time at the player's arc`
  and `Δd = ghost arc at the player's race time − player arc`. Both are "gap to
  make up": positive = the player is behind. The arc is the measured polyline arc
  on the 310 m course and straight `x` on the 29 m course; the ghost table uses the
  running maximum of the arc so a lateral projection wobble cannot rewind it.
  At the finish of the ghost's own run both deltas are 0.

## 3. Rendering: one extra draw set, no extra upload

`packet-consumer.js` gained one additive path:

- At `load()` the consumer reserves `drawCount + carDrawCount` uniform slots in
  the **existing** uniform buffer (no new buffer; `load()` still creates the same
  three mesh buffer triples + uniform + scene = 11) and starts a second pipeline
  with the same bind groups and vertex layout, a translucent cyan diagnostic tint,
  `depthWriteEnabled:false` and `depthCompare:less`.
- `setGhostFrame(nodeMatrices)` accepts the page's nine node matrices (body + four
  spin + four static wheels). `renderFrame()` writes their uniforms after the
  packet's own uniforms, then re-submits the **already uploaded** car mesh once
  more: same vertex/index/UV buffers, same 84–115 draws, no texture sample in the
  ghost shader (a 1×1 placeholder is bound), no collisions.
- Stats: `ghostDraws` (slots), `ghostDrawsIssued`, `ghostFrames`, `ghostEnabled`.
  `drawsIssued` counts the ghost draw set; `geometryUploads` does not move.

The page label is the on-screen tag `GHOST · <source> · REPLAY, NO COLLISION` plus
the HUD row `ghost … Δt … Δd … G to hide`. The tint is a diagnostic colour, not a
recovered material.

`?ghostoffset=<ticks>` is a **capture-only presentation offset**. The headless
five-car capture uses `+60` so the ghost is visibly ahead of the identical
scripted player run. It changes only where the ghost is drawn; the record, the
nearest recorded pose, the delta, the packet and the physics do not move.

## 4. Determinism

| check | result |
| --- | --- |
| same run → same ghost hash | 10/10 records (5 cars × 2 courses) |
| committed reference bytes = regenerated bytes | 10/10 + index |
| ghost state-sequence hash = pinned sprint anchor | 10/10 (`da7e14f1…`, `83f05df4…`, `accf125a…`, `1094698d…`, `0b32413d…`, short P37 anchors) |
| body pose rebuilt from the record (vs the run's packet) | max \|Δ\| **5.0e-6** (float32 sample) |
| wheel matrices rebuilt from the record | max \|Δ\| **3.1e-5** (float32 sample) |
| rotation quaternions unit | max \|1 − \|q\|\| 3.3e-16 |
| player replayed against its own ghost | ≤ 8.6e-5 s / 1.4e-3 m on 800+ moving ticks per car |
| ghost clock reaches the recorded finish at its last tick | 10/10 |
| store keeps the fastest, ignores slower, separates courses, drops tampering | PASS |
| cross-car delta signs (Audi ghost ahead of Corvette pace, Focus behind Audi) | PASS |

Because the derivation is a pure function of the anchored run and the ghost files
are compared byte for byte, a physics change would fail the ghost gate as well as
the state-sequence anchors. The reverse is not implied: the ghost itself never
steps the engine.

## 5. Browser evidence

`node probes/e1-drive/tools/capture_browser.mjs --mode ghost --port 8841` produced
**5 ghost-visible frames** (one per roster car, held at the node verifier's mid
tick) plus a **G toggle pair** for the default car, in headless Edge/WebGPU
1600×900, adapter `nvidia / blackwell`, **0 console messages, 0 assertion
failures** (`_work/e1-drive/browser-evidence-ghost.json`):

- the page reports the committed reference ghost (`source: reference-trace`), its
  hash equals the committed index entry, and it is visible;
- the ghost is drawn at `displayTick + 60 − 1` (the race-clock tick plus the
  capture offset) and the browser body pose and four wheel spin matrices are
  **bit-identical** to the record at that tick (`bodyMaxDelta = 0`,
  `wheelMaxDelta = 0`);
- `geometryUploads = 3` and the upload byte count equal the level + own body +
  track meshes; `drawsIssued = frames × draws + ghostFrames × ghostDrawSlots`
  exactly (one extra draw set per ghost frame, no upload);
- the HUD delta equals the node-computed race-clock gap within 1e-9;
- the tag and HUD label the replay and its source;
- `G` hides the ghost with no reload: 34 frames rendered with `ghostFrames`
  frozen, `geometryUploads` still 3, and `drawsIssued` advancing by exactly
  `frames × draws`; `G` shows it again on the next frame.

Screenshots: `browser-<slug>-sprint-ghost.png` (5 cars) and
`browser-corvette-zr1-stock-sprint-ghost-off.png` (toggle proof).

## 6. Commands

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"

# 1. regenerate the committed reference ghosts (golden files; needs all cars)
& $node probes/e1-drive/tools/verify_e1_drive.mjs --write-ghosts

# 2. the normal gate: re-derives every ghost from the sprint runs and compares
& $node probes/e1-drive/tools/verify_e1_drive.mjs          # PASS 678/678

# 3. browser: 5-car ghost frames + G toggle + console gate
& $node probes/e1-drive/tools/capture_browser.mjs --mode ghost --port 8841

# 4. regression captures (ghost off; unchanged behaviour)
& $node probes/e1-drive/tools/capture_browser.mjs --mode sprint --port 8831
& $node probes/e1-drive/tools/capture_browser.mjs --mode restart --port 8833

# 5. repo-wide portable gate (uses the existing binaries)
& $py tools/verify_asset_probe.py --skip-build       # PASS, 30 checks

# interactive
& $node probes/e1-drive/tools/serve.mjs --port 8801
# /?car=<slug>            finish once, press R, press G to race the ghost
# /?ghost=1               show the reference ghost from the start
```

## 7. Recorded hashes

`probes/e1-drive/ghosts/index.json` — 8,842 B,
SHA-256 `ee9f599c0058ac17a6368a9eaa02bb9ef0a7384bc1c30e6098655842f212a387`
(canonical index content; the verifier regenerates it and compares bytes).

| car | course | finish | tick | ghost hash |
| --- | --- | ---: | ---: | --- |
| Corvette ZR1 | 310 m | 14.650 s | 969 | `sha256:10a2e115a897a0c87eff30aba7d13944658ff2f9dd009f0f07c48178b35c9f1e` |
| Lotus Exige Cup260 | 310 m | 14.767 s | 976 | `sha256:d75db71c22145f33f78dcee3f0e6cb4463ce671dd7d7687904bcfe660db6a89c` |
| Dodge Challenger | 310 m | 14.917 s | 985 | `sha256:f49d9d9490ffadaebfd30e05f665192adc4286b49b22c372381ffdd0961a5d7f` |
| Ford Focus RS | 310 m | 15.217 s | 1003 | `sha256:2204e200bb581574a6efab3f25cb7375cc6e1f89d3d7bf0efec9467082188ff5` |
| Audi R8 V10 | 310 m | 14.150 s | 939 | `sha256:937e279db686c5c94fdf561b1f4d9f64074c32020dcfb045027aa2a6c61e5c5f` |
| Corvette ZR1 | 29 m | 2.800 s | 258 | `sha256:5c04978dd18bb9531c4432d977d58ee34d26b2b8f916ee961fb26f359daad567` |
| Lotus Exige Cup260 | 29 m | 2.850 s | 261 | `sha256:11c2c42e58cf4aeccc27eaef2d4876489e7fe72ae4c757050690a49d5bdf3fff` |
| Dodge Challenger | 29 m | 3.000 s | 270 | `sha256:68fa7f8011f58d1177371b000fee673c2eb68073026f12fb6b5c35417ae28702` |
| Ford Focus RS | 29 m | 3.267 s | 286 | `sha256:05c065ae6d1602729b606cacbbc3d80fb11712c801ba1dbac3630c921edad3c9` |
| Audi R8 V10 | 29 m | 2.283 s | 227 | `sha256:f88564f54082c9b4cb213739f87dd7e6a550da66a402c5a7438efaef394a46db` |

Reference files are 55,969–59,733 B (310 m) and 14,201–17,667 B (29 m); every
file's SHA-256 is pinned in the index and in `_work/e1-drive/run.json` → `ghost`.

## 8. Limits

- **A replay, not an AI opponent.** One ghost per car and course; it has no
  collision, input, physics body or packet entry. No racing-line search, no
  rubber-banding, no traffic and no retail rival behaviour.
- **The committed reference is the deterministic scripted follower**, not a human
  best; the page labels it as such. The player's own ghost is only stored for a
  clean finish (no respawn) and only when it is faster.
- **The ghost does not re-simulate.** It follows the recorded engine-tick samples
  (interpolated by the fixed-step alpha); it cannot react, drift or be hit.
- **Deltas are race-clock gaps**, not telemetry: they compare the player's time at
  an arc with the ghost's recorded time at that arc, and vice versa. The ghost's
  arc table clamps at the recorded finish, so a finished ghost stays at the line.
- **`?ghostoffset` is a capture diagnostic.** It moves only the drawn ghost; the
  record, pose, delta and physics are unmoved. Normal use keeps it at 0.
- **The tint is diagnostic.** A translucent cyan silhouette with the same spin
  band as the live car; no recovered paint, material or shader is added.
- **One extra draw set per ghost frame** (84–115 draws) and one uniform write per
  frame; GPU buffers and textures are unchanged. The ghost is not culled or
  LOD'd.
- **No full-game claim.** One measured point-to-point course, one car, one ghost.

## 9. What changed

| file | change |
| --- | --- |
| `probes/e1-drive/web/ghost-replay.js` | **new**: record encode/decode, quaternion/matrix reconstruction, canonical hash, store, reference naming, arc/time delta |
| `probes/e1-drive/web/packet-consumer.js` | ghost pipeline, reserved uniform slots, ghost draw pass, `setGhostFrame`, ghost stats |
| `probes/e1-drive/web/packet-adapter.js` | exports the existing `multiplyMat4` / `rotationXMatrix` so the ghost composes wheels identically (no behaviour change) |
| `probes/e1-drive/web/app.js` | ghost load/store/playback, `G` toggle, HUD delta + tag, finish recording, `?ghost=1`, `?ghostoffset=` |
| `probes/e1-drive/web/index.html` / `style.css` | ghost tag and key/legend lines |
| `probes/e1-drive/tools/serve.mjs` | read-only `/ghosts/` tree |
| `probes/e1-drive/tools/verify_e1_drive.mjs` | ghost record/store/delta checks, committed reference comparison, `--write-ghosts`; 678 checks |
| `probes/e1-drive/tools/capture_browser.mjs` | `--mode ghost` pass (5 cars + G toggle + uploads/console gates) |
| `probes/e1-drive/ghosts/**` | **new**: committed reference ghost set (10 records + index) |
| `probes/e1-drive/README.md` | ghost section, commands, evidence, limits |
| `docs/work/analysis/e1-drive-slice.md` §25 | analysis record |

## 10. Evidence paths

| path | content |
| --- | --- |
| `probes/e1-drive/ghosts/index.json` | 10 reference ghosts: file, bytes, file SHA-256, canonical ghost hash, finish, ticks, layout, state-sequence hash |
| `probes/e1-drive/ghosts/<slug>-{310m,short}.json` | committed reference records |
| `_work/e1-drive/run.json` → `ghost` | reconstructed deltas, per-record hashes, store results, limits |
| `_work/e1-drive/browser-evidence-ghost.json` | 5 ghost captures, G toggle, pose/delta/upload/console gates |
| `_work/e1-drive/browser-<slug>-sprint-ghost.png` | ghost-visible frame per car |
| `_work/e1-drive/browser-corvette-zr1-stock-sprint-ghost-off.png` | G hidden |
| `_work/logs/e1-drive/p63-*.log`, `edge-ghost.log` | verify/capture logs |
