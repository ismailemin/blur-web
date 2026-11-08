// Career rules for the Blur browser remake.
//
// Recovered from the shipped `gamedata/xt/singleplayer.bin` and the shipped
// upstream source (SP_Events/SP_Rewards/SP_Tiers/SP_Bosses/SP_Lua and the four
// race-mode SetupResults paths). The module is pure: it takes the career
// manifest as data and never reads the filesystem, the clock or an RNG.
//
// It implements:
//   * event availability (tier stars, 3-event unlock groups, boss demands)
//   * completion and medal assignment per mode
//   * star and fan-par accounting (bronze 3 / silver 4 / gold 5 + par + run,
//     boss gold 8)
//   * unlock propagation (rank vehicles, tiers, events, bosses, boss rewards)
//   * boss demand counters (derived and external)
//   * a minimal, versioned save state with an explicit `blur.profile.v1`
//     integration patch.
//
// The retail save/profile type is platform-bound; the browser build does not
// have a career section in `blur.profile.v1`. This module therefore keeps the
// career state in its own `blur.career.state` document and exposes
// `toProfilePatch()` / `applyProfile()` for the shell. It does not write
// storage and does not modify `probes/profile`.

import { canonicalJson, hashOf } from './hash.mjs';

export const CAREER_STATE_KIND = 'blur.career.state';
export const CAREER_STATE_VERSION = 1;

/** SP_EventState order: incomplete, bronze, silver, gold. */
export const MEDAL = Object.freeze({ INCOMPLETE: 0, BRONZE: 1, SILVER: 2, GOLD: 3 });
export const MEDAL_NAMES = Object.freeze(['incomplete', 'bronze', 'silver', 'gold']);
export const DIFFICULTY_NAMES = Object.freeze(['easy', 'medium', 'hard']);
const DIFFICULTY_RANK = Object.freeze({ easy: 0, medium: 1, hard: 2 });

const DIFFICULTY_FIELD = Object.freeze({ easy: 'Easy', medium: 'Medium', hard: 'Hard' });

const STANDARD_STARS = Object.freeze({ 0: 0, 1: 3, 2: 4, 3: 5 });
const BOSS_GOLD_STARS = 8;
const EVENT_GROUP_SIZE = 3;
const EVENT_GROUP_REQUIRED = 2;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const round6 = (value) => Math.round(value * 1e6) / 1e6;
const keyOf = (value) => String(value);

export class CareerError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'CareerError';
    this.code = code;
    this.detail = detail;
  }
}

function assert(condition, code, message, detail = null) {
  if (!condition) throw new CareerError(code, message, detail);
}

/** Find the highest rank whose fans threshold is <= `fans` (SP_FindRankByFans). */
export function findRankByFans(career, fans) {
  const ranks = career.ranks;
  for (let index = 1; index < ranks.length; index += 1) {
    if (fans < ranks[index].fans) return index - 1;
  }
  return ranks.length - 1;
}

export function difficultyRank(name) {
  const rank = DIFFICULTY_RANK[name];
  assert(rank !== undefined, 'invalid-difficulty', `unknown difficulty ${JSON.stringify(name)}`);
  return rank;
}

/** Normalise and validate the manifest once. */
export function loadCareer(manifest) {
  assert(manifest && typeof manifest === 'object', 'invalid-manifest', 'career manifest must be an object');
  assert(manifest.kind === 'blur.career-manifest', 'invalid-manifest', 'kind must be blur.career-manifest');
  assert(manifest.version === 1, 'invalid-manifest', 'unsupported manifest version');
  assert(Array.isArray(manifest.tiers) && manifest.tiers.length > 0, 'invalid-manifest', 'tiers[] is missing');
  assert(Array.isArray(manifest.ranks) && manifest.ranks.length > 1, 'invalid-manifest', 'ranks[] is missing');

  const events = [];
  const byKey = new Map();
  const byId = new Map();
  let maxStars = 0;
  let previousRequirement = -1;
  for (const tier of manifest.tiers) {
    assert(Number.isInteger(tier.index), 'invalid-manifest', 'tier.index must be an integer');
    assert(Number.isInteger(tier.starRequirement) && tier.starRequirement >= 0,
      'invalid-manifest', `tier ${tier.index} starRequirement`);
    assert(tier.starRequirement >= previousRequirement, 'invalid-manifest',
      `tier ${tier.index} starRequirement is not monotonic`);
    previousRequirement = tier.starRequirement;
    assert(Array.isArray(tier.events) && tier.events.length > 0, 'invalid-manifest',
      `tier ${tier.index} has no events`);
    let tierMax = 0;
    for (const event of tier.events) {
      assert(typeof event.key === 'string' && event.key.length > 0, 'invalid-manifest', 'event key');
      assert(!byKey.has(event.key), 'invalid-manifest', `duplicate event key ${event.key}`);
      assert(Number.isInteger(event.eventId), 'invalid-manifest', `${event.key} eventId`);
      assert(!byId.has(event.eventId), 'invalid-manifest', `duplicate event id ${event.eventId}`);
      assert(Number.isInteger(event.indexInTier), 'invalid-manifest', `${event.key} indexInTier`);
      assert(event.route && typeof event.route.level === 'string', 'invalid-manifest',
        `${event.key} route.level`);
      assert(isFiniteNumber(event.fanPar) && event.fanPar >= 0, 'invalid-manifest', `${event.key} fanPar`);
      assert(typeof event.mode === 'string', 'invalid-manifest', `${event.key} mode`);
      byKey.set(event.key, event);
      byId.set(event.eventId, event);
      events.push(event);
      tierMax += event.kind === 'boss' ? BOSS_GOLD_STARS : 7;
    }
    assert(tier.maxStars === tierMax, 'invalid-manifest',
      `tier ${tier.index} maxStars ${tier.maxStars} != recomputed ${tierMax}`);
    maxStars += tierMax;
  }
  assert(manifest.summary.maxStars === maxStars, 'invalid-manifest',
    `summary.maxStars ${manifest.summary.maxStars} != recomputed ${maxStars}`);

  let previousFans = -1;
  for (let index = 1; index < manifest.ranks.length; index += 1) {
    const rank = manifest.ranks[index];
    assert(isFiniteNumber(rank.fans) && rank.fans >= previousFans, 'invalid-manifest',
      `rank ${index} fans threshold is not monotonic`);
    previousFans = rank.fans;
  }

  return new Career(manifest, events, byKey, byId, maxStars);
}

export class Career {
  constructor(manifest, events, byKey, byId, maxStars) {
    this.manifest = manifest;
    this.eventList = events;
    this.eventsByKey = byKey;
    this.eventsById = byId;
    this.maxStars = maxStars;
    this.tiers = manifest.tiers;
    this.ranks = manifest.ranks;
    this.rules = manifest.rules;
  }

  event(key) {
    const event = this.eventsByKey.get(key);
    assert(event, 'unknown-event', `unknown career event ${JSON.stringify(key)}`);
    return event;
  }

  eventByAmaxId(id) {
    for (const event of this.eventList) if (event.amaxEventId === id) return event;
    return null;
  }

  tier(index) {
    const tier = this.tiers[index];
    assert(tier, 'unknown-tier', `unknown tier ${index}`);
    return tier;
  }

  tierOf(event) {
    return this.tiers[event.tierIndex];
  }

  /** Every reward vehicle id in the career (ranks + bosses). */
  vehicleRewardIds() {
    return this.manifest.summary.vehicleRewardIds.slice();
  }

  /** Tier star requirement list, in tier order. */
  starRequirements() {
    return this.tiers.map((tier) => tier.starRequirement);
  }
}

function freshEventState() {
  return {
    unlocked: false,
    state: MEDAL.INCOMPLETE,
    difficulty: 0,
    difficultyName: 'easy',
    bestFans: 0,
    bestPoints: 0,
    bestTimeSeconds: 0,
    fanRunComplete: false,
    lastVehicleId: null,
    completions: 0,
  };
}

/** A fresh `blur.career.state`. Caller normally uses `createCareerSession`. */
export function newCareerState(career) {
  const state = {
    kind: CAREER_STATE_KIND,
    version: CAREER_STATE_VERSION,
    revision: 0,
    totalFans: 0,
    totalFanEventFans: 0,
    rank: 0,
    lastVehicleId: null,
    stats: { races: 0, wins: 0 },
    selection: { carSlug: null, map: null, course: null, mode: null },
    tierCarsUsed: {},
    events: {},
    tiers: {},
    bosses: {},
    vehicles: {},
    mods: {},
  };
  for (const event of career.eventList) state.events[event.key] = freshEventState();
  for (const tier of career.tiers) {
    state.tiers[keyOf(tier.id)] = { unlocked: false, isNew: false };
    if (tier.boss) {
      state.bosses[keyOf(tier.boss.id)] = { unlocked: false, isNew: false, defeated: false, demandValues: {} };
      for (let index = 0; index < tier.boss.demands.length; index += 1) {
        state.bosses[keyOf(tier.boss.id)].demandValues[keyOf(index)] = 0;
      }
    }
  }
  for (const id of career.vehicleRewardIds()) {
    if (id === null || id === undefined) continue;
    state.vehicles[keyOf(id)] = { unlocked: false, isNew: false };
  }
  return state;
}

function emptyDiff() {
  return {
    changed: false,
    rankUps: [],
    tiers: [],
    events: [],
    bosses: [],
    bossDefeated: [],
    vehicles: [],
    mods: [],
  };
}

function markDiff(diff, kind, id) {
  diff.changed = true;
  diff[kind].push(id);
}

/**
 * One career save-game session. The state is a plain JSON object; every public
 * mutation returns the unlock diff and increments `revision`.
 */
export class CareerSession {
  constructor(career, state = null, options = {}) {
    this.career = career;
    this.state = state ? cloneState(career, state, options) : newCareerState(career);
    // Retail runs SP_ProcessUnlocks after load/create; do the same so tier 1
    // and rank 1 are available on a fresh save. The initial diff is discarded.
    this.processUnlocks({ silent: true });
  }

  static fresh(career) {
    return new CareerSession(career);
  }

  static fromJSON(career, text, options = {}) {
    const value = typeof text === 'string' ? JSON.parse(text) : text;
    return new CareerSession(career, value, { strict: options.strict !== false });
  }

  get revision() {
    return this.state.revision;
  }

  hash() {
    return hashOf(this.state);
  }

  serialize() {
    return canonicalJson(this.state);
  }

  // ------------------------------------------------------------------ medal
  /** Assign a medal exactly as the shipped race modes do. */
  assignMedal(key, result = {}) {
    const event = this.career.event(key);
    const difficulty = this.resolveDifficulty(event, result);
    if (event.mode === 'street-race') {
      const position = result.position;
      assert(Number.isInteger(position) && position >= 1, 'missing-result-field',
        `${key}: street-race needs an integer position`, { field: 'position' });
      if (position === 1) return { medal: MEDAL.GOLD, medalName: 'gold', mode: event.mode, difficulty };
      if (position === 2) return { medal: MEDAL.SILVER, medalName: 'silver', mode: event.mode, difficulty };
      if (position === 3) return { medal: MEDAL.BRONZE, medalName: 'bronze', mode: event.mode, difficulty };
      return { medal: MEDAL.INCOMPLETE, medalName: 'incomplete', mode: event.mode, difficulty };
    }
    if (event.mode === 'destruction') {
      const points = result.points;
      assert(isFiniteNumber(points) && points >= 0, 'missing-result-field',
        `${key}: destruction needs points`, { field: 'points' });
      const block = event.difficulty[DIFFICULTY_FIELD[difficulty.name]];
      assert(block && block.thresholdsPoints, 'invalid-manifest', `${key}: no destruction thresholds`);
      const thresholds = block.thresholdsPoints;
      if (points >= thresholds.gold) return { medal: MEDAL.GOLD, medalName: 'gold', mode: event.mode, difficulty, thresholds };
      if (points >= thresholds.silver) return { medal: MEDAL.SILVER, medalName: 'silver', mode: event.mode, difficulty, thresholds };
      if (points >= thresholds.bronze) return { medal: MEDAL.BRONZE, medalName: 'bronze', mode: event.mode, difficulty, thresholds };
      return { medal: MEDAL.INCOMPLETE, medalName: 'incomplete', mode: event.mode, difficulty, thresholds };
    }
    if (event.mode === 'checkpoint') {
      const remaining = result.timeRemainingSeconds;
      assert(isFiniteNumber(remaining), 'missing-result-field',
        `${key}: checkpoint needs timeRemainingSeconds`, { field: 'timeRemainingSeconds' });
      const block = event.difficulty[DIFFICULTY_FIELD[difficulty.name]];
      assert(block && block.thresholdsSeconds, 'invalid-manifest', `${key}: no checkpoint thresholds`);
      const thresholds = block.thresholdsSeconds;
      if (remaining >= thresholds.goldRemaining) return { medal: MEDAL.GOLD, medalName: 'gold', mode: event.mode, difficulty, thresholds };
      if (remaining >= thresholds.silverRemaining) return { medal: MEDAL.SILVER, medalName: 'silver', mode: event.mode, difficulty, thresholds };
      if (remaining >= 0) return { medal: MEDAL.BRONZE, medalName: 'bronze', mode: event.mode, difficulty, thresholds };
      return { medal: MEDAL.INCOMPLETE, medalName: 'incomplete', mode: event.mode, difficulty, thresholds };
    }
    if (event.mode === 'boss-battle') {
      assert(typeof result.bossDefeated === 'boolean', 'missing-result-field',
        `${key}: boss-battle needs bossDefeated`, { field: 'bossDefeated' });
      return {
        medal: result.bossDefeated ? MEDAL.GOLD : MEDAL.INCOMPLETE,
        medalName: result.bossDefeated ? 'gold' : 'incomplete',
        mode: event.mode,
        difficulty,
      };
    }
    throw new CareerError('unsupported-mode', `${key}: no medal rule for mode ${event.mode}`, { mode: event.mode });
  }

  resolveDifficulty(event, result = {}) {
    if (result.difficulty !== undefined) {
      difficultyRank(result.difficulty);
      return { name: result.difficulty, defaulted: false };
    }
    const saved = this.state.events[event.key].difficultyName;
    if (DIFFICULTY_NAMES.includes(saved)) return { name: saved, defaulted: false };
    return { name: 'easy', defaulted: true };
  }

  // ------------------------------------------------------------------- stars
  eventStars(key) {
    const event = this.career.event(key);
    const save = this.state.events[key];
    if (!save.unlocked) return 0;
    if (event.kind === 'boss') return save.state === MEDAL.GOLD ? BOSS_GOLD_STARS : 0;
    let stars = STANDARD_STARS[save.state] ?? 0;
    if (save.bestFans >= event.fanPar) stars += 1;
    if (save.fanRunComplete) stars += 1;
    return stars;
  }

  maxEventStars(key) {
    const event = this.career.event(key);
    return event.kind === 'boss' ? BOSS_GOLD_STARS : 7;
  }

  tierStars(tierIndex) {
    const tier = this.career.tier(tierIndex);
    if (!this.state.tiers[keyOf(tier.id)].unlocked) return 0;
    let stars = 0;
    for (const event of tier.events) stars += this.eventStars(event.key);
    return stars;
  }

  countStars() {
    let stars = 0;
    for (const tier of this.career.tiers) stars += this.tierStars(tier.index);
    return stars;
  }

  /** Stars of every tier before `tierIndex` (the value compared on unlock). */
  starsBeforeTier(tierIndex) {
    let stars = 0;
    for (const tier of this.career.tiers) {
      if (tier.index >= tierIndex) break;
      stars += this.tierStars(tier.index);
    }
    return stars;
  }

  countPrimaryStars() {
    let stars = 0;
    for (const event of this.career.eventList) {
      const value = this.eventStars(event.key);
      stars += event.kind === 'boss' ? Math.min(value, 8) : Math.min(value, 5);
    }
    return stars;
  }

  isEventComplete(key) {
    return this.state.events[key].state >= MEDAL.BRONZE;
  }

  // ------------------------------------------------------------- availability
  eventAvailability(key) {
    const event = this.career.event(key);
    const save = this.state.events[key];
    const tier = this.career.tier(event.tierIndex);
    const reasons = [];
    const tierStars = this.starsBeforeTier(tier.index);
    if (!tierStarsSatisfy(tier, tierStars, this.state)) {
      reasons.push({
        code: 'tier-locked',
        tierIndex: tier.index,
        starRequirement: tier.starRequirement,
        stars: tierStars,
        missing: Math.max(0, tier.starRequirement - tierStars),
      });
    }
    let completedBefore = 0;
    let eventsRequired = 0;
    if (event.kind !== 'boss') {
      eventsRequired = Math.floor(event.indexInTier / EVENT_GROUP_SIZE) * EVENT_GROUP_REQUIRED;
      for (const sibling of tier.events) {
        if (sibling.kind === 'boss') continue;
        if (sibling.indexInTier < event.indexInTier && this.isEventComplete(sibling.key)) completedBefore += 1;
      }
      if (completedBefore < eventsRequired) {
        reasons.push({
          code: 'events-required',
          required: eventsRequired,
          completed: completedBefore,
          missing: eventsRequired - completedBefore,
        });
      }
    } else if (tier.boss) {
      const demandState = this.state.bosses[keyOf(tier.boss.id)];
      const incomplete = tier.boss.demands.map((demand, index) => {
        const value = this.demandValue(tier.boss, index);
        return { index, kind: demand.kind, unit: demand.unit, target: demand.target, value,
          complete: value >= demand.target };
      }).filter((entry) => !entry.complete);
      if (incomplete.length > 0) {
        reasons.push({ code: 'boss-demands-incomplete', bossId: tier.boss.id, incomplete });
      }
      if (!demandState.unlocked) reasons.push({ code: 'boss-locked', bossId: tier.boss.id });
    }
    return {
      key,
      kind: event.kind,
      tierIndex: tier.index,
      indexInTier: event.indexInTier,
      unlocked: save.unlocked,
      available: save.unlocked,
      state: MEDAL_NAMES[save.state],
      tierUnlocked: this.state.tiers[keyOf(tier.id)].unlocked,
      tierStarsBefore: tierStars,
      tierStarRequirement: tier.starRequirement,
      eventsRequired,
      completedBefore,
      reasons,
    };
  }

  // -------------------------------------------------------------- boss demand
  demandValue(boss, index) {
    const save = this.state.bosses[keyOf(boss.id)];
    const value = save.demandValues[keyOf(index)];
    return isFiniteNumber(value) ? value : 0;
  }

  isDemandComplete(boss, index) {
    return this.demandValue(boss, index) >= boss.demands[index].target;
  }

  _setDemand(boss, index, value) {
    const demand = boss.demands[index];
    const save = this.state.bosses[keyOf(boss.id)];
    const isFloat = demand.kind === 'SP_BossDemand_Tier_Drift' ||
      demand.kind === 'SP_BossDemand_Tier_Air_Time';
    let next = isFloat ? value : Math.trunc(value);
    if (!isFiniteNumber(next) || next < 0) next = 0;
    if (next > demand.target) next = demand.target;
    const old = save.demandValues[keyOf(index)] ?? 0;
    save.demandValues[keyOf(index)] = next;
    return old !== next;
  }

  /** Public external counter, e.g. power-up uses. Clamped to the demand target. */
  setBossDemand(bossId, index, value) {
    const boss = this._bossById(bossId);
    assert(boss, 'unknown-boss', `unknown boss ${bossId}`);
    assert(Number.isInteger(index) && index >= 0 && index < boss.demands.length,
      'unknown-demand', `boss ${bossId} has no demand ${index}`);
    const changed = this._setDemand(boss, index, value);
    if (changed) this.state.revision += 1;
    const diff = this.processUnlocks();
    return { changed, diff, value: this.demandValue(boss, index) };
  }

  incrementBossDemand(bossId, index, delta) {
    assert(isFiniteNumber(delta), 'invalid-demand-delta', 'delta must be finite');
    const boss = this._bossById(bossId);
    assert(boss, 'unknown-boss', `unknown boss ${bossId}`);
    assert(Number.isInteger(index) && index >= 0 && index < boss.demands.length,
      'unknown-demand', `boss ${bossId} has no demand ${index}`);
    return this.setBossDemand(bossId, index, this.demandValue(boss, index) + delta);
  }

  _bossById(bossId) {
    for (const tier of this.career.tiers) {
      if (tier.boss && tier.boss.id === bossId) return tier.boss;
    }
    return null;
  }

  _updateBossDemands(tier) {
    const boss = tier.boss;
    if (!boss) return;
    let finishEvents = 0;
    let completeFanRuns = 0;
    let completeFanPars = 0;
    let getLights = 0;
    let winAll = 0;
    for (const event of tier.events) {
      const save = this.state.events[event.key];
      if (event.kind !== 'boss') {
        if (this.isEventComplete(event.key)) finishEvents += 1;
        if (save.fanRunComplete) completeFanRuns += 1;
        if (save.bestFans >= event.fanPar) completeFanPars += 1;
      }
      getLights += this.eventStars(event.key);
      if (save.unlocked && save.state === MEDAL.GOLD) winAll += 1;
    }
    const usedCars = this.state.tierCarsUsed[keyOf(tier.index)] ?? [];
    for (let index = 0; index < boss.demands.length; index += 1) {
      const demand = boss.demands[index];
      let value = this.demandValue(boss, index);
      switch (demand.kind) {
        case 'SP_BossDemand_Tier_Finish_Events': value = finishEvents; break;
        case 'SP_BossDemand_Tier_Complete_FanRuns': value = completeFanRuns; break;
        case 'SP_BossDemand_Tier_Complete_FanPars': value = completeFanPars; break;
        case 'SP_BossDemand_Tier_Get_Lights': value = getLights; break;
        case 'SP_BossDemand_Event_Get_All_Lights':
          value = demand.eventKey ? this.eventStars(demand.eventKey) : 0;
          break;
        case 'SP_BossDemand_Tier_Win_All_Events': value = winAll; break;
        case 'SP_BossDemand_Tier_Earn_Fans': value = this.state.totalFans; break;
        case 'SP_BossDemand_Tier_Finish_In_Different_Car': value = usedCars.length; break;
        case 'SP_BossDemand_Event_Time_Remaining':
          value = demand.eventKey ? this.state.events[demand.eventKey].bestTimeSeconds : 0;
          break;
        default:
          break;
      }
      this._setDemand(boss, index, value);
    }
  }

  // ---------------------------------------------------------------- completion
  completeEvent(key, result = {}) {
    const event = this.career.event(key);
    const save = this.state.events[key];
    if (!save.unlocked) {
      return { accepted: false, code: 'event-locked', availability: this.eventAvailability(key) };
    }
    const fans = result.fansEarned;
    assert(isFiniteNumber(fans) && fans >= 0, 'missing-result-field',
      `${key}: fansEarned must be a finite number >= 0`, { field: 'fansEarned' });
    const scored = this.assignMedal(key, result);
    const medal = scored.medal;
    const difficulty = scored.difficulty.name;
    const before = { state: save.state, stars: this.eventStars(key), complete: this.isEventComplete(key) };
    const fansAdded = Math.trunc(fans);

    this.state.totalFans += fansAdded;
    if (event.kind === 'fan') this.state.totalFanEventFans += fansAdded;

    if (medal >= MEDAL.BRONZE) {
      if (medal >= save.state) {
        if (medal > save.state || difficultyRank(difficulty) > difficultyRank(save.difficultyName)) {
          save.state = medal;
          save.difficulty = DIFFICULTY_RANK[difficulty];
          save.difficultyName = difficulty;
        }
      }
      if (fansAdded > save.bestFans) save.bestFans = fansAdded;
      if (result.goldenFanDemandComplete === true) save.fanRunComplete = true;
      const raceTime = result.totalTimeSeconds;
      if (isFiniteNumber(raceTime) && raceTime >= 0) {
        if (event.kind === 'race') {
          if (save.bestTimeSeconds <= 0 || raceTime < save.bestTimeSeconds) save.bestTimeSeconds = round6(raceTime);
        } else if (event.kind === 'checkpoint' || event.kind === 'boss') {
          if (raceTime > save.bestTimeSeconds) save.bestTimeSeconds = round6(raceTime);
        }
      }
      if (event.kind === 'destruction' && isFiniteNumber(result.points)) {
        if (result.points > save.bestPoints) save.bestPoints = Math.trunc(result.points);
      }
      if (event.kind === 'fan' && isFiniteNumber(result.carsWrecked)) {
        if (result.carsWrecked > save.bestPoints) save.bestPoints = Math.trunc(result.carsWrecked);
      }
      save.completions += 1;
      if (result.vehicleId !== undefined && result.vehicleId !== null) save.lastVehicleId = result.vehicleId;
      if (result.carSlug) {
        const used = this.state.tierCarsUsed[keyOf(event.tierIndex)] ?? [];
        if (!used.includes(result.carSlug)) {
          used.push(result.carSlug);
          used.sort();
          this.state.tierCarsUsed[keyOf(event.tierIndex)] = used;
        }
        this.state.selection.carSlug = result.carSlug;
      }
      if (result.vehicleId !== undefined && result.vehicleId !== null) this.state.lastVehicleId = result.vehicleId;
      this.state.selection.map = result.mapId ?? event.route.level;
      this.state.selection.course = result.courseId ?? (event.laps > 0 ? 'lap' : 'sprint');
      this.state.selection.mode = result.modeId ?? event.mode;
      this.state.stats.races += 1;
      if (medal === MEDAL.GOLD) this.state.stats.wins += 1;
    }

    this.state.revision += 1;
    const unlocks = this.processUnlocks();
    const after = { state: save.state, stars: this.eventStars(key), complete: this.isEventComplete(key) };
    return {
      accepted: true,
      key,
      medal,
      medalName: MEDAL_NAMES[medal],
      difficulty,
      difficultyDefaulted: scored.difficulty.defaulted,
      fansAdded,
      totalFans: this.state.totalFans,
      stateBefore: MEDAL_NAMES[before.state],
      stateAfter: MEDAL_NAMES[after.state],
      starsBefore: before.stars,
      starsAfter: after.stars,
      starsAwarded: after.stars - before.stars,
      newlyCompleted: !before.complete && after.complete,
      eventState: { ...save },
      unlocks,
    };
  }

  // ---------------------------------------------------------------- unlocks
  _setTier(tier, unlocked, diff) {
    const save = this.state.tiers[keyOf(tier.id)];
    if (save.unlocked === unlocked) return false;
    save.unlocked = unlocked;
    if (unlocked) save.isNew = true;
    markDiff(diff, 'tiers', tier.id);
    return true;
  }

  _setEvent(event, unlocked, diff) {
    const save = this.state.events[event.key];
    if (save.unlocked === unlocked) return false;
    save.unlocked = unlocked;
    if (unlocked) markDiff(diff, 'events', event.key);
    return true;
  }

  _setBoss(boss, unlocked, diff) {
    const save = this.state.bosses[keyOf(boss.id)];
    if (save.unlocked === unlocked) return false;
    save.unlocked = unlocked;
    if (unlocked) save.isNew = true;
    markDiff(diff, 'bosses', boss.id);
    return true;
  }

  _setReward(reward, unlocked, diff) {
    const table = reward.kind === 'vehicle' ? this.state.vehicles : this.state.mods;
    const id = reward.kind === 'vehicle' ? reward.vehicleId : reward.mod?.refId;
    if (id === null || id === undefined) return false;
    const save = table[keyOf(id)] ?? (table[keyOf(id)] = { unlocked: false, isNew: false });
    if (save.unlocked === unlocked) return false;
    save.unlocked = unlocked;
    if (unlocked) {
      save.isNew = true;
      markDiff(diff, reward.kind === 'vehicle' ? 'vehicles' : 'mods', id);
    }
    return true;
  }

  /** Recompute every unlock in retail order. Idempotent. */
  processUnlocks(options = {}) {
    const diff = emptyDiff();
    const { state, career } = this;
    const newRank = findRankByFans(career, state.totalFans);
    let highestRankUp = 0;
    for (let rankNo = 1; rankNo < career.ranks.length; rankNo += 1) {
      const rank = career.ranks[rankNo];
      const unlocked = rankNo <= newRank;
      for (const reward of rank.vehicles) this._setReward({ kind: 'vehicle', vehicleId: reward.vehicleId }, unlocked, diff);
      if (unlocked && state.rank < rankNo) highestRankUp = rankNo;
    }
    for (let rankNo = Math.max(1, state.rank + 1); rankNo <= highestRankUp; rankNo += 1) {
      diff.rankUps.push(rankNo);
      diff.changed = true;
    }
    if (state.rank !== newRank) {
      state.rank = newRank;
      diff.changed = true;
    }

    let stars = 0;
    for (const tier of career.tiers) {
      const tierUnlocked = stars >= tier.starRequirement;
      this._setTier(tier, tierUnlocked, diff);
      let completeCount = 0;
      for (const event of tier.events) {
        if (event.kind === 'boss') continue;
        const required = Math.floor(event.indexInTier / EVENT_GROUP_SIZE) * EVENT_GROUP_REQUIRED;
        this._setEvent(event, tierUnlocked && completeCount >= required, diff);
        if (this.isEventComplete(event.key)) completeCount += 1;
        stars += this.eventStars(event.key);
      }
      this._updateBossDemands(tier);
      const boss = tier.boss;
      let bossUnlocked = false;
      if (boss) {
        bossUnlocked = boss.demands.every((demand, index) => this.isDemandComplete(boss, index));
        this._setBoss(boss, bossUnlocked, diff);
      }
      let rewardsUnlocked = bossUnlocked;
      for (const event of tier.events) {
        if (event.kind !== 'boss') continue;
        this._setEvent(event, bossUnlocked, diff);
        if (!this.isEventComplete(event.key)) rewardsUnlocked = false;
        stars += this.eventStars(event.key);
      }
      if (boss) {
        const save = state.bosses[keyOf(boss.id)];
        if (save.defeated !== rewardsUnlocked) {
          save.defeated = rewardsUnlocked;
          diff.changed = true;
          if (rewardsUnlocked) diff.bossDefeated.push(boss.id);
        }
        for (const reward of boss.rewardsForUnlock) this._setReward(reward, bossUnlocked, diff);
        for (const reward of boss.rewardsForDefeat) this._setReward(reward, rewardsUnlocked, diff);
      }
    }
    if (diff.changed && !options.silent) state.revision += 1;
    return diff;
  }

  // ------------------------------------------------------------------- UI data
  snapshot() {
    const state = this.state;
    const tiers = this.career.tiers.map((tier) => ({
      index: tier.index,
      id: tier.id,
      name: tier.name?.value ?? null,
      starRequirement: tier.starRequirement,
      unlocked: state.tiers[keyOf(tier.id)].unlocked,
      isNew: state.tiers[keyOf(tier.id)].isNew,
      stars: this.tierStars(tier.index),
      maxStars: tier.maxStars,
      events: tier.events.map((event) => ({
        key: event.key,
        kind: event.kind,
        mode: event.mode,
        level: event.route.level,
        laps: event.laps,
        carClass: event.carClass,
        fanPar: event.fanPar,
        unlocked: state.events[event.key].unlocked,
        state: MEDAL_NAMES[state.events[event.key].state],
        stars: this.eventStars(event.key),
        maxStars: this.maxEventStars(event.key),
      })),
      boss: tier.boss ? {
        id: tier.boss.id,
        name: tier.boss.name?.value ?? null,
        unlocked: state.bosses[keyOf(tier.boss.id)].unlocked,
        defeated: state.bosses[keyOf(tier.boss.id)].defeated,
        demands: tier.boss.demands.map((demand, index) => ({
          index,
          kind: demand.kind,
          unit: demand.unit,
          target: demand.target,
          value: this.demandValue(tier.boss, index),
          complete: this.isDemandComplete(tier.boss, index),
        })),
      } : null,
    }));
    const vehicles = Object.keys(state.vehicles).sort((a, b) => Number(a) - Number(b)).map((id) => ({
      vehicleId: Number(id),
      unlocked: state.vehicles[id].unlocked,
      isNew: state.vehicles[id].isNew,
    }));
    return {
      kind: 'blur.career.snapshot',
      version: 1,
      rank: state.rank,
      totalFans: state.totalFans,
      totalStars: this.countStars(),
      maxStars: this.career.maxStars,
      primaryStars: this.countPrimaryStars(),
      selection: { ...state.selection },
      tiers,
      vehicles,
      revision: state.revision,
    };
  }

  // -------------------------------------------------------------- persistence
  /** Values accepted by `blur.profile.v1`; the shell writes the profile. */
  toProfilePatch() {
    const selection = this.state.selection;
    const validSlug = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
    const profileModes = ['sprint', 'lap', 'free', 'multiplayer'];
    let lastMode = 'sprint';
    if (profileModes.includes(selection.mode)) lastMode = selection.mode;
    else if (selection.course === 'lap') lastMode = 'lap';
    return {
      progress: {
        lastCar: validSlug(selection.carSlug) ? selection.carSlug : null,
        lastMap: validSlug(selection.map) ? selection.map : null,
        lastCourse: validSlug(selection.course) ? selection.course : null,
        lastMode,
      },
      stats: { races: this.state.stats.races, wins: this.state.stats.wins },
      careerMode: selection.mode,
      note: 'career mode is not a blur.profile.v1 progress mode; it is returned separately',
    };
  }

  /**
   * Read the shared profile. `blur.profile.v1` has no career section and its
   * `extra` bucket is not round-trip safe, so career progress cannot live there.
   * This imports only the documented selection and (optionally) stats.
   */
  applyProfile(profile, options = {}) {
    assert(profile && typeof profile === 'object', 'invalid-profile', 'profile must be an object');
    assert(profile.kind === 'blur.profile', 'invalid-profile', 'profile.kind must be blur.profile');
    assert(profile.schemaVersion === 1, 'invalid-profile', 'profile.schemaVersion must be 1');
    const progress = profile.progress ?? {};
    if (typeof progress.lastCar === 'string') this.state.selection.carSlug = progress.lastCar;
    if (typeof progress.lastMap === 'string') this.state.selection.map = progress.lastMap;
    if (typeof progress.lastCourse === 'string') this.state.selection.course = progress.lastCourse;
    if (typeof progress.lastMode === 'string') this.state.selection.mode = progress.lastMode;
    if (options.importStats && profile.stats) {
      if (Number.isInteger(profile.stats.races) && profile.stats.races >= 0) this.state.stats.races = profile.stats.races;
      if (Number.isInteger(profile.stats.wins) && profile.stats.wins >= 0) this.state.stats.wins = profile.stats.wins;
    }
    return {
      applied: true,
      profileSchemaVersion: profile.schemaVersion,
      careerSection: null,
      note: 'blur.profile.v1 has no career section; career progression is stored in blur.career.state',
    };
  }
}

function tierStarsSatisfy(tier, stars, state) {
  // An already-unlocked tier stays unlocked even if the requirement is zero.
  if (state.tiers[keyOf(tier.id)].unlocked) return true;
  return stars >= tier.starRequirement;
}

function cloneState(career, value, options = {}) {
  const strict = options.strict !== false;
  assert(value && typeof value === 'object', 'invalid-state', 'career state must be an object');
  assert(value.kind === CAREER_STATE_KIND, 'invalid-state', `state.kind must be ${CAREER_STATE_KIND}`);
  assert(value.version === CAREER_STATE_VERSION, 'invalid-state', `unsupported state version`);
  const fresh = newCareerState(career);
  if (strict) {
    const count = (object) => (object && typeof object === 'object' ? Object.keys(object).length : 0);
    assert(count(value.events) === career.eventList.length, 'invalid-state',
      'state.events does not cover every career event', { got: count(value.events), want: career.eventList.length });
    assert(count(value.tiers) === career.tiers.length, 'invalid-state',
      'state.tiers does not cover every career tier');
    const bossCount = career.tiers.filter((tier) => tier.boss).length;
    assert(count(value.bosses) === bossCount, 'invalid-state', 'state.bosses does not cover every boss');
    assert(count(value.vehicles) === career.vehicleRewardIds().length, 'invalid-state',
      'state.vehicles does not cover every reward vehicle');
  }
  const state = {
    ...fresh,
    revision: Number.isInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    totalFans: Number.isInteger(value.totalFans) && value.totalFans >= 0 ? value.totalFans : 0,
    totalFanEventFans: Number.isInteger(value.totalFanEventFans) && value.totalFanEventFans >= 0 ? value.totalFanEventFans : 0,
    rank: Number.isInteger(value.rank) && value.rank >= 0 ? value.rank : 0,
    lastVehicleId: value.lastVehicleId ?? null,
    stats: {
      races: Number.isInteger(value.stats?.races) && value.stats.races >= 0 ? value.stats.races : 0,
      wins: Number.isInteger(value.stats?.wins) && value.stats.wins >= 0 ? value.stats.wins : 0,
    },
    selection: {
      carSlug: typeof value.selection?.carSlug === 'string' ? value.selection.carSlug : null,
      map: typeof value.selection?.map === 'string' ? value.selection.map : null,
      course: typeof value.selection?.course === 'string' ? value.selection.course : null,
      mode: typeof value.selection?.mode === 'string' ? value.selection.mode : null,
    },
  };
  for (const [tierId, entry] of Object.entries(value.tiers ?? {})) {
    if (!fresh.tiers[tierId]) {
      assert(!strict, 'invalid-state', `unknown tier id ${tierId}`);
      continue;
    }
    state.tiers[tierId] = { unlocked: entry?.unlocked === true, isNew: entry?.isNew === true };
  }
  for (const [eventKey, entry] of Object.entries(value.events ?? {})) {
    if (!fresh.events[eventKey]) {
      assert(!strict, 'invalid-state', `unknown event key ${eventKey}`);
      continue;
    }
    const target = state.events[eventKey];
    const medal = Number.isInteger(entry?.state) ? Math.max(0, Math.min(3, entry.state)) : 0;
    target.unlocked = entry?.unlocked === true;
    target.state = medal;
    target.difficulty = Number.isInteger(entry?.difficulty) ? Math.max(0, Math.min(2, entry.difficulty)) : 0;
    target.difficultyName = DIFFICULTY_NAMES[target.difficulty] ?? 'easy';
    target.bestFans = Number.isInteger(entry?.bestFans) && entry.bestFans >= 0 ? entry.bestFans : 0;
    target.bestPoints = Number.isInteger(entry?.bestPoints) && entry.bestPoints >= 0 ? entry.bestPoints : 0;
    target.bestTimeSeconds = isFiniteNumber(entry?.bestTimeSeconds) && entry.bestTimeSeconds >= 0
      ? round6(entry.bestTimeSeconds) : 0;
    target.fanRunComplete = entry?.fanRunComplete === true;
    target.lastVehicleId = entry?.lastVehicleId ?? null;
    target.completions = Number.isInteger(entry?.completions) && entry.completions >= 0 ? entry.completions : 0;
  }
  for (const [bossId, entry] of Object.entries(value.bosses ?? {})) {
    if (!fresh.bosses[bossId]) {
      assert(!strict, 'invalid-state', `unknown boss id ${bossId}`);
      continue;
    }
    const target = state.bosses[bossId];
    target.unlocked = entry?.unlocked === true;
    target.isNew = entry?.isNew === true;
    target.defeated = entry?.defeated === true;
    for (const [index, demand] of Object.entries(entry?.demandValues ?? {})) {
      if (!(index in target.demandValues)) {
        assert(!strict, 'invalid-state', `unknown demand index ${index} on boss ${bossId}`);
        continue;
      }
      target.demandValues[index] = isFiniteNumber(demand) && demand >= 0 ? demand : 0;
    }
  }
  for (const [vehicleId, entry] of Object.entries(value.vehicles ?? {})) {
    if (!fresh.vehicles[vehicleId]) {
      assert(!strict, 'invalid-state', `unknown vehicle reward ${vehicleId}`);
      continue;
    }
    state.vehicles[vehicleId] = { unlocked: entry?.unlocked === true, isNew: entry?.isNew === true };
  }
  for (const [modId, entry] of Object.entries(value.mods ?? {})) {
    state.mods[modId] = { unlocked: entry?.unlocked === true, isNew: entry?.isNew === true };
  }
  for (const [tierIndex, cars] of Object.entries(value.tierCarsUsed ?? {})) {
    if (Array.isArray(cars)) state.tierCarsUsed[tierIndex] = cars.filter((car) => typeof car === 'string').sort();
  }
  return state;
}

/** Convenience: fresh session with rank 1 / tier 1 available. */
export function createCareerSession(careerOrManifest) {
  const career = careerOrManifest instanceof Career ? careerOrManifest : loadCareer(careerOrManifest);
  return new CareerSession(career);
}

export { canonicalJson, hashOf };
