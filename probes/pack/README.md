# probes/pack — distributable Blur Web bundle

PACK1 turns the working tree into a self-contained, hash-verified folder under
`_work/pack/`. It never writes to the source tree and never commits the bundle.

| file | role |
|---|---|
| `build.py` | builds `release` (self-contained) or `dev` (serves the tree in place) |
| `server.mjs` | Node-only runtime server + boot integrity check + bundled room-service import |
| `ws_probe.mjs` | minimal WebSocket `room.create` smoke probe |
| `cleanroom.py` | copies the release to a temp path, boots it, fetches/hashes chunks, tests typed failures |
| `verify.py` | 2,800+ checks: manifest, hashes, pins, leakage, determinism, clean-room |

```powershell
$py = "C:/Users/ismailemin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"

& $py probes/pack/build.py --target release
& $py probes/pack/build.py --target dev
& $py probes/pack/verify.py --json _work/logs/pack/verify-latest.json
& $py probes/pack/cleanroom.py --report _work/logs/pack/cleanroom-latest.json
```

Run: `_work/pack/release/start.cmd` (Windows) or `sh _work/pack/release/start.sh`,
then open `http://127.0.0.1:8830/`. The room service starts on 8811 by default.

Full layout, size table, integrity semantics and limits:
`docs/work/analysis/packaging.md`.
