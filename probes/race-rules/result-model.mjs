// ResultModel — ordered race results for 2–4 participants.
//
// Ordering is deterministic and documented:
//   1. finishers first, by finish tick (total race time), then participant id;
//   2. still-racing participants by laps, checkpoints, progress fraction, id;
//   3. DNF participants by the same progress criteria;
//   4. disconnected participants;
//   5. left participants.
// Equal finish ticks (or equal laps/checkpoints/progress) share a position using
// standard competition ranking (1, 2, 2, 4) and are marked `tied: true`.
//
// Only total race time and per-participant best lap are claimed. No retail AMAX
// score, medal, damage or pickup statistic is invented here.

import { hashOf } from './hash.mjs';

export const RESULT_STATUS = Object.freeze({
  FINISHED: 'finished',
  RACING: 'racing',
  DNF: 'dnf',
  DISCONNECTED: 'disconnected',
  LEFT: 'left'
});

const round6 = (value) => Math.round(value * 1e6) / 1e6;

const STATUS_GROUP = Object.freeze({
  [RESULT_STATUS.FINISHED]: 0,
  [RESULT_STATUS.RACING]: 1,
  [RESULT_STATUS.DNF]: 2,
  [RESULT_STATUS.DISCONNECTED]: 3,
  [RESULT_STATUS.LEFT]: 4
});

function resolveStatus(directorRow, progressRow) {
  if (directorRow?.status === 'disconnected') return RESULT_STATUS.DISCONNECTED;
  if (directorRow?.status === 'dnf') return RESULT_STATUS.DNF;
  if (directorRow?.status === 'left') return RESULT_STATUS.LEFT;
  if (directorRow?.status === 'finished' || progressRow?.status === 'finished') {
    return RESULT_STATUS.FINISHED;
  }
  return RESULT_STATUS.RACING;
}

function tieKey(row) {
  if (row.status === RESULT_STATUS.FINISHED) {
    return 'finished|' + String(row.finishTick);
  }
  return row.status + '|' + row.lapsCompleted + '|' + row.checkpointsPassed + '|' +
    Math.round(row.progress * 1e6);
}

function compareRows(a, b) {
  const group = STATUS_GROUP[a.status] - STATUS_GROUP[b.status];
  if (group !== 0) return group;
  if (a.status === RESULT_STATUS.FINISHED) {
    if (a.finishTick !== b.finishTick) return a.finishTick - b.finishTick;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  if (a.lapsCompleted !== b.lapsCompleted) return b.lapsCompleted - a.lapsCompleted;
  if (a.checkpointsPassed !== b.checkpointsPassed) return b.checkpointsPassed - a.checkpointsPassed;
  if (a.progress !== b.progress) return b.progress - a.progress;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class ResultModel {
  constructor(course, options = {}) {
    if (!course) throw new Error('ResultModel needs a CourseModel');
    this.course = course;
    this.options = options;
  }

  /**
   * @param {object} input
   * @param {object} input.director RaceDirector.snapshot()
   * @param {object} input.progress ProgressTracker.snapshot()
   */
  build({ director, progress } = {}) {
    if (!director || !Array.isArray(director.participants)) {
      throw new Error('ResultModel needs a director snapshot');
    }
    if (!progress || !Array.isArray(progress.participants)) {
      throw new Error('ResultModel needs a progress snapshot');
    }
    const progressById = new Map(progress.participants.map((row) => [row.id, row]));
    const rows = director.participants.map((directorRow) => {
      const progressRow = progressById.get(directorRow.id) ?? null;
      const status = resolveStatus(directorRow, progressRow);
      const finishTick = progressRow?.finishTick ?? directorRow.finishTick ?? null;
      const lapTimes = progressRow?.lapTimes ? progressRow.lapTimes.slice() : [];
      let lapsCompleted = progressRow?.lapsCompleted ?? 0;
      // A host-authoritative finish without a progress row (admin finish) still
      // means the sprint distance is complete; do not report zero laps.
      if (status === RESULT_STATUS.FINISHED && this.course.mode === 'sprint' && lapsCompleted === 0) {
        lapsCompleted = 1;
      }
      return {
        id: directorRow.id,
        slot: directorRow.slot,
        status,
        lapsCompleted,
        laps: this.course.laps,
        checkpointsPassed: progressRow?.checkpointsPassed ?? 0,
        totalCheckpoints: progressRow?.totalCheckpoints ?? 0,
        progress: progressRow ? round6(progressRow.progress) : 0,
        progressMetres: progressRow ? round6(progressRow.progressMetres) : 0,
        finishTick,
        totalTimeSeconds: finishTick === null || finishTick === undefined
          ? null : round6(finishTick / this.course.tickHz),
        lapTimes,
        bestLapSeconds: lapTimes.length ? Math.min(...lapTimes) : null,
        lastLapSeconds: lapTimes.length ? lapTimes[lapTimes.length - 1] : null,
        dnfReason: directorRow.dnfReason ?? null,
        tied: false,
        position: null
      };
    }).sort(compareRows);

    let lastKey = null;
    let lastPosition = 0;
    let previousRow = null;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const key = tieKey(row);
      if (key === lastKey) {
        row.position = lastPosition;
        row.tied = true;
        if (previousRow) previousRow.tied = true;
      } else {
        row.position = index + 1;
        lastPosition = row.position;
        lastKey = key;
      }
      previousRow = row;
    }

    const groups = new Map();
    for (const row of rows) {
      const key = String(row.position);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row.id);
    }
    const ties = [...groups.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([position, ids]) => ({ position: Number(position), participants: ids }));

    const fastest = rows
      .filter((row) => row.bestLapSeconds !== null)
      .sort((a, b) => a.bestLapSeconds - b.bestLapSeconds ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;

    const body = {
      schema: 'blur.race-rules.results/1',
      courseId: this.course.courseId,
      mode: this.course.mode,
      laps: this.course.laps,
      tickHz: this.course.tickHz,
      rows,
      order: rows.map((row) => row.id),
      finishers: rows.filter((row) => row.status === RESULT_STATUS.FINISHED).map((row) => row.id),
      racing: rows.filter((row) => row.status === RESULT_STATUS.RACING).map((row) => row.id),
      dnf: rows.filter((row) => row.status === RESULT_STATUS.DNF).map((row) => row.id),
      disconnected: rows.filter((row) => row.status === RESULT_STATUS.DISCONNECTED).map((row) => row.id),
      left: rows.filter((row) => row.status === RESULT_STATUS.LEFT).map((row) => row.id),
      ties,
      fastestLap: fastest ? {
        participantId: fastest.id,
        seconds: fastest.bestLapSeconds
      } : null,
      ordering: 'finished by finishTick; then laps, checkpoints, progress, id; DNF and disconnect after finishers'
    };
    return { ...body, hash: hashOf(body) };
  }
}
