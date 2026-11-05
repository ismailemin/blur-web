// Deterministic ghost / rival replay for the E1 sprint.
//
// A ghost is a *recording of one completed run*, not a second simulation. At the
// finish the page copies the run's own per-tick body pose and wheel angles into a
// compact record; on the next attempt (or from the committed reference trace) the
// same record is replayed through the same per-car mesh. The ghost never steps the
// engine, never collides, never writes a physics value and is never part of the
// packet: `web/packet-consumer.js` draws it with a translucent diagnostic tint as
// an extra draw of the car mesh that is already uploaded.
//
// Record layout (version 1), one sample per engine tick from the settled tick 0
// to the finish tick inclusive:
//
//   position (3 float32) + rotation quaternion (4 float32) +
//   wheel angle (4 float32, corners frontleft/frontright/backleft/backright)
//
// 11 float32 per tick = 44 B/tick, stored as little-endian base64. The body
// matrix is rebuilt from the quaternion and the translation; the wheel matrices
// are rebuilt exactly like `packet-adapter.js` does it (body x rest x Rx(angle)),
// with the rest pose read from the committed car manifest in `geometry.json`.
//
// The record's canonical hash covers every field except `hash` itself, so two
// derivations of the same run hash identically in the browser and in Node, and a
// stored ghost whose hash does not re-compute is rejected rather than replayed.
//
// Limits (also in the packet/README): a replay, not an AI; one ghost; no
// collision; the ghost of a run with a respawn is never recorded because its
// engine tick axis restarts. The page stores the fastest clean run per car and
// per course, and falls back to a committed deterministic reference trace when
// the user has not finished yet.

import { hashOf } from './packet-hash.js';
import { TICK_HZ } from './drive-script.js';
import { multiplyMat4, rotationXMatrix } from './packet-adapter.js';

export const GHOST_KIND = 'e1-drive.ghost-replay';
export const GHOST_VERSION = 1;
export const GHOST_STORE_KIND = 'e1-drive.sprint-ghost-store';
export const GHOST_INDEX_KIND = 'e1-drive.ghost-index';
export const GHOST_KEY_PREFIX = 'e1-drive.sprint.ghost.v1.';
export const GHOST_CORNERS = Object.freeze(['frontleft', 'frontright', 'backleft', 'backright']);
export const GHOST_FLOATS = 11;
export const GHOST_ENCODING = 'float32le-base64';
export const GHOST_COMPONENTS =
  'position3 + rotationQuaternion4 + wheelAngle4 (frontleft, frontright, backleft, backright)';
export const GHOST_SOURCE = Object.freeze({
  BEST: 'best-run',
  REFERENCE: 'reference-trace'
});

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 without btoa/Buffer so the same code runs in the page and in Node. */
export function bytesToBase64(bytes) {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += B64_ALPHABET[(triple >> 18) & 63] + B64_ALPHABET[(triple >> 12) & 63];
    out += index + 1 < bytes.length ? B64_ALPHABET[(triple >> 6) & 63] : '=';
    out += index + 2 < bytes.length ? B64_ALPHABET[triple & 63] : '=';
  }
  return out;
}

export function base64ToBytes(text) {
  if (typeof text !== 'string' || text.length % 4 !== 0) throw new Error('ghost sample is not base64');
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < text.length; index += 4) {
    const values = [0, 0, 0, 0];
    for (let slot = 0; slot < 4; slot++) {
      const char = text[index + slot];
      if (char === '=') { values[slot] = 0; continue; }
      const value = B64_ALPHABET.indexOf(char);
      if (value < 0) throw new Error('ghost sample has a non-base64 character');
      values[slot] = value;
    }
    const triple = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
    if (offset < bytes.length) bytes[offset++] = (triple >> 16) & 0xff;
    if (offset < bytes.length) bytes[offset++] = (triple >> 8) & 0xff;
    if (offset < bytes.length) bytes[offset++] = triple & 0xff;
  }
  return bytes;
}

/** Rotation quaternion (x, y, z, w) from the engine's three body axes (matrix columns). */
export function quaternionFromAxes(axisX, axisY, axisZ) {
  // R[row][column]: column 0 is axisX, column 1 is axisY, column 2 is axisZ.
  const m00 = axisX[0], m10 = axisX[1], m20 = axisX[2];
  const m01 = axisY[0], m11 = axisY[1], m21 = axisY[2];
  const m02 = axisZ[0], m12 = axisZ[1], m22 = axisZ[2];
  const trace = m00 + m11 + m22;
  let x;
  let y;
  let z;
  let w;
  if (trace > 0) {
    const scale = Math.sqrt(trace + 1) * 2;
    w = 0.25 * scale;
    x = (m21 - m12) / scale;
    y = (m02 - m20) / scale;
    z = (m10 - m01) / scale;
  } else if (m00 > m11 && m00 > m22) {
    const scale = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / scale;
    x = 0.25 * scale;
    y = (m01 + m10) / scale;
    z = (m02 + m20) / scale;
  } else if (m11 > m22) {
    const scale = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / scale;
    x = (m01 + m10) / scale;
    y = 0.25 * scale;
    z = (m12 + m21) / scale;
  } else {
    const scale = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / scale;
    x = (m02 + m20) / scale;
    y = (m12 + m21) / scale;
    z = 0.25 * scale;
  }
  const length = Math.hypot(x, y, z, w) || 1;
  return [x / length, y / length, z / length, w / length];
}

/** Column-major rigid matrix from a unit quaternion and a translation. */
export function matrixFromQuaternion(quaternion, position) {
  const [x, y, z, w] = quaternion;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  // Columns of R (column-major storage), matching the engine's axis convention.
  return [
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    position[0], position[1], position[2], 1
  ];
}

function writeFloat32Array(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index++) view.setFloat32(index * 4, values[index], true);
  return bytes;
}

function readFloat32Array(text) {
  const bytes = base64ToBytes(text);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float64Array(bytes.length / 4);
  for (let index = 0; index < values.length; index++) values[index] = view.getFloat32(index * 4, true);
  return values;
}

/** Canonical hash of a ghost record (everything except the `hash` member). */
export function ghostHash(record) {
  const body = { ...record };
  delete body.hash;
  return hashOf(body);
}

/**
 * Build the ghost record of one completed run.
 *
 * `run` is read-only:
 *   car, course ('310m'|'short'), courseId, layoutHash, countdownTicks,
 *   finishTick, timeSeconds, stateSequenceHash,
 *   updates (packet v1.1 updates of the run) and wheelAnglesByTick
 *   (session.wheelAnglesByTick, one entry per tick).
 */
export function ghostFromRun(run) {
  if (!run || typeof run.car !== 'string' || !run.car) throw new Error('ghost needs a car slug');
  if (run.course !== '310m' && run.course !== 'short') throw new Error('ghost course must be 310m or short');
  if (!Number.isInteger(run.finishTick) || run.finishTick < 1) throw new Error('ghost needs a positive finish tick');
  if (!Number.isFinite(run.timeSeconds) || run.timeSeconds <= 0) throw new Error('ghost needs a finish time');
  if (!Array.isArray(run.updates) || run.updates.length < run.finishTick + 1) {
    throw new Error('ghost needs the completed run updates (tick 0 .. finish)');
  }
  if (!Array.isArray(run.wheelAnglesByTick)) throw new Error('ghost needs the per-tick wheel angles');
  const byTick = new Map(run.updates.map((update) => [update.tick, update]));
  const anglesByTick = new Map(run.wheelAnglesByTick.map((entry) => [entry.tick, entry.angles]));
  const tickCount = run.finishTick + 1;
  const samples = new Float32Array(tickCount * GHOST_FLOATS);
  for (let tick = 0; tick < tickCount; tick++) {
    const update = byTick.get(tick);
    if (!update) throw new Error('ghost run has no packet update for tick ' + tick);
    const bodyEntry = update.matrices.find((entry) => entry.nodeId === 'e1.car.body');
    if (!bodyEntry) throw new Error('ghost run has no body matrix at tick ' + tick);
    const world = bodyEntry.world;
    const quaternion = quaternionFromAxes(
      [world[0], world[1], world[2]],
      [world[4], world[5], world[6]],
      [world[8], world[9], world[10]]
    );
    const angles = anglesByTick.get(tick);
    if (!angles) throw new Error('ghost run has no wheel angles for tick ' + tick);
    const base = tick * GHOST_FLOATS;
    samples[base] = world[12];
    samples[base + 1] = world[13];
    samples[base + 2] = world[14];
    samples[base + 3] = quaternion[0];
    samples[base + 4] = quaternion[1];
    samples[base + 5] = quaternion[2];
    samples[base + 6] = quaternion[3];
    for (let corner = 0; corner < GHOST_CORNERS.length; corner++) {
      const angle = angles[GHOST_CORNERS[corner]];
      if (!Number.isFinite(angle)) throw new Error('ghost run has a non-finite wheel angle at tick ' + tick);
      samples[base + 7 + corner] = angle;
    }
  }
  const record = {
    kind: GHOST_KIND,
    version: GHOST_VERSION,
    car: run.car,
    course: run.course,
    courseId: run.courseId ?? null,
    layoutHash: run.layoutHash ?? null,
    source: run.source === GHOST_SOURCE.REFERENCE ? GHOST_SOURCE.REFERENCE : GHOST_SOURCE.BEST,
    sourceLabel: typeof run.sourceLabel === 'string' && run.sourceLabel
      ? run.sourceLabel
      : run.source === GHOST_SOURCE.REFERENCE
        ? 'reference ghost - committed deterministic sprint trace'
        : 'your best run (' + run.timeSeconds.toFixed(3) + ' s)',
    tickHz: TICK_HZ,
    countdownTicks: Number.isInteger(run.countdownTicks) ? run.countdownTicks : 0,
    finishTick: run.finishTick,
    timeSeconds: run.timeSeconds,
    tickCount,
    stateSequenceHash: run.stateSequenceHash ?? null,
    sample: {
      encoding: GHOST_ENCODING,
      stride: GHOST_FLOATS,
      components: GHOST_COMPONENTS,
      data: bytesToBase64(writeFloat32Array(samples))
    }
  };
  record.hash = ghostHash(record);
  return record;
}

/** Structural + hash validation. Returns all problems instead of throwing. */
export function validateGhostRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object') return { ok: false, errors: ['not an object'] };
  if (record.kind !== GHOST_KIND) errors.push('kind is not ' + GHOST_KIND);
  if (record.version !== GHOST_VERSION) errors.push('version is not ' + GHOST_VERSION);
  if (typeof record.car !== 'string' || !record.car) errors.push('missing car');
  if (record.course !== '310m' && record.course !== 'short') errors.push('course is not 310m/short');
  if (record.tickHz !== TICK_HZ) errors.push('tickHz is not ' + TICK_HZ);
  if (!Number.isInteger(record.tickCount) || record.tickCount < 2) errors.push('bad tickCount');
  if (record.finishTick !== record.tickCount - 1) errors.push('finishTick is not tickCount - 1');
  if (!Number.isFinite(record.timeSeconds) || record.timeSeconds <= 0) errors.push('bad timeSeconds');
  if (!Number.isInteger(record.countdownTicks) || record.countdownTicks < 0) errors.push('bad countdownTicks');
  if (!record.sample || typeof record.sample !== 'object') {
    errors.push('missing sample');
  } else {
    if (record.sample.encoding !== GHOST_ENCODING) errors.push('bad sample encoding');
    if (record.sample.stride !== GHOST_FLOATS) errors.push('bad sample stride');
    if (typeof record.sample.data !== 'string') {
      errors.push('missing sample data');
    } else {
      const expected = record.tickCount * GHOST_FLOATS * 4;
      const bytes = base64ToBytes(record.sample.data);
      if (bytes.length !== expected) errors.push('sample bytes ' + bytes.length + ' != ' + expected);
    }
  }
  if (typeof record.hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record.hash)) {
    errors.push('missing hash');
  } else if (ghostHash(record) !== record.hash) {
    errors.push('hash does not re-compute');
  }
  return { ok: errors.length === 0, errors };
}

/** Decode a validated record into a flat Float64Array of per-tick samples. */
export function decodeGhost(record) {
  const checked = validateGhostRecord(record);
  if (!checked.ok) throw new Error('ghost record rejected: ' + checked.errors.join('; '));
  return {
    record,
    tickCount: record.tickCount,
    values: readFloat32Array(record.sample.data)
  };
}

function sampleAt(decoded, tick) {
  const last = decoded.tickCount - 1;
  const clamped = Math.max(0, Math.min(last, tick));
  const floor = Math.floor(clamped);
  const ceil = Math.min(floor + 1, last);
  const f = clamped - floor;
  const a = floor * GHOST_FLOATS;
  const b = ceil * GHOST_FLOATS;
  const values = decoded.values;
  const position = [
    values[a] + (values[b] - values[a]) * f,
    values[a + 1] + (values[b + 1] - values[a + 1]) * f,
    values[a + 2] + (values[b + 2] - values[a + 2]) * f
  ];
  // nlerp with hemisphere correction: deterministic and stable for small steps.
  let q0 = [values[a + 3], values[a + 4], values[a + 5], values[a + 6]];
  let q1 = [values[b + 3], values[b + 4], values[b + 5], values[b + 6]];
  const dot = q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3];
  if (dot < 0) q1 = q1.map((value) => -value);
  const quaternion = [0, 0, 0, 0].map((_, index) => q0[index] + (q1[index] - q0[index]) * f);
  const length = Math.hypot(quaternion[0], quaternion[1], quaternion[2], quaternion[3]) || 1;
  for (let index = 0; index < 4; index++) quaternion[index] /= length;
  const wheelAngles = {};
  for (let corner = 0; corner < GHOST_CORNERS.length; corner++) {
    const value = values[a + 7 + corner];
    wheelAngles[GHOST_CORNERS[corner]] = value + (values[b + 7 + corner] - value) * f;
  }
  return { tick: clamped, position, quaternion, wheelAngles };
}

/** Sampled ghost pose at a (fractional) engine tick. */
export function ghostPoseAt(decoded, tick) {
  return sampleAt(decoded, tick);
}

/**
 * Node matrices for one ghost frame, composed exactly like the adapter composes
 * the live car. `wheelRest` maps corner -> manifest rest matrix (column-major).
 */
export function ghostMatrices(decoded, tick, wheelRest) {
  const pose = sampleAt(decoded, tick);
  const body = matrixFromQuaternion(pose.quaternion, pose.position);
  const wheels = {};
  for (const corner of GHOST_CORNERS) {
    const rest = wheelRest[corner];
    if (!rest) throw new Error('ghost has no rest matrix for wheel ' + corner);
    const stationary = multiplyMat4(body, rest);
    wheels[corner] = {
      spin: multiplyMat4(stationary, rotationXMatrix(pose.wheelAngles[corner])),
      static: stationary
    };
  }
  return { pose, body, wheels };
}

/**
 * Arc/time table of a ghost for the HUD delta. `progressOf(position)` maps a
 * recorded position to the course's progress axis (measured arc on the 310 m
 * course, straight x on the 29 m regression course). The ghost's race time is 0
 * during the countdown and `(tick - countdownTicks) / tickHz` after it, so it
 * shares the page's timer axis.
 */
export function buildGhostArcTable(decoded, progressOf) {
  if (typeof progressOf !== 'function') throw new Error('ghost delta needs a course progress function');
  const record = decoded.record;
  const arcs = new Float64Array(decoded.tickCount);
  const seconds = new Float64Array(decoded.tickCount);
  // Progress is a race axis: the running maximum makes a lateral projection
  // wobble unable to rewind the ghost, so the time-at-arc lookup is monotone.
  let previous = -Infinity;
  for (let tick = 0; tick < decoded.tickCount; tick++) {
    const base = tick * GHOST_FLOATS;
    const values = decoded.values;
    const position = [values[base], values[base + 1], values[base + 2]];
    const raw = progressOf(position);
    if (!Number.isFinite(raw)) throw new Error('ghost progress is not finite at tick ' + tick);
    const arc = raw > previous ? raw : previous;
    previous = arc;
    arcs[tick] = arc;
    seconds[tick] = Math.max(0, (tick - record.countdownTicks) / record.tickHz);
  }
  return { record, arcs, seconds, tickCount: decoded.tickCount };
}

/** Ghost race time when it first reached `arc` (linear between recorded ticks). */
export function ghostSecondsAtArc(table, arc) {
  const { arcs, seconds } = table;
  const last = table.tickCount - 1;
  if (!(arc > arcs[0])) return { seconds: seconds[0], tick: 0 };
  for (let index = 1; index < table.tickCount; index++) {
    if (arcs[index] >= arc) {
      const span = arcs[index] - arcs[index - 1];
      const f = span > 0 ? Math.max(0, Math.min(1, (arc - arcs[index - 1]) / span)) : 0;
      return { seconds: seconds[index - 1] + (seconds[index] - seconds[index - 1]) * f, tick: index - 1 + f };
    }
  }
  return { seconds: seconds[last], tick: last };
}

/** Ghost arc at a race time (linear between recorded ticks). */
export function ghostArcAtSeconds(table, raceSeconds) {
  const { arcs, seconds } = table;
  const last = table.tickCount - 1;
  if (!(raceSeconds > seconds[0])) return { arc: arcs[0], tick: 0 };
  for (let index = 1; index < table.tickCount; index++) {
    if (seconds[index] >= raceSeconds) {
      const span = seconds[index] - seconds[index - 1];
      const f = span > 0 ? Math.max(0, Math.min(1, (raceSeconds - seconds[index - 1]) / span)) : 0;
      return { arc: arcs[index - 1] + (arcs[index] - arcs[index - 1]) * f, tick: index - 1 + f };
    }
  }
  return { arc: arcs[last], tick: last };
}

/**
 * Gap to the ghost at the player's own progress. Both numbers are "what the
 * player still has to make up": positive = the player is behind.
 *
 *   seconds  player race time - ghost race time at the player's arc
 *   metres   ghost arc at the player's race time - player arc
 */
export function ghostGap(table, player) {
  if (!Number.isFinite(player?.arc) || !Number.isFinite(player?.seconds)) {
    throw new Error('ghost gap needs the player arc and race seconds');
  }
  const atArc = ghostSecondsAtArc(table, player.arc);
  const atTime = ghostArcAtSeconds(table, player.seconds);
  return {
    seconds: player.seconds - atArc.seconds,
    metres: atTime.arc - player.arc,
    ghostSecondsAtPlayerArc: atArc.seconds,
    ghostArcAtPlayerTime: atTime.arc
  };
}

/** Deterministic committed-reference file name for a car and course. */
export function referenceGhostFileName(slug, course) {
  return slug + '-' + course + '.json';
}

/**
 * localStorage-shaped ghost store: the fastest clean run per car, one key per
 * course. Malformed or unverifiable records are dropped instead of replayed.
 */
export function createGhostStore(storage, course, options = {}) {
  const key = GHOST_KEY_PREFIX + course;
  let persistent = Boolean(storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function');
  let lastError = null;
  const empty = () => ({ kind: GHOST_STORE_KIND, version: 1, course, cars: {} });

  function read() {
    if (!persistent) return empty();
    try {
      const raw = storage.getItem(key);
      if (!raw) return empty();
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.kind !== GHOST_STORE_KIND || parsed.version !== 1 ||
          parsed.course !== course || !parsed.cars || typeof parsed.cars !== 'object' || Array.isArray(parsed.cars)) {
        return empty();
      }
      const cars = {};
      for (const [slug, record] of Object.entries(parsed.cars)) {
        if (validateGhostRecord(record).ok && record.car === slug && record.course === course) cars[slug] = record;
        else lastError = 'dropped a stored ghost for ' + slug + ' (invalid record or wrong course)';
      }
      return { kind: GHOST_STORE_KIND, version: 1, course, cars };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      return empty();
    }
  }

  function write(store) {
    if (!persistent) return false;
    try {
      storage.setItem(key, JSON.stringify(store));
      return true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      persistent = false;
      return false;
    }
  }

  return {
    key,
    course,
    get persistent() { return persistent; },
    get lastError() { return lastError; },
    read,
    get(slug) {
      return read().cars[slug] ?? null;
    },
    bestSecondsFor(slug) {
      return read().cars[slug]?.timeSeconds ?? null;
    },
    /**
     * Store a ghost only when it is faster than the stored one (a slower run
     * never replaces the ghost of a better run).
     */
    submit(slug, record) {
      const checked = validateGhostRecord(record);
      if (!checked.ok) throw new Error('ghost store rejected the record: ' + checked.errors.join('; '));
      if (record.car !== slug) throw new Error('ghost store key ' + slug + ' got a record for ' + record.car);
      if (record.course !== course) throw new Error('ghost store course ' + course + ' got a ' + record.course + ' record');
      if (options.layoutHash && record.layoutHash && record.layoutHash !== options.layoutHash) {
        throw new Error('ghost was recorded on layout ' + record.layoutHash + ', not ' + options.layoutHash);
      }
      const store = read();
      const previous = store.cars[slug] ?? null;
      const improved = previous === null || record.timeSeconds < previous.timeSeconds;
      if (improved) {
        store.cars[slug] = record;
        write(store);
      }
      return {
        stored: improved,
        improved,
        previousSeconds: previous ? previous.timeSeconds : null,
        seconds: record.timeSeconds,
        persistent
      };
    },
    clear(slug) {
      const store = read();
      if (!(slug in store.cars)) return false;
      delete store.cars[slug];
      return write(store);
    }
  };
}
