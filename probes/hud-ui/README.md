# Runtime HUD (`blur.hud-runtime/1`)

Small, mountable, DOM-only HUD for the browser remake. It is the runtime layer
the driving page can import; `hud.mjs` remains the larger HUD2 model/preview
module.

- **No dependencies.** Plain ES modules, no canvas, no WebGPU, no timers.
- **No simulation state.** Every value comes from `update(state)`.
- **No invented labels.** All static strings live in `hud-document.mjs`, which
  records the retail loc key or the documented project-constant reason.
- **No guessed zeros.** Missing / non-finite values render `—` and carry
  `data-missing="1"`; bars drop `aria-valuenow` instead of claiming `0`.
- **Deterministic.** The same state produces the same DOM and the same
  `snapshot()`; a repeated `update()` writes nothing.

## Import contract

```js
import { createHud, HUD_SCHEMA, HUD_DOCUMENT } from './probes/hud-ui/runtime-hud.mjs';

const hud = createHud({
  doc: HUD_DOCUMENT,          // committed HUD document; defaults to HUD_DOCUMENT
  host: document.getElementById('hud-mount'),
  now: () => performance.now() // optional clock, used only for feed `expiresAt`
});

hud.update({
  speedMps: 41.2,
  gear: 4,
  position: 2,
  fieldSize: 8,
  lap: 2,
  laps: 3,
  timeSeconds: 86.412,
  bestLapSeconds: 28.4,
  powerup: { type: 'Bomb', charges: 2, secondsLeft: 4.25 },
  shield: { current: 50, max: 50, secondsLeft: 4.25 },
  health: { current: 78, max: 100 },
  feed: [
    'picked up Bomb',
    { type: 'bombed', text: 'Mined' },
    { type: 'shielded' }
  ]
});

const rendered = hud.snapshot(); // exactly what the DOM shows
hud.destroy();                   // removes the root and the resize listener
```

`HUD_SCHEMA` is `'blur.hud-runtime/1'`. `createHud` throws if `host` is not a DOM
element, if the document is not the committed HUD document, or if the host
already owns a runtime HUD. Call `destroy()` before mounting again.

The module is a static ES module. If the driving page is served from
`probes/e1-drive/web/`, import it as `../../hud-ui/runtime-hud.mjs` with the
repository root as the server root, or copy `runtime-hud.mjs` and
`hud-document.mjs` next to the page.

## State contract

| Field | Accepted value | Rendering |
| --- | --- | --- |
| `speedMps` | finite number | absolute m/s → integer mph (`× 2.2369362920544`) |
| `gear` | finite number | `0` → `N`, negative → `R`, otherwise the number |
| `position` | integer ≥ 1 | position number |
| `fieldSize` | integer ≥ 1 | `/ N` |
| `lap` | integer ≥ 1 | lap number |
| `laps` | integer ≥ 1 | `/ N` |
| `timeSeconds` | finite number ≥ 0 | `m:ss.mmm` |
| `bestLapSeconds` | finite number ≥ 0 | `ss.mmm` (or `m:ss.mmm` above 60 s) |
| `powerup` | string or `{ type, charges?, secondsLeft? }` | label + glyph + `×N · N.NN s` |
| `shield` | number (percent 0–100) or `{ current, max }` | text + bar |
| `health` | number (percent 0–100) or `{ current, max }` | text + bar |
| `feed` | array of strings or `{ text?, type?, kind?, expiresAt? }` | last 8 rows |

Feed entries with a known retail event `type` use the recovered `HUD_PT_*`
string (for example `bombed` → `Mined`, `shielded` → `Shielded`). A supplied
`text` always wins. An unknown `type` renders the raw type and sets
`data-kind="unknown"`. `expiresAt` is compared against `now()` in milliseconds.

## DOM structure

Mount one HUD per page. Stable ids are provided for the driving page; use the
`data-field` / `data-element` selectors if more than one HUD is ever mounted.

```text
#blur-hud .blur-hud [data-hud="blur.hud-runtime/1"] [data-art="project"]
├─ .blur-hud__cluster--status [data-cluster="status"]
│  ├─ .blur-hud__card--position [data-element="position"]
│  │  ├─ .blur-hud__label                 "Position"
│  │  ├─ #blur-hud-position               [data-field="position"]
│  │  └─ #blur-hud-position-total         [data-field="position-total"]
│  ├─ .blur-hud__card--lap [data-element="lap"]
│  │  ├─ .blur-hud__label                 "Laps"
│  │  ├─ #blur-hud-lap                    [data-field="lap"]
│  │  └─ #blur-hud-lap-total              [data-field="lap-total"]
│  └─ .blur-hud__card--time [data-element="time"]
│     ├─ .blur-hud__label                 "TIME"
│     ├─ #blur-hud-time                   [data-field="time"]
│     ├─ .blur-hud__label--inline         "Best"
│     └─ #blur-hud-best-lap               [data-field="best-lap"]
├─ .blur-hud__cluster--speed [data-cluster="speed"]
│  ├─ .blur-hud__card--speed [data-element="speed"]
│  │  ├─ #blur-hud-speed                  [data-field="speed"]
│  │  └─ #blur-hud-speed-unit             [data-field="speed-unit"] "MPH"
│  └─ .blur-hud__card--gear [data-element="gear"]
│     ├─ .blur-hud__label                 "GEAR"
│     └─ #blur-hud-gear                   [data-field="gear"]
├─ .blur-hud__cluster--powerup [data-cluster="powerup"]
│  └─ .blur-hud__card--powerup [data-element="powerup"] [data-kind]
│     ├─ .blur-hud__label                 "Power-up"
│     ├─ #blur-hud-powerup-glyph          [data-field="powerup-glyph"]
│     ├─ #blur-hud-powerup                [data-field="powerup"]
│     └─ #blur-hud-powerup-detail         [data-field="powerup-detail"]
├─ .blur-hud__cluster--meters [data-cluster="meters"]
│  ├─ .blur-hud__meter--health [data-element="health"]
│  │  ├─ .blur-hud__label                 "HEALTH"
│  │  ├─ #blur-hud-health                 [data-field="health"]
│  │  └─ .blur-hud__bar-track > #blur-hud-health-bar [data-bar="health"]
│  └─ .blur-hud__meter--shield [data-element="shield"]
│     ├─ .blur-hud__label                 "SHIELD"
│     ├─ #blur-hud-shield                 [data-field="shield"]
│     └─ .blur-hud__bar-track > #blur-hud-shield-bar [data-bar="shield"]
└─ .blur-hud__feed-wrap [data-element="feed-wrap"]
   ├─ .blur-hud__label                    "Events"
   └─ #blur-hud-feed [data-field="feed"] [data-element="feed"]
      └─ li.blur-hud__feed-item [data-kind] [data-missing?]
```

Bars are `<i role="progressbar" aria-valuemin="0" aria-valuemax="100">` and set
`aria-valuenow` plus `style.width` only when a value exists. When missing they
carry `data-missing="1"`, have no `aria-valuenow`, and are empty.

## Snapshot

`snapshot()` reads the live DOM and returns:

```js
{
  schema: 'blur.hud-runtime/1',
  labels: {
    root: 'race HUD, display only',
    position: 'Position',
    lap: 'Laps',
    time: 'TIME',
    best: 'Best',
    speedUnit: 'MPH',
    gear: 'GEAR',
    powerup: 'Power-up',
    health: 'HEALTH',
    shield: 'SHIELD',
    feed: 'Events'
  },
  fields: {
    speed: { text: '92', missing: false },
    speedUnit: { text: 'MPH', missing: false },
    gear: { text: '4', missing: false },
    position: { text: '2', missing: false },
    positionTotal: { text: '/ 8', missing: false },
    lap: { text: '2', missing: false },
    lapTotal: { text: '/ 3', missing: false },
    time: { text: '1:26.412', missing: false },
    bestLap: { text: '28.400', missing: false },
    powerup: { text: 'MINE', missing: false, kind: 'bomb' },
    powerupGlyph: { text: 'M', missing: false },
    powerupDetail: { text: '×2 · 4.25 s', missing: false },
    health: { text: '78 / 100', missing: false },
    shield: { text: '50 / 50', missing: false }
  },
  bars: {
    health: { percent: 78, missing: false },
    shield: { percent: 100, missing: false }
  },
  feed: {
    items: [{ text: 'picked up Bomb', kind: 'info', missing: false }],
    missing: false,
    empty: false
  },
  layout: { compact: false }
}
```

After `destroy()`, `snapshot()` returns `null` and `update()` returns `false`.

## Tests

```powershell
node --test probes/hud-ui/test/
```

The suite uses the `probes/game-shell/test/dom-shim.mjs` pattern and covers:
every field, missing/NaN/Infinity values, zero-as-value, power-up variants,
feed mapping/limit/expiry/empty state, snapshot-vs-DOM equality, idempotent
updates, deterministic mounts, and listener removal on `destroy()`.

## Evidence

- `hud-document.mjs` records the SHA-256 of
  `_work/hud/raw/gamedata_xt_loc_hud.loc` and
  `_work/hud/hud_objects_dump.txt`, plus the retail `HUD_*` key for each label.
- The document is data only. No retail pixels, track geometry or simulation
  values are embedded.
