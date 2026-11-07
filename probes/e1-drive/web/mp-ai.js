// AI opponents for the online room (M4 slice).
//
// The host owns the AI roster and the simulation. This module is deliberately
// DOM-free and wasm-free so the same lobby/result/remote logic runs in the page
// and in the Node verifier:
//
//   * buildAiRoster: 0-3 host-selected AI records (car + skill profile);
//   * aiParticipants: stable participant ids (`ai-1`...`ai-3`) and slots after
//     the human roster, for the unchanged race-rules RaceSession;
//   * aiResultRows: AI rows from the host's authoritative RaceSession result;
//   * AiRemoteSet: one interpolation buffer + bounded display corrector per AI
//     on the guest (and for the host's own HUD); the client never simulates AI.
//
// The AI controller itself is `ai-driver-browser.js`, a verbatim copy of the
// committed `probes/ai-driver/ai-driver.mjs` with the Node crypto import
// replaced by the slice's synchronous SHA-256.
//
// Scope labels: `aiTransport:'host-relay-20Hz'`, `aiSimulation:'host-only'`,
// `aiMax:3`, `aiProfiles:['cautious','standard','reference']`,
// `aiPowerups:false`, `retailAi:false`.

import { RemoteDisplay } from './mp-remote.js';

export const MP_AI_SCHEMA = 'e1-drive.mp.ai/1';
export const MP_AI_MAX = 3;
export const MP_AI_RELAY_PATH = '/_mp-ai/relay';
export const MP_AI_RELAY_POLL_MS = 150;
export const MP_AI_POSE_EVERY_TICKS = 3; // 20 Hz at the fixed 60 Hz tick
export const MP_AI_PROFILE_IDS = Object.freeze(['cautious', 'standard', 'reference']);
export const MP_AI_PROFILE_SPEED = Object.freeze({ cautious: 0.85, standard: 0.95, reference: 1.0 });
export const MP_AI_ID_PREFIX = 'ai-';
export const MP_AI_DEFAULT_PROFILES = Object.freeze(['reference', 'standard', 'cautious']);
export const MP_AI_NOTE =
  'host-simulated AI opponents: one wasm instance per AI, R1 participant ids, ' +
  'broadcast at 20 Hz; clients never simulate AI and AI cars do not use power-ups';
// Typed map/preset limits. The Amboy floor is the driver owner's tuned value for
// the measured 6.06 m hairpin (MAP_CONTROL otherwise); Gracia keeps MAP_CONTROL.
// The Gracia Dodge Challenger loses front-axle contact at the committed spawn
// pose and is refused explicitly instead of pretending it races.
export const MP_AI_SPAWN_UNSUPPORTED = 'ai-spawn-unsupported';
export const MP_AI_MAP_CONTROL = Object.freeze({
  river: null,
  amboy: Object.freeze({ minSpeed: 3.5 }),
  gracia: null
});

export function aiControlOverrides(mapId) {
  return MP_AI_MAP_CONTROL[mapId] ?? null;
}

export function aiSpawnSupport(mapId, carSlug) {
  if (mapId === 'gracia' && carSlug === 'dodge-challenger-stock') {
    return {
      ok: false,
      code: MP_AI_SPAWN_UNSUPPORTED,
      reason: 'Gracia: the Dodge Challenger front axle is unloaded at the committed start pose ' +
        '(driver-owner measured 7 respawns/DNF); pick another car'
    };
  }
  return { ok: true, code: null, reason: null };
}

/** `ai-1`...`ai-3`; the numeric suffix is the only identity the rules see. */
export function aiPlayerId(index) {
  return MP_AI_ID_PREFIX + (index + 1);
}

export function isAiPlayerId(value) {
  return typeof value === 'string' && /^ai-[1-9][0-9]*$/.test(value);
}

function rosterCars(rosterDocument) {
  const cars = rosterDocument?.roster?.cars;
  if (!Array.isArray(cars) || !cars.length) throw new Error('AI roster needs the committed car roster');
  return cars;
}

function normalizeList(value, count) {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value.slice() : String(value).split(',');
  return list.map((entry) => String(entry).trim()).filter(Boolean).slice(0, count);
}

/**
 * Build the host's AI records. This is pure and total: it never invents a car
 * or a profile, and an invalid request returns `built:false` with typed errors
 * instead of silently dropping a slot.
 *
 * @param {object} rosterDocument committed `/_work/e1-drive/cars.json`
 * @param {{count?:number, cars?:string[]|string, profiles?:string[]|string,
 *          firstSlot?:number, hostCar?:string}} options
 */
export function buildAiRoster(rosterDocument, options = {}) {
  const rawCount = options.count ?? 0;
  const count = Number(rawCount);
  const errors = [];
  if (!Number.isInteger(count) || count < 0 || count > MP_AI_MAX) {
    errors.push('AI count must be an integer in [0, ' + MP_AI_MAX + '] (got ' + JSON.stringify(rawCount) + ')');
  }
  const cars = rosterCars(rosterDocument);
  const bySlug = new Map(cars.map((car) => [car.slug, car]));
  const requestedCars = normalizeList(options.cars, MP_AI_MAX);
  const requestedProfiles = normalizeList(options.profiles, MP_AI_MAX);
  const firstSlot = Number.isInteger(options.firstSlot) && options.firstSlot >= 2 ? options.firstSlot : 3;
  const mapId = options.mapId ?? 'river';
  const players = [];
  const errorCodes = [];
  const safeCount = Number.isInteger(count) ? Math.max(0, Math.min(MP_AI_MAX, count)) : 0;
  for (let index = 0; index < safeCount; index++) {
    const fallbackCar = cars[(index + 1) % cars.length];
    const carSlug = requestedCars[index] ?? fallbackCar.slug;
    const car = bySlug.get(carSlug);
    if (!car) {
      errors.push('AI ' + (index + 1) + ' names an unknown car ' + JSON.stringify(carSlug) +
        ' (roster: ' + cars.map((entry) => entry.slug).join(', ') + ')');
      continue;
    }
    const profile = requestedProfiles[index] ?? MP_AI_DEFAULT_PROFILES[index] ?? 'standard';
    if (!MP_AI_PROFILE_IDS.includes(profile)) {
      errors.push('AI ' + (index + 1) + ' names an unknown skill profile ' + JSON.stringify(profile) +
        ' (supported: ' + MP_AI_PROFILE_IDS.join(', ') + ')');
      continue;
    }
    const support = aiSpawnSupport(mapId, car.slug);
    if (!support.ok) {
      errors.push('AI ' + (index + 1) + ' (' + car.slug + '): ' + support.reason);
      errorCodes.push({ ai: index + 1, id: aiPlayerId(index), code: support.code, message: support.reason });
      continue;
    }
    players.push({
      id: aiPlayerId(index),
      slot: firstSlot + index,
      name: 'AI ' + (index + 1),
      car: car.slug,
      carName: car.name,
      profile,
      speedScale: MP_AI_PROFILE_SPEED[profile],
      ai: true
    });
  }
  return {
    kind: 'e1-drive.mp.ai-roster',
    version: 1,
    count: safeCount,
    firstSlot,
    mapId,
    players,
    built: errors.length === 0 && players.length === safeCount,
    errors,
    errorCodes,
    note: MP_AI_NOTE
  };
}

/** The AI records are valid for the start gate only when every slot was built. */
export function aiRosterReady(ai) {
  if (!ai) return true;
  if (!Number.isInteger(ai.count) || ai.count < 0 || ai.count > MP_AI_MAX) return false;
  return ai.built === true && Array.isArray(ai.players) && ai.players.length === ai.count;
}

/**
 * RaceSession participants: the human roster in its own slots, then AI in
 * stable slots after the highest human slot. Ids are `ai-1`... never a room id.
 */
export function aiParticipants(humanPlayers, aiPlayers = []) {
  const humans = [...(Array.isArray(humanPlayers) ? humanPlayers : [])]
    .map((player, index) => ({
      id: player.id,
      slot: Number.isInteger(player.slot) ? player.slot : index + 1,
      human: true
    }))
    .sort((a, b) => a.slot - b.slot || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const firstAiSlot = humans.length ? Math.max(...humans.map((row) => row.slot)) + 1 : 1;
  const ai = (Array.isArray(aiPlayers) ? aiPlayers : []).slice(0, MP_AI_MAX).map((player, index) => ({
    id: player.id ?? aiPlayerId(index),
    slot: Number.isInteger(player.slot) ? player.slot : firstAiSlot + index,
    human: false,
    ai: true
  })).sort((a, b) => a.slot - b.slot || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...humans, ...ai];
}

/** Deterministic AI start offsets behind the two measured human slots (metres). */
export function aiLongitudinalOffsets(count) {
  const offsets = [2.2, 0, -2.2, -4.4, -6.6];
  return offsets.slice(2, 2 + Math.max(0, Math.min(MP_AI_MAX, Number(count) || 0)));
}

const round6 = (value) => Math.round(value * 1e6) / 1e6;

/**
 * AI result rows from the host's RaceSession result. RaceSession reports race
 * ticks (from GO); the shared room table uses engine ticks including the
 * committed countdown, exactly like the human finish report.
 */
export function aiResultRows(raceRows, aiPlayers = [], countdownTicks = 0, tickHz = 60, raceTickOffset = 0) {
  const byId = new Map((Array.isArray(raceRows) ? raceRows : []).map((row) => [row.id, row]));
  return (Array.isArray(aiPlayers) ? aiPlayers : []).map((player) => {
    const row = byId.get(player.id) ?? null;
    const finished = row?.status === 'finished' && Number.isInteger(row.finishTick);
    const raceTick = finished ? row.finishTick + raceTickOffset : null;
    return {
      playerId: player.id,
      status: finished ? 'finished' : 'dnf',
      raceTick,
      tick: finished ? raceTick + countdownTicks : null,
      timeSeconds: finished ? round6(raceTick / tickHz) : null,
      finishHash: null,
      reason: finished ? null : (row?.dnfReason ?? 'ai-did-not-finish')
    };
  });
}

/** Compact lobby projection shared by the page and the verifier. */
export function aiSummary(ai) {
  if (!ai) return null;
  return {
    schema: MP_AI_SCHEMA,
    enabled: ai.enabled === true,
    host: ai.host === true,
    count: ai.count ?? 0,
    max: MP_AI_MAX,
    mapId: ai.mapId ?? null,
    built: ai.built === true,
    ready: aiRosterReady(ai),
    errorCodes: ai.errorCodes ?? [],
    records: (ai.players ?? []).map((player) => ({
      id: player.id, slot: player.slot, name: player.name, car: player.car,
      carName: player.carName ?? null, profile: player.profile, speedScale: player.speedScale
    })),
    remote: (ai.remotePlayers ?? []).map((player) => ({
      id: player.id, slot: player.slot, name: player.name, car: player.car,
      carName: player.carName ?? null, profile: player.profile
    })),
    errors: ai.errors ?? [],
    relayError: ai.relayError ?? null,
    note: MP_AI_NOTE
  };
}

function finiteState(state) {
  return state && Array.isArray(state.position) && state.position.length === 3 &&
    state.position.every(Number.isFinite) && Array.isArray(state.quaternion) &&
    state.quaternion.length === 4 && state.quaternion.every(Number.isFinite) &&
    Number.isFinite(state.tick) && Number.isFinite(state.speed ?? 0);
}

/**
 * Guest-side remote AI set. One interpolation buffer and one bounded display
 * corrector per AI; the pose source is the host's 20 Hz relay, never a local
 * simulation. Missing poses stay null and are labelled, never guessed.
 */
export class AiRemoteSet {
  constructor({ players = [], InterpolationBuffer, delayTicks = 3, ...correctors } = {}) {
    if (typeof InterpolationBuffer !== 'function') throw new Error('AiRemoteSet needs the net-mvp InterpolationBuffer');
    this.players = players;
    this.delayTicks = delayTicks;
    this.InterpolationBuffer = InterpolationBuffer;
    this.correctors = correctors;
    this.slots = new Map();
    for (const player of players) {
      this.slots.set(player.id, {
        player,
        buffer: new InterpolationBuffer(),
        display: new RemoteDisplay(this.correctors),
        latest: null,
        sample: null,
        pose: null,
        displayPose: null,
        corrections: 0,
        hardSets: 0,
        blends: 0,
        distance: null,
        samples: 0
      });
    }
  }

  get size() { return this.slots.size; }

  /** Apply one host snapshot `{ tick, cars:[{id,tick,position,quaternion,speed}] }`. */
  applyPose(message) {
    if (!message || !Array.isArray(message.cars)) return 0;
    let applied = 0;
    for (const car of message.cars) {
      const slot = this.slots.get(car?.id);
      if (!slot) continue;
      const state = {
        tick: car.tick ?? message.tick,
        position: car.position,
        quaternion: car.quaternion,
        speed: car.speed ?? 0
      };
      if (!finiteState(state)) continue;
      if (slot.buffer.add(state)) applied++;
      slot.latest = state;
      slot.samples++;
    }
    return applied;
  }

  /**
   * Sample every AI at `renderTick` (already delayed by the caller, like the
   * human remote path) and run the bounded display corrector. Returns one entry
   * per AI in roster order.
   */
  sample(renderTick) {
    const out = [];
    for (const slot of this.slots.values()) {
      const sample = slot.buffer.sample(renderTick);
      if (!sample) {
        out.push({ id: slot.player.id, player: slot.player, pose: null, sample: null, display: null });
        continue;
      }
      const display = slot.display.update(sample);
      slot.sample = sample;
      slot.corrections = display?.corrections ?? slot.corrections;
      slot.hardSets = display?.hardSets ?? slot.hardSets;
      slot.blends = display?.blends ?? slot.blends;
      slot.distance = display?.errorMetres ?? slot.distance;
      slot.displayPose = display ? { position: display.position.slice(), quaternion: display.quaternion.slice() } : null;
      out.push({
        id: slot.player.id,
        player: slot.player,
        pose: slot.displayPose,
        sample: {
          tick: sample.tick,
          interpolated: sample.interpolated === true,
          clamped: sample.clamped === true,
          alpha: sample.alpha ?? 0,
          from: sample.from ?? null,
          to: sample.to ?? null,
          position: sample.position.slice()
        },
        latest: slot.latest,
        display: {
          corrections: slot.corrections,
          hardSets: slot.hardSets,
          blends: slot.blends,
          distance: slot.distance
        }
      });
    }
    return out;
  }

  /** Forget interpolation/correction history (a respawn or a restart). */
  reset(playerId = null) {
    const targets = playerId ? [this.slots.get(playerId)].filter(Boolean) : [...this.slots.values()];
    for (const slot of targets) {
      slot.buffer = new this.InterpolationBuffer();
      slot.display.reset();
      slot.latest = null;
      slot.sample = null;
      slot.pose = null;
      slot.displayPose = null;
      slot.distance = null;
    }
  }

  snapshot() {
    return [...this.slots.values()].map((slot) => ({
      id: slot.player.id,
      slot: slot.player.slot,
      name: slot.player.name,
      car: slot.player.car,
      profile: slot.player.profile,
      label: aiLabel(slot.player),
      samples: slot.samples,
      latestTick: slot.latest?.tick ?? null,
      latestPosition: slot.latest?.position ?? null,
      sampleTick: slot.sample?.tick ?? null,
      samplePosition: slot.sample?.position ?? null,
      displayPosition: slot.displayPose?.position ?? null,
      displayQuaternion: slot.displayPose?.quaternion ?? null,
      distance: slot.distance,
      corrections: slot.corrections,
      hardSets: slot.hardSets,
      blends: slot.blends
    }));
  }
}

/** HUD/result label: `AI · profile`. */
export function aiLabel(player) {
  const profile = player?.profile ?? 'standard';
  return 'AI · ' + profile;
}
