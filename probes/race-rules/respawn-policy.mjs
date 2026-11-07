// RespawnPolicy — decides whether a participant must be rebuilt on the course
// and where. This is a post-hoc rules decision, not a collision barrier: it
// never blocks motion and never adds an invisible wall. The caller applies the
// returned target to the engine rebuild and then calls ProgressTracker.rejoin.
//
// Reasons are explicit and ordered: off-course, below-ground, airborne. The
// thresholds come from the committed layout's declared respawn rule; overrides
// are labelled with their provenance so a tuned value is never presented as a
// recovered retail value.

export const RESPAWN_REASON = Object.freeze({
  OFF_COURSE: 'off-course',
  BELOW_GROUND: 'below-ground',
  AIRBORNE: 'airborne',
  INVALID_STATE: 'invalid-state'
});

/** Fallback values only if a layout omits its declared respawn block. */
export const RESPAWN_DEFAULTS = Object.freeze({
  enabled: true,
  fallBelowGroundMetres: 1.0,
  airborneTicks: 30,
  outsideBandMarginMetres: 0.0,
  overshootMarginMetres: 0.0,
  source: 'layout-declared'
});

const round6 = (value) => Math.round(value * 1e6) / 1e6;

export class RespawnPolicy {
  /**
   * @param {import('./course-model.mjs').CourseModel} course
   * @param {object} options overrides; `enabled:false` disables respawn checks
   */
  constructor(course, options = {}) {
    if (!course) throw new Error('RespawnPolicy needs a CourseModel');
    const declared = course.respawnConfig ?? {};
    this.course = course;
    this.config = Object.freeze({
      enabled: options.enabled !== undefined ? Boolean(options.enabled) : RESPAWN_DEFAULTS.enabled,
      fallBelowGroundMetres: options.fallBelowGroundMetres ??
        declared.fallBelowGroundMetres ?? RESPAWN_DEFAULTS.fallBelowGroundMetres,
      airborneTicks: options.airborneTicks ??
        declared.airborneTicks ?? RESPAWN_DEFAULTS.airborneTicks,
      outsideBandMarginMetres: options.outsideBandMarginMetres ??
        declared.outsideBandMarginMetres ?? RESPAWN_DEFAULTS.outsideBandMarginMetres,
      overshootMarginMetres: options.overshootMarginMetres ??
        declared.overshootMarginMetres ?? RESPAWN_DEFAULTS.overshootMarginMetres,
      source: options.source ?? (course.courseId === 'lap' ? 'layout-declared' : 'layout-declared')
    });
    if (!(this.config.fallBelowGroundMetres >= 0)) {
      throw new Error('RespawnPolicy: fallBelowGroundMetres must be >= 0');
    }
    if (!Number.isInteger(this.config.airborneTicks) || this.config.airborneTicks < 1) {
      throw new Error('RespawnPolicy: airborneTicks must be a positive integer');
    }
  }

  /** Specific off-course detail, or null when the position is inside the band. */
  offCourseDetail(position, projection) {
    const course = this.course;
    const margin = this.config.outsideBandMarginMetres;
    if (course.mode === 'sprint') {
      const overshoot = this.config.overshootMarginMetres;
      if (projection.arc < -overshoot) {
        return {
          detail: 'behind-start',
          arc: projection.arc,
          limit: -overshoot
        };
      }
      if (projection.arc > course.finishArc + overshoot) {
        return {
          detail: 'past-finish-line',
          arc: projection.arc,
          limit: round6(course.finishArc + overshoot)
        };
      }
    }
    const halfWidth = course.corridorHalfWidthMetres;
    if (halfWidth !== null && projection.lateral > halfWidth + margin) {
      return {
        detail: 'outside-corridor',
        arc: projection.arc,
        lateralMetres: projection.lateral,
        limitMetres: round6(halfWidth + margin)
      };
    }
    return null;
  }

  /**
   * Evaluate one observed state.
   *
   * @param {object} input
   * @param {number[]} input.position [x, y, z]
   * @param {object} input.projection CourseModel.project(position) result
   * @param {number} [input.groundY] local measured ground
   * @param {number} [input.airborneTicks] consecutive airborne ticks
   * @returns {{respawn:boolean, reasons:object[], reasonNames:string[]}}
   */
  evaluate(input) {
    if (!this.config.enabled) return { respawn: false, reasons: [], reasonNames: [] };
    const position = input?.position;
    const projection = input?.projection;
    if (!Array.isArray(position) || position.length < 3 ||
        !Number.isFinite(position[0]) || !Number.isFinite(position[1]) || !Number.isFinite(position[2])) {
      return {
        respawn: true,
        reasons: [{ reason: RESPAWN_REASON.INVALID_STATE, detail: 'non-finite position' }],
        reasonNames: [RESPAWN_REASON.INVALID_STATE]
      };
    }
    if (!projection) throw new Error('RespawnPolicy.evaluate needs a course projection');
    const reasons = [];
    const offCourse = this.offCourseDetail(position, projection);
    if (offCourse) reasons.push({ reason: RESPAWN_REASON.OFF_COURSE, ...offCourse });
    const groundY = input.groundY ?? projection.groundY ?? this.course.groundAtArc(projection.arc);
    if (position[1] < groundY - this.config.fallBelowGroundMetres) {
      reasons.push({
        reason: RESPAWN_REASON.BELOW_GROUND,
        groundY: round6(groundY),
        belowByMetres: round6(groundY - position[1]),
        limitMetres: this.config.fallBelowGroundMetres
      });
    }
    const airborneTicks = input.airborneTicks ?? 0;
    if (airborneTicks >= this.config.airborneTicks) {
      reasons.push({
        reason: RESPAWN_REASON.AIRBORNE,
        airborneTicks,
        limitTicks: this.config.airborneTicks
      });
    }
    return {
      respawn: reasons.length > 0,
      reasons,
      reasonNames: reasons.map((entry) => entry.reason)
    };
  }

  /** Target checkpoint/line for the last passed gate. */
  targetFor({ lastGateIndex = 0 } = {}) {
    return {
      ...this.course.respawnTargetForGate(lastGateIndex),
      policy: 'post-hoc respawn target; motion is never blocked (no invisible walls)',
      source: this.config.source
    };
  }

  toJSON() {
    return {
      reasonOrder: [RESPAWN_REASON.OFF_COURSE, RESPAWN_REASON.BELOW_GROUND, RESPAWN_REASON.AIRBORNE],
      config: { ...this.config },
      noInvisibleWalls: true,
      targetRule: this.course.mode === 'lap'
        ? 'the start/finish line of the current lap'
        : 'the gate point of the last passed checkpoint (the start line before the first checkpoint)'
    };
  }
}
