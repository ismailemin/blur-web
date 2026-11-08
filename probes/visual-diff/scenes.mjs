// Scene catalogue for the visual-diff harness.
//
// Every scene is deterministic by construction:
//   * `app` scenes load the committed E1 drive page at a URL whose `hold=<tick>`
//     parameter replays the deterministic scripted run (sprint / lap / free /
//     map) and holds the engine at that tick with interpolation alpha 0; the
//     page renders that still state every animation frame.
//   * `parity` scenes call `window.__parityPose(key)` on the committed
//     retail-parity fixed-pose page: a fixed world camera and a reconstructed
//     car pose, no physics run.
//   * `powerups` loads the multiplayer lobby with `?powerups=1` and waits for
//     the settled lobby + power-up HUD; the room code / connection lines are
//     masked (they are the only deliberately variable text).
//
// `overlays: 'hidden'` means the harness injects a stylesheet that hides the
// live DOM overlays (`#hud` frame counter, legend, keys, car picker, banners)
// before the frame is captured, so the whole 1600x900 canvas is under test.
// `overlays: 'visible'` keeps the product overlays and masks only the volatile
// rectangles listed in `masks` (resolved from the live DOM at capture time).
//
// Nothing here changes the page: the injection is CDP-side and recorded in the
// capture manifest.

export const VIEWPORT = Object.freeze({ width: 1600, height: 900 });
export const DEFAULT_TIMEOUT_MS = 150000;
export const DEFAULT_MAX_CHANGED_PERCENT = 0;

const app = (scene) => ({
  kind: 'app',
  viewport: VIEWPORT,
  overlays: 'hidden',
  masks: [],
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxChangedPercent: DEFAULT_MAX_CHANGED_PERCENT,
  ...scene
});

const parity = (pose, notes) => ({
  kind: 'parity',
  pose,
  viewport: VIEWPORT,
  overlays: 'hidden',
  masks: [],
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxChangedPercent: DEFAULT_MAX_CHANGED_PERCENT,
  mechanism: 'fixed world camera from window.__parityPose(' + pose + '): committed ChaseCamera (chase poses) ' +
    'or fixed orbit (map poses), car pose reconstructed from the recorded sprint tick; no physics step',
  notes
});

export const SCENES = Object.freeze([
  parity('A', 'Start, car chase. Committed 45 deg FOV, chase distance 9.314505 m.'),
  parity('B', 'Start, elevated map overview 25.554 m behind/above the car.'),
  parity('C', 'Exit 100 m (checkpoint 1), car chase, tick 432.'),
  parity('D', 'Exit 100 m, elevated map overview 29.069 m back.'),
  app({
    id: 'sprint-start',
    label: 'Sprint start (tick 0)',
    url: '/?script=sprint&hold=0&car=corvette-zr1-stock',
    tick: 0,
    mechanism: 'sprint script replayed to engine tick 0 (countdown), held with alpha 0',
    notes: 'The start gantry area, three prop groups and the car at the line.'
  }),
  app({
    id: 'sprint-mid',
    label: 'Sprint mid-course (tick 565)',
    url: '/?script=sprint&hold=565&car=corvette-zr1-stock',
    tick: 565,
    mechanism: 'sprint script replayed to engine tick 565 (~50 % of the 310 m course), held with alpha 0',
    notes: 'Road surface, verge, material colour and lighting are the dominant pixels here.'
  }),
  app({
    id: 'sprint-finish',
    label: 'Sprint finish (tick 969)',
    url: '/?script=sprint&hold=969&car=corvette-zr1-stock',
    tick: 969,
    mechanism: 'sprint script replayed to the finish tick 969 (14.650 s), held with alpha 0',
    notes: 'Post-finish brake zone; exercises the end of the 310 m draw set.'
  }),
  app({
    id: 'lap',
    label: 'Lap course, lap 1 complete (tick 1830)',
    url: '/?script=sprint&course=lap&hold=1830&car=corvette-zr1-stock',
    tick: 1830,
    mechanism: 'lap script (P61 loop-01, 3 laps) replayed to tick 1830 (lap 1 complete), held with alpha 0',
    timeoutMs: 240000,
    notes: 'Different course geometry from the sprint; lap HUD is part of the hidden overlay set.'
  }),
  app({
    id: 'free',
    label: 'Free roam, basin (tick 200)',
    url: '/?script=sprint&course=free&hold=200&car=corvette-zr1-stock',
    tick: 200,
    mechanism: 'free-roam script replayed to tick 200, held with alpha 0',
    notes: 'Visible-prop layer is active in free roam; prop material work lands here.'
  }),
  app({
    id: 'amboy',
    label: 'Amboy start (tick 300)',
    url: '/?script=sprint&map=amboy&hold=300&car=corvette-zr1-stock',
    tick: 300,
    mechanism: 'Amboy sprint script replayed to tick 300, held with alpha 0',
    timeoutMs: 300000,
    notes: '1,201 opaque draws / 269,300 triangles; 334 additive decals and 71 diagnostic draws are skipped with labels.'
  }),
  app({
    id: 'gracia',
    label: 'Gracia start (tick 300)',
    url: '/?script=sprint&map=gracia&hold=300&car=corvette-zr1-stock',
    tick: 300,
    mechanism: 'Gracia sprint script replayed to tick 300, held with alpha 0',
    timeoutMs: 300000,
    notes: '2,627 opaque draws / 365,451 triangles; 518 decals and 435 diagnostic draws are skipped with labels.'
  }),
  {
    id: 'powerup-hud',
    kind: 'powerups',
    label: 'Power-up HUD (multiplayer lobby)',
    url: '/?mp=1&host=1&powerups=1&script=sprint&car=corvette-zr1-stock&name=Host',
    viewport: VIEWPORT,
    overlays: 'visible',
    masks: ['#hud', '#mp-room-code', '#mp-connection', '#mp-lobby-status', '#mp-server-note'],
    timeoutMs: 180000,
    maxChangedPercent: DEFAULT_MAX_CHANGED_PERCENT,
    mechanism: 'multiplayer host lobby with ?powerups=1, waited until phase=lobby, engineReady, ' +
      'power-ups phase=lobby and the power-up HUD is visible; no race is started',
    notes: 'Product overlay scene: the power-up HUD, lobby and legend are under test; only the ' +
      'random room code, the connection/status lines and the live frame counter are masked.'
  }
]);

export const SCENE_IDS = Object.freeze(SCENES.map((scene) => scene.id));

export function sceneById(id) {
  return SCENES.find((scene) => scene.id === id) ?? null;
}

/** Parse `--scene a,b` / repeated `--scene`. Unknown ids are a hard error. */
export function selectScenes(values) {
  if (!values || !values.length) return SCENES.slice();
  const wanted = values.flatMap((value) => String(value).split(',')).map((value) => value.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !SCENE_IDS.includes(id));
  if (unknown.length) {
    throw new Error('unknown scene ' + JSON.stringify(unknown) + ' (known: ' + SCENE_IDS.join(', ') + ')');
  }
  return SCENES.filter((scene) => wanted.includes(scene.id));
}
