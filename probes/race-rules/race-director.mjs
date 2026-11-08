// RaceDirector — deterministic phase machine for a 2–4 participant race.
//
// Phases: lobby -> loading -> countdown -> running -> finished -> results.
// The clock is a tick counter advanced by the caller; there is no wall clock,
// no random source and no engine call. Host authority is explicit: privileged
// commands (start/finish/dnf/restart) are accepted from the host only when
// `hostAuthority` is enabled. Clients consume the host snapshot and must not
// run an independent finish judge.

export const RACE_PHASE = Object.freeze({
  LOBBY: 'lobby',
  LOADING: 'loading',
  COUNTDOWN: 'countdown',
  RUNNING: 'running',
  FINISHED: 'finished',
  RESULTS: 'results'
});

export const RACE_EVENT = Object.freeze({
  JOIN: 'join',
  READY: 'ready',
  START: 'start',
  COUNTDOWN: 'countdown',
  GO: 'go',
  FINISH: 'finish',
  DNF: 'dnf',
  DISCONNECT: 'disconnect',
  RACE_FINISHED: 'race-finished',
  RESULTS: 'results',
  RESTART: 'restart',
  RACE_ABORTED: 'race-aborted',
  COMMAND_REJECTED: 'command-rejected'
});

export const DIRECTOR_STATUS = Object.freeze({
  LOBBY: 'lobby',
  LOADING: 'loading',
  COUNTDOWN: 'countdown',
  RUNNING: 'running',
  FINISHED: 'finished',
  DNF: 'dnf',
  DISCONNECTED: 'disconnected',
  LEFT: 'left'
});

/** Values not recovered from retail data are labelled `source: provisional`. */
export const DIRECTOR_DEFAULTS = Object.freeze({
  hostAuthority: true,
  requireAllReady: true,
  minParticipants: 2,
  maxParticipants: 4,
  countdownTicks: 90,
  loadingTicks: 0,
  resultsDelayTicks: 120,
  raceTimeoutTicks: 18000,
  tickHz: 60,
  allowLateJoin: false,
  source: 'provisional'
});

const round6 = (value) => Math.round(value * 1e6) / 1e6;

const TERMINAL_STATUSES = new Set([
  DIRECTOR_STATUS.FINISHED,
  DIRECTOR_STATUS.DNF,
  DIRECTOR_STATUS.DISCONNECTED,
  DIRECTOR_STATUS.LEFT
]);

function normalizeParticipants(participants) {
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new Error('RaceDirector needs participants');
  }
  const rows = participants.map((entry, index) => {
    const value = typeof entry === 'string' ? { id: entry } : entry;
    if (!value || typeof value.id !== 'string' || value.id.length === 0) {
      throw new Error('participant at index ' + index + ' has no id');
    }
    const slot = value.slot ?? index + 1;
    if (!Number.isInteger(slot) || slot < 1) throw new Error('participant slot must be a positive integer');
    return { id: value.id, slot, ready: value.ready === true };
  });
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error('duplicate participant id');
  }
  if (new Set(rows.map((row) => row.slot)).size !== rows.length) {
    throw new Error('duplicate participant slot');
  }
  return rows.sort((a, b) => a.slot - b.slot ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export class RaceDirector {
  /**
   * @param {object} options
   * @param {Array<{id:string, slot?:number, ready?:boolean}|string>} options.participants
   * @param {object} [options.config]
   */
  constructor({ participants, config = {} } = {}) {
    this.participantsInput = normalizeParticipants(participants);
    this.config = Object.freeze({ ...DIRECTOR_DEFAULTS, ...config });
    if (!Number.isInteger(this.config.countdownTicks) || this.config.countdownTicks < 0) {
      throw new Error('RaceDirector countdownTicks must be a non-negative integer');
    }
    if (!Number.isInteger(this.config.loadingTicks) || this.config.loadingTicks < 0) {
      throw new Error('RaceDirector loadingTicks must be a non-negative integer');
    }
    if (!(this.config.tickHz > 0)) throw new Error('RaceDirector tickHz must be positive');
    if (this.config.minParticipants < 1 || this.config.maxParticipants < this.config.minParticipants) {
      throw new Error('RaceDirector participant bounds are invalid');
    }
    this.hostId = this.config.hostId ?? this.participantsInput[0].id;
    if (!this.participantsInput.some((entry) => entry.id === this.hostId)) {
      throw new Error('RaceDirector hostId is not a participant');
    }
    this.eventSeq = 0;
    this.resetRaceState();
    this.phase = RACE_PHASE.LOBBY;
  }

  resetRaceState() {
    this.tick = 0;
    this.raceTick = 0;
    this.started = false;
    this.loadingTicksLeft = 0;
    this.countdownTicksLeft = 0;
    this.resultsTicksLeft = 0;
    this.participants = this.participantsInput.map((entry) => ({
      id: entry.id,
      slot: entry.slot,
      ready: false,
      status: DIRECTOR_STATUS.LOBBY,
      finishTick: null,
      finishTimeSeconds: null,
      dnf: false,
      dnfReason: null,
      disconnected: false
    }));
    this.byId = new Map(this.participants.map((entry) => [entry.id, entry]));
  }

  get(id) {
    const participant = this.byId.get(id);
    if (!participant) throw new Error('RaceDirector: unknown participant ' + id);
    return participant;
  }

  isHost(id) {
    return id === this.hostId;
  }

  emit(type, payload = {}) {
    return {
      seq: this.eventSeq++,
      type,
      tick: this.tick,
      raceTick: this.raceTick,
      phase: this.phase,
      ...payload
    };
  }

  reject(message, reason) {
    return {
      accepted: false,
      reason,
      events: [this.emit(RACE_EVENT.COMMAND_REJECTED, {
        command: message?.type ?? null,
        from: message?.from ?? null,
        reason
      })]
    };
  }

  /** Apply a room/command message. Returns {accepted, events, reason?}. */
  command(message) {
    if (!message || typeof message.type !== 'string') {
      return this.reject(message, 'invalid-command');
    }
    switch (message.type) {
      case 'ready':
        return this.setReady(message.from, message.ready !== false);
      case 'start':
        return this.start(message.from);
      case 'disconnect':
        return this.disconnect(message.from ?? message.id, message.reason ?? 'disconnected');
      case 'dnf':
        if (this.config.hostAuthority && !this.isHost(message.from)) {
          return this.reject({ type: 'dnf', from: message.from }, 'not-host');
        }
        return this.dnf(message.id ?? message.from, message.reason ?? 'dnf', message.tick);
      case 'finish':
        return this.finishCommand(message);
      case 'restart':
        return this.restart(message.from);
      case 'join':
        return this.join(message.participant ?? message, message.from);
      default:
        return this.reject(message, 'unknown-command');
    }
  }

  setReady(id, ready) {
    const message = { type: 'ready', from: id };
    if (!this.byId.has(id)) return this.reject(message, 'unknown-participant');
    if (this.phase !== RACE_PHASE.LOBBY) return this.reject(message, 'phase-not-lobby');
    const participant = this.get(id);
    participant.ready = Boolean(ready);
    return {
      accepted: true,
      events: [this.emit(RACE_EVENT.READY, { participantId: id, ready: participant.ready })]
    };
  }

  start(from) {
    const message = { type: 'start', from };
    if (this.config.hostAuthority && !this.isHost(from)) return this.reject(message, 'not-host');
    if (this.phase !== RACE_PHASE.LOBBY) return this.reject(message, 'phase-not-lobby');
    const active = this.participants.filter((entry) => entry.status !== DIRECTOR_STATUS.LEFT);
    if (active.length < this.config.minParticipants) return this.reject(message, 'too-few-participants');
    if (active.length > this.config.maxParticipants) return this.reject(message, 'too-many-participants');
    if (this.config.requireAllReady && !active.every((entry) => entry.ready)) {
      return this.reject(message, 'not-all-ready');
    }
    this.phase = RACE_PHASE.LOADING;
    this.started = true;
    this.raceTick = 0;
    this.loadingTicksLeft = this.config.loadingTicks;
    this.countdownTicksLeft = 0;
    this.resultsTicksLeft = 0;
    for (const participant of active) participant.status = DIRECTOR_STATUS.LOADING;
    return {
      accepted: true,
      events: [this.emit(RACE_EVENT.START, {
        participants: active.map((entry) => entry.id),
        countdownTicks: this.config.countdownTicks,
        loadingTicks: this.config.loadingTicks
      })]
    };
  }

  advance(steps = 1) {
    if (!Number.isInteger(steps) || steps < 0) throw new Error('advance steps must be a non-negative integer');
    const events = [];
    for (let index = 0; index < steps; index++) events.push(...this.advanceOne());
    return events;
  }

  advanceOne() {
    this.tick++;
    const events = [];
    if (this.phase === RACE_PHASE.LOADING) {
      if (this.loadingTicksLeft > 0) this.loadingTicksLeft--;
      if (this.loadingTicksLeft <= 0) {
        this.phase = RACE_PHASE.COUNTDOWN;
        this.countdownTicksLeft = this.config.countdownTicks;
        for (const participant of this.participants) {
          if (!this.isTerminal(participant)) participant.status = DIRECTOR_STATUS.COUNTDOWN;
        }
        events.push(this.emit(RACE_EVENT.COUNTDOWN, { ticks: this.countdownTicksLeft }));
        if (this.countdownTicksLeft <= 0) this.enterRunning(events);
      }
    } else if (this.phase === RACE_PHASE.COUNTDOWN) {
      this.countdownTicksLeft--;
      if (this.countdownTicksLeft <= 0) this.enterRunning(events);
    } else if (this.phase === RACE_PHASE.RUNNING) {
      this.raceTick++;
      if (this.config.raceTimeoutTicks > 0 && this.raceTick >= this.config.raceTimeoutTicks) {
        for (const participant of this.participants) {
          if (participant.status === DIRECTOR_STATUS.RUNNING) {
            participant.status = DIRECTOR_STATUS.DNF;
            participant.dnf = true;
            participant.dnfReason = 'timeout';
            events.push(this.emit(RACE_EVENT.DNF, {
              participantId: participant.id,
              reason: 'timeout',
              tick: this.raceTick
            }));
          }
        }
        this.settle(events, 'timeout');
      }
    } else if (this.phase === RACE_PHASE.FINISHED) {
      if (this.resultsTicksLeft > 0) this.resultsTicksLeft--;
      if (this.resultsTicksLeft <= 0) {
        this.phase = RACE_PHASE.RESULTS;
        events.push(this.emit(RACE_EVENT.RESULTS, { resultReady: true }));
      }
    }
    return events;
  }

  enterRunning(events) {
    this.phase = RACE_PHASE.RUNNING;
    this.raceTick = 0;
    this.countdownTicksLeft = 0;
    for (const participant of this.participants) {
      if (!this.isTerminal(participant)) participant.status = DIRECTOR_STATUS.RUNNING;
    }
    events.push(this.emit(RACE_EVENT.GO, { raceTick: 0 }));
  }

  isTerminal(participant) {
    return TERMINAL_STATUSES.has(participant.status);
  }

  allTerminal() {
    return this.participants.every((entry) => this.isTerminal(entry));
  }

  settle(events, reason) {
    if (this.phase !== RACE_PHASE.RUNNING) return;
    if (!this.allTerminal()) return;
    this.phase = RACE_PHASE.FINISHED;
    this.resultsTicksLeft = this.config.resultsDelayTicks;
    events.push(this.emit(RACE_EVENT.RACE_FINISHED, {
      reason,
      resultsInTicks: this.resultsTicksLeft
    }));
  }

  finishCommand(message) {
    if (this.config.hostAuthority && !this.isHost(message.from)) {
      return this.reject({ type: 'finish', from: message.from }, 'not-host');
    }
    return this.finishParticipant(message.id ?? message.from, message.tick);
  }

  finishParticipant(id, tick = null) {
    if (!this.byId.has(id)) {
      return { accepted: false, reason: 'unknown-participant', events: [
        this.emit(RACE_EVENT.COMMAND_REJECTED, { command: 'finish', from: id, reason: 'unknown-participant' })
      ] };
    }
    if (this.phase !== RACE_PHASE.RUNNING) {
      return { accepted: false, reason: 'phase-not-running', events: [
        this.emit(RACE_EVENT.COMMAND_REJECTED, { command: 'finish', from: id, reason: 'phase-not-running' })
      ] };
    }
    const participant = this.get(id);
    if (participant.status !== DIRECTOR_STATUS.RUNNING) {
      return { accepted: false, reason: 'not-running', events: [
        this.emit(RACE_EVENT.COMMAND_REJECTED, { command: 'finish', from: id, reason: 'not-running' })
      ] };
    }
    const finishTick = Number.isInteger(tick) ? tick : this.raceTick;
    participant.status = DIRECTOR_STATUS.FINISHED;
    participant.finishTick = finishTick;
    participant.finishTimeSeconds = round6(finishTick / this.config.tickHz);
    const events = [this.emit(RACE_EVENT.FINISH, {
      participantId: id,
      tick: finishTick,
      timeSeconds: participant.finishTimeSeconds
    })];
    this.settle(events, 'all-finished');
    return { accepted: true, events };
  }

  disconnect(id, reason = 'disconnected') {
    if (!this.byId.has(id)) {
      return this.reject({ type: 'disconnect', from: id }, 'unknown-participant');
    }
    const participant = this.get(id);
    participant.ready = false;
    if (this.phase === RACE_PHASE.LOBBY) {
      participant.status = DIRECTOR_STATUS.LEFT;
      participant.disconnected = true;
      return {
        accepted: true,
        events: [this.emit(RACE_EVENT.DISCONNECT, { participantId: id, reason, dnf: false })]
      };
    }
    participant.disconnected = true;
    if (participant.status === DIRECTOR_STATUS.FINISHED || participant.status === DIRECTOR_STATUS.DNF) {
      // A post-finish disconnect must not erase a valid result.
      return {
        accepted: true,
        events: [this.emit(RACE_EVENT.DISCONNECT, {
          participantId: id,
          reason,
          dnf: participant.status === DIRECTOR_STATUS.DNF,
          retainedResult: participant.status === DIRECTOR_STATUS.FINISHED
        })]
      };
    }
    participant.dnf = true;
    participant.dnfReason = reason;
    participant.finishTick = null;
    participant.finishTimeSeconds = null;
    participant.status = DIRECTOR_STATUS.DISCONNECTED;
    const events = [this.emit(RACE_EVENT.DISCONNECT, {
      participantId: id,
      reason,
      dnf: this.phase === RACE_PHASE.RUNNING
    })];
    if (this.phase === RACE_PHASE.RUNNING) this.settle(events, 'disconnect');
    else if (this.phase === RACE_PHASE.LOADING || this.phase === RACE_PHASE.COUNTDOWN) {
      if (this.participants.every((entry) => entry.disconnected || entry.status === DIRECTOR_STATUS.LEFT)) {
        this.phase = RACE_PHASE.LOBBY;
        this.started = false;
        this.raceTick = 0;
        events.push(this.emit(RACE_EVENT.RACE_ABORTED, { reason: 'all-disconnected' }));
      }
    }
    return { accepted: true, events };
  }

  dnf(id, reason = 'dnf', tick = null) {
    if (!this.byId.has(id)) {
      return this.reject({ type: 'dnf', from: id }, 'unknown-participant');
    }
    if (this.phase !== RACE_PHASE.RUNNING) {
      return this.reject({ type: 'dnf', from: id }, 'phase-not-running');
    }
    const participant = this.get(id);
    if (participant.status !== DIRECTOR_STATUS.RUNNING) {
      return this.reject({ type: 'dnf', from: id }, 'not-running');
    }
    participant.status = DIRECTOR_STATUS.DNF;
    participant.dnf = true;
    participant.dnfReason = reason;
    participant.finishTick = Number.isInteger(tick) ? tick : null;
    participant.finishTimeSeconds = null;
    const events = [this.emit(RACE_EVENT.DNF, {
      participantId: id,
      reason,
      tick: this.raceTick
    })];
    this.settle(events, 'dnf');
    return { accepted: true, events };
  }

  join(participant) {
    const message = { type: 'join', from: participant?.id ?? null };
    if (this.phase !== RACE_PHASE.LOBBY) {
      // The room reconnects a returning client to the existing slot; adding a
      // new participant mid-race is deliberately not implemented in M1.
      return this.reject(message, 'join-closed');
    }
    if (!participant || typeof participant.id !== 'string') return this.reject(message, 'invalid-participant');
    if (this.byId.has(participant.id)) return this.reject(message, 'duplicate-participant');
    if (this.participants.length >= this.config.maxParticipants) return this.reject(message, 'room-full');
    const slot = participant.slot ?? this.participants.length + 1;
    if (this.participants.some((entry) => entry.slot === slot)) return this.reject(message, 'duplicate-slot');
    const entry = {
      id: participant.id,
      slot,
      ready: participant.ready === true,
      status: DIRECTOR_STATUS.LOBBY,
      finishTick: null,
      finishTimeSeconds: null,
      dnf: false,
      dnfReason: null,
      disconnected: false
    };
    this.participants.push(entry);
    this.participantsInput.push({ id: entry.id, slot: entry.slot, ready: false });
    this.participants.sort((a, b) => a.slot - b.slot ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.byId.set(entry.id, entry);
    return {
      accepted: true,
      events: [this.emit(RACE_EVENT.JOIN, { participantId: entry.id, slot })]
    };
  }

  restart(from) {
    const message = { type: 'restart', from };
    if (this.config.hostAuthority && !this.isHost(from)) return this.reject(message, 'not-host');
    if (this.phase !== RACE_PHASE.FINISHED && this.phase !== RACE_PHASE.RESULTS) {
      return this.reject(message, 'phase-not-finished');
    }
    this.resetRaceState();
    this.phase = RACE_PHASE.LOBBY;
    return {
      accepted: true,
      events: [this.emit(RACE_EVENT.RESTART, {
        participants: this.participants.map((entry) => entry.id)
      })]
    };
  }

  snapshot() {
    const participants = this.participants.map((entry) => ({
      id: entry.id,
      slot: entry.slot,
      ready: entry.ready,
      status: entry.status,
      finishTick: entry.finishTick,
      finishTimeSeconds: entry.finishTimeSeconds,
      dnf: entry.dnf,
      dnfReason: entry.dnfReason,
      disconnected: entry.disconnected
    }));
    const counts = {
      ready: participants.filter((entry) => entry.ready).length,
      running: participants.filter((entry) => entry.status === DIRECTOR_STATUS.RUNNING).length,
      finished: participants.filter((entry) => entry.status === DIRECTOR_STATUS.FINISHED).length,
      dnf: participants.filter((entry) => entry.status === DIRECTOR_STATUS.DNF).length,
      disconnected: participants.filter((entry) => entry.status === DIRECTOR_STATUS.DISCONNECTED).length,
      left: participants.filter((entry) => entry.status === DIRECTOR_STATUS.LEFT).length
    };
    return {
      schema: 'blur.race-rules.director/1',
      phase: this.phase,
      tick: this.tick,
      raceTick: this.raceTick,
      raceTimeSeconds: round6(this.raceTick / this.config.tickHz),
      started: this.started,
      hostId: this.hostId,
      authority: {
        hostId: this.hostId,
        hostAuthoritative: true,
        requireHostCommands: this.config.hostAuthority,
        clientsAcceptHostResult: true,
        note: 'host runs the rules and broadcasts phase/events; clients do not run an independent finish judge'
      },
      config: {
        hostAuthority: this.config.hostAuthority,
        requireAllReady: this.config.requireAllReady,
        minParticipants: this.config.minParticipants,
        maxParticipants: this.config.maxParticipants,
        countdownTicks: this.config.countdownTicks,
        loadingTicks: this.config.loadingTicks,
        resultsDelayTicks: this.config.resultsDelayTicks,
        raceTimeoutTicks: this.config.raceTimeoutTicks,
        tickHz: this.config.tickHz,
        source: this.config.source
      },
      participants,
      counts,
      loadingTicksLeft: this.loadingTicksLeft,
      countdownTicksLeft: this.countdownTicksLeft,
      resultsTicksLeft: this.resultsTicksLeft,
      allDone: this.allTerminal()
    };
  }
}
