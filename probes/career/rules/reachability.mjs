// Content-gated reachability for the recovered retail career.
//
// The career manifest is retail data. This module answers a narrower question:
// which of the 63 retail events can the browser build actually start today,
// and which can be reached through a legal star/rank/boss progression.
//
// Inputs:
//   career   - the object returned by loadCareer() or the raw manifest
//   content  - `_work/career/content.json` (probes/career/tools/build_content.py)
//
// It does not read the filesystem, the clock or an RNG.

import {
  createCareerSession, loadCareer, MEDAL, MEDAL_NAMES,
} from './career.mjs';

const DERIVED_DEMANDS = new Set([
  'SP_BossDemand_Tier_Finish_Events',
  'SP_BossDemand_Tier_Complete_FanRuns',
  'SP_BossDemand_Tier_Complete_FanPars',
  'SP_BossDemand_Tier_Get_Lights',
  'SP_BossDemand_Event_Get_All_Lights',
  'SP_BossDemand_Tier_Win_All_Events',
  'SP_BossDemand_Tier_Earn_Fans',
  'SP_BossDemand_Tier_Finish_In_Different_Car',
  'SP_BossDemand_Event_Time_Remaining',
]);

function asCareer(career) {
  return career && career.eventList ? career : loadCareer(career);
}

export function contentBlockers(career, content, event) {
  const hard = [];
  const degraded = [];
  const map = content.maps[event.route.level];
  if (!map) {
    hard.push({
      code: 'map-not-playable',
      level: event.route.level,
      route: event.route.name,
      reason: 'no proven course/package for this level in the browser build',
    });
  }
  const mode = content.modes[event.mode];
  if (!mode || mode.implemented !== true) {
    hard.push({
      code: 'mode-not-implemented',
      mode: event.mode,
      reason: mode?.reason ?? 'mode is absent from the content descriptor',
    });
  }
  if (map && event.laps > 0) {
    const lapCourses = (map.courses ?? []).filter((course) =>
      course.mode === 'lap' && (course.laps === null || course.laps === undefined || course.laps >= event.laps));
    if (lapCourses.length === 0) {
      hard.push({
        code: 'lap-course-missing',
        level: event.route.level,
        laps: event.laps,
        reason: 'the level has a point-to-point course only; no committed closed-loop course for this lap count',
      });
    }
  }
  if (event.carClass && event.carClass !== 'ANY') {
    const cars = (content.cars ?? []).filter((car) => car.class === event.carClass);
    if (cars.length === 0) {
      hard.push({
        code: 'car-class-unavailable',
        carClass: event.carClass,
        reason: 'no playable roster car of this class',
      });
    }
  }
  const maxOpponents = content.ai?.maxOpponents ?? 0;
  if (Number.isInteger(event.opponents?.count) && event.opponents.count > maxOpponents) {
    degraded.push({
      code: 'opponents-exceed-ai-cap',
      declared: event.opponents.count,
      available: maxOpponents,
      reason: 'the retail opponent grid is larger than the host-simulated AI cap; the event can only run with a reduced grid',
    });
  }
  if (event.kind === 'boss' && event.tierIndex >= 0) {
    const tier = career.tier(event.tierIndex);
    const boss = tier.boss;
    if (boss) {
      for (const demand of boss.demands) {
        if (DERIVED_DEMANDS.has(demand.kind)) continue;
        if (!(content.demands?.producible ?? []).includes(demand.unit)) {
          degraded.push({
            code: 'boss-demand-unit-unavailable',
            bossId: boss.id,
            kind: demand.kind,
            unit: demand.unit,
            target: demand.target,
            reason: 'the build emits no telemetry for this boss demand unit',
          });
        }
      }
    }
  }
  return { hard, degraded };
}

function syntheticResult(career, content, event) {
  const cars = (content.cars ?? []).filter((car) =>
    !event.carClass || event.carClass === 'ANY' || car.class === event.carClass);
  const car = cars.length ? cars[(event.tierIndex + event.indexInTier) % cars.length] : cars[0];
  const result = {
    fansEarned: event.fanPar,
    goldenFanDemandComplete: true,
    totalTimeSeconds: 60,
    difficulty: 'easy',
    carSlug: car?.slug ?? null,
    vehicleId: car?.recordId ?? null,
  };
  if (event.mode === 'street-race') result.position = 1;
  if (event.mode === 'destruction') {
    result.points = event.difficulty?.Easy?.thresholdsPoints?.gold ?? 0;
  }
  if (event.mode === 'checkpoint') {
    result.timeRemainingSeconds = event.difficulty?.Easy?.thresholdsSeconds?.goldRemaining ?? 0;
  }
  if (event.mode === 'boss-battle') result.bossDefeated = true;
  return result;
}

function satisfyDerivedDependencies(session, career, content) {
  let changed = false;
  const producible = new Set(content.demands?.producible ?? []);
  for (const tier of career.tiers) {
    const boss = tier.boss;
    if (!boss) continue;
    for (let index = 0; index < boss.demands.length; index += 1) {
      const demand = boss.demands[index];
      if (DERIVED_DEMANDS.has(demand.kind)) continue;
      if (!producible.has(demand.unit)) continue;
      if (session.demandValue(boss, index) < demand.target) {
        session.setBossDemand(boss.id, index, demand.target);
        changed = true;
      }
    }
  }
  return changed;
}

export function evaluateReachability(careerOrManifest, content, options = {}) {
  const career = asCareer(careerOrManifest);
  const includeEvents = options.includeEvents !== false;
  const statuses = new Map();
  for (const event of career.eventList) {
    const { hard, degraded } = contentBlockers(career, content, event);
    statuses.set(event.key, {
      key: event.key,
      tierIndex: event.tierIndex,
      indexInTier: event.indexInTier,
      kind: event.kind,
      mode: event.mode,
      level: event.route.level,
      laps: event.laps,
      carClass: event.carClass,
      fanPar: event.fanPar,
      opponents: event.opponents?.count ?? null,
      hardBlockers: hard,
      degradedBlockers: degraded,
      status: hard.length > 0 ? 'blocked' : degraded.length > 0 ? 'degraded' : 'full',
      progression: 'not-reached',
      completedState: null,
      stars: 0,
    });
  }

  // Legal-progression closure: complete every event whose map/mode/car/lap
  // content exists, in the retail unlock order, with a perfect result. External
  // boss demands are filled only when the content descriptor says the build
  // can produce that unit.
  const session = createCareerSession(career);
  const completed = new Set();
  let guard = 0;
  let progressed = true;
  while (progressed && guard < 256) {
    guard += 1;
    progressed = false;
    if (satisfyDerivedDependencies(session, career, content)) progressed = true;
    for (const event of career.eventList) {
      if (completed.has(event.key)) continue;
      const status = statuses.get(event.key);
      if (status.status === 'blocked') continue;
      if (!session.state.events[event.key].unlocked) continue;
      const result = session.completeEvent(event.key, syntheticResult(career, content, event));
      if (!result.accepted) continue;
      completed.add(event.key);
      status.completedState = result.stateAfter;
      status.stars = result.starsAfter;
      progressed = true;
    }
  }

  for (const event of career.eventList) {
    const status = statuses.get(event.key);
    if (completed.has(event.key)) {
      status.progression = 'completed';
    } else if (status.status === 'blocked') {
      status.progression = 'blocked';
    } else {
      status.progression = 'not-reached';
    }
  }

  const totals = {
    events: career.eventList.length,
    directFull: 0,
    directDegraded: 0,
    directBlocked: 0,
    completedFull: 0,
    completedDegraded: 0,
    completedTotal: 0,
    starsEarned: session.countStars(),
    maxStars: career.maxStars,
    rank: session.state.rank,
    totalFans: session.state.totalFans,
    vehiclesUnlocked: Object.values(session.state.vehicles).filter((v) => v.unlocked).length,
    maxVehicles: career.vehicleRewardIds().length,
  };
  for (const status of statuses.values()) {
    if (status.status === 'full') totals.directFull += 1;
    else if (status.status === 'degraded') totals.directDegraded += 1;
    else totals.directBlocked += 1;
    if (status.progression === 'completed') {
      totals.completedTotal += 1;
      if (status.status === 'full') totals.completedFull += 1;
      else totals.completedDegraded += 1;
    }
  }
  const pct = (value) => Math.round((value / totals.events) * 10000) / 100;
  totals.directPlayable = totals.directFull + totals.directDegraded;
  totals.directPlayablePercent = pct(totals.directPlayable);
  totals.progressionPercent = pct(totals.completedTotal);
  totals.strictProgressionPercent = pct(totals.completedFull);
  totals.starsPercent = Math.round((totals.starsEarned / totals.maxStars) * 10000) / 100;

  const tiers = career.tiers.map((tier) => {
    const events = tier.events.map((event) => statuses.get(event.key));
    return {
      index: tier.index,
      name: tier.name?.value ?? null,
      starRequirement: tier.starRequirement,
      unlocked: session.state.tiers[String(tier.id)].unlocked,
      stars: session.tierStars(tier.index),
      maxStars: tier.maxStars,
      directPlayable: events.filter((e) => e.status !== 'blocked').length,
      completed: events.filter((e) => e.progression === 'completed').length,
      blocked: events.filter((e) => e.status === 'blocked').length,
      boss: tier.boss ? {
        id: tier.boss.id,
        name: tier.boss.name?.value ?? null,
        unlocked: session.state.bosses[String(tier.boss.id)].unlocked,
        defeated: session.state.bosses[String(tier.boss.id)].defeated,
        demands: tier.boss.demands.map((demand, index) => ({
          index,
          kind: demand.kind,
          unit: demand.unit,
          target: demand.target,
          value: session.demandValue(tier.boss, index),
          derived: DERIVED_DEMANDS.has(demand.kind),
          producible: (content.demands?.producible ?? []).includes(demand.unit),
          complete: session.isDemandComplete(tier.boss, index),
        })),
      } : null,
    };
  });

  return {
    kind: 'blur.career.reachability',
    version: 1,
    contentKind: content.kind,
    contentVersion: content.version,
    totals,
    tiers,
    events: includeEvents ? [...statuses.values()] : undefined,
    sessionHash: session.hash(),
    state: options.includeState ? session.state : undefined,
  };
}

export { MEDAL, MEDAL_NAMES };
