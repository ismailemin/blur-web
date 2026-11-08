// Deterministic, compact, seekable race replay for the Blur web probe.
//
// A replay records every car that took part in one race, not one ghost:
// 20 Hz transformed snapshots, optional wheel/steer/health/shield channels and
// a tick-stamped event stream (pickup, hit, wreck, respawn, lap, finish),
// followed by the shared result. It consumes the same snapshot shape the
// multiplayer host already emits:
//
//   { tick, position:[x,y,z], quaternion:[x,y,z,w], speed }
//   { tick, cars:[{ id, tick, position, quaternion, speed }] }   // host N-slot
//
// This probe does not step an engine and does not modify e1-drive. The
// recorder is fed by the host, and the player rebuilds the recorded samples.
//
// ---------------------------------------------------------------------------
// Format (version 1)
// ---------------------------------------------------------------------------
// The file is a JSON object. Metadata, hashes, events and the result are JSON;
// the sample stream is one base64 blob. All integers are little-endian varints
// of the zig-zag form (unsigned LEB128 over a signed mapping).
//
// Header fields:
//   kind, version, schema, generator
//   tickHz, engineTickHz, firstTick, lastTick, sampleCount
//   hashes { build, map, layout, physics, cars:{ id: hash } }
//   participants [{ id, slot, car, carHash, channels, sampleCount }]
//   result { rows[], winnerId, ... }        shared race result
//   events [{ tick, type, participantId, ... }]  sorted by tick
//   quantisation { channel: { scale, maxError } }
//   encoding { bodyEncoding, indexBlockSamples, bodyBytes, sampleBytes,
//              indexBytes, bodyBase64Bytes }
//   body: base64 sample stream
//   hash: canonical SHA-256 over everything above
//
// Sample stream, participant by participant:
//   varint participantCount
//   for each participant:
//     varint sampleCount
//     varint blockCount
//     blockCount x { varint absoluteTick, varint byteOffset }
//     varint sampleByteLength
//     sampleByteLength bytes
//
// One sample:
//   varint head
//     head == 0        repeat the previous sample, then varint repeatCount
//     head == 1        absolute sample, then varint absoluteTick
//     head >= 2        delta sample, tickDelta = head - 2
//   channel values in the order position3, quaternion4, speed,
//   velocity3, wheel4, steer, health, shield (only the channels the
//   participant declares). An absolute sample stores the quantised integers;
//   a delta sample stores the difference from the previous sample.
//   Every INDEX_BLOCK_SAMPLES-th sample is absolute, which is the seek anchor.
//
// Quantisation (integer stored = round(raw * scale)):
//   position 1024/m (max error 4.88e-4 m), quaternion 32767 (unit, max
//   component error 1.53e-5, then renormalised), speed/velocity 100/(m/s)
//   (5e-3), wheel 1000/rad (5e-4), steer 10000/rad (5e-5), health/shield
//   10/point (5e-2). These are measured against the raw values, not assumed.
//
// Seeking uses the block index: the player binary-searches the last block at
// or before the requested tick and decodes at most INDEX_BLOCK_SAMPLES samples
// from that anchor. It never re-simulates and never extrapolates.
//
// Limits: recordings are trusted only after the header hash and the build /
// map / layout / physics / car hashes match the caller's manifest. A replay is
// a recording, not an authority: it cannot prove the race was legal.
//
// No retail format, asset byte or unknown field is invented here.

import { hashOf, canonicalJson, sha256Hex } from './sha256.mjs';

export const REPLAY_KIND = 'blur.race-replay';
export const REPLAY_VERSION = 1;
export const REPLAY_SCHEMA = 'blur.race-replay/1';
export const REPLAY_GENERATOR = 'probes/replay/replay.mjs';
export const REPLAY_BODY_ENCODING = 'varint-delta-rle-v1';
export const REPLAY_SAMPLE_HZ = 20;
export const REPLAY_ENGINE_HZ = 60;
export const REPLAY_INDEX_BLOCK_SAMPLES = 32;

export const REPLAY_CHANNEL_ORDER = Object.freeze([
  'position', 'quaternion', 'speed', 'velocity', 'wheel', 'steer', 'health', 'shield'
]);
export const REPLAY_REQUIRED_CHANNELS = Object.freeze(['position', 'quaternion', 'speed']);
export const REPLAY_CHANNEL_WIDTH = Object.freeze({
  position: 3, quaternion: 4, speed: 1, velocity: 3, wheel: 4, steer: 1, health: 1, shield: 1
});
export const REPLAY_EVENT_TYPES = Object.freeze([
  'pickup', 'hit', 'wreck', 'respawn', 'lap', 'finish'
]);
export const REPLAY_RESULT_STATUS = Object.freeze(['finished', 'dnf', 'disconnected', 'left']);

/** Quantisation scale per channel (integer = round(raw * scale)). */
export const REPLAY_QUANT = Object.freeze({
  position: { scale: 1024, maxError: 0.5 / 1024 },
  quaternion: { scale: 32767, maxError: 0.5 / 32767 },
  speed: { scale: 100, maxError: 0.5 / 100 },
  velocity: { scale: 100, maxError: 0.5 / 100 },
  wheel: { scale: 1000, maxError: 0.5 / 1000 },
  steer: { scale: 10000, maxError: 0.5 / 10000 },
  health: { scale: 10, maxError: 0.5 / 10 },
  shield: { scale: 10, maxError: 0.5 / 10 }
});

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const F32_SAFE = 2 ** 40;

export class ReplayError extends Error {
  constructor(code, message, detail = null) {
    super(message || code);
    this.name = 'ReplayError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Base64 (works in the page and in Node without Buffer/btoa)
// ---------------------------------------------------------------------------

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
  if (typeof text !== 'string' || text.length % 4 !== 0) {
    throw new ReplayError('REPLAY_BAD_BASE64', 'replay body is not base64');
  }
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < text.length; index += 4) {
    const values = [0, 0, 0, 0];
    for (let slot = 0; slot < 4; slot++) {
      const char = text[index + slot];
      if (char === '=') { values[slot] = 0; continue; }
      const value = B64_ALPHABET.indexOf(char);
      if (value < 0) throw new ReplayError('REPLAY_BAD_BASE64', 'replay body has a non-base64 character');
      values[slot] = value;
    }
    const triple = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
    if (offset < bytes.length) bytes[offset++] = (triple >> 16) & 0xff;
    if (offset < bytes.length) bytes[offset++] = (triple >> 8) & 0xff;
    if (offset < bytes.length) bytes[offset++] = triple & 0xff;
  }
  return bytes;
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

// ---------------------------------------------------------------------------
// Quantisation
// ---------------------------------------------------------------------------

function assertFinite(value, what) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ReplayError('REPLAY_VALUE', what + ' is not a finite number');
  }
}

function quantiseValue(value, channel) {
  assertFinite(value, channel);
  const scale = REPLAY_QUANT[channel].scale;
  const quantised = Math.round(value * scale);
  if (!Number.isSafeInteger(quantised) || Math.abs(quantised) > F32_SAFE) {
    throw new ReplayError('REPLAY_VALUE', channel + ' is outside the quantisation range');
  }
  return quantised;
}

export function dequantiseValue(value, channel) {
  return value / REPLAY_QUANT[channel].scale;
}

export function quantiseChannel(values, channel) {
  const width = REPLAY_CHANNEL_WIDTH[channel];
  if (!Array.isArray(values) || values.length !== width) {
    throw new ReplayError('REPLAY_CHANNEL', channel + ' needs ' + width + ' values');
  }
  return values.map((value) => quantiseValue(value, channel));
}

export function dequantiseChannel(values, channel) {
  return values.map((value) => dequantiseValue(value, channel));
}

export function normalizeQuaternion(quaternion) {
  const length = Math.hypot(
    quaternion[0], quaternion[1], quaternion[2], quaternion[3]
  );
  if (!(length > 0) || !Number.isFinite(length)) {
    throw new ReplayError('REPLAY_VALUE', 'quaternion has zero length');
  }
  return [
    quaternion[0] / length, quaternion[1] / length,
    quaternion[2] / length, quaternion[3] / length
  ];
}

export function quaternionAngle(a, b) {
  const dot = Math.abs(
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  );
  return 2 * Math.acos(Math.max(-1, Math.min(1, dot)));
}

/** Slerp with the shortest arc; both inputs are normalised. */
export function slerpQuaternion(a, b, t) {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    return normalizeQuaternion([
      a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t,
      a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t
    ]);
  }
  const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
  const sinTheta = Math.sin(theta);
  const scaleA = Math.sin((1 - t) * theta) / sinTheta;
  const scaleB = Math.sin(t * theta) / sinTheta;
  return normalizeQuaternion([
    a[0] * scaleA + bx * scaleB, a[1] * scaleA + by * scaleB,
    a[2] * scaleA + bz * scaleB, a[3] * scaleA + bw * scaleB
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;
const lerpArray = (a, b, t) => a.map((value, index) => lerp(value, b[index], t));

// ---------------------------------------------------------------------------
// Binary writer / reader
// ---------------------------------------------------------------------------

class Writer {
  constructor() {
    this.bytes = [];
  }
  get length() {
    return this.bytes.length;
  }
  varint(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ReplayError('REPLAY_ENCODE', 'varint needs a non-negative safe integer');
    }
    let remaining = value;
    while (remaining >= 0x80) {
      this.bytes.push((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    this.bytes.push(remaining);
    return this;
  }
  signed(value) {
    if (!Number.isSafeInteger(value)) {
      throw new ReplayError('REPLAY_ENCODE', 'signed value is not a safe integer');
    }
    return this.varint(value >= 0 ? value * 2 : -value * 2 - 1);
  }
  concat(bytes) {
    for (const byte of bytes) this.bytes.push(byte);
    return this;
  }
  toBytes() {
    return Uint8Array.from(this.bytes);
  }
}

class Reader {
  constructor(bytes, offset = 0) {
    this.bytes = bytes;
    this.offset = offset;
  }
  varint() {
    let result = 0;
    let multiplier = 1;
    for (let index = 0; index < 8; index++) {
      if (this.offset >= this.bytes.length) {
        throw new ReplayError('REPLAY_TRUNCATED', 'sample stream ends inside a varint');
      }
      const byte = this.bytes[this.offset++];
      result += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return result;
      multiplier *= 128;
    }
    throw new ReplayError('REPLAY_CORRUPT', 'varint is longer than 8 bytes');
  }
  signed() {
    const value = this.varint();
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
  }
  remaining() {
    return this.bytes.length - this.offset;
  }
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

function normalizeParticipant(entry, index) {
  const value = typeof entry === 'string' ? { id: entry } : entry;
  if (!value || typeof value.id !== 'string' || !value.id) {
    throw new ReplayError('REPLAY_PARTICIPANT', 'participant ' + index + ' has no id');
  }
  const slot = value.slot ?? index + 1;
  if (!Number.isInteger(slot) || slot < 1) {
    throw new ReplayError('REPLAY_PARTICIPANT', 'participant ' + value.id + ' has a bad slot');
  }
  return {
    id: value.id,
    slot,
    car: typeof value.car === 'string' ? value.car : null,
    carHash: typeof value.carHash === 'string' ? value.carHash : null
  };
}

function normalizeCar(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') {
    throw new ReplayError('REPLAY_SAMPLE', 'car sample is not an object');
  }
  const id = raw.id ?? fallbackId;
  if (typeof id !== 'string' || !id) {
    throw new ReplayError('REPLAY_SAMPLE', 'car sample has no id');
  }
  if (!Array.isArray(raw.position) || raw.position.length !== 3) {
    throw new ReplayError('REPLAY_SAMPLE', id + ' needs a [x, y, z] position');
  }
  if (!Array.isArray(raw.quaternion) || raw.quaternion.length !== 4) {
    throw new ReplayError('REPLAY_SAMPLE', id + ' needs an [x, y, z, w] quaternion');
  }
  assertFinite(raw.speed, id + ' speed');
  const car = {
    id,
    position: raw.position.slice(),
    quaternion: raw.quaternion.slice(),
    speed: raw.speed
  };
  for (const channel of ['velocity', 'wheel']) {
    if (raw[channel] !== undefined) {
      const width = REPLAY_CHANNEL_WIDTH[channel];
      if (!Array.isArray(raw[channel]) || raw[channel].length !== width) {
        throw new ReplayError('REPLAY_CHANNEL', id + ' ' + channel + ' needs ' + width + ' values');
      }
      car[channel] = raw[channel].slice();
    }
  }
  for (const channel of ['steer', 'health', 'shield']) {
    if (raw[channel] !== undefined) {
      assertFinite(raw[channel], id + ' ' + channel);
      car[channel] = raw[channel];
    }
  }
  return car;
}

/**
 * Records one race. Feed host snapshots in tick order; build() returns the
 * immutable replay record.
 *
 *   const recorder = new ReplayRecorder({
 *     tickHz: 20, engineTickHz: 60,
 *     map: { id, hash }, hashes: { build, map, layout, physics },
 *     participants: [{ id, slot, car, carHash }]
 *   });
 *   recorder.capture({ tick, cars: [...] });     // or a single-car snapshot
 *   recorder.addEvent({ tick, type: 'pickup', participantId: 'pl_1', pickup: 'Shield' });
 *   recorder.setResult(result);
 *   const replay = recorder.build();
 */
export class ReplayRecorder {
  constructor(options = {}) {
    const tickHz = options.tickHz ?? REPLAY_SAMPLE_HZ;
    const engineTickHz = options.engineTickHz ?? REPLAY_ENGINE_HZ;
    if (!(Number.isFinite(tickHz) && tickHz > 0)) {
      throw new ReplayError('REPLAY_CONFIG', 'tickHz must be positive');
    }
    if (!(Number.isFinite(engineTickHz) && engineTickHz > 0)) {
      throw new ReplayError('REPLAY_CONFIG', 'engineTickHz must be positive');
    }
    if (!Number.isInteger(engineTickHz / tickHz)) {
      throw new ReplayError('REPLAY_CONFIG', 'engineTickHz must be an integer multiple of tickHz');
    }
    const participants = (options.participants ?? []).map(normalizeParticipant);
    if (participants.length === 0) {
      throw new ReplayError('REPLAY_CONFIG', 'a replay needs at least one participant');
    }
    const ids = new Set(participants.map((participant) => participant.id));
    if (ids.size !== participants.length) {
      throw new ReplayError('REPLAY_CONFIG', 'participant ids must be unique');
    }
    const slots = new Set(participants.map((participant) => participant.slot));
    if (slots.size !== participants.length) {
      throw new ReplayError('REPLAY_CONFIG', 'participant slots must be unique');
    }
    this.tickHz = tickHz;
    this.engineTickHz = engineTickHz;
    this.participants = participants;
    this.map = options.map ? JSON.parse(JSON.stringify(options.map)) : null;
    this.hashes = options.hashes ?? {};
    this.labels = options.labels ? JSON.parse(JSON.stringify(options.labels)) : {};
    this.createdAt = options.createdAt ?? null;
    this.keepRaw = options.keepRaw === true;
    this._byId = new Map(participants.map((participant) => [participant.id, participant]));
    this._samples = new Map(participants.map((participant) => [participant.id, []]));
    this._raw = this.keepRaw ? [] : null;
    this._ticks = [];
    this._events = [];
    this._result = null;
    this._eventSeq = 0;
    this._quaternionSigns = new Map();
  }

  get lastTick() {
    return this._ticks.length ? this._ticks[this._ticks.length - 1] : null;
  }

  get sampleCount() {
    return this._ticks.length;
  }

  /** Raw snapshots retained only when `keepRaw` is on (diagnostics/tests). */
  get rawStream() {
    return this._raw;
  }

  capture(snapshot) {
    if (!snapshot || !Number.isInteger(snapshot.tick) || snapshot.tick < 0) {
      throw new ReplayError('REPLAY_SAMPLE', 'snapshot needs a non-negative integer tick');
    }
    const tick = snapshot.tick;
    if (this.lastTick !== null && tick < this.lastTick) {
      throw new ReplayError(
        'REPLAY_TICK_ORDER',
        'snapshot tick ' + tick + ' is before the previous tick ' + this.lastTick
      );
    }
    if (Array.isArray(snapshot.cars)) {
      for (const car of snapshot.cars) {
        if (car && car.tick !== undefined && car.tick !== tick) {
          throw new ReplayError(
            'REPLAY_TICK_ORDER',
            'car ' + car.id + ' tick ' + car.tick + ' is not the snapshot tick ' + tick
          );
        }
      }
    }
    const cars = Array.isArray(snapshot.cars)
      ? snapshot.cars.map((car) => normalizeCar(car, null))
      : [normalizeCar(snapshot, this.participants.length === 1 ? this.participants[0].id : null)];

    const seen = new Set();
    for (const car of cars) {
      if (!this._byId.has(car.id)) {
        throw new ReplayError('REPLAY_PARTICIPANT', 'unknown participant ' + car.id);
      }
      if (seen.has(car.id)) {
        throw new ReplayError('REPLAY_PARTICIPANT', 'participant ' + car.id + ' appears twice');
      }
      seen.add(car.id);
    }
    if (seen.size !== this.participants.length) {
      const missing = this.participants.map((participant) => participant.id)
        .filter((id) => !seen.has(id));
      throw new ReplayError(
        'REPLAY_PARTICIPANT',
        'snapshot tick ' + tick + ' is missing ' + missing.join(', ')
      );
    }

    const replacing = tick === this.lastTick;
    if (replacing) {
      for (const car of cars) {
        const list = this._samples.get(car.id);
        list.pop();
      }
      this._ticks.pop();
      if (this._raw) this._raw.pop();
    }

    const record = { tick, cars: [] };
    for (const car of cars) {
      const participant = this._byId.get(car.id);
      const previous = this._samples.get(car.id).slice(-1)[0] ?? null;
      const quantised = { position: quantiseChannel(car.position, 'position') };
      let quaternion = normalizeQuaternion(car.quaternion);
      if (previous) {
        const lastQuaternion = previous.q.quaternion.map(
          (value) => value / REPLAY_QUANT.quaternion.scale
        );
        const dot = quaternion[0] * lastQuaternion[0] +
          quaternion[1] * lastQuaternion[1] +
          quaternion[2] * lastQuaternion[2] +
          quaternion[3] * lastQuaternion[3];
        if (dot < 0) quaternion = quaternion.map((value) => -value);
      }
      quantised.quaternion = quaternion.map((value) => quantiseValue(value, 'quaternion'));
      quantised.speed = [quantiseValue(car.speed, 'speed')];
      for (const channel of ['velocity', 'wheel']) {
        if (car[channel] !== undefined) quantised[channel] = quantiseChannel(car[channel], channel);
      }
      for (const channel of ['steer', 'health', 'shield']) {
        if (car[channel] !== undefined) quantised[channel] = [quantiseValue(car[channel], channel)];
      }
      this._samples.get(car.id).push({ tick, q: quantised });
      record.cars.push({
        id: participant.id,
        tick,
        position: car.position.slice(),
        quaternion: car.quaternion.slice(),
        speed: car.speed,
        ...(car.velocity ? { velocity: car.velocity.slice() } : {}),
        ...(car.wheel ? { wheel: car.wheel.slice() } : {}),
        ...(car.steer !== undefined ? { steer: car.steer } : {}),
        ...(car.health !== undefined ? { health: car.health } : {}),
        ...(car.shield !== undefined ? { shield: car.shield } : {})
      });
    }
    this._ticks.push(tick);
    if (this._raw) this._raw.push(record);
    return this;
  }

  /** Quantised samples as recorded; diagnostics and size accounting only. */
  quantisedSamples(participantId) {
    const samples = this._samples.get(participantId);
    if (!samples) throw new ReplayError('REPLAY_PARTICIPANT', 'unknown participant ' + participantId);
    return samples.map((sample) => ({
      tick: sample.tick,
      q: Object.fromEntries(Object.entries(sample.q).map(([channel, values]) => [channel, values.slice()]))
    }));
  }

  addEvent(event) {
    if (!event || typeof event !== 'object') {
      throw new ReplayError('REPLAY_EVENT', 'event is not an object');
    }
    if (!Number.isInteger(event.tick) || event.tick < 0) {
      throw new ReplayError('REPLAY_EVENT', 'event needs a non-negative integer tick');
    }
    if (!REPLAY_EVENT_TYPES.includes(event.type)) {
      throw new ReplayError('REPLAY_EVENT', 'unknown event type ' + event.type);
    }
    if (event.participantId !== undefined && !this._byId.has(event.participantId)) {
      throw new ReplayError('REPLAY_EVENT', 'event names unknown participant ' + event.participantId);
    }
    if (event.targetId !== undefined && !this._byId.has(event.targetId)) {
      throw new ReplayError('REPLAY_EVENT', 'event names unknown target ' + event.targetId);
    }
    if (this._ticks.length && event.tick < this._ticks[0]) {
      throw new ReplayError('REPLAY_EVENT', 'event tick ' + event.tick + ' is before the first sample');
    }
    this._events.push({ ...event, __seq: this._eventSeq++ });
    return this;
  }

  setResult(result) {
    if (!result || typeof result !== 'object' || !Array.isArray(result.rows)) {
      throw new ReplayError('REPLAY_RESULT', 'result needs a rows array');
    }
    for (const row of result.rows) {
      if (!row || typeof row.id !== 'string' || !this._byId.has(row.id)) {
        throw new ReplayError('REPLAY_RESULT', 'result row names an unknown participant');
      }
      if (row.status !== undefined && !REPLAY_RESULT_STATUS.includes(row.status)) {
        throw new ReplayError('REPLAY_RESULT', 'unknown result status ' + row.status);
      }
    }
    this._result = JSON.parse(JSON.stringify(result));
    return this;
  }

  build(options = {}) {
    if (this._ticks.length < 2) {
      throw new ReplayError('REPLAY_CONFIG', 'a replay needs at least two samples');
    }
    if (!this._result) {
      throw new ReplayError('REPLAY_CONFIG', 'a replay needs the shared result before build()');
    }
    const participantSamples = [];
    const participantChannels = [];
    const participantMeta = [];
    for (const participant of this.participants) {
      const samples = this._samples.get(participant.id);
      if (samples.length !== this._ticks.length) {
        throw new ReplayError(
          'REPLAY_PARTICIPANT',
          participant.id + ' has ' + samples.length + ' samples, expected ' + this._ticks.length
        );
      }
      const channels = Object.keys(samples[0].q);
      for (const channel of REPLAY_REQUIRED_CHANNELS) {
        if (!channels.includes(channel)) {
          throw new ReplayError('REPLAY_CHANNEL', participant.id + ' is missing ' + channel);
        }
      }
      for (const sample of samples) {
        const keys = Object.keys(sample.q);
        if (keys.length !== channels.length || keys.some((key) => !channels.includes(key))) {
          throw new ReplayError(
            'REPLAY_CHANNEL',
            participant.id + ' changes its channel set between samples'
          );
        }
      }
      participantSamples.push(samples);
      participantChannels.push(channels);
      participantMeta.push({
        id: participant.id,
        slot: participant.slot,
        car: participant.car,
        carHash: participant.carHash,
        channels,
        sampleCount: samples.length
      });
    }

    const encoded = encodeReplayBody(participantSamples, participantChannels, {
      indexBlockSamples: REPLAY_INDEX_BLOCK_SAMPLES,
      rle: options.rle !== false
    });
    const body = bytesToBase64(encoded.body);
    const events = this._events
      .slice()
      .sort((a, b) => a.tick - b.tick || a.__seq - b.__seq)
      .map((event) => {
        const clean = { ...event };
        delete clean.__seq;
        return clean;
      });
    for (const event of events) {
      if (event.tick < this._ticks[0] || event.tick > this._ticks[this._ticks.length - 1]) {
        throw new ReplayError(
          'REPLAY_EVENT',
          'event tick ' + event.tick + ' is outside the recorded tick range'
        );
      }
    }
    const cars = {};
    for (const participant of participantMeta) {
      if (participant.carHash) cars[participant.id] = participant.carHash;
    }
    const header = {
      kind: REPLAY_KIND,
      version: REPLAY_VERSION,
      schema: REPLAY_SCHEMA,
      generator: REPLAY_GENERATOR,
      createdAt: this.createdAt,
      tickHz: this.tickHz,
      engineTickHz: this.engineTickHz,
      firstTick: this._ticks[0],
      lastTick: this._ticks[this._ticks.length - 1],
      sampleCount: this._ticks.length,
      map: this.map,
      labels: this.labels,
      hashes: {
        build: this.hashes.build ?? null,
        map: this.hashes.map ?? null,
        layout: this.hashes.layout ?? null,
        physics: this.hashes.physics ?? null,
        cars
      },
      participants: participantMeta,
      result: this._result,
      events,
      quantisation: Object.fromEntries(
        REPLAY_CHANNEL_ORDER.map((channel) => [channel, { ...REPLAY_QUANT[channel] }])
      ),
      encoding: {
        bodyEncoding: REPLAY_BODY_ENCODING,
        indexBlockSamples: REPLAY_INDEX_BLOCK_SAMPLES,
        bodyBytes: encoded.body.length,
        sampleBytes: encoded.sampleBytes,
        indexBytes: encoded.indexBytes,
        bodyBase64Bytes: body.length
      },
      body
    };
    header.hash = replayHash(header);
    return header;
  }
}

// ---------------------------------------------------------------------------
// Body encoder / decoder
// ---------------------------------------------------------------------------

function sampleChannelEquals(a, b, channels) {
  for (const channel of channels) {
    const left = a[channel];
    const right = b[channel];
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index]) return false;
    }
  }
  return true;
}

function writeChannelValues(writer, channel, values, previous, absolute) {
  for (let index = 0; index < values.length; index++) {
    writer.signed(absolute ? values[index] : values[index] - previous[index]);
  }
}

function encodeParticipant(samples, channels, blockSize, rle) {
  const writer = new Writer();
  const index = [];
  let previous = null;
  let previousDelta = null;
  let runLength = 0;

  const flushRun = () => {
    if (runLength > 0) {
      writer.varint(0);
      writer.varint(runLength);
      runLength = 0;
    }
  };

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    const sample = samples[sampleIndex];
    const delta = previous ? sample.tick - previous.tick : 0;
    if (delta < 0) throw new ReplayError('REPLAY_TICK_ORDER', 'samples are not in tick order');
    const absolute = sampleIndex % blockSize === 0;
    const repeated = rle && !absolute && previous && delta >= 1 &&
      delta === previousDelta && sampleChannelEquals(sample.q, previous.q, channels);
    if (repeated) {
      runLength++;
      previous = sample;
      continue;
    }
    flushRun();
    if (absolute) index.push({ tick: sample.tick, offset: writer.length });
    if (absolute) {
      writer.varint(1);
      writer.varint(sample.tick);
      for (const channel of channels) {
        writeChannelValues(writer, channel, sample.q[channel], null, true);
      }
      previousDelta = null;
    } else {
      if (!previous) throw new ReplayError('REPLAY_ENCODE', 'first sample must be absolute');
      writer.varint(2 + delta);
      for (const channel of channels) {
        writeChannelValues(writer, channel, sample.q[channel], previous.q[channel], false);
      }
      previousDelta = delta;
    }
    previous = sample;
  }
  flushRun();
  return { bytes: writer.toBytes(), index };
}

/** Encode the participant sample stream. Exported for size accounting tests. */
export function encodeReplayBody(participantSamples, participantChannels, options = {}) {
  const blockSize = options.indexBlockSamples ?? REPLAY_INDEX_BLOCK_SAMPLES;
  const rle = options.rle !== false;
  if (!Number.isInteger(blockSize) || blockSize < 1) {
    throw new ReplayError('REPLAY_CONFIG', 'indexBlockSamples must be a positive integer');
  }
  const table = new Writer();
  table.varint(participantSamples.length);
  let sampleBytes = 0;
  const blocks = [];
  for (let participantIndex = 0; participantIndex < participantSamples.length; participantIndex++) {
    const samples = participantSamples[participantIndex];
    const channels = participantChannels[participantIndex];
    const encoded = encodeParticipant(samples, channels, blockSize, rle);
    table.varint(samples.length);
    table.varint(encoded.index.length);
    for (const block of encoded.index) {
      table.varint(block.tick);
      table.varint(block.offset);
    }
    table.varint(encoded.bytes.length);
    table.concat(encoded.bytes);
    blocks.push(encoded.index);
    sampleBytes += encoded.bytes.length;
  }
  const body = table.toBytes();
  return {
    body,
    indexBytes: body.length - sampleBytes,
    sampleBytes,
    blocks
  };
}

function readChannelValues(reader, channel, previous, absolute) {
  const width = REPLAY_CHANNEL_WIDTH[channel];
  const values = new Array(width);
  for (let index = 0; index < width; index++) {
    const raw = reader.signed();
    values[index] = absolute ? raw : previous[index] + raw;
  }
  return values;
}

/**
 * Size of the same quantised samples if every sample stored absolute integers
 * (no delta, no RLE). Used only to measure what delta+RLE saves; it is not a
 * valid replay encoding.
 */
export function measureAbsoluteSampleBytes(participantSamples, participantChannels) {
  let bytes = 0;
  for (let participantIndex = 0; participantIndex < participantSamples.length; participantIndex++) {
    const channels = participantChannels[participantIndex];
    for (const sample of participantSamples[participantIndex]) {
      const writer = new Writer();
      writer.varint(1);
      writer.varint(sample.tick);
      for (const channel of channels) {
        writeChannelValues(writer, channel, sample.q[channel], null, true);
      }
      bytes += writer.length;
    }
  }
  return bytes;
}

/** Parse the body into participant byte ranges and seek blocks. */
export function decodeReplayBody(replay) {
  const body = base64ToBytes(replay.body);
  const reader = new Reader(body);
  const count = reader.varint();
  if (count !== replay.participants.length) {
    throw new ReplayError(
      'REPLAY_CORRUPT',
      'body has ' + count + ' participants, header has ' + replay.participants.length
    );
  }
  const participants = [];
  let sampleBytes = 0;
  for (const meta of replay.participants) {
    const channels = meta.channels;
    if (!Array.isArray(channels) || channels.length === 0) {
      throw new ReplayError('REPLAY_CORRUPT', meta.id + ' has no channels in the header');
    }
    for (const channel of channels) {
      if (!REPLAY_CHANNEL_WIDTH[channel]) {
        throw new ReplayError('REPLAY_CORRUPT', meta.id + ' declares unknown channel ' + channel);
      }
    }
    const sampleCount = reader.varint();
    if (sampleCount !== meta.sampleCount) {
      throw new ReplayError(
        'REPLAY_CORRUPT',
        meta.id + ' body sampleCount ' + sampleCount + ' != header ' + meta.sampleCount
      );
    }
    const blockCount = reader.varint();
    const blocks = [];
    for (let index = 0; index < blockCount; index++) {
      const tick = reader.varint();
      const offset = reader.varint();
      blocks.push({ tick, offset });
    }
    const length = reader.varint();
    if (reader.offset + length > body.length) {
      throw new ReplayError('REPLAY_TRUNCATED', meta.id + ' sample bytes exceed the body');
    }
    const bytes = body.subarray(reader.offset, reader.offset + length);
    reader.offset += length;
    participants.push({
      id: meta.id,
      slot: meta.slot,
      car: meta.car,
      channels,
      sampleCount,
      blocks,
      bytes
    });
    sampleBytes += length;
  }
  if (reader.remaining() !== 0) {
    throw new ReplayError('REPLAY_CORRUPT', 'body has ' + reader.remaining() + ' trailing bytes');
  }
  return {
    body,
    participants,
    indexBytes: body.length - sampleBytes,
    sampleBytes
  };
}

// ---------------------------------------------------------------------------
// Sample decoding from a seek anchor
// ---------------------------------------------------------------------------

function findBlock(blocks, tick) {
  if (blocks.length === 0) return 0;
  let low = 0;
  let high = blocks.length - 1;
  if (tick <= blocks[0].tick) return 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (blocks[middle].tick <= tick) {
      if (middle === blocks.length - 1 || blocks[middle + 1].tick > tick) return middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return 0;
}

function walkFromBlock(participant, blockIndex, targetTick, blockSize) {
  const offset = participant.blocks[blockIndex].offset;
  const reader = new Reader(participant.bytes, offset);
  const channels = participant.channels;
  let previous = null;
  let previousDelta = null;
  let sampleIndex = blockIndex * blockSize;

  while (sampleIndex < participant.sampleCount) {
    const head = reader.varint();
    if (head === 0) {
      const extra = reader.varint();
      if (!previous || previousDelta === null || extra < 1) {
        throw new ReplayError('REPLAY_CORRUPT', participant.id + ' has an invalid repeat run');
      }
      const firstAfter = previous.tick + previousDelta;
      const lastAfter = previous.tick + previousDelta * extra;
      if (targetTick <= lastAfter) {
        if (targetTick <= firstAfter) {
          if (targetTick === firstAfter) {
            return { prev: { tick: firstAfter, q: previous.q }, next: null, alpha: 0 };
          }
          return {
            prev: previous,
            next: { tick: firstAfter, q: previous.q },
            alpha: (targetTick - previous.tick) / (firstAfter - previous.tick)
          };
        }
        const steps = Math.floor((targetTick - previous.tick) / previousDelta);
        const beforeTick = previous.tick + (steps - 1) * previousDelta;
        const afterTick = previous.tick + steps * previousDelta;
        if (afterTick === targetTick) {
          return { prev: { tick: afterTick, q: previous.q }, next: null, alpha: 0 };
        }
        return {
          prev: { tick: beforeTick, q: previous.q },
          next: { tick: afterTick, q: previous.q },
          alpha: (targetTick - beforeTick) / (afterTick - beforeTick)
        };
      }
      previous = { tick: lastAfter, q: previous.q };
      sampleIndex += extra;
      continue;
    }

    let sample;
    if (head === 1) {
      const tick = reader.varint();
      const q = {};
      for (const channel of channels) {
        q[channel] = readChannelValues(reader, channel, null, true);
      }
      sample = { tick, q };
      previousDelta = null;
    } else {
      const delta = head - 2;
      if (delta < 1 || !previous) {
        throw new ReplayError('REPLAY_CORRUPT', participant.id + ' has a delta without a base');
      }
      const tick = previous.tick + delta;
      const q = {};
      for (const channel of channels) {
        q[channel] = readChannelValues(reader, channel, previous.q[channel], false);
      }
      sample = { tick, q };
      previousDelta = delta;
    }

    if (!previous) {
      if (sample.tick >= targetTick) {
        return { prev: sample, next: null, alpha: 0 };
      }
      previous = sample;
      sampleIndex++;
      continue;
    }
    if (sample.tick >= targetTick) {
      if (sample.tick === targetTick) return { prev: sample, next: null, alpha: 0 };
      return {
        prev: previous,
        next: sample,
        alpha: (targetTick - previous.tick) / (sample.tick - previous.tick)
      };
    }
    previous = sample;
    sampleIndex++;
  }
  return { prev: previous, next: null, alpha: 0 };
}

// ---------------------------------------------------------------------------
// Reader / player
// ---------------------------------------------------------------------------

function channelFloatValues(q, channel) {
  return dequantiseChannel(q[channel], channel);
}

function sampleToCar(participant, sample) {
  const q = sample.q;
  const car = {
    id: participant.id,
    slot: participant.slot,
    car: participant.car,
    tick: sample.tick,
    position: channelFloatValues(q, 'position'),
    quaternion: normalizeQuaternion(channelFloatValues(q, 'quaternion')),
    quaternionQuantised: q.quaternion.map((value) => dequantiseValue(value, 'quaternion')),
    speed: channelFloatValues(q, 'speed')[0]
  };
  for (const channel of ['velocity', 'wheel']) {
    if (q[channel]) car[channel] = channelFloatValues(q, channel);
  }
  for (const channel of ['steer', 'health', 'shield']) {
    if (q[channel] !== undefined) car[channel] = dequantiseValue(q[channel][0], channel);
  }
  return car;
}

function interpolateCars(participant, prev, next, alpha) {
  const a = sampleToCar(participant, prev);
  if (!next || alpha === 0) {
    a.sampleTick = prev.tick;
    return a;
  }
  const b = sampleToCar(participant, next);
  const car = {
    id: a.id,
    slot: a.slot,
    car: a.car,
    tick: prev.tick,
    sampleTick: prev.tick,
    position: lerpArray(a.position, b.position, alpha),
    quaternion: slerpQuaternion(a.quaternion, b.quaternion, alpha),
    speed: lerp(a.speed, b.speed, alpha)
  };
  if (a.velocity) car.velocity = lerpArray(a.velocity, b.velocity, alpha);
  if (a.wheel) car.wheel = lerpArray(a.wheel, b.wheel, alpha);
  if (a.steer !== undefined) car.steer = lerp(a.steer, b.steer, alpha);
  if (a.health !== undefined) car.health = a.health;
  if (a.shield !== undefined) car.shield = a.shield;
  return car;
}

export class ReplayReader {
  constructor(replay, options = {}) {
    this.replay = replay;
    this.blockSize = replay.encoding?.indexBlockSamples ?? REPLAY_INDEX_BLOCK_SAMPLES;
    const body = options.body ?? decodeReplayBody(replay);
    this.body = body.body;
    this.participants = body.participants;
    this._byId = new Map(this.participants.map((participant) => [participant.id, participant]));
  }

  participant(id) {
    const participant = this._byId.get(id);
    if (!participant) throw new ReplayError('REPLAY_PARTICIPANT', 'unknown participant ' + id);
    return participant;
  }

  /** Exact-or-interpolated interval for one participant at an engine tick. */
  interval(id, tick) {
    const participant = this.participant(id);
    const first = this.replay.firstTick;
    const last = this.replay.lastTick;
    if (!Number.isFinite(tick)) throw new ReplayError('REPLAY_TICK', 'tick is not finite');
    const clamped = Math.max(first, Math.min(last, tick));
    const blockIndex = findBlock(participant.blocks, clamped);
    const walked = walkFromBlock(participant, blockIndex, clamped, this.blockSize);
    if (!walked.prev) {
      throw new ReplayError('REPLAY_CORRUPT', participant.id + ' has no sample at tick ' + clamped);
    }
    return walked;
  }

  sampleAt(id, tick) {
    const participant = this.participant(id);
    const walked = this.interval(id, tick);
    return sampleToCar(participant, walked.prev);
  }

  /**
   * Rebuild every car at an engine tick.
   * `interpolate:false` returns the last recorded sample at or before the tick
   * (used by seek); the default interpolates position/quaternion/speed/
   * velocity/wheel/steer and holds health/shield until their next sample.
   */
  stateAt(tick, options = {}) {
    const interpolate = options.interpolate !== false;
    const clamped = Math.max(this.replay.firstTick, Math.min(this.replay.lastTick, tick));
    const cars = [];
    let sampleTick = null;
    for (const participant of this.participants) {
      const walked = this.interval(participant.id, clamped);
      const car = interpolate
        ? interpolateCars(participant, walked.prev, walked.next, walked.alpha)
        : (() => {
          const exact = sampleToCar(participant, walked.prev);
          exact.sampleTick = walked.prev.tick;
          return exact;
        })();
      if (sampleTick === null) sampleTick = walked.prev.tick;
      cars.push(car);
    }
    return {
      tick: clamped,
      sampleTick,
      cars
    };
  }

  /** Decode every sample of one participant (tests, export, error bounds). */
  allSamples(id) {
    const participant = this.participant(id);
    const reader = new Reader(participant.bytes, 0);
    const samples = [];
    let previous = null;
    let previousDelta = null;
    while (samples.length < participant.sampleCount) {
      const head = reader.varint();
      if (head === 0) {
        const extra = reader.varint();
        if (!previous || previousDelta === null || extra < 1) {
          throw new ReplayError('REPLAY_CORRUPT', participant.id + ' has an invalid repeat run');
        }
        for (let index = 0; index < extra; index++) {
          const tick = previous.tick + previousDelta * (index + 1);
          samples.push({ tick, q: previous.q });
        }
        previous = { tick: previous.tick + previousDelta * extra, q: previous.q };
        continue;
      }
      let sample;
      if (head === 1) {
        const tick = reader.varint();
        const q = {};
        for (const channel of participant.channels) {
          q[channel] = readChannelValues(reader, channel, null, true);
        }
        sample = { tick, q };
        previousDelta = null;
      } else {
        const delta = head - 2;
        if (delta < 1 || !previous) {
          throw new ReplayError('REPLAY_CORRUPT', participant.id + ' has a delta without a base');
        }
        const tick = previous.tick + delta;
        const q = {};
        for (const channel of participant.channels) {
          q[channel] = readChannelValues(reader, channel, previous.q[channel], false);
        }
        sample = { tick, q };
        previousDelta = delta;
      }
      if (!previous && sample.tick !== this.replay.firstTick) {
        throw new ReplayError('REPLAY_CORRUPT', participant.id + ' first sample is not firstTick');
      }
      samples.push(sample);
      previous = sample;
    }
    return samples.map((sample) => sampleToCar(participant, sample));
  }
}

/**
 * Replay player. `seek(tick)` jumps to the recorded sample at or before the
 * tick; `sampleAt(tick)` interpolates for rendering; `advance(dt)` moves the
 * cursor by `dt * playbackRate * tickHz`.
 */
export class ReplayPlayer {
  constructor(replay, expected = {}) {
    const checked = validateReplay(replay, expected);
    if (!checked.ok) {
      throw new ReplayError('REPLAY_REJECTED', checked.errors.join('; '), checked.errors);
    }
    this.replay = replay;
    this.reader = new ReplayReader(replay);
    this.playbackRate = 1;
    this.playing = false;
    this.ended = false;
    this._cursorTick = replay.firstTick;
  }

  get tickHz() {
    return this.replay.tickHz;
  }

  get engineTickHz() {
    return this.replay.engineTickHz;
  }

  get firstTick() {
    return this.replay.firstTick;
  }

  get lastTick() {
    return this.replay.lastTick;
  }

  get durationSeconds() {
    return (this.replay.lastTick - this.replay.firstTick) / this.replay.engineTickHz;
  }

  get cursorTick() {
    return this._cursorTick;
  }

  set playbackRate(rate) {
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 8) {
      throw new ReplayError('REPLAY_CONFIG', 'playbackRate must be in (0, 8]');
    }
    this._rate = rate;
  }

  get playbackRate() {
    return this._rate;
  }

  play() {
    if (this._cursorTick >= this.lastTick) {
      this._cursorTick = this.firstTick;
    }
    this.playing = true;
    this.ended = false;
    return this;
  }

  pause() {
    this.playing = false;
    return this;
  }

  seek(tick) {
    if (!Number.isFinite(tick)) throw new ReplayError('REPLAY_TICK', 'seek needs a finite tick');
    const clamped = Math.max(this.firstTick, Math.min(this.lastTick, tick));
    const state = this.reader.stateAt(clamped, { interpolate: false });
    this._cursorTick = state.sampleTick ?? clamped;
    this.ended = this._cursorTick >= this.lastTick;
    if (this.ended) this.playing = false;
    return state;
  }

  sampleAt(tick = this._cursorTick) {
    return this.reader.stateAt(tick, { interpolate: true });
  }

  /** Advance the cursor by wall-clock seconds; returns the rendered state. */
  advance(dtSeconds) {
    if (typeof dtSeconds !== 'number' || !Number.isFinite(dtSeconds) || dtSeconds < 0) {
      throw new ReplayError('REPLAY_CONFIG', 'advance needs non-negative seconds');
    }
    if (!this.playing) return this.sampleAt(this._cursorTick);
    this._cursorTick += dtSeconds * this.playbackRate * this.engineTickHz;
    if (this._cursorTick >= this.lastTick) {
      this._cursorTick = this.lastTick;
      this.ended = true;
      this.playing = false;
    }
    return this.sampleAt(this._cursorTick);
  }

  eventsBetween(fromTick, toTick) {
    const low = Math.min(fromTick, toTick);
    const high = Math.max(fromTick, toTick);
    return (this.replay.events ?? []).filter((event) => event.tick >= low && event.tick <= high);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function replayHash(record) {
  const body = { ...record };
  delete body.hash;
  return hashOf(body);
}

export function replaySize(replay) {
  const json = JSON.stringify(replay);
  return {
    jsonBytes: utf8Bytes(json).length,
    bodyBase64Bytes: typeof replay.body === 'string' ? replay.body.length : 0,
    bodyBytes: replay.encoding?.bodyBytes ?? 0,
    sampleBytes: replay.encoding?.sampleBytes ?? 0,
    indexBytes: replay.encoding?.indexBytes ?? 0
  };
}

const EXPECTED_HASH_FIELDS = [
  ['buildHash', 'build', 'REPLAY_BUILD_MISMATCH'],
  ['mapHash', 'map', 'REPLAY_MAP_MISMATCH'],
  ['layoutHash', 'layout', 'REPLAY_LAYOUT_MISMATCH'],
  ['physicsHash', 'physics', 'REPLAY_PHYSICS_MISMATCH']
];

function eventError(event, index, participantIds) {
  if (!event || typeof event !== 'object') return 'event ' + index + ' is not an object';
  if (!Number.isInteger(event.tick) || event.tick < 0) return 'event ' + index + ' has a bad tick';
  if (!REPLAY_EVENT_TYPES.includes(event.type)) return 'event ' + index + ' has an unknown type';
  if (event.participantId !== undefined && !participantIds.has(event.participantId)) {
    return 'event ' + index + ' names an unknown participant';
  }
  if (event.targetId !== undefined && !participantIds.has(event.targetId)) {
    return 'event ' + index + ' names an unknown target';
  }
  return null;
}

/**
 * Validate structure, body, sample ticks, events and the canonical hash, then
 * compare the recorded build/map/layout/physics/car hashes with `expected`.
 * Returns every problem instead of throwing.
 */
export function validateReplay(replay, expected = {}) {
  const errors = [];
  const add = (code, message) => errors.push(code + ': ' + message);
  if (!replay || typeof replay !== 'object' || Array.isArray(replay)) {
    return { ok: false, errors: ['REPLAY_STRUCTURE: not an object'] };
  }
  if (replay.kind !== REPLAY_KIND) add('REPLAY_STRUCTURE', 'kind is not ' + REPLAY_KIND);
  if (replay.version !== REPLAY_VERSION) {
    add('REPLAY_VERSION_MISMATCH', 'version is ' + replay.version + ', expected ' + REPLAY_VERSION);
  }
  if (replay.schema !== REPLAY_SCHEMA) add('REPLAY_STRUCTURE', 'schema is not ' + REPLAY_SCHEMA);
  if (expected.version !== undefined && replay.version !== expected.version) {
    add('REPLAY_VERSION_MISMATCH', 'build expects replay version ' + expected.version);
  }
  if (!(Number.isFinite(replay.tickHz) && replay.tickHz > 0)) add('REPLAY_STRUCTURE', 'bad tickHz');
  if (!(Number.isFinite(replay.engineTickHz) && replay.engineTickHz > 0)) {
    add('REPLAY_STRUCTURE', 'bad engineTickHz');
  }
  if (!Number.isInteger(replay.firstTick) || replay.firstTick < 0) {
    add('REPLAY_STRUCTURE', 'bad firstTick');
  }
  if (!Number.isInteger(replay.lastTick) || replay.lastTick <= replay.firstTick) {
    add('REPLAY_STRUCTURE', 'bad lastTick');
  }
  if (!Number.isInteger(replay.sampleCount) || replay.sampleCount < 2) {
    add('REPLAY_STRUCTURE', 'bad sampleCount');
  }
  if (!replay.hashes || typeof replay.hashes !== 'object') {
    add('REPLAY_STRUCTURE', 'missing hashes');  } else {
    for (const [key, field, code] of EXPECTED_HASH_FIELDS) {
      if (typeof replay.hashes[field] !== 'string' || !replay.hashes[field]) {
        add('REPLAY_STRUCTURE', 'missing hashes.' + field);
      } else if (typeof expected[key] === 'string' && replay.hashes[field] !== expected[key]) {
        add(code, field + ' ' + replay.hashes[field] + ' != build ' + expected[key]);
      }
    }
  }
  if (replay.labels !== undefined && (replay.labels === null || typeof replay.labels !== 'object' ||
      Array.isArray(replay.labels))) {
    add('REPLAY_STRUCTURE', 'labels must be an object');
  }
  const participantIds = new Set();
  const participants = Array.isArray(replay.participants) ? replay.participants : [];
  if (participants.length === 0) add('REPLAY_STRUCTURE', 'no participants');
  for (const participant of participants) {
    if (!participant || typeof participant.id !== 'string' || !participant.id) {
      add('REPLAY_STRUCTURE', 'participant without id');
      continue;
    }
    if (participantIds.has(participant.id)) add('REPLAY_STRUCTURE', 'duplicate participant ' + participant.id);
    participantIds.add(participant.id);
    if (!Number.isInteger(participant.slot) || participant.slot < 1) {
      add('REPLAY_STRUCTURE', participant.id + ' has a bad slot');
    }
    if (!Array.isArray(participant.channels) ||
        !REPLAY_REQUIRED_CHANNELS.every((channel) => participant.channels.includes(channel))) {
      add('REPLAY_CHANNEL', participant.id + ' misses a required channel');
    }
    if (!Number.isInteger(participant.sampleCount) || participant.sampleCount !== replay.sampleCount) {
      add('REPLAY_STRUCTURE', participant.id + ' sampleCount does not match the header');
    }
    if (typeof expected.carHashes === 'object' && expected.carHashes !== null) {
      const wanted = expected.carHashes[participant.id];
      if (typeof wanted === 'string' && participant.carHash !== wanted) {
        add('REPLAY_CAR_MISMATCH', participant.id + ' car hash does not match the build');
      }
    }
    if (replay.hashes && typeof replay.hashes.cars === 'object' &&
        typeof replay.hashes.cars[participant.id] === 'string' &&
        participant.carHash !== replay.hashes.cars[participant.id]) {
      add('REPLAY_CAR_MISMATCH', participant.id + ' car hash disagrees with the participant row');
    }
  }
  if (replay.hashes && typeof replay.hashes.cars === 'object') {
    for (const id of participantIds) {
      if (typeof replay.hashes.cars[id] !== 'string') {
        add('REPLAY_STRUCTURE', 'missing car hash for ' + id);
      }
    }
  }

  if (replay.encoding?.bodyEncoding !== REPLAY_BODY_ENCODING) {
    add('REPLAY_STRUCTURE', 'unexpected body encoding');
  }
  if (typeof replay.body !== 'string') {
    add('REPLAY_STRUCTURE', 'missing body');
  } else if (typeof replay.encoding?.bodyBytes === 'number') {
    try {
      const bytes = base64ToBytes(replay.body);
      if (bytes.length !== replay.encoding.bodyBytes) {
        add('REPLAY_CORRUPT', 'body decodes to ' + bytes.length + ' bytes, header says ' +
          replay.encoding.bodyBytes);
      }
    } catch (error) {
      add('REPLAY_BAD_BASE64', error.message);
    }
  }

  if (!replay.result || typeof replay.result !== 'object' || !Array.isArray(replay.result.rows)) {
    add('REPLAY_RESULT', 'missing shared result rows');
  } else {
    for (const row of replay.result.rows) {
      if (!row || typeof row.id !== 'string' || !participantIds.has(row.id)) {
        add('REPLAY_RESULT', 'result row names an unknown participant');
      }
      if (row && row.status !== undefined && !REPLAY_RESULT_STATUS.includes(row.status)) {
        add('REPLAY_RESULT', 'result row has unknown status ' + row.status);
      }
    }
  }

  const events = Array.isArray(replay.events) ? replay.events : null;
  if (!events) add('REPLAY_STRUCTURE', 'missing events');
  else {
    let previousTick = -Infinity;
    for (let index = 0; index < events.length; index++) {
      const message = eventError(events[index], index, participantIds);
      if (message) add('REPLAY_EVENT', message);
      if (events[index] && Number.isInteger(events[index].tick)) {
        if (events[index].tick < previousTick) add('REPLAY_EVENT', 'events are not tick-sorted');
        previousTick = events[index].tick;
        if (Number.isInteger(replay.firstTick) && Number.isInteger(replay.lastTick) &&
            (events[index].tick < replay.firstTick || events[index].tick > replay.lastTick)) {
          add('REPLAY_EVENT', 'event ' + index + ' is outside the recorded tick range');
        }
      }
    }
  }

  if (!errors.some((error) => error.startsWith('REPLAY_BAD_BASE64') ||
      error.startsWith('REPLAY_CORRUPT') || error.startsWith('REPLAY_TRUNCATED')) &&
      typeof replay.body === 'string') {
    try {
      const decoded = decodeReplayBody(replay);
      for (let index = 0; index < decoded.participants.length; index++) {
        const participant = decoded.participants[index];
        if (participant.blocks.length === 0) {
          add('REPLAY_CORRUPT', participant.id + ' has no seek blocks');
          continue;
        }
        if (participant.blocks[0].tick !== replay.firstTick) {
          add('REPLAY_CORRUPT', participant.id + ' first block tick is not firstTick');
        }
        if (participant.blocks[0].offset !== 0) {
          add('REPLAY_CORRUPT', participant.id + ' first block offset is not zero');
        }
        if (participant.blocks[participant.blocks.length - 1].offset >= participant.bytes.length) {
          add('REPLAY_CORRUPT', participant.id + ' block offset is outside the sample bytes');
        }
        if (participant.blocks[participant.blocks.length - 1].tick > replay.lastTick) {
          add('REPLAY_CORRUPT', participant.id + ' has a block after lastTick');
        }
        for (let block = 1; block < participant.blocks.length; block++) {
          if (participant.blocks[block].tick <= participant.blocks[block - 1].tick) {
            add('REPLAY_CORRUPT', participant.id + ' seek blocks are not tick-ordered');
          }
          if (participant.blocks[block].offset < participant.blocks[block - 1].offset) {
            add('REPLAY_CORRUPT', participant.id + ' seek offsets are not ordered');
          }
        }
      }
      if (decoded.sampleBytes !== replay.encoding?.sampleBytes) {
        add('REPLAY_CORRUPT', 'sample byte accounting does not match');
      }
      if (decoded.indexBytes !== replay.encoding?.indexBytes) {
        add('REPLAY_CORRUPT', 'index byte accounting does not match');
      }
    } catch (error) {
      add(error.code ?? 'REPLAY_CORRUPT', error.message);
    }
  }

  if (typeof replay.hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(replay.hash)) {
    add('REPLAY_STRUCTURE', 'missing canonical hash');
  } else if (replayHash(replay) !== replay.hash) {
    add('REPLAY_HASH_MISMATCH', 'canonical hash does not re-compute');
  }
  return { ok: errors.length === 0, errors };
}

/** Validate and open a replay; throws ReplayError('REPLAY_REJECTED'). */
export function loadReplay(replay, expected = {}) {
  const checked = validateReplay(replay, expected);
  if (!checked.ok) {
    throw new ReplayError('REPLAY_REJECTED', checked.errors.join('; '), checked.errors);
  }
  return new ReplayReader(replay);
}

/** Decode all cars at one tick without constructing a player. */
export function decodeReplayAt(replay, tick, expected = {}) {
  const checked = validateReplay(replay, expected);
  if (!checked.ok) {
    throw new ReplayError('REPLAY_REJECTED', checked.errors.join('; '), checked.errors);
  }
  return new ReplayReader(replay).stateAt(tick, { interpolate: false });
}

// ---------------------------------------------------------------------------
// Error measurement
// ---------------------------------------------------------------------------

/**
 * Compare a replay against the raw snapshot stream that produced it.
 * `rawStream` is the recorder's `{ tick, cars:[...] }` input. Quaternion error
 * is the rotation angle between the raw and decoded quaternions (sign
 * insensitive), position/velocity error is the Euclidean component distance.
 */
export function measureReplayError(rawStream, replay) {
  if (!Array.isArray(rawStream)) throw new ReplayError('REPLAY_CONFIG', 'raw stream must be an array');
  const reader = new ReplayReader(replay);
  const errors = {
    samples: 0,
    cars: 0,
    positionMax: 0,
    positionAxisMax: 0,
    positionMeanSum: 0,
    quaternionAngleMax: 0,
    quaternionComponentMax: 0,
    speedMax: 0,
    velocityMax: 0,
    wheelMax: 0,
    steerMax: 0,
    healthMax: 0,
    shieldMax: 0
  };
  for (const snapshot of rawStream) {
    const state = reader.stateAt(snapshot.tick, { interpolate: false });
    const byId = new Map(state.cars.map((car) => [car.id, car]));
    for (const raw of snapshot.cars) {
      const decoded = byId.get(raw.id);
      if (!decoded) throw new ReplayError('REPLAY_PARTICIPANT', 'decoded replay misses ' + raw.id);
      errors.samples++;
      const dx = decoded.position[0] - raw.position[0];
      const dy = decoded.position[1] - raw.position[1];
      const dz = decoded.position[2] - raw.position[2];
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      errors.positionMax = Math.max(errors.positionMax, distance);
      errors.positionAxisMax = Math.max(
        errors.positionAxisMax, Math.abs(dx), Math.abs(dy), Math.abs(dz)
      );
      errors.positionMeanSum += distance;
      const rawQuaternion = normalizeQuaternion(raw.quaternion.slice());
      errors.quaternionAngleMax = Math.max(
        errors.quaternionAngleMax,
        quaternionAngle(rawQuaternion, decoded.quaternion)
      );
      for (let index = 0; index < 4; index++) {
        errors.quaternionComponentMax = Math.max(
          errors.quaternionComponentMax,
          Math.abs(rawQuaternion[index] - decoded.quaternion[index])
        );
      }
      errors.speedMax = Math.max(errors.speedMax, Math.abs(decoded.speed - raw.speed));
      if (raw.velocity && decoded.velocity) {
        const vx = decoded.velocity[0] - raw.velocity[0];
        const vy = decoded.velocity[1] - raw.velocity[1];
        const vz = decoded.velocity[2] - raw.velocity[2];
        errors.velocityMax = Math.max(errors.velocityMax, Math.sqrt(vx * vx + vy * vy + vz * vz));
      }
      if (raw.wheel && decoded.wheel) {
        for (let index = 0; index < 4; index++) {
          errors.wheelMax = Math.max(errors.wheelMax, Math.abs(decoded.wheel[index] - raw.wheel[index]));
        }
      }
      if (raw.steer !== undefined && decoded.steer !== undefined) {
        errors.steerMax = Math.max(errors.steerMax, Math.abs(decoded.steer - raw.steer));
      }
      if (raw.health !== undefined && decoded.health !== undefined) {
        errors.healthMax = Math.max(errors.healthMax, Math.abs(decoded.health - raw.health));
      }
      if (raw.shield !== undefined && decoded.shield !== undefined) {
        errors.shieldMax = Math.max(errors.shieldMax, Math.abs(decoded.shield - raw.shield));
      }
      errors.cars++;
    }
  }
  errors.positionMean = errors.samples ? errors.positionMeanSum / errors.samples : 0;
  delete errors.positionMeanSum;
  return errors;
}

/** Canonical hash helper for integration tests: hash arbitrary metadata. */
export function replayHashOf(value) {
  return 'sha256:' + sha256Hex(canonicalJson(value));
}
