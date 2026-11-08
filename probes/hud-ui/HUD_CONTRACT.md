# Runtime HUD state contract (`blur.hud-runtime/1`)

English technical contract. The page (or its adapter) calls
`hud.update(state)` once per rendered frame. This file lists every field the
page must pass, its accepted type/range, and exactly what the HUD renders when
the value is absent.

**No guessed values.** A field that is absent, `null`, `NaN`, `Infinity` or out
of its documented range renders `—` and the node carries `data-missing="1"`.
A real zero is rendered as `0` (or `N` for gear) and never as missing.

Style note: the gauge, ring, colour ramp, spacing, colours and type in
`runtime-hud.css` are **project art**. No retail colour, font metric, gauge
shape or icon is claimed.

## `update(state)`

`state` is one plain object. All fields are optional; omitting one is
equivalent to passing `null` for it. `update()` returns `true` while mounted and
`false` after `destroy()`. Repeated identical calls write nothing.

```js
hud.update({
  speedMps: 41.2,          // m/s, finite, any sign (absolute value is used)
  maxSpeedMps: 60,         // m/s, finite, > 0; denominator of the speed gauge
  gear: 4,                 // integer; 0 -> N, negative -> R, 1..6 -> digit
  position: 2,             // integer >= 1
  fieldSize: 8,            // integer >= 1
  lap: 2,                  // integer >= 1
  laps: 3,                 // integer >= 1
  timeSeconds: 86.412,     // seconds, finite, >= 0
  bestLapSeconds: 28.4,    // seconds, finite, >= 0
  powerup: {
    type: 'Bomb',          // string key in HUD_DOCUMENT.powerups
    charges: 2,            // finite, >= 0
    secondsLeft: 4.25,     // seconds, finite, >= 0
    cooldownSeconds: 5     // seconds, finite, > 0; denominator of the ring
  },
  shield: { current: 50, max: 50, secondsLeft: 4.25 },
  health: { current: 78, max: 100 },
  countdown: { label: '2', secondsLeft: 2.4 },
  wrongWay: false,
  feed: [
    'picked up Bomb',
    { type: 'bombed', text: 'Mined' },
    { type: 'shielded' }
  ]
});
```

## Field reference

| Field | Type / range | Rendered | When missing |
| --- | --- | --- | --- |
| `speedMps` | finite number, m/s (sign ignored) | integer mph via `× 2.2369362920544` | `—`, `data-missing="1"`; speed gauge also missing |
| `maxSpeedMps` | finite number, `> 0`, m/s | not printed; speed gauge denominator | speed number still renders; speed gauge `—` / `data-missing="1"` |
| `gear` | integer; `0`, negative, or `1..6` | `0` → `N`, negative → `R`, `1..6` → digit | `—`, `data-missing="1"`, `data-gear="missing"` |
| `gear` out of range | integer `> 6`, or non-integer | `—` (unsupported, not a guess) | `data-gear="out-of-range"` |
| `position` | integer `>= 1` | position number | `—`, `data-missing="1"` |
| `fieldSize` | integer `>= 1` | `/ N` after position | `—`, `data-missing="1"` |
| `lap` | integer `>= 1` | lap number | `—`, `data-missing="1"` |
| `laps` | integer `>= 1` | `/ N` after lap | `—`, `data-missing="1"` |
| `timeSeconds` | finite number `>= 0` | `m:ss.mmm` | `—`, `data-missing="1"` |
| `bestLapSeconds` | finite number `>= 0` | `ss.mmm` (or `m:ss.mmm` above 60 s) | `—`, `data-missing="1"` |
| `powerup` | string, or `{ type, charges?, secondsLeft?, cooldownSeconds? }` | label + glyph + `×N` + `N.NN s` | label `—`, glyph `·`, charges `—`, detail `—`, ring `—` |
| `powerup.type` | string; known key in `HUD_DOCUMENT.powerups` | mapped label/glyph; unknown type → raw string + `?` glyph, `data-kind="unknown"` | whole slot missing |
| `powerup.charges` | finite number `>= 0` | `×N` in `#blur-hud-powerup-charges` | `—`, `data-missing="1"` |
| `powerup.secondsLeft` | finite number `>= 0` | `N.NN s` in `#blur-hud-powerup-detail` | `—`, `data-missing="1"` |
| `powerup.cooldownSeconds` | finite number `> 0` | ring percent = `secondsLeft / cooldownSeconds × 100` | ring `—`, `data-missing="1"` |
| `shield` | number `0..100`, or `{ current, max }` | `N%` or `N / M` + bar | text `—`, bar `data-missing="1"`, no `aria-valuenow` |
| `health` | number `0..100`, or `{ current, max }` | `N%` or `N / M` + bar | text `—`, bar `data-missing="1"`, no `aria-valuenow` |
| `countdown` | `{ label?: string, secondsLeft?: number >= 0 }` | overlay with label + `N.N s` | overlay hidden; label/seconds `—` |
| `wrongWay` | boolean; only strict `true` shows the banner | `WRONG WAY` banner | banner hidden |
| `feed` | array of strings or `{ text?, type?, kind?, expiresAt? }` | last 8 rows | one `—` row, feed `data-missing="1"` |

### Derived values

| Derived value | Formula | Missing rule |
| --- | --- | --- |
| speed gauge percent | `abs(speedMps) / maxSpeedMps × 100`, clamped `0..100`, rounded to 1 decimal | missing if either input is missing or `maxSpeedMps <= 0` |
| cooldown ring percent | `secondsLeft / cooldownSeconds × 100`, clamped `0..100`, rounded to 1 decimal | missing if either input is missing or `cooldownSeconds <= 0` |
| health/shield bar percent | `current / max × 100` (or the number itself), clamped `0..100` | missing if `max <= 0` or either value is non-finite |
| meter colour level | `>= 60` → `ok`, `>= 30` → `warn`, else `critical` | `missing` (project thresholds, not retail) |

`powerup.secondsLeft` is the remaining active/cooldown time and
`powerup.cooldownSeconds` is the full window it counts down from. The ring is
only drawn when both are present; the HUD never assumes a cooldown length.

## DOM additions (stable selectors)

```text
#blur-hud .blur-hud [data-hud="blur.hud-runtime/1"] [data-art="project"]
├─ [data-cluster="speed"]
│  ├─ [data-element="speed"] .blur-hud__card--speed
│  │  └─ [data-gauge="speed"] role="progressbar" [data-percent] [data-missing]
│  │     ├─ .blur-hud__gauge-track   (aria-hidden)
│  │     ├─ .blur-hud__gauge-ticks   (aria-hidden)
│  │     ├─ .blur-hud__gauge-fill    (aria-hidden)
│  │     └─ .blur-hud__gauge-dial
│  │        ├─ #blur-hud-speed       [data-field="speed"]
│  │        └─ #blur-hud-speed-unit  [data-field="speed-unit"]
│  └─ [data-element="gear"] [data-gear="forward|neutral|reverse|out-of-range|missing"]
│     ├─ .blur-hud__label
│     └─ #blur-hud-gear              [data-field="gear"]
├─ [data-cluster="powerup"] [data-element="powerup"] [data-kind]
│  ├─ .blur-hud__label
│  ├─ .blur-hud__powerup-row
│  │  ├─ [data-gauge="cooldown"] role="progressbar" [data-percent] [data-missing]
│  │  │  ├─ .blur-hud__ring-track    (aria-hidden)
│  │  │  └─ .blur-hud__ring-fill     (aria-hidden)
│  │  └─ #blur-hud-powerup-glyph     [data-field="powerup-glyph"]
│  ├─ #blur-hud-powerup              [data-field="powerup"]
│  ├─ #blur-hud-powerup-charges      [data-field="powerup-charges"]
│  └─ #blur-hud-powerup-detail       [data-field="powerup-detail"]
├─ [data-cluster="meters"]
│  ├─ [data-element="health"] #blur-hud-health-bar [data-bar="health"] [data-level]
│  └─ [data-element="shield"] #blur-hud-shield-bar [data-bar="shield"] [data-level]
├─ [data-element="countdown"] [hidden] role="status" aria-live="assertive"
│  ├─ #blur-hud-countdown-label      [data-field="countdown-label"]
│  └─ #blur-hud-countdown-seconds    [data-field="countdown-seconds"]
└─ [data-element="wrongway"] [hidden] role="status" aria-live="assertive"
```

Gauges expose the numeric percent as `data-percent` and drive the CSS
`--gauge` custom property (`0..100`, unitless) for the conic-gradient fill.
`data-level` on a bar fill is one of `ok`, `warn`, `critical`, `missing`.

## `snapshot()`

`snapshot()` reads the live DOM. In addition to the original fields it returns:

```js
{
  fields: {
    // ...existing fields...
    powerupCharges: { text: '×2', missing: false },
    countdownLabel: { text: '2', missing: false },
    countdownSeconds: { text: '2.4 s', missing: false }
  },
  bars: {
    health: { percent: 78, missing: false, level: 'ok' },
    shield: { percent: 100, missing: false, level: 'ok' }
  },
  gauges: {
    speed: { percent: 68.7, missing: false },
    cooldown: { percent: 85, missing: false }
  },
  countdown: { visible: true, missing: false },
  wrongWay: { visible: false }
}
```

## Adapter note (`probes/e1-drive/web/hud-mount.js`)

The driving page adapter currently forwards `speedMps`, `gear`, `position`,
`fieldSize`, `lap`, `laps`, `timeSeconds`, `bestLapSeconds`, `powerup`,
`shield`, `health` and `feed`. To light up the new HUD surfaces it must also
supply:

- `maxSpeedMps` — the vehicle's current top speed in m/s (gauge denominator).
- `powerup.cooldownSeconds` — the active item's full cooldown window.
- `countdown` — during the start countdown.
- `wrongWay` — when the race director flags a wrong-way driver.

Until then those surfaces stay explicitly missing (`—` / hidden); nothing is
defaulted.
