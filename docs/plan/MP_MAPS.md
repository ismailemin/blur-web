# Multiplayer map selection and sync

Status: design, 7 November 2026. M1 is River-only; Amboy is playable solo at
`?map=amboy`, Gracia is being integrated. Multiplayer needs an explicit map
contract.

## 1. Room settings

`room.create` already carries `{name, maxPlayers, map, car}`. Extend the room
state with:

```
map: { id: 'river'|'amboy'|'gracia', layoutHash, packageHash, physicsHash }
```

- The host selects the map in the lobby; guests see it read-only.
- `room.started` carries the same `map` record plus `startTick`.
- The room service stores/relays it; it does **not** serve game data.

## 2. Client checks before start

Each client resolves `map.id` through `map-registry.js` and fetches:

- physics bytes for the map,
- layout,
- render package.

It computes the package/layout/physics hashes and compares them with the room
record. On mismatch it refuses to start with a typed error
(`MAP_PACKAGE_MISMATCH`) and shows the reason in the lobby. No silent fallback
to River.

## 3. Start and authority

- Host starts only when every player is ready **and** every client has reported
  `map-ready` with matching hashes.
- The host runs the map physics/rules; clients run their own car on the same
  map and send inputs.
- Snapshot/remote-car rendering uses the existing 20 Hz path; the remote car
  mesh may be loaded from the map package (same car rule for M1; different-car
  MP is a later gate).

## 4. Solo deep links (already working)

```
?map=river            default
?map=amboy&script=sprint
?map=gracia&script=sprint
```

MP stays `?mp=1&host=1` / `?mp=1&room=CODE`; adding `&map=amboy` is only
accepted for the host and is rejected on guests (they inherit the room map).

## 5. Acceptance

1. Host selects Amboy; guest joins; both load the same package and see the same
   spawn/layout; a mismatched package is refused with a clear message.
2. Two players finish the Amboy measured course (2,060.6 m) and share results.
3. River M1/M2 still pass; Gracia does the same after integration.
4. Console 0 on both pages; screenshots.
5. A guest without the map data cannot start (no empty world, no wrong map).

## 6. Limits

- One map per room; no mid-race map switch.
- No map download from the host; each client uses local game data.
- Package loading is synchronous in the first pass; a loading screen is needed
  for 19–29 MB packages.
- No retail race director or map rotation.
