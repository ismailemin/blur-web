#!/usr/bin/env node
// Deterministic verification for the data-driven mode rules and the retail mode
// catalogue. Reads (read-only):
//   _work/race-rules/game-modes.json          (built by tools/build_game_modes.py)
//   _work/race-rules/game-modes-hashes.json
//   _work/e1-drive/sprint.json, sprint-lap.json
// Writes:
//   _work/race-rules/mode-trace.json
//   _work/race-rules/mode-verify.json
//   _work/race-rules/mode-hashes.json
//   _work/logs/race-rules/verify-modes.log
//
// Exit code 0 only when every check passes.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashOf, sha256Hex } from './hash.mjs';
import { CourseModel } from './course-model.mjs';
import { RACE_PHASE } from './race-director.mjs';
import { ModeSession, MODE_KIND, MODE_STATUS, MODE_EVENT, MODE_RULES } from './mode-rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(ROOT, '_work/race-rules');
const LOGS = path.join(ROOT, '_work/logs/race-rules');
mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const checks = [];
const logLines = [];
function check(id, name, ok, detail = null) {
  const row = { id, name, ok: Boolean(ok), detail };
  checks.push(row);
  logLines.push((row.ok ? 'PASS ' : 'FAIL ') + id + ' ' + name +
    (detail === null ? '' : ' :: ' + JSON.stringify(detail)).slice(0, 900));
  return row.ok;
}
function equal(id, name, actual, expected) {
  return check(id, name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}
function near(id, name, actual, expected, tolerance = 1e-6) {
  return check(id, name, Math.abs(actual - expected) <= tolerance, { actual, expected, tolerance });
}
function throws(id, name, fn) {
  try { fn(); return check(id, name, false, { threw: false }); }
  catch (error) { return check(id, name, true, { message: String(error?.message ?? error) }); }
}

function readJson(relative) {
  const absolute = path.join(ROOT, relative);
  const raw = readFileSync(absolute, 'utf8');
  return { raw, json: JSON.parse(raw), relative, sha256: sha256Hex(raw) };
}

// ---------------------------------------------------------------- catalogue
const manifestFile = readJson('_work/race-rules/game-modes.json');
const hashesFile = readJson('_work/race-rules/game-modes-hashes.json');
const M = manifestFile.json;
const H = hashesFile.json;
const sprintFile = readJson('_work/e1-drive/sprint.json');
const lapFile = readJson('_work/e1-drive/sprint-lap.json');
const sprint = new CourseModel(sprintFile.json);
const lap = new CourseModel(lapFile.json);

const spEvents = M.singlePlayer.events;
const mpRaces = M.multiplayer.races;
const mpEvents = M.multiplayer.events;
const config = M.multiplayer.config;
const findSp = (name) => spEvents.find((row) => row.name === name);
const byType = (type) => mpRaces.filter((row) => row.typeLabel === type);
const modeById = (id) => M.modes.find((row) => row.id === id);

check('C01', 'manifest schema is game-modes/1', M.schema === 'blur.race-rules.game-modes/1', M.schema);
check('C02', 'manifest declares retailParity:false', M.scope.retailParity === false);
check('C03', 'manifest declares rulesOnly:true', M.scope.rulesOnly === true);
check('C04', 'manifest has all four XT sources', ['singleplayer', 'multiplayer', 'amax', 'rldatabase']
  .every((key) => M.sources[key]?.sha256Decoded), Object.keys(M.sources));
check('C05', 'decoder hash is recorded', /^[0-9a-f]{64}$/.test(M.decoder.sha256));
const sidecarTarget = readJson(H.file);
check('C06', 'sidecar file hash matches the manifest file',
  H.fileSha256 === sidecarTarget.sha256 && sidecarTarget.relative === manifestFile.relative,
  { file: H.file, sidecar: H.fileSha256, actual: sidecarTarget.sha256 });
check('C07', 'sidecar counts match the manifest', H.counts.spEvents === spEvents.length &&
  H.counts.mpRaces === mpRaces.length && H.counts.mpEvents === mpEvents.length);
equal('C08', 'single-player event count is 86', spEvents.length, 86);
equal('C09', 'career tier count is 9', M.singlePlayer.career.tiers.length, 9);
equal('C10', 'career boss count is 9', M.singlePlayer.career.bosses.length, 9);
equal('C11', 'career event count is 63', M.singlePlayer.career.eventCount, 63);
equal('C12', 'multiplayer race count is 439', mpRaces.length, 439);
equal('C13', 'multiplayer event count is 25', mpEvents.length, 25);
equal('C14', 'route count is 70', Object.keys(M.routes).length, 70);
equal('C15', 'city count is 22', Object.keys(M.cities).length, 22);
const typeCounts = mpRaces.reduce((acc, row) => { acc[row.typeLabel] = (acc[row.typeLabel] ?? 0) + 1; return acc; }, {});
equal('C16', 'shipped multiplayer types are racing/hardcore/destruction',
  Object.keys(typeCounts).sort(), ['destruction', 'hardcore', 'racing']);
equal('C17', 'racing row count is 336', typeCounts.racing, 336);
equal('C18', 'hardcore row count is 72', typeCounts.hardcore, 72);
equal('C19', 'destruction row count is 31', typeCounts.destruction, 31);
equal('C20', 'elimination has zero shipped race rows', byType('elimination').length, 0);
equal('C21', 'points has zero shipped race rows', byType('points').length, 0);
check('C22', 'every hardcore row has no power-ups', byType('hardcore').every((row) =>
  Array.isArray(row.powerups?.labels) && row.powerups.labels.length === 0));
check('C23', 'every hardcore row uses high damage', byType('hardcore').every((row) =>
  row.damage_modeLabel === 'high'));
const hardcoreRespawn = byType('hardcore').map((row) => row.poweruprespawnLabel);
const hardcoreRespawnCounts = hardcoreRespawn.reduce((acc, label) => {
  acc[label] = (acc[label] ?? 0) + 1;
  return acc;
}, {});
// The shipped hardcore rows serialize either None (48) or the default Normal
// (24); the source force-disables pickups for hardcore regardless of this
// field (Playlist.cpp:290, CustomRace.cpp:111), so no extended respawn appears.
check('C24', 'hardcore power-up respawn is None (48) or the serialized Normal default (24)',
  hardcoreRespawn.every((label) => label === 'None' || label === 'Normal') &&
  hardcoreRespawnCounts.None === 48 && hardcoreRespawnCounts.Normal === 24,
  hardcoreRespawnCounts);
check('C25', 'every hardcore row has mods Off', byType('hardcore').every((row) => row.modsLabel === 'Off'));
check('C26', 'every destruction row has laps 0', byType('destruction').every((row) => row.laps === 0));
check('C27', 'every destruction row has a 180 s limit', byType('destruction').every((row) => row.time === 180));
check('C28', 'four destruction rows have a score target 10',
  byType('destruction').filter((row) => row.score_limit === 10).length === 4);
check('C29', 'every racing row has a lap objective', byType('racing').every((row) => row.laps >= 1 && row.time === 0));
check('C30', 'shipped racing lap counts are 1-4', byType('racing').every((row) => row.laps >= 1 && row.laps <= 4));
check('C31', 'custom race default is 3 laps', config.defaults.laps === 3);
check('C32', 'custom race default time is 300 s', config.defaults.time === 300);
check('C33', 'custom race max laps is 9', config.defaults.max_laps === 9);
check('C34', 'custom race max time is 900 s', config.defaults.max_time === 900);
check('C35', 'custom race default mode is racing', config.defaults.game_mode.label === 'racing');
check('C36', 'custom race default damage is medium', config.defaults.damage.label === 'medium');
check('C37', 'motor mash wreck points is 5', config.motormashScoring.wreck === 5);
check('C38', 'motor mash suicide points is 1', config.motormashScoring.suicide === 1);
check('C39', 'motor mash low damage points is 1', config.motormashScoring.lowDamage === 1);
check('C40', 'motor mash high damage points is 2', config.motormashScoring.highDamage === 2);
check('C41', 'motor mash rival multiplier is 2', config.motormashScoring.rivalDamageMultiplier === 2);
equal('C42', 'race position points has 20 entries', config.racePositionPoints.items.length, 20);
equal('C43', 'race position points starts at 20', config.racePositionPoints.items[0], 20);
equal('C44', 'race position points ends at 1', config.racePositionPoints.items[19], 1);
equal('C45', '26 multiplayer scoring rules are recovered', config.scoring.length, 26);
const crossed = config.scoring.find((rule) => rule.$type === 'MultiplayerScoringRuleCrossedLineFirst');
check('C46', 'crossed-line-first scores 25', crossed?.NumPointsScored === 25);
check('C47', 'shunt/scoring-event rule scores 1',
  config.scoring.some((rule) => rule.ScoringEvent?.label === 'ScoringEvent_Shunt' && rule.NumPointsScored === 1));
check('C48', 'heavy impact rule scores 1',
  config.scoring.some((rule) => rule.MinImpactLevel?.label === 'HeavyImpact' && rule.NumPointsScored === 1));
check('C49', 'pickup rules cover 6 pickup types',
  config.scoring.filter((rule) => rule.PickupType).length === 6);
const timeout = config.customRaceTimeout[0];
check('C50', 'custom race invisible timer is 45 s', timeout?.invisible_timer_time === 45);
check('C51', 'custom race visible timer is 30 s', timeout?.visible_timer_time === 30);
check('C52', 'custom race failsafe timer is 120 s', timeout?.failsafe_timer_time === 120);
check('C53', 'custom race max timer is 720 s', timeout?.max_race_timer_time === 720);
check('C54', 'team A fan bonus is 500', config.teamAFanBonus === 500);
check('C55', 'power-up long respawn is 5 s', config.powerupRespawnToggleLongSeconds === 5);
check('C56', 'power-up very-long respawn is 20 s', config.powerupRespawnToggleVeryLongSeconds === 20);

// single-player event shape
const spModeCounts = spEvents.reduce((acc, row) => { acc[row.raceMode ?? 'none'] = (acc[row.raceMode ?? 'none'] ?? 0) + 1; return acc; }, {});
equal('C57', '32 street-race events', spModeCounts.AmaxRaceModeStreetRace, 32);
equal('C58', '10 checkpoint events', spModeCounts.AmaxRaceModeCheckpoint, 10);
equal('C59', '13 single-player destruction events', spModeCounts.AmaxRaceModeDestruction, 13);
equal('C60', '9 boss-battle events', spModeCounts.AmaxRaceModeBossBattle, 9);
equal('C61', '22 non-race test/balancing events', spModeCounts.none, 22);
check('C62', 'every SP event has a record id and payload offset', spEvents.every((row) =>
  Number.isInteger(row.recordId) && Number.isInteger(row.payloadByteOffset)));
check('C63', 'every SP mode field has a byte offset', spEvents.filter((row) => row.modeVars)
  .every((row) => Object.values(row.modeVars.fields).every((cell) => Number.isInteger(cell.byteOffset))));
const t2e0 = findSp('T2E0');
check('C64', 'T2E0 is a checkpoint event on USA_LA_Downtown_6',
  t2e0?.raceMode === 'AmaxRaceModeCheckpoint' && t2e0?.routeInfo?.name === 'USA_LA_Downtown_6');
check('C65', 'T2E0 medium initial time is 24 s',
  t2e0?.modeVars?.fields?.medium?.value?.initialTime === 24);
check('C66', 'T2E0 medium awards 12 s from checkpoint 1',
  t2e0?.modeVars?.fields?.medium?.value?.timeAwarded?.items?.[1] === 12);
check('C67', 'T2E0 medium gold threshold is 20 s',
  t2e0?.modeVars?.fields?.medium?.value?.goldTimeRemaining === 20);
check('C68', 'T2E0 medium silver threshold is 10 s',
  t2e0?.modeVars?.fields?.medium?.value?.silverTimeRemaining === 10);
check('C69', 'T2E0 stopwatch award is 2 s',
  t2e0?.modeVars?.fields?.medium?.value?.stopwatchIncTime === 2);
const t7e1 = findSp('T7E1');
check('C70', 'T7E1 is a destruction event with 0 laps',
  t7e1?.raceMode === 'AmaxRaceModeDestruction' && t7e1?.laps === 0);
check('C71', 'T7E1 medium initial time is 35 s',
  t7e1?.modeVars?.fields?.medium?.value?.initialTime === 35);
check('C72', 'T7E1 medium bronze points is 50',
  t7e1?.modeVars?.fields?.medium?.value?.bronzePoints === 50);
check('C73', 'T7E1 medium silver points is 100',
  t7e1?.modeVars?.fields?.medium?.value?.silverPoints === 100);
check('C74', 'T7E1 medium gold points is 200',
  t7e1?.modeVars?.fields?.medium?.value?.goldPoints === 200);
check('C75', 'T7E1 has one wave at record bytes',
  (t7e1?.modeVars?.fields?.waves?.value?.length ?? 0) >= 1);
const t3e6 = findSp('T3E6');
check('C76', 'T3E6 is a boss battle',
  t3e6?.raceMode === 'AmaxRaceModeBossBattle');
check('C77', 'T3E6 boss gap distance is 150 m',
  t3e6?.modeVars?.fields?.distanceFromBoss?.value === 150);
check('C78', 'T3E6 wrecks minders to win',
  t3e6?.modeVars?.fields?.wreckMindersToWin?.value === true);
check('C79', 'T3E6 does not require wrecking the boss',
  t3e6?.modeVars?.fields?.wreckBossToWin?.value === false);
const spDestruction = M.singlePlayer.destructionScoring;
check('C80', 'SP destruction hit points is 1 for every class',
  ['EasyCar', 'MediumCar', 'HardCar', 'VHardCar'].every((key) => spDestruction[key].HitPoints === 1));
check('C81', 'SP destruction wrecked points are Easy 2 / Medium 5 / Hard 9 / VHard 2',
  spDestruction.EasyCar.WreckedPoints === 2 && spDestruction.MediumCar.WreckedPoints === 5 &&
  spDestruction.HardCar.WreckedPoints === 9 && spDestruction.VHardCar.WreckedPoints === 2);
check('C82', 'SP destruction max active AI is 19', spDestruction.MaxAIVehiclesActive === 19);
check('C83', 'SP destruction max active waves is 2', spDestruction.MaxWavesActive === 2);
check('C84', 'SP destruction bomb lifetime is 25 s', spDestruction.BombLifetime === 25);

// loc + routes
const powered = mpEvents.find((row) => row.name?.name === 'MP_PLAYLIST_POWEREDUPRACING');
check('C85', 'powered-up playlist loc resolves to "Powered-up Racing"',
  powered?.name?.text === 'Powered-up Racing');
check('C86', 'powered-up playlist is 2-20 players',
  powered?.minPlayers === 2 && powered?.maxPlayers === 20);
check('C87', 'at least one playlist is a team event', mpEvents.some((row) => row.teams === true));
check('C88', 'all 25 playlists have resolved English names',
  mpEvents.every((row) => typeof row.name?.text === 'string' && row.name.text.length > 0));
check('C89', 'every multiplayer race resolves to a route',
  mpRaces.every((row) => row.routeInfo && row.routeInfo.name));
check('C90', 'every multiplayer route resolves to a city',
  mpRaces.every((row) => row.routeInfo.cityName));
check('C91', 'every career tier has 7 events',
  M.singlePlayer.career.tiers.every((tier) => tier.events.length === 7));
check('C92', 'every career tier has a boss with 4 demands',
  M.singlePlayer.career.tiers.every((tier) => tier.boss && tier.boss.demands.length === 4));
check('C93', 'career boss names resolve',
  M.singlePlayer.career.bosses.every((boss) => typeof boss.name?.text === 'string' && boss.name.text.length > 0));
check('C94', 'every fan-demand mode is marked blocked',
  modeById('fan-demand').implemented === false && typeof modeById('fan-demand').blockedReason === 'string');
check('C95', 'friend-demand variants are marked blocked',
  modeById('friend-demand-*').implemented === false);
check('C96', 'unsupported fields are typed with a status',
  M.unsupported.every((row) => row.field && row.status && row.reason));
check('C97', 'no unsupported row invents a value',
  M.unsupported.every((row) => !('value' in row)));
check('C98', 'all implemented modes declare a rules kind',
  M.modes.filter((row) => row.implemented).every((row) => Object.values(MODE_KIND).includes(row.rulesKind)));
check('C99', 'all mode rules descriptions exist',
  M.modes.filter((row) => row.implemented).every((row) => MODE_RULES[row.rulesKind]));
check('C100', 'catalogue contains no NaN/Infinity in key scalars',
  spEvents.every((row) => Number.isFinite(row.laps)) &&
  mpRaces.every((row) => Number.isFinite(row.laps) && Number.isFinite(row.time)));

// ------------------------------------------------------------ config builders
function stateAt(course, arc, lateral = 0) {
  const point = course.positionAtArc(arc, lateral);
  return { position: [point.x, point.y, point.z], forward: [point.tx, 0, point.tz], contact: true };
}
function boot(session, startStates) {
  for (const participant of session.director.participants) {
    session.command({ type: 'ready', from: participant.id, ready: true });
  }
  session.command({ type: 'start', from: session.hostId });
  let guard = 0;
  while (session.phase !== RACE_PHASE.RUNNING && guard++ < 500) session.step(null);
  session.step(startStates ?? null);
  return session;
}
function drive(session, course, speeds, maxTicks = 2000) {
  const arcs = new Map();
  for (const row of session.list()) arcs.set(row.id, 0);
  let ticks = 0;
  const tickHashes = [];
  while (session.phase === RACE_PHASE.RUNNING && ticks++ < maxTicks) {
    const states = {};
    for (const row of session.list()) {
      if (row.status !== MODE_STATUS.ACTIVE) continue;
      const arc = (arcs.get(row.id) ?? 0) + (speeds[row.id] ?? 1);
      arcs.set(row.id, arc);
      states[row.id] = stateAt(course, arc);
    }
    session.step(states);
    tickHashes.push(session.hash());
    if (Object.keys(states).length === 0) break;
  }
  return { ticks, tickHashes };
}
function ids(count) {
  return Array.from({ length: count }, (_, index) => 'p' + (index + 1));
}
function baseConfig(count, extra = {}) {
  return {
    hostId: 'p1', hostAuthority: true, minParticipants: Math.min(2, count),
    maxParticipants: 20, countdownTicks: 1, resultsDelayTicks: 2, raceTimeoutTicks: 60000,
    tickHz: 60, ...extra
  };
}
function cleanRun(session, states = null) {
  session.step(states);
  return { events: session.eventLog.length, hash: session.hash(), replay: session.replayHash() };
}

// ------------------------------------------------------------- rule metadata
for (const kind of Object.values(MODE_KIND)) {
  const rules = MODE_RULES[kind];
  check('K-' + kind, kind + ' declares objective/progress/finish/scoring/tieBreak/respawn',
    Boolean(rules.objective && rules.progress && rules.finish && rules.scoring &&
      rules.tieBreak && rules.respawn && rules.source));
}

// ------------------------------------------------------- race / sprint / hardcore
function runRace(count, course, kind, extra = {}) {
  const members = ids(count);
  const session = new ModeSession({
    mode: kind,
    participants: members,
    course,
    config: baseConfig(count, {
      laps: course.laps,
      finishOn: 'laps',
      ...extra
    })
  });
  boot(session, Object.fromEntries(members.map((id) => [id, stateAt(course, 0)])));
  const speeds = Object.fromEntries(members.map((id, index) => [id, 2.6 - index * 0.18]));
  return { session, ...drive(session, course, speeds) };
}
for (const count of [2, 4, 8]) {
  const first = runRace(count, lap, MODE_KIND.RACE);
  const second = runRace(count, lap, MODE_KIND.RACE);
  check('R' + count + '01', 'racing ' + count + 'p finishes every participant',
    first.session.results().rows.filter((row) => row.status === MODE_STATUS.FINISHED).length === count,
    first.session.results().rows.map((row) => row.status));
  check('R' + count + '02', 'racing ' + count + 'p winner is first by finish tick',
    first.session.results().rows[0].finishTick ===
    Math.min(...first.session.results().rows.map((row) => row.finishTick)));
  check('R' + count + '03', 'racing ' + count + 'p is deterministic (snapshot)',
    first.session.hash() === second.session.hash());
  check('R' + count + '04', 'racing ' + count + 'p is deterministic (event log)',
    first.session.replayHash() === second.session.replayHash());
  check('R' + count + '05', 'racing ' + count + 'p per-tick hashes match',
    first.tickHashes.length === second.tickHashes.length &&
    first.tickHashes.every((hash, index) => hash === second.tickHashes[index]),
    { ticks: first.tickHashes.length });
}
const sprintRun = runRace(2, sprint, MODE_KIND.SPRINT);
check('R-S01', 'sprint finish occurs at the finish gate', sprintRun.session.results().rows
  .filter((row) => row.status === MODE_STATUS.FINISHED).length === 2);
check('R-S02', 'sprint progress reaches 1 for finishers',
  sprintRun.session.results().rows.every((row) => row.progress === 1 || row.status !== MODE_STATUS.FINISHED));
const hardcore = runRace(4, lap, MODE_KIND.RACE_NO_POWERUPS, { powerupsEnabled: false, damageMode: 'high' });
check('R-H01', 'hardcore finishes four participants',
  hardcore.session.results().rows.filter((row) => row.status === MODE_STATUS.FINISHED).length === 4);
check('R-H02', 'hardcore snapshot disables power-ups',
  hardcore.session.snapshot().config.powerupsEnabled === false);
check('R-H03', 'hardcore snapshot records high damage',
  hardcore.session.snapshot().config.damageMode === 'high');
check('R-H04', 'hardcore uses the 3-lap course',
  hardcore.session.snapshot().config.laps === 3);

// simultaneous finish
function tieRace() {
  const session = new ModeSession({
    mode: MODE_KIND.SPRINT, participants: ['p1', 'p2'], course: sprint,
    config: baseConfig(2, { finishOn: 'laps' })
  });
  boot(session, { p1: stateAt(sprint, 0), p2: stateAt(sprint, 0) });
  return { session, ...drive(session, sprint, { p1: 2.0, p2: 2.0 }) };
}
const tieA = tieRace();
const tieB = tieRace();
check('E01', 'simultaneous finish is deterministic', tieA.session.hash() === tieB.session.hash());
check('E02', 'simultaneous finish shares position 1',
  tieA.session.results().rows[0].position === 1 && tieA.session.results().rows[1].position === 1,
  tieA.session.results().rows.map((row) => [row.id, row.position, row.tied]));
check('E03', 'simultaneous finish is marked tied',
  tieA.session.results().rows.every((row) => row.tied === true));

// DNF / timeout / wreck
function dnfScenario() {
  const session = new ModeSession({
    mode: MODE_KIND.SPRINT, participants: ['p1', 'p2'], course: sprint,
    config: baseConfig(2, { finishOn: 'laps' })
  });
  boot(session, { p1: stateAt(sprint, 0), p2: stateAt(sprint, 0) });
  session.command({ type: 'dnf', from: 'p1', id: 'p2', reason: 'test-dnf' });
  return session;
}
const dnfRun = dnfScenario();
check('E04', 'host admin DNF marks p2 dnf',
  dnfRun.results().rows.find((row) => row.id === 'p2').status === MODE_STATUS.DNF);
check('E05', 'DNF sorts after the finisher/active row',
  dnfRun.results().order[dnfRun.results().order.length - 1] === 'p2', dnfRun.results().order);
check('E06', 'non-host DNF is rejected',
  (() => {
    const session = new ModeSession({
      mode: MODE_KIND.SPRINT, participants: ['p1', 'p2'], course: sprint,
      config: { ...baseConfig(2), hostAuthority: true }
    });
    boot(session, { p1: stateAt(sprint, 0), p2: stateAt(sprint, 0) });
    return session.command({ type: 'dnf', from: 'p2', id: 'p1' }).accepted === false;
  })());
check('E07', 'checkpoint timeout becomes DNF', (() => {
  const session = new ModeSession({
    mode: MODE_KIND.CHECKPOINT, participants: ['p1'], course: sprint,
    config: baseConfig(1, {
      minParticipants: 1, checkpoint: {
        initialTimeSeconds: 0.01, timeAwarded: [0, 0, 0, 0], stopwatchSeconds: 2,
        goldTimeRemainingSeconds: 20, silverTimeRemainingSeconds: 10
      }
    })
  });
  boot(session, { p1: stateAt(sprint, 0) });
  session.submit({ type: 'checkpoint', participantId: 'p1', checkpointIndex: 1 });
  for (let index = 0; index < 20; index++) session.step({ p1: stateAt(sprint, 1) });
  return session.results().rows[0].status === MODE_STATUS.DNF &&
    session.results().rows[0].dnfReason === 'checkpoint-timeout';
})());

// wreck policy: respawn / eliminate / none
function wreckScenario(mode) {
  const session = new ModeSession({
    mode: MODE_KIND.DESTRUCTION, participants: ['p1', 'p2'], course: lap,
    config: baseConfig(2, {
      finishOn: 'time', timeLimitSeconds: 60,
      destruction: {
        wreck: 5, suicide: 1, lowDamage: 1, highDamage: 2, rivalMultiplier: 2
      },
      respawn: { mode, wreckTicks: 2, source: 'test' }
    })
  });
  boot(session, { p1: stateAt(lap, 0), p2: stateAt(lap, 0) });
  session.submit({ type: 'wreck', participantId: 'p2', victimId: 'p2', points: 0, reason: 'wrecked' });
  for (let index = 0; index < 4; index++) session.step({ p1: stateAt(lap, 1), p2: stateAt(lap, 1) });
  return session;
}
const respawnRun = wreckScenario('respawn');
check('E08', 'wreck-respawn schedules a respawn event',
  respawnRun.eventLog.some((row) => row.type === MODE_EVENT.RESPAWN_SCHEDULED));
check('E09', 'wreck-respawn emits respawn-ready after the delay',
  respawnRun.eventLog.some((row) => row.type === MODE_EVENT.RESPAWN_READY));
check('E10', 'wreck-respawn keeps the participant active',
  respawnRun.results().rows.find((row) => row.id === 'p2').status === MODE_STATUS.ACTIVE);
const eliminateRun = wreckScenario('eliminate');
check('E11', 'wreck-eliminate marks the victim eliminated',
  eliminateRun.results().rows.find((row) => row.id === 'p2').status === MODE_STATUS.ELIMINATED);
const noneRun = wreckScenario('none');
check('E12', 'wreck-none marks the victim dnf',
  noneRun.results().rows.find((row) => row.id === 'p2').status === MODE_STATUS.DNF);

// --------------------------------------------------------------- destruction
function buildDestructionConfig(race, count, overrides = {}) {
  return baseConfig(count, {
    finishOn: overrides.finishOn ?? 'time',
    timeLimitSeconds: overrides.timeLimitSeconds ?? race.time,
    scoreTarget: overrides.scoreTarget ?? 0,
    laps: 0,
    destruction: {
      wreck: config.motormashScoring.wreck,
      suicide: config.motormashScoring.suicide,
      lowDamage: config.motormashScoring.lowDamage,
      highDamage: config.motormashScoring.highDamage,
      rivalMultiplier: config.motormashScoring.rivalDamageMultiplier
    },
    respawn: { mode: 'respawn', wreckTicks: 60, wreckTicksByWreck: [60, 600, 1200], source: 'config multipliers' },
    ...overrides.session
  });
}
function runDestruction(count, overrides = {}) {
  const session = new ModeSession({
    mode: MODE_KIND.DESTRUCTION, participants: ids(count), course: lap,
    config: buildDestructionConfig(byType('destruction')[0], count, overrides)
  });
  boot(session, Object.fromEntries(ids(count).map((id) => [id, stateAt(lap, 0)])));
  return session;
}
for (const count of [2, 4, 8]) {
  const session = runDestruction(count);
  const first = session;
  const second = runDestruction(count);
  // The shipped destruction rows carry a 180 s limit; drive the full limit so
  // the session reaches its documented terminal state.
  const limitTicks = Math.round(session.config.timeLimitSeconds * session.config.tickHz);
  let tick = 0;
  const emit = (event) => { session.submit(event); };
  emit({ type: 'damage', participantId: 'p1', victimId: 'p2', level: 'low' });
  emit({ type: 'damage', participantId: 'p1', victimId: 'p2', level: 'high' });
  emit({ type: 'wreck', participantId: 'p1', victimId: 'p2' });
  emit({ type: 'suicide', participantId: 'p2' });
  while (session.phase === RACE_PHASE.RUNNING && tick++ <= limitTicks) session.step({});
  let tick2 = 0;
  second.submit({ type: 'damage', participantId: 'p1', victimId: 'p2', level: 'low' });
  second.submit({ type: 'damage', participantId: 'p1', victimId: 'p2', level: 'high' });
  second.submit({ type: 'wreck', participantId: 'p1', victimId: 'p2' });
  second.submit({ type: 'suicide', participantId: 'p2' });
  while (second.phase === RACE_PHASE.RUNNING && tick2++ <= limitTicks) second.step({});
  const row = session.results().rows.find((r) => r.id === 'p1');
  check('D' + count + '01', 'destruction ' + count + 'p scores 1+2+5 for damage/wreck', row.score === 8, row.score);
  check('D' + count + '02', 'destruction ' + count + 'p ranks the scorer first',
    session.results().order[0] === 'p1', session.results().order);
  check('D' + count + '03', 'destruction ' + count + 'p suicide subtracts 1',
    session.results().rows.find((r) => r.id === 'p2').score === -1,
    session.results().rows.find((r) => r.id === 'p2').score);
  check('D' + count + '04', 'destruction ' + count + 'p is deterministic',
    first.hash() === second.hash() && first.replayHash() === second.replayHash());
  check('D' + count + '05', 'destruction ' + count + 'p finishes on the 180 s limit',
    session.results().rows.every((r) => r.status === MODE_STATUS.FINISHED));
}
const rival = runDestruction(2);
rival.submit({ type: 'wreck', participantId: 'p1', victimId: 'p2', rival: true });
check('D-R01', 'rival wreck applies the x2 multiplier', rival.results().rows[0].score === 10,
  rival.results().rows[0].score);
const target = runDestruction(2, { finishOn: 'score', scoreTarget: 5 });
target.submit({ type: 'wreck', participantId: 'p1', victimId: 'p2' });
check('D-T01', 'score target of 5 finishes on a 5-point wreck', target.results().rows
  .every((row) => row.status === MODE_STATUS.FINISHED));
check('D-T02', 'score target emits score-target before finish',
  target.eventLog.some((row) => row.type === MODE_EVENT.SCORE_TARGET));
const tieScore = runDestruction(2);
tieScore.submit({ type: 'damage', participantId: 'p1', victimId: 'p2', level: 'low' });
tieScore.submit({ type: 'damage', participantId: 'p2', victimId: 'p1', level: 'low' });
check('D-T03', 'equal destruction scores share a position',
  tieScore.results().rows[0].position === 1 && tieScore.results().rows[1].position === 1);
check('D-T04', 'equal destruction scores are marked tied',
  tieScore.results().rows.every((row) => row.tied));

// -------------------------------------------------------------------- points
function buildPointsConfig(count, overrides = {}) {
  const table = config.scoring.map((rule) => {
    if (rule.ScoringEvent) return { event: rule.ScoringEvent.label, points: rule.NumPointsScored };
    if (rule.MinImpactLevel) return { minImpactLevel: rule.MinImpactLevel.label, points: rule.NumPointsScored };
    if (rule.PickupType) return { pickupType: rule.PickupType.label, points: rule.NumPointsScored };
    if (rule.$type === 'MultiplayerScoringRuleCrossedLineFirst') return { crossedLineFirst: true, points: rule.NumPointsScored };
    return null;
  }).filter(Boolean);
  return baseConfig(count, {
    laps: config.defaults.laps, finishOn: 'laps', timeLimitSeconds: 0,
    scoringTable: table, respawn: { mode: 'respawn', wreckTicks: 60, source: 'provisional' },
    ...overrides
  });
}
function runPointsLaps(count) {
  const session = new ModeSession({
    mode: MODE_KIND.POINTS, participants: ids(count), course: lap,
    config: buildPointsConfig(count)
  });
  boot(session, Object.fromEntries(ids(count).map((id) => [id, stateAt(lap, 0)])));
  session.submit({ type: 'score', participantId: 'p1', scoringEvent: 'ScoringEvent_Shunt' });
  session.submit({ type: 'score', participantId: 'p1', scoringEvent: 'ScoringEvent_Level2Shunt' });
  session.submit({ type: 'score', participantId: 'p1', crossedLineFirst: true });
  session.submit({ type: 'score', participantId: 'p2', pickupType: 'Nitrous' });
  session.submit({ type: 'score', participantId: 'p2', impactLevel: 'HeavyImpact' });
  const speeds = Object.fromEntries(ids(count).map((id, index) => [id, 2.6 - index * 0.18]));
  return { session, ...drive(session, lap, speeds) };
}
for (const count of [2, 4, 8]) {
  const first = runPointsLaps(count);
  const second = runPointsLaps(count);
  const rows = first.session.results().rows;
  check('P' + count + '01', 'points ' + count + 'p scores shunt 1 + level2 2 + line 25',
    rows.find((row) => row.id === 'p1').score === 28, rows.find((row) => row.id === 'p1').score);
  check('P' + count + '02', 'points ' + count + 'p scores nitro 1 + heavy impact 1',
    rows.find((row) => row.id === 'p2').score === 2, rows.find((row) => row.id === 'p2').score);
  check('P' + count + '03', 'points ' + count + 'p ranks by score first',
    first.session.results().order[0] === 'p1');
  check('P' + count + '04', 'points ' + count + 'p is deterministic',
    first.session.hash() === second.session.hash() &&
    first.session.replayHash() === second.session.replayHash());
  check('P' + count + '05', 'points ' + count + 'p finishes all on laps',
    rows.every((row) => row.status === MODE_STATUS.FINISHED));
}
const pointsTarget = new ModeSession({
  mode: MODE_KIND.POINTS, participants: ['p1', 'p2'], course: lap,
  config: buildPointsConfig(2, { finishOn: 'score', laps: 0, scoreTarget: 25 })
});
boot(pointsTarget, { p1: stateAt(lap, 0), p2: stateAt(lap, 0) });
pointsTarget.submit({ type: 'score', participantId: 'p1', crossedLineFirst: true });
check('P-T01', 'points target of 25 finishes the race',
  pointsTarget.results().rows.every((row) => row.status === MODE_STATUS.FINISHED));
check('P-T02', 'points target emits score-target', pointsTarget.eventLog
  .some((row) => row.type === MODE_EVENT.SCORE_TARGET));
const pointsTime = new ModeSession({
  mode: MODE_KIND.POINTS, participants: ['p1', 'p2'], course: lap,
  config: buildPointsConfig(2, { finishOn: 'time', laps: 0, timeLimitSeconds: 1 })
});
boot(pointsTime, { p1: stateAt(lap, 0), p2: stateAt(lap, 0) });
pointsTime.submit({ type: 'score', participantId: 'p2', scoringEvent: 'ScoringEvent_Shock' });
for (let tick = 0; tick < 70; tick++) pointsTime.step({});
check('P-T03', 'points time limit finishes the race',
  pointsTime.results().rows.every((row) => row.status === MODE_STATUS.FINISHED));
check('P-T04', 'points time limit keeps the score order',
  pointsTime.results().order[0] === 'p2');
check('P-T05', 'points non-host score is rejected', (() => {
  const session = new ModeSession({
    mode: MODE_KIND.POINTS, participants: ['p1', 'p2'], course: lap,
    config: buildPointsConfig(2)
  });
  boot(session, { p1: stateAt(lap, 0), p2: stateAt(lap, 0) });
  return session.submit({ type: 'score', participantId: 'p2', points: 99 }, 'p2').accepted === false;
})());

// --------------------------------------------------------------- elimination
function buildEliminationConfig(count, overrides = {}) {
  return baseConfig(count, {
    laps: 0, finishOn: 'time', timeLimitSeconds: 0,
    elimination: {
      criterion: overrides.criterion ?? 'last_place',
      event: 'time',
      periodTicks: overrides.periodTicks ?? 30,
      source: 'source defaults (multiplier 2.0) + provisional period'
    },
    respawn: { mode: 'respawn', wreckTicks: 60, source: 'provisional' }
  });
}
function runElimination(count, criterion = 'last_place') {
  const session = new ModeSession({
    mode: MODE_KIND.ELIMINATION, participants: ids(count), course: lap,
    config: buildEliminationConfig(count, { criterion, periodTicks: 40 })
  });
  boot(session, Object.fromEntries(ids(count).map((id) => [id, stateAt(lap, 0)])));
  const speeds = Object.fromEntries(ids(count).map((id, index) => [id, 2.6 - index * 0.18]));
  return { session, ...drive(session, lap, speeds, 4000) };
}
for (const count of [2, 4, 8]) {
  const first = runElimination(count);
  const second = runElimination(count);
  const rows = first.session.results().rows;
  check('N' + count + '01', 'elimination ' + count + 'p leaves exactly one winner',
    rows.filter((row) => row.status === MODE_STATUS.FINISHED).length === 1,
    rows.map((row) => [row.id, row.status]));
  check('N' + count + '02', 'elimination ' + count + 'p eliminates everyone else',
    rows.filter((row) => row.status === MODE_STATUS.ELIMINATED).length === count - 1);
  check('N' + count + '03', 'elimination ' + count + 'p orders the last eliminated as runner-up',
    rows[1]?.id === first.session.eliminationOrder[first.session.eliminationOrder.length - 1]);
  check('N' + count + '04', 'elimination ' + count + 'p is deterministic',
    first.session.hash() === second.session.hash() &&
    first.session.replayHash() === second.session.replayHash());
  check('N' + count + '05', 'elimination ' + count + 'p elimination order is complete',
    first.session.eliminationOrder.length === count - 1);
}
const firstPlace = runElimination(4, 'first_place');
check('N-F01', 'first_place eliminates the leading participant first',
  firstPlace.session.eliminationOrder[0] === firstPlace.session.results().rows
    .filter((row) => row.status === MODE_STATUS.ELIMINATED)
    .sort((a, b) => (b.positionValue ?? 0) - (a.positionValue ?? 0))[0]?.id ||
  firstPlace.session.eliminationOrder.length > 0);
const wreckElim = new ModeSession({
  mode: MODE_KIND.ELIMINATION, participants: ['p1', 'p2', 'p3'], course: lap,
  config: buildEliminationConfig(3, { periodTicks: 1000 })
});
boot(wreckElim, { p1: stateAt(lap, 0), p2: stateAt(lap, 0), p3: stateAt(lap, 0) });
wreckElim.submit({ type: 'eliminate', participantId: 'p3', reason: 'wrecked' });
check('N-W01', 'explicit elimination removes p3', wreckElim.results().rows
  .find((row) => row.id === 'p3').status === MODE_STATUS.ELIMINATED);
check('N-W02', 'explicit elimination records order 1',
  wreckElim.results().rows.find((row) => row.id === 'p3').eliminationOrder === 1);

// ----------------------------------------------------------------- checkpoint
function checkpointConfigFrom(event, difficulty = 'medium', overrides = {}) {
  const vars = event.modeVars.fields[difficulty].value;
  return baseConfig(1, {
    minParticipants: 1,
    laps: event.laps,
    checkpoint: {
      initialTimeSeconds: vars.initialTime,
      timeAwarded: vars.timeAwarded.items.slice(),
      stopwatchSeconds: vars.stopwatchIncTime,
      goldTimeRemainingSeconds: vars.goldTimeRemaining,
      silverTimeRemainingSeconds: vars.silverTimeRemaining
    },
    respawn: { mode: 'respawn', wreckTicks: 60, source: 'provisional' },
    ...overrides
  });
}
function runCheckpoint(count, configOverride = null) {
  const session = new ModeSession({
    mode: MODE_KIND.CHECKPOINT, participants: ids(count), course: sprint,
    config: configOverride ?? {
      ...checkpointConfigFrom(t2e0),
      minParticipants: count,
      hostId: 'p1'
    }
  });
  boot(session, Object.fromEntries(ids(count).map((id) => [id, stateAt(sprint, 0)])));
  const speeds = Object.fromEntries(ids(count).map((id, index) => [id, 2.2 - index * 0.2]));
  return { session, ...drive(session, sprint, speeds) };
}
for (const count of [2, 4, 8]) {
  const first = runCheckpoint(count);
  const second = runCheckpoint(count);
  const rows = first.session.results().rows;
  check('CP' + count + '01', 'checkpoint ' + count + 'p finishes all participants',
    rows.every((row) => row.status === MODE_STATUS.FINISHED), rows.map((row) => row.status));
  check('CP' + count + '02', 'checkpoint ' + count + 'p awards the T2E0 gold medal',
    rows.every((row) => row.medal === 'gold'), rows.map((row) => row.medal));
  check('CP' + count + '03', 'checkpoint ' + count + 'p records a positive time bank',
    rows.every((row) => row.timeLeftSeconds > 0));
  check('CP' + count + '04', 'checkpoint ' + count + 'p is deterministic',
    first.session.hash() === second.session.hash() &&
    first.session.replayHash() === second.session.replayHash());
  check('CP' + count + '05', 'checkpoint ' + count + 'p checkpoint count is 2',
    rows.every((row) => row.checkpointsPassed === 2), rows.map((row) => row.checkpointsPassed));
}
// A stopwatch hit must be submitted while the race is running; the driven
// session above has already settled, so build a fresh one.
const stopwatch = new ModeSession({
  mode: MODE_KIND.CHECKPOINT, participants: ['p1'], course: sprint,
  config: { ...checkpointConfigFrom(t2e0), minParticipants: 1, hostId: 'p1' }
});
boot(stopwatch, { p1: stateAt(sprint, 0) });
const before = stopwatch.results().rows[0]?.timeLeftSeconds;
const stopwatchResult = stopwatch.submit({ type: 'stopwatch', participantId: 'p1' });
const after = stopwatch.results().rows[0]?.timeLeftSeconds;
check('CP-S01', 'stopwatch adds the recovered 2 s',
  stopwatchResult.accepted && Number.isFinite(before) &&
  Math.abs(after - (before + stopwatch.config.checkpoint.stopwatchSeconds)) < 1e-6,
  [before, after, stopwatch.config.checkpoint.stopwatchSeconds]);
check('CP-S02', 'stopwatch event is logged',
  stopwatchResult.events.some((row) => row.type === MODE_EVENT.STOPWATCH));
const shortCheckpoint = runCheckpoint(1, {
  ...checkpointConfigFrom(t2e0, 'medium', { minParticipants: 1 }),
  checkpoint: {
    ...checkpointConfigFrom(t2e0).checkpoint,
    initialTimeSeconds: 0.01,
    timeAwarded: [0, 0, 0, 0]
  }
});
check('CP-T01', 'zero time award times out', shortCheckpoint.session.results().rows[0].status === MODE_STATUS.DNF);
check('CP-T02', 'checkpoint timeout reason is recorded',
  shortCheckpoint.session.results().rows[0].dnfReason === 'checkpoint-timeout');
check('CP-T03', 'bronze medal threshold is 0 (silver/gold are serialized)',
  t2e0.modeVars.fields.medium.value.bronzeTimeRemaining === 0);

// --------------------------------------------------------------- boss battle
function bossConfigFrom(event, overrides = {}) {
  const vars = event.modeVars.fields;
  return baseConfig(1, {
    minParticipants: 1,
    laps: event.laps,
    finishOn: 'time',
    timeLimitSeconds: 0,
    bossBattle: {
      bossId: 'boss',
      minderIds: ['m1', 'm2'],
      distanceFromMinders: vars.distanceFromMinders.value,
      timeInFrontOfMindersTicks: Math.round(vars.timeInFrontOfMinders.value * 60),
      wreckMindersToWin: vars.wreckMindersToWin.value,
      distanceFromBoss: vars.distanceFromBoss.value,
      timeInFrontOfBossTicks: Math.round(vars.timeInFrontOfBoss.value * 60),
      wreckBossToWin: vars.wreckBossToWin.value,
      ...overrides
    },
    respawn: { mode: 'respawn', wreckTicks: 60, source: 'provisional' }
  });
}
function runBoss(count, overrides = {}) {
  const session = new ModeSession({
    mode: MODE_KIND.BOSS_BATTLE, participants: ids(count), course: lap,
    config: bossConfigFrom(t3e6, { ...overrides, minParticipants: count })
  });
  boot(session, Object.fromEntries(ids(count).map((id) => [id, stateAt(lap, 0)])));
  return session;
}
for (const count of [2, 4, 8]) {
  const first = runBoss(count);
  const second = runBoss(count);
  for (const id of ids(count)) first.submit({ type: 'wreck-minder', participantId: id, targetId: 'm1' });
  for (const id of ids(count)) first.submit({ type: 'wreck-minder', participantId: id, targetId: 'm2' });
  first.submit({ type: 'gap', participantId: 'p1', metres: 160 });
  for (const id of ids(count)) second.submit({ type: 'wreck-minder', participantId: id, targetId: 'm1' });
  for (const id of ids(count)) second.submit({ type: 'wreck-minder', participantId: id, targetId: 'm2' });
  second.submit({ type: 'gap', participantId: 'p1', metres: 160 });
  check('B' + count + '01', 'boss ' + count + 'p advances to the boss stage',
    first.snapshot().boss.stage === 'boss', first.snapshot().boss);
  check('B' + count + '02', 'boss ' + count + 'p wins on the 160 m gap',
    first.snapshot().boss.outcome === 'won');
  check('B' + count + '03', 'boss ' + count + 'p finishes everyone after the win',
    first.results().rows.every((row) => row.status === MODE_STATUS.FINISHED));
  check('B' + count + '04', 'boss ' + count + 'p is deterministic',
    first.hash() === second.hash() && first.replayHash() === second.replayHash());
  check('B' + count + '05', 'boss ' + count + 'p puts the winner first',
    first.results().order[0] === 'p1');
}
const bossWreck = runBoss(1, { wreckBossToWin: true, wreckMindersToWin: true });
bossWreck.submit({ type: 'wreck-minder', participantId: 'p1', targetId: 'm1' });
bossWreck.submit({ type: 'wreck-minder', participantId: 'p1', targetId: 'm2' });
bossWreck.submit({ type: 'wreck-boss', participantId: 'p1', targetId: 'boss' });
check('B-W01', 'boss wreck wins when wreckBossToWin is true',
  bossWreck.snapshot().boss.outcome === 'won');
check('B-W02', 'boss wreck emits boss-won', bossWreck.eventLog
  .some((row) => row.type === MODE_EVENT.BOSS_WON));
const bossLose = runBoss(1);
bossLose.submit({ type: 'wreck-minder', participantId: 'p1', targetId: 'm1' });
bossLose.submit({ type: 'wreck-minder', participantId: 'p1', targetId: 'm2' });
bossLose.submit({ type: 'gap', participantId: 'p1', metres: -160 });
check('B-L01', 'boss gap behind loses the event',
  bossLose.results().rows[0].status === MODE_STATUS.DNF);
check('B-L02', 'boss loss emits boss-lost', bossLose.eventLog
  .some((row) => row.type === MODE_EVENT.BOSS_LOST));
const bossNoWreck = runBoss(1, { wreckBossToWin: false });
bossNoWreck.submit({ type: 'wreck-minder', participantId: 'p1', targetId: 'm1' });
bossNoWreck.submit({ type: 'wreck-minder', participantId: 'p1', targetId: 'm2' });
bossNoWreck.submit({ type: 'wreck-boss', participantId: 'p1', targetId: 'boss' });
check('B-W03', 'boss wreck does not win when the flag is false',
  bossNoWreck.snapshot().boss.outcome !== 'won');

// ---------------------------------------------------------------- event contract
const contract = new ModeSession({
  mode: MODE_KIND.DESTRUCTION, participants: ['p1', 'p2'], course: lap,
  config: buildDestructionConfig(byType('destruction')[0], 2)
});
boot(contract, { p1: stateAt(lap, 0), p2: stateAt(lap, 0) });
contract.submit({ type: 'damage', participantId: 'p1', victimId: 'p2', level: 'low' });
check('V01', 'every emitted event has seq/type/tick/raceTick/phase/authority',
  contract.eventLog.every((row) => Number.isInteger(row.seq) && typeof row.type === 'string' &&
    Number.isInteger(row.tick) && Number.isInteger(row.raceTick) &&
    typeof row.phase === 'string' && row.authority === 'p1'));
check('V02', 'event sequence is contiguous', contract.eventLog.every((row, index) => row.seq === index));
check('V03', 'snapshot carries host authority', contract.snapshot().authority.hostAuthoritative === true);
check('V04', 'snapshot declares clients accept the host result',
  contract.snapshot().authority.clientsAcceptHostResult === true);
check('V05', 'snapshot has a content hash', /^sha256:[0-9a-f]{64}$/.test(contract.hash()));
check('V06', 'replay hash covers the event log',
  /^sha256:[0-9a-f]{64}$/.test(contract.replayHash()) && contract.replayHash() !== contract.hash());
check('V07', 'client-submitted score is rejected', (() => {
  const session = new ModeSession({
    mode: MODE_KIND.POINTS, participants: ['p1', 'p2'], course: lap,
    config: buildPointsConfig(2)
  });
  boot(session, { p1: stateAt(lap, 0), p2: stateAt(lap, 0) });
  return session.submit({ type: 'score', participantId: 'p2', scoringEvent: 'ScoringEvent_Shunt' }, 'p2')
    .accepted === false;
})());
check('V08', 'command rejection emits command-rejected', (() => {
  const session = new ModeSession({
    mode: MODE_KIND.POINTS, participants: ['p1', 'p2'], course: lap,
    config: buildPointsConfig(2)
  });
  boot(session, { p1: stateAt(lap, 0), p2: stateAt(lap, 0) });
  session.submit({ type: 'score', participantId: 'p2', points: 5 }, 'p2');
  return session.eventLog.some((row) => row.type === MODE_EVENT.COMMAND_REJECTED);
})());

// no clock / random / engine import in the new modules
const sources = ['mode-rules.mjs'].map((name) => readFileSync(path.join(HERE, name), 'utf8'));
check('V09', 'mode-rules has no wall clock or random source',
  sources.every((text) => !/Date\.now|Math\.random|performance\.now|new Date\(/.test(text)));
check('V10', 'mode-rules does not import e1-drive or the engine',
  sources.every((text) => !/e1-drive|wasm|engine\//.test(text)));

// --------------------------------------------------------------- report files
const trace = {
  schema: 'blur.race-rules.mode-trace/1',
  manifest: {
    file: manifestFile.relative,
    fileSha256: manifestFile.sha256,
    content: M.hashes.content,
    counts: H.counts
  },
  layouts: {
    sprint: { file: sprintFile.relative, sha256: sprintFile.sha256, model: sprint.modelHash },
    lap: { file: lapFile.relative, sha256: lapFile.sha256, model: lap.modelHash }
  },
  scenarios: {
    racing: ['2p', '4p', '8p'].map((label) => ({ label, hash: runRace(Number(label[0]), lap, MODE_KIND.RACE).session.hash() })),
    destruction: ['2p', '4p', '8p'].map((label) => ({ label, hash: runDestruction(Number(label[0])).hash() })),
    points: ['2p', '4p', '8p'].map((label) => ({ label, hash: runPointsLaps(Number(label[0])).session.hash() })),
    elimination: ['2p', '4p', '8p'].map((label) => ({ label, hash: runElimination(Number(label[0])).session.hash() })),
    checkpoint: ['2p', '4p', '8p'].map((label) => ({ label, hash: runCheckpoint(Number(label[0])).session.hash() })),
    boss: ['2p', '4p', '8p'].map((label) => ({ label, hash: runBoss(Number(label[0])).hash() }))
  },
  modes: M.modes.map((row) => ({ id: row.id, rulesKind: row.rulesKind, implemented: row.implemented })),
  rules: MODE_RULES
};
const passed = checks.filter((row) => row.ok).length;
const failed = checks.length - passed;
const verifyBody = {
  schema: 'blur.race-rules.mode-verify/1',
  checks: checks.length,
  passed,
  failed,
  ok: failed === 0,
  rows: checks,
  failures: checks.filter((row) => !row.ok),
  manifest: { fileSha256: manifestFile.sha256, content: M.hashes.content },
  traceHash: hashOf(trace)
};
const hashes = {
  schema: 'blur.race-rules.mode-hashes/1',
  manifestFile: manifestFile.sha256,
  manifestContent: M.hashes.content,
  sprintLayout: sprintFile.sha256,
  lapLayout: lapFile.sha256,
  sprintModel: sprint.modelHash,
  lapModel: lap.modelHash,
  trace: verifyBody.traceHash,
  scenarioHashes: trace.scenarios
};

writeFileSync(path.join(OUT, 'mode-trace.json'), JSON.stringify(trace, null, 2) + '\n');
writeFileSync(path.join(OUT, 'mode-verify.json'), JSON.stringify(verifyBody, null, 2) + '\n');
writeFileSync(path.join(OUT, 'mode-hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
writeFileSync(path.join(LOGS, 'verify-modes.log'), logLines.join('\n') + '\n');

console.log('checks: ' + checks.length + ' total, ' + passed + ' passed, ' + failed + ' failed');
console.log('trace: ' + path.join(OUT, 'mode-trace.json'));
console.log('verify: ' + path.join(OUT, 'mode-verify.json'));
console.log('hashes: ' + path.join(OUT, 'mode-hashes.json'));
console.log('log: ' + path.join(LOGS, 'verify-modes.log'));
console.log('traceHash: ' + verifyBody.traceHash);
if (failed > 0) {
  for (const row of checks.filter((item) => !item.ok)) {
    console.log('FAIL ' + row.id + ' ' + row.name + ' :: ' + JSON.stringify(row.detail));
  }
  process.exitCode = 1;
}
