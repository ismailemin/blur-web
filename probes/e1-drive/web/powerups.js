// Power-up slice for the E1 online race (M2/PWR2).
//
// This module is deliberately DOM-free and dependency-injected:
//   * the browser passes `createWorld` from `probes/powerups/rules/engine.js`
//     (served read-only at `/powerups/engine.js`) and the manifest from
//     `_work/powerups/powerups.json`;
//   * the Node verifier passes the same `createWorld` from the committed probe.
//
// Integrated in this slice: Bomb/Mine, Shield, Repair, pickup/collection,
// damage/wreck/respawn, HUD/events. Nitro/Shock/Shunt/Blindfire/Barge and every
// projectile are deferred (see POWERUP_DEFERRED): the shipped data has no
// serialized projectile lifetime/hit test/human targeting and the wasm module
// exposes no proven boost/impulse hook, so applying them would be a guess.
//
// The prototype's recovered values are never copied or re-typed here: every
// number comes from the manifest through `createWorld`. This file only adds the
// host loop around it (proximity collection, arm events, wreck/respawn), the
// provisional measured-arc placement and a client event reducer.

export const POWERUP_SCHEMA = 'e1-drive.powerups/1';
export const POWERUP_SLICE_TYPES = Object.freeze(['Bomb', 'Shield', 'Repair']);
export const POWERUP_SLICE_LABELS = Object.freeze({
  Bomb: 'MINE',
  Shield: 'SHIELD',
  Repair: 'REPAIR'
});

// A collection of *provable* reasons, not a roadmap promise.
export const POWERUP_DEFERRED = Object.freeze({
  Nitrous: 'no proven engine boost hook: the wasm ABI has no verified speed/torque override, and the Nitrous balancing graph is not wired to a physics input.',
  Shock: 'projectile/area lifetime exists but the hit test and falloff law are not serialized (PWR1 UNKNOWNS.projectileLifetime/damageFalloff).',
  Shunt: 'projectile speed/damage are serialized; lifetime, hit volume and targeting are runtime-only.',
  Blindfire: 'projectile speed/damage are serialized; lifetime, bolt count/charges and targeting are runtime-only.',
  Barge: 'mine push forces are serialized but there is no verified physics-impulse hook in the wasm ABI.',
  SuperShield: 'single-player-only PickupType (no multiplayer flag); its boost/mass fields need the same missing physics hook.'
});

// Provisional placement on the measured 310 m P48 arc. PWR3 is recovering the
// real level/actor placement separately; these arcs are a documented project
// choice, not retail data. The plan is a pure function of the committed layout.
export const POWERUP_PLACEMENT_ARCS = Object.freeze([40, 90, 140, 190, 240, 280]);
export const POWERUP_PLACEMENT_TYPES = Object.freeze(['Bomb', 'Shield', 'Repair', 'Bomb', 'Shield', 'Repair']);
export const POWERUP_PLACEMENT_NOTE =
  'provisional measured-arc pickup placement (PWR3 owns the real level/actor placement; these arcs are project-specific, not retail)';

const TICK_HZ = 60;
const round6 = (value) => Math.round(value * 1e6) / 1e6;

function positionOf(value) {
  if (!value) return { x: 0, y: 0, z: 0 };
  if (Array.isArray(value)) return { x: value[0] ?? 0, y: value[1] ?? 0, z: value[2] ?? 0 };
  return { x: value.x ?? 0, y: value.y ?? 0, z: value.z ?? 0 };
}

function planarDistance(a, b) {
  return Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.z ?? 0) - (b?.z ?? 0));
}

/** Rotate the engine's local +Z (forward) by a unit quaternion. */
export function forwardFromQuaternion(quaternion) {
  if (!Array.isArray(quaternion) || quaternion.length < 4) return null;
  const [x, y, z, w] = quaternion;
  // R * (0,0,1) = third column of the rotation matrix.
  const fx = 2 * (x * z + w * y);
  const fy = 2 * (y * z - w * x);
  const fz = 1 - 2 * (x * x + y * y);
  const length = Math.hypot(fx, fy, fz);
  if (!(length > 0)) return null;
  return { x: fx / length, y: fy / length, z: fz / length };
}

/** Nearest measured sample for an arc; no interpolation, no invented point. */
export function measuredArcPosition(layout, arc) {
  const samples = layout?.course?.samples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('power-up placement needs the committed measured course samples');
  }
  let best = samples[0];
  let bestDelta = Math.abs((best.arc ?? 0) - arc);
  for (const sample of samples) {
    const delta = Math.abs((sample.arc ?? 0) - arc);
    if (delta < bestDelta) { best = sample; bestDelta = delta; }
  }
  return { x: best.x, y: best.groundY ?? best.height ?? 0, z: best.z, arc: best.arc, sampleIndex: samples.indexOf(best) };
}

/**
 * Provisional pickup plan: one item on each measured arc, cycling the three
 * integrated types. Every entry carries the placement label and the source
 * sample so the HUD/evidence can state exactly what was placed.
 */
export function provisionalPickupPlan(layout, options = {}) {
  const arcs = options.arcs ?? POWERUP_PLACEMENT_ARCS;
  const types = options.types ?? POWERUP_PLACEMENT_TYPES;
  return arcs.map((arc, index) => {
    const sample = measuredArcPosition(layout, arc);
    return {
      pickupType: types[index % types.length],
      arc: sample.arc,
      sampleIndex: sample.sampleIndex,
      position: { x: sample.x, y: sample.y, z: sample.z },
      placement: 'provisional-measured-arc',
      note: POWERUP_PLACEMENT_NOTE
    };
  });
}

/**
 * Host-side power-up model.
 *
 * `createWorld` must be the PWR1 prototype factory. The model never re-types a
 * balancing value; the only project constants are the diagnostic health pool,
 * respawn delay and provisional placement, all labelled in the snapshot.
 */
export function createPowerupModel({
  manifest,
  createWorld,
  authorityId = 'host',
  maxHealth = 100,
  respawnDelaySeconds = 1.0,
  normalRespawnSeconds = null,
  inventoryCapacity = 1
} = {}) {
  if (!manifest || !Array.isArray(manifest.entities)) throw new Error('power-up model needs the PWR1 manifest');
  if (typeof createWorld !== 'function') throw new Error('power-up model needs the PWR1 createWorld factory');

  const world = createWorld(manifest, {
    authorityId,
    mode: 'Normal',
    normalRespawnSeconds
  });
  const catalog = world.catalog;
  const bombDefinition = catalog.entities.get('Bomb');
  const bombLevel = bombDefinition?.levels?.Normal;
  const placeBehindDistance = bombLevel?.values?.PlaceBehindDistance ?? 0;

  const model = {
    schema: POWERUP_SCHEMA,
    world,
    catalog,
    manifestHash: catalog.manifestHash,
    authorityId,
    maxHealth,
    respawnDelaySeconds,
    normalRespawnSeconds,
    inventoryCapacity,
    // Diagnostic labels: these are project constants, not recovered retail data.
    labels: {
      healthScale: 'runtime-only: 100 HP diagnostic pool (PWR1 healthScale is runtime-only)',
      respawnDelay: 'provisional diagnostic ' + respawnDelaySeconds + ' s wreck delay (Normal respawn seconds are not serialized)',
      inventoryCapacity: 'runtime-only: one active slot (PWR1 pickupInventoryCapacity is runtime-only)',
      inventoryOnRespawn: 'kept (inventory-on-respawn is not serialized)',
      shieldAbsorb: 'prototype-assumption: ShieldBalancingData.Health is treated as shield HP',
      minePrime: 'prototype-assumption: MasterMinePrimeTimer is used as the arming delay',
      minePlacement: 'Bomb PlaceBehindDistance=' + placeBehindDistance + ' m behind the owner, using the engine forward axis',
      damageFalloff: 'not-serialized: full Bomb damage inside Radius, no damage outside OuterRadius, near-miss is a typed event',
      tickRate: TICK_HZ
    },
    placement: {
      mode: 'provisional-measured-arc',
      arcs: POWERUP_PLACEMENT_ARCS.slice(),
      types: POWERUP_PLACEMENT_TYPES.slice(),
      note: POWERUP_PLACEMENT_NOTE,
      pwr3Recovery: 'real pickup placement is not in the PWR1 packs'
    },
    deferred: { ...POWERUP_DEFERRED },

    get now() { return world.now; },
    get events() { return world.events; },
    get players() { return world.players; },
    get pickups() { return world.pickups; },
    get mines() { return world.mines; },
    get effects() { return world.effects; },

    addPlayer(id, options = {}) {
      const player = world.addPlayer(id, {
        health: options.health ?? maxHealth,
        maxHealth: options.maxHealth ?? maxHealth,
        inventoryCapacity: options.inventoryCapacity ?? inventoryCapacity,
        position: positionOf(options.position)
      });
      player.forward = options.forward ? { ...options.forward } : { x: 0, y: 0, z: 1 };
      player.respawnAt = null;
      player.forwardXZ = options.forward ?? null;
      return player;
    },

    setPlayerState(id, state = {}) {
      const player = world.players.get(id);
      if (!player) return null;
      const position = positionOf(state.position ?? state);
      player.position = { x: position.x, y: position.y, z: position.z };
      const forward = state.forward
        ?? (state.quaternion ? forwardFromQuaternion(state.quaternion) : null);
      if (forward) player.forward = { x: forward.x, y: forward.y ?? 0, z: forward.z };
      return player;
    },

    spawnPickup(pickupType, position, options = {}) {
      if (!POWERUP_SLICE_TYPES.includes(pickupType)) {
        throw new Error('power-up slice does not spawn ' + JSON.stringify(pickupType) +
          ' (deferred: ' + (POWERUP_DEFERRED[pickupType] ?? 'not integrated') + ')');
      }
      const item = world.spawnPickup(pickupType, positionOf(position), options);
      const event = world.events[world.events.length - 1];
      if (event?.type === 'pickup-spawned') {
        event.source = options.source ?? 'host';
        event.placement = options.placement ?? 'host';
        if (options.arc !== undefined) event.arc = options.arc;
        if (options.sampleIndex !== undefined) event.sampleIndex = options.sampleIndex;
        if (options.note) event.note = options.note;
      }
      return item;
    },

    spawnProvisionalPickups(layout) {
      const plan = provisionalPickupPlan(layout);
      const spawned = [];
      for (const entry of plan) {
        const item = model.spawnPickup(entry.pickupType, entry.position, {
          source: 'provisional-plan',
          placement: entry.placement,
          arc: entry.arc,
          sampleIndex: entry.sampleIndex,
          note: entry.note
        });
        spawned.push({ id: item.id, ...entry });
      }
      return spawned;
    },

    collect(pickupId, playerId) {
      return world.pickup(pickupId, playerId);
    },

    /**
     * Host validation for a client's use intent. `position` is an optional
     * host-only staging override (capture diagnostics); the normal path derives
     * a Bomb position from the recovered PlaceBehindDistance and the owner's
     * forward axis.
     */
    requestUse(playerId, request = {}) {
      const start = world.events.length;
      const player = world.players.get(playerId);
      if (!player) {
        world.emit('use-rejected', { playerId, reason: 'no-player' });
        return world.events.slice(start);
      }
      if (!player.alive) {
        world.emit('use-rejected', { playerId, reason: 'wrecked' });
        return world.events.slice(start);
      }
      const slot = request.slot ?? 0;
      const item = player.inventory[slot];
      if (!item) {
        world.emit('use-rejected', { playerId, reason: 'empty-inventory' });
        return world.events.slice(start);
      }
      if (!POWERUP_SLICE_TYPES.includes(item.type)) {
        world.emit('use-rejected', {
          playerId,
          pickupType: item.type,
          reason: 'not-in-slice',
          deferred: POWERUP_DEFERRED[item.type] ?? 'not integrated in this slice'
        });
        return world.events.slice(start);
      }
      if (world.now < player.nextUseAt) {
        world.emit('use-rejected', { playerId, reason: 'cooldown', nextUseAt: player.nextUseAt });
        return world.events.slice(start);
      }
      let position = request.position ? positionOf(request.position) : null;
      if (!position && item.type === 'Bomb') {
        const forward = player.forward ?? { x: 0, y: 0, z: 1 };
        position = {
          x: player.position.x - forward.x * placeBehindDistance,
          y: player.position.y,
          z: player.position.z - forward.z * placeBehindDistance
        };
      }
      world.use(playerId, { slot, position: position ?? player.position });
      const event = world.events[world.events.length - 1];
      if (event?.type === 'mine-placed' && request.staged === true) event.staged = true;
      return world.events.slice(start);
    },

    /** Capture staging: spawn an item on the player and collect it immediately. */
    grantItem(playerId, pickupType, options = {}) {
      const player = world.players.get(playerId);
      if (!player) throw new Error('grantItem needs a known player');
      const offset = options.forwardOffset ?? 0.5;
      const forward = player.forward ?? { x: 0, y: 0, z: 1 };
      const position = {
        x: player.position.x + forward.x * offset,
        y: player.position.y,
        z: player.position.z + forward.z * offset
      };
      const item = model.spawnPickup(pickupType, position, {
        source: 'capture-staged',
        placement: 'capture-staged'
      });
      model.collect(item.id, playerId);
      return item;
    },

    clearInventory(playerId) {
      const player = world.players.get(playerId);
      if (!player) return;
      player.inventory.length = 0;
      player.nextUseAt = world.now;
    },

    /** Capture staging: place a mine at an explicit host position (no guessed value). */
    placeMineForPlayer(playerId, position) {
      const player = world.players.get(playerId);
      if (!player) throw new Error('placeMineForPlayer needs a known player');
      const before = player.inventory.slice();
      const beforeUse = player.nextUseAt;
      player.inventory.push({ type: 'Bomb', level: 'Normal' });
      player.nextUseAt = 0;
      const events = model.requestUse(playerId, {
        slot: player.inventory.length - 1,
        position,
        staged: true
      });
      player.inventory = before;
      player.nextUseAt = beforeUse;
      return events;
    },

    /**
     * Advance the host world by one fixed tick. `states` is a map id ->
     * {position, quaternion|forward}. Returns this tick's events.
     */
    tick(dt, states = {}, respawnTargetFor = null) {
      const start = world.events.length;
      for (const [id, state] of Object.entries(states)) model.setPlayerState(id, state);

      // Collection is a host proximity check against the recovered
      // PickupRadius. The prototype's pickup() has no distance logic.
      const radius = catalog.system.radius;
      for (const item of [...world.pickups.values()]) {
        if (item.state !== 'active') continue;
        for (const player of world.players.values()) {
          if (!player.alive) continue;
          if (planarDistance(player.position, item.position) <= radius) {
            world.pickup(item.id, player.id);
            break;
          }
        }
      }

      // A mine arms at MasterMinePrimeTimer before it can detonate.
      const predictedNow = world.now + dt;
      for (const mine of world.mines) {
        if (mine.armed === true || predictedNow < mine.armAt) continue;
        mine.armed = true;
        const event = world.emit('mine-armed', {
          mineId: mine.id,
          position: mine.position,
          armAt: mine.armAt,
          primeSeconds: round6(Math.max(0, mine.armAt - world.now)),
          source: 'MasterMinePrimeTimer'
        });
        event.at = mine.armAt;
      }

      world.advance(dt);

      // Wreck scheduling and the R1 respawn target. The prototype has no
      // respawn; this wrapper adds the project rules-layer behaviour.
      for (const player of world.players.values()) {
        if (!player.alive && player.respawnAt === null) {
          player.respawnAt = world.now + respawnDelaySeconds;
        }
        if (player.alive || player.respawnAt === null) continue;
        if (world.now + 1e-9 < player.respawnAt) continue;
        const target = respawnTargetFor ? respawnTargetFor(player.id) : null;
        if (!target) {
          player.respawnAt = null;
          world.emit('respawn-unresolved', {
            playerId: player.id,
            status: 'not-serialized',
            field: 'race-rules respawn target',
            reason: 'no committed respawn target was supplied by the host rules layer'
          });
          continue;
        }
        player.alive = true;
        player.health = player.maxHealth;
        player.respawnAt = null;
        player.position = {
          x: target.x,
          y: target.y ?? player.position.y,
          z: target.z
        };
        if (Number.isFinite(target.headingRad)) player.headingRad = target.headingRad;
        world.emit('respawn', {
          playerId: player.id,
          health: player.health,
          maxHealth: player.maxHealth,
          target: { ...target },
          source: 'race-rules-respawn-target',
          delaySeconds: respawnDelaySeconds,
          inventoryOnRespawn: 'kept (not-serialized)',
          healthScale: model.labels.healthScale
        });
      }

      return world.events.slice(start);
    },

    snapshot() {
      return {
        schema: POWERUP_SCHEMA,
        authority: authorityId,
        now: round6(world.now),
        provisionalPlacement: model.placement.mode,
        placement: { ...model.placement, arcs: model.placement.arcs.slice(), types: model.placement.types.slice() },
        labels: { ...model.labels },
        players: [...world.players.values()]
          .map((player) => ({
            id: player.id,
            health: round6(player.health),
            maxHealth: player.maxHealth,
            alive: player.alive,
            inventory: player.inventory.map((item) => ({ type: item.type, level: item.level })),
            position: { x: round6(player.position.x), y: round6(player.position.y ?? 0), z: round6(player.position.z) },
            respawnAt: player.respawnAt === null ? null : round6(player.respawnAt)
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        pickups: [...world.pickups.values()]
          .map((item) => ({
            id: item.id,
            type: item.type,
            state: item.state,
            position: { ...item.position },
            respawnAt: item.respawnAt,
            sourceRecord: item.sourceRecord
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        mines: world.mines.map((mine) => ({
          id: mine.id,
          ownerId: mine.ownerId,
          position: { ...mine.position },
          radius: mine.radius,
          outerRadius: mine.outerRadius,
          damage: mine.damage,
          armAt: round6(mine.armAt),
          expiresAt: round6(mine.expiresAt),
          armed: mine.armed === true
        })),
        effects: world.effects.map((effect) => ({
          id: effect.id,
          kind: effect.kind,
          ownerId: effect.ownerId,
          expiresAt: round6(effect.expiresAt),
          capacity: effect.capacity ?? null,
          maxCapacity: effect.maxCapacity ?? null
        })),
        eventCount: world.events.length
      };
    }
  };

  return model;
}

/** Client-side reducer over the host's sequenced event batches + snapshots. */
export function createPowerupView({ localId = null, remoteId = null, now = 0 } = {}) {
  return {
    schema: POWERUP_SCHEMA,
    localId,
    remoteId,
    now,
    players: {},
    pickups: {},
    mines: {},
    effects: {},
    feed: [],
    counts: {},
    lastEventSeq: 0,
    lastBatchSeq: 0,
    relayError: null,
    lastEvent: null
  };
}

const EVENT_TEXT = {
  'pickup-spawned': (event) => 'pickup spawned ' + (event.pickupType ?? ''),
  pickup: (event) => 'picked up ' + (event.pickupType ?? ''),
  'pickup-rejected': (event) => 'pickup rejected: ' + (event.reason ?? ''),
  'pickup-respawn': (event) => 'pickup respawn ' + (event.pickupType ?? ''),
  'respawn-unresolved': (event) => 'pickup respawn unresolved',
  'mine-placed': (event) => 'mine placed',
  'mine-armed': () => 'mine armed',
  'mine-detonated': (event) => 'mine detonated · ' + (event.directHits?.length ?? 0) + ' direct, ' +
    (event.nearMisses?.length ?? 0) + ' near',
  'mine-near-miss': () => 'mine near miss',
  'mine-expired': () => 'mine expired',
  'shield-activated': () => 'shield activated',
  'shield-absorbed': (event) => 'shield absorbed ' + (event.absorbed ?? 0) +
    ' · ' + (event.capacity ?? 0) + ' left',
  'shield-broken': () => 'shield broken',
  repaired: (event) => 'repaired +' + (event.amount ?? 0) + ' · ' + (event.health ?? '—') + ' HP',
  damage: (event) => 'damage -' + (event.amount ?? 0) + ' · ' + (event.health ?? '—') + ' HP',
  wrecked: () => 'WRECKED',
  respawn: (event) => 'respawn · ' + (event.health ?? '—') + ' HP · ' +
    (event.target?.gateId ?? event.target?.gateIndex ?? 'target'),
  'effect-expired': (event) => (event.kind ?? 'effect') + ' expired',
  'use-rejected': (event) => 'use rejected: ' + (event.reason ?? ''),
  'player-joined': () => 'player joined'
};

export function powerupEventText(event) {
  if (!event) return '';
  return EVENT_TEXT[event.type] ? EVENT_TEXT[event.type](event) : event.type;
}

function mergeSnapshot(view, snapshot) {
  if (!snapshot) return;
  if (Number.isFinite(snapshot.now)) view.now = snapshot.now;
  view.players = {};
  for (const player of snapshot.players ?? []) {
    view.players[player.id] = {
      ...player,
      inventory: (player.inventory ?? []).map((item) => ({ ...item })),
      position: { ...(player.position ?? { x: 0, y: 0, z: 0 }) }
    };
  }
  view.pickups = {};
  for (const pickup of snapshot.pickups ?? []) view.pickups[pickup.id] = { ...pickup, position: { ...pickup.position } };
  view.mines = {};
  for (const mine of snapshot.mines ?? []) view.mines[mine.id] = { ...mine, position: { ...mine.position } };
  view.effects = {};
  for (const effect of snapshot.effects ?? []) view.effects[effect.id] = { ...effect };
  view.snapshotLabels = snapshot.labels ?? view.snapshotLabels ?? null;
  view.placement = snapshot.placement ?? view.placement ?? null;
}

/**
 * Apply one host batch: `{batchSeq, now, events[], snapshot}`. The snapshot is
 * authoritative for the rendered state; the sequenced events are still applied
 * for the feed/counters (and as a fallback before the first snapshot arrives).
 */
export function applyPowerupBatch(view, batch) {
  if (!view || !batch) return view;
  if (Number.isInteger(batch.batchSeq) && batch.batchSeq <= view.lastBatchSeq) return view;
  if (Number.isInteger(batch.batchSeq)) view.lastBatchSeq = batch.batchSeq;
  if (Number.isFinite(batch.now)) view.now = batch.now;
  const hasSnapshot = Boolean(batch.snapshot);
  if (hasSnapshot) mergeSnapshot(view, batch.snapshot);
  for (const event of batch.events ?? []) {
    if (!event || !Number.isInteger(event.seq) || event.seq <= view.lastEventSeq) continue;
    view.lastEventSeq = event.seq;
    view.lastEvent = event;
    view.counts[event.type] = (view.counts[event.type] ?? 0) + 1;
    const text = powerupEventText(event);
    view.feed.push({
      seq: event.seq,
      type: event.type,
      at: event.at ?? null,
      playerId: event.playerId ?? event.targetId ?? event.ownerId ?? null,
      pickupType: event.pickupType ?? null,
      text
    });
    if (view.feed.length > 24) view.feed.splice(0, view.feed.length - 24);
    if (!hasSnapshot) applyEventOnly(view, event);
  }
  return view;
}

/** Fallback reducer used only if a batch carries no snapshot. */
function applyEventOnly(view, event) {
  const player = (id) => view.players[id];
  switch (event.type) {
    case 'pickup-spawned':
      if (event.pickupId) view.pickups[event.pickupId] = {
        id: event.pickupId, type: event.pickupType, state: 'active', position: { ...event.position }
      };
      break;
    case 'pickup': {
      delete view.pickups[event.pickupId];
      const target = player(event.playerId);
      if (target) target.inventory = [...(target.inventory ?? []), { type: event.pickupType, level: 'Normal' }];
      break;
    }
    case 'mine-placed':
      if (event.mine) view.mines[event.mine.id] = { ...event.mine, position: { ...event.mine.position } };
      break;
    case 'mine-armed': {
      const mine = view.mines[event.mineId];
      if (mine) mine.armed = true;
      break;
    }
    case 'mine-detonated':
    case 'mine-expired':
      delete view.mines[event.mineId];
      break;
    case 'shield-activated':
      if (event.effect) view.effects[event.effect.id] = { ...event.effect };
      break;
    case 'shield-absorbed': {
      const effect = view.effects[event.effectId];
      if (effect) effect.capacity = event.capacity;
      break;
    }
    case 'shield-broken':
      delete view.effects[event.effectId];
      break;
    case 'effect-expired':
      delete view.effects[event.effectId];
      break;
    case 'damage':
    case 'repaired': {
      const target = player(event.targetId ?? event.playerId);
      if (target && Number.isFinite(event.health)) target.health = event.health;
      break;
    }
    case 'wrecked': {
      const target = player(event.targetId);
      if (target) { target.alive = false; target.health = 0; }
      break;
    }
    case 'respawn': {
      const target = player(event.playerId);
      if (target) {
        target.alive = true;
        target.health = event.health;
        if (event.target) target.position = { x: event.target.x, y: event.target.y ?? target.position.y, z: event.target.z };
      }
      break;
    }
    default:
      break;
  }
}

/** The local player's active shield effect, if any. */
export function shieldFor(view, playerId) {
  return Object.values(view?.effects ?? {})
    .find((effect) => effect.ownerId === playerId && (effect.kind === 'shield' || effect.kind === 'superShield')) ?? null;
}

/** Compact HUD/evidence projection of the client view. */
export function powerupViewSummary(view) {
  if (!view) return null;
  const local = view.localId ? view.players[view.localId] ?? null : null;
  const remote = view.remoteId ? view.players[view.remoteId] ?? null : null;
  const shield = view.localId ? shieldFor(view, view.localId) : null;
  return {
    now: view.now,
    localId: view.localId,
    remoteId: view.remoteId,
    local,
    remote,
    shield: shield ? {
      id: shield.id,
      capacity: shield.capacity,
      maxCapacity: shield.maxCapacity,
      expiresAt: shield.expiresAt,
      secondsLeft: Math.max(0, shield.expiresAt - view.now)
    } : null,
    pickups: Object.values(view.pickups),
    mines: Object.values(view.mines),
    effects: Object.values(view.effects),
    feed: view.feed.slice(-8),
    counts: { ...view.counts },
    lastEventSeq: view.lastEventSeq,
    lastBatchSeq: view.lastBatchSeq,
    relayError: view.relayError,
    placement: view.placement ?? null
  };
}
