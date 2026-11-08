# Packaging — Blur Web distributable bundle (PACK1)

**Date:** 8 November 2026
**Scope:** one local build step that turns the working tree into a runnable
folder, with a hashed manifest, a Node-only runtime and a typed boot integrity
check. Design and evidence only; no browser capture is part of PACK1.

The bundle is a **local build artifact**. It lives under `_work/pack/` and is
never committed. Game data, decoded audio and generated chunks remain outside
version control.

## 1. Why this exists

Running the current build needs four separate things:

1. the static page source (`probes/e1-drive/web/`),
2. the generated module/geometry/texture/ghost output under `_work/e1-drive/`,
3. map packages under `_work/map-slice/` and the level physics bytes,
4. a local static server, plus the room service for multiplayer.

`probes/pack/build.py` assembles exactly those bytes into one folder, records a
size and SHA-256 for every file, and `probes/pack/server.mjs` verifies the
manifest before it opens a port. A friend only needs Node.js 18+ and
`start.cmd` / `start.sh`.

## 2. Bundle layout

```
_work/pack/release/
  manifest.json              every file: url, path, bytes, sha256, group, role
  manifest.sha256            SHA-256 of manifest.json (sha256sum format)
  build.json                 target, pack version, stamp, counts
  VERSION                    human-readable stamp summary
  README.txt                 exact user steps, localhost and remote
  server.mjs                 Node static server + embedded room-service import
  start.cmd                  Windows launcher
  start.sh                   Linux/macOS launcher
  www/                       the only static content root
    index.html               page entry (url "/")
    app.js, style.css, ...   31 page modules
    _work/e1-drive/
      level.geometry.json    River level chunk                9,663,610 B
      base.geometry.json     map-mode base                       11,429 B
      car-bodies.index.json  car chunk index                     27,101 B
      cars.json              roster                             82,344 B
      spawn.json             measured spawn                         289 B
      sprint.json            310 m layout                       386,521 B
      sprint-short.json      29 m layout                         11,495 B
      sprint-lap.json        3-lap layout
      sprint-free.json       free-roam layout
      Level.levelphysics     River physics                     1,945,409 B
      module/e1_drive.mjs    wasm glue                            11,480 B
      module/e1_drive.wasm   wasm module                       1,012,634 B
      module/build.json      module build record
      cars/<slug>.geometry.json   25 selected-on-demand car chunks
      cars/<slug>.fields          25 car field lists
      amboy/{map,layout}.json     Amboy package + layout
      gracia/{map,layout}.json    Gracia package + layout
    _work/map-slice/
      amboy-render/render.json    pinned render source
      amboy/slice.json            pinned slice source
      amboy-render/diagnostics.json
      gracia-render/render.json
      gracia/slice.json
      gracia-render/diagnostics.json
    _work/audio/
      RaceV8_Engine_{1500,1995,3015,4005,4995,6000}.wav
      engine-model.json           provenance only
    _work/powerups/{powerups,projectiles}.json
    _work/prop-collision/colliders-v2.json
    _work/free-roam-prop/colliders-r04-v2.json
    ghosts/index.json + 50 reference ghost traces
    prop-collision/lib/*.mjs      P66 resolver (4 modules)
    audio/engine-audio.js         committed audio module
    net-mvp/                      client, protocol, hash, race, room service, web
    race-rules/*.mjs              race model modules
    powerups/{engine,projectiles}.js
    map-data/usa_amboy/Level.levelphysics              4,442,528 B
    map-data/spa_barcelona_gracia/Level.levelphysics   5,569,121 B
```

The URL space is the existing page URL space. `/` maps to `www/index.html`;
`/_work/e1-drive/...` maps to `www/_work/e1-drive/...`; `/ghosts/...`,
`/prop-collision/...`, `/audio/...`, `/net-mvp/...`, `/race-rules/...`,
`/powerups/...` and `/map-data/...` map to their `www/` equivalents. The page
source was not modified.

### Dev target

```
_work/pack/dev/
  manifest.json, manifest.sha256, build.json, VERSION, README.txt
  server.mjs, start.cmd, start.sh
```

`contentRoot` is `../../..`; the manifest entries point at the working tree
(`probes/e1-drive/web/...`, `_work/e1-drive/...`, `game-data/...` for the two
map physics files). No asset is copied, so the dev server sees regenerated
assets immediately. It is not distributable and must stay in this folder.

## 3. Build commands

Use the bundled Python:

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# release: self-contained folder, ~324 MiB
& $py probes/pack/build.py --target release

# dev: serve the working tree in place
& $py probes/pack/build.py --target dev

# manifest-only (no asset copy; used by the determinism gate)
& $py probes/pack/build.py --target release --manifest-only --stamp ci-2026-11-08

# JSON summary for tooling
& $py probes/pack/build.py --target release --manifest-only --json
```

Exit codes: `0` ok, `1` a required source asset is missing (all missing paths
are listed), `2` usage, `3` a copy/hash mismatch while building.

The builder writes to `<out>.tmp-<pid>` and only replaces the target after the
whole tree is written and, for release, every copied file's size and SHA-256
match the source. The source tree is read-only throughout.

## 4. Run commands

### Windows, localhost

```bat
_work\pack\release\start.cmd
```

Then open `http://127.0.0.1:8830/`.

`start.cmd` requires `node` on `PATH` and runs:

```bat
node server.mjs --port 8830 --with-room --room-port 8811
```

### Linux/macOS, localhost

```sh
sh _work/pack/release/start.sh
```

`start.sh` is the same command with `$DIR/server.mjs`. It is generated on
Windows, so use `sh start.sh` (or `chmod +x start.sh` once) rather than assuming
the executable bit was preserved by the archive/copy.

### Room server in a release

The release embeds the unchanged `probes/net-mvp/server.mjs` at
`www/net-mvp/server.mjs`. `server.mjs` imports it through the verified manifest
entry and starts it with `--room-port` (default **8811**). The game server is
**8830**. Both bind `127.0.0.1` by default.

| mode | command | URLs |
|---|---|---|
| single player, no room | `node server.mjs --no-room` | `http://127.0.0.1:8830/` |
| localhost room | `start.cmd` / `sh start.sh` | host `/?mp=1&host=1`, guest `/?mp=1&room=<CODE>` |
| LAN host | `start.cmd --host 0.0.0.0` | `http://<host-ip>:8830/?mp=1&host=1` |
| LAN guest | — | `http://<host-ip>:8830/?mp=1&room=<CODE>` |

For LAN play, allow inbound TCP **8830** and **8811** on the host firewall. The
page's default room endpoint is `ws://<page-host>:8811/ws`. If the room port is
changed, append `&mpServer=ws://<host-ip>:<port>/ws` to both URLs. There is no
TLS, authentication, NAT/TURN or persistence; rooms are in memory and are lost
when the process stops.

### Dev target

```powershell
& $py probes/pack/build.py --target dev
_work/pack/dev/start.cmd        # or: node _work/pack/dev/server.mjs --port 8830
```

The dev server serves the working tree; it still verifies every manifest entry
on boot. Regenerating a chunk requires re-running `build.py --target dev` so the
manifest records the new hash.

## 5. Manifest and integrity semantics

`manifest.json` is a `blur-web.pack` / schema 1 document. Key fields:

- `packVersion`, `buildStamp`, `stampSource` (`derived` or `override`);
- `contentRoot` (`www` for release, `../../..` for dev);
- `counts` / `totals` (files, bytes);
- `groups` (page, river, cars, ghosts, map:amboy, map:gracia, audio,
  prop-collision, powerups, net-mvp, race-rules, control);
- `cars[]` (chunk/fields/ghost bytes per slug), `maps[]`;
- `preload` (the recommended preload set), `largestFiles[20]`;
- `excluded[]` (what was deliberately not shipped and why);
- `files[]`: `url`, `path`, `source`, `bytes`, `sha256:...`, `group`, `role`,
  `kind` (`asset`/`control`), `preload`, optional `car`/`map`.

`manifest.sha256` contains the SHA-256 of `manifest.json` in `sha256sum` format.
The manifest itself and `manifest.sha256` are the only files not listed inside
the manifest (self-reference is impossible).

### Boot sequence

`server.mjs` does this before `listen()`:

1. read `manifest.json` and `manifest.sha256`;
2. verify the manifest hash (`PACK_MANIFEST_HASH`);
3. verify every entry's path safety, existence, byte size and SHA-256;
4. verify `verified bytes == totals.bytes`, `files.length == counts.files` and
   unique URLs;
5. only then open the game port and optionally the room port.

Typed failures, printed to stderr with exit code 3 and no port opened:

| code | meaning |
|---|---|
| `PACK_MANIFEST_MISSING` | `manifest.json` is absent |
| `PACK_MANIFEST_HASH` | manifest hash mismatch / missing `manifest.sha256` |
| `PACK_MANIFEST_SCHEMA` | not a `blur-web.pack`/1 document |
| `PACK_INTEGRITY_PATH` | path/contentRoot escapes the content root |
| `PACK_INTEGRITY_MISSING` | one or more files are missing |
| `PACK_INTEGRITY_SIZE` | a file's byte size differs |
| `PACK_INTEGRITY_SHA256` | a file's SHA-256 differs |
| `PACK_INTEGRITY_COUNT` | manifest counts/URLs are inconsistent |
| `PACK_ROOM_MISSING` / `PACK_ROOM_IMPORT` / `PACK_ROOM_START` | bundled room service cannot start |
| `PACK_NODE_VERSION` | Node.js older than 18 |

The error lists up to 50 missing and 50 corrupt paths with expected/actual
values. There is **no fallback**: a request for a path that is not in the
manifest returns HTTP 404 with `PACK_NOT_IN_MANIFEST`; a file that disappears
after boot returns `PACK_FILE_VANISHED`. A request is never served from a
different file, a stale chunk or the source tree.

`/_pack/health` (GET) returns the target, pack version, build stamp, manifest
hash, file/byte counts, boot verification time and room status. It is an
operational endpoint, not a replacement for the manifest.

### Build stamp

The default stamp is derived, not clock-based:

```
sha256(
  "schema=blur-web.pack/1\n" +
  "target=<release|dev>\n" +
  "pack=<packVersion>\n" +
  <for each asset entry, sorted by url: "url\tbytes\tsha256\n">
)[:24]  -> "b1-<24 hex>"
```

The stamp covers shipped **assets**; control files are still hashed in the
manifest but do not change the content stamp (so a launcher text change does not
look like a content change). `--stamp <value>` records an override and sets
`stampSource: "override"`; two builds with the same override and the same
assets are byte-identical. Changing `--pack-version` or any asset changes the
derived stamp. There is no wall-clock value in the manifest, so a rebuild from
identical inputs is reproducible.

## 6. Size accounting

Current release snapshot:

| group | files | bytes | share |
|---|---:|---:|---:|
| cars (25 chunks + 25 fields) | 50 | 172,289,660 | 50.72 % |
| map:gracia | 6 | 85,290,565 | 25.11 % |
| map:amboy | 6 | 58,392,366 | 17.19 % |
| river (level + layouts + module + physics) | 13 | 13,517,159 | 3.98 % |
| prop-collision | 6 | 4,930,779 | 1.45 % |
| ghosts | 51 | 1,917,118 | 0.56 % |
| powerups | 4 | 1,307,511 | 0.38 % |
| page | 31 | 924,023 | 0.27 % |
| audio (6 WAV + module + model) | 13 | 734,743 | 0.22 % |
| net-mvp | 11 | 177,569 | 0.05 % |
| race-rules | 11 | 219,623 | 0.06 % |
| control | 6 | 17,523 | 0.01 % |
| **total** | **208** | **339,718,639 B (323.98 MiB)** | 100 % |

`manifest.counts` is authoritative; this table is a snapshot.

### Per map

| map | files | bytes | largest part |
|---|---:|---:|---|
| river | 13 | 13,517,159 | level chunk 9,663,610 B |
| amboy | 6 | 58,392,366 | `map.json` 49,524,812 B |
| gracia | 6 | 85,290,565 | `map.json` 72,616,717 B |

Amboy/Gracia sizes are `map.json + layout + render source + slice source +
diagnostics + physics`. The raw map-slice `textures/`, `raw/` and instance
chunks are build inputs already embedded in `map.json`; they are not shipped.

### Per car

`chunk` is the on-demand `cars/<slug>.geometry.json`; `fields` is the tiny
selector; `ghost` is the two committed reference traces (not preloaded).

| slug | chunk | fields | ghost | total |
|---|---:|---:|---:|---:|
| audi-r8v10-stock | 5,673,193 | 7,435 | 70,170 | 5,750,798 |
| audi-s3-stock | 6,769,503 | 7,379 | 77,150 | 6,854,032 |
| audi-tt-stock | 5,759,038 | 7,379 | 78,502 | 5,844,919 |
| bmw-m3e92-tuner | 6,762,185 | 7,410 | 77,154 | 6,846,749 |
| chevrolet-camaro-ratdrift | 8,335,955 | 7,549 | 77,933 | 8,421,437 |
| chevrolet-camaro-stocke3 | 7,180,667 | 7,336 | 76,178 | 7,264,181 |
| chevrolet-socalhhr-stock | 7,277,157 | 7,707 | 74,298 | 7,359,162 |
| corvette-c3-rat | 6,154,740 | 7,485 | 76,160 | 6,238,385 |
| corvette-zr1-stock (default) | 8,468,680 | 7,489 | 73,749 | 8,549,918 |
| dodge-challenger-stock | 5,657,014 | 7,546 | 75,403 | 5,739,963 |
| dodge-challenger-tuner | 7,966,464 | 7,553 | 74,350 | 8,048,367 |
| dodge-viperacr-stock | 6,587,291 | 7,544 | 72,882 | 6,667,717 |
| foose-stallion-stock | 8,489,161 | 7,548 | 76,867 | 8,573,576 |
| ford-bronco-offroad | 5,791,133 | 7,331 | 78,329 | 5,876,793 |
| ford-f100-offroad | 6,076,860 | 7,541 | 74,636 | 6,159,037 |
| ford-focusrs-stock | 6,896,981 | 7,384 | 77,400 | 6,981,765 |
| ford-fr100-stock | 6,076,045 | 7,434 | 72,633 | 6,156,112 |
| ford-mustanggtr-stock | 5,931,828 | 7,598 | 74,875 | 6,014,301 |
| koenigsegg-ccxr-stock | 7,602,321 | 7,333 | 71,356 | 7,681,010 |
| lotus-exige-cup260-stock | 9,018,247 | 7,335 | 74,354 | 9,099,936 |
| nissan-350znismo-stock | 7,727,617 | 7,339 | 76,704 | 7,811,660 |
| nissan-skyliner34ztune-stock | 5,468,922 | 7,447 | 69,961 | 5,546,330 |
| toyota-supratrd-stock | 7,137,864 | 7,492 | 75,227 | 7,220,583 |
| volkswagen-beetle-offroad | 7,538,809 | 7,382 | 75,521 | 7,621,712 |
| volkswagen-golfw12650-stock | 5,755,564 | 7,445 | 72,832 | 5,835,841 |

Largest single files: `gracia/map.json` 72.6 MB, `amboy/map.json` 49.5 MB,
`level.geometry.json` 9.66 MB, then the Lotus 9.02 MB, Foose 8.49 MB and
Corvette 8.47 MB car chunks.

### Preload vs lazy-load recommendation

`manifest.preload` currently selects **46 files / 22,917,351 B (21.86 MiB,
6.75 % of the bundle)**: the 31 page modules, the 13 River core files
(level/base/index/roster/spawn/4 layouts/physics/module) and the default
Corvette chunk + fields.

Preload that set (it is the first-page path). Everything else should stay
on demand:

- other 24 car chunks + fields: one chunk only when the car is selected /
  the MP peer car is first seen (~5.5–9.0 MB each);
- ghosts (51 files, 1.9 MB): only when `G`/ghost mode needs them;
- Amboy/Gracia (143.7 MB combined): only after `?map=` selects one; do not
  preload both;
- the six engine WAVs (0.63 MB): only after the first user gesture;
- power-up/prop manifests (~4.6 MB): only when `?powerups=1` or prop collision
  is used.

This is a recommendation derived from the manifest, not an automatic
streaming implementation. The page already fetches level + one car chunk; the
bundle does not add a second loader.

Nothing is dropped silently: all 25 roster cars, all 51 ghosts, all three maps,
all four layouts and the six engine loops are present. Deliberate exclusions
are recorded in `manifest.excluded[]` and repeated here:

| excluded | reason |
|---|---|
| `_work/e1-drive/geometry.json` (181 MB) | combined pre-chunking debug artifact; never fetched |
| per-car packets/runs/telemetry/soak/browser/PNG | build, verify and capture traces |
| `track-uv.bin`, `car-uv-*.bin`, texture manifests, `track.json`, `course.json`, corridor survey | build inputs already embedded in chunks, or diagnostic records |
| `e1_drive_{a,b,debug}.*`, `.o`, symbols | determinism/debug build products |
| map-slice `textures/`, `raw/`, instance chunks, Long Beach, repeat packs | raw package inputs / maps outside the committed registry |
| 1,220+ other `_work/audio` files | the page only fetches the six engine loops + model |
| `game-data/**` except three `Level.levelphysics` | read-only installed tree; only the physics bytes the page fetches are copied |
| `upstream/**`, `_work/pack/**`, `.git/**` | reference / output / metadata |
| net-mvp selftest/harness/capture, power-up tests, AI Node tools, prop tools | development-only |
| `probes/pack/**` | builder/verifier source, not runtime content |

## 7. Verification

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

# full release gate (includes the clean-room run)
& $py probes/pack/verify.py --json _work/logs/pack/verify-latest.json

# dev target (clean-room is release-only)
& $py probes/pack/verify.py --bundle _work/pack/dev --skip-cleanroom `
    --json _work/logs/pack/verify-dev-latest.json

# clean-room alone
& $py probes/pack/cleanroom.py --report _work/logs/pack/cleanroom-latest.json
```

### Results at report time

| gate | result |
|---|---|
| release verifier | **2,876 checks / 2,876 pass / 0 fail** |
| dev verifier | **2,865 checks / 2,865 pass / 0 fail** |
| determinism | two fixed-stamp manifest-only builds byte-identical; derived stamp == recorded; `--pack-version` change changes the stamp |
| clean-room copy | 324 MB copied to a temp folder, boot **0.53 s**, **20 files / 86,422,952 B** fetched over HTTP, every size and SHA-256 matched |
| clean-room negative | missing → `PACK_INTEGRITY_MISSING`, same-size byte edit → `PACK_INTEGRITY_SHA256`, edited manifest → `PACK_MANIFEST_HASH`; all exit 3 |
| clean-room room service | WebSocket `room.create` → `room.created`, 1 player, 60 Hz, 24 ms |
| clean-room unknown URL | `/…/geometry.json` → HTTP 404 `PACK_NOT_IN_MANIFEST` |
| source tree during clean-room | unchanged (`manifest.sha256` and a sample chunk hash identical) |

Artifacts:

- `_work/pack/release/manifest.json`
  (`sha256:d7ce7047b228c679eb02e10e3dd5acfbb70859ade311efae8148f98189ccc05a`)
- build stamp `b1-83a420dca25348358fb2c721`
- 208 files / 339,718,639 B
- `_work/logs/pack/verify-latest.json`
- `_work/logs/pack/verify-dev-latest.json`
- `_work/logs/pack/cleanroom-latest.json`
- `_work/pack/_verify/` (determinism evidence)
- release folder manifest hash and per-file hashes are authoritative; the
  counts above are a snapshot and change if any source asset is regenerated.

The verifier checks manifest schema/counts/groups, every file's path, source
existence, size and SHA-256, the chunk-index/roster/ghost pins, the map-registry
file pins (River/Amboy/Gracia), required URLs, the six audio loops, no
game-data/upstream/`_work/pack` leakage, no debug/capture artifacts, no absolute
paths, no secrets, no extra files in the release folder, launcher/README
content, and the determinism gate. Per-file checks alone are > 1,000, well above
the 150-check floor.

## 8. Limits

- **Snapshot, not a release pipeline.** PACK1 packages the current working
  tree. A new chunk, ghost, roster entry or map requires re-running the build.
- **Local artifact.** `_work/pack/**` is not committed. The bundle contains
  generated game-derived bytes (three `Level.levelphysics` files, six decoded
  WAVs, map/chunk payloads); keep it out of git and do not redistribute it as
  retail content.
- **~324 MiB uncompressed.** There is no compression, delta packing or
  per-map/per-car download profile. If a smaller friend build is needed, add a
  profile that copies a subset explicitly and records the excluded content;
  do not silently delete files.
- **No streaming/eviction.** The page still loads a level + one selected car
  (plus the MP peer). All car chunks are shipped, but only one is fetched.
- **Node 18+ only at runtime.** No Python, npm install, database or build step
  on the target. The build itself currently uses Python 3 + Node (browser
  capture is not part of PACK1).
- **HTTP + WebSocket only.** No TLS, authentication, accounts, NAT/TURN or room
  persistence. Room state is in memory and dies with the process.
- **Boot hashes every file.** ~0.5 s for 324 MiB on this machine; time scales
  linearly with bundle size. This is intentional: a fast boot must not skip
  the integrity check.
- **No browser-level claim in PACK1.** The clean-room test proves HTTP bytes,
  hashes, the room handshake and the integrity failures. The WebGPU page itself
  still needs the normal browser capture gate; PACK1 did not run one.
- **The dev target is not distributable.** It depends on the working tree and
  `_work/` output and must not be copied to another machine.
