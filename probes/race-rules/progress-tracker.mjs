// ProgressTracker — per-participant ordered gate/lap progress for the race
// rules layer. It reads only the CourseModel and a normalized vehicle state
// ({position, forward or velocity, contact}) and never calls an engine.
//
// Sprint (310 m): gates count only in index order; a finish crossing before
// every checkpoint is rejected. Progress is the furthest measured arc reached.
// Lap (loop-01): the start/finish line is crossed once per lap and only counts
// after a full lap of accumulated forward travel; three laps finish the race.
//
// Wrong-way, off-course, below-ground and airborne detection are deterministic
// tick counters. A respawn event puts the participant in `awaitingRejoin` until
// the caller rebuilds the car and calls rejoin(), exactly like the existing
// e1-drive rule surface.

import { RespawnPolicy, RESPAWN_REASON } from './respawn-policy.mjs';

export const PROGRESS_STATUS = Object.freeze({
  WAITING: 'waiting',
  RUNNING: 'running',
  FINISHED: 'finished',
  DNF: 'dnf',
  DISCONNECTED: 'disconnected',
  LEFT: 'left'
});

export const PROGRESS_EVENT = Object.freeze({
  CHECKPOINT: 'checkpoint',
  LAP: 'lap',
  LAP_REJECTED: 'lap-rejected',
  FINISH: 'finish',
  FINISH_BLOCKED: 'finish-blocked',
  GATE_OUT_OF_ORDER: 'gate-out-of-order',
  WRONG_WAY: 'wrong-way',
  WRONG_WAY_CLEARED: 'wrong-way-cleared',
  OFF_COURSE: 'off-course',
  OFF_COURSE_CLEARED: 'off-course-cleared',
  RESPAWN: 'respawn'
});

/** Tuning that is not recovered from retail data is labelled provisional. */
export const PROGRESS_DEFAULTS = Object.freeze({
  wrongWayDotThreshold: -0.25,
  wrongWayTicks: 30,
  lapCrossingToleranceMetres: 2.0,
  source: 'provisional'
});

const round6 = (value) => Math.round(value * 1e6) / 1e6;
const clamp01 = (value) => Math.max(0, Math.min(1, value));

function normalizeParticipants(participants) {
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new Error('ProgressTracker needs participants');
  }
  const rows = participants.map((entry, index) => {
    const value = typeof entry === 'string' ? { id: entry } : entry;
    if (!value || typeof value.id !== 'string' || value.id.length === 0) {
      throw new Error('participant at index ' + index + ' has no id');
    }
    const slot = value.slot ?? index + 1;
    if (!Number.isInteger(slot) || slot < 1) throw new Error('participant slot must be a positive integer');
    return { id: value.id, slot };
  });
  const ids = new Set(rows.map((row) => row.id));
  if (ids.size !== rows.length) throw new Error('duplicate participant id');
  const slots = new Set(rows.map((row) => row.slot));
  if (slots.size !== rows.length) throw new Error('duplicate participant slot');
  return rows.sort((a, b) => a.slot - b.slot ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function cloneState(state) {
  if (!state || !Array.isArray(state.position) || state.position.length < 3) {
    throw new Error('vehicle state needs a [x, y, z] position');
  }
  for (const value of state.position.slice(0, 3)) {
    if (!Number.isFinite(value)) throw new Error('vehicle position must be finite');
  }
  const contact = state.contact !== undefined ? state.contact
    : state.onGround !== undefined ? state.onGround : null;
  return {
    tick: Number.isInteger(state.tick) ? state.tick : null,
    position: state.position.slice(0, 3),
    forward: Array.isArray(state.forward) && state.forward.length >= 2
      ? [state.forward[0], state.forward[1] ?? 0, state.forward[2] ?? 0] : null,
    velocity: Array.isArray(state.velocity) && state.velocity.length >= 2
      ? [state.velocity[0], state.velocity[1] ?? 0, state.velocity[2] ?? 0] : null,
    contact,
    finite: state.finite ?? 1
  };
}

export class ProgressTracker {
  /**
   * @param {import('./course-model.mjs').CourseModel} course
   * @param {Array<{id:string, slot?:number}|string>} participants
   * @param {object} config
   */
  constructor(course, participants, config = {}) {
    if (!course) throw new Error('ProgressTracker needs a CourseModel');
    this.course = course;
    this.participantsInput = normalizeParticipants(participants);
    this.config = Object.freeze({
      tickHz: config.tickHz ?? course.tickHz,
      wrongWayDotThreshold: config.wrongWayDotThreshold ?? PROGRESS_DEFAULTS.wrongWayDotThreshold,
      wrongWayTicks: config.wrongWayTicks ?? PROGRESS_DEFAULTS.wrongWayTicks,
      lapCrossingToleranceMetres: config.lapCrossingToleranceMetres ??
        PROGRESS_DEFAULTS.lapCrossingToleranceMetres,
      source: config.source ?? PROGRESS_DEFAULTS.source
    });
    if (!(this.config.tickHz > 0)) throw new Error('ProgressTracker tickHz must be positive');
    if (!Number.isInteger(this.config.wrongWayTicks) || this.config.wrongWayTicks < 1) {
      throw new Error('ProgressTracker wrongWayTicks must be a positive integer');
    }
    if (!(this.config.lapCrossingToleranceMetres >= 0)) {
      throw new Error('ProgressTracker lapCrossingToleranceMetres must be >= 0');
    }
    this.policy = new RespawnPolicy(course, config.respawn ?? {});
    this.reset();
  }

  reset() {
    this.byId = new Map();
    this.order = [];
    for (const entry of this.participantsInput) {
      const participant = this.createParticipant(entry);
      this.byId.set(entry.id, participant);
      this.order.push(entry.id);
    }
  }

  /** Add a lobby participant before the race starts. */
  addParticipant(entry) {
    const [normalized] = normalizeParticipants([entry]);
    if (this.byId.has(normalized.id)) throw new Error('duplicate participant id ' + normalized.id);
    if (this.participantsInput.some((row) => row.slot === normalized.slot)) {
      throw new Error('duplicate participant slot ' + normalized.slot);
    }
    this.participantsInput.push(normalized);
    this.participantsInput.sort((a, b) => a.slot - b.slot ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const participant = this.createParticipant(normalized);
    this.byId.set(normalized.id, participant);
    this.order = this.participantsInput.map((row) => row.id);
    return participant;
  }

  createParticipant(entry) {
    const lapMode = this.course.mode === 'lap';
    return {
      id: entry.id,
      slot: entry.slot,
      status: PROGRESS_STATUS.WAITING,
      primed: false,
      prevState: null,
      awaitingRejoin: false,
      // Ordered-gate state (sprint).
      gateIndex: lapMode ? 0 : 1,
      checkpointsPassed: 0,
      passedGates: lapMode ? [] : [{
        id: 'start', index: 0, tick: 0, timeSeconds: 0, position: null, arc: 0
      }],
      // Lap state.
      lapIndex: 0,
      lapTimes: [],
      lapStartTick: 0,
      lapStartSeconds: 0,
      lapDistance: 0,
      lastArc: lapMode ? 0 : null,
      lapCrossings: [],
      // Progress and status.
      arc: 0,
      maxArc: 0,
      lateral: 0,
      maxLateral: 0,
      groundY: this.course.groundAtArc(0),
      progress: 0,
      progressMetres: 0,
      finishTick: null,
      finishTimeSeconds: null,
      dnfReason: null,
      // Counters.
      respawns: 0,
      respawnLog: [],
      offCourse: false,
      offCourseDetail: null,
      wrongWay: false,
      wrongWayTicks: 0,
      airborneTicks: 0,
      contactKnown: false,
      lastEvent: null
    };
  }

  get(id) {
    const participant = this.byId.get(id);
    if (!participant) throw new Error('unknown participant ' + id);
    return participant;
  }

  isTerminal(participant) {
    return participant.status === PROGRESS_STATUS.FINISHED ||
      participant.status === PROGRESS_STATUS.DNF ||
      participant.status === PROGRESS_STATUS.DISCONNECTED ||
      participant.status === PROGRESS_STATUS.LEFT;
  }

  /** Observe the settled start state without counting a gate crossing. */
  prime(id, state, tick = 0) {
    const participant = this.get(id);
    if (this.isTerminal(participant)) return participant;
    const normalized = cloneState(state);
    participant.primed = true;
    participant.status = PROGRESS_STATUS.RUNNING;
    participant.prevState = normalized;
    this.observe(participant, normalized, tick);
    if (this.course.mode === 'lap') {
      participant.lastArc = 0;
      participant.lapDistance = 0;
      participant.lapStartTick = 0;
      participant.lapStartSeconds = 0;
      participant.progress = 0;
      participant.progressMetres = 0;
    } else {
      participant.gateIndex = 1;
      participant.passedGates = [{
        id: 'start', index: 0, tick: 0, timeSeconds: 0,
        position: normalized.position.slice(), arc: participant.arc
      }];
      participant.progress = clamp01((participant.maxArc) / this.course.finishArc);
      participant.progressMetres = round6(participant.maxArc);
    }
    return participant;
  }

  /** Continue after an engine rebuild. Progress is kept; motion history is reset. */
  rejoin(id, state, tick = 0) {
    const participant = this.get(id);
    if (this.isTerminal(participant)) return participant;
    const normalized = cloneState(state);
    participant.primed = true;
    participant.status = PROGRESS_STATUS.RUNNING;
    participant.prevState = normalized;
    participant.awaitingRejoin = false;
    participant.airborneTicks = 0;
    participant.offCourse = false;
    participant.offCourseDetail = null;
    this.observe(participant, normalized, tick);
    if (this.course.mode === 'lap') {
      participant.lastArc = 0;
      participant.lapDistance = participant.lapIndex * this.course.lengthMetres;
      participant.progress = clamp01(participant.lapDistance /
        (this.course.laps * this.course.lengthMetres));
      participant.progressMetres = round6(participant.lapDistance);
    }
    return participant;
  }

  observe(participant, state, tick) {
    if (state.finite === 0) participant.airborneTicks = 0;
    const contact = state.contact;
    if (contact === false) {
      participant.airborneTicks++;
      participant.contactKnown = true;
    } else if (contact === true) {
      participant.airborneTicks = 0;
      participant.contactKnown = true;
    } else {
      // The state did not report contact: do not claim an airborne count.
      participant.airborneTicks = 0;
      participant.contactKnown = false;
    }

    const projection = this.course.project(state.position);
    participant.arc = projection.arc;
    participant.lateral = projection.lateral;
    participant.groundY = projection.groundY;
    if (projection.lateral > participant.maxLateral) participant.maxLateral = projection.lateral;
    if (this.course.mode === 'sprint' && projection.arc > participant.maxArc) {
      participant.maxArc = projection.arc;
    }
    participant.lastTick = tick;
    return projection;
  }

  /**
   * Advance one participant by one observed state. `tick` is the authoritative
   * race tick (0 at GO); it is the only clock this module uses.
   */
  step(id, state, tick) {
    const participant = this.get(id);
    if (this.isTerminal(participant)) return [];
    if (!Number.isInteger(tick) || tick < 0) throw new Error('step tick must be a non-negative integer');
    if (!participant.primed) {
      this.prime(id, state, tick);
      return [];
    }
    const normalized = cloneState(state);
    const previous = participant.prevState;
    const projection = this.observe(participant, normalized, tick);
    const events = [];
    const seconds = round6(tick / this.config.tickHz);
    participant.status = PROGRESS_STATUS.RUNNING;

    if (!participant.awaitingRejoin && previous) {
      if (this.course.mode === 'lap') {
        this.stepLap(participant, previous, normalized, tick, seconds, events);
      } else {
        this.stepSprint(participant, previous, normalized, tick, seconds, events);
      }
      if (!this.isTerminal(participant)) {
        this.stepWrongWay(participant, previous, normalized, tick, events);
        this.stepRespawn(participant, normalized, projection, tick, seconds, events);
      }
    }

    participant.prevState = normalized;
    if (events.length) participant.lastEvent = events[events.length - 1];
    return events;
  }

  stepSprint(participant, previous, state, tick, seconds, events) {
    const gates = this.course.gates;
    for (let index = participant.gateIndex; index < gates.length; index++) {
      const gate = gates[index];
      const crossing = this.course.crossing(previous.position, state.position, gate);
      if (!crossing) continue;
      if (gate.index !== participant.gateIndex) {
        if (gate.kind === 'finish') {
          events.push({
            type: PROGRESS_EVENT.FINISH_BLOCKED,
            participantId: participant.id,
            tick,
            timeSeconds: seconds,
            gateId: gate.id,
            gateIndex: gate.index,
            expectedIndex: participant.gateIndex,
            reasons: ['checkpoints-missing'],
            position: crossing.point
          });
        } else {
          events.push({
            type: PROGRESS_EVENT.GATE_OUT_OF_ORDER,
            participantId: participant.id,
            tick,
            timeSeconds: seconds,
            gateId: gate.id,
            gateIndex: gate.index,
            expectedIndex: participant.gateIndex,
            position: crossing.point
          });
        }
        continue;
      }
      if (gate.kind === 'checkpoint') {
        participant.gateIndex++;
        participant.checkpointsPassed++;
        const record = {
          id: gate.id,
          index: gate.index,
          tick,
          timeSeconds: seconds,
          position: crossing.point,
          arc: gate.arc
        };
        participant.passedGates.push(record);
        events.push({ type: PROGRESS_EVENT.CHECKPOINT, participantId: participant.id, ...record });
      } else if (gate.kind === 'finish') {
        if (participant.checkpointsPassed !== this.course.checkpointCount) {
          events.push({
            type: PROGRESS_EVENT.FINISH_BLOCKED,
            participantId: participant.id,
            tick,
            timeSeconds: seconds,
            gateId: gate.id,
            gateIndex: gate.index,
            expectedIndex: participant.gateIndex,
            reasons: ['checkpoints-missing'],
            position: crossing.point
          });
          continue;
        }
        participant.gateIndex++;
        participant.passedGates.push({
          id: gate.id,
          index: gate.index,
          tick,
          timeSeconds: seconds,
          position: crossing.point,
          arc: gate.arc
        });
        participant.status = PROGRESS_STATUS.FINISHED;
        participant.finishTick = tick;
        participant.finishTimeSeconds = seconds;
        participant.progress = 1;
        participant.progressMetres = round6(this.course.finishArc);
        events.push({
          type: PROGRESS_EVENT.FINISH,
          participantId: participant.id,
          tick,
          timeSeconds: seconds,
          gateId: gate.id,
          checkpoints: participant.checkpointsPassed,
          totalCheckpoints: this.course.checkpointCount,
          position: crossing.point
        });
      }
    }
    participant.progress = participant.status === PROGRESS_STATUS.FINISHED
      ? 1
      : clamp01(participant.maxArc / this.course.finishArc);
    participant.progressMetres = round6(Math.min(participant.maxArc, this.course.finishArc));
  }

  stepLap(participant, previous, state, tick, seconds, events) {
    const length = this.course.lengthMetres;
    let delta = participant.arc - participant.lastArc;
    if (delta < -length / 2) delta += length;
    else if (delta > length / 2) delta -= length;
    if (delta > 0 && delta < length / 4) participant.lapDistance += delta;
    participant.lastArc = participant.arc;
    if (participant.status !== PROGRESS_STATUS.FINISHED) {
      participant.progress = clamp01(participant.lapDistance /
        (this.course.laps * length));
      participant.progressMetres = round6(participant.lapDistance);
    }

    const crossing = this.course.crossing(previous.position, state.position, this.course.lapLine);
    if (!crossing) return;
    const required = (participant.lapIndex + 1) * length -
      this.config.lapCrossingToleranceMetres;
    if (participant.lapDistance < required) {
      if (participant.lapDistance >= this.course.minLapMetres) {
        events.push({
          type: PROGRESS_EVENT.LAP_REJECTED,
          participantId: participant.id,
          tick,
          timeSeconds: seconds,
          reason: 'short-lap',
          lapDistanceMetres: round6(participant.lapDistance),
          requiredMetres: round6(required),
          position: crossing.point
        });
      }
      return;
    }
    const lapNumber = participant.lapIndex + 1;
    const lapSeconds = round6(seconds - participant.lapStartSeconds);
    participant.lapTimes.push(lapSeconds);
    participant.lapCrossings.push({
      lap: lapNumber,
      tick,
      timeSeconds: seconds,
      lapSeconds,
      position: crossing.point
    });
    participant.lapStartTick = tick;
    participant.lapStartSeconds = seconds;
    participant.lapIndex++;
    const common = {
      participantId: participant.id,
      lap: lapNumber,
      laps: this.course.laps,
      lapSeconds,
      lapTimes: participant.lapTimes.slice(),
      bestLapSeconds: Math.min(...participant.lapTimes),
      tick,
      timeSeconds: seconds,
      position: crossing.point
    };
    if (participant.lapIndex >= this.course.laps) {
      participant.status = PROGRESS_STATUS.FINISHED;
      participant.finishTick = tick;
      participant.finishTimeSeconds = seconds;
      participant.progress = 1;
      participant.progressMetres = round6(this.course.laps * length);
      events.push({ type: PROGRESS_EVENT.FINISH, ...common });
    } else {
      events.push({ type: PROGRESS_EVENT.LAP, ...common });
    }
  }

  stepWrongWay(participant, previous, state, tick, events) {
    const tangent = this.course.tangentAtArc(participant.arc);
    let fx = 0;
    let fz = 0;
    if (state.forward) {
      fx = state.forward[0];
      fz = state.forward[2];
    } else if (state.velocity) {
      fx = state.velocity[0];
      fz = state.velocity[2];
    } else {
      fx = state.position[0] - previous.position[0];
      fz = state.position[2] - previous.position[2];
    }
    const magnitude = Math.hypot(fx, fz);
    if (!(magnitude > 1e-9)) {
      participant.wrongWayTicks = 0;
      return;
    }
    const dot = (fx / magnitude) * tangent.tx + (fz / magnitude) * tangent.tz;
    if (dot < this.config.wrongWayDotThreshold) participant.wrongWayTicks++;
    else participant.wrongWayTicks = 0;
    if (participant.wrongWayTicks >= this.config.wrongWayTicks && !participant.wrongWay) {
      participant.wrongWay = true;
      events.push({
        type: PROGRESS_EVENT.WRONG_WAY,
        participantId: participant.id,
        tick,
        dot: round6(dot),
        ticks: participant.wrongWayTicks,
        thresholdTicks: this.config.wrongWayTicks
      });
    } else if (participant.wrongWayTicks === 0 && participant.wrongWay) {
      participant.wrongWay = false;
      events.push({
        type: PROGRESS_EVENT.WRONG_WAY_CLEARED,
        participantId: participant.id,
        tick,
        dot: round6(dot)
      });
    }
  }

  stepRespawn(participant, state, projection, tick, seconds, events) {
    const verdict = this.policy.evaluate({
      position: state.position,
      projection,
      groundY: projection.groundY,
      airborneTicks: participant.airborneTicks
    });
    const offCourse = verdict.reasons.find((entry) => entry.reason === RESPAWN_REASON.OFF_COURSE);
    if (offCourse) {
      const entering = !participant.offCourse;
      participant.offCourse = true;
      participant.offCourseDetail = offCourse.detail;
      if (entering) {
        events.push({
          type: PROGRESS_EVENT.OFF_COURSE,
          participantId: participant.id,
          tick,
          timeSeconds: seconds,
          detail: offCourse.detail,
          arc: offCourse.arc,
          lateralMetres: offCourse.lateralMetres,
          limitMetres: offCourse.limitMetres
        });
      }
    } else if (participant.offCourse) {
      participant.offCourse = false;
      participant.offCourseDetail = null;
      events.push({
        type: PROGRESS_EVENT.OFF_COURSE_CLEARED,
        participantId: participant.id,
        tick,
        timeSeconds: seconds
      });
    }
    if (!verdict.respawn) return;
    participant.respawns++;
    participant.awaitingRejoin = true;
    participant.airborneTicks = 0;
    if (this.course.mode === 'lap') {
      participant.lapDistance = participant.lapIndex * this.course.lengthMetres;
    }
    const target = this.policy.targetFor({ lastGateIndex: Math.max(0, participant.gateIndex - 1) });
    const record = {
      type: PROGRESS_EVENT.RESPAWN,
      participantId: participant.id,
      tick,
      timeSeconds: seconds,
      reasons: verdict.reasons,
      reasonNames: verdict.reasonNames,
      position: state.position.slice(),
      target
    };
    participant.respawnLog.push(record);
    events.push(record);
  }

  /** Director-side terminal state (timeout, disconnect, admin DNF). */
  markTerminal(id, status, reason = null, tick = null) {
    const participant = this.get(id);
    if (participant.status === PROGRESS_STATUS.FINISHED) return participant;
    if (!['dnf', 'disconnected', 'left'].includes(status)) {
      throw new Error('markTerminal status must be dnf, disconnected or left');
    }
    participant.status = status;
    participant.dnfReason = reason;
    participant.finishTick = null;
    participant.finishTimeSeconds = null;
    participant.awaitingRejoin = false;
    if (this.course.mode === 'lap' && Number.isInteger(tick)) {
      participant.lastTick = tick;
    }
    return participant;
  }

  /** Compact ordered snapshot for results, HUD and the deterministic hash. */
  snapshot() {
    const rows = this.order.map((id) => {
      const participant = this.get(id);
      const nextGate = this.course.mode === 'lap'
        ? { id: 'lap-line', kind: 'finish', index: 1, arc: this.course.lengthMetres }
        : (this.course.gate(participant.gateIndex)
          ? {
            id: this.course.gate(participant.gateIndex).id,
            kind: this.course.gate(participant.gateIndex).kind,
            index: this.course.gate(participant.gateIndex).index,
            arc: this.course.gate(participant.gateIndex).arc
          }
          : null);
      return {
        id: participant.id,
        slot: participant.slot,
        status: participant.status,
        gateIndex: participant.gateIndex,
        nextGate,
        checkpointsPassed: participant.checkpointsPassed,
        totalCheckpoints: this.course.mode === 'lap'
          ? this.course.laps : this.course.checkpointCount,
        lapIndex: participant.lapIndex,
        lapsCompleted: participant.status === PROGRESS_STATUS.FINISHED
          ? this.course.laps : participant.lapIndex,
        laps: this.course.laps,
        lapTimes: participant.lapTimes.slice(),
        bestLapSeconds: participant.lapTimes.length
          ? Math.min(...participant.lapTimes) : null,
        lastLapSeconds: participant.lapTimes.length
          ? participant.lapTimes[participant.lapTimes.length - 1] : null,
        finishTick: participant.finishTick,
        finishTimeSeconds: participant.finishTimeSeconds,
        dnfReason: participant.dnfReason,
        progress: round6(participant.progress),
        progressMetres: round6(participant.progressMetres),
        arc: round6(participant.arc),
        maxArc: round6(participant.maxArc),
        lateralMetres: round6(participant.lateral),
        maxLateralMetres: round6(participant.maxLateral),
        groundY: round6(participant.groundY),
        passedGates: participant.passedGates.map((gate) => ({ ...gate })),
        lapCrossings: participant.lapCrossings.map((entry) => ({ ...entry })),
        respawns: participant.respawns,
        respawnLog: participant.respawnLog.map((entry) => ({ ...entry })),
        offCourse: participant.offCourse,
        offCourseDetail: participant.offCourseDetail,
        wrongWay: participant.wrongWay,
        wrongWayTicks: participant.wrongWayTicks,
        airborneTicks: participant.airborneTicks,
        contactKnown: participant.contactKnown,
        lastEvent: participant.lastEvent ? { ...participant.lastEvent } : null
      };
    });
    return {
      schema: 'blur.race-rules.progress/1',
      courseId: this.course.courseId,
      mode: this.course.mode,
      tickHz: this.config.tickHz,
      wrongWay: {
        dotThreshold: this.config.wrongWayDotThreshold,
        ticks: this.config.wrongWayTicks,
        source: this.config.source
      },
      respawnPolicy: this.policy.toJSON(),
      participants: rows
    };
  }
}
