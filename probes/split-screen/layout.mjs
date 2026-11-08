// Split-screen layout and aspect-aware field-of-view contract.
//
// The browser build is single-viewport today. This module defines the layout
// rectangles and the FOV rule for 1-4 local players at the measurement canvas
// (1600x900, DPR 1). It is pure arithmetic: no WebGPU, no DOM, no game state.
//
// Layout naming is by the divider, not by the arrangement:
//   split-h  horizontal divider  -> two views stacked top/bottom
//   split-v  vertical divider    -> two views side by side
//
// The FOV rule is "preserve vertical, cap horizontal":
//   * start from the committed 45 deg vertical FOV at 16:9;
//   * a wider viewport keeps that vertical FOV and gains horizontal FOV;
//   * once horizontal FOV reaches 100 deg it is capped and the vertical FOV is
//     derived from the capped horizontal FOV, so a 32:9 half-screen view does
//     not stretch to a 112 deg horizontal fisheye;
//   * a taller/narrower viewport keeps the 45 deg vertical FOV and loses
//     horizontal coverage. It never gains vertical coverage, so the car keeps
//     the same on-screen height as in the single-player 16:9 frame.
//
// Every value here is deterministic and independent of DPR; the caller
// multiplies the CSS rects by the render ratio before calling setViewport.

export const CANVAS = Object.freeze({
  cssWidth: 1600,
  cssHeight: 900,
  dpr: 1,
  deviceWidth: 1600,
  deviceHeight: 900
});

export const FOV_POLICY = Object.freeze({
  id: 'preserve-vertical-cap-horizontal',
  baseVerticalDegrees: 45,
  baseAspect: 16 / 9,
  horizontalCapDegrees: 100
});

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** w/h of a pixel rect. Throws on a non-positive rect. */
export function aspectOf(rect) {
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) {
    throw new Error('aspectOf needs a rect with positive w/h');
  }
  return rect.w / rect.h;
}

export function areaOf(rect) {
  return rect.w * rect.h;
}

/** FOV in radians/degrees for a viewport aspect, under FOV_POLICY. */
export function fovForAspect(aspect) {
  if (!(aspect > 0) || !Number.isFinite(aspect)) {
    throw new Error('fovForAspect needs a positive finite aspect');
  }
  const vBase = FOV_POLICY.baseVerticalDegrees * DEG;
  const hCap = FOV_POLICY.horizontalCapDegrees * DEG;
  const uncappedH = 2 * Math.atan(Math.tan(vBase / 2) * aspect);
  let verticalRadians = vBase;
  let horizontalRadians = uncappedH;
  let capped = false;
  if (uncappedH > hCap) {
    capped = true;
    horizontalRadians = hCap;
    verticalRadians = 2 * Math.atan(Math.tan(hCap / 2) / aspect);
  }
  return {
    verticalRadians,
    horizontalRadians,
    verticalDegrees: verticalRadians * RAD,
    horizontalDegrees: horizontalRadians * RAD,
    capped
  };
}

function mm(value) {
  return Math.round(value * 1e6) / 1e6;
}

function makeView(player, x, y, w, h, hudScale) {
  const rect = { x, y, w, h };
  const aspect = aspectOf(rect);
  const fov = fovForAspect(aspect);
  return Object.freeze({
    player,
    rect: Object.freeze(rect),
    aspect: mm(aspect),
    pixelShare: mm(areaOf(rect) / (CANVAS.deviceWidth * CANVAS.deviceHeight)),
    fov: Object.freeze({
      policy: FOV_POLICY.id,
      verticalDegrees: mm(fov.verticalDegrees),
      horizontalDegrees: mm(fov.horizontalDegrees),
      verticalRadians: mm(fov.verticalRadians),
      horizontalRadians: mm(fov.horizontalRadians),
      capped: fov.capped
    }),
    hudScale
  });
}

const RAW_LAYOUTS = [
  {
    id: 'solo',
    label: '1 player, full canvas',
    players: 1,
    divider: 'none',
    gutterPx: 0,
    hudScale: 1,
    views: [[1, 0, 0, 1600, 900]]
  },
  {
    id: 'split-h',
    label: '2 players, horizontal divider (stacked)',
    players: 2,
    divider: 'horizontal',
    gutterPx: 2,
    hudScale: 0.85,
    views: [
      [1, 0, 0, 1600, 450],
      [2, 0, 450, 1600, 450]
    ]
  },
  {
    id: 'split-v',
    label: '2 players, vertical divider (side by side)',
    players: 2,
    divider: 'vertical',
    gutterPx: 2,
    hudScale: 0.9,
    views: [
      [1, 0, 0, 800, 900],
      [2, 800, 0, 800, 900]
    ]
  },
  {
    id: 'three',
    label: '3 players, one full-width top view + two bottom views',
    players: 3,
    divider: 'mixed',
    gutterPx: 2,
    hudScale: 0.75,
    views: [
      [1, 0, 0, 1600, 450],
      [2, 0, 450, 800, 450],
      [3, 800, 450, 800, 450]
    ]
  },
  {
    id: 'quad',
    label: '4 players, 2x2 quad',
    players: 4,
    divider: 'mixed',
    gutterPx: 4,
    hudScale: 0.7,
    views: [
      [1, 0, 0, 800, 450],
      [2, 800, 0, 800, 450],
      [3, 0, 450, 800, 450],
      [4, 800, 450, 800, 450]
    ]
  }
];

export const LAYOUTS = Object.freeze(RAW_LAYOUTS.map((raw) => Object.freeze({
  id: raw.id,
  label: raw.label,
  players: raw.players,
  divider: raw.divider,
  gutterPx: raw.gutterPx,
  hudScale: raw.hudScale,
  views: Object.freeze(raw.views.map(([player, x, y, w, h]) => makeView(player, x, y, w, h, raw.hudScale))),
  canvas: CANVAS
})));

export function layoutById(id) {
  const layout = LAYOUTS.find((entry) => entry.id === id);
  if (!layout) throw new Error('unknown layout ' + JSON.stringify(id));
  return layout;
}

/** True when two rects overlap with a positive-area intersection. */
export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
