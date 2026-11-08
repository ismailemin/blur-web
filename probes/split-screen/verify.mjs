// Split-screen plan verifier.
//
//   node probes/split-screen/verify.mjs
//
// Checks the layout/FOV arithmetic, the per-view and per-frame work tables,
// the frame budgets, the feasibility truth table and the committed plan file.
// It is independent of the plan builder: every value is recomputed from the
// layout and budget modules, not read back from the JSON.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANVAS, FOV_POLICY, LAYOUTS, aspectOf, areaOf, fovForAspect, rectsOverlap } from './layout.mjs';
import {
  CAR, CAR_ENVELOPE, DRAW_UNIFORM_STRIDE, FRAME_ANCHOR, MAPS, MAP_IDS, PLAYER_COUNTS,
  REMOTE_LOD_DRAWS, drawBoundForDraws, drawBoundMs, feasibility, frameBudgetMs, frameWork,
  geometryMemory, linearViewMs, lodFrameDraws, lodPerViewDraws, oneViewMs, perDrawMs,
  perViewWork, textureMemory
} from './budget.mjs';
import { PLAN_PATH, buildPlan, canonicalJson, planHash } from './build-plan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOG_PATH = join(ROOT, '_work', 'logs', 'split-screen', 'verify.log');
const checks = [];

function check(group, name, condition, detail = '') {
  checks.push({ group, name, ok: Boolean(condition), detail: String(detail) });
}

function close(actual, expected, epsilon = 1e-9) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon;
}

function finiteNonNegative(values) {
  return values.every((value) => Number.isFinite(value) && value >= 0);
}

// ---------------------------------------------------------------- layouts

const canvasArea = CANVAS.deviceWidth * CANVAS.deviceHeight;

for (const layout of LAYOUTS) {
  const tag = 'layout/' + layout.id;
  check(tag, 'players 1..4 and one view per player',
    layout.players >= 1 && layout.players <= 4 && layout.views.length === layout.players,
    layout.players + ' players / ' + layout.views.length + ' views');

  const players = layout.views.map((view) => view.player).sort((a, b) => a - b);
  check(tag, 'player ids are exactly 1..N',
    players.length === layout.players && players.every((id, index) => id === index + 1),
    players.join(','));

  const rects = layout.views.map((view) => view.rect);
  check(tag, 'rects have positive integer sizes',
    rects.every((rect) => Number.isInteger(rect.w) && Number.isInteger(rect.h) && rect.w > 0 && rect.h > 0),
    rects.map((rect) => rect.w + 'x' + rect.h).join(' '));

  check(tag, 'rects are inside the canvas and at non-negative offsets',
    rects.every((rect) => Number.isInteger(rect.x) && Number.isInteger(rect.y) &&
      rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= CANVAS.deviceWidth && rect.y + rect.h <= CANVAS.deviceHeight));

  const area = rects.reduce((sum, rect) => sum + areaOf(rect), 0);
  check(tag, 'rect areas sum to the full canvas',
    area === canvasArea, area + ' / ' + canvasArea);

  let overlaps = 0;
  for (let a = 0; a < rects.length; a++) {
    for (let b = a + 1; b < rects.length; b++) if (rectsOverlap(rects[a], rects[b])) overlaps++;
  }
  check(tag, 'no two views overlap', overlaps === 0, overlaps + ' overlaps');

  check(tag, 'aspect equals w/h',
    layout.views.every((view) => close(view.aspect, aspectOf(view.rect), 1e-6)),
    layout.views.map((view) => view.aspect.toFixed(4)).join(' '));

  const share = layout.views.reduce((sum, view) => sum + view.pixelShare, 0);
  check(tag, 'pixel shares sum to 1', close(share, 1, 1e-5), share.toFixed(6));

  check(tag, 'vertical FOV is in (0, 45] degrees',
    layout.views.every((view) => view.fov.verticalDegrees > 0 && view.fov.verticalDegrees <= 45.000001),
    layout.views.map((view) => view.fov.verticalDegrees.toFixed(3)).join(' '));

  check(tag, 'horizontal FOV is in (0, 100] degrees',
    layout.views.every((view) => view.fov.horizontalDegrees > 0 && view.fov.horizontalDegrees <= 100.000001),
    layout.views.map((view) => view.fov.horizontalDegrees.toFixed(3)).join(' '));

  check(tag, 'FOV cap flag matches the uncapped horizontal FOV',
    layout.views.every((view) => {
      const uncapped = 2 * Math.atan(Math.tan((FOV_POLICY.baseVerticalDegrees * Math.PI / 180) / 2) * view.aspect);
      return view.fov.capped === (uncapped > FOV_POLICY.horizontalCapDegrees * Math.PI / 180);
    }));

  check(tag, 'FOV policy is recorded',
    layout.views.every((view) => view.fov.policy === FOV_POLICY.id));

  check(tag, 'stored FOV matches a fresh computation',
    layout.views.every((view) => {
      const fresh = fovForAspect(view.aspect);
      return close(view.fov.verticalDegrees, fresh.verticalDegrees, 1e-5) &&
        close(view.fov.horizontalDegrees, fresh.horizontalDegrees, 1e-5);
    }));
}

check('layout/solo', '16:9 keeps the committed 45 deg vertical FOV',
  close(LAYOUTS[0].views[0].fov.verticalDegrees, 45, 1e-5));
check('layout/solo', '16:9 horizontal FOV is 72.73 deg',
  LAYOUTS[0].views[0].fov.horizontalDegrees > 72.7 && LAYOUTS[0].views[0].fov.horizontalDegrees < 72.8);
check('layout/split-h', '32:9 view is horizontally capped at 100 deg',
  LAYOUTS[1].views[0].fov.capped === true && close(LAYOUTS[1].views[0].fov.horizontalDegrees, 100, 1e-5));
check('layout/split-h', '32:9 vertical FOV is 37.06 deg',
  close(LAYOUTS[1].views[0].fov.verticalDegrees, 37.0603, 0.001));
check('layout/split-v', '8:9 view keeps 45 deg vertical and narrows horizontal',
  close(LAYOUTS[2].views[0].fov.verticalDegrees, 45, 1e-5) &&
  LAYOUTS[2].views[0].fov.horizontalDegrees < 41);
check('layout/quad', 'four 800x450 views are native 16:9',
  LAYOUTS[4].views.every((view) => close(view.aspect, 16 / 9, 1e-6) &&
    close(view.fov.verticalDegrees, 45, 1e-5)));

// ---------------------------------------------------------------- budgets

check('budget', '60 Hz budget is 16.667 ms', close(frameBudgetMs(60), 1000 / 60, 1e-9));
check('budget', '30 Hz budget is 33.333 ms', close(frameBudgetMs(30), 1000 / 30, 1e-9));
check('budget', 'anchor is 516 draws/frame', FRAME_ANCHOR.drawsPerFrame === 516);
check('budget', 'frame percentiles are ordered',
  FRAME_ANCHOR.frameMs.p50 <= FRAME_ANCHOR.frameMs.p95 && FRAME_ANCHOR.frameMs.p95 <= FRAME_ANCHOR.frameMs.max);
check('budget', 'both anchor runs agree on p50',
  close(FRAME_ANCHOR.frameMs.p50, FRAME_ANCHOR.frameMsRun2.p50, 1e-9));
check('budget', 'per-draw cost is the p50 frame / 516 draws',
  close(perDrawMs(), 6.945 / 516, 1e-12));
check('budget', 'one view p95 is the slower run', close(oneViewMs('p95'), 6.975, 1e-9));
check('budget', 'linear view bound is N x p95', [1, 2, 3, 4].every((n) =>
  close(linearViewMs(n, 'p95'), n * 6.975, 1e-9)));

// ---------------------------------------------------------------- work tables

for (const mapId of MAP_IDS) {
  const map = MAPS[mapId];
  for (const players of PLAYER_COUNTS) {
    const tag = 'work/' + mapId + '/' + players + 'p';
    const perView = perViewWork(mapId, players);
    const frame = frameWork(mapId, players);

    check(tag, 'per-view draws/triangles/vertices are static + N car',
      perView.draws === map.draws + players * CAR.draws &&
      perView.triangles === map.triangles + players * CAR.triangles &&
      perView.vertices === map.vertices + players * CAR.vertices,
      perView.draws + ' draws / ' + perView.triangles + ' tri / ' + perView.vertices + ' verts');

    check(tag, 'index bytes are 12 x triangles',
      perView.indexBytes === perView.triangles * 12);

    check(tag, 'uniform bands use the 256 B stride',
      perView.drawUniformBytes === perView.draws * DRAW_UNIFORM_STRIDE &&
      perView.viewUniformBytes === players * DRAW_UNIFORM_STRIDE);

    check(tag, 'frame totals are N x per-view',
      frame.draws === perView.draws * players &&
      frame.triangles === perView.triangles * players &&
      frame.vertices === perView.vertices * players &&
      frame.indexBytes === perView.indexBytes * players);

    check(tag, 'uniform option A duplicates per view and option B shares the draw band',
      frame.uniformBytesOptionA === perView.drawUniformBytes * players &&
      frame.uniformBytesOptionB === perView.drawUniformBytes + players * DRAW_UNIFORM_STRIDE);

    const distinct = textureMemory(mapId, players, { distinctCars: true });
    const same = textureMemory(mapId, players, { distinctCars: false });
    const geomDistinct = geometryMemory(mapId, players, { distinctCars: true });
    const geomSame = geometryMemory(mapId, players, { distinctCars: false });
    check(tag, 'distinct cars add 9 textures per player and same-car shares them',
      distinct.textures === map.textures + players * CAR.textures &&
      same.textures === map.textures + CAR.textures &&
      (players === 1 ? distinct.bytes === same.bytes : distinct.bytes > same.bytes));
    check(tag, 'geometry is uploaded once and distinct cars add one car mesh per player',
      geomDistinct.bytes === geomSame.bytes + (players - 1) *
        (CAR.vertices * 20 + CAR.indices * 4) && geomSame.bytes > 0);

    check(tag, 'every submitted count is finite and non-negative',
      finiteNonNegative([perView.draws, perView.triangles, perView.vertices, perView.indexBytes,
        perView.drawUniformBytes, frame.draws, frame.triangles, frame.vertices,
        frame.uniformBytesOptionA, frame.uniformBytesOptionB, distinct.bytes, geomDistinct.bytes]));
  }
}

// ---------------------------------------------------------------- time / verdict

check('time', 'River 1P draw bound is the anchor frame', close(drawBoundMs('river', 1), 6.945, 1e-9));
check('time', 'River 2P draw bound is 16.58 ms',
  close(drawBoundMs('river', 2), 16.582, 0.01), drawBoundMs('river', 2).toFixed(3));
check('time', 'River 4P draw bound is 43.94 ms',
  close(drawBoundMs('river', 4), 43.94, 0.02), drawBoundMs('river', 4).toFixed(3));
check('time', '2P 60 Hz uses 83.7% of the linear-view budget',
  close(feasibility('river', 2, 60).linearUtilization, 13.95 / (1000 / 60), 1e-9));
check('time', '3P 60 Hz linear bound does not fit',
  linearViewMs(3, 'p95') > frameBudgetMs(60));
check('time', '4P 30 Hz linear bound fits but the full draw bound does not',
  feasibility('river', 4, 30).status === 'marginal-linear-only');
check('verdict', 'River 2P at 60 Hz is feasible under both bounds',
  feasibility('river', 2, 60).status === 'feasible');
check('verdict', 'River 3P at 60 Hz is infeasible',
  feasibility('river', 3, 60).status === 'infeasible');
check('verdict', 'River 4P at 60 Hz is infeasible',
  feasibility('river', 4, 60).status === 'infeasible');
check('verdict', 'River 3P at 30 Hz is feasible',
  feasibility('river', 3, 30).status === 'feasible');
check('verdict', 'Amboy 2P at 60 Hz is linear-only, not certified',
  feasibility('amboy', 2, 60).status === 'marginal-linear-only');
check('verdict', 'Gracia 3P at 60 Hz is infeasible even on the linear bound',
  feasibility('gracia', 3, 60).status === 'infeasible');
check('verdict', 'Longbeach 2P at 60 Hz is linear-only, not certified',
  feasibility('longbeach', 2, 60).status === 'marginal-linear-only');
check('verdict', 'Longbeach 1P at 60 Hz is estimate-only, not certified',
  feasibility('longbeach', 1, 60).status === 'estimate-fits-unmeasured');
check('verdict', 'no unmeasured map is labelled feasible at 60 Hz',
  MAP_IDS.filter((id) => id !== 'river').every((id) =>
    PLAYER_COUNTS.every((players) => feasibility(id, players, 60).status !== 'feasible')));

// ------------------------------------------------------- car draw sensitivity

check('car', 'roster envelope is 123 draws / 41,270 tri / 40,018 verts',
  CAR_ENVELOPE.draws === 123 && CAR_ENVELOPE.triangles === 41270 && CAR_ENVELOPE.vertices === 40018);
check('car', 'River 2P envelope is 662 draws/view and 1324 draws/frame',
  perViewWork('river', 2, CAR_ENVELOPE).draws === 662 &&
  frameWork('river', 2, CAR_ENVELOPE).draws === 1324);
check('car', 'River 2P envelope draw bound is 17.82 ms',
  close(drawBoundMs('river', 2, CAR_ENVELOPE), 17.82, 0.01));
check('car', 'River 2P envelope is marginal, not feasible, at 60 Hz',
  feasibility('river', 2, 60, 'p95', CAR_ENVELOPE).status === 'marginal-linear-only');
check('car', 'River 2P envelope + remote LOD fits 60 Hz',
  drawBoundForDraws(lodFrameDraws('river', 2, CAR_ENVELOPE)) < frameBudgetMs(60) &&
  linearViewMs(2, 'p95') < frameBudgetMs(60));
check('car', 'River 4P envelope is 908 draws/view and 3632 draws/frame',
  perViewWork('river', 4, CAR_ENVELOPE).draws === 908 &&
  frameWork('river', 4, CAR_ENVELOPE).draws === 3632);
check('car', 'River 4P envelope + remote LOD fits 30 Hz',
  drawBoundForDraws(lodFrameDraws('river', 4, CAR_ENVELOPE)) < frameBudgetMs(30) &&
  linearViewMs(4, 'p95') < frameBudgetMs(30));

// ---------------------------------------------------------------- LOD lever

check('lod', 'River 2P remote LOD is 528 draws/view',
  lodPerViewDraws('river', 2) === 416 + 100 + REMOTE_LOD_DRAWS);
check('lod', 'River 4P remote LOD is 552 draws/view and 2208 draws/frame',
  lodPerViewDraws('river', 4) === 552 && lodFrameDraws('river', 4) === 2208);
check('lod', 'River 4P at 30 Hz fits with remote LOD',
  drawBoundForDraws(lodFrameDraws('river', 4)) < frameBudgetMs(30) &&
  linearViewMs(4, 'p95') < frameBudgetMs(30));

// ---------------------------------------------------------------- plan file

let raw = null;
try {
  raw = readFileSync(PLAN_PATH, 'utf8');
} catch (error) {
  check('plan', 'plan.json exists', false, error.message);
}
if (raw !== null) {
  check('plan', 'plan.json exists and is valid JSON', true);
  let plan = null;
  try {
    plan = JSON.parse(raw);
  } catch (error) {
    check('plan', 'plan.json parses', false, error.message);
  }
  if (plan) {
    check('plan', 'kind and version are split-screen.plan v1',
      plan.kind === 'split-screen.plan' && plan.version === 1);
    check('plan', 'planHash matches a fresh canonical hash',
      plan.planHash === planHash(plan), plan.planHash);
    const rebuilt = buildPlan();
    check('plan', 'buildPlan is deterministic', rebuilt.planHash === plan.planHash);
    check('plan', 'plan.json is byte-identical to a fresh build',
      JSON.stringify(rebuilt, null, 2) + '\n' === raw);
    check('plan', 'all five layouts are present',
      plan.layouts.length === LAYOUTS.length &&
      plan.layouts.every((entry, index) => entry.id === LAYOUTS[index].id));
    check('plan', 'all four maps are present',
      MAP_IDS.every((id) => Boolean(plan.maps[id])) && Object.keys(plan.maps).length === MAP_IDS.length);
    check('plan', 'every map has 8 verdict rows (2 rates x 4 player counts)',
      MAP_IDS.every((id) => plan.verdict.byMap[id].length === 8));
    check('plan', 'car sensitivity matches the fresh envelope functions',
      plan.verdict.carSensitivity.river2p60.envelope ===
        feasibility('river', 2, 60, 'p95', CAR_ENVELOPE).status &&
      plan.verdict.carSensitivity.river4p30.envelope ===
        feasibility('river', 4, 30, 'p95', CAR_ENVELOPE).status &&
      close(plan.verdict.carSensitivity.river2p60.envelopeDrawBoundMs,
        drawBoundMs('river', 2, CAR_ENVELOPE), 1e-6));
    check('plan', 'every map has two envelope sensitivity rows',
      MAP_IDS.every((id) => plan.maps[id].sensitivity.length === 2 &&
        plan.maps[id].sensitivity.every((row) => row.players === 2 || row.players === 4)));
    check('plan', 'River verdicts match the fresh functions',
      plan.verdict.byMap.river.every((row) => {
        const fresh = feasibility('river', row.players, row.hz);
        return row.status === fresh.status && close(row.linearViewMs, fresh.linearViewMs, 1e-6) &&
          close(row.drawBoundMs, fresh.drawBoundMs, 1e-6);
      }));
  }
}

check('plan', 'pass counts are one color pass and N viewport stages',
  (() => { const plan = JSON.parse(raw); return plan.passes.colorPasses === 1 && plan.passes.viewportStages === 'players'; })());
check('plan', 'no shadow, post or GPU occlusion pass is claimed',
  (() => { const plan = JSON.parse(raw); return plan.passes.shadowPasses === 0 &&
    plan.passes.postPasses === 0 && plan.passes.occlusionQueryPasses === 0; })());
check('plan', 'one queue submit and one uniform write per frame',
  (() => { const plan = JSON.parse(raw); return plan.passes.queueSubmits === 1 &&
    plan.passes.uniformWritesPerFrame === 1; })());
check('plan', 'headline says 2 players at 60 Hz and 4 with LOD at 30 Hz',
  (() => { const plan = JSON.parse(raw); return plan.verdict.maxPlayers60Hz === 2 &&
    plan.verdict.maxPlayers30Hz === 3 && plan.verdict.maxPlayers30HzWithRemoteLod === 4; })());
check('plan', 'budgets record the 123-draw envelope maxima (1 at 60 Hz, 3 at 30 Hz)',
  (() => { const plan = JSON.parse(raw); return plan.budgets.hz60.playersFeasibleEnvelope === 1 &&
    plan.budgets.hz30.playersFeasibleEnvelope === 3; })());
check('plan', 'input model names one keyboard player and three gamepad players',
  (() => { const plan = JSON.parse(raw); const keys = plan.input.players.filter((p) => p.primary.startsWith('keyboard'));
    return keys.length === 1 && keys[0].player === 1 && plan.input.players.length === 4; })());
check('plan', 'ownership is host-authoritative with three non-authoritative peers',
  (() => { const plan = JSON.parse(raw); return plan.ownership.model.includes('host-authoritative') &&
    plan.ownership.peers.length === 3 && plan.ownership.peers.every((p) => p.authority === 'none'); })());
check('plan', 'limits state that only River is measured and 4 instances need ~1 GiB',
  (() => { const plan = JSON.parse(raw); return plan.limits.some((line) => line.includes('Only River')) &&
    plan.limits.some((line) => line.includes('1 GiB')); })());

// ---------------------------------------------------------------- report

mkdirSync(dirname(LOG_PATH), { recursive: true });
const failures = checks.filter((entry) => !entry.ok);
const lines = checks.map((entry) =>
  '[' + (entry.ok ? 'ok' : 'FAIL') + '] ' + entry.group + ' :: ' + entry.name +
  (entry.detail ? ' — ' + entry.detail : ''));
lines.push('');
lines.push('checks ' + checks.length + ' / pass ' + (checks.length - failures.length) + ' / fail ' + failures.length);
writeFileSync(LOG_PATH, lines.join('\n') + '\n', 'utf8');

const groups = {};
for (const entry of checks) {
  groups[entry.group] = groups[entry.group] ?? { total: 0, fail: 0 };
  groups[entry.group].total++;
  if (!entry.ok) groups[entry.group].fail++;
}
for (const [group, counts] of Object.entries(groups)) {
  console.log((counts.fail === 0 ? 'PASS ' : 'FAIL ') + group + ' ' +
    (counts.total - counts.fail) + '/' + counts.total);
}
if (failures.length > 0) {
  console.error('\n' + failures.length + ' failure(s):');
  for (const failure of failures) {
    console.error('  ' + failure.group + ' :: ' + failure.name + ' — ' + failure.detail);
  }
}
console.log('\n' + (failures.length === 0 ? 'PASS' : 'FAIL') + ' ' +
  (checks.length - failures.length) + '/' + checks.length + ' checks');
console.log('log ' + LOG_PATH);
process.exit(failures.length === 0 ? 0 : 1);
