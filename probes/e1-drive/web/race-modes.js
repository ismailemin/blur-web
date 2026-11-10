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
  throw new Error('mode must be sprint, checkpoint or destruction (got ' + JSON.stringify(value) + ')');
}
