// Split-screen work and frame-budget model.
//
// Every count below comes from a recorded artifact; every time comes from a
// measured frame. The model has two deliberately different time bounds:
//
//   linear-view   one view costs no more than the measured whole frame, so N
//                 views cost at most N x that frame. This ignores the extra
//                 per-player car draws each view gains.
//   draw-bound    every submitted draw is charged the average measured
//                 frame time per draw (6.945 ms / 516 draws). This charges the
//                 compositor/cadence share to every draw, so it over-charges;
//                 it is a conservative upper estimate, not a measurement of
//                 another map.
//
// A player count is only "feasible" when BOTH bounds fit the frame budget.
// "marginal-linear-only" means only the optimistic bound fits and the map has
// not been measured; it is not a claim.
//
// Evidence:
//   frame anchor  _work/e1-drive/browser-evidence-soak.json (two runs, 516
//                 draws/frame, 1600x900, headless Edge, nvidia/blackwell)
//   River counts  _work/e1-drive/geometry.json + packet-corvette-zr1-stock.json
//   Amboy/Gracia _work/e1-drive/browser-evidence-map-{amboy,gracia}.json
//   Longbeach     docs/work/analysis/map-slice-longbeach.md + render package

export const FRAME_ANCHOR = Object.freeze({
  source: '_work/e1-drive/browser-evidence-soak.json',
  date: '2026-11-06',
  browser: 'headless Edge 1600x900, nvidia/blackwell',
  runs: 2,
  drawsPerFrame: 516,
  ticksPerFrame: 4,
  uniformWritesPerFrame: 1,
  frameMs: Object.freeze({ p50: 6.945, p95: 6.975, max: 7.09 }),
  workMs: Object.freeze({ p50: 1.055, p95: 1.408, max: 2.415 }),
  frameMsRun2: Object.freeze({ p50: 6.945, p95: 6.96, max: 7.03 }),
  workMsRun2: Object.freeze({ p50: 1.015, p95: 1.293, max: 2.025 }),
  note: 'Frame interval is the headless rAF cadence (~144 Hz); it is an upper bound on GPU+compositor for one view, not a GPU timestamp.'
});

// One car in every packet: 100 draws, 35,045 triangles, 33,048 vertices,
// 105,135 indices, 9 textures / 4,538,368 B (Corvette ZR1 stock). This is the
// measured default car, not the roster maximum.
export const CAR = Object.freeze({
  label: 'Corvette ZR1 reference',
  draws: 100,
  triangles: 35045,
  vertices: 33048,
  indices: 105135,
  textures: 9,
  textureBytes: 4538368
});

// Roster envelope: max of each column over the 25 measured car chunks
// (performance-budget.md section 2.1). No single car has all three maxima; it
// is a conservative upper envelope for a mixed 4-car session.
export const CAR_ENVELOPE = Object.freeze({
  label: 'roster envelope (max draws / tris / verts)',
  draws: 123,
  triangles: 41270,
  vertices: 40018,
  indices: 123810,
  textures: 9,
  textureBytes: 4997120
});

// Static (non-car) scene counts per map. `indices` is the whole index buffer,
// not just the draw-referenced ranges; it is used for geometry memory only.
export const MAPS = Object.freeze({
  river: Object.freeze({
    label: 'River usa_la_river (drive-slice packet)',
    measured: true,
    draws: 416,
    triangles: 67441,
    vertices: 109656,
    indices: 202323,
    textures: 140,
    textureBytes: 447552,
    evidence: [
      '_work/e1-drive/packet-corvette-zr1-stock.json (516 = 394 track + 22 level + 100 car)',
      '_work/e1-drive/geometry.json (river.block27.instances-all + river.track.visual)'
    ]
  }),
  amboy: Object.freeze({
    label: 'Amboy usa_amboy (map package)',
    measured: false,
    draws: 1201,
    triangles: 269300,
    vertices: 529624,
    indices: 1046844,
    textures: 179,
    textureBytes: 2654272,
    evidence: ['_work/e1-drive/browser-evidence-map-amboy.json package.counts']
  }),
  gracia: Object.freeze({
    label: 'Gracia spa_barcelona_gracia (map package)',
    measured: false,
    draws: 2627,
    triangles: 365451,
    vertices: 738905,
    indices: 1651896,
    textures: 734,
    textureBytes: 3247360,
    evidence: ['_work/e1-drive/browser-evidence-map-gracia.json package.counts']
  }),
  longbeach: Object.freeze({
    label: 'Longbeach usa_la_longbeachdocks (map package)',
    measured: false,
    draws: 1039,
    triangles: 511782,
    vertices: 864473,
    indices: 1611882,
    textures: 164,
    textureBytes: 1239168,
    evidence: ['docs/work/analysis/map-slice-longbeach.md section 10', '_work/map-slice/longbeach-render/render.json']
  })
});

export const MAP_IDS = Object.freeze(Object.keys(MAPS));
export const PLAYER_COUNTS = Object.freeze([1, 2, 3, 4]);
export const DRAW_UNIFORM_STRIDE = 256; // WebGPU minUniformBufferOffsetAlignment
export const BYTES_PER_VERTEX = 20; // position f32x3 + uv0 f32x2
export const BYTES_PER_INDEX = 4; // uint32
export const REMOTE_LOD_DRAWS = 12; // proposed low-LOD budget for a remote car

export function frameBudgetMs(hz) {
  if (hz !== 60 && hz !== 30) throw new Error('frameBudgetMs supports 60 or 30 Hz');
  return 1000 / hz;
}

function assertMap(mapId) {
  const map = MAPS[mapId];
  if (!map) throw new Error('unknown map ' + JSON.stringify(mapId));
  return map;
}

function assertPlayers(players) {
  if (!Number.isInteger(players) || players < 1 || players > 4) {
    throw new Error('players must be an integer in [1, 4]');
  }
}

/** Per-view submitted work when every player's car is drawn in full in every view. */
export function perViewWork(mapId, players, car = CAR) {
  const map = assertMap(mapId);
  assertPlayers(players);
  const draws = map.draws + players * car.draws;
  const triangles = map.triangles + players * car.triangles;
  const vertices = map.vertices + players * car.vertices;
  const indexBytes = triangles * 3 * BYTES_PER_INDEX;
  return {
    players,
    draws,
    triangles,
    vertices,
    indexBytes,
    drawUniformBytes: draws * DRAW_UNIFORM_STRIDE,
    viewUniformBytes: players * DRAW_UNIFORM_STRIDE
  };
}

/**
 * Whole-frame submitted work for N views.
 * Option A duplicates the per-draw uniform band per view; option B shares the
 * world/draw band and adds one small view-constant band per view.
 */
export function frameWork(mapId, players, car = CAR) {
  const perView = perViewWork(mapId, players, car);
  return {
    players,
    perView,
    draws: perView.draws * players,
    triangles: perView.triangles * players,
    vertices: perView.vertices * players,
    indexBytes: perView.indexBytes * players,
    uniformBytesOptionA: perView.drawUniformBytes * players,
    uniformBytesOptionB: perView.drawUniformBytes + players * DRAW_UNIFORM_STRIDE
  };
}

/** GPU texture memory. Distinct cars duplicate the 9 car textures per player. */
export function textureMemory(mapId, players, { distinctCars = true, car = CAR } = {}) {
  const map = assertMap(mapId);
  assertPlayers(players);
  const carCount = distinctCars ? players : 1;
  return {
    textures: map.textures + carCount * car.textures,
    bytes: map.textureBytes + carCount * car.textureBytes
  };
}

/** Geometry memory. Buffers are uploaded once, never per viewport. */
export function geometryMemory(mapId, players, { distinctCars = true, car = CAR } = {}) {
  const map = assertMap(mapId);
  assertPlayers(players);
  const carCount = distinctCars ? players : 1;
  const staticBytes = map.vertices * BYTES_PER_VERTEX + map.indices * BYTES_PER_INDEX;
  const carBytes = car.vertices * BYTES_PER_VERTEX + car.indices * BYTES_PER_INDEX;
  return { bytes: staticBytes + carCount * carBytes, distinctCars: carCount };
}

/** Worst-case measured frame for one view (both runs, p95 of the slower run). */
export function oneViewMs(stat = 'p95') {
  const value = FRAME_ANCHOR.frameMs[stat];
  if (typeof value !== 'number') throw new Error('unknown frame statistic ' + JSON.stringify(stat));
  return value;
}

/** Linear-view upper bound: N views each cost at most the measured frame. */
export function linearViewMs(players, stat = 'p95') {
  assertPlayers(players);
  return players * oneViewMs(stat);
}

/** Average measured frame time per submitted draw (p50 anchor). */
export function perDrawMs() {
  return FRAME_ANCHOR.frameMs.p50 / FRAME_ANCHOR.drawsPerFrame;
}

/** Conservative draw-proportional estimate for a full-draw-list frame. */
export function drawBoundMs(mapId, players, car = CAR) {
  return frameWork(mapId, players, car).draws * perDrawMs();
}

/** Conservative draw-proportional estimate for an arbitrary draw total. */
export function drawBoundForDraws(draws) {
  if (!Number.isInteger(draws) || draws < 1) throw new Error('draws must be a positive integer');
  return draws * perDrawMs();
}

/**
 * Proposed remote-car LOD: own car full, every other car REMOTE_LOD_DRAWS.
 * This is a budget lever, not an implemented renderer path.
 */
export function lodPerViewDraws(mapId, players, car = CAR) {
  const map = assertMap(mapId);
  assertPlayers(players);
  return map.draws + car.draws + (players - 1) * REMOTE_LOD_DRAWS;
}

export function lodFrameDraws(mapId, players, car = CAR) {
  return lodPerViewDraws(mapId, players, car) * players;
}

export function utilization(ms, hz) {
  return ms / frameBudgetMs(hz);
}

/**
 * Feasibility under both bounds.
 *   feasible                    both bounds fit and the map has a measured frame
 *   estimate-fits-unmeasured    both bounds fit but the map has no measured frame
 *   marginal-linear-only        only the optimistic bound fits
 *   infeasible                  even the optimistic bound does not fit
 */
export function feasibility(mapId, players, hz, stat = 'p95', car = CAR) {
  const map = assertMap(mapId);
  const budget = frameBudgetMs(hz);
  const linear = linearViewMs(players, stat);
  const draw = drawBoundMs(mapId, players, car);
  let status;
  if (linear > budget) status = 'infeasible';
  else if (draw > budget) status = 'marginal-linear-only';
  else status = map.measured ? 'feasible' : 'estimate-fits-unmeasured';
  return {
    mapId,
    players,
    hz,
    stat,
    measured: map.measured,
    budgetMs: budget,
    linearViewMs: linear,
    drawBoundMs: draw,
    linearUtilization: utilization(linear, hz),
    drawUtilization: utilization(draw, hz),
    marginLinearMs: budget - linear,
    marginDrawMs: budget - draw,
    status
  };
}
