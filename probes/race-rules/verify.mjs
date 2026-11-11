#!/usr/bin/env node
// Deterministic verification harness for the race-rules probe.
//
//   node probes/race-rules/verify.mjs
//
// Reads the committed e1-drive layouts read-only:
//   _work/e1-drive/sprint.json
//   _work/e1-drive/sprint-lap.json
// Runs synthetic 2/3/4-participant races on both courses, exercises the
// director, progress, respawn and result rules, repeats every scenario to prove
// the replay hash, and writes:
//   _work/race-rules/trace.json
//   _work/race-rules/verify.json
//   _work/race-rules/hashes.json
//   _work/logs/race-rules/verify.log
//
// Exit code 0 only when every check passes.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashOf, sha256Hex } from './hash.mjs';
import { CourseModel } from './course-model.mjs';
import { RaceDirector, RACE_PHASE, RACE_EVENT } from './race-director.mjs';
import { ProgressTracker, PROGRESS_EVENT } from './progress-tracker.mjs';
import { RespawnPolicy } from './respawn-policy.mjs';
import { ResultModel } from './result-model.mjs';
import { RaceSession } from './race-session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(ROOT, '_work/race-rules');
const LOGS = path.join(ROOT, '_work/logs/race-rules');
mkdirSync(OUT, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const TRACE_FILE = path.join(OUT, 'trace.json');
const VERIFY_FILE = path.join(OUT, 'verify.json');
const HASHES_FILE = path.join(OUT, 'hashes.json');
const LOG_FILE = path.join(LOGS, 'verify.log');

const checks = [];
const logLines = [];

function check(id, name, ok, detail = null) {
  const row = { id, name, ok: Boolean(ok), detail };
  checks.push(row);
  logLines.push((row.ok ? 'PASS ' : 'FAIL ') + id + ' ' + name +
    (detail === null ? '' : ' :: ' + JSON.stringify(detail)));
  return row.ok;
}

function equal(id, name, actual, expected) {
  return check(id, name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

function throws(id, name, fn) {
  try {
    fn();
    return check(id, name, false, { threw: false });
  } catch (error) {
    return check(id, name, true, { message: String(error?.message ?? error) });
  }
}

function readLayout(fileName) {
  const absolute = path.join(ROOT, '_work/e1-drive', fileName);
  const raw = readFileSync(absolute, 'utf8');
  return {
    fileName,
    relative: '_work/e1-drive/' + fileName,
    layout: JSON.parse(raw),
    fileSha256: sha256Hex(raw)
  };
}

function recomputedLayoutHash(layout) {
  const copy = { ...layout };
  delete copy.hash;
  return hashOf(copy);
}

function stateAt(course, arc, options = {}) {
  const lateral = options.lateral ?? 0;
  const yOffset = options.yOffset ?? 0;
  const forwardSign = options.forwardSign ?? 1;
  const point = course.positionAtArc(arc, lateral);
  return {
    position: [point.x, point.y + yOffset, point.z],
    forward: [point.tx * forwardSign, 0, point.tz * forwardSign],
    contact: options.contact ?? true
  };
}

function runProgress(course, states, options = {}) {
  const tracker = new ProgressTracker(course, ['p1'], {
    respawn: options.respawn ?? { enabled: false },
    ...(options.config ?? {})
  });
  tracker.prime('p1', states[0], 0);
  const events = [];
  for (let tick = 1; tick < states.length; tick++) {
    events.push(...tracker.step('p1', states[tick], tick));
  }
  return { tracker, events, participant: tracker.get('p1') };
}

function eventsOfType(events, type) {
  return events.filter((event) => event.type === type);
}

function readyAll(director) {
  return director.participants.map((participant) => director.setReady(participant.id, true));
}

function advanceToRunning(director) {
  let guard = 0;
  while (director.phase !== RACE_PHASE.RUNNING && guard++ < 500) director.advance();
}

function makeSession(layout, ids, config = {}) {
  return new RaceSession({
    layout,
    participants: ids,
    config: {
      hostId: ids[0],
      resultsDelayTicks: 2,
      raceTimeoutTicks: 30000,
      ...config
    }
  });
}

function prepareSession(session) {
  const events = [];
  for (const participant of session.director.participants) {
    events.push(...session.command({ type: 'ready', from: participant.id, ready: true }).events);
  }
  events.push(...session.command({ type: 'start', from: session.director.hostId }).events);
  return events;
}

function runScenario(id, layout, ids, speeds, options = {}) {
  const session = makeSession(layout, ids, options.config ?? {});
  const events = [...prepareSession(session)];
  const tickHashes = [];
  let guard = 0;
  const maxTicks = options.maxTicks ?? 4000;
  while (guard++ < maxTicks) {
    const phase = session.director.phase;
    if (phase === RACE_PHASE.FINISHED || phase === RACE_PHASE.RESULTS) break;
    const raceTick = session.director.raceTick + (phase === RACE_PHASE.RUNNING ? 1 : 0);
    const states = {};
    for (const participantId of ids) {
      const speed = speeds[participantId] ?? speeds.default ?? 60;
      let arc = speed * raceTick / session.course.tickHz;
      if (session.course.mode === 'lap') arc %= session.course.lengthMetres;
      states[participantId] = stateAt(session.course, arc);
    }
    events.push(...session.step(states));
    if (options.recordTicks) tickHashes.push(session.hash());
  }
  return {
    id,
    session,
    events,
    tickHashes,
    snapshot: session.snapshot(),
    finalHash: session.hash(),
    eventLogHash: session.eventLogHash(),
    replayHash: session.replayHash()
  };
}

function scenarioSummary(run) {
  const results = run.snapshot.results;
  return {
    id: run.id,
    courseId: run.snapshot.course.courseId,
    phase: run.snapshot.phase,
    raceTick: run.snapshot.raceTick,
    finalHash: run.finalHash,
    eventLogHash: run.eventLogHash,
    replayHash: run.replayHash,
    results: results.rows.map((row) => ({
      id: row.id,
      status: row.status,
      position: row.position,
      tied: row.tied,
      finishTick: row.finishTick,
      totalTimeSeconds: row.totalTimeSeconds,
      lapsCompleted: row.lapsCompleted,
      checkpointsPassed: row.checkpointsPassed,
      progress: row.progress,
      bestLapSeconds: row.bestLapSeconds
    })),
    ties: results.ties,
    events: run.events,
    tickHashCount: run.tickHashes.length,
    tickHashes: run.tickHashes
  };
}

function main() {
  const sprintDoc = readLayout('sprint.json');
  const lapDoc = readLayout('sprint-lap.json');
  const sprint = new CourseModel(sprintDoc.layout);
  const lap = new CourseModel(lapDoc.layout);

  // ---------------------------------------------------------------- course ---
  check('C01', 'sprint layout hash matches the committed document',
    sprintDoc.layout.hash === recomputedLayoutHash(sprintDoc.layout) &&
    sprint.layoutHash === sprintDoc.layout.hash,
    { committed: sprintDoc.layout.hash, recomputed: recomputedLayoutHash(sprintDoc.layout) });
  check('C02', 'lap layout hash matches the committed document',
    lapDoc.layout.hash === recomputedLayoutHash(lapDoc.layout) &&
    lap.layoutHash === lapDoc.layout.hash,
    { committed: lapDoc.layout.hash, recomputed: recomputedLayoutHash(lapDoc.layout) });
  check('C03', 'sprint CourseModel mode/gates',
    sprint.mode === 'sprint' && sprint.checkpointCount === 2 &&
    sprint.gates.map((gate) => gate.kind).join(',') === 'start,checkpoint,checkpoint,finish',
    { mode: sprint.mode, checkpointCount: sprint.checkpointCount });
  // Re-centred on 2026-11-11: the line is 313.387116 m and the finish keeps the
  // committed 10 m clearance (303.187344).
  check('C04', 'sprint finish arc and measured length',
    sprint.finishArc === 303.187344 && sprint.measuredLengthMetres === 313.387116 &&
    sprint.lengthMetres === 303.187344,
    { finishArc: sprint.finishArc, measured: sprint.measuredLengthMetres });
  check('C05', 'lap CourseModel mode/laps/line',
    lap.mode === 'lap' && lap.laps === 3 && lap.lengthMetres === 222.040211 &&
    lap.lapLine.x === lap.startGate.x && lap.lapLine.z === lap.startGate.z,
    { mode: lap.mode, laps: lap.laps, lengthMetres: lap.lengthMetres });
  const beforeHash = hashOf(sprintDoc.layout);
  new CourseModel(sprintDoc.layout);
  check('C06', 'CourseModel does not mutate the layout document',
    hashOf(sprintDoc.layout) === beforeHash);
  const startPoint = sprint.positionAtArc(0);
  const startProjection = sprint.project([startPoint.x, startPoint.y, startPoint.z]);
  check('C07', 'start projects to arc 0 and lateral 0',
    Math.abs(startProjection.arc) < 1e-9 && startProjection.lateral < 1e-9,
    { projection: startProjection });
  const probeArc = 100.107736;
  const probePoint = sprint.positionAtArc(probeArc);
  const probeProjection = sprint.project([probePoint.x, probePoint.y, probePoint.z]);
  check('C08', 'positionAtArc/project round-trip within the sample step',
    Math.abs(probeProjection.arc - probeArc) < 1e-3 &&
    probeProjection.lateral < 1e-3,
    { expectedArc: probeArc, projection: probeProjection });
  const grids = [sprint.startGrid(2), sprint.startGrid(3), sprint.startGrid(4)];
  check('C09', 'start grid is deterministic and labelled provisional',
    grids.every((grid, index) => grid.length === index + 2 &&
      grid.every((slot) => slot.source === 'provisional')) &&
    grids.every((grid) => grid.every((slot) => slot.headingRad === sprint.startGate.headingRad)),
    { counts: grids.map((grid) => grid.length) });
  throws('C10', 'unsupported courseId is rejected',
    () => new CourseModel({ ...sprintDoc.layout, courseId: 'free' }));
  throws('C11', 'tampered layout hash is rejected', () => {
    const tampered = JSON.parse(JSON.stringify(sprintDoc.layout));
    tampered.gates[1].arc += 1;
    return new CourseModel(tampered);
  });
  const moduleFiles = [
    'hash.mjs', 'course-model.mjs', 'respawn-policy.mjs', 'progress-tracker.mjs',
    'race-director.mjs', 'result-model.mjs', 'race-session.mjs', 'index.mjs'
  ];
  const moduleText = Object.fromEntries(moduleFiles.map((name) => [
    name, readFileSync(path.join(HERE, name), 'utf8')
  ]));
  check('C12', 'rules modules contain no clock, random source or engine import',
    Object.entries(moduleText).every(([, text]) =>
      !/Date\.now|Math\.random|performance\.now|new Date\(/.test(text) &&
      !/from\s+['"][^'"]*e1-drive/.test(text)),
    { files: moduleFiles });

  // --------------------------------------------------------------- director ---
  const director = new RaceDirector({ participants: ['p1', 'p2'], config: { hostId: 'p1' } });
  check('D01', 'director starts in lobby', director.phase === RACE_PHASE.LOBBY);
  check('D02', 'non-host start is rejected',
    director.command({ type: 'start', from: 'p2' }).reason === 'not-host');
  check('D03', 'start before all ready is rejected',
    director.command({ type: 'start', from: 'p1' }).reason === 'not-all-ready');
  const solo = new RaceDirector({ participants: ['p1'], config: { hostId: 'p1' } });
  solo.setReady('p1', true);
  check('D04', 'start with fewer than two participants is rejected',
    solo.command({ type: 'start', from: 'p1' }).reason === 'too-few-participants');
  readyAll(director);
  const startResult = director.command({ type: 'start', from: 'p1' });
  check('D05', 'host start enters loading', startResult.accepted && director.phase === RACE_PHASE.LOADING);
  director.advance();
  check('D06', 'loading enters countdown with the layout tick count',
    director.phase === RACE_PHASE.COUNTDOWN && director.countdownTicksLeft === 90,
    { phase: director.phase, countdownTicksLeft: director.countdownTicksLeft });
  const goEvents = director.advance(90);
  check('D07', 'GO happens after exactly 90 countdown ticks',
    director.phase === RACE_PHASE.RUNNING && director.raceTick === 0 &&
    goEvents.some((event) => event.type === RACE_EVENT.GO),
    { phase: director.phase, raceTick: director.raceTick, events: goEvents.map((event) => event.type) });

  const timeoutDirector = new RaceDirector({
    participants: ['p1', 'p2'],
    config: { hostId: 'p1', countdownTicks: 2, raceTimeoutTicks: 5 }
  });
  readyAll(timeoutDirector);
  timeoutDirector.command({ type: 'start', from: 'p1' });
  advanceToRunning(timeoutDirector);
  timeoutDirector.advance(5);
  check('D08', 'race timeout marks every runner DNF at the configured tick',
    timeoutDirector.phase === RACE_PHASE.FINISHED &&
    timeoutDirector.participants.every((row) => row.status === 'dnf' && row.dnfReason === 'timeout'),
    { phase: timeoutDirector.phase, rows: timeoutDirector.snapshot().participants });

  const disconnectDirector = new RaceDirector({
    participants: ['p1', 'p2'],
    config: { hostId: 'p1', countdownTicks: 2, resultsDelayTicks: 2 }
  });
  readyAll(disconnectDirector);
  disconnectDirector.command({ type: 'start', from: 'p1' });
  advanceToRunning(disconnectDirector);
  disconnectDirector.advance(1);
  const disconnectResult = disconnectDirector.disconnect('p2');
  check('D09', 'disconnect during the race is a DNF/disconnected transition',
    disconnectResult.accepted &&
    disconnectDirector.get('p2').status === 'disconnected' &&
    disconnectDirector.get('p2').dnf === true,
    { participant: disconnectDirector.snapshot().participants.find((row) => row.id === 'p2') });
  disconnectDirector.finishParticipant('p1', 1);
  disconnectDirector.advance(2);
  check('D10', 'results phase is reached after the results delay',
    disconnectDirector.phase === RACE_PHASE.RESULTS,
    { phase: disconnectDirector.phase });
  const restartResult = disconnectDirector.restart('p1');
  check('D11', 'host restart returns to lobby and clears ready/race state',
    restartResult.accepted && disconnectDirector.phase === RACE_PHASE.LOBBY &&
    disconnectDirector.raceTick === 0 &&
    disconnectDirector.participants.every((row) => row.ready === false && row.status === 'lobby'),
    { phase: disconnectDirector.phase, rows: disconnectDirector.snapshot().participants });
  const authority = disconnectDirector.snapshot().authority;
  check('D12', 'host authority flags are explicit',
    authority.hostId === 'p1' && authority.hostAuthoritative === true &&
    authority.requireHostCommands === true && authority.clientsAcceptHostResult === true,
    authority);

  const finishDirector = new RaceDirector({
    participants: ['p1', 'p2'],
    config: { hostId: 'p1', countdownTicks: 1 }
  });
  readyAll(finishDirector);
  finishDirector.command({ type: 'start', from: 'p1' });
  advanceToRunning(finishDirector);
  const nonHostFinish = finishDirector.command({ type: 'finish', from: 'p2', id: 'p2' });
  const hostFinish = finishDirector.command({ type: 'finish', from: 'p1', id: 'p1' });
  check('D13', 'finish command is host-authoritative',
    nonHostFinish.reason === 'not-host' && hostFinish.accepted === true &&
    finishDirector.get('p1').status === 'finished',
    { nonHost: nonHostFinish.reason, host: hostFinish.accepted });
  const retained = finishDirector.disconnect('p1');
  check('D14', 'a post-finish disconnect does not erase the finish',
    retained.accepted && finishDirector.get('p1').status === 'finished' &&
    finishDirector.get('p1').disconnected === true,
    { row: finishDirector.snapshot().participants.find((row) => row.id === 'p1') });

  const leaveDirector = new RaceDirector({
    participants: ['p1', 'p2', 'p3'],
    config: { hostId: 'p1', countdownTicks: 1 }
  });
  leaveDirector.setReady('p1', true);
  leaveDirector.setReady('p2', true);
  leaveDirector.disconnect('p3');
  check('D15', 'a lobby leave does not block the remaining ready roster',
    leaveDirector.command({ type: 'start', from: 'p1' }).accepted === true &&
    leaveDirector.snapshot().counts.left === 1,
    { phase: leaveDirector.phase, counts: leaveDirector.snapshot().counts });

  const joinSession = makeSession(sprintDoc.layout, ['p1', 'p2']);
  const joinResult = joinSession.command({ type: 'join', participant: { id: 'p3', slot: 3 } });
  check('D16', 'a lobby join reaches both the director and the progress tracker',
    joinResult.accepted && joinSession.director.participants.length === 3 &&
    joinSession.progress.order.length === 3 &&
    joinSession.progress.get('p3').status === 'waiting',
    { director: joinSession.director.snapshot().participants.length, progress: joinSession.progress.order });

  // --------------------------------------------------------- sprint progress ---
  // The finish arc is read from the layout: the course length is a measured
  // value, and a hard-coded "past the finish" arc silently stops crossing the
  // line when the course changes.
  const finishArc = sprint.finishArc;
  const ordered = runProgress(sprint, [
    stateAt(sprint, 0), stateAt(sprint, 50), stateAt(sprint, 110),
    stateAt(sprint, 210), stateAt(sprint, finishArc + 1)
  ]);
  check('P01', 'ordered checkpoint crossings count in index order',
    eventsOfType(ordered.events, PROGRESS_EVENT.CHECKPOINT).length === 2 &&
    ordered.participant.checkpointsPassed === 2 &&
    ordered.participant.passedGates.map((gate) => gate.id).join(',') ===
      'start,checkpoint-1,checkpoint-2,finish',
    { events: ordered.events.map((event) => event.type) });
  check('P02', 'finish after all checkpoints sets the finish tick and 100% progress',
    ordered.participant.status === 'finished' &&
    ordered.participant.finishTick === 4 &&
    ordered.participant.progress === 1,
    { status: ordered.participant.status, finishTick: ordered.participant.finishTick });
  const primeOnly = new ProgressTracker(sprint, ['p1']);
  primeOnly.prime('p1', stateAt(sprint, 0), 0);
  check('P03', 'priming the start line does not count a gate crossing',
    primeOnly.get('p1').gateIndex === 1 && primeOnly.get('p1').checkpointsPassed === 0 &&
    primeOnly.get('p1').passedGates.length === 1);

  const skipped = runProgress(sprint, [
    stateAt(sprint, 0), stateAt(sprint, 50), stateAt(sprint, 90),
    stateAt(sprint, 210, { lateral: 80 }), stateAt(sprint, 210),
    stateAt(sprint, 250), stateAt(sprint, finishArc - 2), stateAt(sprint, finishArc + 1)
  ]);
  check('P04', 'skipping a checkpoint blocks the finish',
    skipped.participant.status === 'running' &&
    skipped.participant.checkpointsPassed === 0 &&
    eventsOfType(skipped.events, PROGRESS_EVENT.FINISH_BLOCKED).length === 1 &&
    eventsOfType(skipped.events, PROGRESS_EVENT.FINISH).length === 0,
    { status: skipped.participant.status, events: skipped.events.map((event) => event.type) });

  const outOfOrder = runProgress(sprint, [
    stateAt(sprint, 0, { lateral: 80 }), stateAt(sprint, 190, { lateral: 80 }),
    stateAt(sprint, 190), stateAt(sprint, 195), stateAt(sprint, 205)
  ]);
  check('P05', 'crossing a later checkpoint first reports gate-out-of-order',
    eventsOfType(outOfOrder.events, PROGRESS_EVENT.GATE_OUT_OF_ORDER).length === 1 &&
    outOfOrder.participant.checkpointsPassed === 0,
    { events: outOfOrder.events.map((event) => event.type) });

  const wrongWayStates = [stateAt(sprint, 50),
    ...Array.from({ length: 35 }, () => stateAt(sprint, 50, { forwardSign: -1 }))];
  const wrongWay = runProgress(sprint, wrongWayStates);
  check('P06', 'wrong-way is reported after the configured consecutive ticks',
    wrongWay.participant.wrongWay === true &&
    eventsOfType(wrongWay.events, PROGRESS_EVENT.WRONG_WAY).length === 1 &&
    wrongWay.participant.wrongWayTicks >= 30,
    { wrongWayTicks: wrongWay.participant.wrongWayTicks });

  const offBefore = runProgress(sprint, [
    stateAt(sprint, 0), stateAt(sprint, 50), stateAt(sprint, 52, { lateral: 10 })
  ], { respawn: {} });
  const offBeforeRespawn = eventsOfType(offBefore.events, PROGRESS_EVENT.RESPAWN)[0];
  check('P07', 'off-course respawn targets the start line before the first checkpoint',
    Boolean(offBeforeRespawn) &&
    offBeforeRespawn.target.gateId === 'start' &&
    offBeforeRespawn.target.gateIndex === 0 &&
    offBeforeRespawn.reasonNames.includes('off-course'),
    { respawn: offBeforeRespawn?.target, reasons: offBeforeRespawn?.reasonNames });

  const offAfter = runProgress(sprint, [
    stateAt(sprint, 0), stateAt(sprint, 50), stateAt(sprint, 110),
    stateAt(sprint, 112, { lateral: 10 })
  ], { respawn: {} });
  const offAfterRespawn = eventsOfType(offAfter.events, PROGRESS_EVENT.RESPAWN)[0];
  check('P08', 'off-course respawn targets the last passed checkpoint',
    Boolean(offAfterRespawn) &&
    offAfterRespawn.target.gateId === 'checkpoint-1' &&
    offAfterRespawn.target.gateIndex === 1,
    { respawn: offAfterRespawn?.target });
  const duplicateRespawn = offAfter.tracker.step('p1', stateAt(sprint, 112, { lateral: 10 }), 4);
  offAfter.tracker.rejoin('p1', stateAt(sprint, 0), 5);
  const afterRejoin = offAfter.tracker.step('p1', stateAt(sprint, 60), 6);
  check('P09', 'a respawn waits for rejoin and does not duplicate the event',
    duplicateRespawn.length === 0 && afterRejoin.length === 0 &&
    offAfter.tracker.get('p1').awaitingRejoin === false,
    { duplicate: duplicateRespawn.map((event) => event.type), afterRejoin: afterRejoin.map((event) => event.type) });

  const belowGround = runProgress(sprint, [
    stateAt(sprint, 0), stateAt(sprint, 50, { yOffset: -2 })
  ], { respawn: {} });
  const belowRespawn = eventsOfType(belowGround.events, PROGRESS_EVENT.RESPAWN)[0];
  check('P10', 'below-ground is an explicit respawn reason',
    Boolean(belowRespawn) && belowRespawn.reasonNames.includes('below-ground'),
    { reasons: belowRespawn?.reasonNames, detail: belowRespawn?.reasons });

  const airborneStates = [stateAt(sprint, 0),
    ...Array.from({ length: 31 }, () => stateAt(sprint, 50, { contact: false }))];
  const airborne = runProgress(sprint, airborneStates, { respawn: {} });
  const airborneRespawn = eventsOfType(airborne.events, PROGRESS_EVENT.RESPAWN)[0];
  check('P11', 'airborne is reported after 30 consecutive ticks',
    Boolean(airborneRespawn) && airborneRespawn.reasonNames.includes('airborne') &&
    airborneRespawn.tick === 30,
    { reasons: airborneRespawn?.reasonNames, tick: airborneRespawn?.tick });
  const noWalls = new RespawnPolicy(sprint).toJSON();
  check('P12', 'respawn is a post-hoc target, never an invisible wall',
    noWalls.noInvisibleWalls === true &&
    noWalls.targetRule.includes('last passed checkpoint'),
    noWalls);
  const finiteGuard = new ProgressTracker(sprint, ['p1']);
  finiteGuard.prime('p1', stateAt(sprint, 0), 0);
  throws('P13', 'a non-finite vehicle state fails explicitly',
    () => finiteGuard.step('p1', { position: [Number.NaN, 0, 0], contact: true }, 1));
  const noContact = new ProgressTracker(sprint, ['p1'], { respawn: {} });
  noContact.prime('p1', stateAt(sprint, 0), 0);
  let noContactRespawns = 0;
  for (let tick = 1; tick <= 40; tick++) {
    const state = { position: stateAt(sprint, 50).position, forward: stateAt(sprint, 50).forward };
    noContactRespawns += noContact.step('p1', state, tick)
      .filter((event) => event.type === PROGRESS_EVENT.RESPAWN).length;
  }
  check('P14', 'missing contact never claims an airborne respawn',
    noContactRespawns === 0 && noContact.get('p1').contactKnown === false &&
    noContact.get('p1').airborneTicks === 0,
    { respawns: noContactRespawns, contactKnown: noContact.get('p1').contactKnown });

  // ------------------------------------------------------------- lap progress ---
  const lapStates = [stateAt(lap, 0)];
  for (let tick = 1; tick <= 740; tick++) {
    lapStates.push(stateAt(lap, (60 * tick / lap.tickHz) % lap.lengthMetres));
  }
  const lapRun = runProgress(lap, lapStates);
  const lapEvents = eventsOfType(lapRun.events, PROGRESS_EVENT.LAP);
  const finishEvents = eventsOfType(lapRun.events, PROGRESS_EVENT.FINISH);
  check('L01', 'lap 1 completes only after a full loop',
    lapEvents.length >= 2 && lapEvents[0].lap === 1 && lapEvents[0].lapSeconds > 0 &&
    lapRun.participant.lapIndex === 3,
    { lapEvents: lapEvents.map((event) => ({ lap: event.lap, lapSeconds: event.lapSeconds })) });
  check('L02', 'three lap crossings finish the loop race with lap times',
    finishEvents.length === 1 && lapRun.participant.status === 'finished' &&
    lapRun.participant.lapTimes.length === 3 &&
    Math.abs(Math.min(...lapRun.participant.lapTimes) -
      lapRun.participant.lapTimes.slice().sort((a, b) => a - b)[0]) < 1e-9,
    { status: lapRun.participant.status, lapTimes: lapRun.participant.lapTimes });
  check('L03', 'lap progress is cumulative and clamped to three laps',
    lapRun.participant.progress === 1 &&
    lapRun.participant.progressMetres === 666.120633,
    { progress: lapRun.participant.progress, metres: lapRun.participant.progressMetres });

  const shortLap = runProgress(lap, [
    stateAt(lap, 0), stateAt(lap, 10), stateAt(lap, 221), stateAt(lap, 2), stateAt(lap, 3)
  ]);
  check('L04', 'a line crossing before a full lap does not count',
    shortLap.participant.lapIndex === 0 &&
    eventsOfType(shortLap.events, PROGRESS_EVENT.LAP).length === 0 &&
    shortLap.participant.status === 'running',
    { lapIndex: shortLap.participant.lapIndex, events: shortLap.events.map((event) => event.type) });

  const lapRespawnTracker = new ProgressTracker(lap, ['p1'], { respawn: {} });
  lapRespawnTracker.prime('p1', stateAt(lap, 10), 0);
  const lapRespawnEvents = lapRespawnTracker.step('p1', stateAt(lap, 12, { lateral: 4 }), 1);
  const lapRespawn = eventsOfType(lapRespawnEvents, PROGRESS_EVENT.RESPAWN)[0];
  check('L05', 'lap respawn targets the start/finish line',
    Boolean(lapRespawn) && lapRespawn.target.gateId === 'lap-line' &&
    lapRespawn.target.gateIndex === 0,
    { respawn: lapRespawn?.target });
  check('L06', 'one lap is not a finish',
    lapRun.participant.status === 'finished' &&
    lapEvents.length === 2 && finishEvents.length === 1 &&
    finishEvents[0].lap === 3,
    { lapEventLaps: lapEvents.map((event) => event.lap), finishLap: finishEvents[0]?.lap });

  // ----------------------------------------------------------------- results ---
  const sprint2 = runScenario('sprint-2p', sprintDoc.layout, ['p1', 'p2'], { p1: 60, p2: 50 });
  const result2 = sprint2.snapshot.results;
  check('R01', 'finishers are ordered by total time',
    result2.order.join(',') === 'p1,p2' &&
    result2.rows[0].finishTick < result2.rows[1].finishTick &&
    result2.rows[0].position === 1 && result2.rows[1].position === 2,
    { order: result2.order, rows: result2.rows.map((row) => [row.id, row.finishTick]) });

  const tie = runScenario('tie', sprintDoc.layout, ['p1', 'p2'], { p1: 60, p2: 60 });
  const tieResult = tie.snapshot.results;
  check('R02', 'equal finish ticks produce a shared position and a tie group',
    tieResult.rows.every((row) => row.position === 1 && row.tied === true) &&
    tieResult.ties.length === 1 && tieResult.ties[0].participants.length === 2,
    { rows: tieResult.rows.map((row) => [row.id, row.position, row.tied]), ties: tieResult.ties });

  const dnfSession = makeSession(sprintDoc.layout, ['p1', 'p2', 'p3'], { resultsDelayTicks: 2 });
  const dnfEvents = [...prepareSession(dnfSession)];
  let dnfGuard = 0;
  while (dnfGuard++ < 2000) {
    const phase = dnfSession.director.phase;
    if (phase === RACE_PHASE.FINISHED || phase === RACE_PHASE.RESULTS) break;
    const raceTick = dnfSession.director.raceTick + (phase === RACE_PHASE.RUNNING ? 1 : 0);
    const states = {};
    const speeds = { p1: 60, p2: 50, p3: 55 };
    for (const id of ['p1', 'p2', 'p3']) {
      states[id] = stateAt(dnfSession.course, speeds[id] * raceTick / dnfSession.course.tickHz);
    }
    dnfEvents.push(...dnfSession.step(states));
    if (dnfSession.director.phase === RACE_PHASE.RUNNING && dnfSession.director.raceTick === 2) {
      dnfEvents.push(...dnfSession.command({ type: 'disconnect', from: 'p3' }).events);
      dnfEvents.push(...dnfSession.command({ type: 'dnf', from: 'p1', id: 'p2', reason: 'admin-dnf' }).events);
    }
  }
  const dnfResult = dnfSession.snapshot().results;
  check('R03', 'DNF and disconnect sort after finishers, DNF before disconnect',
    dnfResult.order.join(',') === 'p1,p2,p3' &&
    dnfResult.rows[0].status === 'finished' &&
    dnfResult.rows[1].status === 'dnf' &&
    dnfResult.rows[2].status === 'disconnected',
    { order: dnfResult.order, statuses: dnfResult.rows.map((row) => row.status) });
  check('R04', 'disconnect is labelled with its reason',
    dnfResult.rows[2].dnfReason === 'disconnected',
    { row: dnfResult.rows[2] });

  const lap2 = runScenario('lap-2p', lapDoc.layout, ['p1', 'p2'], { p1: 60, p2: 55 });
  const lapResult = lap2.snapshot.results;
  const lapWinner = lapResult.rows[0];
  check('R05', 'lap results carry total time and best lap',
    lapWinner.status === 'finished' &&
    Math.abs(lapWinner.totalTimeSeconds - lapWinner.finishTick / lap.tickHz) < 1e-6 &&
    lapWinner.bestLapSeconds === Math.min(...lapWinner.lapTimes),
    { totalTimeSeconds: lapWinner.totalTimeSeconds, bestLapSeconds: lapWinner.bestLapSeconds });
  check('R06', 'result hash is stable for the same snapshot',
    lapResult.hash === new ResultModel(lap).build({
      director: lap2.snapshot.director,
      progress: lap2.snapshot.progress
    }).hash);
  const manualDirector = {
    participants: [
      { id: 'a', slot: 1, status: 'running', finishTick: null, dnfReason: null },
      { id: 'b', slot: 2, status: 'running', finishTick: null, dnfReason: null },
      { id: 'c', slot: 3, status: 'running', finishTick: null, dnfReason: null }
    ]
  };
  const manualProgress = {
    participants: [
      { id: 'a', status: 'running', lapsCompleted: 0, checkpointsPassed: 1, totalCheckpoints: 2,
        progress: 0.4, progressMetres: 120, finishTick: null, lapTimes: [] },
      { id: 'b', status: 'running', lapsCompleted: 0, checkpointsPassed: 0, totalCheckpoints: 2,
        progress: 0.8, progressMetres: 240, finishTick: null, lapTimes: [] },
      { id: 'c', status: 'running', lapsCompleted: 1, checkpointsPassed: 0, totalCheckpoints: 2,
        progress: 0.1, progressMetres: 30, finishTick: null, lapTimes: [5] }
    ]
  };
  const manualResult = new ResultModel(sprint).build({
    director: manualDirector,
    progress: manualProgress
  });
  check('R07', 'unfinished rows rank by laps, then checkpoints, then progress',
    manualResult.order.join(',') === 'c,a,b',
    { order: manualResult.order, rows: manualResult.rows.map((row) => [row.id, row.lapsCompleted, row.checkpointsPassed, row.progress]) });

  // --------------------------------------------------------------- scenarios ---
  const scenarioSpecs = [
    { id: 'sprint-3p', layout: sprintDoc.layout, ids: ['p1', 'p2', 'p3'], speeds: { p1: 60, p2: 55, p3: 50 }, recordTicks: true },
    { id: 'sprint-4p', layout: sprintDoc.layout, ids: ['p1', 'p2', 'p3', 'p4'], speeds: { p1: 60, p2: 56, p3: 52, p4: 48 } },
    { id: 'lap-3p', layout: lapDoc.layout, ids: ['p1', 'p2', 'p3'], speeds: { p1: 60, p2: 55, p3: 50 } },
    { id: 'lap-4p', layout: lapDoc.layout, ids: ['p1', 'p2', 'p3', 'p4'], speeds: { p1: 60, p2: 56, p3: 52, p4: 48 }, recordTicks: true }
  ];
  const runs = [];
  for (const spec of scenarioSpecs) {
    const first = runScenario(spec.id, spec.layout, spec.ids, spec.speeds, { recordTicks: spec.recordTicks });
    const second = runScenario(spec.id, spec.layout, spec.ids, spec.speeds, { recordTicks: spec.recordTicks });
    runs.push({ spec, first, second });
    const allFinished = first.snapshot.results.rows.every((row) => row.status === 'finished');
    const expectedOrder = spec.ids.slice().sort((a, b) => (spec.speeds[b] - spec.speeds[a]) || (a < b ? -1 : 1));
    check('S-' + spec.id, spec.id + ' completes with 2-4 participants',
      allFinished && first.snapshot.results.order.join(',') === expectedOrder.join(',') &&
      first.snapshot.results.rows.every((row) => row.lapsCompleted === (spec.layout.courseId === 'lap' ? 3 : 1)),
      { order: first.snapshot.results.order, expectedOrder, statuses: first.snapshot.results.rows.map((row) => row.status) });
    check('S-' + spec.id + '-replay', spec.id + ' is byte-identical on a second run',
      first.finalHash === second.finalHash &&
      first.eventLogHash === second.eventLogHash &&
      first.replayHash === second.replayHash,
      { first: first.replayHash, second: second.replayHash });
    if (spec.recordTicks) {
      check('S-' + spec.id + '-ticks', spec.id + ' per-tick hashes are identical on replay',
        first.tickHashes.length === second.tickHashes.length &&
        first.tickHashes.every((hash, index) => hash === second.tickHashes[index]),
        { ticks: first.tickHashes.length, first: first.tickHashes[0], last: first.tickHashes[first.tickHashes.length - 1] });
    }
  }

  // Restart integration: finish a race, reach results, restart, run again.
  const restartSession = makeSession(sprintDoc.layout, ['p1', 'p2'], { resultsDelayTicks: 2 });
  prepareSession(restartSession);
  let restartGuard = 0;
  while (restartGuard++ < 2000) {
    const phase = restartSession.director.phase;
    if (phase === RACE_PHASE.RESULTS) break;
    const raceTick = restartSession.director.raceTick + (phase === RACE_PHASE.RUNNING ? 1 : 0);
    const states = {};
    for (const id of ['p1', 'p2']) {
      const speed = id === 'p1' ? 60 : 50;
      states[id] = stateAt(restartSession.course, speed * raceTick / restartSession.course.tickHz);
    }
    restartSession.step(states);
  }
  const restartAccepted = restartSession.command({ type: 'restart', from: 'p1' });
  const restartState = restartSession.snapshot();
  check('S-RESTART', 'restart returns the session to lobby with cleared progress',
    restartAccepted.accepted && restartState.phase === RACE_PHASE.LOBBY &&
    restartState.progress.participants.every((row) => row.status === 'waiting') &&
    restartState.director.participants.every((row) => row.ready === false),
    { phase: restartState.phase, progress: restartState.progress.participants.map((row) => row.status) });
  prepareSession(restartSession);
  advanceToRunning(restartSession.director);
  check('S-RESTART-RUN', 'a restarted race reaches running again',
    restartSession.director.phase === RACE_PHASE.RUNNING,
    { phase: restartSession.director.phase });

  // ------------------------------------------------------------------ outputs ---
  const failed = checks.filter((row) => !row.ok);
  const status = failed.length === 0 ? 'pass' : 'fail';

  const scenarioTraces = runs.map(({ spec, first }) => scenarioSummary(first));
  scenarioTraces.push(scenarioSummary(sprint2));
  scenarioTraces.push(scenarioSummary(tie));
  scenarioTraces.push(scenarioSummary(lap2));
  scenarioTraces.push(scenarioSummary({
    id: 'sprint-dnf-3p',
    session: dnfSession,
    events: dnfEvents,
    tickHashes: [],
    snapshot: dnfSession.snapshot(),
    finalHash: dnfSession.hash(),
    eventLogHash: dnfSession.eventLogHash(),
    replayHash: dnfSession.replayHash()
  }));

  const traceBody = {
    schema: 'blur.race-rules.trace/1',
    command: 'node probes/race-rules/verify.mjs',
    scope: {
      rulesOnly: true,
      engineIntegration: false,
      renderer: false,
      network: false,
      retailParity: false,
      assetReaders: false
    },
    inputs: {
      sprint: {
        file: sprintDoc.relative,
        fileSha256: 'sha256:' + sprintDoc.fileSha256,
        layoutHash: sprintDoc.layout.hash,
        modelHash: sprint.modelHash,
        courseId: sprint.courseId,
        gates: sprint.gates.length,
        samples: sprint.samples.length
      },
      lap: {
        file: lapDoc.relative,
        fileSha256: 'sha256:' + lapDoc.fileSha256,
        layoutHash: lapDoc.layout.hash,
        modelHash: lap.modelHash,
        courseId: lap.courseId,
        gates: lap.gates.length,
        samples: lap.samples.length
      }
    },
    config: {
      countdownTicks: sprint.countdownTicks,
      tickHz: sprint.tickHz,
      syntheticSpeedsMetresPerSecond: [48, 50, 52, 55, 56, 60],
      syntheticState: 'position on the measured centre line + forward tangent + contact=true',
      source: 'synthetic; no engine step'
    },
    scenarios: scenarioTraces,
    determinism: {
      repeatRunsPerScenario: 2,
      allScenarioHashesEqual: runs.every(({ first, second }) =>
        first.finalHash === second.finalHash &&
        first.eventLogHash === second.eventLogHash &&
        first.replayHash === second.replayHash),
      tickReplay: runs.filter(({ spec }) => spec.recordTicks).map(({ spec, first, second }) => ({
        id: spec.id,
        ticks: first.tickHashes.length,
        equal: first.tickHashes.length === second.tickHashes.length &&
          first.tickHashes.every((hash, index) => hash === second.tickHashes[index]),
        finalHash: first.finalHash
      }))
    },
    limits: [
      'Rules-only module: no physics step, engine import, renderer or network claim.',
      'Synthetic participant motion is a straight arc interpolation on the measured course; it is not a car physics run.',
      'The 310 m sprint keeps its committed point-to-point meaning. The loop-01 lap course keeps the partial draw-coverage label recorded by e1-drive.',
      'The starting grid, wrong-way thresholds, respawn timing and results delay are project-specific tuning, labelled provisional where they are not layout-declared.',
      'No retail race director, split-line, damage, pickup or scoring behaviour is claimed.'
    ]
  };
  const traceHash = hashOf(traceBody);
  const trace = { ...traceBody, traceHash };

  const hashes = {
    schema: 'blur.race-rules.hashes/1',
    layouts: {
      sprint: sprintDoc.layout.hash,
      lap: lapDoc.layout.hash
    },
    files: {
      sprint: 'sha256:' + sprintDoc.fileSha256,
      lap: 'sha256:' + lapDoc.fileSha256
    },
    courseModels: {
      sprint: sprint.modelHash,
      lap: lap.modelHash
    },
    scenarios: Object.fromEntries(runs.map(({ spec, first }) => [spec.id, {
      finalHash: first.finalHash,
      eventLogHash: first.eventLogHash,
      replayHash: first.replayHash
    }])),
    trace: traceHash
  };

  const verifyBody = {
    schema: 'blur.race-rules.verify/1',
    status,
    command: 'node probes/race-rules/verify.mjs',
    checks: {
      total: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length
    },
    results: checks,
    counts: {
      courses: 2,
      participants: [2, 3, 4],
      deterministicScenarios: runs.length,
      traceScenarios: scenarioTraces.length,
      tickHashes: runs.filter(({ spec }) => spec.recordTicks)
        .reduce((sum, { first }) => sum + first.tickHashes.length, 0)
    },
    hashes,
    evidence: {
      trace: '_work/race-rules/trace.json',
      verify: '_work/race-rules/verify.json',
      hashes: '_work/race-rules/hashes.json',
      log: '_work/logs/race-rules/verify.log'
    },
    scope: traceBody.scope,
    limits: traceBody.limits
  };

  writeFileSync(TRACE_FILE, JSON.stringify(trace, null, 2) + '\n');
  writeFileSync(HASHES_FILE, JSON.stringify(hashes, null, 2) + '\n');
  writeFileSync(VERIFY_FILE, JSON.stringify(verifyBody, null, 2) + '\n');
  writeFileSync(LOG_FILE, [
    'race-rules verification',
    'command: node probes/race-rules/verify.mjs',
    'checks: ' + checks.length + ' total, ' + (checks.length - failed.length) + ' passed, ' + failed.length + ' failed',
    'traceHash: ' + traceHash,
    '',
    ...logLines,
    ''
  ].join('\n'));

  console.log('checks: ' + checks.length + ' total, ' +
    (checks.length - failed.length) + ' passed, ' + failed.length + ' failed');
  console.log('trace: ' + TRACE_FILE);
  console.log('verify: ' + VERIFY_FILE);
  console.log('hashes: ' + HASHES_FILE);
  console.log('log: ' + LOG_FILE);
  console.log('traceHash: ' + traceHash);
  if (failed.length) {
    for (const row of failed) console.log('FAIL ' + row.id + ' ' + row.name + ' :: ' + JSON.stringify(row.detail));
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  const message = String(error?.stack ?? error);
  writeFileSync(LOG_FILE, 'FAIL fatal\n' + message + '\n');
  writeFileSync(VERIFY_FILE, JSON.stringify({
    schema: 'blur.race-rules.verify/1',
    status: 'fail',
    checks: { total: 0, passed: 0, failed: 1 },
    fatal: message
  }, null, 2) + '\n');
  console.error(message);
  process.exitCode = 1;
}
