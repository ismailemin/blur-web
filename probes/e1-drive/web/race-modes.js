// Checkpoint and Destruction race modes for the E1 drive page.
//
// Every number here is a committed retail value; the source is named on each
// block. The module is pure (no DOM, no engine, no network) so the page and the
// node tests share exactly one implementation.
//
// Checkpoint (`singleplayer.bin` AmaxRaceModeCheckpointVars, easy row):
//   initialTime 40 s, timeAwarded [0, 16 x 11], stopwatchIncTime 2 s,
//   gold 20 s / silver 10 s / bronze 0 s remaining.
//
// Destruction (`multiplayer.bin` MultiplayerConfig.motormashScoringValues):
//   wreck 5, suicide 1, rival damage x2, respawn delay multipliers [1, 10, 20] s,
//   MultiplayerRace.time = 180 s.
//   The low/high damage split (1 / 2 points) is NOT applied: the threshold that
//   separates them is not serialized, so damage points are a typed unsupported
//   entry rather than a guessed boundary.
export const CHECKPOINT_MODE = Object.freeze({
  schema: 'e1-drive.checkpoint-mode/1',
  id: 'checkpoint',
  label: 'Checkpoint',
  initialTimeSeconds: 40,
  timeAwardedSeconds: Object.freeze([0, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16]),
  stopwatchIncTimeSeconds: 2,
  goldTimeRemainingSeconds: 20,
  silverTimeRemainingSeconds: 10,
  bronzeTimeRemainingSeconds: 0,
  source: 'singleplayer.bin AmaxRaceModeCheckpointVars (easy row): initialTime, timeAwarded, stopwatchIncTime, gold/silver/bronzeTimeRemaining'
});

export const DESTRUCTION_MODE = Object.freeze({
  schema: 'e1-drive.destruction-mode/1',
  id: 'destruction',
  label: 'Destruction',
  timeLimitSeconds: 180,
  minParticipants: 2,
  scoring: Object.freeze({ wreck: 5, suicide: 1, rivalDamageMultiplier: 2 }),
  damageScoring: Object.freeze({
    lowDamage: 1,
    highDamage: 2,
    status: 'unsupported',
    reason: 'the low/high damage threshold is not serialized in MultiplayerConfig.motormashScoringValues'
  }),
  respawnDelayMultipliers: Object.freeze([1, 10, 20]),
  source: 'multiplayer.bin MultiplayerConfig.motormashScoringValues; MultiplayerRace.time = 180 s (31/31 rows)'
});


/**
 * Points (multiplayer fan score). The committed scoring table is
 * `MultiplayerConfig.scoring` (26 rows, 1-25 points). Seven of the 26 rows carry
 * no serialized `ScoringEvent` label, so they are a typed unsupported entry
 * rather than a guessed mapping. No shipped `MultiplayerRace` row gives this
 * mode a time limit; 180 s is the shipped destruction round length, used as a
 * labelled provisional period.
 */
export const POINTS_MODE = Object.freeze({
  schema: 'e1-drive.points-mode/1',
  id: 'points',
  label: 'Points',
  timeLimitSeconds: 180,
  timeLimitSource: 'provisional: no shipped MultiplayerRace row for points; 180 s is the shipped destruction round length',
  minParticipants: 2,
  scoring: Object.freeze({
    Shunt: 1, Shock: 1, Barge: 1, Bomb: 1,
    Level2Shunt: 2, Level2Shock: 2, Level2Barge: 2, Level2Bomb: 2, DoubleBarge: 2,
    Drifting: 1, Air: 1, ShuntOvertake: 1, NitrousOvertake: 1, ShockOvertake: 1,
    SkillShotNitrous: 1, BatteringRam: 3
  }),
  unlabelledRows: Object.freeze({
    count: 7,
    status: 'unsupported',
    reason: '7 of the 26 MultiplayerConfig.scoring rows carry no serialized ScoringEvent label; their event is not guessed'
  }),
  source: 'multiplayer.bin MultiplayerConfig.scoring (26 rows); the labelled 19 rows are applied'
});

/**
 * Elimination. The period and the criterion are provisional: the retail source
 * uses `LevelState.mTimeLimit` and `E_EliminationType`, and no shipped
 * `MultiplayerRace` row serializes either for an event. The tracker eliminates
 * the last-ranked participant every `periodSeconds` and the last one standing
 * wins.
 */
export const ELIMINATION_MODE = Object.freeze({
  schema: 'e1-drive.elimination-mode/1',
  id: 'elimination',
  label: 'Elimination',
  periodSeconds: 30,
  criterion: 'last-place',
  minParticipants: 2,
  provisional: true,
  reason: 'the period and criterion are not serialized for an event (LevelState.mTimeLimit / E_EliminationType); 30 s and last-place are a labelled project choice',
  source: 'RaceModeMultiplayerElimination.cpp; no shipped MultiplayerRace row'
});

/** Points scoreboard: one row per participant, scored from typed events. */
export function createPointsScoreboard({ participants = [], timeLimitSeconds = POINTS_MODE.timeLimitSeconds } = {}) {
  const rows = new Map();
  for (const entry of participants) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id === 'string' && id.length) rows.set(id, { id, score: 0, events: 0 });
  }
  let elapsedSeconds = 0;
  const log = [];
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { id, score: 0, events: 0 });
    return rows.get(id);
  };
  return {
    schema: POINTS_MODE.schema,
    mode: POINTS_MODE.id,
    timeLimitSeconds,
    tick(dtSeconds) {
      const dt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : 0;
      elapsedSeconds += dt;
      return this.snapshot();
    },
    /** `{ event: 'Shunt' | 'Shock' | 'Barge' | 'Bomb', actorId }`. */
    ingest(event) {
      if (!event || typeof event !== 'object' || typeof event.actorId !== 'string') return this.snapshot();
      const points = POINTS_MODE.scoring[event.event];
      if (!Number.isFinite(points)) return this.snapshot();
      const actor = row(event.actorId);
      actor.score += points;
      actor.events += 1;
      log.push({ event: event.event, actorId: event.actorId, points });
      return this.snapshot();
    },
    snapshot() {
      const sorted = [...rows.values()]
        .map((entry) => ({ ...entry }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return {
        schema: POINTS_MODE.schema,
        mode: POINTS_MODE.id,
        timeLimitSeconds,
        timeLeftSeconds: round3(Math.max(0, timeLimitSeconds - elapsedSeconds)),
        elapsedSeconds: round3(elapsedSeconds),
        finished: elapsedSeconds >= timeLimitSeconds,
        rows: sorted,
        events: log.slice(),
        scoring: { ...POINTS_MODE.scoring },
        unlabelledRows: { ...POINTS_MODE.unlabelledRows }
      };
    }
  };
}

/**
 * Elimination tracker. `progress` is the caller's ranking value (higher is
 * better, e.g. the measured arc); every `periodSeconds` the lowest value is
 * eliminated. The last participant standing wins.
 */
export function createEliminationTracker({ participants = [], periodSeconds = ELIMINATION_MODE.periodSeconds } = {}) {
  const rows = new Map();
  for (const entry of participants) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id === 'string' && id.length) rows.set(id, { id, progress: 0, eliminated: false, order: null });
  }
  const order = [];
  let elapsedSeconds = 0;
  let nextAt = periodSeconds;
  let winner = null;
  return {
    schema: ELIMINATION_MODE.schema,
    mode: ELIMINATION_MODE.id,
    periodSeconds,
    setProgress(id, progress) {
      const row = rows.get(id);
      if (row && !row.eliminated && Number.isFinite(progress)) row.progress = progress;
    },
    tick(dtSeconds) {
      const dt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : 0;
      elapsedSeconds += dt;
      while (elapsedSeconds >= nextAt) {
        nextAt += periodSeconds;
        const active = [...rows.values()].filter((row) => !row.eliminated);
        if (active.length <= 1) break;
        active.sort((a, b) => a.progress - b.progress || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const victim = active[0];
        victim.eliminated = true;
        victim.order = order.length + 1;
        order.push(victim.id);
      }
      const active = [...rows.values()].filter((row) => !row.eliminated);
      if (active.length === 1) winner = active[0].id;
      return this.snapshot();
    },
    snapshot() {
      const list = [...rows.values()].map((row) => ({ ...row }));
      const active = list.filter((row) => !row.eliminated);
      return {
        schema: ELIMINATION_MODE.schema,
        mode: ELIMINATION_MODE.id,
        periodSeconds,
        elapsedSeconds: round3(elapsedSeconds),
        nextEliminationInSeconds: round3(Math.max(0, nextAt - elapsedSeconds)),
        activeCount: active.length,
        finished: winner !== null,
        winner,
        order: order.slice(),
        rows: list,
        provisional: ELIMINATION_MODE.provisional,
        reason: ELIMINATION_MODE.reason
      };
    }
  };
}

const round3 = (value) => Math.round(value * 1e3) / 1e3;

/**
 * The checkpoint time bank for a sprint snapshot.
 *
 * `timeLeft = initialTime + sum(timeAwarded[1..checkpointsPassed]) - elapsed`
 * (the finish time when the run is finished). The medal is the committed
 * remaining-time threshold; a run that empties the bank before the finish is
 * `expired` and has no medal.
 */
export function checkpointState({
  elapsedSeconds = 0,
  checkpointsPassed = 0,
  finished = false,
  finishTimeSeconds = null
} = {}) {
  const passed = Math.max(0, Math.min(CHECKPOINT_MODE.timeAwardedSeconds.length - 1, Math.floor(checkpointsPassed)));
  let awarded = 0;
  for (let index = 1; index <= passed; index++) awarded += CHECKPOINT_MODE.timeAwardedSeconds[index];
  const clock = finished && Number.isFinite(finishTimeSeconds) ? finishTimeSeconds : elapsedSeconds;
  const timeLeft = CHECKPOINT_MODE.initialTimeSeconds + awarded - clock;
  const expired = !finished && timeLeft < 0;
  let medal = null;
  if (finished) {
    medal = timeLeft >= CHECKPOINT_MODE.goldTimeRemainingSeconds ? 'gold'
      : timeLeft >= CHECKPOINT_MODE.silverTimeRemainingSeconds ? 'silver'
        : timeLeft >= CHECKPOINT_MODE.bronzeTimeRemainingSeconds ? 'bronze' : 'none';
  }
  return {
    schema: CHECKPOINT_MODE.schema,
    mode: CHECKPOINT_MODE.id,
    timeLeftSeconds: round3(timeLeft),
    awardedSeconds: awarded,
    checkpointsPassed: passed,
    clockSeconds: round3(clock),
    expired,
    finished,
    medal
  };
}

/**
 * Destruction scoreboard. It consumes typed wreck/suicide events and keeps a
 * per-player score plus the remaining round time.
 *
 * `rival` is the team/opponent flag the caller supplies for the target; a rival
 * wreck is multiplied by the committed `rivalDamageMultiplier`.
 */
export function createDestructionScoreboard({ participants = [], timeLimitSeconds = DESTRUCTION_MODE.timeLimitSeconds } = {}) {
  const scores = new Map();
  for (const entry of participants) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id === 'string' && id.length) scores.set(id, { id, score: 0, wrecks: 0, suicides: 0, rivalWrecks: 0 });
  }
  let elapsedSeconds = 0;
  const events = [];
  const row = (id) => {
    if (!scores.has(id)) scores.set(id, { id, score: 0, wrecks: 0, suicides: 0, rivalWrecks: 0 });
    return scores.get(id);
  };
  return {
    schema: DESTRUCTION_MODE.schema,
    mode: DESTRUCTION_MODE.id,
    timeLimitSeconds,
    tick(dtSeconds) {
      const dt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : 0;
      elapsedSeconds += dt;
      return this.snapshot();
    },
    /** `{ type: 'wreck', actorId, targetId, rival }` or `{ type: 'suicide', actorId }`. */
    ingest(event) {
      if (!event || typeof event !== 'object') return this.snapshot();
      if (event.type === 'wreck' && typeof event.actorId === 'string') {
        const actor = row(event.actorId);
        const rival = event.rival === true;
        const points = DESTRUCTION_MODE.scoring.wreck * (rival ? DESTRUCTION_MODE.scoring.rivalDamageMultiplier : 1);
        actor.score += points;
        actor.wrecks += 1;
        if (rival) actor.rivalWrecks += 1;
        events.push({ type: 'wreck', actorId: event.actorId, targetId: event.targetId ?? null, rival, points });
      } else if (event.type === 'suicide' && typeof event.actorId === 'string') {
        const actor = row(event.actorId);
        actor.score -= DESTRUCTION_MODE.scoring.suicide;
        actor.suicides += 1;
        events.push({ type: 'suicide', actorId: event.actorId, points: -DESTRUCTION_MODE.scoring.suicide });
      }
      return this.snapshot();
    },
    snapshot() {
      const rows = [...scores.values()]
        .map((entry) => ({ ...entry }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return {
        schema: DESTRUCTION_MODE.schema,
        mode: DESTRUCTION_MODE.id,
        timeLimitSeconds,
        timeLeftSeconds: round3(Math.max(0, timeLimitSeconds - elapsedSeconds)),
        elapsedSeconds: round3(elapsedSeconds),
        finished: elapsedSeconds >= timeLimitSeconds,
        rows,
        events: events.slice(),
        scoring: { ...DESTRUCTION_MODE.scoring },
        damageScoring: { ...DESTRUCTION_MODE.damageScoring }
      };
    }
  };
}

/** Which mode a `?mode=` value selects, or null for the sprint default. */
export function raceModeFor(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value === 'sprint') return null;
  if (value === CHECKPOINT_MODE.id) return CHECKPOINT_MODE.id;
  if (value === DESTRUCTION_MODE.id) return DESTRUCTION_MODE.id;
  if (value === POINTS_MODE.id) return POINTS_MODE.id;
  if (value === ELIMINATION_MODE.id) return ELIMINATION_MODE.id;
  throw new Error('mode must be sprint, checkpoint, destruction, points or elimination (got ' +
    JSON.stringify(value) + ')');
}
