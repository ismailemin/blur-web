// Fixed-step driver for the render-packet consumer.
//
// This is a faithful JavaScript port of probes/scheduler-probe/src/fixed_step.cpp,
// which is the project's reference implementation of
// docs/work/analysis/t005-scheduler-design.md §4.3:
//
//   accumulator in integer microseconds -> floor(accum / (1/60)) ticks,
//   capped at 4 per frame, leftover kept, backlog above one tick dropped
//   (ApplicationPC.cpp:508-529), and a delta above 250 ms treated as a pause.
//
// Integer microseconds, not floats: the accumulator is an exact rational
// remainder so a node test can compare frame-by-frame against the native probe's
// recorded deltas with no tolerance.
//
// Imported by web/app.js (browser) and tools/verify_tick_loop.mjs (node).

export const FLAG = Object.freeze({
  TICK: 1 << 0,          // at least one simulation tick ran
  ZERO_TICK: 1 << 1,     // no simulation tick ran
  CAPPED: 1 << 2,        // requested ticks exceeded maxTicksPerFrame
  BACKLOG_DROP: 1 << 3,  // post-cap clamp cleared the accumulator
  PAUSED: 1 << 4,        // delta exceeded pauseThresholdUs; accumulator dropped
  DT_REWIND: 1 << 5,     // negative delta; treated as zero
  DELTA_ZERO: 1 << 6,    // delta was exactly zero
  BASELINE: 1 << 7       // first sample: baseline established, no delta consumed
});

export const DEFAULT_CONFIG = Object.freeze({
  stepHz: 60,
  usPerSecond: 1000000,
  maxTicksPerFrame: 4,
  pauseThresholdUs: 250000,
  dropBacklog: true
});

export class FixedStepDriver {
  constructor(config = {}) {
    this.stepHz = config.stepHz ?? DEFAULT_CONFIG.stepHz;
    this.usPerSecond = config.usPerSecond ?? DEFAULT_CONFIG.usPerSecond;
    this.maxTicksPerFrame = config.maxTicksPerFrame ?? DEFAULT_CONFIG.maxTicksPerFrame;
    this.pauseThresholdUs = config.pauseThresholdUs ?? DEFAULT_CONFIG.pauseThresholdUs;
    this.dropBacklog = config.dropBacklog ?? DEFAULT_CONFIG.dropBacklog;
    if (!(this.stepHz > 0 && this.stepHz <= 1000)) throw new Error('stepHz must be in (0, 1000]');
    if (!(this.usPerSecond > 0)) throw new Error('usPerSecond must be positive');
    if (!(this.maxTicksPerFrame >= 1)) throw new Error('maxTicksPerFrame must be at least 1');
    if (!(this.pauseThresholdUs >= 0)) throw new Error('pauseThresholdUs must be non-negative');
    this.accUnits = 0;
    this.lastTimestampUs = 0;
    this.framesAdvanced = 0;
    this.hasBaseline = false;
    this.totals = { ticks: 0, requested: 0, cappedFrames: 0, pausedFrames: 0, zeroTickFrames: 0, backlogDropFrames: 0 };
  }

  /** Accumulator units per microsecond; one tick is `usPerSecond` units. */
  auPerUs() { return this.stepHz; }

  /** Accumulator units per simulation tick. */
  auPerStep() { return this.usPerSecond; }

  reset(nowUs) {
    this.accUnits = 0;
    this.lastTimestampUs = nowUs;
    this.framesAdvanced = 0;
    this.hasBaseline = true;
  }

  /** Monotonic timestamp entry point. The first call only establishes a baseline. */
  advanceTo(nowUs) {
    if (!this.hasBaseline) {
      this.hasBaseline = true;
      this.lastTimestampUs = nowUs;
      this.accUnits = 0;
      this.framesAdvanced++;
      return {
        dtUs: 0,
        requestedTicks: 0,
        ticks: 0,
        accUnits: 0,
        droppedUnits: 0,
        droppedTicks: 0,
        flags: FLAG.BASELINE | FLAG.DELTA_ZERO | FLAG.ZERO_TICK
      };
    }
    const dtUs = nowUs - this.lastTimestampUs;
    this.lastTimestampUs = nowUs;
    return this.step(dtUs);
  }

  /** Explicit-delta entry point for deterministic traces. */
  advanceBy(dtUs) {
    return this.step(dtUs);
  }

  step(dtUs) {
    const sample = { dtUs: 0, requestedTicks: 0, ticks: 0, accUnits: 0, droppedUnits: 0, droppedTicks: 0, flags: 0 };
    let effectiveDtUs = dtUs;
    if (effectiveDtUs < 0) {
      sample.flags |= FLAG.DT_REWIND;
      effectiveDtUs = 0;
    }
    if (effectiveDtUs === 0) sample.flags |= FLAG.DELTA_ZERO;
    sample.dtUs = effectiveDtUs;

    if (effectiveDtUs > this.pauseThresholdUs) {
      // Tab throttled, devtools paused or a stalled frame: a pause, not a
      // fast-forward. The delta is discarded entirely.
      sample.flags |= FLAG.PAUSED;
      this.accUnits = 0;
      this.totals.pausedFrames++;
    } else {
      this.accUnits += effectiveDtUs * this.auPerUs();
    }

    const stepUnits = this.auPerStep();
    sample.requestedTicks = Math.floor(this.accUnits / stepUnits);
    let ticks = sample.requestedTicks;
    if (ticks > this.maxTicksPerFrame) {
      ticks = this.maxTicksPerFrame;
      sample.flags |= FLAG.CAPPED;
      this.totals.cappedFrames++;
    }

    if (ticks > 0) {
      this.accUnits -= ticks * stepUnits;
      if (this.dropBacklog && this.accUnits >= stepUnits) {
        // ApplicationPC.cpp:521-522: without this clamp a display slower than
        // 15 Hz accumulates a permanent backlog.
        sample.droppedUnits = this.accUnits;
        sample.droppedTicks = Math.floor(this.accUnits / stepUnits);
        this.accUnits = 0;
        sample.flags |= FLAG.BACKLOG_DROP;
        this.totals.backlogDropFrames++;
      }
      sample.flags |= FLAG.TICK;
    } else {
      sample.flags |= FLAG.ZERO_TICK;
      this.totals.zeroTickFrames++;
    }

    if (this.accUnits < 0) throw new Error('accumulator went negative');
    sample.ticks = ticks;
    sample.accUnits = this.accUnits;
    this.framesAdvanced++;
    this.totals.ticks += ticks;
    this.totals.requested += sample.requestedTicks;
    return sample;
  }

  /** Interpolation factor in [0, 1] as an exact fraction of one tick. */
  alpha(sample) {
    const denominator = this.auPerStep();
    const numerator = Math.min(sample.accUnits, denominator);
    return { numerator, denominator, value: denominator > 0 ? numerator / denominator : 0 };
  }

  /** Interpolation factor clamped to [0, 1] from the current accumulator. */
  currentAlpha() {
    const denominator = this.auPerStep();
    return denominator > 0 ? Math.min(1, Math.max(0, this.accUnits / denominator)) : 0;
  }
}
