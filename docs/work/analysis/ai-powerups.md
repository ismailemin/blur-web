# AI power-up decisions — recovered retail tables, policy and measured usage

**Date:** 8 November 2026
**Owner:** AI4 (sub-agent)
**Scope:** `probes/ai-driver/**`, `_work/ai-driver/**`, `_work/logs/ai-driver/**` and
this document. No change to `probes/e1-drive/**`, `probes/powerups/**` (read only),
`tools/`, `upstream/` or `game-data/`. Game data is read-only. Nothing is committed.
**Result:** the retail AI power-up decision tables are recovered (`AIPickupController`,
five `AIPickupControllerSetup` rows, eight `PickupType` AI trigger sets), the
`AIPerkUse` / `DifficultyPerks` types are recovered but **empty in every shipped
record**, a deterministic intent-only policy is implemented, **26/26 unit tests**
and **43/43 verification checks** pass, and the River 310 m and loop-01 AI races
finish with 0 respawns while using 8 MP power-up classes. **This is not a
retail-AI-parity or full-game claim.**

---

## 0. TL;DR

| item | result |
| --- | --- |
| controller table | `pickups.bin` `AIPickupController` record **355**, refId **1737121311**, payload abs **76440** |
| difficulty rows | **5**: VeryEasy 447, Easy 811, Normal 153, Hard 416, HardCore 482 |
| setup values | evaluate **0.5 s**, shield evaluate **0.1 s**, fired disable **2 s**, player-hit disable **5 s**, pickup switch **1–3 s**, out-of-range drop **5–20 s**, fire ratio **1.0**, ignore human **0.0** |
| accuracy data | **7** `AIPickupAccuracyGraph` curves + **1** `ShieldedGraph` per setup; x-axis units are **not serialized** |
| per-type triggers | serialized `AIUsageType` + `AIPickupTypes` for all 11 entities (8 MP classes + Fan/Stopwatch/SuperShield) |
| `AIPerkUse` | field exists (`DifficultySettings` offset **64**, type `DifficultyPerks`); **0 entries** in all 258 difficulty blocks |
| `DifficultyPerks` | 36-byte type with 7 fields; **0 records** in `singleplayer.bin` |
| policy | `probes/ai-driver/rules/ai-powerups.mjs`, 8 MP types, SuperShield extension off by default, intents only |
| unit tests | **26/26 PASS** |
| evidence run | 17 scenario runs: 3 profiles × 4 River scenarios + 4 three-AI races + 1 degradation run |
| finishes | **all finished**, **0 respawns**, **0 NaN ticks**, **0 policy violations** |
| double fire | max **1** use per player per tick |
| firing while wrecked/finished | **0** post-finish intents |
| race usage | reference **13**, standard **4**, cautious **0** uses across the four races |
| solo usage | cautious **3**, standard **5**, reference **5** uses across four solo runs |
| determinism | two process-separated result files byte-identical, `sha256:c1d960bcb713ecb22459d8c0bd2c797469c74b5325ff436cade255fc57f3ebb8` |
| verifier | **43/43 PASS** |

---

## 1. Sources and hashes

All game payloads are entries in `game-data/Blur/cache/gamedata.pak` (V2, codec 2
zlib, secure FAT). The decoded bytes used here are the PWR1/PWR4 probe outputs in
`_work/powerups/`, read only.

| source | path | SHA-256 (decoded) |
| --- | --- | --- |
| pickup definitions | `\gamedata\xt\pickups.bin` | `f8e9ba3d0749dcb2b7b775c25fc1e0ec5c337b4835efa947f0cfe329a4965ed7` |
| single-player settings | `\gamedata\xt\singleplayer.bin` | `14af6d07a0fe6eb84253c794e1473196098eeeed215dd7988a8c387d86d65f19` |
| multiplayer settings | `\gamedata\xt\multiplayer.bin` | `0dcf60bc5306069c2dfa6a4d89701a27f0e789235a1bcf5f9aa2167d9ef6ab48` |

| local decoded input | path | bytes | SHA-256 |
| --- | --- | ---: | --- |
| pickup Flask | `_work/powerups/pickups.xt` | 132,056 | recorded in `recovered-ai-powerups.json.sources[0]` |
| single-player Flask | `_work/powerups/singleplayer.xt` | 120,736 | recorded in `recovered-ai-powerups.json.sources[1]` |
| PWR1 manifest | `_work/powerups/powerups.json` | 982,981 | `6ee5a3e699187086665b4b5330abcda29859e77b4464edae65e6ed00b7bc73d7` |
| recovered AI manifest | `_work/ai-driver/recovered-ai-powerups.json` | 165,550 | `7f0e236873a8a1a160bf8599e0c07fae0f54a991c34f7f403fb0679de4d29085` |
| scenario results | `_work/ai-driver/results-powerups.json` | 138,027 | `c1d960bcb713ecb22459d8c0bd2c797469c74b5325ff436cade255fc57f3ebb8` |
| verifier report | `_work/ai-driver/verify-powerups.json` | 17,739 | `63f6bc3201c9d6bf2fb0ec374472ea8491b78da6b02532b0699b3c9eba27628e` |

Recovery script: `_work/ai-driver/recover-ai-powerups.py` (read-only import of
`probes/powerups/tools/xt_decode.py`; writes only under `_work/ai-driver/`).

---

## 2. Recovered AI power-up decision data

### 2.1 Controller and difficulty rows

`pickups.bin` `AIPickupController` record **355** (refId **1737121311**, payload
absolute **76,440**) has a `Controllers` array of five
`AIPickupControllerDifficulty` elements. Each element points at one
`AIPickupControllerSetup` record:

| difficulty | setup record | setup refId | setup payload abs | `PickupSwitchTime` |
| --- | ---: | ---: | ---: | ---: |
| VeryEasy | 447 | 2241696437 | 86,920 | 3.0 s |
| Easy | 811 | 4063194058 | 125,332 | 3.0 s |
| Normal | 153 | 742508891 | 55,368 | 2.0 s |
| Hard | 416 | 2101837824 | 83,236 | 1.0 s |
| HardCore | 482 | 2415460375 | 91,452 | 1.0 s |

The mapping is a typed cross-record handle
(`Controller` → `AIPickupControllerSetup`), not a name match. The five setup
records are **153, 416, 447, 482, 811**.

### 2.2 `AIPickupControllerSetup` fields

Every setup shares the same 56-byte struct (`fieldOffsets` in
`recovered-ai-powerups.json`):

| field | offset | Normal value | meaning |
| --- | ---: | ---: | --- |
| `EvaluateTimeInSeconds` | 0 | 0.5 | offensive/utility decision cadence |
| `EvaluateShieldTimeInSeconds` | 4 | 0.1 | defensive shield reaction cadence |
| `BeenHitWithPerkDisableTime` | 8 | 0.0 | post-hit lock (serialized 0) |
| `OutOfRangePickDropTimeMin` | 12 | 5.0 | minimum out-of-range hold before drop |
| `OutOfRangePickDropTimeMax` | 16 | 20.0 | maximum out-of-range hold |
| `PickupSwitchTime` | 20 | 2.0 | delay between pickup decisions (1–3 s by difficulty) |
| `FiredPerkDisableTime` | 24 | 2.0 | post-fire lock |
| `PlayerHitWithPerkDisableTime` | 28 | 5.0 | post-hit perk lock |
| `FireProbabilityRatio` | 32 | 1.0 | fire probability scalar |
| `IgnoreHumanRatio` | 36 | 0.0 | ignore-human scalar |
| `AIPickupAccuracyGraphs` | 40 | 7 graphs | AI aim probability vs distance |
| `ShieldedGraph` | 48 | 5 keyframes | shield reaction curve |

Only `PickupSwitchTime` differs between the five setups (3 / 3 / 2 / 1 / 1 s);
the other scalars are identical. The 7 accuracy graphs and the `ShieldedGraph`
are serialized as `RLPickupAccuracyHermiteKeyFrame` arrays (`Distance`,
`Probability`, `InTangent`, `OutTangent`). The graph-to-pickup-class index order
and the x-axis units are **runtime code, not serialized**; they are recorded but
not used as a hit probability in this task (`provisional`).

### 2.3 Per-type aggression and targeting

Each `PickupType` carries `AIUsageType` (`Aggressive` / `Passive`) and an
`AIPickupTypes` trigger array. Serialized values:

| pickup | usage | trigger |
| --- | --- | --- |
| Nitrous | Passive | empty `AIPickupTrigger` |
| Shock | Aggressive | `EnemyInRange` 50/0, then `AheadOfEnemy` 80/45 and 200/20 |
| Shunt | Aggressive | `EnemyInRange` 40/40, 30/30, 20/20 |
| Blindfire | Aggressive | `EnemyInRange` 40/40, 30/30, 20/20 |
| Barge | Aggressive | no trigger array |
| Bomb | Aggressive | empty `AIPickupTrigger` |
| Repair | Passive | 3× `DamageLevel` selectors |
| Shield | Passive | no trigger array |
| Fan | Passive | no trigger array |
| Stopwatch | Aggressive | no trigger array |
| SuperShield | Passive | empty array |

The `EnemyInRange` payload is `WeaponDistanceAdjustment` and
`WeaponAngleAdjustment`; `AheadOfEnemy` is `DistanceFromPlayer` /
`AngleFromPlayer` (both degrees/metres as serialized). **Interpreting them as
fire gates is `provisional`**; the serialized values are exact.

### 2.4 `AIPerkUse` and `DifficultyPerks` — recovered but empty

The schema exists but the shipped data does not use it:

| item | evidence |
| --- | --- |
| `DifficultySettings.AIPerkUse` | field offset **64**, typeIndex **102** (`DifficultyPerks`), array behaviour 3 |
| `DifficultyPerks` | 36-byte struct, 7 fields: `OpponentIndex` 0, `MaxPerkLevel` 4, `PerkToGrant` 8, `GrantTimeMin` 12, `GrantTimeMax` 16, `CharactersNeverTargetted` 20, `PreferredPickups` 28 |
| `DifficultyPerks` records | **0** in `singleplayer.bin` |
| `AIPerkUse` entries | **0** across **86** `AmaxEvent` records × 3 difficulty blocks (Easy offset 92, Medium 184, Hard 276) |
| `Opponents[*].PerkGiftTypes` | empty in all **932** opponent setups |
| `Opponents[*].AlwaysShields` | true in **1** setup (Boss Battle Part 1, opponent 3) |

Therefore there is **no serialized per-difficulty AI perk-use/grant policy**. Any
profile-to-difficulty mapping, aim lead, mine chase rule or shield threat radius
is a project value and is labelled `provisional` in the policy and in this
document. This agrees with SS1's finding in `supershield.md` §3.1.

Exact per-event offsets are stored for all 86 events in
`recovered-ai-powerups.json.singlePlayer.amaxEventOffsets[]`. For example,
event record 0 (refId 4597671) has payload absolute **20,068**; its
`AIPerkUse` field is at Easy **20,224**, Medium **20,316**, Hard **20,408**
(array component/element `0xFFFF`/`0xFFFF`, length **0** in all three).

### 2.5 Timing values used by the policy

| value | source | value |
| --- | --- | ---: |
| Nitrous duration | `NitrousBalancingData.Duration` | 1.3 s (checkpoint 2.5 s) |
| Shield lifetime | `ShieldBalancingData.Lifetime` | 6 s (DoubleTap 12 s) |
| Shield health | `ShieldBalancingData.Health` | 50 (prototype absorb model) |
| Bomb place-behind | `BombBalancingData.PlaceBehindDistance` | 5 m |
| Bomb arm timer | `BombBalancingData.MasterMinePrimeTimer` | 0.3 s |
| Bomb radii | `Radius` / `OuterRadius` | 1.0 m / 3.5 m |
| Bomb lifespan | `Lifespan` | 60 s |
| Barge radius | `Radius` + runtime +0.5 | 7.0 + 0.5 = 7.5 m |
| Barge duration | `Duration` | 0.4 s |
| Repair amount | `AmountToRepair` | 400 (health scale runtime-only) |
| Shunt / Blindfire | PWR4 | damage 100/50 and 50, speed/homing runtime |

**Not serialized** (typed `provisional` in the policy): aim lead (0 s), Bomb
chase distance/angle (40 m / dot −0.3), shield threat radius (120 m), shield
behind distance (60 m), Nitrous minimum speed (10 m/s), Repair health fraction
(any damage), accuracy-graph index/units, drop-time choice inside 5–20 s.

---

## 3. Policy module

**File:** `probes/ai-driver/rules/ai-powerups.mjs`
**Kind:** `blur.ai-powerup-policy` version 1.

The module is a pure policy: it never calls the host world, the engine or any
effect. It consumes the same pickup/weapon event contract as the human slice
(`pickup`, `nitro-activated`, `shield-activated`, `mine-placed`,
`projectile-fired`, `damage`, `wrecked`, ...) and returns **intents**.

```js
const policy = createAiPowerupPolicy({
  profileId: 'reference',            // cautious | standard | reference | aggressive
  capabilities: { types: [...], superShield: false }
});
const decision = policy.decide({
  tick, self, opponents, pickups, mines, effects, events, finished
});
// decision.intents[]  -> host-applied
// decision.diagnostics[] -> typed skips
// decision.hash       -> canonical SHA-256 of the decision
```

### 3.1 Profile mapping (provisional)

The existing driver profiles are speed-only, so the policy maps them to the five
recovered difficulty rows:

| profile | difficulty | setup record | pickup switch |
| --- | --- | ---: | ---: |
| cautious | Easy | 811 | 3.0 s |
| standard | Normal | 153 | 2.0 s |
| reference | Hard | 416 | 1.0 s |
| aggressive (experimental) | HardCore | 482 | 1.0 s |

The mapping is a project choice; the difficulty rows and their values are
serialized.

### 3.2 Intent types

| intent | payload | host action |
| --- | --- | --- |
| `pickup` | `pickupId, pickupType, distance, radiusMetres, reason` | validate active + within 2.0 m + slot space, then `world.pickup` |
| `use` | `slot, pickupType, targetId?, position?, aim?, trigger?, shield?, drop?, reason` | validate slot/type/target, then `world.use` |
| `drop` | `slot, pickupType, reason:'out-of-range-timeout', detail` | remove the item; emit `pickup-dropped` (**extension**) |

Diagnostics carry `{kind:'skip', pickupType, reason, detail}` with a typed reason:
`unsupported-type`, `no-target`, `out-of-range`, `not-needed`, `already-active`,
`no-threat`.

### 3.3 Type rules

| type | rule |
| --- | --- |
| Nitrous | use above the provisional 10 m/s and below 0.5 steer; 1.3 s duration |
| Shock | fire at the lowest-race-position target that satisfies 50/0, 80/45 or 200/20 |
| Shunt | target ahead within the 40/40, 30/30 or 20/20 tier and the human 500 m / 45° rule |
| Blindfire | forward fire (no target id) when an ahead target satisfies a trigger tier |
| Barge | use when an opponent is inside the serialized 7.0 + 0.5 m radius |
| Bomb | drop behind at 5 m when chased, or as a trap after the 5 s out-of-range hold |
| Repair | use only when damaged; `AmountToRepair=400` with runtime health scale |
| Shield | react on the 0.1 s cadence to an incoming projectile/mine or a chaser behind |
| SuperShield | extension only; off by default; same reaction rule; 10 s lifetime |

Cooldowns: 2 s after firing, 5 s after being hit, 1–3 s between pickup decisions,
and a drop after 5 s of continuous "no valid use" (the serialized 5–20 s window,
using the minimum deterministically). The policy emits at most one use per tick.

### 3.4 Graceful degradation

`capabilities.types` is the supported slice. A held type outside it is skipped
with `reason:'unsupported-type'` and `detail.supportedTypes`; it is never fired
as a placeholder. `Fan`, `Stopwatch` and (default) `SuperShield` are outside the
8-type MP slice. The verifier proves this with a dedicated 3-slot run.

### 3.5 Determinism

The policy reads only the integer tick, the supplied state/events and its own
previous decisions. It contains no `Math.random`, `Date.now`, `performance.now`,
`new Date`, `setTimeout` or `setInterval` (the verifier scans the source with
comments stripped). Every decision is hashed with canonical sorted-key JSON and
SHA-256.

---

## 4. Measured usage

**Command:** `node probes/ai-driver/run-powerups.mjs` (twice; the first result is
copied to `results-powerups.previous.json`).
**Car:** `corvette-zr1-stock` for every run (the profiles differ only in the
retail difficulty row and the existing speed scale).
**Host config:** pickup radius 2.0 m, inventory capacity 2 (runtime-only in the
retail data; host choice), leader-first arbitration for contested pickups.

### 4.1 Solo runs (no opponents, one AI)

| course | pickup scenario | cautious (Easy) | standard (Normal) | reference (Hard) |
| --- | --- | --- | --- | --- |
| 310 m | PWR2 provisional 6 (Bomb/Shield/Repair) | 1 Bomb | 1 Bomb | 1 Bomb |
| 310 m | 12-slot 8-type provisional | 1 Nitrous | 1 Nitrous | 1 Nitrous |
| loop-01 | recovered (Shield, Repair) | 0 | 0 | 0 |
| loop-01 | 12-slot 8-type provisional | 1 Bomb | 3 (2 Nitrous + 1 Bomb) | 3 (2 Nitrous + 1 Bomb) |

Totals over the four solo runs: **cautious 3 (0.75/run)**, **standard 5
(1.25/run)**, **reference 5 (1.25/run)**. The cautious profile still collects
the loop set, but its 0.85 speed target keeps it below the provisional 10 m/s
Nitrous threshold at the pickup points, so it uses only the Bomb trap; the
other two profiles use Nitrous and Bomb. Solo runs have no target for the
offensive types, so only Nitrous and the Bomb trap are used; this is the
expected result, not a policy failure.

### 4.2 Three-AI races (shared pickup world, independent wasm per AI)

| course | pickup scenario | reference (Hard) | standard (Normal) | cautious (Easy) |
| --- | --- | --- | --- | --- |
| 310 m | PWR2 provisional 6 | 4 (2 Bomb + 2 Shield) | 0 | 0 |
| 310 m | 12-slot 8-type | 3 (2 Nitrous + 1 Shield) | 3 (1 Blindfire + 1 Bomb + 1 Shunt) | 0 |
| loop-01 | recovered | 1 Shield | 0 | 0 |
| loop-01 | 12-slot 8-type | 5 (2 Nitrous + 1 Barge + 1 Bomb + 1 Shield) | 1 Blindfire | 0 |

Race totals: **reference 13**, **standard 4**, **cautious 0** uses. The leader
(arrival order) consumes the contested pickups first; the chasers use the
offensive types that need a target ahead (Shunt, Blindfire, Bomb, Shock). The
cautious car is last on every course and receives the leftovers, which is why
its measured race count is zero. These are measured outcomes, not tuning targets.

### 4.3 Finish, safety and event validity

| check | result |
| --- | --- |
| runs | 17 (4 solo scenarios × 3 profiles, 4 races, 1 degradation) |
| all rows finished | yes |
| respawns | 0 |
| NaN ticks | 0 |
| policy violations (`use-rejected`, `pickup-out-of-radius`, double use, ...) | 0 |
| max use events per player per tick | 1 |
| post-finish intents / post-finish uses | 0 / 0 |
| world events | valid `seq`, `type`, `at`, `authority`; monotonic `seq`; 0 invalid |
| contested pickups | counted as `contention`, not violations |

### 4.4 Graceful degradation run

The reference profile runs the 310 m with `Shock` and `Bomb` removed from
`capabilities.types` and a 3-slot layout `[Shock, Shield, Bomb]`:

- `supportedTypes` = Barge, Blindfire, Nitrous, Repair, Shield, Shunt;
- `useCounts` has no Shock and no Bomb (0 uses);
- typed skips: **Shock 1**, **Bomb 1** (plus Shield 11 "no-threat" holds);
- finish 14.650000 s, 0 respawns, 0 violations.

The AI therefore skips unsupported weapons with a typed reason instead of firing
a placeholder.

---

## 5. Determinism evidence

| evidence | value |
| --- | --- |
| two process-separated result files | byte-identical, `sha256:c1d960bcb713ecb22459d8c0bd2c797469c74b5325ff436cade255fc57f3ebb8` |
| decision aggregate | `sha256:3b0a1114762489b2b83160972a3098e7b62b3b82ae9a99595035ea81784d08ca` |
| event aggregate | `sha256:cdc8e6d10cebc06ac47e7b073e761704292f4c59dd707543d865ee87ce40520c` |
| per-scenario run hashes | 17 hashes, identical in both processes (`results-powerups.json.determinism.runHashes`) |
| unit-test determinism | 26/26, including identical per-tick decision hashes for a 300-tick sequence |
| base AI driver regression | `node probes/ai-driver/verify.mjs` 26/26; `verify-maps.mjs` 25/25 |

Logs: `_work/logs/ai-driver/run-powerups.log`,
`_work/logs/ai-driver/run-powerups-second.log`,
`_work/logs/ai-driver/verify-powerups.log`.

---

## 6. Integration contract for e1-drive (no e1-drive change made)

### 6.1 Where the host calls the policy

Per AI, per fixed 60 Hz tick, **after** the engine step and state read, and
**after** the host power-up world has advanced (`world.advance(1/60)`):

```text
engine.step(input)                       // existing AI driver four-channel input
state = engine.getState()
driver.observe(state, raceTick)          // existing checkpoint/lap/respawn observer
powerWorld.advance(1/60)                 // human slice: mines, effects, respawn
decision = aiPolicy.decide({ ... })      // pure; no side effects
host.apply(decision.intents)             // host-validated, authoritative
```

The AI driver remains the only producer of the four-channel vehicle input. The
power-up policy is a second, independent decision stream; it does not steer or
throttle the car.

### 6.2 Input payload

The host passes a snapshot, never live objects:

```js
{
  tick,                                  // integer race tick
  self: {
    id, position:{x,z}, heading, speed, steer,
    health, maxHealth, alive, finished,
    inventory: [{ type, level }], inventoryCapacity,
    effects: [{ id, kind, ownerId, expiresAt }]
  },
  opponents: [{ id, position:{x,z}, heading, speed, alive, racePosition, progress }],
  pickups: [{ id, type, position:{x,z}, state }],
  mines: [{ id, ownerId, position, armAt, expiresAt }],
  effects: [{ id, kind, ownerId, expiresAt }],
  events: [{ seq, type, at, authority, tick, ...eventPayload }],
  finished
}
```

`events` is a rolling window (the harness keeps 3 s) with `tick` derived from the
authoritative `at`; the policy uses it for projectile/mine threats and damage
locks.

### 6.3 Output intents and host validation

```js
{ kind:'pickup', pickupId, pickupType, distance, radiusMetres, reason:'proximity' }
{ kind:'use', slot, pickupType, targetId?, position?, aim?, trigger?, shield?, drop?, reason }
{ kind:'drop', slot, pickupType, reason:'out-of-range-timeout', detail }
{ kind:'skip', pickupType, reason, detail }   // diagnostics only, no host action
```

Host rules (the policy never performs them):

1. `pickup`: the pickup must be active, within `PickupRadius = 2.0 m`, and the
   inventory must have a free slot. A contested pickup is resolved by applying
   intents in descending race progress (leader first), not roster order.
2. `use`: the slot must still hold the declared type; the player must be alive
   and not finished; at most one use per player per tick. Target state is
   re-checked by the host.
3. `drop`: remove the item and emit `pickup-dropped`
   (`{playerId, pickupType, slot, reason, source:'ai-contract-extension'}`).
   This event is a **contract extension**; the current human slice has no drop
   verb, so a host that does not implement it may ignore the intent (the AI then
   keeps the item and loses throughput).
4. Apply `world.use(playerId, {slot, targetId, position})` and
   `world.pickup(pickupId, playerId)` exactly as for a human.
5. Projectile hit resolution stays host-authoritative. This task fires
   projectiles and validates the fire event; it does not judge hits. The PWR4
   projectile model is the right resolver.

### 6.4 Guests

- The host owns AI intent generation and application. AI intents are **never**
  sent on the wire.
- Guests receive the same authoritative pickup/use/hit/drop events as for human
  players, in `seq` order, plus the 20–30 Hz snapshot. The existing
  `NetPlayerVehicle.pickupSlots` / `shieldSlots` fields should carry the AI
  inventory/effect state; do not add a second inventory model.
- Clients treat AI cars as ordinary remote participants and never simulate their
  power-up policy.
- Late join: send active pickups, mines, effects, AI inventories/cooldowns and
  the next `seq`, then replay events.

### 6.5 R1/N1 wiring

1. Add AI ids to the roster as host-controlled participants (as already done in
   `docs/work/analysis/ai-driver.md` §10).
2. Create one `PowerupSession` per race from the human slice and one
   `createAiPowerupPolicy` per AI. The policy profile is the AI difficulty field.
3. Each tick: existing AI input step → power-up world step → policy decision →
   host validation/application → existing rules snapshot.
4. On respawn, keep the AI power-up world entry (inventory persists unless the
   rules drop it) and re-prime the driver as today.
5. At finish, the policy returns no intents (`phase:'finished'`); the host must
   reject any late intent for a finished/wrecked AI.

No `probes/e1-drive/**` file was modified; the contract above is additive.

---

## 7. Limits and non-claims

- **No retail AI parity.** The policy is an original deterministic rule set
  driven by recovered trigger/timing thresholds. There is no retail behaviour
  tree, `.aid` route, or race-director parity.
- **`AIPerkUse` / `DifficultyPerks` are empty.** The shipped single-player data
  has 0 records and 0 entries, so no per-difficulty perk grant policy is claimed.
  The profile → difficulty mapping is `provisional`.
- **Trigger interpretation is provisional.** `EnemyInRange` / `AheadOfEnemy`
  values are exact; treating them as fire gates is not proven from runtime code.
- **Accuracy graphs are recorded, not used as hit probability.** The 7-graph
  class index and x-axis units are not serialized. Aim lead is 0 s
  (`provisional`); Shunt uses its runtime homing outside this slice.
- **Provisional policy values:** Bomb chase distance/angle, shield threat radius,
  shield behind distance, Nitrous minimum speed, Repair health fraction, drop
  choice inside the 5–20 s window, inventory capacity 2, leader-first contested
  pickup arbitration.
- **No projectile hit judgement.** The harness emits `projectile-fired` but does
  not resolve travel/hits/damage; usage counts are fire events. Shield reaction
  is proven with a host-injected incoming event and the unit tests.
- **Pickup layouts are mixed.** The 310 m PWR2 6-slot plan is the documented
  `provisional` plan; the 12-slot 8-type layouts are project extensions. The
  loop-01 recovered run uses only the two shipped placements within 2.0 m
  (Shield, Repair). No pickup position was moved.
- **No Amboy run in this evidence set.** The harness supports `--amboy` (tuned
  `minSpeed` 3.5, recovered + provisional scenarios), but the River results were
  prioritised; the recovered Amboy set has only one placement within 2.0 m.
- **Inventory capacity 2 is a host config.** The retail pickup-slot capacity is
  runtime-only; the unit tests exercise capacity 1 slot limits.
- **No e1-drive, renderer, audio, UI or full-game claim.** No browser capture was
  run; this is a headless Node/wasm evidence task.

---

## 8. Reproduce

```powershell
node probes/ai-driver/rules/ai-powerups.test.mjs

node probes/ai-driver/run-powerups.mjs
Copy-Item _work/ai-driver/results-powerups.json _work/ai-driver/results-powerups.previous.json
node probes/ai-driver/run-powerups.mjs
node probes/ai-driver/verify-powerups.mjs

# base AI regression (unchanged)
node probes/ai-driver/verify.mjs
node probes/ai-driver/verify-maps.mjs
```

Optional Amboy run (separate output is not wired; it overwrites the River results
file, so copy it first):

```powershell
node probes/ai-driver/run-powerups.mjs --amboy
```

---

## 9. Evidence paths

| evidence | path |
| --- | --- |
| policy module | `probes/ai-driver/rules/ai-powerups.mjs` |
| unit tests | `probes/ai-driver/rules/ai-powerups.test.mjs` |
| evidence harness | `probes/ai-driver/run-powerups.mjs` |
| independent verifier | `probes/ai-driver/verify-powerups.mjs` |
| recovered AI manifest | `_work/ai-driver/recovered-ai-powerups.json` |
| recovery script | `_work/ai-driver/recover-ai-powerups.py` |
| scenario results | `_work/ai-driver/results-powerups.json` |
| second identical process run | `_work/ai-driver/results-powerups.previous.json` |
| check-by-check verification | `_work/ai-driver/verify-powerups.json` |
| run logs | `_work/logs/ai-driver/run-powerups.log`, `_work/logs/ai-driver/run-powerups-second.log` |
| verifier log | `_work/logs/ai-driver/verify-powerups.log` |
| PWR1 definitions | `_work/powerups/powerups.json` |
| PWR3 placements | `_work/powerups/placements.json` |
| base AI driver | `probes/ai-driver/ai-driver.mjs` and `docs/work/analysis/ai-driver.md` |
| human power-up slice | `probes/powerups/rules/engine.js` |
| projectile model | `probes/powerups/rules/projectiles.js` and `docs/work/analysis/powerup-projectiles.md` |
