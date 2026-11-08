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

import {
  M2_BOOST_DELAY_TICKS, M2_BOOST_LABELS, M2_BOOST_MAGNITUDE_MPS2, M2_NITRO_CAP_MPS,
  M2_NITRO_CLASS, M2_NITRO_CLASS_SOURCE, M2_NITRO_DURATION_TICKS, M2_REFERENCE_SPRINT_SPEED_MPS,
  M2_SHOCK_DURATION_TICKS, M2_SHOCK_MIN_SCRUB_MPH, keyframesFromLevel,
  nitroClassTargetTable, nitroTargetForSpeed, shockTargetForSpeed
} from './boost-model.js';

export const POWERUP_SCHEMA = 'e1-drive.powerups/1';
export const POWERUP_SLICE_TYPES = Object.freeze([
  'Bomb', 'Shield', 'Repair', 'Nitrous', 'Shock', 'Blindfire', 'Shunt', 'Barge'
]);
export const POWERUP_PROJECTILE_TYPES = Object.freeze(['Blindfire', 'Shunt', 'Barge']);
export const POWERUP_SLICE_LABELS = Object.freeze({
  Bomb: 'MINE',
  Shield: 'SHIELD',
  Repair: 'REPAIR',
  Nitrous: 'NITRO',
  Shock: 'SHOCK',
  Blindfire: 'BLINDFIRE',
  Shunt: 'SHUNT',
  Barge: 'BARGE'
});

// A collection of *provable* reasons, not a roadmap promise. Only SuperShield
// remains outside the slice; Blindfire/Shunt/Barge are driven by the PWR4
// projectile model (recovered XT values + typed runtime-only fields).
export const POWERUP_DEFERRED = Object.freeze({
  SuperShield: 'single-player-only PickupType (no multiplayer flag); its boost/mass fields need the same missing physics hook.'
});

// Documented project car envelope, not a recovered retail hull. Source:
// probes/prop-collision/lib/collider-build.mjs CAR_ENVELOPE (2.98 x 1.68 x 1.35).
// The target sphere radius is the OBB circumradius, which equals the committed
// sprint-layout carCircumradiusMetres 1.710 (sqrt(1.49^2 + 0.84^2) = 1.7105).
export const POWERUP_CAR_ENVELOPE = Object.freeze({
  length: 2.98,
  width: 1.68,
  height: 1.35,
  source: 'probes/prop-collision/lib/collider-build.mjs CAR_ENVELOPE (documented maximum XT envelope, not a recovered retail hull)'
});
export const POWERUP_TARGET_RADIUS_M = Math.hypot(
  POWERUP_CAR_ENVELOPE.length / 2,
  POWERUP_CAR_ENVELOPE.width / 2
);
export const POWERUP_SHUNT_MAX_TARGET_M = 500;
export const POWERUP_SHUNT_MIN_FORWARD_DOT = Math.SQRT1_2; // cos 45 deg
export const POWERUP_PROVISIONAL_SHUNT_IMPULSE_NS = 20000; // BOOST1 provisional design choice, not retail
// Provisional placement on the measured 310 m P48 arc. PWR3 is recovering the
// real level/actor placement separately; these arcs are a documented project
// choice, not retail data. The plan is a pure function of the committed layout.
export const POWERUP_PLACEMENT_ARCS = Object.freeze([40, 90, 140, 190, 240, 280]);
export const POWERUP_PLACEMENT_TYPES = Object.freeze(['Bomb', 'Shield', 'Repair', 'Nitrous', 'Shock', 'Bomb']);
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
  projectileManifest = null,
  createProjectileModel = null,
  authorityId = 'host',
  maxHealth = 100,
  respawnDelaySeconds = 1.0,
  normalRespawnSeconds = null,
  inventoryCapacity = 1,
  provisionalShuntImpulseNs = POWERUP_PROVISIONAL_SHUNT_IMPULSE_NS
} = {}) {
  if (!manifest || !Array.isArray(manifest.entities)) throw new Error('power-up model needs the PWR1 manifest');
  if (typeof createWorld !== 'function') throw new Error('power-up model needs the PWR1 createWorld factory');
  if (projectileManifest && typeof createProjectileModel !== 'function') {
    throw new Error('power-up model needs the PWR4 createProjectileModel factory when a projectile manifest is supplied');
  }
  if (projectileManifest && projectileManifest.schema !== 'blur-powerups-projectiles/1') {
    throw new Error('projectile manifest schema is not blur-powerups-projectiles/1');
  }

  const world = createWorld(manifest, {
    authorityId,
    mode: 'Normal',
    normalRespawnSeconds
  });
  const projectiles = projectileManifest
    ? createProjectileModel(projectileManifest, { authorityId })
    : null;
  const projectileRuntime = projectileManifest?.runtimeValues ?? null;
  const projectileDirections = new Map();
  // Pickup id -> the measured arc it was placed at (provisional placement only).
  const pickupArcs = new Map();
  // PWR4 owns hit judgement; the PWR1 world owns the health/shield/wreck model.
  // The internal damage call is replaced so a hit is applied exactly once,
  // through world.damage() (shield absorb included).
  if (projectiles) projectiles.damage = () => null;
  const catalog = world.catalog;
  const bombDefinition = catalog.entities.get('Bomb');
  const bombLevel = bombDefinition?.levels?.Normal;
  const placeBehindDistance = bombLevel?.values?.PlaceBehindDistance ?? 0;
  const nitroDefinition = catalog.entities.get('Nitrous');
  const nitroLevel = nitroDefinition?.levels?.Normal;
  const shockDefinition = catalog.entities.get('Shock');
  const shockLevel = shockDefinition?.levels?.Normal;
  const nitroKeyframes = keyframesFromLevel(nitroLevel);
  const shockKeyframes = keyframesFromLevel(shockLevel);
  const nitroModifiers = {
    A: nitroLevel.values.ClassAModifier,
    B: nitroLevel.values.ClassBModifier,
    C: nitroLevel.values.ClassCModifier,
    D: nitroLevel.values.ClassDModifier
  };
  const shockValues = shockLevel.values;

  // ---------------------------------------------------------- projectile bridge
  // PWR4 judges travel/hit/expiry; this wrapper owns host sequencing, charges,
  // and applies every hit through the PWR1 world so shields/wreck/respawn stay
  // in one place. Missing values are typed, never guessed.
  function projectileChargesOf(playerId, type) {
    return projectiles ? projectiles.charges(playerId, type) : 0;
  }

  function projectileMaxCharges(type) {
    const value = projectileRuntime?.[type]?.charges;
    return Number.isFinite(value) ? value : null;
  }

  function projectileDelay(type, level = 'Normal') {
    const value = projectileManifest?.types?.[type]?.levels?.[level]?.fields?.Delay?.value;
    return Number.isFinite(value) ? value : 0;
  }

  function ensureProjectileCharges(playerId, type) {
    if (!projectiles || !POWERUP_PROJECTILE_TYPES.includes(type)) return 0;
    const charges = projectileMaxCharges(type);
    if (!Number.isFinite(charges)) return 0;
    return projectiles.addInventory(playerId, type, charges);
  }

  function projectileCarConfig(player) {
    return {
      position: { ...player.position },
      forward: player.forward ?? { x: 0, y: 0, z: 1 },
      speedMps: player.speedMps ?? 0,
      massKg: player.massKg ?? null,
      radiusM: POWERUP_TARGET_RADIUS_M,
      extents: {
        x: POWERUP_CAR_ENVELOPE.length,
        y: POWERUP_CAR_ENVELOPE.height,
        z: POWERUP_CAR_ENVELOPE.width
      },
      health: player.health,
      maxHealth: player.maxHealth,
      alive: player.alive
    };
  }

  function syncProjectileCars() {
    if (!projectiles) return;
    for (const player of world.players.values()) {
      const existing = projectiles.cars.get(player.id);
      if (!existing) {
        projectiles.addCar(player.id, projectileCarConfig(player));
        continue;
      }
      existing.position = { ...player.position };
      existing.forward = { ...(player.forward ?? { x: 0, y: 0, z: 1 }) };
      existing.speedMps = player.speedMps ?? 0;
      existing.massKg = player.massKg ?? null;
      existing.health = player.health;
      existing.maxHealth = player.maxHealth;
      existing.alive = player.alive;
    }
  }

  function buildProvisionalImpulse(targetId, hitType, direction) {
    const target = world.players.get(targetId) ?? null;
    const massKg = target?.massKg ?? null;
    const impulse = {
      status: 'provisional-impulse',
      source: 'provisional-impulse',
      impulseNs: provisionalShuntImpulseNs,
      massKg,
      direction: direction ? { ...direction } : null,
      retailEquivalent: hitType === 'major'
        ? 'E_FAKE_PHYSICS_FLIP_FORWARD' : 'E_FAKE_PHYSICS_TIP_FORWARD',
      label: 'BOOST1 ' + provisionalShuntImpulseNs + ' N*s design choice; retail fake-physics magnitude is not-serialized'
    };
    if (!Number.isFinite(massKg) || massKg <= 0) {
      impulse.status = 'missing-input';
      impulse.required = ['massKg'];
      return impulse;
    }
    if (!direction || !(Math.hypot(direction.x, direction.y, direction.z) > 0)) {
      impulse.status = 'missing-input';
      impulse.required = ['direction'];
      return impulse;
    }
    impulse.deltaV = round6(provisionalShuntImpulseNs / massKg);
    return impulse;
  }

  function translateProjectileEvents(raw, extra = {}) {
    const translated = [];
    if (!Array.isArray(raw)) return translated;
    for (const rawEvent of raw) {
      const { seq, authority, at, ...data } = rawEvent;
      const type = rawEvent.type;
      if (type === 'projectile-hit' || type === 'barge-hit' || type === 'shock-hit') {
        const event = world.emit(type, { ...data, ...extra });
        const source = data.pickupType ? data.pickupType : (data.bargeId ? 'Barge' : 'projectile');
        const result = world.damage(data.targetId, data.damage, {
          kind: source,
          projectileId: data.projectileId ?? null,
          bargeId: data.bargeId ?? null,
          hitType: data.hitType ?? null,
          staged: extra.staged === true
        });
        event.appliedDamage = result.remaining;
        event.absorbed = result.absorbed;
        event.health = result.health;
        event.healthScale = 'runtime-only: 100 HP diagnostic pool';
        translated.push(event);
      } else if (type === 'shunt-hit') {
        const direction = projectileDirections.get(data.projectileId) ?? null;
        const impulse = buildProvisionalImpulse(data.targetId, data.hitType, direction);
        translated.push(world.emit('shunt-hit', { ...data, impulse, ...extra }));
        projectileDirections.delete(data.projectileId);
      } else {
        if (type === 'projectile-expired') projectileDirections.delete(data.projectileId);
        translated.push(world.emit(type, { ...data, ...extra }));
      }
    }
    return translated;
  }

  /**
   * Recovered human Shunt target rule (VehicleLogicActor.cpp:2056-2222): no
   * self/wrecked target, planar distance <= 500 m, forward dot > cos 45 deg,
   * lowest score (1 - dot) * sqrt(distance / 500). The host has no camera
   * line-of-sight, so the car's engine forward is used and labelled.
   */
  function selectShuntTarget(ownerId) {
    const owner = world.players.get(ownerId);
    if (!owner) return { targetId: null, reason: 'no-owner' };
    const forward = owner.forward ?? { x: 0, y: 0, z: 1 };
    const forwardLength = Math.hypot(forward.x, forward.z) || 1;
    let best = null;
    for (const candidate of world.players.values()) {
      if (candidate.id === ownerId || !candidate.alive) continue;
      const dx = candidate.position.x - owner.position.x;
      const dz = candidate.position.z - owner.position.z;
      const distanceM = Math.hypot(dx, dz);
      if (!(distanceM > 0) || distanceM > POWERUP_SHUNT_MAX_TARGET_M) continue;
      const dotForward = (dx * forward.x + dz * forward.z) / (distanceM * forwardLength);
      if (!(dotForward > POWERUP_SHUNT_MIN_FORWARD_DOT)) continue;
      const score = (1 - dotForward) * Math.sqrt(distanceM / POWERUP_SHUNT_MAX_TARGET_M);
      if (!best || score < best.score) {
        best = { targetId: candidate.id, score: round6(score), distanceM: round6(distanceM), dotForward: round6(dotForward) };
      }
    }
    if (!best) {
      return {
        targetId: null,
        reason: 'no-eligible-target',
        rule: {
          maxDistanceM: POWERUP_SHUNT_MAX_TARGET_M,
          minForwardDot: POWERUP_SHUNT_MIN_FORWARD_DOT,
          source: 'VehicleLogicActor.cpp:2056-2222 (host forward cone; camera LOS not modelled)'
        }
      };
    }
    return {
      ...best,
      rule: {
        maxDistanceM: POWERUP_SHUNT_MAX_TARGET_M,
        minForwardDot: POWERUP_SHUNT_MIN_FORWARD_DOT,
        score: '(1 - dotForward) * sqrt(distance / 500)',
        source: 'VehicleLogicActor.cpp:2056-2222 (host forward cone; camera LOS not modelled)'
      }
    };
  }

  function fireProjectileItem(player, item, slot, request) {
    const start = world.events.length;
    if (!projectiles) {
      world.emit('use-rejected', {
        playerId: player.id, pickupType: item.type, reason: 'projectile-model-unavailable',
        missing: 'PWR4 projectile manifest/model was not supplied to the host model'
      });
      return world.events.slice(start);
    }
    const type = item.type;
    const level = item.level ?? 'Normal';
    const chargesBefore = projectileChargesOf(player.id, type);
    if (!(chargesBefore > 0)) {
      world.emit('use-rejected', {
        playerId: player.id, pickupType: type, reason: 'no-ammo',
        charges: chargesBefore,
        chargesSource: { status: 'runtime-only', value: projectileMaxCharges(type) }
      });
      return world.events.slice(start);
    }
    const projectileStart = projectiles.events.length;
    let result = null;
    let targeting = null;
    if (type === 'Blindfire') {
      result = projectiles.fireBlindfire({
        ownerId: player.id,
        level,
        origin: request.origin ? positionOf(request.origin) : undefined,
        direction: request.direction ?? player.forward
      });
    } else if (type === 'Shunt') {
      const explicit = request.targetId ? world.players.get(request.targetId) : null;
      targeting = explicit && explicit.id !== player.id && explicit.alive
        ? { targetId: explicit.id, source: 'caller-input' }
        : selectShuntTarget(player.id);
      if (!targeting.targetId) {
        world.emit('projectile-rejected', {
          playerId: player.id, pickupType: type, reason: 'no-eligible-target',
          targeting
        });
        projectiles.events.length = projectileStart;
        return world.events.slice(start);
      }
      result = projectiles.fireShunt({
        ownerId: player.id,
        targetId: targeting.targetId,
        level,
        origin: request.origin ? positionOf(request.origin) : undefined
      });
    } else if (type === 'Barge') {
      result = projectiles.fireBarge({ ownerId: player.id, level });
    } else {
      throw new Error('unexpected projectile item ' + JSON.stringify(type));
    }
    if (result && result.kind === 'projectile') {
      projectileDirections.set(result.id, { ...result.direction });
      if (request.staged === true) result.staged = true;
    }
    const events = translateProjectileEvents(projectiles.events.slice(projectileStart),
      request.staged === true ? { staged: true } : {});
    projectiles.events.length = projectileStart;
    const remaining = projectileChargesOf(player.id, type);
    if (remaining <= 0) {
      const index = player.inventory.indexOf(item);
      if (index >= 0) player.inventory.splice(index, 1);
    }
    player.nextUseAt = world.now + projectileDelay(type, level);
    for (const event of events) {
      event.chargesRemaining = remaining;
      event.chargesMax = projectileMaxCharges(type);
      event.chargesSource = { status: 'runtime-only', source: type === 'Blindfire'
        ? 'VLC_Pickups.cpp:2859' : 'VLC_Pickups.cpp:2855' };
      if (targeting) event.targeting = targeting;
    }
    return world.events.slice(start);
  }

  function advanceProjectiles(dt) {
    if (!projectiles) return [];
    syncProjectileCars();
    for (const projectile of projectiles.projectiles) {
      projectileDirections.set(projectile.id, { ...projectile.direction });
    }
    const start = projectiles.events.length;
    projectiles.advance(dt);
    const events = translateProjectileEvents(projectiles.events.slice(start));
    projectiles.events.length = start;
    syncProjectileCars();
    return events;
  }

  /**
   * Capture-only diagnostic: fire a weapon from `attackerId` at `targetId`.
   * Blindfire/Shunt launch a few metres from the target so the hit is judged
   * on the next tick; Barge stages the owner's model position at the target
   * (the PWR1 physics pose is never modified). Every event is marked staged.
   */
  function stageWeapon({ attackerId, targetId = null, pickupType, miss = false } = {}) {
    if (!projectiles) throw new Error('stageWeapon needs the PWR4 projectile model');
    const attacker = world.players.get(attackerId);
    if (!attacker) throw new Error('stageWeapon needs a known attacker');
    const target = targetId ? world.players.get(targetId) : null;
    if (!miss && !target) throw new Error('stageWeapon needs a known target unless miss=true');
    if (!POWERUP_PROJECTILE_TYPES.includes(pickupType)) {
      throw new Error('stageWeapon does not handle ' + JSON.stringify(pickupType));
    }
    syncProjectileCars();
    projectiles.addInventory(attackerId, pickupType, 1);
    const start = world.events.length;
    const projectileStart = projectiles.events.length;
    const forward = attacker.forward ?? { x: 0, y: 0, z: 1 };
    const direction = miss || !target
      ? { ...forward }
      : (() => {
        const dx = target.position.x - attacker.position.x;
        const dy = (target.position.y ?? 0) - (attacker.position.y ?? 0);
        const dz = target.position.z - attacker.position.z;
        const length = Math.hypot(dx, dy, dz) || 1;
        return { x: dx / length, y: dy / length, z: dz / length };
      })();
    if (pickupType === 'Blindfire') {
      const origin = miss || !target
        ? {
          x: attacker.position.x + direction.x * 2,
          y: (attacker.position.y ?? 0) + 0.3,
          z: attacker.position.z + direction.z * 2
        }
        : {
          x: target.position.x - direction.x * 4,
          y: (target.position.y ?? 0) + 0.3,
          z: target.position.z - direction.z * 4
        };
      const projectile = projectiles.fireBlindfire({ ownerId: attackerId, origin, direction });
      if (projectile?.kind === 'projectile') projectileDirections.set(projectile.id, { ...projectile.direction });
    } else if (pickupType === 'Shunt') {
      const origin = {
        x: target.position.x - direction.x * 8,
        y: (target.position.y ?? 0) + 0.3,
        z: target.position.z - direction.z * 8
      };
      const projectile = projectiles.fireShunt({
        ownerId: attackerId, targetId: target.id, origin
      });
      if (projectile?.kind === 'projectile') projectileDirections.set(projectile.id, { ...projectile.direction });
    } else {
      const car = projectiles.cars.get(attackerId);
      const saved = { ...car.position };
      car.position = { ...target.position };
      projectiles.fireBarge({ ownerId: attackerId });
      for (let tick = 0; tick < 3; tick++) {
        projectiles.advance(1 / 60);
        if (projectiles.effects.find((effect) => effect.kind === 'barge')?.hitTargets?.has(target.id)) break;
      }
      car.position = saved;
      syncProjectileCars();
    }
    const fired = translateProjectileEvents(projectiles.events.slice(projectileStart), { staged: true });
    projectiles.events.length = projectileStart;
    if (!miss && pickupType !== 'Barge') {
      for (let tick = 0; tick < 180; tick++) {
        const startTick = projectiles.events.length;
        projectiles.advance(1 / 60);
        const hits = translateProjectileEvents(projectiles.events.slice(startTick), { staged: true });
        projectiles.events.length = startTick;
        if (hits.some((event) => event.type === 'projectile-hit')) break;
        if (!projectiles.projectiles.length) break;
      }
    } else if (miss) {
      // One tick keeps the marker moving; the host loop owns the rest.
      const startTick = projectiles.events.length;
      projectiles.advance(1 / 60);
      translateProjectileEvents(projectiles.events.slice(startTick), { staged: true });
      projectiles.events.length = startTick;
    }
    const events = world.events.slice(start);
    for (const event of events) {
      event.staged = true;
      event.diagnostic = 'capture-staged weapon fire; no PWR1 inventory item was consumed';
      void fired;
    }
    return events;
  }

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
    projectileManifestHash: projectileManifest?.hashes?.manifestContent ?? null,
    projectiles,
    projectileRuntime,
    provisionalShuntImpulseNs,
    carEnvelope: { ...POWERUP_CAR_ENVELOPE },
    targetRadiusM: POWERUP_TARGET_RADIUS_M,
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
      nitro: 'Nitrous force = ' + M2_BOOST_MAGNITUDE_MPS2 + ' m/s^2 * mass * adjust before C_Scene::Simulate; target = exact PWR1 Hermite at the fire speed * ClassAModifier; 0.5 s force window in a 1.3 s effect; ' + M2_NITRO_CAP_MPS + ' m/s project cap',
      nitroClass: M2_NITRO_CLASS_SOURCE,
      shock: 'Shock is a speed scrub (E_FAKE_SPEED_BRAKE) to the exact PWR1 Shock curve target with the 10 mph floor; DamageInflicted=' + shockValues.DamageInflicted + ', InnerRadius=' + shockValues.InnerRadius + ', OuterRadius=' + shockValues.OuterRadius + ', Lifetime=' + shockValues.Lifetime + ' s',
      shockTargeting: 'not-serialized: the Shock hit test/falloff is not in PWR1; M2a uses the recovered Inner/OuterRadius with planar distance and applies DamageInflicted to every target inside OuterRadius',
      projectiles: 'PWR4 recovered values: Blindfire Speed=300 m/s, Radius=0.2 m, Damage=50, lifetime=10 s (runtime-only), 3 charges (runtime-only); Shunt Radius=0.75 m, Damage=100 major / 50 minor, lifetime=40 s (runtime-only), homing 0.3..1.0 x 50 + target speed (runtime-only), target 500 m / cos 45 deg; Barge Radius=7.0 m (+0.5 runtime padding, 2.0 m inner band), Damage=100, Duration=0.4 s',
      targetEnvelope: 'documented project car envelope ' + POWERUP_CAR_ENVELOPE.length + ' x ' + POWERUP_CAR_ENVELOPE.width + ' x ' + POWERUP_CAR_ENVELOPE.height + ' m; target sphere radius ' + round6(POWERUP_TARGET_RADIUS_M) + ' m = OBB circumradius (matches sprint-layout carCircumradiusMetres 1.710); not a recovered retail hull',
      shuntImpulse: 'provisional-impulse: ' + provisionalShuntImpulseNs + ' N*s is a BOOST1 design choice, not retail; retail is E_FAKE_PHYSICS_FLIP_FORWARD/TIP_FORWARD with a not-serialized magnitude',
      shuntTargeting: 'host forward cone: distance <= ' + POWERUP_SHUNT_MAX_TARGET_M + ' m, dotForward > cos 45 deg; camera line-of-sight is not modelled',
      bargeJink: 'JINK_BARGE_LEFT/RIGHT and JINK_BARGE_MINOR_LEFT/RIGHT magnitude is not-serialized; no linear vehicle impulse is applied',
      dynamicObjects: 'not applicable: the e1-drive world has no replicated dynamic objects, so the serialized PerkForceEffects MaxForce table is not emitted',
      tickRate: TICK_HZ
    },
    boost: {
      nitro: {
        keyframes: nitroKeyframes.map((frame) => ({ ...frame })),
        classModifiers: { ...nitroModifiers },
        classUsed: M2_NITRO_CLASS,
        classSource: M2_NITRO_CLASS_SOURCE,
        targetTable: nitroClassTargetTable(nitroKeyframes, M2_REFERENCE_SPRINT_SPEED_MPS, nitroModifiers),
        magnitudeMps2: M2_BOOST_MAGNITUDE_MPS2,
        forceWindowTicks: 30,
        durationTicks: M2_NITRO_DURATION_TICKS,
        capMps: M2_NITRO_CAP_MPS,
        source: M2_BOOST_LABELS.source,
        targetSource: M2_BOOST_LABELS.targetSource
      },
      shock: {
        keyframes: shockKeyframes.map((frame) => ({ ...frame })),
        magnitudeMps2: M2_BOOST_MAGNITUDE_MPS2,
        durationTicks: M2_SHOCK_DURATION_TICKS,
        minScrubMph: M2_SHOCK_MIN_SCRUB_MPH,
        innerRadius: shockValues.InnerRadius,
        outerRadius: shockValues.OuterRadius,
        lifetime: shockValues.Lifetime,
        damage: shockValues.DamageInflicted,
        source: M2_BOOST_LABELS.source,
        targetSource: M2_BOOST_LABELS.targetSource
      },
      delayTicks: M2_BOOST_DELAY_TICKS,
      authority: M2_BOOST_LABELS.authority,
      engineHook: 'e1_boost_queue before C_Scene::Simulate; no post-tick velocity or pose write'
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
      player.speedMps = Number.isFinite(options.speedMps) ? options.speedMps : 0;
      player.massKg = Number.isFinite(options.massKg) ? options.massKg : null;
      player.radiusM = POWERUP_TARGET_RADIUS_M;
      player.extents = {
        x: POWERUP_CAR_ENVELOPE.length,
        y: POWERUP_CAR_ENVELOPE.height,
        z: POWERUP_CAR_ENVELOPE.width
      };
      if (projectiles) projectiles.addCar(id, projectileCarConfig(player));
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
      if (Number.isFinite(state.speedMps)) player.speedMps = state.speedMps;
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

    spawnProvisionalPickups(layout, options = {}) {
      const plan = provisionalPickupPlan(layout, options);
      const spawned = [];
      for (const entry of plan) {
        const item = model.spawnPickup(entry.pickupType, entry.position, {
          source: 'provisional-plan',
          placement: entry.placement,
          arc: entry.arc,
          sampleIndex: entry.sampleIndex,
          note: entry.note
        });
        pickupArcs.set(item.id, entry.arc);
        spawned.push({ id: item.id, ...entry });
      }
      // The snapshot's placement metadata must describe the arcs actually
      // spawned, not the default table (package maps scale them).
      model.placement = {
        ...model.placement,
        mode: plan[0]?.placement ?? model.placement.mode,
        arcs: plan.map((entry) => entry.arc),
        types: plan.map((entry) => entry.pickupType),
        count: plan.length,
        note: plan[0]?.note ?? model.placement.note
      };
      return spawned;
    },

    collect(pickupId, playerId) {
      const event = world.pickup(pickupId, playerId);
      if (event?.type === 'pickup') ensureProjectileCharges(playerId, event.pickupType);
      return event;
    },

    projectileCharges(playerId, type) {
      return projectileChargesOf(playerId, type);
    },

    stageWeapon(request) {
      return stageWeapon(request);
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
      if (POWERUP_PROJECTILE_TYPES.includes(item.type)) {
        return fireProjectileItem(player, item, slot, request);
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
      const tick = Number.isFinite(request.tick)
        ? request.tick
        : Math.round(world.now * TICK_HZ);
      const classLetter = request.classLetter ?? M2_NITRO_CLASS;
      const speedMps = Number.isFinite(request.speedMps)
        ? request.speedMps
        : M2_REFERENCE_SPRINT_SPEED_MPS;
      const speedSource = request.speedSource ?? (Number.isFinite(request.speedMps)
        ? 'host-engine-state' : 'reference-310m-sprint');
      const startTick = tick + M2_BOOST_DELAY_TICKS - 1;

      world.use(playerId, { slot, position: position ?? player.position });
      const events = world.events.slice(start);

      for (const event of events) {
        if (event.type === 'nitro-activated') {
          const effect = world.effects[world.effects.length - 1] ?? event.effect ?? null;
          const target = nitroTargetForSpeed(nitroKeyframes, {
            speedMps, classLetter, classModifiers: nitroModifiers, capMps: M2_NITRO_CAP_MPS
          });
          const table = nitroClassTargetTable(nitroKeyframes, speedMps, nitroModifiers);
          Object.assign(event, {
            targetPlayer: playerId,
            kind: 'nitro',
            startTick,
            delayTicks: M2_BOOST_DELAY_TICKS,
            ticks: M2_NITRO_DURATION_TICKS,
            forceWindowTicks: 30,
            targetMps: target.targetMps,
            magnitude: M2_BOOST_MAGNITUDE_MPS2,
            speedMps: target.speedMps,
            speedSource,
            classLetter,
            classModifier: target.classModifier,
            classSource: M2_NITRO_CLASS_SOURCE,
            targetTable: table,
            targetSource: M2_BOOST_LABELS.targetSource,
            source: M2_BOOST_LABELS.source,
            capMps: M2_NITRO_CAP_MPS,
            capApplied: target.capApplied,
            staged: request.staged === true
          });
          if (effect) Object.assign(effect, {
            targetPlayerId: playerId,
            ticks: M2_NITRO_DURATION_TICKS,
            forceWindowTicks: 30,
            targetMps: target.targetMps,
            magnitude: M2_BOOST_MAGNITUDE_MPS2,
            speedMps: target.speedMps,
            classLetter,
            classModifier: target.classModifier,
            classSource: M2_NITRO_CLASS_SOURCE,
            targetSource: M2_BOOST_LABELS.targetSource,
            source: M2_BOOST_LABELS.source
          });
        }
        if (event.type === 'shock-activated') {
          const effect = event.effect ?? world.effects[world.effects.length - 1] ?? null;
          const targets = [];
          if (effect) {
            for (const targetPlayer of world.players.values()) {
              if (targetPlayer.id === playerId || !targetPlayer.alive) continue;
              const distanceM = planarDistance(effect.position, targetPlayer.position);
              if (distanceM > effect.outerRadius) continue;
              const targetSpeedMps = Number.isFinite(request.speeds?.[targetPlayer.id])
                ? request.speeds[targetPlayer.id]
                : (targetPlayer.id === playerId ? speedMps : M2_REFERENCE_SPRINT_SPEED_MPS);
              const target = shockTargetForSpeed(shockKeyframes, { speedMps: targetSpeedMps });
              targets.push({
                targetPlayer: targetPlayer.id,
                distanceM: round6(distanceM),
                hit: distanceM <= effect.innerRadius ? 'inner' : 'outer',
                speedMps: target.speedMps,
                targetMps: target.targetMps,
                graphValue: target.graphValue,
                floorMps: target.floorMps,
                floorApplied: target.floorApplied,
                damage: effect.damage,
                speedSource: Number.isFinite(request.speeds?.[targetPlayer.id])
                  ? 'host-engine-state' : 'reference-310m-sprint'
              });
            }
          }
          Object.assign(event, {
            kind: 'shock',
            startTick,
            delayTicks: M2_BOOST_DELAY_TICKS,
            ticks: M2_SHOCK_DURATION_TICKS,
            magnitude: M2_BOOST_MAGNITUDE_MPS2,
            targetSource: M2_BOOST_LABELS.targetSource,
            source: M2_BOOST_LABELS.source,
            innerRadius: shockValues.InnerRadius,
            outerRadius: shockValues.OuterRadius,
            lifetime: shockValues.Lifetime,
            damage: shockValues.DamageInflicted,
            targets,
            targeting: 'project-planar-distance; PWR1 does not serialize the Shock hit test',
            staged: request.staged === true
          });
          if (effect) Object.assign(effect, {
            ticks: M2_SHOCK_DURATION_TICKS,
            magnitude: M2_BOOST_MAGNITUDE_MPS2,
            targets,
            targetSource: M2_BOOST_LABELS.targetSource,
            source: M2_BOOST_LABELS.source,
            targeting: event.targeting
          });
          for (const target of targets) {
            if (target.hit) {
              world.damage(target.targetPlayer, shockValues.DamageInflicted, {
                kind: 'Shock', effectId: effect?.id ?? null
              });
            }
          }
        }
      }

      const placed = events.find((event) => event.type === 'mine-placed') ?? null;
      if (placed && request.staged === true) placed.staged = true;
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
            const pickupEvent = world.pickup(item.id, player.id);
            if (pickupEvent?.type === 'pickup') ensureProjectileCharges(player.id, pickupEvent.pickupType);
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
      advanceProjectiles(dt);

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
            massKg: player.massKg ?? null,
            inventory: player.inventory.map((item) => {
              const row = { type: item.type, level: item.level };
              if (POWERUP_PROJECTILE_TYPES.includes(item.type)) {
                row.charges = projectileChargesOf(player.id, item.type);
                row.maxCharges = projectileMaxCharges(item.type);
                row.chargesSource = { status: 'runtime-only' };
              }
              return row;
            }),
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
            arc: pickupArcs.get(item.id) ?? null,
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
          maxCapacity: effect.maxCapacity ?? null,
          duration: effect.duration ?? null,
          targetPlayerId: effect.targetPlayerId ?? null,
          targetMps: effect.targetMps ?? null,
          magnitude: effect.magnitude ?? null,
          ticks: effect.ticks ?? null,
          forceWindowTicks: effect.forceWindowTicks ?? null,
          speedMps: effect.speedMps ?? null,
          classLetter: effect.classLetter ?? null,
          targetSource: effect.targetSource ?? null,
          source: effect.source ?? null,
          targets: effect.targets ? effect.targets.map((target) => ({ ...target })) : null,
          targeting: effect.targeting ?? null
        })),
        projectiles: projectiles
          ? projectiles.projectiles.map((projectile) => ({
            id: projectile.id,
            pickupType: projectile.pickupType,
            level: projectile.level,
            ownerId: projectile.ownerId,
            targetId: projectile.targetId,
            position: { ...projectile.position },
            direction: { ...projectile.direction },
            speedMps: round6(projectile.speedMps),
            radiusM: projectile.radiusM,
            damage: projectile.damage,
            age: round6(projectile.age),
            lifetimeSeconds: projectile.lifetimeSeconds,
            lifetimeSource: projectile.lifetimeSource,
            chargesRemaining: projectile.chargesRemaining,
            status: projectile.status,
            homing: projectile.homing ?? null,
            hitTest: projectile.hitTest
          })).sort((a, b) => a.id.localeCompare(b.id))
          : [],
        barges: projectiles
          ? projectiles.effects
            .filter((effect) => effect.kind === 'barge')
            .map((effect) => {
              const envelopeFudge = (POWERUP_CAR_ENVELOPE.length + POWERUP_CAR_ENVELOPE.width) / 2
                - effect.extentsFudgeAverage;
              const outerRadius = effect.radius + effect.padding + envelopeFudge;
              return {
                id: effect.id,
                kind: 'barge',
                ownerId: effect.ownerId,
                position: { ...effect.position },
                radius: effect.radius,
                padding: effect.padding,
                innerBand: effect.innerBand,
                extentsFudgeAverage: effect.extentsFudgeAverage,
                outerRadius: round6(outerRadius),
                innerRadius: round6(outerRadius - effect.innerBand),
                damage: effect.damage,
                durationSeconds: effect.durationSeconds,
                expiresAt: round6(effect.expiresAt),
                secondsLeft: round6(Math.max(0, effect.expiresAt - (projectiles?.now ?? world.now))),
                hitTest: effect.hitTest
              };
            })
            .sort((a, b) => a.id.localeCompare(b.id))
          : [],
        projectileModel: projectiles ? {
          schema: projectileManifest.schema,
          manifestHash: projectileManifest.hashes?.manifestContent ?? null,
          source: 'PWR4 _work/powerups/projectiles.json'
        } : null,
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
    projectiles: {},
    barges: {},
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
  'nitro-activated': (event) => 'NITRO · ' + (event.targetMps != null ? Number(event.targetMps).toFixed(2) : '—') +
    ' m/s target · ' + (event.speedMps != null ? Number(event.speedMps).toFixed(2) : '—') + ' m/s fire speed',
  'shock-activated': (event) => 'SHOCK · ' + (event.targets?.length ?? 0) + ' target(s) · ' +
    (event.outerRadius ?? '—') + ' m outer',
  'nitro-hit': (event) => 'NITRO applied · ' + (event.targetMps ?? '—') + ' m/s',
  'shock-hit': (event) => 'SHOCK hit · ' + (event.targetPlayer ?? '—') + ' · ' +
    (event.targetMps != null ? Number(event.targetMps).toFixed(2) : '—') + ' m/s',
  'projectile-fired': (event) => (event.pickupType ?? 'projectile') + ' fired - ' +
    (event.chargesRemaining ?? '?') + ' charge(s) left',
  'projectile-hit': (event) => (event.pickupType ?? 'projectile') + ' hit ' +
    (event.targetId ?? '?') + ' - ' + (event.damage ?? '?') + ' dmg',
  'projectile-expired': (event) => (event.pickupType ?? 'projectile') + ' expired',
  'shunt-hit': (event) => 'SHUNT ' + (event.hitType ?? 'hit') + ' - ' +
    (event.impulse?.deltaV != null ? Number(event.impulse.deltaV).toFixed(2) + ' m/s provisional impulse' : 'impulse typed'),
  'barge-activated': (event) => 'BARGE - ' + (event.radius ?? '?') + ' m / ' +
    (event.durationSeconds ?? '?') + ' s',
  'barge-hit': (event) => 'BARGE hit ' + (event.targetId ?? '?') + ' - ' +
    (event.hitType ?? '') + ' - ' + (event.damage ?? '?') + ' dmg',
  'shunt-impulse-provisional': (event) => 'SHUNT provisional impulse - ' +
    (event.deltaV != null ? Number(event.deltaV).toFixed(2) : '?') + ' m/s',
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
  view.projectiles = {};
  for (const projectile of snapshot.projectiles ?? []) {
    view.projectiles[projectile.id] = { ...projectile, position: { ...projectile.position } };
  }
  view.barges = {};
  for (const barge of snapshot.barges ?? []) {
    view.barges[barge.id] = { ...barge, position: { ...barge.position } };
  }
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
    case 'nitro-activated':
    case 'shock-activated':
      if (event.effect) view.effects[event.effect.id] = { ...event.effect, ...(event.targets ? { targets: event.targets } : {}) };
      break;
    case 'projectile-fired':
      view.projectiles[event.projectileId] = {
        id: event.projectileId,
        pickupType: event.pickupType,
        ownerId: event.ownerId,
        targetId: event.targetId ?? null,
        position: { ...(event.origin ?? { x: 0, y: 0, z: 0 }) },
        direction: { ...(event.direction ?? { x: 0, y: 0, z: 1 }) },
        speedMps: event.speedMps,
        lifetimeSeconds: event.lifetimeSeconds,
        chargesRemaining: event.chargesRemaining,
        age: 0,
        status: 'active'
      };
      break;
    case 'projectile-hit':
    case 'shunt-hit':
    case 'projectile-expired':
      delete view.projectiles[event.projectileId];
      break;
    case 'barge-activated':
      if (event.bargeId) view.barges[event.bargeId] = {
        id: event.bargeId,
        kind: 'barge',
        ownerId: event.ownerId,
        position: { ...event.position },
        radius: event.radius,
        durationSeconds: event.durationSeconds,
        outerRadius: event.hitTest?.majorRadius ?? event.radius,
        innerRadius: (event.hitTest?.majorRadius ?? event.radius) - (event.hitTest?.innerBand ?? 0),
        expiresAt: (view.now ?? 0) + (event.durationSeconds ?? 0),
        secondsLeft: event.durationSeconds ?? 0
      };
      break;
    case 'barge-hit':
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
      delete view.barges[event.effectId];
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

/** The local player's active Nitro/Shock effect, if any. */
export function boostFor(view, playerId) {
  return Object.values(view?.effects ?? {})
    .find((effect) => (effect.kind === 'nitro' || effect.kind === 'shock') &&
      effect.ownerId === playerId) ?? null;
}

/** Compact HUD/evidence projection of the client view. */
export function powerupViewSummary(view) {
  if (!view) return null;
  const local = view.localId ? view.players[view.localId] ?? null : null;
  const remote = view.remoteId ? view.players[view.remoteId] ?? null : null;
  const shield = view.localId ? shieldFor(view, view.localId) : null;
  const boost = view.localId ? boostFor(view, view.localId) : null;
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
    boost: boost ? {
      ...boost,
      secondsLeft: Math.max(0, boost.expiresAt - view.now)
    } : null,
    pickups: Object.values(view.pickups),
    mines: Object.values(view.mines),
    effects: Object.values(view.effects),
    projectiles: Object.values(view.projectiles ?? {}),
    barges: Object.values(view.barges ?? {}),
    feed: view.feed.slice(-8),
    counts: { ...view.counts },
    lastEventSeq: view.lastEventSeq,
    lastBatchSeq: view.lastBatchSeq,
    relayError: view.relayError,
    placement: view.placement ?? null
  };
}
