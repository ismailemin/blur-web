// Client-side prediction + authoritative reconciliation for a deterministic
// fixed-step simulation.
//
// The predictor is the client half of the host-authoritative model:
//
//   local input at tick n  ->  step(state, input) immediately  ->  render n
//   host snapshot at tick S  ->  compare predicted[S] with authority[S]
//                            ->  rollback to S, replay inputs S+1..current
//                            ->  hide residual error behind a decaying visual
//                                offset when the correction is small enough
//
// The step is injected: `new Predictor({ step, cloneState })`. Nothing here
// imports a physics module, so the same class can run against the fake sim in
// this probe and against the real wasm step in e1-drive.
//
// Determinism: the class never reads a wall clock. The caller supplies every
// tick and every input; all counters and hashes are functions of those calls.
//
// No silent fallback: a malformed snapshot is counted and reported with a
// reason, a broken step contract throws PredictionError. The caller always
// receives enough metadata to decide what to show.

export const PREDICTION_VERSION = 1;

export const PREDICTION_ERROR_CODES = Object.freeze({
  PREDICT_CONFIG: 'PREDICT_CONFIG',
  PREDICT_STATE: 'PREDICT_STATE',
  PREDICT_INPUT: 'PREDICT_INPUT',
  PREDICT_STEP: 'PREDICT_STEP',
  PREDICT_TICK: 'PREDICT_TICK',
  PREDICT_NOT_STARTED: 'PREDICT_NOT_STARTED'
});

export class PredictionError extends Error {
  constructor(code, message, detail = null) {
    super(message || code);
    this.name = 'PredictionError';
    this.code = PREDICTION_ERROR_CODES[code] ? code : PREDICTION_ERROR_CODES.PREDICT_CONFIG;
    this.detail = detail;
  }
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, detail: this.detail };
  }
}

// --------------------------------------------------------------------- ticks

export function tickAdd(tick, amount, wrapBits = 32) {
  if (!Number.isInteger(tick) || !Number.isInteger(amount)) {
    throw new PredictionError('PREDICT_TICK', 'tickAdd expects integers', { tick, amount });
  }
  const modulus = 2 ** wrapBits;
  let next = (tick + amount) % modulus;
  if (next < 0) next += modulus;
  return next;
}

/**
 * Signed forward distance from `from` to `to` in (-modulus/2, modulus/2].
 * Normal race ticks (well below 2^31) behave as plain subtraction; a 32-bit
 * counter wrap is handled without special cases at the call sites.
 */
export function tickDelta(from, to, wrapBits = 32) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new PredictionError('PREDICT_TICK', 'tickDelta expects integers', { from, to });
  }
  const modulus = 2 ** wrapBits;
  let delta = (to - from) % modulus;
  if (delta < 0) delta += modulus;
  if (delta > modulus / 2) delta -= modulus;
  return delta;
}

// --------------------------------------------------------------- validation

function finiteVector(value, length) {
  return Array.isArray(value) && value.length === length && value.every((part) => Number.isFinite(part));
}

/** Returns a reason string or null. Never throws for data. */
export function checkPredictionState(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return 'state must be an object';
  if (!finiteVector(state.position, 3)) return 'state.position must be [x,y,z] finite';
  if (!finiteVector(state.quaternion, 4)) return 'state.quaternion must be [x,y,z,w] finite';
  const norm = Math.sqrt(
    state.quaternion[0] ** 2 + state.quaternion[1] ** 2 + state.quaternion[2] ** 2 + state.quaternion[3] ** 2
  );
  if (!(norm > 0) || Math.abs(norm - 1) > 1e-2) return 'state.quaternion must be unit length (got ' + norm + ')';
  if (!Number.isFinite(state.speed)) return 'state.speed must be finite';
  return null;
}

/** Returns a reason string or null. Never throws for data. */
export function checkPredictionInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  for (const field of ['throttle', 'brake', 'steer', 'handbrake']) {
    if (!Number.isFinite(input[field])) return 'input.' + field + ' must be finite';
    if (input[field] < -1 || input[field] > 1) return 'input.' + field + ' must be in [-1, 1]';
  }
  return null;
}

function cloneInput(input) {
  return {
    throttle: input.throttle,
    brake: input.brake,
    steer: input.steer,
    handbrake: input.handbrake
  };
}

export function defaultCloneState(state) {
  const copy = {
    tick: state.tick,
    position: [state.position[0], state.position[1], state.position[2]],
    quaternion: [state.quaternion[0], state.quaternion[1], state.quaternion[2], state.quaternion[3]],
    speed: state.speed
  };
  if (Array.isArray(state.heading)) copy.heading = [state.heading[0], state.heading[1]];
  for (const key of Object.keys(state)) {
    if (!(key in copy)) copy[key] = state[key];
  }
  return copy;
}

// ------------------------------------------------------------ quaternion math

export function quatNormalize(q) {
  const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  if (!(length > 0)) return [0, 0, 0, 1];
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

export function quatDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

export function quatConjugate(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatMultiply(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
}

export function quatSlerp(a, b, t) {
  let target = b;
  let dot = quatDot(a, target);
  if (dot < 0) {
    target = [-b[0], -b[1], -b[2], -b[3]];
    dot = -dot;
  }
  if (dot > 0.9995) {
    return quatNormalize([
      a[0] + (target[0] - a[0]) * t,
      a[1] + (target[1] - a[1]) * t,
      a[2] + (target[2] - a[2]) * t,
      a[3] + (target[3] - a[3]) * t
    ]);
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinTheta = Math.sin(theta);
  const w0 = Math.sin((1 - t) * theta) / sinTheta;
  const w1 = Math.sin(t * theta) / sinTheta;
  return quatNormalize([
    a[0] * w0 + target[0] * w1,
    a[1] * w0 + target[1] * w1,
    a[2] * w0 + target[2] * w1,
    a[3] * w0 + target[3] * w1
  ]);
}

export function quatAngle(a, b) {
  return 2 * Math.acos(Math.min(1, Math.abs(quatDot(a, b))));
}

export function positionDistance(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const IDENTITY_QUAT = Object.freeze([0, 0, 0, 1]);

// ------------------------------------------------------------------ predictor

const DEFAULTS = Object.freeze({
  tickHz: 60,
  wrapBits: 32,
  // A snapshot deeper than this is replayed but not smoothed: the car visibly
  // snaps once instead of sliding for hundreds of milliseconds.
  maxRollbackTicks: 30,
  // State+input history is 3 s at 60 Hz. A snapshot older than this is a
  // resync (timeline rewind), not a rollback.
  historyTicks: 180,
  positionEpsilon: 0.002,
  angleEpsilon: 0.002,
  speedEpsilon: 0.05,
  hardSnapDistance: 2.5,
  hardSnapAngle: 0.9,
  smoothingHalfLifeTicks: 6,
  smoothing: true,
  maxPendingSnapshots: 12,
  futureWindowTicks: 90,
  requireAuthority: false,
  onReconcile: null,
  onHardSnap: null
});

export class Predictor {
  constructor(options = {}) {
    const config = { ...DEFAULTS, ...options };
    if (typeof config.step !== 'function') {
      throw new PredictionError('PREDICT_CONFIG', 'step(state, input, tick) is required');
    }
    if (typeof config.cloneState !== 'function') {
      throw new PredictionError('PREDICT_CONFIG', 'cloneState(state) is required');
    }
    if (!(config.tickHz > 0)) throw new PredictionError('PREDICT_CONFIG', 'tickHz must be positive');
    if (!(config.maxRollbackTicks > 0) || !(config.historyTicks >= config.maxRollbackTicks)) {
      throw new PredictionError('PREDICT_CONFIG', 'historyTicks must be >= maxRollbackTicks > 0');
    }
    if (!(config.smoothingHalfLifeTicks > 0)) {
      throw new PredictionError('PREDICT_CONFIG', 'smoothingHalfLifeTicks must be positive');
    }
    this.config = config;
    this.step = config.step;
    this.cloneState = config.cloneState;
    this.started = false;
    this.currentTick = null;
    this.currentState = null;
    this.wrecked = false;
    this.lastAnchorTick = null;
    this.history = new Map();
    this.inputLog = new Map();
    this.pending = new Map();
    this.visual = { position: [0, 0, 0], quaternion: [...IDENTITY_QUAT] };
    this.stats = this._emptyStats();
  }

  _emptyStats() {
    return {
      snapshotsReceived: 0,
      snapshotsApplied: 0,
      cleanAnchors: 0,
      corrections: 0,
      rollbacks: 0,
      longRollbacks: 0,
      repositionSnaps: 0,
      wreckSnaps: 0,
      wreckRecoveries: 0,
      hardSnaps: 0,
      resyncSnaps: 0,
      duplicates: 0,
      outOfOrder: 0,
      futureBuffered: 0,
      futureDropped: 0,
      invalidSnapshots: 0,
      notAuthoritative: 0,
      replayTicksTotal: 0,
      replayEvents: 0,
      maxRollbackDepth: 0,
      maxAnchorGapTicks: 0,
      frozenTicks: 0,
      clockRewoundTicks: 0,
      hostChanges: 0,
      lastAnchorGapTicks: 0,
      lastSnapshotTick: null,
      lastError: null
    };
  }

  /** Start a session at an authoritative state and local tick. */
  start(state, tick = state?.tick ?? 0) {
    const problem = checkPredictionState(state);
    if (problem) throw new PredictionError('PREDICT_STATE', 'start state invalid: ' + problem);
    if (!Number.isInteger(tick)) throw new PredictionError('PREDICT_TICK', 'start tick must be an integer');
    this.started = true;
    this.currentTick = tick;
    this.currentState = this.cloneState(state);
    this.currentState.tick = tick;
    this.wrecked = false;
    this.lastAnchorTick = null;
    this.history.clear();
    this.inputLog.clear();
    this.pending.clear();
    this.visual = { position: [0, 0, 0], quaternion: [...IDENTITY_QUAT] };
    this.stats = this._emptyStats();
    this.history.set(tick, this.cloneState(this.currentState));
    this.inputLog.set(tick, cloneInput({ throttle: 0, brake: 0, steer: 0, handbrake: 0 }));
    return this;
  }

  /** Number of ticks between the last applied snapshot and the current tick. */
  get anchorAge() {
    if (this.lastAnchorTick === null) return null;
    return tickDelta(this.lastAnchorTick, this.currentTick, this.config.wrapBits);
  }

  /** Current authoritative-anchor prediction age and smoothing state. */
  renderPose() {
    const state = this.currentState;
    const visualAngle = quatAngle(IDENTITY_QUAT, this.visual.quaternion);
    return {
      tick: this.currentTick,
      position: [
        state.position[0] + this.visual.position[0],
        state.position[1] + this.visual.position[1],
        state.position[2] + this.visual.position[2]
      ],
      quaternion: quatNormalize(quatMultiply(this.visual.quaternion, state.quaternion)),
      speed: state.speed,
      wrecked: this.wrecked,
      smoothing: {
        position: Math.sqrt(
          this.visual.position[0] ** 2 + this.visual.position[1] ** 2 + this.visual.position[2] ** 2
        ),
        angle: visualAngle
      }
    };
  }

  _trimHistory() {
    const wrapBits = this.config.wrapBits;
    // Map iteration is insertion order and ticks are inserted in order, so the
    // scan stops at the first entry that is still inside the window.
    for (const tick of this.history.keys()) {
      if (tickDelta(tick, this.currentTick, wrapBits) <= this.config.historyTicks) break;
      this.history.delete(tick);
    }
    for (const tick of this.inputLog.keys()) {
      if (tickDelta(tick, this.currentTick, wrapBits) <= this.config.historyTicks) break;
      this.inputLog.delete(tick);
    }
  }

  _decayVisual() {
    const halfLife = this.config.smoothingHalfLifeTicks;
    const factor = 2 ** (-1 / halfLife);
    for (let index = 0; index < 3; index++) this.visual.position[index] *= factor;
    const alpha = 1 - factor;
    this.visual.quaternion = quatSlerp(this.visual.quaternion, [...IDENTITY_QUAT], alpha);
    const length = Math.sqrt(
      this.visual.position[0] ** 2 + this.visual.position[1] ** 2 + this.visual.position[2] ** 2
    );
    if (length < 1e-7 && quatAngle(IDENTITY_QUAT, this.visual.quaternion) < 1e-7) {
      this.visual.position = [0, 0, 0];
      this.visual.quaternion = [...IDENTITY_QUAT];
    }
  }

  _validateStepResult(state, tick) {
    const problem = checkPredictionState(state);
    if (problem) {
      throw new PredictionError('PREDICT_STEP', 'step returned an invalid state at tick ' + tick + ': ' + problem, {
        tick,
        state
      });
    }
  }

  /**
   * Sample one local input and advance one fixed tick. The input is applied
   * immediately (this is the whole point of prediction) and is logged for a
   * later replay.
   */
  advance(input) {
    if (!this.started) throw new PredictionError('PREDICT_NOT_STARTED', 'call start() before advance()');
    const problem = checkPredictionInput(input);
    if (problem) throw new PredictionError('PREDICT_INPUT', 'advance input invalid: ' + problem);
    const wrapBits = this.config.wrapBits;
    const nextTick = tickAdd(this.currentTick, 1, wrapBits);
    const logged = cloneInput(input);
    this.inputLog.set(nextTick, logged);

    let nextState;
    if (this.wrecked) {
      nextState = this.cloneState(this.currentState);
      nextState.tick = nextTick;
      this.stats.frozenTicks++;
    } else {
      nextState = this.step(this.currentState, logged, nextTick);
      this._validateStepResult(nextState, nextTick);
      nextState.tick = nextTick;
    }
    this.currentState = nextState;
    this.currentTick = nextTick;
    this.history.set(nextTick, this.cloneState(nextState));
    this._trimHistory();
    this._decayVisual();
    this._flushPending();
    return { tick: this.currentTick, state: this.cloneState(this.currentState), render: this.renderPose() };
  }

  /** Force a local wreck/freeze without an authoritative snapshot. */
  setWrecked(wrecked) {
    this.wrecked = Boolean(wrecked);
    return this.wrecked;
  }

  /** Host migration is out of scope but must not crash a live predictor. */
  onHostChange(hostId = null) {
    this.stats.hostChanges++;
    this.lastAnchorTick = null;
    this.pending.clear();
    this.visual = { position: [0, 0, 0], quaternion: [...IDENTITY_QUAT] };
    return { hostId, tick: this.currentTick };
  }

  _findHistoryEntry(tick) {
    const entry = this.history.get(tick);
    if (!entry) return null;
    return tickDelta(tick, this.currentTick, this.config.wrapBits) >= 0 ? entry : null;
  }

  _canReplay(anchorTick) {
    const wrapBits = this.config.wrapBits;
    if (tickDelta(anchorTick, this.currentTick, wrapBits) > this.config.historyTicks) return false;
    let tick = tickAdd(anchorTick, 1, wrapBits);
    while (tickDelta(tick, this.currentTick, wrapBits) >= 0) {
      if (!this.inputLog.has(tick)) return false;
      if (tick === this.currentTick) break;
      tick = tickAdd(tick, 1, wrapBits);
    }
    return true;
  }

  /**
   * Set the state to `authority` at `anchorTick` and replay every logged input
   * up to the current local tick. Returns the corrected current state.
   */
  _replayFrom(anchorTick, authority) {
    const wrapBits = this.config.wrapBits;
    let state = this.cloneState(authority);
    state.tick = anchorTick;
    this.history.set(anchorTick, this.cloneState(state));
    if (anchorTick === this.currentTick) {
      this.currentState = state;
      return 0;
    }
    let replayTicks = 0;
    let tick = tickAdd(anchorTick, 1, wrapBits);
    while (true) {
      const input = this.inputLog.get(tick);
      if (!input) {
        throw new PredictionError('PREDICT_STATE', 'replay input missing', { tick, currentTick: this.currentTick });
      }
      const next = this.step(state, input, tick);
      this._validateStepResult(next, tick);
      next.tick = tick;
      state = next;
      this.history.set(tick, this.cloneState(state));
      replayTicks++;
      if (tick === this.currentTick) break;
      tick = tickAdd(tick, 1, wrapBits);
      if (replayTicks > this.config.historyTicks + 1) {
        throw new PredictionError('PREDICT_STATE', 'replay exceeded history window', {
          anchorTick,
          currentTick: this.currentTick
        });
      }
    }
    this.currentState = state;
    return replayTicks;
  }

  _record(record) {
    if (typeof this.config.onReconcile === 'function') this.config.onReconcile(record);
    return record;
  }

  _applySnapshot(snapshot) {
    const { tick, state: authority, flags } = snapshot;
    const wrapBits = this.config.wrapBits;
    const age = tickDelta(tick, this.currentTick, wrapBits);
    const entry = this._findHistoryEntry(tick);
    const previousAnchor = this.lastAnchorTick;
    this.lastAnchorTick = tick;
    if (previousAnchor !== null) {
      const gap = tickDelta(previousAnchor, tick, wrapBits);
      if (gap > 0) {
        this.stats.lastAnchorGapTicks = gap;
        this.stats.maxAnchorGapTicks = Math.max(this.stats.maxAnchorGapTicks, gap);
      }
    }
    this.stats.snapshotsApplied++;

    const reposition = flags.reposition === true || flags.respawn === true || flags.hardSnap === true;
    const wrecked = flags.wrecked === true;

    // Death/wreck: the host froze the body. Park the local prediction at the
    // authoritative pose and stop stepping until the recovery flag arrives.
    // While wrecked every snapshot is a pose refresh, never a replay, because
    // replaying live inputs would move a body the host is holding still.
    if (wrecked) {
      const before = this.renderPose();
      this.wrecked = true;
      this.visual = { position: [0, 0, 0], quaternion: [...IDENTITY_QUAT] };
      this.currentState = this.cloneState(authority);
      this.currentState.tick = this.currentTick;
      this.history.clear();
      this.history.set(this.currentTick, this.cloneState(this.currentState));
      this.stats.wreckSnaps++;
      this.stats.corrections++;
      this.stats.hardSnaps++;
      return this._record({
        applied: true,
        corrected: true,
        severity: 'wreck',
        tick,
        age,
        replayTicks: 0,
        smoothing: false,
        anchorError: { position: 0, angle: 0, speed: 0 },
        visibleCorrection: {
          position: positionDistance(before.position, authority.position),
          angle: quatAngle(before.quaternion, authority.quaternion)
        },
        flags
      });
    }

    // Recovery: replay the local inputs from the recovery pose when the
    // history window still covers the anchor, so the next snapshot has a
    // comparable trajectory. The snap itself is never smoothed.
    const recoveringFromWreck = this.wrecked;
    if (recoveringFromWreck) {
      this.wrecked = false;
      this.visual = { position: [0, 0, 0], quaternion: [...IDENTITY_QUAT] };
      const before = this.renderPose();
      let replayTicks = 0;
      if (this._canReplay(tick)) {
        replayTicks = this._replayFrom(tick, authority);
      } else {
        this.currentState = this.cloneState(authority);
        this.currentState.tick = this.currentTick;
        this.history.clear();
        this.history.set(this.currentTick, this.cloneState(this.currentState));
      }
      this.stats.wreckRecoveries++;
      this.stats.corrections++;
      this.stats.hardSnaps++;
      return this._record({
        applied: true,
        corrected: true,
        severity: 'wreck-recover',
        tick,
        age,
        replayTicks,
        smoothing: false,
        anchorError: { position: 0, angle: 0, speed: 0 },
        visibleCorrection: {
          position: positionDistance(before.position, this.currentState.position),
          angle: quatAngle(before.quaternion, this.currentState.quaternion)
        },
        flags
      });
    }

    if (!entry) {
      return this._resync(snapshot, age, 'stale-anchor');
    }

    const predicted = entry;
    const positionError = positionDistance(predicted.position, authority.position);
    const angleError = quatAngle(predicted.quaternion, authority.quaternion);
    const speedError = Math.abs(predicted.speed - authority.speed);

    if (!reposition && positionError <= this.config.positionEpsilon &&
        angleError <= this.config.angleEpsilon && speedError <= this.config.speedEpsilon) {
      this.stats.cleanAnchors++;
      return this._record({
        applied: true,
        corrected: false,
        severity: 'clean',
        tick,
        age,
        replayTicks: 0,
        smoothing: false,
        anchorError: { position: positionError, angle: angleError, speed: speedError },
        visibleCorrection: { position: 0, angle: 0 },
        flags
      });
    }

    if (!this._canReplay(tick)) {
      return this._resync(snapshot, age, 'missing-input');
    }

    const beforeRender = this.renderPose();
    const replayTicks = this._replayFrom(tick, authority);
    const corrected = this.currentState;
    const visiblePosition = positionDistance(beforeRender.position, corrected.position);
    const visibleAngle = quatAngle(beforeRender.quaternion, corrected.quaternion);

    const longRollback = age > this.config.maxRollbackTicks;
    const tooFar = positionError > this.config.hardSnapDistance || angleError > this.config.hardSnapAngle;
    const smoothingAllowed =
      this.config.smoothing && !reposition && !longRollback && !tooFar;

    if (smoothingAllowed) {
      this.visual.position = [
        beforeRender.position[0] - corrected.position[0],
        beforeRender.position[1] - corrected.position[1],
        beforeRender.position[2] - corrected.position[2]
      ];
      this.visual.quaternion = quatMultiply(
        beforeRender.quaternion,
        quatConjugate(corrected.quaternion)
      );
    } else {
      this.visual = { position: [0, 0, 0], quaternion: [...IDENTITY_QUAT] };
      this.stats.hardSnaps++;
    }

    this.stats.corrections++;
    this.stats.rollbacks++;
    if (longRollback) this.stats.longRollbacks++;
    if (reposition) this.stats.repositionSnaps++;
    this.stats.replayTicksTotal += replayTicks;
    this.stats.replayEvents++;
    this.stats.maxRollbackDepth = Math.max(this.stats.maxRollbackDepth, age);

    const severity = reposition
      ? 'reposition'
      : longRollback
        ? 'long-rollback'
        : tooFar
          ? 'hard-rollback'
          : 'rollback';

    const record = {
      applied: true,
      corrected: true,
      severity,
      tick,
      age,
      replayTicks,
      smoothing: smoothingAllowed,
      anchorError: { position: positionError, angle: angleError, speed: speedError },
      visibleCorrection: { position: visiblePosition, angle: visibleAngle },
      predictedTick: this.currentTick,
      flags
    };
    if (typeof this.config.onHardSnap === 'function' && !smoothingAllowed) {
      this.config.onHardSnap(record);
    }
    return this._record(record);
  }

  /**
   * Unreplayable snapshot: the anchor is older than the 3 s history window or
   * an input is missing. Rebase the timeline on the authoritative state and
   * flag the rewind. This is a visible resync, never a silent extrapolation.
   */
  _resync(snapshot, age, reason) {
    const wrapBits = this.config.wrapBits;
    this.stats.resyncSnaps++;
    if (age > 0) this.stats.clockRewoundTicks += age;
    this.currentTick = snapshot.tick;
    this.currentState = this.cloneState(snapshot.state);
    this.currentState.tick = this.currentTick;
    this.history.clear();
    this.history.set(this.currentTick, this.cloneState(this.currentState));
    for (const tick of this.inputLog.keys()) {
      if (tickDelta(this.currentTick, tick, wrapBits) > 0) this.inputLog.delete(tick);
    }
    this.inputLog.set(this.currentTick, cloneInput({ throttle: 0, brake: 0, steer: 0, handbrake: 0 }));
    this.lastAnchorTick = this.currentTick;
    this.wrecked = snapshot.flags?.wrecked === true;
    this.visual = { position: [0, 0, 0], quaternion: [...IDENTITY_QUAT] };
    this.stats.corrections++;
    this.stats.hardSnaps++;
    this.stats.lastError = { reason, age, tick: snapshot.tick };
    return this._record({
      applied: true,
      corrected: true,
      severity: 'resync',
      reason,
      tick: snapshot.tick,
      age,
      replayTicks: 0,
      smoothing: false,
      anchorError: { position: 0, angle: 0, speed: 0 },
      visibleCorrection: { position: 0, angle: 0 },
      flags: snapshot.flags ?? {}
    });
  }

  _normalizeSnapshot(raw) {
    const source = raw && typeof raw === 'object' && raw.state ? raw.state : raw;
    const tick = raw?.tick ?? source?.tick;
    if (!Number.isInteger(tick) || tick < 0) return { problem: 'snapshot tick must be a non-negative integer' };
    const problem = checkPredictionState(source);
    if (problem) return { problem };
    if (source.tick !== undefined && source.tick !== tick) return { problem: 'snapshot tick/state.tick mismatch' };
    const state = this.cloneState(source);
    state.tick = tick;
    return {
      snapshot: {
        tick,
        state,
        flags: raw?.flags && typeof raw.flags === 'object' ? raw.flags : {},
        lastInputSeq: raw?.lastInputSeq ?? null,
        authority: raw?.authority
      }
    };
  }

  /**
   * Apply one authoritative snapshot. Returns an outcome object; malformed
   * data is reported with `applied:false` and a reason, never thrown, because
   * a network peer is not allowed to crash the local simulator.
   */
  onSnapshot(raw) {
    if (!this.started) throw new PredictionError('PREDICT_NOT_STARTED', 'call start() before onSnapshot()');
    this.stats.snapshotsReceived++;
    const normalized = this._normalizeSnapshot(raw);
    if (normalized.problem) {
      this.stats.invalidSnapshots++;
      return { applied: false, reason: 'invalid', detail: normalized.problem };
    }
    const snapshot = normalized.snapshot;
    if (this.config.requireAuthority && snapshot.authority !== true) {
      this.stats.notAuthoritative++;
      return { applied: false, reason: 'not-authoritative', tick: snapshot.tick };
    }
    const wrapBits = this.config.wrapBits;
    if (this.lastAnchorTick !== null) {
      const delta = tickDelta(this.lastAnchorTick, snapshot.tick, wrapBits);
      if (delta === 0) {
        this.stats.duplicates++;
        return { applied: false, reason: 'duplicate', tick: snapshot.tick };
      }
      if (delta < 0) {
        this.stats.outOfOrder++;
        return { applied: false, reason: 'out-of-order', tick: snapshot.tick };
      }
    }
    if (tickDelta(this.currentTick, snapshot.tick, wrapBits) > 0) {
      if (tickDelta(this.currentTick, snapshot.tick, wrapBits) > this.config.futureWindowTicks) {
        this.stats.futureDropped++;
        return { applied: false, reason: 'far-future', tick: snapshot.tick };
      }
      if (this.pending.size >= this.config.maxPendingSnapshots) {
        const oldest = this.pending.keys().next().value;
        this.pending.delete(oldest);
        this.stats.futureDropped++;
      }
      this.pending.set(snapshot.tick, snapshot);
      this.stats.futureBuffered++;
      return { applied: false, reason: 'future-buffered', tick: snapshot.tick };
    }
    const record = this._applySnapshot(snapshot);
    this._flushPending();
    return { applied: true, record };
  }

  _flushPending() {
    const wrapBits = this.config.wrapBits;
    let progressed = true;
    while (progressed) {
      progressed = false;
      let best = null;
      let bestDelta = -Infinity;
      let bestAge = -Infinity;
      for (const [tick, snapshot] of this.pending) {
        const age = tickDelta(tick, this.currentTick, wrapBits);
        if (age < 0) continue;
        if (this.lastAnchorTick !== null) {
          const delta = tickDelta(this.lastAnchorTick, tick, wrapBits);
          if (delta <= 0) continue;
          if (best === null || delta < bestDelta) {
            best = snapshot;
            bestDelta = delta;
          }
        } else if (best === null || age > bestAge) {
          // No anchor yet: apply the oldest buffered snapshot first.
          best = snapshot;
          bestAge = age;
        }
      }
      if (!best) break;
      this.pending.delete(best.tick);
      this._applySnapshot(best);
      progressed = true;
    }
  }

  /** Copy of the counters, safe to serialize. */
  statsView() {
    return {
      ...this.stats,
      currentTick: this.currentTick,
      anchorAge: this.anchorAge,
      wrecked: this.wrecked,
      pendingSnapshots: this.pending.size,
      historyEntries: this.history.size,
      inputLogEntries: this.inputLog.size
    };
  }
}

export { IDENTITY_QUAT };
