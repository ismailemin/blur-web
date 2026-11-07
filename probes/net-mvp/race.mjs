// Deterministic synthetic race used by both harnesses.
//
// This is NOT the Blur physics step and it is not a retail protocol. It exists
// so the transport/room gate can be exercised with the exact state shape the
// E1 driver already produces ({tick, position, quaternion, speed}) without
// loading game assets or touching probes/e1-drive.
//
// Determinism rules:
//   * motion depends on (seed, slot, car, tick), never on wall clock, player id,
//     room code, arrival order or transport timing;
//   * only IEEE-754 +, -, *, /, % and Math.sqrt are used (no sin/cos/atan2), so
//     Node and Edge produce the same bits;
//   * state values are quantized to 1e-6 before transmission and hashing.
//
// The final hash deliberately covers the race identity (seed, tick) and each
// player's slot/car/pose, but not the random room code, player id or sequence
// number. Two clean runs with the same seed therefore produce the same hash.

import { hashOf } from './hash.mjs';
import { quantizeState, DEFAULT_FINAL_TICK, TICK_HZ, STATE_EVERY_TICKS } from './protocol.mjs';

export { DEFAULT_FINAL_TICK, TICK_HZ, STATE_EVERY_TICKS };

export function finalTickForSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('seconds must be a positive number');
  return Math.round(seconds * TICK_HZ);
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Stable per-(seed, slot, car) parameters. No Math.random, no clock. */
export function carParams(seed, slot, car) {
  const hash = fnv1a(String(seed) + '|' + String(slot) + '|' + String(car));
  return {
    // Lateral lane in metres, separated so remote cars are visually distinct.
    lane: (((hash >>> 0) % 7) - 3) * 1.5,
    // Start line is the E1 sprint spawn area; the synthetic path is straight.
    startX: -88 + ((hash >>> 4) % 5),
    baseSpeed: 22 + ((hash >>> 8) % 7),
    phase: (hash >>> 12) % 997,
    paint: (hash >>> 20) % 360
  };
}

function normalizeQuaternion(x, y, z, w) {
  const length = Math.sqrt(x * x + y * y + z * z + w * w);
  if (!(length > 0)) throw new Error('degenerate quaternion');
  return [x / length, y / length, z / length, w / length];
}

/**
 * Synthetic snapshot at an absolute race tick (1..finalTick). The quaternion is
 * a small yaw-family rotation represented by a normalized (0, s, 0, 1) vector;
 * it is a valid unit quaternion without trigonometric functions.
 */
export function stateAt(seed, slot, car, tick) {
  if (!Number.isInteger(tick) || tick < 0) throw new Error('tick must be a non-negative integer');
  const params = carParams(seed, slot, car);
  const seconds = tick / TICK_HZ;
  const x = params.startX + params.baseSpeed * seconds;
  const z = params.lane + 1.2 * ((((tick * 3 + params.phase) % 200) - 100) / 100);
  const y = 0.35 + 0.05 * ((((tick + params.phase) % 20) - 10) / 10);
  const steer = ((((tick * 2 + params.phase) % 101) - 50) / 100) * 0.35;
  const quaternion = normalizeQuaternion(0, steer, 0, 1);
  const speed = params.baseSpeed + 0.5 * ((((tick * 2 + params.phase) % 20) - 10) / 10);
  return quantizeState({ tick, position: [x, y, z], quaternion, speed });
}

/** Deterministic control pattern in the protocol's input range. */
export function inputAt(seed, slot, tick) {
  const params = carParams(seed, slot, 'input');
  const steer = ((((tick * 5 + params.phase) % 201) - 100) / 100) * 0.35;
  const braking = tick % 300 >= 270;
  return {
    throttle: braking ? 0.25 : 1,
    brake: braking ? 0.4 : 0,
    steer: Math.round(steer * 10000) / 10000,
    handbrake: 0
  };
}

/**
 * Canonical final-state hash shared by every client and both harnesses.
 * players: [{ slot, car, tick, position, quaternion, speed }]
 */
export function finalHash({ seed, tick, players }) {
  if (!Array.isArray(players) || players.length === 0) throw new Error('finalHash needs players');
  const rows = players.map((player) => ({
    slot: player.slot,
    car: player.car,
    tick: player.tick,
    position: player.position,
    quaternion: player.quaternion,
    speed: player.speed
  })).sort((a, b) => a.slot - b.slot);
  for (const row of rows) {
    if (!Number.isInteger(row.slot) || row.slot < 1) throw new Error('player slot must be a positive integer');
    if (row.tick !== tick) throw new Error('player ' + row.slot + ' tick ' + row.tick + ' != final tick ' + tick);
  }
  const slots = new Set(rows.map((row) => row.slot));
  if (slots.size !== rows.length) throw new Error('duplicate player slot in final table');
  return hashOf({ kind: 'blur.net-mvp.final', version: 1, seed, tick, players: rows });
}
