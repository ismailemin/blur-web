// Live standings for the Blur Web race slice.
//
// This module turns host-authoritative car state into an ordered live table:
// position on track, gap to the leader and to the car ahead, lap deltas, ties,
// wrecks/respawns and DNF/disconnect. It is deterministic: the only clock is
// the integer race tick supplied by the caller, and every stored number,
// position and hash is rounded to 1e-6.
//
// Progress metric (defined per mode):
//   sprint: distance along the measured P48 path, clamped to the finish arc;
//   lap:    validated laps * measured loop length + distance along the loop,
//           with sector checkpoints that reject shortcut lap credit;
//   free:   no standings at all (FreeStandings).
//
// Progress never moves backwards on ordinary state except by a declared,
// validated respawn (retail reset to the last checkpoint / lap line) or a
// declared power-up displacement. A forward jump larger than the physics
// maximum for the elapsed ticks is rejected, never applied.
//
// Scope labels: rulesOnly true, engineIntegration false, renderer false,
// network false, retailParity false, antiCheat 'progress-jump-bounded'.

import { hashOf } from './hash.mjs';
import { CourseModel, COURSE_MODE, lineCrossing } from './course.mjs';

const round6 = (value) => Math.round(value * 1e6) / 1e6;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export const STANDINGS_SCHEMA = 'blur.standings/1';

export const STANDINGS_STATUS = Object.freeze({
  RUNNING: 'running',
  FINISHED: 'finished',
  WRECKED: 'wrecked',
  DNF: 'dnf',
  DISCONNECTED: 'disconnected'
});

export const STANDINGS_EVENT = Object.freeze({
  CHECKPOINT: 'checkpoint',
  LAP: 'lap',
  FINISH: 'finish',
  FINISH_BLOCKED: 'finish-blocked',
  FINISH_UNVALIDATED: 'finish-unvalidated',
  FINISH_TICK_MISMATCH: 'finish-tick-mismatch',
  LAP_REJECTED: 'lap-rejected',
  GATE_OUT_OF_ORDER: 'gate-out-of-order',
  PROGRESS_JUMP_REJECTED: 'progress-jump-rejected',
  BACKTRACK_CLAMPED: 'backtrack-clamped',
  OUT_OF_ORDER_SNAPSHOT: 'out-of-order-snapshot',
  OUT_OF_ORDER_STATE: 'out-of-order-state',
  FUTURE_STATE: 'future-state-rejected',
  STALE: 'stale',
  CONTAINMENT_RESET: 'containment-reset',
  RESPAWN: 'respawn',
  RESPAWN_TARGET_REJECTED: 'respawn-target-rejected',
  POWERUP_TELEPORT: 'powerup-teleport',
  TELEPORT_FORWARD_REJECTED: 'teleport-forward-rejected',
  WRECK: 'wreck',
  RECOVERED: 'recovered',
  DNF: 'dnf',
  DISCONNECTED: 'disconnected'
});

/**
 * Values that are project rules, not recovered retail constants. The speed cap
 * is the project nitro cap (55 m/s) plus a 9 % margin, so a legitimate nitro
 * tick is never rejected. The wreck delay used by the e1-drive power-up model is
 * 1.0 s (provisional); this module does not time the wreck itself, it only
 * freezes progress while the host reports `wrecked`.
 */
export const STANDINGS_DEFAULTS = Object.freeze({
  maxSpeedMps: 60,
  backtrackToleranceMetres: 2.0,
  lapToleranceMetres: 2.0,
  respawnToleranceMetres: 3.0,
  containmentMarginMetres: 25,
  fallBelowGroundMetres: 1.0,
  staleAfterTicks: 180,
  paceWindowTicks: 120,
  minPaceTicks: 15,
  defaultPaceMps: 15,
  sectorCount: 4,
  source: 'provisional-project-rule'
});

function normalizeParticipants(participants) {
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new Error('standings need participants');
  }
  const rows = participants.map((entry, index) => {
    const value = typeof entry === 'string' ? { id: entry } : entry;
    if (!value || typeof value.id !== 'string' || value.id.length === 0) {
      throw new Error('participant at index ' + index + ' has no id');
    }
    const slot = value.slot ?? index + 1;
    if (!Number.isInteger(slot) || slot < 1) {
      throw new Error('participant slot must be a positive integer');
    }
    return { id: value.id, slot, name: value.name ?? value.id };
  });
  const ids = new Set(rows.map((row) => row.id));
  if (ids.size !== rows.length) throw new Error('duplicate participant id');
  const slots = new Set(rows.map((row) => row.slot));
  if (slots.size !== rows.length) throw new Error('duplicate participant slot');
  return rows.sort((a, b) => a.slot - b.slot ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function normalizeStates(states) {
  const map = new Map();
  if (Array.isArray(states)) {
    for (const state of states) {
      if (!state || typeof state.id !== 'string') {
        throw new Error('state entries need an id');
      }
      if (map.has(state.id)) throw new Error('duplicate state for ' + state.id);
      map.set(state.id, state);
    }
  } else if (states && typeof states === 'object') {
    for (const [id, state] of Object.entries(states)) {
      if (!state || typeof state !== 'object') {
        throw new Error('state for ' + id + ' is not an object');
      }
      map.set(id, { ...state, id: state.id ?? id });
    }
  } else {
    throw new Error('update needs a state map or array');
  }
  return map;
}

function isFinitePosition(position) {
  return Array.isArray(position) && position.length >= 3 &&
    Number.isFinite(position[0]) && Number.isFinite(position[1]) && Number.isFinite(position[2]);
}

function planarDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}

function tieKeyFor(row) {
  if (row.status === STANDINGS_STATUS.FINISHED) return 'finished|' + String(row.finishTick);
  if (row.status === STANDINGS_STATUS.DNF) return 'dnf|' + String(round6(row.progressMetres));
  if (row.status === STANDINGS_STATUS.DISCONNECTED) return 'disconnected|' + String(round6(row.progressMetres));
  return 'active|' + String(round6(row.progressMetres));
}

function groupFor(status) {
  if (status === STANDINGS_STATUS.FINISHED) return 0;
  if (status === STANDINGS_STATUS.DNF) return 2;
  if (status === STANDINGS_STATUS.DISCONNECTED) return 3;
  return 1;
}

function bestLapCompare(a, b) {
  const left = a.bestLapSeconds;
  const right = b.bestLapSeconds;
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

/** Deterministic ordering: status group, then the documented tie-break. */
function compareRows(a, b) {
  const group = groupFor(a.status) - groupFor(b.status);
  if (group !== 0) return group;
  if (a.status === STANDINGS_STATUS.FINISHED) {
    if (a.finishTick !== b.finishTick) return a.finishTick - b.finishTick;
    const lap = bestLapCompare(a, b);
    if (lap !== 0) return lap;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  if (a.progressMetres !== b.progressMetres) return b.progressMetres - a.progressMetres;
  const lap = bestLapCompare(a, b);
  if (lap !== 0) return lap;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

class StandingRow {
  constructor(participant, course) {
    this.id = participant.id;
    this.slot = participant.slot;
    this.name = participant.name;
    this.status = STANDINGS_STATUS.RUNNING;
    this.lastTick = -1;
    this.lastUpdateTick = null;
    this.staleTicks = 0;
    this.missingUpdates = 0;
    this.stale = false;
    this.finished = false;
    this.finishTick = null;
    this.totalTimeSeconds = null;
    this.finishSource = null;
    this.finishValidated = null;
    this.lapsCompleted = 0;
    this.lapStartTick = 0;
    this.lapTimes = [];
    this.bestLapSeconds = null;
    this.lastLapSeconds = null;
    this.checkpointIndex = 0;
    this.sectorMask = 0;
    this.validatedTravel = 0;
    this.lapProgress = 0;
    this.progressMetres = 0;
    this.maxProgressMetres = 0;
    this.trackArc = 0;
    this.previousArc = 0;
    this.previousPosition = null;
    this.segment = null;
    this.pace = [];
    this.meanSpeedMps = 0;
    this.wrecked = false;
    this.wreckTick = null;
    this.offMap = false;
    this.offMapReason = null;
    this.respawnRejected = false;
    this.finishBlocked = false;
    this.dnfReason = null;
    this.course = course;
  }

  resetLapProgress() {
    this.validatedTravel = 0;
    this.lapProgress = 0;
    this.sectorMask = 0;
    this.checkpointIndex = 0;
    this.previousArc = 0;
    this.trackArc = 0;
  }

  pushPace(tick, progress, tickHz, windowTicks, minPaceTicks) {
    if (!(progress > 0)) return;
    const last = this.pace[this.pace.length - 1];
    if (last && (progress <= last.progress || tick <= last.tick)) return;
    this.pace.push({ tick, progress });
    while (this.pace.length > 2 && this.pace[0].tick < tick - windowTicks) this.pace.shift();
    if (this.pace.length < 2) { this.meanSpeedMps = 0; return; }
    const first = this.pace[0];
    const lastEntry = this.pace[this.pace.length - 1];
    const ticks = lastEntry.tick - first.tick;
    if (ticks < minPaceTicks) { this.meanSpeedMps = 0; return; }
    this.meanSpeedMps = round6((lastEntry.progress - first.progress) / (ticks / tickHz));
  }
}

export class Standings {
  /**
   * @param {object} layout parsed committed e1-drive layout
   * @param {Array<string|{id:string,slot?:number,name?:string}>} participants
   * @param {object} config
   */
  constructor(layout, participants, config = {}) {
    this.options = { ...STANDINGS_DEFAULTS, ...config };
    this.course = layout instanceof CourseModel ? layout : new CourseModel(layout, {
      verifyLayoutHash: config.verifyLayoutHash,
      sectorCount: this.options.sectorCount
    });
    if (!this.course.standings) {
      throw new Error('standings: course ' + this.course.courseId + ' has no progress metric');
    }
    if (this.course.mode === COURSE_MODE.FREE) {
      throw new Error('standings: use FreeStandings for free-roam');
    }
    if (!(this.options.maxSpeedMps > 0)) throw new Error('standings: maxSpeedMps must be positive');
    if (!(this.options.respawnToleranceMetres >= 0)) {
      throw new Error('standings: respawnToleranceMetres must be >= 0');
    }
    if (!Number.isInteger(this.options.staleAfterTicks) || this.options.staleAfterTicks < 1) {
      throw new Error('standings: staleAfterTicks must be a positive integer');
    }
    this.participants = normalizeParticipants(participants);
    this.rows = new Map(this.participants.map((participant) => [
      participant.id,
      new StandingRow(participant, this.course)
    ]));
    this.tick = -1;
    this.sequence = 0;
    this.events = [];
    this.replayHashes = [];
    this.snapshotCache = null;
    this.trackReplay = config.trackReplay !== false;
    this.requiredCheckpoints = this.course.mode === COURSE_MODE.LAP
      ? this.course.sectorCount - 1
      : this.course.checkpointCount;
  }

  get mode() {
    return this.course.mode;
  }

  get tickHz() {
    return this.course.tickHz;
  }

  /** Maximum progress change accepted for a state that is `elapsed` ticks old. */
  maxStepMetres(elapsedTicks) {
    return this.options.maxSpeedMps / this.course.tickHz * Math.max(1, elapsedTicks);
  }

  emit(type, tick, id, detail = {}) {
    this.events.push({ type, tick, id, ...detail });
  }

  /** Cumulative expected respawn target for a row (retail checkpoint rule). */
  respawnTargetFor(row) {
    return this.course.respawnTarget({
      mode: this.course.mode,
      checkpointIndex: row.checkpointIndex,
      gateIndex: row.checkpointIndex + 1
    });
  }

  /**
   * Advance the table with the authoritative state of one race tick.
   * @param {number} tick race tick (0 at GO)
   * @param {object|Array} states state map keyed by participant id or an array
   * @returns {Array} events produced by this tick
   */
  update(tick, states) {
    if (!Number.isInteger(tick) || tick < 0) throw new Error('standings: tick must be a non-negative integer');
    const startEvents = this.events.length;
    if (tick <= this.tick) {
      this.emit(STANDINGS_EVENT.OUT_OF_ORDER_SNAPSHOT, tick, null, {
        previousTick: this.tick, rejectedTick: tick
      });
      return this.events.slice(startEvents);
    }
    const map = normalizeStates(states);
    this.tick = tick;
    this.sequence++;

    for (const participant of this.participants) {
      const row = this.rows.get(participant.id);
      const state = map.get(participant.id);
      if (!state) {
        row.missingUpdates++;
        row.staleTicks++;
        if (!row.stale && row.staleTicks >= this.options.staleAfterTicks) {
          row.stale = true;
          this.emit(STANDINGS_EVENT.STALE, tick, row.id, {
            staleTicks: row.staleTicks,
            lastTick: row.lastTick
          });
        }
        continue;
      }
      row.missingUpdates = 0;
      row.staleTicks = 0;
      row.stale = false;
      this.observe(row, state, tick);
    }

    if (this.trackReplay) {
      this.replayHashes.push(this.snapshot().hash);
    }
    return this.events.slice(startEvents);
  }

  observe(row, state, updateTick) {
    const stateTick = Number.isInteger(state.tick) ? state.tick : updateTick;
    if (stateTick <= row.lastTick) {
      this.emit(STANDINGS_EVENT.OUT_OF_ORDER_STATE, updateTick, row.id, {
        stateTick, lastTick: row.lastTick
      });
      return;
    }
    if (stateTick > updateTick) {
      this.emit(STANDINGS_EVENT.FUTURE_STATE, updateTick, row.id, { stateTick });
      return;
    }
    const elapsed = Math.max(1, stateTick - row.lastTick);

    const wantsFinish = (state.finished === true || state.status === STANDINGS_STATUS.FINISHED) &&
      !row.finished;
    if (row.finished) {
      row.lastTick = stateTick;
      row.lastUpdateTick = updateTick;
      return;
    }
    if (!wantsFinish && state.status === STANDINGS_STATUS.DNF) {
      const first = row.status !== STANDINGS_STATUS.DNF;
      row.status = STANDINGS_STATUS.DNF;
      row.dnfReason = state.dnfReason ?? 'host-declared';
      row.lastTick = stateTick;
      row.lastUpdateTick = updateTick;
      if (first) this.emit(STANDINGS_EVENT.DNF, stateTick, row.id, { reason: row.dnfReason });
      return;
    }
    if (!wantsFinish && state.status === STANDINGS_STATUS.DISCONNECTED) {
      const first = row.status !== STANDINGS_STATUS.DISCONNECTED;
      row.status = STANDINGS_STATUS.DISCONNECTED;
      row.dnfReason = state.dnfReason ?? 'disconnected';
      row.lastTick = stateTick;
      row.lastUpdateTick = updateTick;
      if (first) this.emit(STANDINGS_EVENT.DISCONNECTED, stateTick, row.id, { reason: row.dnfReason });
      return;
    }
    if (!isFinitePosition(state.position)) {
      if (wantsFinish) {
        this.acceptAuthoritativeFinish(row, state, stateTick);
      } else {
        this.markContainment(row, stateTick, 'non-finite-position', state.position);
      }
      row.lastTick = stateTick;
      row.lastUpdateTick = updateTick;
      return;
    }
    if (!wantsFinish && state.status === STANDINGS_STATUS.WRECKED) {
      if (!row.wrecked) {
        row.wrecked = true;
        row.wreckTick = stateTick;
        row.status = STANDINGS_STATUS.WRECKED;
        this.emit(STANDINGS_EVENT.WRECK, stateTick, row.id, {
          progressMetres: round6(row.progressMetres)
        });
      }
      row.previousPosition = state.position.slice(0, 3);
      row.lastTick = stateTick;
      row.lastUpdateTick = updateTick;
      return;
    }

    const teleportKind = state.teleport?.kind ?? null;
    const isRespawn = state.respawn === true || teleportKind === 'respawn';
    if (wantsFinish) {
      // Process the physical tick first so a crossing on the finish tick is
      // credited by the measured gate/lap evidence; only an unfinished host
      // report is accepted as authoritative below.
    } else if (isRespawn) {
      this.applyRespawn(row, state, stateTick);
      row.lastTick = stateTick;
      row.lastUpdateTick = updateTick;
      return;
    } else if (state.teleport) {
      this.applyTeleport(row, state, stateTick, elapsed);
      row.lastTick = stateTick;
      row.lastUpdateTick = updateTick;
      return;
    }

    if (row.wrecked) {
      row.wrecked = false;
      row.status = STANDINGS_STATUS.RUNNING;
      this.emit(STANDINGS_EVENT.RECOVERED, stateTick, row.id, {
        note: 'host resumed motion without a declared respawn'
      });
    }

    if (row.lastTick < 0) {
      // Prime the first state: establish the projection branch without
      // counting a gate, a lap or a finish.
      const projection = this.course.project(state.position, {
        previousArc: 0,
        hintSegment: null
      });
      row.previousPosition = state.position.slice(0, 3);
      row.previousArc = this.course.mode === COURSE_MODE.LAP ? 0 : clamp(projection.arc, 0, this.course.finishArc);
      row.trackArc = row.previousArc;
      row.segment = projection.segment;
      row.progressMetres = row.previousArc;
      row.maxProgressMetres = row.progressMetres;
      row.lastTick = stateTick;
      row.lastUpdateTick = updateTick;
      return;
    }

    const previousProgress = row.progressMetres;
    const projection = this.course.project(state.position, {
      previousArc: row.previousArc,
      hintSegment: row.segment
    });
    row.segment = projection.segment;

    if (this.isContainment(row, projection, state.position)) {
      this.markContainment(row, stateTick, this.containmentReason(row, projection, state.position), state.position);
      if (wantsFinish) this.acceptAuthoritativeFinish(row, state, stateTick);
      row.lastTick = stateTick;
      row.lastUpdateTick = updateTick;
      return;
    }
    if (row.offMap) {
      row.offMap = false;
      row.offMapReason = null;
      this.emit(STANDINGS_EVENT.RECOVERED, stateTick, row.id, { note: 'back on the measured course' });
    }

    if (this.course.mode === COURSE_MODE.SPRINT) {
      if (!this.updateSprintProgress(row, state, stateTick, elapsed, projection)) {
        if (wantsFinish && !row.finished) this.acceptAuthoritativeFinish(row, state, stateTick);
        row.lastTick = stateTick;
        row.lastUpdateTick = updateTick;
        return;
      }
    } else if (!this.updateLapProgress(row, state, stateTick, elapsed, projection)) {
      if (wantsFinish && !row.finished) this.acceptAuthoritativeFinish(row, state, stateTick);
      row.lastTick = stateTick;
      row.lastUpdateTick = updateTick;
      return;
    }

    if (wantsFinish) {
      if (!row.finished) this.acceptAuthoritativeFinish(row, state, stateTick);
      else this.reconcileFinishTick(row, state);
    }

    row.previousPosition = state.position.slice(0, 3);
    row.lastTick = stateTick;
    row.lastUpdateTick = updateTick;
    const delta = row.progressMetres - previousProgress;
    if (delta > 0 && delta <= this.maxStepMetres(elapsed) * 1.5) {
      row.pushPace(stateTick, row.progressMetres, this.course.tickHz,
        this.options.paceWindowTicks, this.options.minPaceTicks);
    }
  }

  acceptAuthoritativeFinish(row, state, stateTick) {
    const finishTick = Number.isInteger(state.finishTick) ? state.finishTick : stateTick;
    if (finishTick < 0 || finishTick > stateTick) {
      this.emit(STANDINGS_EVENT.FINISH_UNVALIDATED, stateTick, row.id, {
        reason: 'finishTick-out-of-range', finishTick
      });
      return;
    }
    row.finished = true;
    row.status = STANDINGS_STATUS.FINISHED;
    row.finishTick = finishTick;
    row.totalTimeSeconds = round6(finishTick / this.course.tickHz);
    row.finishSource = 'host';
    row.finishValidated = this.course.mode === COURSE_MODE.LAP
      ? row.lapsCompleted >= this.course.laps
      : row.checkpointIndex >= this.requiredCheckpoints;
    if (this.course.mode === COURSE_MODE.LAP) {
      row.lapsCompleted = Math.max(row.lapsCompleted, this.course.laps);
    }
    row.progressMetres = this.course.mode === COURSE_MODE.LAP
      ? this.course.lengthMetres * this.course.laps
      : this.course.finishArc;
    row.trackArc = this.course.finishArc;
    row.wrecked = false;
    this.emit(STANDINGS_EVENT.FINISH, finishTick, row.id, {
      finishTick,
      totalTimeSeconds: row.totalTimeSeconds,
      source: 'host',
      checkpointsValidated: row.finishValidated
    });
    if (!row.finishValidated) {
      this.emit(STANDINGS_EVENT.FINISH_UNVALIDATED, finishTick, row.id, {
        reason: 'local-checkpoint-evidence-incomplete',
        checkpointsSeen: row.checkpointIndex,
        required: this.requiredCheckpoints
      });
    }
  }

  /** Host finish tick is authoritative within a two-tick relay tolerance. */
  reconcileFinishTick(row, state) {
    if (!Number.isInteger(state.finishTick) || row.finishTick === null) return;
    if (Math.abs(state.finishTick - row.finishTick) <= 2) {
      row.finishTick = state.finishTick;
      row.totalTimeSeconds = round6(row.finishTick / this.course.tickHz);
      return;
    }
    this.emit(STANDINGS_EVENT.FINISH_TICK_MISMATCH, row.finishTick, row.id, {
      measuredFinishTick: row.finishTick,
      hostFinishTick: state.finishTick,
      toleranceTicks: 2
    });
  }

  applyRespawn(row, state, stateTick) {
    const target = this.respawnTargetFor(row);
    const distance = planarDistance(state.position, [target.x, target.y, target.z]);
    if (distance > this.options.respawnToleranceMetres) {
      row.respawnRejected = true;
      this.emit(STANDINGS_EVENT.RESPAWN_TARGET_REJECTED, stateTick, row.id, {
        expectedGateId: target.gateId,
        distanceMetres: round6(distance),
        limitMetres: this.options.respawnToleranceMetres
      });
      return;
    }
    row.respawnRejected = false;
    row.offMap = false;
    row.offMapReason = null;
    row.wrecked = false;
    row.status = STANDINGS_STATUS.RUNNING;
    row.previousPosition = state.position.slice(0, 3);
    row.segment = this.course.project(state.position, { hintSegment: null }).segment;
    row.pace = [];
    row.meanSpeedMps = 0;
    if (this.course.mode === COURSE_MODE.LAP) {
      row.lapsCompleted = Math.max(0, row.lapsCompleted);
      row.progressMetres = round6(row.lapsCompleted * this.course.lengthMetres);
      row.resetLapProgress();
      row.previousArc = 0;
      row.lapProgress = 0;
      row.progressMetres = round6(row.lapsCompleted * this.course.lengthMetres);
      row.maxProgressMetres = Math.max(row.maxProgressMetres, row.progressMetres);
    } else {
      const arc = clamp(target.arc, 0, this.course.finishArc);
      row.progressMetres = round6(arc);
      row.previousArc = row.progressMetres;
      row.trackArc = row.progressMetres;
      row.maxProgressMetres = Math.max(row.maxProgressMetres, row.progressMetres);
    }
    this.emit(STANDINGS_EVENT.RESPAWN, stateTick, row.id, {
      gateId: target.gateId,
      gateIndex: target.gateIndex,
      arc: round6(target.arc),
      distanceMetres: round6(distance)
    });
  }

  applyTeleport(row, state, stateTick, elapsed) {
    if (!isFinitePosition(state.position)) {
      this.markContainment(row, stateTick, 'non-finite-position', state.position);
      return;
    }
    const projection = this.course.project(state.position, { hintSegment: null });
    if (this.isContainment(row, projection, state.position)) {
      this.markContainment(row, stateTick, this.containmentReason(row, projection, state.position), state.position);
      return;
    }
    const arc = clamp(projection.arc, 0, this.course.finishArc);
    const candidate = this.course.mode === COURSE_MODE.LAP
      ? round6(row.lapsCompleted * this.course.lengthMetres + arc)
      : round6(arc);
    const limit = this.maxStepMetres(elapsed);
    if (candidate > row.progressMetres + limit + 1e-6) {
      this.emit(STANDINGS_EVENT.TELEPORT_FORWARD_REJECTED, stateTick, row.id, {
        kind: state.teleport.kind ?? 'unknown',
        fromMetres: round6(row.progressMetres),
        observedMetres: candidate,
        limitMetres: round6(limit),
        elapsedTicks: elapsed
      });
      // Keep the old progress branch, but reset the motion history so the
      // car cannot re-earn the teleported distance by driving forward.
      row.previousPosition = state.position.slice(0, 3);
      row.segment = projection.segment;
      return;
    }
    if (this.course.mode === COURSE_MODE.LAP) {
      row.lapProgress = Math.min(row.lapProgress, arc);
      row.validatedTravel = Math.min(row.validatedTravel, arc);
      row.checkpointIndex = this.course.sectors.filter((sector) => sector.arc <= arc).length;
      row.sectorMask = 0;
      for (let index = 0; index < row.checkpointIndex; index++) row.sectorMask |= (1 << index);
      row.progressMetres = round6(row.lapsCompleted * this.course.lengthMetres + row.lapProgress);
    } else {
      row.progressMetres = round6(Math.min(row.progressMetres, arc));
    }
    row.trackArc = arc;
    row.previousArc = arc;
    row.previousPosition = state.position.slice(0, 3);
    row.segment = projection.segment;
    this.emit(STANDINGS_EVENT.POWERUP_TELEPORT, stateTick, row.id, {
      kind: state.teleport.kind ?? 'powerup',
      reason: state.teleport.reason ?? null,
      arc,
      progressMetres: row.progressMetres,
      accepted: true
    });
  }

  updateSprintProgress(row, state, stateTick, elapsed, projection) {
    const arc = clamp(projection.arc, 0, this.course.finishArc);
    row.trackArc = arc;
    const delta = arc - row.previousArc;
    const limit = this.maxStepMetres(elapsed);
    if (delta > limit + 1e-6) {
      this.emit(STANDINGS_EVENT.PROGRESS_JUMP_REJECTED, stateTick, row.id, {
        observedMetres: round6(arc),
        previousMetres: round6(row.previousArc),
        deltaMetres: round6(delta),
        limitMetres: round6(limit),
        elapsedTicks: elapsed
      });
      row.previousPosition = state.position.slice(0, 3);
      return false;
    }
    if (delta < -this.options.backtrackToleranceMetres) {
      this.emit(STANDINGS_EVENT.BACKTRACK_CLAMPED, stateTick, row.id, {
        observedMetres: round6(arc),
        heldMetres: round6(row.progressMetres),
        deltaMetres: round6(delta)
      });
    }
    if (delta > 0) {
      row.previousArc = arc;
      row.progressMetres = Math.max(row.progressMetres, arc);
      row.maxProgressMetres = Math.max(row.maxProgressMetres, row.progressMetres);
    } else if (delta >= -this.options.backtrackToleranceMetres) {
      row.previousArc = Math.max(row.previousArc, arc);
    }
    this.checkSprintGates(row, state, stateTick);
    return !row.finished;
  }

  checkSprintGates(row, state, stateTick) {
    const previous = row.previousPosition;
    const current = state.position;
    // Checkpoints are strict order; a later gate crossed first is reported but
    // never credited.
    for (let index = 1; index < this.course.gates.length - 1; index++) {
      const gate = this.course.gates[index];
      const crossing = lineCrossing(previous, current, gate);
      if (!crossing) continue;
      if (index === row.checkpointIndex + 1) {
        row.checkpointIndex++;
        this.emit(STANDINGS_EVENT.CHECKPOINT, stateTick, row.id, {
          gateId: gate.id,
          index,
          arc: gate.arc,
          position: crossing.point
        });
      } else if (index > row.checkpointIndex + 1) {
        this.emit(STANDINGS_EVENT.GATE_OUT_OF_ORDER, stateTick, row.id, {
          gateId: gate.id,
          index,
          expectedIndex: row.checkpointIndex + 1
        });
      }
    }
    const finishGate = this.course.finishGate;
    const finishCrossing = lineCrossing(previous, current, finishGate);
    if (!finishCrossing) return;
    if (row.checkpointIndex < this.requiredCheckpoints) {
      row.finishBlocked = true;
      this.emit(STANDINGS_EVENT.FINISH_BLOCKED, stateTick, row.id, {
        gateId: finishGate.id,
        checkpointsSeen: row.checkpointIndex,
        required: this.requiredCheckpoints
      });
      return;
    }
    row.finished = true;
    row.status = STANDINGS_STATUS.FINISHED;
    row.finishTick = stateTick;
    row.totalTimeSeconds = round6(stateTick / this.course.tickHz);
    row.finishSource = 'gate-crossing';
    row.finishValidated = true;
    row.finishBlocked = false;
    row.progressMetres = this.course.finishArc;
    row.trackArc = this.course.finishArc;
    row.maxProgressMetres = Math.max(row.maxProgressMetres, row.progressMetres);
    this.emit(STANDINGS_EVENT.FINISH, stateTick, row.id, {
      finishTick: stateTick,
      totalTimeSeconds: row.totalTimeSeconds,
      gateId: finishGate.id,
      source: 'gate-crossing',
      checkpointsValidated: true,
      position: finishCrossing.point
    });
  }

  updateLapProgress(row, state, stateTick, elapsed, projection) {
    const arc = clamp(projection.arc, 0, this.course.lengthMetres);
    row.trackArc = arc;
    let rawDelta = arc - row.previousArc;
    if (rawDelta < -this.course.lengthMetres / 2) rawDelta += this.course.lengthMetres;
    if (rawDelta > this.course.lengthMetres / 2) rawDelta -= this.course.lengthMetres;
    const limit = this.maxStepMetres(elapsed);
    if (rawDelta > limit + 1e-6) {
      this.emit(STANDINGS_EVENT.PROGRESS_JUMP_REJECTED, stateTick, row.id, {
        observedMetres: round6(row.lapsCompleted * this.course.lengthMetres + arc),
        previousMetres: round6(row.progressMetres),
        deltaMetres: round6(rawDelta),
        limitMetres: round6(limit),
        elapsedTicks: elapsed
      });
      row.previousPosition = state.position.slice(0, 3);
      return false;
    }
    if (rawDelta >= 0) {
      row.validatedTravel = Math.min(this.course.lengthMetres,
        row.validatedTravel + rawDelta);
      row.lapProgress = Math.max(row.lapProgress, arc);
      row.previousArc = arc;
      row.progressMetres = round6(row.lapsCompleted * this.course.lengthMetres + row.lapProgress);
      row.maxProgressMetres = Math.max(row.maxProgressMetres, row.progressMetres);
    } else if (rawDelta < -this.options.backtrackToleranceMetres) {
      this.emit(STANDINGS_EVENT.BACKTRACK_CLAMPED, stateTick, row.id, {
        observedMetres: round6(arc),
        heldMetres: round6(row.progressMetres),
        deltaMetres: round6(rawDelta)
      });
    } else {
      row.previousArc = arc;
    }

    this.checkLapSectors(row, state, stateTick);
    this.checkLapLine(row, state, stateTick);
    return !row.finished;
  }

  checkLapSectors(row, state, stateTick) {
    const previous = row.previousPosition;
    const current = state.position;
    for (const sector of this.course.sectors) {
      const crossing = lineCrossing(previous, current, sector);
      if (!crossing) continue;
      if (sector.index === row.checkpointIndex + 1) {
        row.checkpointIndex++;
        row.sectorMask |= (1 << (sector.index - 1));
        this.emit(STANDINGS_EVENT.CHECKPOINT, stateTick, row.id, {
          gateId: sector.id,
          index: sector.index,
          lap: row.lapsCompleted + 1,
          arc: sector.arc,
          position: crossing.point
        });
      } else if (sector.index > row.checkpointIndex + 1) {
        this.emit(STANDINGS_EVENT.GATE_OUT_OF_ORDER, stateTick, row.id, {
          gateId: sector.id,
          index: sector.index,
          expectedIndex: row.checkpointIndex + 1
        });
      }
    }
  }

  checkLapLine(row, state, stateTick) {
    const crossing = lineCrossing(row.previousPosition, state.position, this.course.lapLine);
    if (!crossing) return;
    // A car that settles backwards over the line in the first metres has not
    // started a lap. The race timer still starts at GO, exactly as the layout
    // document states; the crossing is ignored, not turned into a short lap.
    if (row.validatedTravel < 5) return;
    const allSectors = (1 << (this.course.sectorCount - 1)) - 1;
    const travelComplete = row.validatedTravel >= this.course.lengthMetres - this.options.lapToleranceMetres;
    const sectorsComplete = (row.sectorMask & allSectors) === allSectors;
    if (!travelComplete || !sectorsComplete) {
      row.finishBlocked = true;
      this.emit(STANDINGS_EVENT.LAP_REJECTED, stateTick, row.id, {
        lap: row.lapsCompleted + 1,
        validatedTravelMetres: round6(row.validatedTravel),
        requiredTravelMetres: round6(this.course.lengthMetres - this.options.lapToleranceMetres),
        sectorsComplete,
        reasons: [
          ...(travelComplete ? [] : ['short-lap']),
          ...(sectorsComplete ? [] : ['missing-sector'])
        ],
        position: crossing.point
      });
      // The car is physically past the line. Keep its validated progress and
      // let it earn the next crossing after a real full loop.
      const arc = clamp(this.course.project(state.position, {
        previousArc: row.previousArc, hintSegment: row.segment
      }).arc, 0, this.course.lengthMetres);
      row.previousArc = arc;
      row.trackArc = arc;
      return;
    }
    row.lapsCompleted++;
    const lapSeconds = round6((stateTick - row.lapStartTick) / this.course.tickHz);
    row.lastLapSeconds = lapSeconds;
    row.lapTimes.push(lapSeconds);
    row.bestLapSeconds = row.lapTimes.length ? Math.min(...row.lapTimes) : null;
    row.finishBlocked = false;
    const arc = clamp(this.course.project(state.position, {
      previousArc: row.previousArc, hintSegment: row.segment
    }).arc, 0, this.course.lengthMetres);
    if (row.lapsCompleted >= this.course.laps) {
      row.finished = true;
      row.status = STANDINGS_STATUS.FINISHED;
      row.finishTick = stateTick;
      row.totalTimeSeconds = round6(stateTick / this.course.tickHz);
      row.finishSource = 'lap-line';
      row.finishValidated = true;
      row.progressMetres = round6(this.course.lengthMetres * this.course.laps);
      row.trackArc = 0;
      row.previousArc = 0;
      row.lapProgress = 0;
      row.validatedTravel = 0;
      row.sectorMask = 0;
      row.checkpointIndex = this.requiredCheckpoints;
      row.maxProgressMetres = Math.max(row.maxProgressMetres, row.progressMetres);
      this.emit(STANDINGS_EVENT.LAP, stateTick, row.id, {
        lap: row.lapsCompleted,
        laps: this.course.laps,
        lapSeconds,
        lapTimes: row.lapTimes.slice(),
        bestLapSeconds: row.bestLapSeconds,
        position: crossing.point
      });
      this.emit(STANDINGS_EVENT.FINISH, stateTick, row.id, {
        finishTick: stateTick,
        totalTimeSeconds: row.totalTimeSeconds,
        lap: row.lapsCompleted,
        laps: this.course.laps,
        lapSeconds,
        lapTimes: row.lapTimes.slice(),
        bestLapSeconds: row.bestLapSeconds,
        source: 'lap-line',
        checkpointsValidated: true,
        position: crossing.point
      });
      return;
    }
    row.resetLapProgress();
    row.lapStartTick = stateTick;
    row.lapProgress = arc;
    row.previousArc = arc;
    row.trackArc = arc;
    row.progressMetres = round6(row.lapsCompleted * this.course.lengthMetres + arc);
    row.maxProgressMetres = Math.max(row.maxProgressMetres, row.progressMetres);
    this.emit(STANDINGS_EVENT.LAP, stateTick, row.id, {
      lap: row.lapsCompleted,
      laps: this.course.laps,
      lapSeconds,
      lapTimes: row.lapTimes.slice(),
      bestLapSeconds: row.bestLapSeconds,
      position: crossing.point
    });
  }

  isContainment(row, projection, position) {
    return this.containmentReason(row, projection, position) !== null;
  }

  containmentReason(row, projection, position) {
    if (!isFinitePosition(position)) return 'non-finite-position';
    const halfWidth = this.course.corridorHalfWidthMetres;
    if (halfWidth !== null &&
        projection.lateral > halfWidth + this.options.containmentMarginMetres) {
      return 'outside-corridor';
    }
    if (this.course.mode === COURSE_MODE.SPRINT) {
      if (projection.arc < -this.options.backtrackToleranceMetres - 8) return 'behind-start';
      if (projection.arc > this.course.finishArc + 10) return 'past-finish';
    }
    const groundY = projection.groundY;
    if (Number.isFinite(groundY) &&
        position[1] < groundY - this.options.fallBelowGroundMetres) {
      return 'below-ground';
    }
    return null;
  }

  markContainment(row, tick, reason, position) {
    const first = !row.offMap;
    row.offMap = true;
    row.offMapReason = reason;
    if (!first) return;
    const target = this.respawnTargetFor(row);
    this.emit(STANDINGS_EVENT.CONTAINMENT_RESET, tick, row.id, {
      reason,
      observed: isFinitePosition(position) ? position.slice(0, 3) : null,
      target: {
        gateId: target.gateId, gateIndex: target.gateIndex,
        arc: round6(target.arc), x: target.x, y: target.y, z: target.z
      },
      note: 'host must rebuild the car at the target; progress stays frozen'
    });
  }

  currentLapsCompleted(row) {
    if (this.course.mode === COURSE_MODE.SPRINT) {
      return row.finished ? 1 : 0;
    }
    return row.lapsCompleted;
  }

  progressFraction(row) {
    const total = this.course.mode === COURSE_MODE.LAP
      ? this.course.lengthMetres * this.course.laps
      : this.course.finishArc;
    if (!(total > 0)) return 0;
    return round6(clamp(row.progressMetres / total, 0, 1));
  }

  buildRow(row) {
    const lapsCompleted = this.currentLapsCompleted(row);
    return {
      id: row.id,
      slot: row.slot,
      name: row.name,
      status: row.status,
      position: null,
      tied: false,
      finishTick: row.finishTick,
      totalTimeSeconds: row.totalTimeSeconds,
      finishValidated: row.finishValidated,
      lapsCompleted,
      lapsTotal: this.course.mode === COURSE_MODE.LAP ? this.course.laps : 1,
      currentLap: this.course.mode === COURSE_MODE.LAP
        ? Math.min(this.course.laps, lapsCompleted + (row.finished ? 0 : 1))
        : 1,
      checkpointIndex: row.checkpointIndex,
      checkpointsTotal: this.requiredCheckpoints,
      trackArc: round6(row.trackArc),
      progressMetres: round6(row.progressMetres),
      maxProgressMetres: round6(row.maxProgressMetres),
      progressFraction: this.progressFraction(row),
      bestLapSeconds: row.bestLapSeconds,
      lastLapSeconds: row.lastLapSeconds,
      lapTimes: row.lapTimes.slice(),
      gapToLeaderMetres: null,
      gapToLeaderSeconds: null,
      gapToAheadMetres: null,
      gapToAheadSeconds: null,
      gapSource: null,
      lapsDown: 0,
      wrecked: row.wrecked,
      offMap: row.offMap,
      offMapReason: row.offMapReason,
      stale: row.stale,
      staleTicks: row.staleTicks,
      respawnRejected: row.respawnRejected,
      finishBlocked: row.finishBlocked,
      dnfReason: row.dnfReason,
      meanSpeedMps: round6(row.meanSpeedMps)
    };
  }

  /** Ordered snapshot with positions, ties and gaps. */
  snapshot() {
    if (this.snapshotCache && this.snapshotCache.sequence === this.sequence) {
      return this.snapshotCache.value;
    }
    const rows = [...this.rows.values()].map((row) => this.buildRow(row)).sort(compareRows);
    const leader = rows[0] ?? null;
    const referencePace = leader && leader.meanSpeedMps > 1
      ? leader.meanSpeedMps : this.options.defaultPaceMps;

    // Standard competition ranking on the documented tie key.
    let lastKey = null;
    let lastPosition = 0;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const key = tieKeyFor(row);
      if (key === lastKey) {
        row.position = lastPosition;
        row.tied = true;
        if (index > 0) rows[index - 1].tied = true;
      } else {
        row.position = index + 1;
        lastPosition = row.position;
        lastKey = key;
      }
    }

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (index === 0) {
        row.gapToLeaderMetres = 0;
        row.gapToLeaderSeconds = 0;
        row.gapToAheadMetres = 0;
        row.gapToAheadSeconds = 0;
        row.gapSource = 'leader';
        continue;
      }
      const previous = rows[index - 1];
      const tiedWithAhead = row.position === previous.position;
      const sameTimeGroup = row.status === STANDINGS_STATUS.FINISHED &&
        previous.status === STANDINGS_STATUS.FINISHED;

      if (sameTimeGroup) {
        const seconds = round6(Math.max(0,
          (row.finishTick - previous.finishTick) / this.course.tickHz));
        row.gapToAheadMetres = tiedWithAhead ? 0 : null;
        row.gapToAheadSeconds = tiedWithAhead ? 0 : seconds;
        const leaderSeconds = round6(Math.max(0,
          (row.finishTick - leader.finishTick) / this.course.tickHz));
        row.gapToLeaderMetres = null;
        row.gapToLeaderSeconds = leaderSeconds;
        row.gapSource = 'finish-time';
      } else {
        const metresAhead = Math.max(0, previous.progressMetres - row.progressMetres);
        const metresLeader = Math.max(0, leader.progressMetres - row.progressMetres);
        row.gapToAheadMetres = tiedWithAhead ? 0 : round6(metresAhead);
        row.gapToLeaderMetres = round6(metresLeader);
        row.gapToAheadSeconds = tiedWithAhead ? 0
          : round6(metresAhead / Math.max(1, referencePace));
        row.gapToLeaderSeconds = round6(metresLeader / Math.max(1, referencePace));
        row.gapSource = 'pace-estimate';
      }
      if (this.course.mode === COURSE_MODE.LAP) {
        row.lapsDown = Math.max(0, leader.lapsCompleted - row.lapsCompleted);
      }
    }

    const body = {
      schema: STANDINGS_SCHEMA,
      sequence: this.sequence,
      tick: this.tick,
      tickHz: this.course.tickHz,
      courseId: this.course.courseId,
      layoutHash: this.course.layoutHash,
      mode: this.course.mode,
      laps: this.course.mode === COURSE_MODE.LAP ? this.course.laps : 1,
      standings: true,
      leaderId: rows[0]?.id ?? null,
      order: rows.map((row) => row.id),
      rows,
      ties: tiesOf(rows),
      ordering: 'finished by finishTick, best lap, id; then progress, best lap, id; DNF and disconnected last',
      progressMetric: this.course.mode === COURSE_MODE.LAP
        ? 'validated laps * measured loop length + distance along the loop (sector checkpoints)'
        : 'distance along the measured path, clamped to the finish arc'
    };
    const value = { ...body, hash: hashOf(body) };
    this.snapshotCache = { sequence: this.sequence, value };
    return value;
  }
  broadcast() {
    const snapshot = this.snapshot();
    const rows = snapshot.rows.map((row) => ({
      id: row.id,
      slot: row.slot,
      name: row.name,
      position: row.position,
      tied: row.tied,
      status: row.status,
      lap: row.currentLap,
      laps: row.lapsTotal,
      lapsDown: row.lapsDown,
      checkpointIndex: row.checkpointIndex,
      checkpointsTotal: row.checkpointsTotal,
      trackArc: row.trackArc,
      progressFraction: row.progressFraction,
      gapToLeaderMetres: row.gapToLeaderMetres,
      gapToLeaderSeconds: row.gapToLeaderSeconds,
      gapToAheadMetres: row.gapToAheadMetres,
      gapToAheadSeconds: row.gapToAheadSeconds,
      gapSource: row.gapSource,
      bestLapSeconds: row.bestLapSeconds,
      lastLapSeconds: row.lastLapSeconds,
      totalTimeSeconds: row.totalTimeSeconds,
      finishTick: row.finishTick,
      wrecked: row.wrecked,
      offMap: row.offMap,
      stale: row.stale,
      dnfReason: row.dnfReason
    }));
    const body = {
      schema: STANDINGS_SCHEMA,
      sequence: snapshot.sequence,
      tick: snapshot.tick,
      tickHz: snapshot.tickHz,
      courseId: snapshot.courseId,
      layoutHash: snapshot.layoutHash,
      mode: snapshot.mode,
      laps: snapshot.laps,
      leaderId: snapshot.leaderId,
      order: snapshot.order,
      rows,
      ties: snapshot.ties,
      hashAlgorithm: 'sha256-canonical-json'
    };
    return { ...body, hash: hashOf(body) };
  }

  /** Deterministic hash of the current full table. */
  hash() {
    return this.snapshot().hash;
  }

  /** Deterministic hash of the event log and every per-tick snapshot hash. */
  replayHash() {
    return hashOf({
      schema: 'blur.standings.replay/1',
      courseId: this.course.courseId,
      layoutHash: this.course.layoutHash,
      events: this.events,
      tickHashes: this.replayHashes
    });
  }
}

function tiesOf(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row.position);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.id);
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([position, ids]) => ({ position: Number(position), participants: ids }));
}

/** Free-roam: no standings metric, no rows, no invented progress. */
export class FreeStandings {
  constructor(layout, participants, config = {}) {
    this.course = layout instanceof CourseModel ? layout : new CourseModel(layout, {
      verifyLayoutHash: config.verifyLayoutHash
    });
    if (this.course.mode !== COURSE_MODE.FREE) {
      throw new Error('FreeStandings needs a free-roam layout');
    }
    this.participants = normalizeParticipants(participants);
    this.tick = -1;
    this.sequence = 0;
    this.events = [];
  }

  update(tick) {
    if (!Number.isInteger(tick) || tick < 0) throw new Error('standings: tick must be a non-negative integer');
    if (tick <= this.tick) {
      this.events.push({ type: STANDINGS_EVENT.OUT_OF_ORDER_SNAPSHOT, tick, id: null });
      return [];
    }
    this.tick = tick;
    this.sequence++;
    return [];
  }

  snapshot() {
    const body = {
      schema: STANDINGS_SCHEMA,
      sequence: this.sequence,
      tick: this.tick,
      courseId: this.course.courseId,
      layoutHash: this.course.layoutHash,
      mode: COURSE_MODE.FREE,
      standings: false,
      reason: 'free-roam has no race progress metric',
      leaderId: null,
      order: [],
      rows: [],
      ties: []
    };
    return { ...body, hash: hashOf(body) };
  }

  broadcast() {
    return this.snapshot();
  }

  hash() {
    return this.snapshot().hash;
  }

  replayHash() {
    return hashOf({ schema: 'blur.standings.replay/1', events: this.events, rows: [] });
  }
}

/** Factory that selects the standings model from the committed layout. */
export function createStandings(layout, participants, config = {}) {
  const course = layout instanceof CourseModel ? layout : new CourseModel(layout, {
    verifyLayoutHash: config.verifyLayoutHash,
    sectorCount: config.sectorCount
  });
  if (course.mode === COURSE_MODE.FREE) {
    return new FreeStandings(course, participants, config);
  }
  return new Standings(course, participants, config);
}

export { CourseModel, COURSE_MODE, lineCrossing };
