// Race-mode tests for the E1 drive page.
//
// Runs without a browser or GPU. It drives the real `race-modes.js` module with
// the committed retail values and checks:
//   * the checkpoint time bank (+16 s per checkpoint, 40 s initial),
//   * the committed medal thresholds (gold 20 / silver 10 / bronze 0),
//   * expiry before the finish,
//   * the Motor Mash scoring (wreck 5, rival x2, suicide 1),
//   * the 180 s round timer,
//   * the typed unsupported damage split,
//   * the `?mode=` validator.
//
// Usage:
//   node probes/e1-drive/tools/race_modes_tests.mjs
//
// Writes `_work/e1-drive/race-modes-report.json`.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHECKPOINT_MODE, DESTRUCTION_MODE, ELIMINATION_MODE, POINTS_MODE,
  checkpointState, createDestructionScoreboard, createEliminationTracker, createPointsScoreboard,
  raceModeFor
} from '../web/race-modes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(ROOT, '_work/e1-drive');

let checks = 0;
const failures = [];
function check(label, condition, detail) {
  checks++;
  if (!condition) failures.push(label + (detail === undefined ? '' : ': ' + JSON.stringify(detail)));
}
const close = (a, b) => Math.abs(a - b) < 1e-6;

// ---------------------------------------------------------------- checkpoint
check('checkpoint: initial time is the committed 40 s', CHECKPOINT_MODE.initialTimeSeconds === 40,
  CHECKPOINT_MODE.initialTimeSeconds);
check('checkpoint: the award table is the committed 12-entry array',
  CHECKPOINT_MODE.timeAwardedSeconds.length === 12 &&
    CHECKPOINT_MODE.timeAwardedSeconds[0] === 0 &&
    CHECKPOINT_MODE.timeAwardedSeconds.slice(1).every((value) => value === 16),
  CHECKPOINT_MODE.timeAwardedSeconds);
check('checkpoint: the medal thresholds are 20 / 10 / 0',
  CHECKPOINT_MODE.goldTimeRemainingSeconds === 20 &&
    CHECKPOINT_MODE.silverTimeRemainingSeconds === 10 &&
    CHECKPOINT_MODE.bronzeTimeRemainingSeconds === 0);

const start = checkpointState({ elapsedSeconds: 0, checkpointsPassed: 0 });
check('checkpoint: the bank starts at 40 s', close(start.timeLeftSeconds, 40), start.timeLeftSeconds);
check('checkpoint: no medal while running', start.medal === null);

const oneCheckpoint = checkpointState({ elapsedSeconds: 10, checkpointsPassed: 1 });
check('checkpoint: one checkpoint pays 16 s', oneCheckpoint.awardedSeconds === 16,
  oneCheckpoint.awardedSeconds);
check('checkpoint: the bank is 40 + 16 - 10', close(oneCheckpoint.timeLeftSeconds, 46),
  oneCheckpoint.timeLeftSeconds);

const twoCheckpoints = checkpointState({ elapsedSeconds: 20, checkpointsPassed: 2 });
check('checkpoint: two checkpoints pay 32 s', twoCheckpoints.awardedSeconds === 32,
  twoCheckpoints.awardedSeconds);
check('checkpoint: the bank is 40 + 32 - 20', close(twoCheckpoints.timeLeftSeconds, 52),
  twoCheckpoints.timeLeftSeconds);

const expired = checkpointState({ elapsedSeconds: 50, checkpointsPassed: 0 });
check('checkpoint: an empty bank before the finish expires', expired.expired === true,
  expired);

const gold = checkpointState({ elapsedSeconds: 10, checkpointsPassed: 2, finished: true, finishTimeSeconds: 10 });
check('checkpoint: gold at 20 s or more remaining', gold.medal === 'gold', gold);
const silver = checkpointState({ elapsedSeconds: 55, checkpointsPassed: 2, finished: true, finishTimeSeconds: 55 });
check('checkpoint: silver at 10 s or more remaining', silver.medal === 'silver', silver);
const bronze = checkpointState({ elapsedSeconds: 65, checkpointsPassed: 2, finished: true, finishTimeSeconds: 65 });
check('checkpoint: bronze at 0 s or more remaining', bronze.medal === 'bronze', bronze);
const none = checkpointState({ elapsedSeconds: 75, checkpointsPassed: 2, finished: true, finishTimeSeconds: 75 });
check('checkpoint: no medal below 0 s remaining', none.medal === 'none', none);

// --------------------------------------------------------------- destruction
check('destruction: the round is the committed 180 s', DESTRUCTION_MODE.timeLimitSeconds === 180);
check('destruction: the scoring table is wreck 5 / suicide 1 / rival x2',
  DESTRUCTION_MODE.scoring.wreck === 5 && DESTRUCTION_MODE.scoring.suicide === 1 &&
    DESTRUCTION_MODE.scoring.rivalDamageMultiplier === 2, DESTRUCTION_MODE.scoring);
check('destruction: the damage split is typed unsupported',
  DESTRUCTION_MODE.damageScoring.status === 'unsupported' &&
    /threshold/.test(DESTRUCTION_MODE.damageScoring.reason), DESTRUCTION_MODE.damageScoring);

const board = createDestructionScoreboard({ participants: ['host', 'guest'] });
let snapshot = board.snapshot();
check('destruction: both participants start at 0', snapshot.rows.length === 2 &&
  snapshot.rows.every((row) => row.score === 0), snapshot.rows);
check('destruction: the timer starts at 180 s', close(snapshot.timeLeftSeconds, 180),
  snapshot.timeLeftSeconds);

board.tick(10);
snapshot = board.snapshot();
check('destruction: the timer counts down', close(snapshot.timeLeftSeconds, 170),
  snapshot.timeLeftSeconds);

board.ingest({ type: 'wreck', actorId: 'host', targetId: 'guest', rival: true });
snapshot = board.snapshot();
const hostRow = snapshot.rows.find((row) => row.id === 'host');
check('destruction: a rival wreck is 5 x 2 = 10 points', hostRow.score === 10, hostRow);
check('destruction: the wreck is counted', hostRow.wrecks === 1 && hostRow.rivalWrecks === 1, hostRow);

board.ingest({ type: 'wreck', actorId: 'guest', targetId: 'host', rival: false });
snapshot = board.snapshot();
const guestRow = snapshot.rows.find((row) => row.id === 'guest');
check('destruction: a non-rival wreck is 5 points', guestRow.score === 5, guestRow);
check('destruction: the leader is the higher score', snapshot.rows[0].id === 'host', snapshot.rows);

board.ingest({ type: 'suicide', actorId: 'host' });
snapshot = board.snapshot();
check('destruction: a suicide subtracts the committed 1 point',
  snapshot.rows.find((row) => row.id === 'host').score === 9,
  snapshot.rows.find((row) => row.id === 'host'));

board.tick(200);
snapshot = board.snapshot();
check('destruction: the round finishes at the time limit',
  snapshot.finished === true && snapshot.timeLeftSeconds === 0, snapshot);

// -------------------------------------------------------------------- points
check('points: the round length is the labelled provisional 180 s',
  POINTS_MODE.timeLimitSeconds === 180 && /provisional/.test(POINTS_MODE.timeLimitSource),
  POINTS_MODE.timeLimitSource);
check('points: the labelled scoring rows are the committed values',
  POINTS_MODE.scoring.Shunt === 1 && POINTS_MODE.scoring.Bomb === 1 &&
    POINTS_MODE.scoring.BatteringRam === 3 && POINTS_MODE.scoring.Level2Shunt === 2,
  POINTS_MODE.scoring);
check('points: the 7 unlabelled rows are a typed unsupported entry',
  POINTS_MODE.unlabelledRows.count === 7 && POINTS_MODE.unlabelledRows.status === 'unsupported',
  POINTS_MODE.unlabelledRows);

const points = createPointsScoreboard({ participants: ['host', 'guest'] });
let pointsSnapshot = points.snapshot();
check('points: both participants start at 0', pointsSnapshot.rows.length === 2 &&
  pointsSnapshot.rows.every((row) => row.score === 0), pointsSnapshot.rows);
points.ingest({ event: 'Shunt', actorId: 'host' });
points.ingest({ event: 'Bomb', actorId: 'host' });
points.ingest({ event: 'BatteringRam', actorId: 'guest' });
pointsSnapshot = points.snapshot();
check('points: Shunt + Bomb score 2', pointsSnapshot.rows.find((row) => row.id === 'host').score === 2,
  pointsSnapshot.rows);
check('points: BatteringRam scores the committed 3',
  pointsSnapshot.rows.find((row) => row.id === 'guest').score === 3, pointsSnapshot.rows);
check('points: the leader is the higher score', pointsSnapshot.rows[0].id === 'guest',
  pointsSnapshot.rows);
check('points: an unknown event scores nothing', (() => {
  const before = points.snapshot().rows.reduce((sum, row) => sum + row.score, 0);
  points.ingest({ event: 'NotARow', actorId: 'host' });
  return points.snapshot().rows.reduce((sum, row) => sum + row.score, 0) === before;
})());
points.tick(200);
check('points: the round finishes at the time limit', points.snapshot().finished === true);

// --------------------------------------------------------------- elimination
check('elimination: the period and criterion are provisional',
  ELIMINATION_MODE.provisional === true && ELIMINATION_MODE.periodSeconds === 30 &&
    ELIMINATION_MODE.criterion === 'last-place' && /not serialized/.test(ELIMINATION_MODE.reason),
  ELIMINATION_MODE);

const elimination = createEliminationTracker({ participants: ['host', 'guest', 'third'] });
elimination.setProgress('host', 100);
elimination.setProgress('guest', 50);
elimination.setProgress('third', 10);
let eliminationSnapshot = elimination.tick(0);
check('elimination: three participants start active', eliminationSnapshot.activeCount === 3,
  eliminationSnapshot.activeCount);
eliminationSnapshot = elimination.tick(30);
check('elimination: the last-ranked racer is eliminated after one period',
  eliminationSnapshot.activeCount === 2 && eliminationSnapshot.order[0] === 'third',
  eliminationSnapshot.order);
eliminationSnapshot = elimination.tick(30);
check('elimination: the next last-ranked racer is eliminated',
  eliminationSnapshot.activeCount === 1 && eliminationSnapshot.winner === 'host',
  eliminationSnapshot);
check('elimination: the winner is the last one standing', eliminationSnapshot.finished === true);

// ------------------------------------------------------------------- mode id
check('mode: sprint maps to the default', raceModeFor('sprint') === null);
check('mode: checkpoint is accepted', raceModeFor('checkpoint') === 'checkpoint');
check('mode: destruction is accepted', raceModeFor('destruction') === 'destruction');
check('mode: points is accepted', raceModeFor('points') === 'points');
check('mode: elimination is accepted', raceModeFor('elimination') === 'elimination');
let rejected = false;
try { raceModeFor('boss-battle'); } catch { rejected = true; }
check('mode: an unknown mode is rejected', rejected);

const report = {
  schema: 'e1-drive.race-modes-tests/1',
  checks,
  failures,
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  checkpoint: CHECKPOINT_MODE,
  destruction: DESTRUCTION_MODE
};
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'race-modes-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

if (failures.length) {
  console.error('race-mode tests FAILED');
  for (const failure of failures) console.error('  ' + failure);
  process.exit(1);
}
console.log(checks + '/' + checks + ' race-mode checks passed');
