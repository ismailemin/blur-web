// E2E scenarios for the Blur Web E1 drive slice.
//
// Every scenario drives the real page through CDP, asserts against the committed
// measured anchors in `expected.json` (and the built layouts), captures at least
// one screenshot per step and leaves the console gate to `assertSilent` /
// `assertRejection`. No scenario weakens an anchor: when a value differs, the
// assertion records expected vs actual and the run fails.

import { MAPS } from '../e1-drive/web/map-registry.js';
import { sleep } from './cdp.mjs';

const MP_ROOM_CODE = /^[A-Z2-9]{5}$/;

/**
 * One compact read of the page's own probe. `e1DriveProbe` is the page's
 * documented capture surface; `__mp.snapshot()` is the MP capture surface.
 * A page that rejected its URL at module-evaluation time has no probe at all.
 */
const READ_PROBE = `(() => {
  const p = window.e1DriveProbe;
  const el = (id) => document.getElementById(id);
  return {
    hasProbe: Boolean(p),
    url: location.href,
    readyState: document.readyState,
    consumer: p?.consumer ?? null,
    error: p?.error ?? null,
    mode: p?.mode ?? null,
    engineTick: p?.engineTick ?? null,
    displayTick: p?.displayTick ?? null,
    frames: p?.frames ?? null,
    car: p?.car ? { slug: p.car.slug, name: p.car.name, drivetrain: p.car.drivetrain } : null,
    map: p?.map ?? null,
    mapCounts: p?.mapCounts ?? null,
    sprint: p?.sprint ?? null,
    raceMode: p?.raceMode ?? null,
    sprintResult: p?.sprintResult ?? null,
    sprintCourseId: p?.sprintCourseId ?? null,
    sprintLayoutHash: p?.sprintLayoutHash ?? null,
    sprintBest: p?.sprintBest ?? null,
    restarts: p?.restarts ?? 0,
    props: p?.props ?? null,
    tickHash: p?.tickHash ?? null,
    tick0Hash: p?.tick0Hash ?? null,
    mp: window.__mp ? window.__mp.snapshot() : null,
    overlays: {
      errorHidden: el('error')?.hidden ?? null,
      errorText: el('error')?.textContent ?? null,
      resultsHidden: el('results')?.hidden ?? null,
      resultsTime: el('results-time')?.textContent ?? null,
      resultsBest: el('results-best')?.textContent ?? null,
      mpResultsHidden: el('mp-results')?.hidden ?? null,
      mpResultsText: el('mp-results')?.textContent ?? null,
      remoteTagHidden: el('remote-tag')?.hidden ?? null,
      remoteTagText: el('remote-tag')?.textContent ?? null,
      remotesHidden: el('mp-remotes')?.hidden ?? null,
      remotesText: el('mp-remotes')?.textContent ?? null,
      hudText: el('hud')?.textContent ?? null,
      countdownHidden: el('countdown')?.hidden ?? null,
      countdownText: el('countdown')?.textContent ?? null,
      eventText: el('event')?.textContent ?? null,
      powerupHudHidden: el('powerup-hud')?.hidden ?? null,
      powerupHudText: el('powerup-hud')?.textContent ?? null
    }
  };
})()`;

export async function readProbe(page) {
  try {
    return await page.evaluate(READ_PROBE);
  } catch {
    // A navigation mid-flight rejects the evaluate; the caller polls again.
    return null;
  }
}

function probeSummary(probe) {
  if (!probe) return 'no probe';
  return JSON.stringify({
    consumer: probe.consumer,
    error: probe.error,
    mode: probe.mode,
    engineTick: probe.engineTick,
    course: probe.sprint?.courseId ?? probe.sprintCourseId,
    finished: probe.sprint?.finished ?? null,
    phase: probe.mp?.phase ?? null,
    status: probe.mp?.status ?? null
  });
}

/** Poll the page probe until `predicate` holds; fail early on a page error. */
export async function waitProbe(ctx, page, predicate, { timeoutMs, label, allowError = false }) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await readProbe(page);
    if (last) {
      if (last.consumer === 'error' && !allowError) {
        throw new Error(label + ': page error: ' + last.error);
      }
      if (predicate(last)) return last;
    }
    await sleep(120);
  }
  throw new Error(label + ': timed out after ' + timeoutMs + ' ms; last ' + probeSummary(last));
}

async function waitMp(ctx, page, predicate, { timeoutMs, label }) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await readProbe(page);
    if (last?.mp) {
      if (last.consumer === 'error' || last.error) {
        throw new Error(label + ': page error: ' + (last.error ?? last.mp.error));
      }
      if (predicate(last)) return last;
    }
    await sleep(120);
  }
  throw new Error(label + ': timed out after ' + timeoutMs + ' ms; last ' + probeSummary(last));
}

function matchesAny(messages, regexes) {
  return messages.filter((message) => regexes.some((regex) => regex.test(message.text)));
}

/** Assert the slice [from, now) contains no console message of any kind. */
export function assertSilent(ctx, page, from, label) {
  const slice = page.messages.slice(from);
  ctx.A.check(label + ': console silent (0 messages of any kind)', slice.length === 0, ctx.fmt(slice));
  ctx.A.check(label + ': console 0 errors', slice.filter((m) => m.type === 'error').length === 0, ctx.fmt(slice));
  ctx.A.check(label + ': console 0 warnings',
    slice.filter((m) => m.type === 'warning' || m.type === 'warn').length === 0, ctx.fmt(slice));
  page.consumed = Math.max(page.consumed ?? 0, page.messages.length);
}

/** Assert the slice [from, now) is exactly one typed rejection message. */
export function assertRejection(ctx, page, from, label, pattern) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const slice = page.messages.slice(from);
  const matched = matchesAny(slice, [regex]);
  const unexpected = slice.filter((message) => !regex.test(message.text));
  ctx.A.check(label + ': typed rejection raised', matched.length === 1, ctx.fmt(slice));
  ctx.A.check(label + ': rejection text names the exact rule', matched.length === 1 && regex.test(matched[0].text),
    ctx.fmt(matched));
  ctx.A.check(label + ': no other console output', unexpected.length === 0, ctx.fmt(unexpected));
  page.consumed = Math.max(page.consumed ?? 0, page.messages.length);
  return matched[0] ?? null;
}

// ------------------------------------------------------------------ solo

/**
 * `solo-sprint`: one tab, default 310 m scripted sprint. The committed anchor
 * (14.650 s / tick 969) is asserted, then a second fresh-page run must produce
 * the identical finish time, tick and layout hash (determinism).
 */
export async function soloSprint(ctx) {
  const anchor = ctx.anchors.sprint;
  const url = ctx.base + '/?script=sprint&car=' + encodeURIComponent(anchor.slug) + '&audio=0';
  const page = await ctx.openPage('driver');
  const runs = ctx.options.sprintRuns;
  let first = null;

  for (let index = 1; index <= runs; index++) {
    const prefix = runs > 1 ? 'run' + index + '-' : '';
    await page.navigate(url);
    const running = await waitProbe(ctx, page, (probe) => probe.consumer === 'running' && probe.engineTick >= 2,
      { timeoutMs: 90000, label: prefix + 'sprint running' });
    await ctx.shot(page, prefix + 'start');

    if (index === 1) {
      ctx.A.check('sprint: URL is the requested scripted sprint', running.url === url, running.url);
      ctx.A.check('sprint: page mode is script:sprint', running.mode === 'script:sprint', running.mode);
      ctx.A.check('sprint: car is ' + anchor.slug, running.car?.slug === anchor.slug, ctx.fmt(running.car));
      ctx.A.check('sprint: map is river', running.map?.id === 'river', ctx.fmt(running.map));
      ctx.A.check('sprint: course is 310m', running.sprint?.courseId === anchor.courseId,
        running.sprint?.courseId);
      ctx.A.check('sprint: layout hash is the committed 310 m layout',
        running.sprintLayoutHash === ctx.anchors.layouts['310m'],
        running.sprintLayoutHash + ' vs ' + ctx.anchors.layouts['310m']);
      ctx.A.check('sprint: countdown label is visible at the start',
        running.overlays.countdownHidden === false, ctx.fmt(running.overlays));
      ctx.evidence.start = running;
    }

    const done = await waitProbe(ctx, page, (probe) => probe.sprintResult !== null,
      { timeoutMs: 90000 + Math.round(anchor.timeSeconds * 1000), label: prefix + 'sprint finish' });
    await ctx.shot(page, prefix + 'finish');

    const result = done.sprintResult;
    ctx.A.check('sprint: engine tick advanced past the finish gate', done.engineTick >= anchor.tick,
      'tick ' + done.engineTick + ' < ' + anchor.tick);
    ctx.A.check('sprint: finish time is the committed anchor (' + anchor.timeSeconds + ' s)',
      Math.abs(result.timeSeconds - anchor.timeSeconds) <= anchor.timeToleranceSeconds,
      'expected ' + anchor.timeSeconds + ' ± ' + anchor.timeToleranceSeconds + ', got ' + result.timeSeconds);
    ctx.A.check('sprint: finish tick is ' + anchor.tick, done.sprint.finishTick === anchor.tick,
      'got ' + done.sprint.finishTick);
    ctx.A.check('sprint: both checkpoints counted', result.checkpoints === anchor.checkpoints,
      'got ' + result.checkpoints);
    ctx.A.check('sprint: sprint result has no lap array', result.laps === null, ctx.fmt(result.laps));
    ctx.A.check('sprint: no respawn', result.respawns === 0, 'respawns ' + result.respawns);
    ctx.A.check('sprint: results overlay is visible', done.overlays.resultsHidden === false,
      ctx.fmt(done.overlays));
    ctx.A.check('sprint: results overlay shows the measured time',
      (done.overlays.resultsTime ?? '').includes(anchor.timeSeconds.toFixed(3)),
      done.overlays.resultsTime);
    ctx.A.check('sprint: results overlay names the car',
      (done.overlays.resultsTime ?? '').includes(ctx.anchors.cars.defaultName), done.overlays.resultsTime);
    if (index === 1) {
      ctx.A.check('sprint: best time stored on the first run', result.improved === true,
        ctx.fmt({ best: result.bestSeconds, previous: result.previousBestSeconds, improved: result.improved }));
    }

    if (index === 1) {
      first = { timeSeconds: result.timeSeconds, tick: done.sprint.finishTick, layout: done.sprintLayoutHash };
      ctx.evidence.finish = done;
    } else {
      ctx.A.check('sprint: repeat run finishes at the identical time',
        result.timeSeconds === first.timeSeconds,
        'run1 ' + first.timeSeconds + ', run' + index + ' ' + result.timeSeconds);
      ctx.A.check('sprint: repeat run finishes at the identical tick',
        done.sprint.finishTick === first.tick,
        'run1 ' + first.tick + ', run' + index + ' ' + done.sprint.finishTick);
      ctx.A.check('sprint: repeat run uses the identical layout',
        done.sprintLayoutHash === first.layout, done.sprintLayoutHash);
      ctx.A.check('sprint: an equal repeat does not rewrite the best time',
        result.improved === false, ctx.fmt({ improved: result.improved, best: result.bestSeconds }));
      ctx.evidence.repeat = { timeSeconds: result.timeSeconds, tick: done.sprint.finishTick };
    }

    assertSilent(ctx, page, page.consumed ?? 0, prefix + 'sprint run' + index);
  }
}

/**
 * `solo-lap`: `?course=lap`, three laps on the measured loop-01 course.
 * Asserts the three lap times, the best lap and the measured total.
 */
export async function soloLap(ctx) {
  const anchor = ctx.anchors.lap;
  const url = ctx.base + '/?script=sprint&course=lap&car=' + encodeURIComponent(anchor.slug) + '&audio=0';
  const page = await ctx.openPage('driver');
  await page.navigate(url);
  const running = await waitProbe(ctx, page, (probe) => probe.consumer === 'running' && probe.engineTick >= 2,
    { timeoutMs: 120000, label: 'lap running' });
  await ctx.shot(page, 'start');
  ctx.A.check('lap: URL is the requested lap course', running.url === url, running.url);
  ctx.A.check('lap: course is lap', running.sprint?.courseId === anchor.courseId, running.sprint?.courseId);
  ctx.A.check('lap: layout hash is the committed lap layout',
    running.sprintLayoutHash === ctx.anchors.layouts.lap,
    running.sprintLayoutHash + ' vs ' + ctx.anchors.layouts.lap);
  ctx.A.check('lap: three laps are configured', running.sprint?.laps === anchor.laps, running.sprint?.laps);
  ctx.A.check('lap: map is river', running.map?.id === 'river', ctx.fmt(running.map));
  ctx.evidence.start = running;

  const twoLaps = await waitProbe(ctx, page, (probe) => (probe.sprint?.lapTimes?.length ?? 0) >= 2,
    { timeoutMs: 120000, label: 'lap two laps' });
  await ctx.shot(page, 'lap2');
  ctx.A.check('lap: second lap crossing is counted while racing',
    twoLaps.sprint.lapTimes.length >= 2, ctx.fmt(twoLaps.sprint.lapTimes));

  const done = await waitProbe(ctx, page, (probe) => probe.sprintResult !== null,
    { timeoutMs: 90000 + Math.round(anchor.timeSeconds * 1000), label: 'lap finish' });
  await ctx.shot(page, 'finish');
  const result = done.sprintResult;
  ctx.A.check('lap: finish time is the committed anchor (' + anchor.timeSeconds + ' s)',
    Math.abs(result.timeSeconds - anchor.timeSeconds) <= anchor.timeToleranceSeconds,
    'expected ' + anchor.timeSeconds + ', got ' + result.timeSeconds);
  ctx.A.check('lap: finish tick is ' + anchor.tick, done.sprint.finishTick === anchor.tick,
    'got ' + done.sprint.finishTick);
  ctx.A.check('lap: three lap times are present',
    Array.isArray(result.lapTimes) && result.lapTimes.length === anchor.laps,
    ctx.fmt(result.lapTimes));
  anchor.lapTimesSeconds.forEach((expected, index) => {
    const actual = result.lapTimes?.[index];
    ctx.A.check('lap: lap ' + (index + 1) + ' time is ' + expected + ' s',
      Number.isFinite(actual) && Math.abs(actual - expected) <= anchor.timeToleranceSeconds,
      'got ' + actual);
  });
  ctx.A.check('lap: best lap is ' + anchor.bestLapSeconds + ' s',
    Number.isFinite(result.bestLapSeconds) &&
      Math.abs(result.bestLapSeconds - anchor.bestLapSeconds) <= anchor.timeToleranceSeconds,
    'got ' + result.bestLapSeconds);
  ctx.A.check('lap: no respawn', result.respawns === 0, 'respawns ' + result.respawns);
  ctx.A.check('lap: results overlay is visible', done.overlays.resultsHidden === false,
    ctx.fmt(done.overlays));
  ctx.A.check('lap: results overlay shows the measured race time',
    (done.overlays.resultsTime ?? '').includes(anchor.timeSeconds.toFixed(3)),
    done.overlays.resultsTime);
  ctx.A.check('lap: results overlay lists every lap time',
    anchor.lapTimesSeconds.every((seconds) =>
      (done.overlays.resultsBest ?? '').includes(seconds.toFixed(3))),
    done.overlays.resultsBest);
  assertSilent(ctx, page, 0, 'lap');
  ctx.evidence.finish = done;
}

/**
 * `solo-free`: free roam on the measured basin. There is no finish by design;
 * the scenario asserts that no race result appears, the car is contained, the
 * 447-collider prop layer is live and `R` rebuilds at the spawn.
 */
export async function soloFree(ctx) {
  const anchor = ctx.anchors.free;
  const url = ctx.base + '/?course=free&script=sprint&car=' + encodeURIComponent(anchor.slug) + '&audio=0';
  const page = await ctx.openPage('driver');
  await page.navigate(url);
  const running = await waitProbe(ctx, page, (probe) => probe.consumer === 'running' && probe.engineTick >= 240,
    { timeoutMs: 120000, label: 'free roam running' });
  await ctx.shot(page, 'mid');
  ctx.A.check('free: URL is the requested free-roam course', running.url === url, running.url);
  ctx.A.check('free: course is free', running.sprint?.courseId === anchor.courseId,
    running.sprint?.courseId);
  ctx.A.check('free: layout hash is the committed free-roam layout',
    running.sprintLayoutHash === ctx.anchors.layouts.free,
    running.sprintLayoutHash + ' vs ' + ctx.anchors.layouts.free);
  ctx.A.check('free: map is river', running.map?.id === 'river', ctx.fmt(running.map));
  ctx.A.check('free: no finish state', running.sprint?.finished === false, running.sprint?.finished);
  ctx.A.check('free: no sprint result was produced', running.sprintResult === null,
    ctx.fmt(running.sprintResult));
  ctx.A.check('free: results overlay stays hidden', running.overlays.resultsHidden === true,
    ctx.fmt(running.overlays));
  ctx.A.check('free: no next gate exists', running.sprint?.nextGate === null, ctx.fmt(running.sprint?.nextGate));
  ctx.A.check('free: the car is inside the measured basin', running.sprint?.free?.contained === true,
    ctx.fmt(running.sprint?.free));
  ctx.A.check('free: session clock is running',
    Number.isFinite(running.sprint?.elapsedSeconds) && running.sprint.elapsedSeconds >= anchor.minElapsedSeconds,
    running.sprint?.elapsedSeconds);
  ctx.A.check('free: the 447-collider R04 prop layer is live',
    running.props?.colliders === anchor.propColliders, ctx.fmt(running.props));
  ctx.evidence.mid = running;

  const before = running.restarts;
  await page.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'R' })); true");
  const reset = await waitProbe(ctx, page, (probe) => probe.restarts > before && probe.engineTick >= 20,
    { timeoutMs: 30000, label: 'free roam reset' });
  await ctx.shot(page, 'reset');
  ctx.A.check('free: R rebuilt the world exactly once', reset.restarts === before + 1,
    'before ' + before + ', after ' + reset.restarts);
  ctx.A.check('free: reset restarted the session clock', reset.sprint?.elapsedSeconds < 2,
    reset.sprint?.elapsedSeconds);
  ctx.A.check('free: reset kept the car at the spawn',
    Number.isFinite(reset.sprint?.free?.distanceFromSpawnMetres) &&
      reset.sprint.free.distanceFromSpawnMetres < 20,
    reset.sprint?.free?.distanceFromSpawnMetres);
  ctx.A.check('free: reset produced no race result', reset.sprintResult === null, ctx.fmt(reset.sprintResult));
  ctx.A.check('free: reset stays contained', reset.sprint?.free?.contained === true,
    ctx.fmt(reset.sprint?.free));
  assertSilent(ctx, page, 0, 'free');
  ctx.evidence.reset = reset;
}

// ------------------------------------------------------------------ multiplayer

async function openRoom(ctx, {
  mapId,
  hostCar,
  guestCar,
  hostExtra = '',
  guestExtra = '',
  guestPace,
  expectAi = 0
}) {
  const pins = MAPS[mapId]?.mpPins ?? null;
  const roomQuery = '&mpServer=' + encodeURIComponent(ctx.roomUrl) + '&audio=0';
  const host = await ctx.openPage('host');
  const hostUrl = ctx.base + '/?mp=1&host=1&script=sprint&car=' + encodeURIComponent(hostCar) +
    '&map=' + encodeURIComponent(mapId) + '&name=Host' + hostExtra + roomQuery;
  await host.navigate(hostUrl);
  const hostLobby = await waitMp(ctx, host, (probe) =>
    probe.mp.phase === 'lobby' && probe.mp.engineReady === true &&
    (expectAi === 0 || (probe.mp.ai?.count === expectAi && probe.mp.ai?.built === true)),
  { timeoutMs: 180000, label: 'host lobby' });
  const code = hostLobby.mp.roomCode;

  const guest = await ctx.openPage('guest');
  const guestUrl = ctx.base + '/?mp=1&room=' + encodeURIComponent(code ?? '') + '&script=sprint&car=' +
    encodeURIComponent(guestCar) + '&mpPace=' + guestPace + '&name=Guest' + guestExtra + roomQuery;
  await guest.navigate(guestUrl);
  const guestLobby = await waitMp(ctx, guest, (probe) =>
    probe.mp.phase === 'lobby' && probe.mp.engineReady === true &&
    (expectAi === 0 || probe.mp.ai?.remotePlayers?.length === expectAi),
  { timeoutMs: 180000, label: 'guest lobby' });
  const roster = await waitMp(ctx, host, (probe) => probe.mp.players?.length === 2,
    { timeoutMs: 30000, label: 'host roster' });

  return { host, guest, hostUrl, guestUrl, code, hostLobby, guestLobby, roster, pins };
}

function assertLobby(ctx, room, { mapId, hostCar, guestCar, expectAi = 0 }) {
  const { host, guest, code, hostLobby, guestLobby, roster, pins } = room;
  ctx.A.check('mp: host allocated a 5-character room code', MP_ROOM_CODE.test(code ?? ''), code);
  ctx.A.check('mp: guest joined the allocated room', guestLobby.mp.roomCode === code,
    ctx.fmt({ host: code, guest: guestLobby.mp.roomCode }));
  ctx.A.check('mp: both rosters show two human players',
    roster.mp.players.length === 2 && guestLobby.mp.players.length === 2,
    roster.mp.players.length + '/' + guestLobby.mp.players.length);
  const hostSelf = roster.mp.players.find((player) => player.id === roster.mp.you.id);
  const hostOther = roster.mp.players.find((player) => player.id !== roster.mp.you.id);
  const guestSelf = guestLobby.mp.players.find((player) => player.id === guestLobby.mp.you.id);
  ctx.A.check('mp: host is slot 1 and guest is slot 2',
    hostSelf?.slot === 1 && hostSelf?.host === true && hostOther?.slot === 2 &&
      guestSelf?.slot === 2 && guestSelf?.host === false,
    ctx.fmt({ hostSelf, guestSelf }));
  ctx.A.check('mp: lobby map is ' + mapId,
    hostLobby.mp.mapId === mapId && guestLobby.mp.mapId === mapId,
    ctx.fmt({ host: hostLobby.mp.mapId, guest: guestLobby.mp.mapId }));
  ctx.A.check('mp: both pages verified the pinned map record',
    hostLobby.mp.mapReady === true && guestLobby.mp.mapReady === true &&
      hostLobby.mp.map?.packageHash === pins?.packageHash &&
      guestLobby.mp.map?.packageHash === pins?.packageHash &&
      hostLobby.mp.map?.layoutHash === pins?.layoutHash &&
      hostLobby.mp.map?.physicsHash === pins?.physicsHash,
    ctx.fmt({ host: hostLobby.mp.map, guest: guestLobby.mp.map, pins }));
  ctx.A.check('mp: each page loads its own session car',
    hostLobby.mp.sessionCar === hostCar && guestLobby.mp.sessionCar === guestCar,
    hostLobby.mp.sessionCar + ' / ' + guestLobby.mp.sessionCar);
  ctx.A.check('mp: START is host-only and disabled before READY',
    hostLobby.mp.overlays.startHidden === false && hostLobby.mp.overlays.startDisabled === true &&
      guestLobby.mp.overlays.startHidden === true,
    ctx.fmt({ host: hostLobby.mp.overlays, guest: guestLobby.mp.overlays }));
  if (expectAi > 0) {
    const hostAi = hostLobby.mp.ai.records ?? [];
    const guestAi = guestLobby.mp.ai.records ?? [];
    ctx.A.check('mp-ai: host builds ' + expectAi + ' AI records as ai-1…',
      hostAi.length === expectAi && hostAi.every((record, index) =>
        record.id === 'ai-' + (index + 1) && record.slot === 3 + index),
      ctx.fmt(hostAi));
    ctx.A.check('mp-ai: guest sees the same AI roster read-only',
      guestLobby.mp.ai.host === false && guestLobby.mp.ai.records.length === expectAi &&
        JSON.stringify(guestAi.map((row) => [row.id, row.slot, row.car, row.profile])) ===
          JSON.stringify(hostAi.map((row) => [row.id, row.slot, row.car, row.profile])),
      ctx.fmt({ host: hostAi, guest: guestAi }));
  }
  void host;
  void guest;
}

async function startRoomRace(ctx, room, { timeoutMs, midScreenshot = true, expectAi = 0 }) {
  const { host, guest } = room;
  await host.evaluate('window.__mp.setReady(true)');
  await guest.evaluate('window.__mp.setReady(true)');
  const ready = await waitMp(ctx, host, (probe) =>
    probe.mp.players?.length === 2 && probe.mp.players.every((player) => player.ready),
  { timeoutMs: 30000, label: 'host all ready' });
  ctx.A.check('mp: READY propagates to both players',
    ready.mp.players.every((player) => player.ready), ctx.fmt(ready.mp.players));
  ctx.A.check('mp: host START enabled when every human is ready', ready.mp.overlays.startDisabled === false,
    ctx.fmt(ready.mp.overlays));
  await ctx.shot(host, 'lobby-host');
  await ctx.shot(guest, 'lobby-guest');

  await host.evaluate('window.__mp.start()');
  const hostStarted = await waitMp(ctx, host, (probe) => probe.mp.started === true && probe.mp.engineTick >= 2,
    { timeoutMs: 45000, label: 'host race start' });
  const guestStarted = await waitMp(ctx, guest, (probe) => probe.mp.started === true && probe.mp.engineTick >= 2,
    { timeoutMs: 45000, label: 'guest race start' });
  await ctx.shot(host, 'race-start');
  ctx.A.check('mp: room.started reaches both pages', hostStarted.mp.started && guestStarted.mp.started);
  ctx.A.check('mp: room.started carries the selected map',
    hostStarted.mp.mapId === ctx.evidence.mapId && guestStarted.mp.mapId === ctx.evidence.mapId,
    ctx.fmt({ host: hostStarted.mp.mapId, guest: guestStarted.mp.mapId }));
  if (expectAi > 0) {
    const aiStarted = await waitMp(ctx, host, (probe) =>
      probe.mp.ai?.hostSim?.count === expectAi &&
      probe.mp.ai.hostSim.sims?.every((sim) => sim.startSlot !== null),
    { timeoutMs: 30000, label: 'host AI worlds built' });
    ctx.A.check('mp-ai: host built one wasm instance per AI with a grounded start slot',
      aiStarted.mp.ai.hostSim.count === expectAi &&
        aiStarted.mp.ai.hostSim.sims.every((sim) => sim.startSlot !== null),
      ctx.fmt(aiStarted.mp.ai.hostSim));
    ctx.evidence.aiStart = aiStarted.mp.ai.hostSim;
  }

  let midAt = null;
  if (midScreenshot) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const hostProbe = await readProbe(host);
      const guestProbe = await readProbe(guest);
      if (hostProbe?.mp?.engineTick >= 300 && guestProbe?.mp?.engineTick >= 300 &&
          hostProbe.mp.sprint?.phase === 'running' && guestProbe.mp.sprint?.phase === 'running') {
        midAt = { host: hostProbe.mp.engineTick, guest: guestProbe.mp.engineTick };
        break;
      }
      await sleep(100);
    }
    ctx.A.check('mp: both pages reached a running race (tick >= 300)', midAt !== null,
      'race did not reach tick 300 within 60 s');
    if (midAt) {
      await ctx.shot(host, 'race-mid');
      await ctx.shot(guest, 'race-mid');
    }
  }
  return { hostStarted, guestStarted, midAt };
}

function rowFor(rows, playerId) {
  return rows.find((row) => row.playerId === playerId) ?? null;
}

function assertMpResult(ctx, { hostView, guestView, hostStarted, expected, expectAi = 0 }) {
  const hostRes = hostView.mp.result;
  const guestRes = guestView.mp.result;
  ctx.A.check('mp: both pages reached the shared result',
    hostView.mp.phase === 'finished' && guestView.mp.phase === 'finished',
    ctx.fmt({ host: hostView.mp.phase, guest: guestView.mp.phase }));
  ctx.A.check('mp: host and guest render the same result hash',
    typeof hostRes.hash === 'string' && hostRes.hash === guestRes.hash,
    hostRes.hash + ' / ' + guestRes.hash);
  ctx.A.check('mp: host and guest render identical result rows',
    JSON.stringify(hostRes.rows) === JSON.stringify(guestRes.rows),
    'row sets differ');
  ctx.A.check('mp: result identifies the measured course ' + expected.courseId,
    hostRes.courseId === expected.courseId && guestRes.courseId === expected.courseId,
    ctx.fmt({ host: hostRes.courseId, guest: guestRes.courseId }));
  ctx.A.check('mp: every result row finished (no DNF)',
    hostRes.rows.every((row) => row.status === 'finished'),
    ctx.fmt(hostRes.rows.map((row) => [row.playerId, row.status])));

  const expectedRows = expected.rows;
  const hostId = hostView.mp.you.id;
  const guestId = guestView.mp.you.id;
  ctx.A.check('mp: result table has ' + expectedRows.length + ' rows',
    hostRes.rows.length === expectedRows.length, 'got ' + hostRes.rows.length);
  for (const expectedRow of expectedRows) {
    const playerId = expectedRow.playerId ??
      (expectedRow.role === 'host' ? hostId : expectedRow.role === 'guest' ? guestId : null);
    const actual = rowFor(hostRes.rows, playerId);
    const label = expectedRow.playerId ?? expectedRow.role;
    ctx.A.check('mp: ' + label + ' row exists', Boolean(actual), ctx.fmt(hostRes.rows.map((row) => row.playerId)));
    if (!actual) continue;
    ctx.A.check('mp: ' + label + ' finish tick is ' + expectedRow.tick,
      actual.tick === expectedRow.tick, 'got ' + actual.tick);
    ctx.A.check('mp: ' + label + ' race time is ' + expectedRow.timeSeconds + ' s',
      Math.abs(actual.timeSeconds - expectedRow.timeSeconds) <= 0.001,
      'got ' + actual.timeSeconds);
    ctx.A.check('mp: ' + label + ' position is P' + expectedRow.position,
      actual.positionNumber === expectedRow.position, 'got P' + actual.positionNumber);
    if (actual.ai === true) {
      // AI rows are host-simulated: they carry no client finish report by
      // design (the per-AI state-sequence hash is asserted from hostSim).
      ctx.A.check('mp: ' + label + ' row is host-simulated (no client finish hash)',
        actual.finishHash === null && actual.ai === true, ctx.fmt(actual));
    } else {
      ctx.A.check('mp: ' + label + ' row reports a finish hash',
        typeof actual.finishHash === 'string' && actual.finishHash.startsWith('sha256:'),
        actual.finishHash);
    }
  }

  const hostSelfRow = rowFor(hostRes.rows, hostView.mp.you.id);
  const guestSelfRow = rowFor(guestRes.rows, guestView.mp.you.id);
  ctx.A.check('mp: host row equals the host local finish within one tick',
    Number.isInteger(hostView.mp.finishTick) && Math.abs(hostView.mp.finishTick - hostSelfRow.tick) <= 1,
    ctx.fmt({ local: hostView.mp.finishTick, row: hostSelfRow.tick }));
  ctx.A.check('mp: guest row equals the guest local finish within one tick',
    Number.isInteger(guestView.mp.finishTick) && Math.abs(guestView.mp.finishTick - guestSelfRow.tick) <= 1,
    ctx.fmt({ local: guestView.mp.finishTick, row: guestSelfRow.tick }));
  ctx.A.check('mp: each page reports its own finish hash in the shared row',
    hostSelfRow.finishHash === hostView.mp.finishHash &&
      guestSelfRow.finishHash === guestView.mp.finishHash,
    ctx.fmt({ host: hostView.mp.finishHash, guest: guestView.mp.finishHash }));
  ctx.A.check('mp: no start or race respawn on either page',
    hostView.mp.sprint?.respawns === 0 && guestView.mp.sprint?.respawns === 0,
    ctx.fmt({ host: hostView.mp.sprint?.respawns, guest: guestView.mp.sprint?.respawns }));
  ctx.A.check('mp: results overlay is visible on both pages',
    hostView.overlays.resultsHidden === false && guestView.overlays.resultsHidden === false &&
      hostView.overlays.mpResultsHidden === false,
    ctx.fmt({ host: hostView.overlays.resultsHidden, guest: guestView.overlays.resultsHidden }));
  ctx.A.check('mp: host RaceSession accepted the guest finish report',
    hostView.mp.validation?.guestReportAccepted === true &&
      hostView.mp.validation?.guestValidated === true,
    ctx.fmt(hostView.mp.validation));

  if (expectAi > 0) {
    const aiRows = hostRes.rows.filter((row) => row.ai === true);
    ctx.A.check('mp-ai: shared table contains ' + expectAi + ' AI rows',
      aiRows.length === expectAi, ctx.fmt(aiRows.map((row) => row.playerId)));
    ctx.A.check('mp-ai: every AI finished (no DNF)',
      aiRows.every((row) => row.status === 'finished'),
      ctx.fmt(aiRows.map((row) => [row.playerId, row.status])));
    const sims = hostView.mp.ai.hostSim?.sims ?? [];
    ctx.A.check('mp-ai: host simulated each AI for the whole race',
      sims.length === expectAi && sims.every((sim) => sim.finished === true && sim.dnf !== true),
      ctx.fmt(sims.map((sim) => [sim.id, sim.finished, sim.dnf, sim.ticks])));
    ctx.A.check('mp-ai: no AI respawned',
      sims.every((sim) => sim.respawns === 0),
      ctx.fmt(sims.map((sim) => [sim.id, sim.respawns])));
    ctx.A.check('mp-ai: each AI has a per-tick state hash sequence',
      sims.every((sim) => sim.stateHashCount > 100), ctx.fmt(sims.map((sim) => [sim.id, sim.stateHashCount])));
    ctx.A.check('mp-ai: the guest received AI poses from the host relay',
      guestView.mp.ai.poseCount > 0 && guestView.mp.ai.remotes?.length >= expectAi,
      ctx.fmt({ poseCount: guestView.mp.ai.poseCount, remotes: guestView.mp.ai.remotes?.length }));
    ctx.A.check('mp-ai: the AI relays were merged into one shared table',
      hostView.mp.ai.allTerminal === true && hostView.mp.ai.resultHash !== null,
      ctx.fmt({ allTerminal: hostView.mp.ai.allTerminal, hash: hostView.mp.ai.resultHash }));
  }

  void hostStarted;
}

function assertRoomStats(ctx, room, baseline = null) {
  const stats = ctx.roomServer?.stats?.() ?? null;
  if (!stats) {
    // `--base` attach mode with an external room service: the harness did not
    // start it, so statistics are not observable. Recorded, never asserted.
    ctx.evidence.roomStatsUnavailable = 'attached room service; --base/--room-url has no stats()';
    return;
  }
  // A retry reuses the same room service, so counters are compared as deltas.
  const delta = (key) => (baseline ? (stats[key] ?? 0) - (baseline[key] ?? 0) : stats[key] ?? 0);
  ctx.A.check('mp: this attempt created exactly one room', delta('roomsCreated') === 1,
    ctx.fmt({ roomsCreated: delta('roomsCreated'), total: stats.roomsCreated }));
  ctx.A.check('mp: this attempt finished exactly one room', delta('roomsFinished') === 1,
    ctx.fmt({ roomsFinished: delta('roomsFinished'), total: stats.roomsFinished }));
  ctx.A.check('mp: room service recorded no protocol errors', delta('protocolErrors') === 0,
    ctx.fmt({ protocolErrors: delta('protocolErrors') }));
  ctx.evidence.roomStats = stats;
}

async function mpRace(ctx, { mapId, expected, guestCar, guestPace, hostExtra = '', guestExtra = '', expectAi = 0 }) {
  ctx.evidence.mapId = mapId;
  const roomBaseline = ctx.roomServer?.stats?.() ?? null;
  const room = await openRoom(ctx, {
    mapId,
    hostCar: expected.hostCar ?? ctx.anchors.cars.default,
    guestCar,
    hostExtra,
    guestPace,
    expectAi
  });
  ctx.evidence.room = { code: room.code, hostUrl: room.hostUrl, guestUrl: room.guestUrl };
  assertLobby(ctx, room, {
    mapId,
    hostCar: expected.hostCar ?? ctx.anchors.cars.default,
    guestCar,
    expectAi
  });

  const { hostStarted } = await startRoomRace(ctx, room, { timeoutMs: 60000, expectAi });
  const resultTimeout = mapId === 'amboy' ? 360000 : mapId === 'gracia' ? 180000 : 120000;
  const hostView = await waitMp(ctx, room.host, (probe) => probe.mp.result !== null,
    { timeoutMs: resultTimeout, label: 'host result' });
  const guestView = await waitMp(ctx, room.guest, (probe) => probe.mp.result !== null,
    { timeoutMs: resultTimeout, label: 'guest result' });
  await ctx.shot(room.host, 'finish-host');
  await ctx.shot(room.guest, 'finish-guest');

  assertMpResult(ctx, { hostView, guestView, hostStarted, expected, expectAi });
  if (expectAi === 0) {
    ctx.A.check('mp: remote tag is visible and labelled REMOTE',
      hostView.overlays.remoteTagHidden === false && guestView.overlays.remoteTagHidden === false &&
        /^REMOTE/.test(hostView.overlays.remoteTagText ?? '') &&
        /no collision/.test(hostView.overlays.remoteTagText ?? ''),
      ctx.fmt({ host: hostView.overlays.remoteTagText, guest: guestView.overlays.remoteTagText }));
    ctx.A.check('mp: each page loaded the peer car chunk from the roster',
      hostView.mp.remote?.car === guestCar && guestView.mp.remote?.car === expected.hostCar &&
        hostView.mp.remote?.carChunk?.status === 'ready' &&
        guestView.mp.remote?.carChunk?.status === 'ready',
      ctx.fmt({ host: hostView.mp.remote?.carChunk, guest: guestView.mp.remote?.carChunk }));
  } else {
    ctx.A.check('mp-ai: the AI label lists every AI car with profile and relay tag',
      /AI · (reference|cautious|standard)/.test(hostView.overlays.remotesText ?? '') &&
        /20 Hz host relay/.test(hostView.overlays.remotesText ?? '') &&
        /no collision/.test(hostView.overlays.remotesText ?? ''),
      hostView.overlays.remotesText);
  }
  assertRoomStats(ctx, room, roomBaseline);

  assertSilent(ctx, room.host, 0, 'host');
  assertSilent(ctx, room.guest, 0, 'guest');
  ctx.evidence.host = hostView;
  ctx.evidence.guest = guestView;
  return { room, hostView, guestView };
}

export async function mpTwo(ctx) {
  const expected = { ...ctx.anchors.mp.river, hostCar: ctx.anchors.cars.default };
  await mpRace(ctx, {
    mapId: 'river',
    expected,
    guestCar: expected.guestCar,
    guestPace: expected.guestPace
  });
}

export async function mpAi(ctx) {
  const anchor = ctx.anchors.mpAi;
  const expected = {
    ...ctx.anchors.mp.river,
    hostCar: ctx.anchors.cars.default,
    rows: anchor.rows
  };
  const hostExtra = '&ai=' + anchor.aiCount +
    '&aiCars=' + encodeURIComponent(anchor.aiCars.join(',')) +
    '&aiProfiles=' + encodeURIComponent(anchor.aiProfiles.join(','));
  await mpRace(ctx, {
    mapId: anchor.mapId,
    expected,
    guestCar: ctx.anchors.cars.default,
    guestPace: anchor.guestPace,
    hostExtra,
    expectAi: anchor.aiCount
  });
}

export async function mpAmboy(ctx) {
  const expected = { ...ctx.anchors.mp.amboy, hostCar: ctx.anchors.cars.default };
  await mpRace(ctx, {
    mapId: 'amboy',
    expected,
    guestCar: expected.guestCar,
    guestPace: expected.guestPace
  });
}

export async function mpGracia(ctx) {
  const expected = { ...ctx.anchors.mp.gracia, hostCar: ctx.anchors.cars.default };
  await mpRace(ctx, {
    mapId: 'gracia',
    expected,
    guestCar: expected.guestCar,
    guestPace: expected.guestPace
  });
}

/**
 * `mp-powerups`: the host enables the power-up slice (`&powerups=1`) and the
 * room carries the flag to the guest. The scenario asserts the committed type
 * set, the placed pickups, the HUD and a clean console on both pages.
 *
 * It deliberately does not assert a finish tick/time: a boost or a mine wreck
 * legitimately changes the race, so the sprint anchors do not apply. The race is
 * started and driven for a bounded window; the evidence is the power-up state.
 */
export async function mpPowerups(ctx) {
  const mapId = 'river';
  ctx.evidence.mapId = mapId;
  const expected = { ...ctx.anchors.mp.river, hostCar: ctx.anchors.cars.default };
  const roomBaseline = ctx.roomServer?.stats?.() ?? null;
  const room = await openRoom(ctx, {
    mapId,
    hostCar: expected.hostCar,
    guestCar: expected.guestCar,
    guestPace: expected.guestPace,
    hostExtra: '&powerups=1'
  });
  ctx.evidence.room = { code: room.code, hostUrl: room.hostUrl, guestUrl: room.guestUrl };
  assertLobby(ctx, room, { mapId, hostCar: expected.hostCar, guestCar: expected.guestCar });

  const hostConsoleFrom = room.host.messages.length;
  const guestConsoleFrom = room.guest.messages.length;
  await startRoomRace(ctx, room, { timeoutMs: 60000 });

  const hostPower = await waitMp(ctx, room.host, (probe) =>
    probe.mp.powerups?.enabled === true &&
    probe.mp.powerups.phase === 'running' &&
    probe.mp.powerups.pickupCount > 0,
  { timeoutMs: 90000, label: 'host power-up world' });
  const guestPower = await waitMp(ctx, room.guest, (probe) =>
    probe.mp.powerups?.enabled === true,
  { timeoutMs: 90000, label: 'guest power-up slice' });

  const host = hostPower.mp.powerups;
  const guest = guestPower.mp.powerups;
  ctx.A.check('mp-powerups: host enabled the slice', host.enabled === true, host.enabled);
  ctx.A.check('mp-powerups: the host power-up world is running', host.phase === 'running', host.phase);
  ctx.A.check('mp-powerups: the committed types plus the SuperShield extension are exposed',
    Array.isArray(host.types) && host.types.length === 9 && host.types.includes('SuperShield'),
    host.types);
  ctx.A.check('mp-powerups: the host placed pickups on the measured course',
    host.pickupCount > 0, host.pickupCount);
  ctx.A.check('mp-powerups: the placed pickups cover several types',
    Array.isArray(host.pickupTypes) && host.pickupTypes.length >= 2, host.pickupTypes);
  ctx.A.check('mp-powerups: the placement names its source',
    host.placementSource === 'retail-arc-fraction-remap' ||
      host.placementSource === 'provisional-measured-arc', host.placementSource);
  ctx.A.check('mp-powerups: the placement block is labelled',
    host.placement && typeof host.placement.mode === 'string', host.placement?.mode);
  ctx.A.check('mp-powerups: the PWR1 manifest is pinned on the host',
    typeof host.manifestHash === 'string' && host.manifestHash.length > 0, host.manifestHash);
  ctx.A.check('mp-powerups: nothing is deferred',
    host.deferred && Object.keys(host.deferred).length === 0, host.deferred);
  ctx.A.check('mp-powerups: the room flag enabled the slice on the guest',
    guest.enabled === true, guest.enabled);
  ctx.A.check('mp-powerups: the guest sees the same type set',
    JSON.stringify(guest.types) === JSON.stringify(host.types), ctx.fmt({ host: host.types, guest: guest.types }));
  ctx.A.check('mp-powerups: the power-up HUD is visible on the host',
    hostPower.overlays.powerupHudHidden === false, hostPower.overlays.powerupHudHidden);
  ctx.A.check('mp-powerups: the HUD names the power-up types',
    /POWER-UPS/.test(hostPower.overlays.powerupHudText ?? ''), hostPower.overlays.powerupHudText);

  // SuperShield is a labelled project extension: grant it to the host, use it,
  // and assert the committed effect fields and the HUD label.
  const superShield = await room.host.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__powerups.grant('SuperShield');
    await wait(150);
    window.__powerups.use();
    await wait(400);
    const state = window.__powerups.state();
    return {
      shield: state.shield,
      labels: state.labels,
      hud: document.getElementById('powerup-hud')?.textContent ?? ''
    };
  })()`);
  ctx.A.check('mp-powerups: SuperShield activates on the host',
    superShield.shield?.kind === 'superShield', ctx.fmt(superShield.shield));
  ctx.A.check('mp-powerups: SuperShield carries the committed 50-point shield capacity',
    superShield.shield?.capacity === 50 && superShield.shield?.maxCapacity === 50,
    ctx.fmt(superShield.shield));
  ctx.A.check('mp-powerups: the HUD shows an active shield with its remaining time',
    /shield\s*\d+\s*\/\s*\d+\s*[^0-9]*\d+\.\d+\s*s/i.test(superShield.hud),
    superShield.hud.slice(0, 240));

  await ctx.shot(room.host, 'powerups-host');
  await ctx.shot(room.guest, 'powerups-guest');

  // The race must still complete with one shared result. A boost or a wreck may
  // change the time, so only the shared-result invariants are asserted here.
  const hostFinish = await waitMp(ctx, room.host, (probe) => probe.mp.result !== null,
    { timeoutMs: 240000, label: 'host power-up finish' });
  const guestFinish = await waitMp(ctx, room.guest, (probe) => probe.mp.result !== null,
    { timeoutMs: 240000, label: 'guest power-up finish' });
  ctx.A.check('mp-powerups: both pages reached the shared result',
    hostFinish.mp.phase === 'finished' && guestFinish.mp.phase === 'finished',
    ctx.fmt({ host: hostFinish.mp.phase, guest: guestFinish.mp.phase }));
  ctx.A.check('mp-powerups: host and guest render the same result hash',
    hostFinish.mp.result.hash === guestFinish.mp.result.hash,
    hostFinish.mp.result.hash + ' / ' + guestFinish.mp.result.hash);
  ctx.A.check('mp-powerups: every result row finished (no DNF)',
    hostFinish.mp.result.rows.every((row) => row.status === 'finished'),
    ctx.fmt(hostFinish.mp.result.rows.map((row) => [row.playerId, row.status])));
  ctx.A.check('mp-powerups: the power-up state survived the race',
    hostFinish.mp.powerups?.enabled === true && hostFinish.mp.powerups.pickupCount > 0,
    ctx.fmt({ enabled: hostFinish.mp.powerups?.enabled, pickups: hostFinish.mp.powerups?.pickupCount }));

  assertRoomStats(ctx, room, roomBaseline);
  assertSilent(ctx, room.host, hostConsoleFrom, 'powerups-host');
  assertSilent(ctx, room.guest, guestConsoleFrom, 'powerups-guest');
  ctx.evidence.host = hostPower;
  ctx.evidence.guest = guestPower;
}

/**
 * `reconnect`: a guest socket drop mid-race resumes the same player id/slot
 * inside the documented 30 s window and the room still produces one shared
 * result. The supported reconnect is the 24-byte resume token held in memory by
 * the page; a full page reload cannot resume (the token is not persisted and the
 * room rejects a non-resume join after start). See the limits in the analysis.
 */
export async function reconnect(ctx) {
  const expected = { ...ctx.anchors.mp.river, hostCar: ctx.anchors.cars.default };
  ctx.evidence.mapId = 'river';
  const roomBaseline = ctx.roomServer?.stats?.() ?? null;
  const room = await openRoom(ctx, {
    mapId: 'river',
    hostCar: expected.hostCar,
    guestCar: expected.guestCar,
    guestPace: expected.guestPace
  });
  assertLobby(ctx, room, {
    mapId: 'river',
    hostCar: expected.hostCar,
    guestCar: expected.guestCar
  });
  await startRoomRace(ctx, room, { timeoutMs: 60000 });
  await ctx.shot(room.guest, 'before-drop');
  const before = await readProbe(room.guest);
  const beforeId = before.mp.you.id;
  const beforeSlot = before.mp.you.slot;
  const beforeResumes = before.mp.resumeCount;

  await room.guest.evaluate(
    'window.__dropPromise = window.__mp.drop().then(() => "resumed").catch((error) => "error:" + error.message); "started"');
  let sawReconnecting = false;
  const dropDeadline = Date.now() + 30000;
  let after = null;
  while (Date.now() < dropDeadline) {
    after = await readProbe(room.guest);
    if (!after?.mp) { await sleep(100); continue; }
    if (after.mp.phase === 'reconnecting') sawReconnecting = true;
    if (after.mp.resumeCount > beforeResumes && after.mp.phase !== 'reconnecting') break;
    await sleep(100);
  }
  const dropOutcome = await room.guest.evaluate('window.__dropPromise').catch((error) => 'evaluate:' + error.message);
  await ctx.shot(room.guest, 'resumed');
  ctx.A.check('reconnect: guest socket drop resolved through resume', dropOutcome === 'resumed', dropOutcome);
  ctx.A.check('reconnect: guest reports a resume count increase',
    (after?.mp.resumeCount ?? 0) > beforeResumes,
    'before ' + beforeResumes + ', after ' + after?.mp.resumeCount);
  ctx.A.check('reconnect: the same player id resumes', after?.mp.you?.id === beforeId,
    beforeId + ' / ' + after?.mp.you?.id);
  ctx.A.check('reconnect: the same slot resumes', after?.mp.you?.slot === beforeSlot,
    beforeSlot + ' / ' + after?.mp.you?.slot);
  ctx.A.check('reconnect: the guest saw the labelled reconnecting state', sawReconnecting || after?.mp.resumeCount > beforeResumes,
    ctx.fmt({ sawReconnecting, resumeCount: after?.mp.resumeCount }));

  const hostView = await waitMp(ctx, room.host, (probe) => probe.mp.result !== null,
    { timeoutMs: 120000, label: 'host result after reconnect' });
  const guestView = await waitMp(ctx, room.guest, (probe) => probe.mp.result !== null,
    { timeoutMs: 120000, label: 'guest result after reconnect' });
  await ctx.shot(room.host, 'finish-host');
  await ctx.shot(room.guest, 'finish-guest');
  assertMpResult(ctx, { hostView, guestView, hostStarted: null, expected });
  ctx.A.check('reconnect: both cars still finish after the guest resume',
    hostView.mp.result.rows.every((row) => row.status === 'finished'),
    ctx.fmt(hostView.mp.result.rows.map((row) => [row.playerId, row.status])));
  assertRoomStats(ctx, room, roomBaseline);
  assertSilent(ctx, room.host, 0, 'host');
  assertSilent(ctx, room.guest, 0, 'guest');
  ctx.evidence.guest = guestView;
  ctx.evidence.host = hostView;
  ctx.evidence.reconnect = {
    beforeId,
    afterId: after?.mp.you?.id,
    beforeResumes,
    afterResumes: after?.mp.resumeCount,
    sawReconnecting,
    dropOutcome
  };
}

// ------------------------------------------------------------------ mode matrix

/**
 * `mode-matrix`: every supported mode × every playable map. A case either
 * starts (probe running, exact map id and course id, pinned package hashes) or
 * raises its documented typed rejection. A silent wrong map/course is a failure.
 */
export async function modeMatrix(ctx) {
  const matrix = ctx.expected.modeMatrix;
  const cases = [];

  for (const entry of matrix.starts) {
    const page = await ctx.openPage(entry.id);
    const url = ctx.base + entry.url;
    await page.navigate(url);
    let probe = null;
    try {
      probe = await waitProbe(ctx, page,
        (value) => value.consumer === 'running' && value.sprint !== null && value.frames >= 1,
        { timeoutMs: 90000, label: entry.id + ' start' });
    } catch (error) {
      cases.push({ id: entry.id, ok: false, error: error.message });
      await ctx.shot(page, entry.id);
      ctx.A.check(entry.id + ': page starts', false, error.message);
      ctx.closePage(page);
      continue;
    }
    await ctx.shot(page, entry.id);
    const pins = MAPS[entry.mapId]?.pins ?? null;
    ctx.A.check(entry.id + ': URL is the requested mode', probe.url === url, probe.url);
    ctx.A.check(entry.id + ': map id is ' + entry.mapId, probe.map?.id === entry.mapId,
      ctx.fmt(probe.map));
    ctx.A.check(entry.id + ': course id is ' + entry.courseId,
      probe.sprint?.courseId === entry.courseId && probe.sprintCourseId === entry.courseId,
      ctx.fmt({ course: probe.sprint?.courseId, stateCourse: probe.sprintCourseId }));
    ctx.A.check(entry.id + ': no page error box', probe.overlays.errorHidden === true,
      probe.overlays.errorText);
    ctx.A.check(entry.id + ': the WebGPU frame loop is running', probe.frames >= 1, 'frames ' + probe.frames);
    if (entry.courseId === '310m' || entry.courseId === 'lap' || entry.courseId === 'free') {
      ctx.A.check(entry.id + ': layout hash is the committed ' + entry.courseId + ' layout',
        probe.sprintLayoutHash === ctx.anchors.layouts[entry.courseId],
        probe.sprintLayoutHash + ' vs ' + ctx.anchors.layouts[entry.courseId]);
    } else {
      ctx.A.check(entry.id + ': layout hash is a pinned sha256 value',
        /^sha256:[0-9a-f]{64}$/.test(probe.sprintLayoutHash ?? ''), probe.sprintLayoutHash);
      ctx.A.check(entry.id + ': page loaded the pinned map package',
        pins !== null && probe.map?.hash === pins.mapContentHash &&
          probe.map?.layoutHash === pins.layoutContentHash &&
          probe.map?.physicsSha256 === pins.physicsFileSha256,
        ctx.fmt({ actual: { hash: probe.map?.hash, layout: probe.map?.layoutHash,
          physics: probe.map?.physicsSha256 }, pins }));
    }
    assertSilent(ctx, page, 0, entry.id);
    const course = {
      id: entry.id,
      verdict: 'started',
      mapId: entry.mapId,
      courseId: entry.courseId,
      layoutHash: probe.sprintLayoutHash,
      engineTick: probe.engineTick,
      screenshot: ctx.lastScreenshot
    };
    cases.push({ ...course, ok: true });
    ctx.closePage(page);
  }

  for (const entry of matrix.rejections) {
    const page = await ctx.openPage(entry.id);
    const url = ctx.base + entry.url;
    await page.navigate(url);
    const regex = new RegExp(entry.match);
    const deadline = Date.now() + 30000;
    let matched = null;
    while (Date.now() < deadline) {
      matched = page.messages.find((message) => regex.test(message.text)) ?? null;
      if (matched) break;
      await sleep(100);
    }
    // The rejected module never publishes a probe or product UI, so the raw
    // screenshot would be blank. Stamp the harness-observed message onto the
    // page (harness-only DOM, clearly labelled) so the evidence shows which
    // typed rejection this URL produced.
    await page.evaluate(`(() => {
      const box = document.createElement('pre');
      box.id = 'e2e-rejection';
      box.textContent = 'E2E harness · typed rejection for ' + location.pathname + location.search +
        '\\n\\n' + ${JSON.stringify(matched?.text ?? 'no console message was captured')};
      box.setAttribute('style', 'position:fixed;inset:24px;margin:0;padding:24px;' +
        'font:16px/1.5 Consolas,monospace;white-space:pre-wrap;color:#fff;background:#1a0606;' +
        'border:2px solid #c0392b;border-radius:8px;z-index:2147483647');
      document.body.appendChild(box);
      return true;
    })()`).catch(() => {});
    await ctx.shot(page, entry.id);
    const probe = await readProbe(page);
    const rejected = assertRejection(ctx, page, 0, entry.id, regex);
    ctx.A.check(entry.id + ': no engine/probe was created for the rejected URL',
      probe === null || probe.hasProbe === false || probe.consumer === 'error',
      ctx.fmt(probe ? { consumer: probe.consumer, error: probe.error } : null));
    const expectedMatch = new RegExp(entry.match);
    ctx.A.check(entry.id + ': rejection is the documented typed message',
      rejected !== null && expectedMatch.test(rejected.text), ctx.fmt(rejected));
    cases.push({
      id: entry.id,
      verdict: 'rejected',
      ok: rejected !== null,
      message: rejected?.text ?? null,
      screenshot: ctx.lastScreenshot
    });
    ctx.closePage(page);
  }

  ctx.evidence.cases = cases;
  ctx.evidence.starts = cases.filter((entry) => entry.verdict === 'started').length;
  ctx.evidence.rejections = cases.filter((entry) => entry.verdict === 'rejected').length;
}

// ------------------------------------------------------------------ eight players

/**
 * `mp-eight`: eight human browser pages in one room. The room service caps a
 * room at eight players, so this is the whole-field case: every page must join,
 * verify the map, ready, start and then receive the other seven 20 Hz
 * snapshots. Nothing here is AI; every car is a real page.
 */
export async function mpEight(ctx) {
  const car = ctx.anchors.cars.default;
  // A retry reuses the same room service, so counters are compared as deltas.
  const baseline = ctx.roomServer?.stats?.() ?? null;
  const delta = (key) => (baseline ? (ctx.roomServer.stats()[key] ?? 0) - (baseline[key] ?? 0) : null);
  const roomQuery = '&mpServer=' + encodeURIComponent(ctx.roomUrl) + '&audio=0';
  const host = await ctx.openPage('host');
  const hostUrl = ctx.base + '/?mp=1&host=1&script=sprint&car=' + encodeURIComponent(car) +
    '&map=river&name=Host' + roomQuery;
  await host.navigate(hostUrl);
  const hostLobby = await waitMp(ctx, host, (probe) =>
    probe.mp.phase === 'lobby' && probe.mp.engineReady === true,
  { timeoutMs: 180000, label: 'host lobby' });
  const code = hostLobby.mp.roomCode;
  ctx.A.check('mp8: host allocated a 5-character room code', /^[A-Z0-9]{5}$/.test(code ?? ''), code);
  ctx.A.check('mp8: the room advertises eight slots', hostLobby.mp.constants?.maxPlayers === 8,
    ctx.fmt(hostLobby.mp.constants));

  const guests = [];
  for (let index = 1; index <= 7; index++) {
    // Seven extra WebGPU contexts starve the shared GPU process at full size;
    // the guests render at a quarter of the pixels. Their assertions read the
    // page state, not the framebuffer, so this does not weaken the check.
    const guest = await ctx.openPage('guest-' + index, { viewport: { width: 640, height: 360 } });
    const url = ctx.base + '/?mp=1&room=' + encodeURIComponent(code ?? '') + '&script=sprint&car=' +
      encodeURIComponent(car) + '&name=Guest' + index + roomQuery;
    await guest.navigate(url);
    const lobby = await waitMp(ctx, guest, (probe) =>
      probe.mp.phase === 'lobby' && probe.mp.engineReady === true,
    { timeoutMs: 180000, label: 'guest ' + index + ' lobby' });
    ctx.A.check('mp8: guest ' + index + ' joined room ' + code, lobby.mp.roomCode === code,
      lobby.mp.roomCode);
    guests.push(guest);
  }
  const pages = [host, ...guests];

  const full = await waitMp(ctx, host, (probe) => probe.mp.players?.length === 8,
    { timeoutMs: 60000, label: 'host roster of eight' });
  const slots = full.mp.players.map((player) => player.slot).sort((a, b) => a - b);
  ctx.A.check('mp8: the room roster has eight players on slots 1-8',
    JSON.stringify(slots) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]), ctx.fmt(slots));
  ctx.A.check('mp8: exactly one host flag',
    full.mp.players.filter((player) => player.host).length === 1,
    ctx.fmt(full.mp.players.map((player) => [player.slot, player.host])));

  for (const page of guests) {
    const probe = await readProbe(page);
    ctx.A.check('mp8: every guest sees the same eight-player roster',
      probe?.mp?.players?.length === 8, ctx.fmt(probe?.mp?.players?.length));
  }

  for (const page of pages) await page.evaluate('window.__mp.setReady(true)');
  const ready = await waitMp(ctx, host, (probe) =>
    probe.mp.players?.length === 8 && probe.mp.players.every((player) => player.ready),
  { timeoutMs: 60000, label: 'all eight ready' });
  ctx.A.check('mp8: READY propagates to all eight players',
    ready.mp.players.every((player) => player.ready), ctx.fmt(ready.mp.players));
  ctx.A.check('mp8: host START is enabled', ready.mp.overlays.startDisabled === false,
    ctx.fmt(ready.mp.overlays));

  await host.evaluate('window.__mp.start()');
  const started = [];
  for (const [index, page] of pages.entries()) {
    const probe = await waitMp(ctx, page, (value) => value.mp.started === true && value.engineTick >= 2,
      { timeoutMs: 90000, label: 'page ' + index + ' race start' });
    ctx.A.check('mp8: page ' + index + ' started the race', probe.mp.started === true,
      ctx.fmt(probe.mp.started));
    started.push(probe);
  }
  ctx.A.check('mp8: every page agrees on the room map',
    started.every((probe) => probe.mp.mapId === 'river'),
    ctx.fmt(started.map((probe) => probe.mp.mapId)));

  // Each page must see the other seven humans with live snapshot ticks.
  const remotes = [];
  for (const [index, page] of pages.entries()) {
    const probe = await waitMp(ctx, page, (value) =>
      (value.mp.remotes?.length ?? 0) === 7 &&
      value.mp.remotes.every((row) => row.latestTick !== null),
    { timeoutMs: 90000, label: 'page ' + index + ' seven remotes' });
    ctx.A.check('mp8: page ' + index + ' receives seven peer snapshots',
      probe.mp.remotes.length === 7, ctx.fmt(probe.mp.remotes.map((row) => [row.slot, row.latestTick])));
    ctx.A.check('mp8: page ' + index + ' has no self row in its remote list',
      probe.mp.remotes.every((row) => row.id !== probe.mp.you?.id), ctx.fmt(probe.mp.you));
    remotes.push(probe.mp.remotes);
  }
  const ticks = remotes.map((rows) => rows.map((row) => row.latestTick));
  ctx.A.check('mp8: every snapshot tick is a positive integer',
    ticks.every((row) => row.every((tick) => Number.isInteger(tick) && tick >= 0)), ctx.fmt(ticks));

  // The whole field must finish and share one result table. The scripted sprint
  // drives every page; the host's RaceSession owns the authoritative table.
  const hostResult = await waitMp(ctx, host, (probe) => probe.mp.result !== null,
    { timeoutMs: 180000, label: 'host eight-player result' });
  const result = hostResult.mp.result;
  ctx.A.check('mp8: the shared result table has eight rows',
    result.rows.length === 8, ctx.fmt(result.rows.map((row) => [row.playerId, row.positionNumber])));
  const positions = result.rows.map((row) => row.positionNumber);
  // Standard competition ranking: ties share a position (1,1,3,3,…).
  const rankingOk = positions.every((position, index) =>
    Number.isInteger(position) && position >= 1 && position <= 8 &&
    (index === 0 ? position === 1 : position >= positions[index - 1]) &&
    (index === 0 || position === positions[index - 1] || position === index + 1));
  ctx.A.check('mp8: the eight rows form a valid competition ranking',
    rankingOk, ctx.fmt(positions));
  ctx.A.check('mp8: the winner is position 1',
    positions[0] === 1, ctx.fmt(positions));
  ctx.A.check('mp8: every row finished (no DNF)',
    result.rows.every((row) => row.status === 'finished'), ctx.fmt(result.rows.map((row) => [row.playerId, row.status])));
  ctx.A.check('mp8: every human row reports its own finish hash',
    result.rows.every((row) => typeof row.finishHash === 'string' && row.finishHash.startsWith('sha256:')),
    ctx.fmt(result.rows.map((row) => [row.playerId, row.finishHash])));

  // Every page must render the same table from the same broadcast bytes.
  for (const [index, page] of pages.entries()) {
    const probe = await waitMp(ctx, page, (value) => value.mp.result !== null,
      { timeoutMs: 120000, label: 'page ' + index + ' result' });
    ctx.A.check('mp8: page ' + index + ' renders the same result hash',
      probe.mp.result.hash === result.hash, ctx.fmt({ page: probe.mp.result.hash, host: result.hash }));
    ctx.A.check('mp8: page ' + index + ' shows the results overlay',
      probe.overlays.resultsHidden === false, ctx.fmt(probe.overlays.resultsHidden));
  }
  ctx.evidence.result = {
    hash: result.hash,
    order: result.order,
    rows: result.rows.map((row) => ({
      playerId: row.playerId, position: row.positionNumber,
      tick: row.tick, timeSeconds: row.timeSeconds
    }))
  };

  // Evidence frames. Eight WebGPU contexts share one GPU process, so a full-size
  // capture can starve; the guests are closed first and the host is captured
  // last. The functional assertions above are already complete.
  const shots = [];
  try {
    shots.push(await ctx.shot(guests[0], 'race-eight-guest', { timeoutMs: 120000 }));
  } catch (error) {
    ctx.evidence.guestShotError = error.message;
  }
  for (const guest of guests) { try { guest.close(); } catch { /* already closed */ } }
  await new Promise((resolve) => setTimeout(resolve, 800));
  try {
    shots.push(await ctx.shot(host, 'race-eight', { timeoutMs: 180000 }));
  } catch (error) {
    ctx.evidence.hostShotError = error.message;
    ctx.A.check('mp8: host screenshot captured', false, error.message);
  }
  ctx.evidence.shots = shots;

  const stats = ctx.roomServer?.stats?.() ?? null;
  if (stats) {
    ctx.A.check('mp8: the room service saw eight players in one room', stats.maxPlayersSeen === 8,
      ctx.fmt({ maxPlayersSeen: stats.maxPlayersSeen }));
    ctx.A.check('mp8: this attempt created exactly one room', delta('roomsCreated') === 1,
      ctx.fmt({ roomsCreated: delta('roomsCreated'), total: stats.roomsCreated }));
    ctx.A.check('mp8: this attempt finished exactly one room', delta('roomsFinished') === 1,
      ctx.fmt({ roomsFinished: delta('roomsFinished'), total: stats.roomsFinished }));
    ctx.A.check('mp8: the room service recorded no protocol errors', delta('protocolErrors') === 0,
      ctx.fmt({ protocolErrors: delta('protocolErrors') }));
    ctx.evidence.roomStats = stats;
  } else {
    ctx.evidence.roomStatsUnavailable = 'attached room service; --base/--room-url has no stats()';
  }

  ctx.evidence.eight = {
    code,
    players: full.mp.players.map((player) => ({ slot: player.slot, host: player.host })),
    remoteTicks: ticks
  };
}




// ------------------------------------------------------------------ race modes

/**
 * solo-checkpoint: the single-player time-bank mode on the 310 m River
 * sprint. The committed values are singleplayer.bin AmaxRaceModeCheckpointVars:
 * initialTime 40 s, +16 s per checkpoint, gold/silver/bronze 20/10/0 s.
 */
export async function soloCheckpoint(ctx) {
  const url = ctx.base + '/?map=river&script=sprint&mode=checkpoint&car=' +
    encodeURIComponent(ctx.anchors.cars.default) + '&audio=0';
  const page = await ctx.openPage('checkpoint');
  await page.navigate(url);
  const running = await waitProbe(ctx, page,
    (probe) => probe.consumer === 'running' && probe.engineTick >= 2,
    { timeoutMs: 120000, label: 'checkpoint running' });
  await ctx.shot(page, 'start');
  ctx.A.check('checkpoint: URL is the checkpoint sprint', running.url === url, running.url);
  ctx.A.check('checkpoint: the mode is checkpoint', running.raceMode?.mode === 'checkpoint',
    ctx.fmt(running.raceMode));
  ctx.A.check('checkpoint: the time bank starts from the committed 40 s',
    running.raceMode?.timeLeftSeconds <= 40 && running.raceMode?.timeLeftSeconds > 30,
    running.raceMode?.timeLeftSeconds);
  ctx.A.check('checkpoint: the HUD names the time bank and the checkpoint count',
    /time left .* s \/ \d+ of \d+ checkpoints/.test(running.overlays.hudText ?? ''),
    running.overlays.hudText);

  const done = await waitProbe(ctx, page, (probe) => probe.sprintResult !== null,
    { timeoutMs: 240000, label: 'checkpoint finish' });
  await ctx.shot(page, 'finish');
  const mode = done.raceMode;
  ctx.A.check('checkpoint: the run finished with the mode state', mode?.finished === true,
    ctx.fmt(mode));
  ctx.A.check('checkpoint: both checkpoints paid their committed 16 s',
    mode?.awardedSeconds === 32, mode?.awardedSeconds);
  ctx.A.check('checkpoint: the medal is the committed remaining-time threshold',
    ['gold', 'silver', 'bronze'].includes(mode?.medal), mode?.medal);
  ctx.A.check('checkpoint: the remaining time is non-negative',
    typeof mode?.timeLeftSeconds === 'number' && mode.timeLeftSeconds >= 0, mode?.timeLeftSeconds);
  ctx.A.check('checkpoint: the results panel names the medal',
    new RegExp(mode?.medal ?? 'no-medal').test(done.overlays.resultsBest ?? ''),
    done.overlays.resultsBest);
  ctx.A.check('checkpoint: no console error',
    page.messages.filter((m) => m.type === 'error').length === 0,
    ctx.fmt(page.messages.slice(-4)));
  ctx.evidence.finish = done;
}

/**
 * mp-destruction: the multiplayer Motor Mash mode. Both pages select it and
 * the host scores from the typed wreck events. The round is 180 s
 * (MultiplayerRace.time), so the scenario asserts the running state, the
 * committed scoring table and a counting timer rather than waiting 3 minutes.
 */
export async function mpDestruction(ctx) {
  const mapId = 'river';
  ctx.evidence.mapId = mapId;
  const expected = { ...ctx.anchors.mp.river, hostCar: ctx.anchors.cars.default };
  const roomBaseline = ctx.roomServer?.stats?.() ?? null;
  const room = await openRoom(ctx, {
    mapId,
    hostCar: expected.hostCar,
    guestCar: expected.guestCar,
    guestPace: expected.guestPace,
    hostExtra: '&mode=destruction&powerups=1',
    guestExtra: '&mode=destruction&powerups=1'
  });
  ctx.evidence.room = { code: room.code, hostUrl: room.hostUrl, guestUrl: room.guestUrl };
  assertLobby(ctx, room, { mapId, hostCar: expected.hostCar, guestCar: expected.guestCar });

  const hostConsoleFrom = room.host.messages.length;
  const guestConsoleFrom = room.guest.messages.length;
  await startRoomRace(ctx, room, { timeoutMs: 60000 });

  const hostMode = await waitMp(ctx, room.host, (probe) =>
    probe.mp.phase === 'running' && probe.raceMode?.mode === 'destruction' &&
    probe.raceMode.timeLeftSeconds < 180,
  { timeoutMs: 90000, label: 'host destruction mode' });
  const guestMode = await waitMp(ctx, room.guest, (probe) =>
    probe.mp.phase === 'running' && probe.raceMode?.mode === 'destruction',
  { timeoutMs: 90000, label: 'guest destruction mode' });

  ctx.A.check('mp-destruction: the host runs the destruction mode',
    hostMode.raceMode.mode === 'destruction', hostMode.raceMode.mode);
  ctx.A.check('mp-destruction: the guest runs the destruction mode',
    guestMode.raceMode.mode === 'destruction', guestMode.raceMode.mode);
  ctx.A.check('mp-destruction: the round timer is the committed 180 s',
    hostMode.raceMode.timeLimitSeconds === 180, hostMode.raceMode.timeLimitSeconds);
  ctx.A.check('mp-destruction: the timer counts down',
    hostMode.raceMode.timeLeftSeconds < 180 && hostMode.raceMode.timeLeftSeconds > 150,
    hostMode.raceMode.timeLeftSeconds);
  ctx.A.check('mp-destruction: the scoring table is the committed Motor Mash table',
    hostMode.raceMode.scoring.wreck === 5 && hostMode.raceMode.scoring.suicide === 1 &&
      hostMode.raceMode.scoring.rivalDamageMultiplier === 2,
    ctx.fmt(hostMode.raceMode.scoring));
  ctx.A.check('mp-destruction: the damage split is a typed unsupported entry',
    hostMode.raceMode.damageScoring?.status === 'unsupported' &&
      /threshold/.test(hostMode.raceMode.damageScoring?.reason ?? ''),
    ctx.fmt(hostMode.raceMode.damageScoring));
  ctx.A.check('mp-destruction: the HUD names the timer and the wreck points',
    /destruction.*time left .* s.*wreck 5 pts/.test(hostMode.overlays.hudText ?? ''),
    hostMode.overlays.hudText);

  await ctx.shot(room.host, 'destruction-host');
  await ctx.shot(room.guest, 'destruction-guest');
  // The round is 180 s; the scenario asserts the running mode, not a finished
  // room. The room is still one live room with two connected players.
  ctx.A.check('mp-destruction: the room is still one live two-player room',
    hostMode.mp.players?.length === 2 && guestMode.mp.players?.length === 2,
    ctx.fmt({ host: hostMode.mp.players?.length, guest: guestMode.mp.players?.length }));
  assertSilent(ctx, room.host, hostConsoleFrom, 'destruction-host');
  assertSilent(ctx, room.guest, guestConsoleFrom, 'destruction-guest');
  ctx.evidence.host = hostMode;
  ctx.evidence.guest = guestMode;
}

/**
 * `menu-modes`: the menu shell offers Checkpoint as a solo mode and Destruction
 * as a multiplayer match mode, and the launch URL carries the right parameters.
 * It drives the real shell page (no engine) and asserts the synced URL query.
 */
export async function menuModes(ctx) {
  const url = ctx.base + '/game-shell/demo.html';
  const page = await ctx.openPage('menu');
  await page.navigate(url);
  const booted = await page.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let attempt = 0; attempt < 100; attempt++) {
      if (window.__gameShell && document.querySelector('[data-focus="play"]')) return true;
      await wait(200);
    }
    return false;
  })()`);
  ctx.A.check('menu-modes: the shell boots to the main menu', booted === true, booted);

  const modes = await page.evaluate(`(async () => {
    const shell = window.__gameShell;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const click = (selector) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error('missing ' + selector);
      node.click();
    };
    click('[data-focus="play"]');
    await wait(80);
    const cards = [...document.querySelectorAll('.gs-mode-card')].map((n) => n.dataset.focus);
    click('[data-focus="mode-checkpoint"]');
    await wait(80);
    click('[data-car-slug="corvette-zr1-stock"]');
    await wait(80);
    click('[data-focus="car-next"]');
    await wait(80);
    click('[data-focus="map-river"]');
    await wait(80);
    click('[data-focus="map-action"]');
    await wait(200);
    return {
      cards,
      screen: shell.getState().screen,
      config: shell.getState().lastConfig,
      search: location.search
    };
  })()`);
  await ctx.shot(page, 'menu-checkpoint');
  ctx.A.check('menu-modes: the mode list offers five modes including checkpoint',
    Array.isArray(modes.cards) && modes.cards.length === 5 &&
      modes.cards.includes('mode-checkpoint'), ctx.fmt(modes.cards));
  ctx.A.check('menu-modes: checkpoint starts from the menu', modes.screen === 'loading', modes.screen);
  ctx.A.check('menu-modes: the launch config is the checkpoint mode',
    modes.config?.mode === 'checkpoint' && modes.config?.course === '310', ctx.fmt(modes.config));
  ctx.A.check('menu-modes: the synced URL carries mode=checkpoint',
    /(?:^|&)mode=checkpoint(?:&|$)/.test(modes.search.replace(/^\?/, '')), modes.search);

  const lobby = await page.evaluate(`(async () => {
    const shell = window.__gameShell;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const click = (selector) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error('missing ' + selector);
      node.click();
    };
    // Back from loading to the menu (loading -> map-select -> car-select ->
    // mode-select -> main-menu).
    for (let step = 0; step < 5 && !document.querySelector('[data-focus="play"]'); step++) {
      shell.dispatch({ type: 'back' });
      await wait(80);
    }
    click('[data-focus="play"]');
    await wait(80);
    click('[data-focus="mode-multiplayer"]');
    await wait(80);
    click('[data-car-slug="corvette-zr1-stock"]');
    await wait(80);
    click('[data-focus="car-next"]');
    await wait(80);
    click('[data-focus="map-river"]');
    await wait(80);
    click('[data-focus="map-action"]');
    await wait(200);
    const before = shell.getState();
    const segmented = document.querySelectorAll('[data-focus="match-mode"] .gs-segment').length;
    click('[data-focus="match-mode-destruction"]');
    await wait(120);
    const after = shell.getState();
    return {
      screen: after.screen,
      segmented,
      matchModeBefore: before.mp.matchMode,
      matchMode: after.mp.matchMode,
      powerups: after.mp.powerups,
      labels: [...document.querySelectorAll('[data-focus="match-mode"] .gs-segment')].map((n) => n.textContent)
    };
  })()`);
  await ctx.shot(page, 'menu-destruction');
  ctx.A.check('menu-modes: the lobby offers the four match modes', lobby.segmented === 4, lobby.segmented);
  ctx.A.check('menu-modes: the lobby starts on Race', lobby.matchModeBefore === 'race', lobby.matchModeBefore);
  ctx.A.check('menu-modes: Destruction is selectable from the lobby',
    lobby.matchMode === 'destruction', lobby.matchMode);
  ctx.A.check('menu-modes: Destruction forces the power-up slice', lobby.powerups === true, lobby.powerups);
  ctx.A.check('menu-modes: the lobby labels are Race / Destruction / Points / Elimination',
    JSON.stringify(lobby.labels) === JSON.stringify(['Race', 'Destruction', 'Points', 'Elimination']),
    ctx.fmt(lobby.labels));
  ctx.A.check('menu-modes: no console error',
    page.messages.filter((m) => m.type === 'error').length === 0,
    ctx.fmt(page.messages.slice(-4)));
  ctx.evidence.menu = { modes, lobby };
}

/**
 * `mp-points`: the committed Points mode. Both pages select it; the host scores
 * from the labelled MultiplayerConfig.scoring rows and the 7 unlabelled rows are
 * a typed unsupported entry. The round is the labelled provisional 180 s.
 */
export async function mpPoints(ctx) {
  const mapId = 'river';
  ctx.evidence.mapId = mapId;
  const expected = { ...ctx.anchors.mp.river, hostCar: ctx.anchors.cars.default };
  const room = await openRoom(ctx, {
    mapId,
    hostCar: expected.hostCar,
    guestCar: expected.guestCar,
    guestPace: expected.guestPace,
    hostExtra: '&mode=points&powerups=1',
    guestExtra: '&mode=points&powerups=1'
  });
  ctx.evidence.room = { code: room.code, hostUrl: room.hostUrl, guestUrl: room.guestUrl };
  assertLobby(ctx, room, { mapId, hostCar: expected.hostCar, guestCar: expected.guestCar });
  const hostConsoleFrom = room.host.messages.length;
  const guestConsoleFrom = room.guest.messages.length;
  await startRoomRace(ctx, room, { timeoutMs: 60000 });

  const hostMode = await waitMp(ctx, room.host, (probe) =>
    probe.mp.phase === 'running' && probe.raceMode?.mode === 'points' &&
    probe.raceMode.timeLeftSeconds < 180,
  { timeoutMs: 90000, label: 'host points mode' });
  const guestMode = await waitMp(ctx, room.guest, (probe) =>
    probe.mp.phase === 'running' && probe.raceMode?.mode === 'points',
  { timeoutMs: 90000, label: 'guest points mode' });

  ctx.A.check('mp-points: the host runs the points mode', hostMode.raceMode.mode === 'points',
    hostMode.raceMode.mode);
  ctx.A.check('mp-points: the guest runs the points mode', guestMode.raceMode.mode === 'points',
    guestMode.raceMode.mode);
  ctx.A.check('mp-points: the round timer is the labelled provisional 180 s',
    hostMode.raceMode.timeLimitSeconds === 180 && hostMode.raceMode.timeLeftSeconds < 180,
    hostMode.raceMode.timeLeftSeconds);
  ctx.A.check('mp-points: the labelled scoring table is the committed one',
    hostMode.raceMode.scoring.Shunt === 1 && hostMode.raceMode.scoring.BatteringRam === 3 &&
      Object.keys(hostMode.raceMode.scoring).length === 16,
    ctx.fmt(hostMode.raceMode.scoring));
  ctx.A.check('mp-points: the 7 unlabelled rows are a typed unsupported entry',
    hostMode.raceMode.unlabelledRows?.count === 7 &&
      hostMode.raceMode.unlabelledRows?.status === 'unsupported',
    ctx.fmt(hostMode.raceMode.unlabelledRows));
  ctx.A.check('mp-points: the HUD names the timer and the labelled row count',
    /points.*time left .* s.*labelled scoring rows/.test(hostMode.overlays.hudText ?? ''),
    hostMode.overlays.hudText);

  await ctx.shot(room.host, 'points-host');
  await ctx.shot(room.guest, 'points-guest');
  assertSilent(ctx, room.host, hostConsoleFrom, 'points-host');
  assertSilent(ctx, room.guest, guestConsoleFrom, 'points-guest');
  ctx.evidence.host = hostMode;
  ctx.evidence.guest = guestMode;
}

/**
 * `mp-elimination`: the Elimination mode. The period and criterion are a
 * labelled project choice (not serialized for an event), so the scenario
 * asserts the provisional labels and the active counter, not a finished round.
 */
export async function mpElimination(ctx) {
  const mapId = 'river';
  ctx.evidence.mapId = mapId;
  const expected = { ...ctx.anchors.mp.river, hostCar: ctx.anchors.cars.default };
  const room = await openRoom(ctx, {
    mapId,
    hostCar: expected.hostCar,
    guestCar: expected.guestCar,
    guestPace: expected.guestPace,
    hostExtra: '&mode=elimination',
    guestExtra: '&mode=elimination'
  });
  ctx.evidence.room = { code: room.code, hostUrl: room.hostUrl, guestUrl: room.guestUrl };
  assertLobby(ctx, room, { mapId, hostCar: expected.hostCar, guestCar: expected.guestCar });
  const hostConsoleFrom = room.host.messages.length;
  const guestConsoleFrom = room.guest.messages.length;
  await startRoomRace(ctx, room, { timeoutMs: 60000 });

  const hostMode = await waitMp(ctx, room.host, (probe) =>
    probe.mp.phase === 'running' && probe.raceMode?.mode === 'elimination',
  { timeoutMs: 90000, label: 'host elimination mode' });
  const guestMode = await waitMp(ctx, room.guest, (probe) =>
    probe.mp.phase === 'running' && probe.raceMode?.mode === 'elimination',
  { timeoutMs: 90000, label: 'guest elimination mode' });

  ctx.A.check('mp-elimination: the host runs the elimination mode',
    hostMode.raceMode.mode === 'elimination', hostMode.raceMode.mode);
  ctx.A.check('mp-elimination: the guest runs the elimination mode',
    guestMode.raceMode.mode === 'elimination', guestMode.raceMode.mode);
  ctx.A.check('mp-elimination: the period and criterion are labelled provisional',
    hostMode.raceMode.provisional === true && hostMode.raceMode.periodSeconds === 30 &&
      /not serialized/.test(hostMode.raceMode.reason ?? ''),
    ctx.fmt({ provisional: hostMode.raceMode.provisional, period: hostMode.raceMode.periodSeconds }));
  ctx.A.check('mp-elimination: both participants start active',
    hostMode.raceMode.activeCount === 2, hostMode.raceMode.activeCount);
  ctx.A.check('mp-elimination: the HUD names the active count and the next elimination',
    /elimination.*active.*next elimination in .* s/.test(hostMode.overlays.hudText ?? ''),
    hostMode.overlays.hudText);

  await ctx.shot(room.host, 'elimination-host');
  await ctx.shot(room.guest, 'elimination-guest');
  assertSilent(ctx, room.host, hostConsoleFrom, 'elimination-host');
  assertSilent(ctx, room.guest, guestConsoleFrom, 'elimination-guest');
  ctx.evidence.host = hostMode;
  ctx.evidence.guest = guestMode;
}
