# M2 — power-up integration plan (weapons, mines, shields, nitro)

Status: design, 7 November 2026. Inputs: PWR1 (`docs/work/analysis/powerups.md`),
R1 (`docs/work/analysis/race-rules.md`), N1 (`docs/work/analysis/net-mvp.md`).

## Scope

Host-authoritative power-ups in the online race:

- pickups spawn on the measured course and are collected by a car;
- a collected item enters the inventory (one active item in M2);
- use fires a weapon/mine/shield/nitro with the recovered values;
- hits apply damage and may wreck/respawn the target;
- shield absorbs, nitro boosts, mine arms/detonates/expires;
- every event is sequenced and broadcast; clients render the result and never
  judge a hit locally.

## Recovered data (PWR1)

- 11 types, 8 with multiplayer enable flags: Nitrous, Shock, Shunt, Blindfire,
  Barge, Bomb/Mine, Repair, Shield (+ SP Fan/Stopwatch/SuperShield).
- 7 variants; 439 MP race rows; 86 AmaxEvent rows; 51 probability lists.
- Proven values include Nitrous duration, Shock inner/outer/lifetime/damage,
  Shield lifetime/health, Bomb radius/outer/lifespan/damage/prime timer,
  Repair amount, pickup radius/deactivate timer.
- Unknown/typed: charge/ammo, projectile lifetime, targeting, hit test/falloff,
  Normal respawn seconds, inventory capacity, shield-absorb semantics, HUD icon
  binding, audio graph wiring, pickup placement.

## Architecture

```
host tick:
  engine step -> vehicle state
  pickup manager (host) -> pickup events
  item use intent (client -> host) -> host validates -> effect
  damage/health -> wreck/respawn
  emit sequenced events + 20 Hz snapshots
client:
  send use intent, render pickups/effects, apply host events, never judge
```

- `PowerupModel` (original rules) consumes PWR1 values; anything provisional is
  labelled in the event payload (`source:'provisional'`).
- Effects: mine entity (position, arm timer, owner, radius), projectile (spawn,
  direction, lifetime), shield (owner, expiry), nitro (owner, expiry).
- Damage: `HealthModel` with impact/damage values; wreck timer; HoG-style reset
  at the last checkpoint (R1 RespawnPolicy).
- Placement: first gate uses a **provisional** pickup set on measured arcs
  (documented, not retail); replace with recovered placement when available.
- HUD: inventory slot, effect timers, shield/damage bar, hit/kill feed.

## Events (PWR1 list, host-sequenced)

`pickup-spawned`, `pickup`, `pickup-rejected`, `pickup-respawn`,
`respawn-unresolved`, `shield-activated`, `super-shield-activated`,
`nitro-activated`, `repaired`, `mine-placed`, `mine-detonated`,
`mine-near-miss`, `mine-expired`, `shock-activated`, `barge-activated`,
`projectile-fired`, `projectile-hit`, `shield-absorbed`, `shield-broken`,
`damage`, `wrecked`, `effect-expired`, `fans-gained`, `stopwatch-gained`.

## Acceptance

1. Two-client race: both see the same pickup spawn/collect and the same hit
   result; the host result is authoritative.
2. Mine: place, arm, hit inside radius, miss outside outer radius, expire.
3. Shield: absorb, break, overflow damage; expiry.
4. Nitro/Shock: duration, speed/effect, expiry, HUD timer.
5. Wreck/respawn: health reaches wreck, timer, reset at the last checkpoint,
   result not corrupted.
6. Determinism: same inputs/events -> same event hash; replay.
7. Console 0, no existing gate regressed; power-up values traced to
   `_work/powerups/powerups.json`.

## Limits

- No retail projectile physics, targeting, hit test, HUD binding or mixer until
  recovered. No AI use of power-ups in M2 (AI1 drives only). No car-to-car
  contact. No full-game claim.
