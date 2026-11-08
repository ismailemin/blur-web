// `solo-longbeach`: the fourth playable map. The course is the committed
// collision-derived path (785.823230 m), not the draw path: the draw path
// crosses a 10 cm curb at arc 226.8 m and the car cannot pass.
//
import { waitProbe } from './scenarios.mjs';

// The scenario asserts the map/layout identity, the finish, the two
// checkpoints, zero respawns and a clean console. It does not pin a tick: the
// collision path's settle differs from the draw path by a few ticks.

export async function soloLongbeach(ctx) {
  const anchor = ctx.anchors.longbeach;
  const url = ctx.base + '/?map=longbeach&script=sprint&car=' +
    encodeURIComponent(anchor.slug) + '&audio=0';
  const page = await ctx.openPage('longbeach');
  await page.navigate(url);
  const running = await waitProbe(ctx, page, (probe) => probe.consumer === 'running' && probe.engineTick >= 2,
    { timeoutMs: 120000, label: 'longbeach running' });
  await ctx.shot(page, 'start');

  ctx.A.check('longbeach: URL is the requested scripted sprint', running.url === url, running.url);
  ctx.A.check('longbeach: map is longbeach', running.map?.id === 'longbeach', ctx.fmt(running.map));
  ctx.A.check('longbeach: course is longbeach', running.sprint?.courseId === anchor.courseId,
    running.sprint?.courseId);
  ctx.A.check('longbeach: layout hash is the committed collision path',
    running.sprintLayoutHash === anchor.layoutHash,
    running.sprintLayoutHash + ' vs ' + anchor.layoutHash);
  ctx.evidence.start = running;

  const done = await waitProbe(ctx, page, (probe) => probe.sprintResult !== null,
    { timeoutMs: 180000, label: 'longbeach finish' });
  await ctx.shot(page, 'finish');
  const result = done.sprintResult;
  ctx.A.check('longbeach: finish time is ' + anchor.timeSeconds + ' s',
    Math.abs(result.timeSeconds - anchor.timeSeconds) <= anchor.timeToleranceSeconds,
    'expected ' + anchor.timeSeconds + ' Â± ' + anchor.timeToleranceSeconds + ', got ' + result.timeSeconds);
  ctx.A.check('longbeach: two checkpoints were passed', result.checkpoints === anchor.checkpoints,
    'got ' + result.checkpoints);
  ctx.A.check('longbeach: no respawn', result.respawns === 0, 'respawns ' + result.respawns);
  ctx.A.check('longbeach: results overlay is visible', done.overlays.resultsHidden === false,
    ctx.fmt(done.overlays));
  ctx.A.check('longbeach: results overlay shows the measured race time',
    (done.overlays.resultsTime ?? '').includes(anchor.timeSeconds.toFixed(3)),
    done.overlays.resultsTime);
  ctx.A.check('longbeach: no console error', page.messages.filter((m) => m.type === 'error').length === 0,
    ctx.fmt(page.messages.slice(-4)));
  ctx.evidence.finish = done;
}


// `solo-observatory`: the fifth playable map. The course is the committed
// collision-derived path (536.621709 m); the draw path crosses tighter pinches
// than the car can drive.
export async function soloObservatory(ctx) {
  const anchor = ctx.anchors.observatory;
  const url = ctx.base + '/?map=observatory&script=sprint&car=' +
    encodeURIComponent(anchor.slug) + '&audio=0';
  const page = await ctx.openPage('observatory');
  await page.navigate(url);
  const running = await waitProbe(ctx, page, (probe) => probe.consumer === 'running' && probe.engineTick >= 2,
    { timeoutMs: 120000, label: 'observatory running' });
  await ctx.shot(page, 'start');

  ctx.A.check('observatory: URL is the requested scripted sprint', running.url === url, running.url);
  ctx.A.check('observatory: map is observatory', running.map?.id === 'observatory', ctx.fmt(running.map));
  ctx.A.check('observatory: course is observatory', running.sprint?.courseId === anchor.courseId,
    running.sprint?.courseId);
  ctx.A.check('observatory: layout hash is the committed collision path',
    running.sprintLayoutHash === anchor.layoutHash,
    running.sprintLayoutHash + ' vs ' + anchor.layoutHash);

  const done = await waitProbe(ctx, page, (probe) => probe.sprintResult !== null,
    { timeoutMs: 240000, label: 'observatory finish' });
  await ctx.shot(page, 'finish');
  const result = done.sprintResult;
  ctx.A.check('observatory: finish time is ' + anchor.timeSeconds + ' s',
    Math.abs(result.timeSeconds - anchor.timeSeconds) <= anchor.timeToleranceSeconds,
    'expected ' + anchor.timeSeconds + ' ± ' + anchor.timeToleranceSeconds + ', got ' + result.timeSeconds);
  ctx.A.check('observatory: two checkpoints were passed', result.checkpoints === anchor.checkpoints,
    'got ' + result.checkpoints);
  ctx.A.check('observatory: no respawn', result.respawns === 0, 'respawns ' + result.respawns);
  ctx.A.check('observatory: results overlay is visible', done.overlays.resultsHidden === false,
    ctx.fmt(done.overlays));
  ctx.A.check('observatory: no console error', page.messages.filter((m) => m.type === 'error').length === 0,
    ctx.fmt(page.messages.slice(-4)));
  ctx.evidence.finish = done;
}

// `solo-downtown`: the sixth playable map. The course is the committed
// collision-derived path (153.860674 m); the checkpoints sit on straight
// sections so the driven line crosses both gates.
export async function soloDowntown(ctx) {
  const anchor = ctx.anchors.downtown;
  const url = ctx.base + '/?map=downtown&script=sprint&car=' +
    encodeURIComponent(anchor.slug) + '&audio=0';
  const page = await ctx.openPage('downtown');
  await page.navigate(url);
  const running = await waitProbe(ctx, page, (probe) => probe.consumer === 'running' && probe.engineTick >= 2,
    { timeoutMs: 120000, label: 'downtown running' });
  await ctx.shot(page, 'start');

  ctx.A.check('downtown: URL is the requested scripted sprint', running.url === url, running.url);
  ctx.A.check('downtown: map is downtown', running.map?.id === 'downtown', ctx.fmt(running.map));
  ctx.A.check('downtown: course is downtown', running.sprint?.courseId === anchor.courseId,
    running.sprint?.courseId);
  ctx.A.check('downtown: layout hash is the committed collision path',
    running.sprintLayoutHash === anchor.layoutHash,
    running.sprintLayoutHash + ' vs ' + anchor.layoutHash);

  const done = await waitProbe(ctx, page, (probe) => probe.sprintResult !== null,
    { timeoutMs: 180000, label: 'downtown finish' });
  await ctx.shot(page, 'finish');
  const result = done.sprintResult;
  ctx.A.check('downtown: finish time is ' + anchor.timeSeconds + ' s',
    Math.abs(result.timeSeconds - anchor.timeSeconds) <= anchor.timeToleranceSeconds,
    'expected ' + anchor.timeSeconds + ' ± ' + anchor.timeToleranceSeconds + ', got ' + result.timeSeconds);
  ctx.A.check('downtown: two checkpoints were passed', result.checkpoints === anchor.checkpoints,
    'got ' + result.checkpoints);
  ctx.A.check('downtown: no respawn', result.respawns === 0, 'respawns ' + result.respawns);
  ctx.A.check('downtown: results overlay is visible', done.overlays.resultsHidden === false,
    ctx.fmt(done.overlays));
  ctx.A.check('downtown: no console error', page.messages.filter((m) => m.type === 'error').length === 0,
    ctx.fmt(page.messages.slice(-4)));
  ctx.evidence.finish = done;
}

// `solo-mharuna`: the seventh playable map. The course is the committed
// collision-derived path (309.170196 m) and the spawn sits at Y 1064, so the
// page passes the measured ground to the engine's probe column.
export async function soloMharuna(ctx) {
  const anchor = ctx.anchors.mharuna;
  const url = ctx.base + '/?map=mharuna&script=sprint&car=' +
    encodeURIComponent(anchor.slug) + '&audio=0';
  const page = await ctx.openPage('mharuna');
  await page.navigate(url);
  const running = await waitProbe(ctx, page, (probe) => probe.consumer === 'running' && probe.engineTick >= 2,
    { timeoutMs: 120000, label: 'mharuna running' });
  await ctx.shot(page, 'start');

  ctx.A.check('mharuna: URL is the requested scripted sprint', running.url === url, running.url);
  ctx.A.check('mharuna: map is mharuna', running.map?.id === 'mharuna', ctx.fmt(running.map));
  ctx.A.check('mharuna: course is mharuna', running.sprint?.courseId === anchor.courseId,
    running.sprint?.courseId);
  ctx.A.check('mharuna: layout hash is the committed collision path',
    running.sprintLayoutHash === anchor.layoutHash,
    running.sprintLayoutHash + ' vs ' + anchor.layoutHash);

  const done = await waitProbe(ctx, page, (probe) => probe.sprintResult !== null,
    { timeoutMs: 180000, label: 'mharuna finish' });
  await ctx.shot(page, 'finish');
  const result = done.sprintResult;
  ctx.A.check('mharuna: finish time is ' + anchor.timeSeconds + ' s',
    Math.abs(result.timeSeconds - anchor.timeSeconds) <= anchor.timeToleranceSeconds,
    'expected ' + anchor.timeSeconds + ' ± ' + anchor.timeToleranceSeconds + ', got ' + result.timeSeconds);
  ctx.A.check('mharuna: two checkpoints were passed', result.checkpoints === anchor.checkpoints,
    'got ' + result.checkpoints);
  ctx.A.check('mharuna: no respawn', result.respawns === 0, 'respawns ' + result.respawns);
  ctx.A.check('mharuna: results overlay is visible', done.overlays.resultsHidden === false,
    ctx.fmt(done.overlays));
  ctx.A.check('mharuna: no console error', page.messages.filter((m) => m.type === 'error').length === 0,
    ctx.fmt(page.messages.slice(-4)));
  ctx.evidence.finish = done;
}

// A generic solo scenario for a collision-derived map: it asserts the map and
// layout identity, the finish, the two checkpoints, zero respawns and a clean
// console. The anchor lives in `expected.json` under `solo.<mapId>`.
export function soloMapScenario(mapId) {
  return async function soloMap(ctx) {
    const anchor = ctx.anchors[mapId];
    if (!anchor) throw new Error('soloMapScenario: no anchor for ' + mapId);
    const url = ctx.base + '/?map=' + mapId + '&script=sprint&car=' +
      encodeURIComponent(anchor.slug) + '&audio=0';
    const page = await ctx.openPage(mapId);
    await page.navigate(url);
    const running = await waitProbe(ctx, page, (probe) => probe.consumer === 'running' && probe.engineTick >= 2,
      { timeoutMs: 120000, label: mapId + ' running' });
    await ctx.shot(page, 'start');

    ctx.A.check(mapId + ': URL is the requested scripted sprint', running.url === url, running.url);
    ctx.A.check(mapId + ': map is ' + mapId, running.map?.id === mapId, ctx.fmt(running.map));
    ctx.A.check(mapId + ': course is ' + mapId, running.sprint?.courseId === anchor.courseId,
      running.sprint?.courseId);
    ctx.A.check(mapId + ': layout hash is the committed collision path',
      running.sprintLayoutHash === anchor.layoutHash,
      running.sprintLayoutHash + ' vs ' + anchor.layoutHash);

    const done = await waitProbe(ctx, page, (probe) => probe.sprintResult !== null,
      { timeoutMs: 240000, label: mapId + ' finish' });
    await ctx.shot(page, 'finish');
    const result = done.sprintResult;
    ctx.A.check(mapId + ': finish time is ' + anchor.timeSeconds + ' s',
      Math.abs(result.timeSeconds - anchor.timeSeconds) <= anchor.timeToleranceSeconds,
      'expected ' + anchor.timeSeconds + ' ± ' + anchor.timeToleranceSeconds + ', got ' + result.timeSeconds);
    ctx.A.check(mapId + ': two checkpoints were passed', result.checkpoints === anchor.checkpoints,
      'got ' + result.checkpoints);
    ctx.A.check(mapId + ': no respawn', result.respawns === 0, 'respawns ' + result.respawns);
    ctx.A.check(mapId + ': results overlay is visible', done.overlays.resultsHidden === false,
      ctx.fmt(done.overlays));
    ctx.A.check(mapId + ': no console error', page.messages.filter((m) => m.type === 'error').length === 0,
      ctx.fmt(page.messages.slice(-4)));
    ctx.evidence.finish = done;
  };
}
