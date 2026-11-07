// RaceSession — integration wrapper for the M1 online race.
//
// One authoritative session owns a CourseModel, a RaceDirector, a
// ProgressTracker and a ResultModel. The host calls step(states) once per fixed
// engine tick (60 Hz); each state is the engine's post-step vehicle state. The
// session turns phase transitions, gate crossings, laps, finishes, respawns and
// results into one deterministic event log and snapshot hash.
//
// This module does not load assets, does not step physics and does not send a
// network packet. The room/transport layer only carries commands in and events
// or snapshots out.

import { CourseModel } from './course-model.mjs';
import { RaceDirector, RACE_PHASE, RACE_EVENT } from './race-director.mjs';
import { ProgressTracker, PROGRESS_STATUS } from './progress-tracker.mjs';
import { ResultModel } from './result-model.mjs';
import { hashOf } from './hash.mjs';

function stateFor(states, id) {
  if (!states) return null;
  if (Array.isArray(states)) return states.find((entry) => entry?.id === id) ?? null;
  return states[id] ?? null;
}

function directorStatusToProgress(status) {
  if (status === 'dnf') return PROGRESS_STATUS.DNF;
  if (status === 'disconnected') return PROGRESS_STATUS.DISCONNECTED;
  if (status === 'left') return PROGRESS_STATUS.LEFT;
  return null;
}

export class RaceSession {
  /**
   * @param {object} options
   * @param {object} options.layout parsed committed layout JSON (read-only)
   * @param {Array<{id:string, slot?:number}|string>} options.participants
   * @param {object} [options.config]
   */
  constructor({ layout, participants, config = {} } = {}) {
    this.course = new CourseModel(layout, { verifyLayoutHash: config.verifyLayoutHash !== false });
    this.participantsInput = participants;
    const directorConfig = {
      hostId: config.hostId,
      hostAuthority: config.hostAuthority,
      requireAllReady: config.requireAllReady,
      minParticipants: config.minParticipants,
      maxParticipants: config.maxParticipants,
      countdownTicks: config.countdownTicks ?? this.course.countdownTicks,
      loadingTicks: config.loadingTicks,
      resultsDelayTicks: config.resultsDelayTicks,
      raceTimeoutTicks: config.raceTimeoutTicks,
      tickHz: this.course.tickHz,
      allowLateJoin: config.allowLateJoin
    };
    for (const key of Object.keys(directorConfig)) {
      if (directorConfig[key] === undefined) delete directorConfig[key];
    }
    this.director = new RaceDirector({ participants, config: directorConfig });
    this.progress = new ProgressTracker(this.course, participants, {
      ...(config.progress ?? {}),
      tickHz: this.course.tickHz,
      respawn: config.respawn ?? config.progress?.respawn
    });
    this.resultsModel = new ResultModel(this.course, config.results ?? {});
    this.primed = false;
    this.eventLog = [];
    this.lastEvent = null;
  }

  get phase() {
    return this.director.phase;
  }

  get raceTick() {
    return this.director.raceTick;
  }

  record(events) {
    for (const event of events) {
      const row = { index: this.eventLog.length, ...event };
      this.eventLog.push(row);
      this.lastEvent = row;
    }
    return events;
  }

  /** Apply a room/command message; resets race bookkeeping on start/restart. */
  command(message) {
    const type = message?.type;
    const result = this.director.command(message);
    this.record(result.events);
    if (result.accepted && (type === 'start' || type === 'restart')) {
      this.progress.reset();
      this.primed = false;
    }
    if (result.accepted && type === 'disconnect') {
      const id = message.from ?? message.id;
      const directorRow = this.director.byId.get(id);
      if (directorRow) this.syncTerminal(directorRow);
    }
    if (result.accepted && type === 'join') {
      const participant = message.participant ?? message;
      const row = this.director.get(participant.id);
      this.progress.addParticipant({ id: row.id, slot: row.slot });
    }
    return result;
  }

  /** Mirror director terminal states into the progress snapshot. */
  syncTerminal(only = null) {
    const rows = only ? [only] : this.director.participants;
    for (const directorRow of rows) {
      const status = directorStatusToProgress(directorRow.status);
      if (!status) continue;
      const progressRow = this.progress.byId.get(directorRow.id);
      if (!progressRow) continue;
      if (progressRow.status === PROGRESS_STATUS.FINISHED) continue;
      if (progressRow.status === status) continue;
      this.progress.markTerminal(directorRow.id, status, directorRow.dnfReason, this.director.raceTick);
    }
  }

  /**
   * Advance the authoritative clock by one tick and consume the post-step
   * vehicle states. States may be a map {id: state} or an array of
   * {id, position, forward|velocity, contact}.
   *
   * The GO tick primes the start state without counting a crossing. The next
   * running tick is race tick 1.
   */
  step(states = null) {
    const events = [];
    const directorEvents = this.director.advance();
    events.push(...directorEvents);
    this.record(directorEvents);
    this.syncTerminal();

    if (this.director.phase === RACE_PHASE.RUNNING) {
      if (!this.primed) {
        for (const participant of this.director.participants) {
          const state = stateFor(states, participant.id);
          if (state) this.progress.prime(participant.id, state, 0);
        }
        this.primed = true;
      } else if (this.director.raceTick > 0) {
        for (const participant of this.director.participants) {
          if (this.director.phase !== RACE_PHASE.RUNNING) break;
          const directorRow = this.director.get(participant.id);
          if (directorRow.status !== 'running') continue;
          const state = stateFor(states, participant.id);
          if (!state) continue;
          const progressEvents = this.progress.step(participant.id, state, this.director.raceTick);
          if (progressEvents.length) {
            events.push(...progressEvents);
            this.record(progressEvents);
          }
          for (const event of progressEvents) {
            if (event.type === 'finish') {
              const finished = this.director.finishParticipant(participant.id, this.director.raceTick);
              events.push(...finished.events);
              this.record(finished.events);
            }
          }
        }
        // A finish can end the race inside the participant loop; sync the rows
        // that were already marked terminal by a timeout or disconnect.
        this.syncTerminal();
      }
    }
    return events;
  }

  /** Full deterministic snapshot: course metadata, phases, progress, results. */
  snapshot() {
    const director = this.director.snapshot();
    const progress = this.progress.snapshot();
    const results = this.resultsModel.build({ director, progress });
    return {
      schema: 'blur.race-rules.session/1',
      phase: director.phase,
      tick: director.tick,
      raceTick: director.raceTick,
      course: this.course.toJSON(),
      grid: this.course.startGrid(this.director.participants.length),
      director,
      progress,
      results
    };
  }

  hash() {
    return hashOf(this.snapshot());
  }

  eventLogHash() {
    return hashOf(this.eventLog);
  }

  /** Hash of both the final snapshot and the ordered event log. */
  replayHash() {
    return hashOf({ snapshot: this.snapshot(), events: this.eventLog });
  }
}

export { CourseModel, RaceDirector, ProgressTracker, ResultModel, RACE_PHASE, RACE_EVENT };
