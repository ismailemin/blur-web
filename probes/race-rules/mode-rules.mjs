// ModeSession — data-driven, host-authoritative rules for every Blur event mode
// whose objective can be defined from recovered game data.
//
// The rules are an ORIGINAL state machine. They read only:
//   * an optional committed CourseModel (the existing measured course),
//   * a plain mode config assembled by the caller from _work/race-rules/game-modes.json,
//   * per-tick vehicle states and host-scored events.
//
// They never call the engine, a wall clock or a random source. The only clock is
// the integer race tick owned by RaceDirector.
//
// Mode kinds:
//   race / sprint / race-no-powerups  ordered gates/laps (ProgressTracker)
//   checkpoint                        time bank + checkpoints + medal thresholds
//   destruction                       damage/wreck score, time or score target
//   points                            fan score from the recovered 26-rule table
//   elimination                       periodic last/first/health/fans elimination
//   boss-battle                       minders then boss, wreck or gap win
//
// Values that are not recovered are passed in with an explicit `source` label;
// the caller must surface it. This module never substitutes a retail value.

import { RaceDirector, RACE_PHASE } from './race-director.mjs';
import { ProgressTracker } from './progress-tracker.mjs';
import { hashOf } from './hash.mjs';

export const MODE_KIND = Object.freeze({
  RACE: 'race',
  SPRINT: 'sprint',
  RACE_NO_POWERUPS: 'race-no-powerups',
  CHECKPOINT: 'checkpoint',
  DESTRUCTION: 'destruction',
  POINTS: 'points',
  ELIMINATION: 'elimination',
  BOSS_BATTLE: 'boss-battle'
});

export const MODE_STATUS = Object.freeze({
  ACTIVE: 'active',
  FINISHED: 'finished',
  ELIMINATED: 'eliminated',
  DNF: 'dnf',
  DISCONNECTED: 'disconnected',
  LEFT: 'left'
});

export const MODE_EVENT = Object.freeze({
  SCORE: 'score',
  DAMAGE: 'damage',
  WRECK: 'wreck',
  SUICIDE: 'suicide',
  CHECKPOINT: 'checkpoint',
  STOPWATCH: 'stopwatch',
  ELIMINATED: 'eliminated',
  FINISH: 'finish',
  DNF: 'dnf',
  RESPAWN_SCHEDULED: 'respawn-scheduled',
  RESPAWN_READY: 'respawn-ready',
  TIME_EXPIRED: 'time-expired',
  SCORE_TARGET: 'score-target',
  BOSS_STAGE: 'boss-stage',
  BOSS_WON: 'boss-won',
  BOSS_LOST: 'boss-lost',
  GAP: 'gap',
  RACE_FINISHED: 'race-finished',
  COMMAND_REJECTED: 'command-rejected'
});

/**
 * Per-kind rule description, exported for the integration contract and docs.
 * `source` states where each rule comes from; `provisional` marks project values.
 */
export const MODE_RULES = Object.freeze({
  [MODE_KIND.RACE]: {
    objective: 'complete the configured laps; ordered checkpoints/gates',
    progress: 'RaceDirector raceTick + ProgressTracker laps/checkpoints/progress',
    finish: 'ProgressTracker finish after the last lap',
    scoring: 'none; position only',
    tieBreak: 'finishTick, then participant id',
    respawn: 'off-course/below-ground/airborne via ProgressTracker',
    source: 'game data (MultiplayerRace.laps) + existing race-rules modules'
  },
  [MODE_KIND.SPRINT]: {
    objective: 'point-to-point; ordered gates then finish gate',
    progress: 'ProgressTracker gateIndex / maxArc',
    finish: 'finish gate after every checkpoint',
    scoring: 'none; position only',
    tieBreak: 'finishTick, then participant id',
    respawn: 'off-course via ProgressTracker, last passed gate',
    source: 'committed 310 m layout + existing race-rules modules'
  },
  [MODE_KIND.RACE_NO_POWERUPS]: {
    objective: 'lap race with power-ups disabled (hardcore)',
    progress: 'same as race',
    finish: 'same as race',
    scoring: 'none; position only',
    tieBreak: 'finishTick, then id',
    respawn: 'same as race',
    source: 'MultiplayerRace.type=hardcore rows: powerups empty, damage high'
  },
  [MODE_KIND.CHECKPOINT]: {
    objective: 'reach the finish before the per-participant time bank empties',
    progress: 'ordered checkpoints; each awards time from timeAwarded[]',
    finish: 'finish after all intermediate checkpoints with timeLeft >= 0',
    scoring: 'medal: gold/silver thresholds, bronze at timeLeft >= 0',
    tieBreak: 'finishTick, then remaining time, then id',
    respawn: 'off-course via ProgressTracker',
    source: 'AmaxRaceModeCheckpointVars (initialTime/timeAwarded/stopwatchIncTime/thresholds)'
  },
  [MODE_KIND.DESTRUCTION]: {
    objective: 'score damage/wreck points before the timer or score target',
    progress: 'score (OnTrackPoints); no lap objective',
    finish: 'time limit or score target; then every survivor finishes',
    scoring: 'MotorMash wreck/suicide/low/high/rival or SP hit+wrecked per class',
    tieBreak: 'score desc, then fans desc, then id',
    respawn: 'wreck respawn delay / eliminate / do-nothing per config',
    source: 'MultiplayerConfig.motormashScoringValues; SP_GameMode_Destruction'
  },
  [MODE_KIND.POINTS]: {
    objective: 'score fans from the recovered scoring-event table',
    progress: 'fans score; finish on laps, time or score target',
    finish: 'laps (if configured), time limit, or score target',
    scoring: 'MultiplayerConfig.scoring 26 rules (event/impact/pickup/crossed-line)',
    tieBreak: 'score desc, then finishTick, then id',
    respawn: 'wreck respawn',
    source: 'MultiplayerConfig.scoring + RaceModeMultiplayerPoints.cpp'
  },
  [MODE_KIND.ELIMINATION]: {
    objective: 'periodically eliminate the ranked participant; last one wins',
    progress: 'active count + elimination order',
    finish: 'one participant remains',
    scoring: 'elimination points; criterion from config',
    tieBreak: 'reverse elimination order (last survivor first)',
    respawn: 'eliminate on wreck when configured',
    source: 'RaceModeMultiplayerElimination.cpp; period/criterion are provisional (no shipped race rows)'
  },
  [MODE_KIND.BOSS_BATTLE]: {
    objective: 'beat the minders, then beat the boss by wreck or sustained gap',
    progress: 'stage 1 minders, stage 2 boss, per-participant ahead timer',
    finish: 'wreckBossToWin or gap win; lose when behind by distanceFromBoss',
    scoring: 'win/lose only; medal Gold on win (source)',
    tieBreak: 'win tick, then id',
    respawn: 'wreck respawn',
    source: 'AmaxRaceModeBossBattle fields + documented two-stage logic'
  }
});

const round6 = (value) => Math.round(value * 1e6) / 1e6;
const clamp01 = (value) => Math.max(0, Math.min(1, value));

const COURSE_KINDS = new Set([
  MODE_KIND.RACE, MODE_KIND.SPRINT, MODE_KIND.RACE_NO_POWERUPS,
  MODE_KIND.CHECKPOINT, MODE_KIND.BOSS_BATTLE
]);

// Points can finish on laps as well as on time or a score target. When the
// caller supplies a course, track ordered checkpoints/laps exactly like a race;
// a points session without a course keeps the time/score-only behaviour.
const PROGRESS_KINDS = new Set([...COURSE_KINDS, MODE_KIND.POINTS]);

const IMPACT_ORDER = { LightImpact: 1, MediumImpact: 2, HeavyImpact: 3, light: 1, medium: 2, high: 3, heavy: 3 };

const TERMINAL = new Set([
  MODE_STATUS.FINISHED, MODE_STATUS.ELIMINATED, MODE_STATUS.DNF,
  MODE_STATUS.DISCONNECTED, MODE_STATUS.LEFT
]);

function normalizeParticipants(participants) {
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new Error('ModeSession needs participants');
  }
  const rows = participants.map((entry, index) => {
    const value = typeof entry === 'string' ? { id: entry } : entry;
    if (!value || typeof value.id !== 'string' || value.id.length === 0) {
      throw new Error('participant at index ' + index + ' has no id');
    }
    const slot = value.slot ?? index + 1;
    if (!Number.isInteger(slot) || slot < 1) throw new Error('participant slot must be a positive integer');
    return { id: value.id, slot, team: value.team ?? null };
  });
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error('duplicate participant id');
  if (new Set(rows.map((row) => row.slot)).size !== rows.length) throw new Error('duplicate participant slot');
  return rows.sort((a, b) => a.slot - b.slot || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function stateFor(states, id) {
  if (!states) return null;
  if (Array.isArray(states)) return states.find((entry) => entry?.id === id) ?? null;
  return states[id] ?? null;
}

/** Exact/at-least impact lookup: rule applies when its MinImpactLevel <= impact. */
function impactAtLeast(ruleLevel, eventLevel) {
  const a = IMPACT_ORDER[ruleLevel];
  const b = IMPACT_ORDER[eventLevel];
  return Number.isFinite(a) && Number.isFinite(b) && b >= a;
}

export class ModeSession {
  /**
   * @param {object} options
   * @param {string} options.mode one of MODE_KIND
   * @param {Array<{id:string,slot?:number,team?:string}|string>} options.participants
   * @param {object|null} [options.course] CourseModel for course-based kinds
   * @param {object} [options.config] recovered/game-data config (see MODE_RULES)
   */
  constructor({ mode, participants, course = null, config = {} } = {}) {
    if (!Object.values(MODE_KIND).includes(mode)) throw new Error('unsupported mode kind ' + String(mode));
    if (COURSE_KINDS.has(mode) && !course) throw new Error('mode ' + mode + ' needs a CourseModel');
    this.mode = mode;
    this.course = course;
    this.participantsInput = normalizeParticipants(participants);
    this.config = Object.freeze({
      mode,
      hostId: config.hostId,
      hostAuthority: config.hostAuthority !== false,
      minParticipants: config.minParticipants ?? 2,
      maxParticipants: config.maxParticipants ?? 20,
      countdownTicks: config.countdownTicks ?? (course ? course.countdownTicks : 0),
      loadingTicks: config.loadingTicks ?? 0,
      resultsDelayTicks: config.resultsDelayTicks ?? 120,
      raceTimeoutTicks: config.raceTimeoutTicks ?? 60000,
      tickHz: config.tickHz ?? (course ? course.tickHz : 60),
      laps: config.laps ?? (course ? course.laps : 0),
      finishOn: config.finishOn ?? (mode === MODE_KIND.POINTS ? 'time' : 'laps'),
      timeLimitSeconds: config.timeLimitSeconds ?? 0,
      scoreTarget: config.scoreTarget ?? 0,
      scoringTable: config.scoringTable ?? [],
      destruction: config.destruction ?? null,
      elimination: config.elimination ?? null,
      checkpoint: config.checkpoint ?? null,
      bossBattle: config.bossBattle ?? null,
      respawn: config.respawn ?? { mode: 'respawn', wreckTicks: 180, source: 'provisional' },
      damageMode: config.damageMode ?? null,
      powerupsEnabled: config.powerupsEnabled !== false,
      teams: config.teams === true,
      source: config.source ?? 'recovered'
    });
    const directorConfig = {
      hostId: this.config.hostId ?? this.participantsInput[0].id,
      hostAuthority: this.config.hostAuthority,
      minParticipants: this.config.minParticipants,
      maxParticipants: this.config.maxParticipants,
      countdownTicks: this.config.countdownTicks,
      loadingTicks: this.config.loadingTicks,
      resultsDelayTicks: this.config.resultsDelayTicks,
      raceTimeoutTicks: this.config.raceTimeoutTicks,
      tickHz: this.config.tickHz
    };
    this.director = new RaceDirector({ participants, config: directorConfig });
    this.hostId = this.director.hostId;
    this.progress = (PROGRESS_KINDS.has(mode) && course)
      ? new ProgressTracker(course, participants, {
        tickHz: this.config.tickHz,
        respawn: config.respawnPolicy ?? { enabled: true }
      })
      : null;
    this.resetModeState();
    this.primed = false;
    this.eventLog = [];
    this.eventSeq = 0;
  }

  resetModeState() {
    this.byId = new Map();
    for (const entry of this.participantsInput) {
      this.byId.set(entry.id, {
        id: entry.id,
        slot: entry.slot,
        team: entry.team,
        status: MODE_STATUS.ACTIVE,
        score: 0,
        fans: 0,
        wrecks: 0,
        damageDealt: 0,
        damageTaken: 0,
        health: 100,
        finishTick: null,
        finishKind: null,
        dnfReason: null,
        eliminatedAt: null,
        eliminationOrder: null,
        respawns: 0,
        respawnAtTick: null,
        awaitingRejoin: false,
        rejoinSignalled: false,
        // checkpoint
        timeLeftSeconds: this.config.checkpoint ? this.config.checkpoint.initialTimeSeconds : null,
        checkpointIndex: 0,
        stopwatches: 0,
        medal: null,
        // elimination ranking
        positionValue: 0,
        // boss battle
        bossStage: 'minders',
        aheadTicks: 0,
        behindTicks: 0
      });
    }
    this.eliminationOrder = [];
    this.nextEliminationTick = null;
    this.boss = this.config.bossBattle ? {
      stage: 'minders',
      bossId: this.config.bossBattle.bossId ?? 'boss',
      minderIds: (this.config.bossBattle.minderIds ?? []).slice(),
      wreckedMinders: 0,
      wreckedBoss: false,
      outcome: null
    } : null;
    this.raceSettled = false;
  }

  get phase() {
    return this.director.phase;
  }

  get raceTick() {
    return this.director.raceTick;
  }

  get(id) {
    const row = this.byId.get(id);
    if (!row) throw new Error('ModeSession: unknown participant ' + id);
    return row;
  }

  list() {
    return this.participantsInput.map((entry) => this.get(entry.id));
  }

  active() {
    return this.list().filter((row) => row.status === MODE_STATUS.ACTIVE);
  }

  record(type, payload = {}) {
    const row = {
      seq: this.eventSeq++,
      type,
      mode: this.mode,
      tick: this.director.tick,
      raceTick: this.director.raceTick,
      phase: this.director.phase,
      authority: this.hostId,
      ...payload
    };
    this.eventLog.push(row);
    return row;
  }

  emit(type, payload = {}) {
    return this.record(type, payload);
  }

  reject(command, reason, from = null) {
    return { accepted: false, reason, events: [this.record(MODE_EVENT.COMMAND_REJECTED, {
      command: command ?? null, from, reason
    })] };
  }

  /** Room/command message. start/finish/dnf/restart are host-only by default. */
  command(message) {
    const type = message?.type;
    const result = this.director.command(message);
    const events = result.events.map((event) => this.record(event.type, { directorEvent: event }));
    if (result.accepted && (type === 'start' || type === 'restart')) {
      this.resetModeState();
      this.primed = false;
      if (this.progress) this.progress.reset();
      if (type === 'start' && this.config.elimination) {
        this.nextEliminationTick = this.config.elimination.periodTicks;
      }
    }
    if (result.accepted && type === 'disconnect') {
      const id = message.from ?? message.id;
      const row = this.byId.get(id);
      if (row && !TERMINAL.has(row.status)) {
        row.status = MODE_STATUS.DISCONNECTED;
        row.dnfReason = message.reason ?? 'disconnected';
      }
    }
    // Host-authoritative commands (dnf/disconnect) change the director row
    // first; mirror them into the mode rows immediately so results() and the
    // next snapshot agree with the director without waiting for a step().
    if (result.accepted) this.syncDirector();
    return { ...result, events };
  }

  /**
   * Host-scored event. Rejected when `hostAuthority` is on and `from` is not the
   * host: the client sends an intent, never an independent score.
   */
  submit(event, from = this.hostId) {
    if (!event || typeof event.type !== 'string') return this.reject(null, 'invalid-event', from);
    if (this.config.hostAuthority && from !== this.hostId) {
      return this.reject(event.type, 'not-host', from);
    }
    if (this.director.phase !== RACE_PHASE.RUNNING) {
      return this.reject(event.type, 'phase-not-running', from);
    }
    const handler = {
      score: () => this.applyScore(event),
      damage: () => this.applyDamage(event),
      wreck: () => this.applyWreck(event),
      suicide: () => this.applySuicide(event),
      checkpoint: () => this.applyCheckpoint(event),
      stopwatch: () => this.applyStopwatch(event),
      'crossed-line-first': () => this.applyScore({ ...event, crossedLineFirst: true }),
      'wreck-boss': () => this.applyBossWreck(event, true),
      'wreck-minder': () => this.applyBossWreck(event, false),
      gap: () => this.applyGap(event),
      eliminate: () => this.applyExplicitElimination(event)
    }[event.type];
    if (!handler) return this.reject(event.type, 'unknown-event', from);
    return { accepted: true, events: handler() };
  }

  // ------------------------------------------------------------- scoring
  pointsFor(event) {
    const table = this.config.scoringTable;
    if (!Array.isArray(table) || table.length === 0) return 0;
    for (const rule of table) {
      if (rule.event && event.scoringEvent === rule.event) return rule.points ?? 0;
      if (rule.minImpactLevel && event.impactLevel && impactAtLeast(rule.minImpactLevel, event.impactLevel)) {
        return rule.points ?? 0;
      }
      if (rule.pickupType && event.pickupType === rule.pickupType) return rule.points ?? 0;
      if (rule.crossedLineFirst && event.crossedLineFirst) return rule.points ?? 0;
    }
    return 0;
  }

  applyScore(event) {
    const actor = this.get(event.participantId ?? event.actorId);
    if (TERMINAL.has(actor.status)) return [];
    const points = Number.isFinite(event.points) ? event.points : this.pointsFor(event);
    const events = [];
    if (points !== 0) {
      actor.score = round6(actor.score + points);
      if (this.mode === MODE_KIND.POINTS) actor.fans = actor.score;
      events.push(this.emit(MODE_EVENT.SCORE, {
        participantId: actor.id,
        points: round6(points),
        score: actor.score,
        reason: event.scoringEvent ?? event.pickupType ?? event.impactLevel ?? event.reason ?? 'score'
      }));
    }
    events.push(...this.checkScoreTarget(actor));
    return events;
  }

  applyDamage(event) {
    const actor = this.get(event.participantId ?? event.actorId);
    const victim = event.victimId ? this.get(event.victimId) : null;
    if (TERMINAL.has(actor.status)) return [];
    if (this.mode !== MODE_KIND.DESTRUCTION) {
      return [this.emit(MODE_EVENT.DAMAGE, { participantId: actor.id, applied: false, reason: 'mode-not-scored' })];
    }
    const table = this.config.destruction ?? {};
    const rival = event.rival === true ? (table.rivalMultiplier ?? 1) : 1;
    let base;
    if (table.classTable) {
      base = table.classTable[event.victimClass ?? 'Medium']?.hitPoints ?? 0;
    } else {
      base = event.level === 'high' || event.impactLevel === 'HeavyImpact'
        ? (table.highDamage ?? 0) : (table.lowDamage ?? 0);
    }
    const points = round6(base * rival);
    actor.damageDealt += 1;
    actor.score = round6(actor.score + points);
    if (victim) victim.damageTaken += 1;
    const events = [this.emit(MODE_EVENT.DAMAGE, {
      participantId: actor.id, victimId: victim?.id ?? null, level: event.level ?? null,
      points, score: actor.score, rival: event.rival === true
    })];
    events.push(...this.checkScoreTarget(actor));
    return events;
  }

  applyWreck(event) {
    const actor = this.get(event.participantId ?? event.actorId);
    const victim = event.victimId ? this.get(event.victimId) : null;
    if (TERMINAL.has(actor.status)) return [];
    const events = [];
    let points = 0;
    if (this.mode === MODE_KIND.DESTRUCTION) {
      const table = this.config.destruction ?? {};
      const rival = event.rival === true ? (table.rivalMultiplier ?? 1) : 1;
      if (table.classTable) {
        const cls = event.victimClass ?? 'Medium';
        points = ((table.classTable[cls]?.hitPoints ?? 0) + (table.classTable[cls]?.wreckedPoints ?? 0)) * rival;
      } else if (Number.isFinite(event.points)) {
        points = event.points;
      } else {
        points = (table.wreck ?? 0) * rival;
      }
      points = round6(points);
      actor.score = round6(actor.score + points);
      actor.wrecks += 1;
    }
    if (victim) victim.health = 0;
    events.push(this.emit(MODE_EVENT.WRECK, {
      participantId: actor.id, victimId: victim?.id ?? null, points, score: actor.score,
      rival: event.rival === true
    }));
    events.push(...this.checkScoreTarget(actor));
    if (victim) events.push(...this.applyWreckConsequence(victim, event.reason ?? 'wrecked'));
    return events;
  }

  applySuicide(event) {
    const actor = this.get(event.participantId ?? event.actorId);
    if (TERMINAL.has(actor.status)) return [];
    const table = this.config.destruction ?? {};
    const points = -Math.abs(table.suicide ?? 0);
    actor.score = round6(actor.score + (event.appliesToScore === false ? 0 : points));
    const events = [this.emit(MODE_EVENT.SUICIDE, {
      participantId: actor.id, points, score: actor.score
    })];
    events.push(...this.applyWreckConsequence(actor, 'suicide'));
    return events;
  }

  applyWreckConsequence(row, reason) {
    const policy = this.config.respawn ?? {};
    const events = [];
    if (policy.mode === 'eliminate') {
      events.push(...this.eliminate(row, reason));
    } else if (policy.mode === 'none') {
      events.push(...this.markDnf(row, reason));
    } else {
      row.health = 0;
      row.awaitingRejoin = true;
      row.rejoinSignalled = false;
      row.respawns += 1;
      const delay = Array.isArray(policy.wreckTicksByWreck)
        ? (policy.wreckTicksByWreck[Math.min(row.respawns - 1, policy.wreckTicksByWreck.length - 1)] ?? policy.wreckTicks)
        : (policy.wreckTicks ?? 0);
      row.respawnAtTick = this.director.raceTick + delay;
      events.push(this.emit(MODE_EVENT.RESPAWN_SCHEDULED, {
        participantId: row.id, reason, atTick: row.respawnAtTick, delay,
        target: this.progress ? this.progress.policy.targetFor({
          lastGateIndex: Math.max(0, (this.progress.get(row.id)?.gateIndex ?? 1) - 1)
        }) : null
      }));
    }
    return events;
  }

  applyCheckpoint(event) {
    const row = this.get(event.participantId ?? event.actorId);
    if (TERMINAL.has(row.status)) return [];
    if (this.mode !== MODE_KIND.CHECKPOINT) return [];
    const cp = this.config.checkpoint;
    const index = Number.isInteger(event.checkpointIndex) ? event.checkpointIndex
      : (row.checkpointIndex + 1);
    const award = Array.isArray(cp.timeAwarded) ? (cp.timeAwarded[index] ?? 0) : 0;
    row.checkpointIndex = Math.max(row.checkpointIndex, index);
    row.timeLeftSeconds = round6((row.timeLeftSeconds ?? cp.initialTimeSeconds) + award);
    return [this.emit(MODE_EVENT.CHECKPOINT, {
      participantId: row.id, checkpointIndex: index, awardedSeconds: award,
      timeLeftSeconds: row.timeLeftSeconds
    })];
  }

  applyStopwatch(event) {
    const row = this.get(event.participantId ?? event.actorId);
    if (TERMINAL.has(row.status)) return [];
    if (this.mode !== MODE_KIND.CHECKPOINT) return [];
    const cp = this.config.checkpoint;
    const award = cp.stopwatchSeconds ?? 0;
    row.stopwatches += 1;
    row.timeLeftSeconds = round6((row.timeLeftSeconds ?? cp.initialTimeSeconds) + award);
    return [this.emit(MODE_EVENT.STOPWATCH, {
      participantId: row.id, awardedSeconds: award, timeLeftSeconds: row.timeLeftSeconds
    })];
  }

  checkScoreTarget(row) {
    const events = [];
    if (this.mode !== MODE_KIND.DESTRUCTION && this.mode !== MODE_KIND.POINTS) return events;
    if (!(this.config.scoreTarget > 0)) return events;
    if (this.config.finishOn !== 'score') return events;
    if (row.status !== MODE_STATUS.ACTIVE || row.score < this.config.scoreTarget) return events;
    events.push(this.emit(MODE_EVENT.SCORE_TARGET, {
      participantId: row.id, score: row.score, target: this.config.scoreTarget
    }));
    events.push(...this.finishAll('score-target'));
    return events;
  }

  // ------------------------------------------------------------ elimination
  rankingValue(row) {
    const criterion = this.config.elimination?.criterion ?? 'last_place';
    if (criterion.includes('health')) return row.health;
    if (criterion.includes('fans')) return row.fans;
    if (criterion === 'first_place') return row.positionValue;
    return row.positionValue;
  }

  pickEliminationTarget() {
    const active = this.active();
    if (active.length <= 1) return null;
    const criterion = this.config.elimination?.criterion ?? 'last_place';
    const highest = criterion === 'first_place' || criterion === 'most_health' || criterion === 'most_fans';
    let best = null;
    for (const row of active) {
      const value = this.rankingValue(row);
      if (best === null) best = row;
      else {
        const better = highest ? value > this.rankingValue(best) : value < this.rankingValue(best);
        const equal = value === this.rankingValue(best);
        if (better || (equal && row.id < best.id)) best = row;
      }
    }
    return best;
  }

  eliminate(row, reason = 'eliminated') {
    if (TERMINAL.has(row.status)) return [];
    row.status = MODE_STATUS.ELIMINATED;
    row.eliminationOrder = this.eliminationOrder.length + 1;
    this.eliminationOrder.push(row.id);
    const events = [this.emit(MODE_EVENT.ELIMINATED, {
      participantId: row.id, order: row.eliminationOrder, reason,
      positionValue: round6(this.rankingValue(row))
    })];
    const directorRow = this.director.byId.get(row.id);
    if (directorRow && directorRow.status === 'running') this.director.dnf(row.id, 'eliminated');
    events.push(this.settleIfDone('elimination'));
    return events;
  }

  applyExplicitElimination(event) {
    const row = this.get(event.participantId ?? event.actorId);
    return this.eliminate(row, event.reason ?? 'eliminated');
  }

  // ------------------------------------------------------------ boss battle
  applyBossWreck(event, isBoss) {
    if (!this.boss) return [];
    const actor = this.get(event.participantId ?? event.actorId);
    const targetId = event.targetId ?? (isBoss ? this.boss.bossId : null);
    const events = [];
    if (isBoss) {
      this.boss.wreckedBoss = true;
      if (this.config.bossBattle?.wreckBossToWin) {
        this.boss.outcome = 'won';
        events.push(this.emit(MODE_EVENT.BOSS_WON, { participantId: actor.id, how: 'wreck-boss' }));
        events.push(...this.finishAll('boss-won', 'won'));
      } else {
        events.push(this.emit(MODE_EVENT.BOSS_STAGE, {
          participantId: actor.id, stage: 'boss-wrecked', wreckBossToWin: false,
          note: 'boss wreck does not win this event'
        }));
      }
      return events;
    }
    this.boss.wreckedMinders += 1;
    const total = this.boss.minderIds.length;
    events.push(this.emit(MODE_EVENT.BOSS_STAGE, {
      participantId: actor.id, stage: 'minder-wrecked', targetId,
      wreckedMinders: this.boss.wreckedMinders, minders: total
    }));
    if (this.config.bossBattle?.wreckMindersToWin && total > 0 && this.boss.wreckedMinders >= total) {
      this.boss.stage = 'boss';
      this.boss.outcome = null;
      events.push(this.emit(MODE_EVENT.BOSS_STAGE, { participantId: actor.id, stage: 'boss' }));
    }
    return events;
  }

  applyGap(event) {
    if (!this.boss) return [];
    const row = this.get(event.participantId ?? event.actorId);
    if (TERMINAL.has(row.status)) return [];
    const cfg = this.config.bossBattle;
    const metres = Number.isFinite(event.metres) ? event.metres : 0;
    const events = [];
    const isBossStage = this.boss.stage === 'boss';
    if (!isBossStage) {
      if (metres >= (cfg.distanceFromMinders ?? Infinity)) {
        row.aheadTicks += 1;
        if (row.aheadTicks >= (cfg.timeInFrontOfMindersTicks ?? 0)) {
          this.boss.stage = 'boss';
          events.push(this.emit(MODE_EVENT.BOSS_STAGE, { participantId: row.id, stage: 'boss' }));
        }
      } else {
        row.aheadTicks = 0;
      }
      return events;
    }
    if (metres >= (cfg.distanceFromBoss ?? Infinity)) {
      const needed = cfg.timeInFrontOfBossTicks ?? 0;
      row.aheadTicks = needed <= 0 ? needed : row.aheadTicks + 1;
      if (row.aheadTicks >= needed) {
        this.boss.outcome = 'won';
        events.push(this.emit(MODE_EVENT.BOSS_WON, { participantId: row.id, how: 'gap', metres: round6(metres) }));
        events.push(...this.finishAll('boss-won', 'won'));
      }
    } else if (metres <= -(cfg.distanceFromBoss ?? Infinity)) {
      row.behindTicks += 1;
      if (row.behindTicks >= (cfg.timeInFrontOfBossTicks ?? 0)) {
        this.boss.outcome = 'lost';
        events.push(this.emit(MODE_EVENT.BOSS_LOST, { participantId: row.id, how: 'gap', metres: round6(metres) }));
        events.push(...this.markDnf(row, 'boss-gap-lost'));
      }
    } else {
      row.aheadTicks = 0;
      row.behindTicks = 0;
    }
    return events;
  }

  // --------------------------------------------------------------- lifecycle
  markDnf(row, reason) {
    if (TERMINAL.has(row.status)) return [];
    row.status = MODE_STATUS.DNF;
    row.dnfReason = reason;
    const events = [this.emit(MODE_EVENT.DNF, { participantId: row.id, reason })];
    const directorRow = this.director.byId.get(row.id);
    if (directorRow && directorRow.status === 'running') this.director.dnf(row.id, reason);
    events.push(this.settleIfDone(reason));
    return events;
  }

  finishParticipant(row, kind = 'finish') {
    if (TERMINAL.has(row.status)) return [];
    row.status = MODE_STATUS.FINISHED;
    row.finishTick = this.director.raceTick;
    row.finishKind = kind;
    const events = [this.emit(MODE_EVENT.FINISH, {
      participantId: row.id, tick: row.finishTick,
      timeSeconds: round6(row.finishTick / this.config.tickHz), kind
    })];
    this.director.finishParticipant(row.id, row.finishTick);
    events.push(this.settleIfDone(kind));
    return events;
  }

  finishAll(kind = 'time', outcome = null) {
    const events = [];
    const active = this.active();
    for (const row of active) {
      row.status = MODE_STATUS.FINISHED;
      row.finishTick = this.director.raceTick;
      row.finishKind = kind;
      row.outcome = outcome;
      events.push(this.emit(MODE_EVENT.FINISH, {
        participantId: row.id, tick: row.finishTick,
        timeSeconds: round6(row.finishTick / this.config.tickHz), kind
      }));
      this.director.finishParticipant(row.id, row.finishTick);
    }
    events.push(this.settleIfDone(kind));
    return events;
  }

  settleIfDone(reason) {
    if (this.raceSettled) return [];
    if (this.director.phase !== RACE_PHASE.RUNNING) return [];
    const pending = this.list().filter((row) => !TERMINAL.has(row.status));
    if (pending.length > 0) {
      if (this.mode !== MODE_KIND.ELIMINATION) return [];
      if (this.active().length > 1) return [];
      // Last survivor wins the elimination.
      const winner = this.active()[0];
      if (!winner) return [];
      winner.status = MODE_STATUS.FINISHED;
      winner.finishTick = this.director.raceTick;
      winner.finishKind = 'last-standing';
      this.director.finishParticipant(winner.id, winner.finishTick);
      return [this.emit(MODE_EVENT.FINISH, {
        participantId: winner.id, tick: winner.finishTick,
        timeSeconds: round6(winner.finishTick / this.config.tickHz), kind: 'last-standing'
      })];
    }
    this.raceSettled = true;
    return [this.emit(MODE_EVENT.RACE_FINISHED, { reason })];
  }

  /** Mirror director terminal states (timeout/disconnect/admin DNF). */
  syncDirector() {
    for (const directorRow of this.director.participants) {
      const row = this.byId.get(directorRow.id);
      if (!row || TERMINAL.has(row.status)) continue;
      if (directorRow.status === 'dnf') {
        row.status = MODE_STATUS.DNF;
        row.dnfReason = directorRow.dnfReason ?? 'dnf';
      } else if (directorRow.status === 'disconnected') {
        row.status = MODE_STATUS.DISCONNECTED;
        row.dnfReason = directorRow.dnfReason ?? 'disconnected';
      } else if (directorRow.status === 'left') {
        row.status = MODE_STATUS.LEFT;
      }
    }
  }

  step(states = null) {
    const events = [];
    events.push(...this.director.advance().map((event) => this.record(event.type, { directorEvent: event })));
    this.syncDirector();
    if (this.director.phase !== RACE_PHASE.RUNNING) {
      if (this.director.phase === RACE_PHASE.FINISHED) {
        // no mode work after the director settles
      }
      return events;
    }

    if (this.progress) {
      if (!this.primed) {
        for (const row of this.list()) {
          const state = stateFor(states, row.id);
          if (state) this.progress.prime(row.id, state, 0);
        }
        this.primed = true;
      } else if (this.director.raceTick > 0) {
        for (const row of this.list()) {
          if (row.status !== MODE_STATUS.ACTIVE) continue;
          const state = stateFor(states, row.id);
          if (!state || row.awaitingRejoin) continue;
          const progressEvents = this.progress.step(row.id, state, this.director.raceTick);
          for (const progressEvent of progressEvents) {
            events.push(this.record(progressEvent.type, { progressEvent }));
          }
          for (const progressEvent of progressEvents) events.push(...this.onProgress(row, progressEvent));
        }
      }
      // Recompute ranking values from progress for elimination.
      for (const row of this.list()) {
        const progressRow = this.progress.get(row.id);
        if (progressRow) {
          row.positionValue = round6(progressRow.lapsCompleted * 1000 +
            progressRow.checkpointsPassed * 10 + progressRow.progress);
        }
      }
    }

    events.push(...this.modeTick());

    // Respawn readiness is an event, not an automatic teleport.
    for (const row of this.list()) {
      if (row.status !== MODE_STATUS.ACTIVE || !row.awaitingRejoin || row.rejoinSignalled) continue;
      if (row.respawnAtTick !== null && this.director.raceTick >= row.respawnAtTick) {
        row.rejoinSignalled = true;
        events.push(this.emit(MODE_EVENT.RESPAWN_READY, {
          participantId: row.id, target: this.progress ? this.progress.policy.targetFor({
            lastGateIndex: Math.max(0, (this.progress.get(row.id)?.gateIndex ?? 1) - 1)
          }) : null
        }));
      }
    }

    this.syncDirector();
    events.push(...this.settleIfDone('running'));
    return events;
  }

  onProgress(row, event) {
    const events = [];
    if (event.type === 'checkpoint') {
      if (this.mode === MODE_KIND.CHECKPOINT) events.push(...this.applyCheckpoint({
        participantId: row.id, checkpointIndex: event.gateIndex
      }));
      if (this.mode === MODE_KIND.POINTS) events.push(...this.applyScore({
        participantId: row.id, points: 0, reason: 'checkpoint'
      }));
    } else if (event.type === 'finish') {
      if (this.mode === MODE_KIND.CHECKPOINT) {
        const cp = this.config.checkpoint;
        const left = row.timeLeftSeconds ?? cp.initialTimeSeconds;
        row.medal = left >= cp.goldTimeRemainingSeconds ? 'gold'
          : left >= cp.silverTimeRemainingSeconds ? 'silver'
            : left >= 0 ? 'bronze' : 'incomplete';
        if (left < 0) return this.markDnf(row, 'checkpoint-timeout');
      }
      if (this.mode === MODE_KIND.BOSS_BATTLE) {
        // Crossing the finish is still required for the gate model, but the
        // objective is the boss stage; do not finish on the lap line.
        return events;
      }
      events.push(...this.finishParticipant(row, 'finish'));
    }
    return events;
  }

  modeTick() {
    const events = [];
    const tick = this.director.raceTick;
    const seconds = tick / this.config.tickHz;
    if (this.mode === MODE_KIND.CHECKPOINT) {
      for (const row of this.list()) {
        if (row.status !== MODE_STATUS.ACTIVE) continue;
        if (row.checkpointIndex <= 0) continue;
        row.timeLeftSeconds = round6(row.timeLeftSeconds - 1 / this.config.tickHz);
        if (row.timeLeftSeconds < 0) events.push(...this.markDnf(row, 'checkpoint-timeout'));
      }
    }
    if (this.config.scoreTarget > 0 && this.config.finishOn === 'score') {
      for (const row of this.list()) {
        if (row.status === MODE_STATUS.ACTIVE && row.score >= this.config.scoreTarget) {
          events.push(...this.checkScoreTarget(row));
        }
      }
    }
    if (this.config.timeLimitSeconds > 0) {
      const limitTicks = Math.round(this.config.timeLimitSeconds * this.config.tickHz);
      if (tick >= limitTicks) {
        events.push(this.emit(MODE_EVENT.TIME_EXPIRED, {
          tick, limitSeconds: this.config.timeLimitSeconds
        }));
        events.push(...this.finishAll('time'));
      }
    }
    if (this.mode === MODE_KIND.ELIMINATION) {
      const period = this.config.elimination?.periodTicks ?? 0;
      if (period > 0) {
        if (this.nextEliminationTick === null) this.nextEliminationTick = period;
        while (tick >= this.nextEliminationTick && this.active().length > 1) {
          const target = this.pickEliminationTarget();
          if (!target) break;
          events.push(...this.eliminate(target, 'period'));
          this.nextEliminationTick += period;
        }
        if (this.active().length <= 1) events.push(...this.settleIfDone('last-standing'));
      }
    }
    return events;
  }

  /** Continue after an engine rebuild. Progress is kept. */
  rejoin(id, state = null) {
    const row = this.get(id);
    if (TERMINAL.has(row.status)) return row;
    row.awaitingRejoin = false;
    row.rejoinSignalled = false;
    row.respawnAtTick = null;
    row.health = 100;
    if (this.progress && state) this.progress.rejoin(id, state, this.director.raceTick);
    return row;
  }

  // ---------------------------------------------------------------- results
  resultGroup(row) {
    if (row.status === MODE_STATUS.FINISHED) return 0;
    if (row.status === MODE_STATUS.ACTIVE) return 1;
    if (row.status === MODE_STATUS.ELIMINATED) return 2;
    if (row.status === MODE_STATUS.DNF) return 3;
    if (row.status === MODE_STATUS.DISCONNECTED) return 4;
    return 5;
  }

  compareRows(a, b) {
    const group = this.resultGroup(a) - this.resultGroup(b);
    if (group !== 0) return group;
    if (this.mode === MODE_KIND.ELIMINATION) {
      if (a.status === MODE_STATUS.FINISHED && b.status === MODE_STATUS.FINISHED) {
        return (a.finishTick ?? 0) - (b.finishTick ?? 0);
      }
      if (a.status === MODE_STATUS.ELIMINATED && b.status === MODE_STATUS.ELIMINATED) {
        return (b.eliminationOrder ?? 0) - (a.eliminationOrder ?? 0);
      }
    }
    if (this.mode === MODE_KIND.POINTS || this.mode === MODE_KIND.DESTRUCTION) {
      if (a.score !== b.score) return b.score - a.score;
      if (a.fans !== b.fans) return b.fans - a.fans;
      if (a.finishTick !== b.finishTick) {
        if (a.finishTick === null) return 1;
        if (b.finishTick === null) return -1;
        return a.finishTick - b.finishTick;
      }
    }
    if (this.mode === MODE_KIND.CHECKPOINT) {
      if (a.status === MODE_STATUS.FINISHED && b.status === MODE_STATUS.FINISHED) {
        if (a.finishTick !== b.finishTick) return a.finishTick - b.finishTick;
        return (b.timeLeftSeconds ?? 0) - (a.timeLeftSeconds ?? 0);
      }
    }
    if (this.mode === MODE_KIND.BOSS_BATTLE) {
      const ao = a.outcome === 'won' ? 1 : 0;
      const bo = b.outcome === 'won' ? 1 : 0;
      if (ao !== bo) return bo - ao;
      if (a.finishTick !== b.finishTick) {
        if (a.finishTick === null) return 1;
        if (b.finishTick === null) return -1;
        return a.finishTick - b.finishTick;
      }
    }
    if (a.status === MODE_STATUS.FINISHED && b.status === MODE_STATUS.FINISHED) {
      if (a.finishTick !== b.finishTick) return a.finishTick - b.finishTick;
    }
    if (a.positionValue !== b.positionValue) return b.positionValue - a.positionValue;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  results() {
    const rows = this.list().map((row) => {
      const progressRow = this.progress ? this.progress.get(row.id) : null;
      return {
        id: row.id,
        slot: row.slot,
        team: row.team,
        status: row.status,
        score: round6(row.score),
        fans: round6(row.fans),
        wrecks: row.wrecks,
        damageDealt: row.damageDealt,
        damageTaken: row.damageTaken,
        health: round6(row.health),
        lapsCompleted: progressRow?.lapsCompleted ?? 0,
        checkpointsPassed: progressRow?.checkpointsPassed ?? row.checkpointIndex,
        progress: progressRow ? round6(progressRow.progress) : 0,
        finishTick: row.finishTick,
        finishKind: row.finishKind,
        totalTimeSeconds: row.finishTick === null ? null : round6(row.finishTick / this.config.tickHz),
        timeLeftSeconds: row.timeLeftSeconds === null ? null : round6(row.timeLeftSeconds),
        medal: row.medal,
        eliminationOrder: row.eliminationOrder,
        positionValue: round6(row.positionValue),
        dnfReason: row.dnfReason,
        outcome: row.outcome ?? null,
        tied: false,
        position: null
      };
    }).sort((a, b) => this.compareRows(a, b));

    let lastKey = null;
    let lastPosition = 0;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const tieKey = (this.mode === MODE_KIND.POINTS || this.mode === MODE_KIND.DESTRUCTION)
        ? row.status + '|' + row.score + '|' + row.fans
        : (row.status === MODE_STATUS.ELIMINATED
          ? 'eliminated|' + row.eliminationOrder
          : row.status + '|' + row.finishTick);
      if (tieKey === lastKey) {
        row.position = lastPosition;
        row.tied = true;
        if (index > 0) rows[index - 1].tied = true;
      } else {
        row.position = index + 1;
        lastPosition = row.position;
        lastKey = tieKey;
      }
    }
    const ties = [];
    const byPosition = new Map();
    for (const row of rows) {
      if (!byPosition.has(row.position)) byPosition.set(row.position, []);
      byPosition.get(row.position).push(row.id);
    }
    for (const [position, ids] of byPosition) {
      if (ids.length > 1) ties.push({ position, participants: ids });
    }
    return {
      schema: 'blur.race-rules.mode-results/1',
      mode: this.mode,
      rulesKind: this.mode,
      order: rows.map((row) => row.id),
      winner: rows[0]?.id ?? null,
      rows,
      ties,
      ordering: MODE_RULES[this.mode]?.tieBreak ?? 'status, then id'
    };
  }

  clock() {
    const limitTicks = this.config.timeLimitSeconds > 0
      ? Math.round(this.config.timeLimitSeconds * this.config.tickHz) : 0;
    return {
      tickHz: this.config.tickHz,
      raceTick: this.director.raceTick,
      elapsedSeconds: round6(this.director.raceTick / this.config.tickHz),
      timeLimitSeconds: this.config.timeLimitSeconds,
      remainingTicks: limitTicks > 0 ? Math.max(0, limitTicks - this.director.raceTick) : null,
      remainingSeconds: limitTicks > 0
        ? round6(Math.max(0, limitTicks - this.director.raceTick) / this.config.tickHz) : null
    };
  }

  snapshot() {
    const director = this.director.snapshot();
    const progress = this.progress ? this.progress.snapshot() : null;
    const body = {
      schema: 'blur.race-rules.mode-session/1',
      mode: this.mode,
      rulesKind: this.mode,
      rules: MODE_RULES[this.mode],
      phase: this.phase,
      tick: this.director.tick,
      raceTick: this.director.raceTick,
      clock: this.clock(),
      authority: director.authority,
      config: {
        source: this.config.source,
        finishOn: this.config.finishOn,
        laps: this.config.laps,
        timeLimitSeconds: this.config.timeLimitSeconds,
        scoreTarget: this.config.scoreTarget,
        scoringRules: this.config.scoringTable.length,
        powerupsEnabled: this.config.powerupsEnabled,
        teams: this.config.teams,
        damageMode: this.config.damageMode,
        respawn: this.config.respawn,
        minParticipants: this.config.minParticipants,
        maxParticipants: this.config.maxParticipants
      },
      participants: this.list().map((row) => ({
        id: row.id, slot: row.slot, team: row.team, status: row.status,
        score: round6(row.score), fans: round6(row.fans), health: round6(row.health),
        wrecks: row.wrecks, finishTick: row.finishTick, finishKind: row.finishKind,
        dnfReason: row.dnfReason, eliminationOrder: row.eliminationOrder,
        awaitingRejoin: row.awaitingRejoin, respawnAtTick: row.respawnAtTick,
        timeLeftSeconds: row.timeLeftSeconds === null ? null : round6(row.timeLeftSeconds),
        checkpointIndex: row.checkpointIndex, medal: row.medal,
        bossStage: row.bossStage, outcome: row.outcome ?? null
      })),
      progress,
      elimination: this.config.elimination ? {
        criterion: this.config.elimination.criterion ?? 'last_place',
        event: this.config.elimination.event ?? 'time',
        periodTicks: this.config.elimination.periodTicks ?? 0,
        nextTick: this.nextEliminationTick,
        order: this.eliminationOrder.slice(),
        source: this.config.elimination.source ?? 'provisional'
      } : null,
      boss: this.boss ? { ...this.boss } : null,
      results: this.results()
    };
    return body;
  }

  hash() {
    return hashOf(this.snapshot());
  }

  eventLogHash() {
    return hashOf(this.eventLog);
  }

  replayHash() {
    return hashOf({ snapshot: this.snapshot(), events: this.eventLog });
  }
}

export { RaceDirector, RACE_PHASE };
