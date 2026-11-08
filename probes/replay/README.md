# probes/replay — deterministic race replay

A compact, seekable recording of a whole race (all cars, events and result),
not a second simulation. It consumes the same 20 Hz snapshot shape the
multiplayer host already emits and never touches `probes/e1-drive/**`.

- `replay.mjs` — format constants, quantisation, `ReplayRecorder`,
  `ReplayReader`, `ReplayPlayer`, body codec, index, validation, error
  measurement.
- `sha256.mjs` — dependency-free SHA-256 and canonical JSON for the record hash.
- `selftest.mjs` — 431 assertions: round-trip, quantisation bounds, seek,
  corruption/version rejection, determinism and size accounting.

Full format, measured sizes, error bounds and the e1-drive/MP integration
contract: `docs/work/analysis/replay.md`.

## Commands

```powershell
$node = "_work/toolchains/emsdk/node/24.19.0_64bit/node.exe"
& $node probes/replay/selftest.mjs
```

Outputs (ignored by Git):

```text
_work/replay/selftest.json
_work/logs/replay/selftest.log
```

## Minimal use

```js
import { ReplayRecorder, ReplayPlayer, loadReplay } from './replay.mjs';

const recorder = new ReplayRecorder({
  tickHz: 20,
  engineTickHz: 60,
  map: { id: 'usa_la_river', hash: MAP_HASH },
  hashes: { build: BUILD_HASH, map: MAP_HASH, layout: LAYOUT_HASH, physics: PHYSICS_HASH },
  participants: [
    { id: 'pl_1', slot: 1, car: 'corvette-zr1-stock', carHash: CAR_HASH }
  ],
  labels: { retailReplayFormat: false, sampleSource: 'host-20Hz-snapshot' }
});

// Host snapshot shape, one call per recorded tick.
recorder.capture({ tick, cars: [{ id, position, quaternion, speed }] });
recorder.addEvent({ tick, type: 'pickup', participantId: 'pl_1', pickup: 'Shield' });
recorder.setResult(result);
const replay = recorder.build();           // canonical-hashed JSON record

const player = new ReplayPlayer(replay, {
  version: 1, buildHash: BUILD_HASH, mapHash: MAP_HASH,
  layoutHash: LAYOUT_HASH, physicsHash: PHYSICS_HASH,
  carHashes: { pl_1: CAR_HASH }
});
player.seek(900);
player.playbackRate = 0.5;
const frame = player.advance(1 / 60);      // interpolated cars
```

`loadReplay(replay, expected)` validates structure, body, ticks, events and the
canonical hash before anything is played. A build/map/layout/physics/car hash
mismatch, a tampered body or a version mismatch is rejected with a typed
`ReplayError`; there is no partial playback and no guessed pose.

## Limits

- Recording, not authority: it cannot prove a race was legal.
- 20 Hz samples; no input stream and no re-simulation.
- Health/shield are held between samples; wheel spin exists only when the
  source supplies it (the E1 network state does not).
- No retail replay format, no browser capture and no `e1-drive` change here.
