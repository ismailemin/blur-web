// Deterministic AI power-up policy for the Blur Web race slice.
//
// This module is a *policy*, not a world. It consumes the same pickup/weapon
// event contract the human power-up slice exposes (`pickup`, `nitro-activated`,
// `shield-activated`, `mine-placed`, `projectile-fired`, `damage`, ...) and
// emits intents. It never calls a host-authoritative effect directly: the host
// validates and applies `pickup` / `use` intents against its own world.
//
// Recovered retail data (see docs/work/analysis/ai-powerups.md):
//
//   pickups.bin AIPickupController record 355 refId 1737121311
//     -> five AIPickupControllerDifficulty rows (VeryEasy..HardCore)
//     -> AIPickupControllerSetup records 153/416/447/482/811
//   pickups.bin PickupType.AIUsageType / AIPickupTypes for the 11 entities
//   pickups.bin Bomb/Nitrous/Shield/... balancing values (via the human slice)
//
// Everything that is not serialized (aim lead, the exact graph-to-weapon index,
// mine chase distance, shield threat radius) is labelled `provisional` in the
// intent payload and in this header. There is no `Math.random`, no clock and no
// wall time: the only time source is the integer race tick supplied by the host.

import { createHash } from 'node:crypto';

export const AI_POWERUP_POLICY_KIND = 'blur.ai-powerup-policy';
export const AI_POWERUP_POLICY_VERSION = 1;

const round6 = (value) => Math.round(value * 1e6) / 1e6;

// The eight retail multiplayer classes (PWR1 `MpPickup` flags). Fan, Stopwatch
// and SuperShield are not in the 8-type multiplayer slice; SuperShield is the
// documented project extension and is off by default.
export const SUPPORTED_MP_TYPES = Object.freeze([
  'Nitrous', 'Shock', 'Shunt', 'Blindfire', 'Barge', 'Bomb', 'Repair', 'Shield'
]);
export const EXTENSION_TYPES = Object.freeze(['SuperShield']);
export const NON_MP_TYPES = Object.freeze(['Fan', 'Stopwatch']);

// Recovered values, keyed by the serialized difficulty label. The `refId` and
// `setupRecord` fields are the evidence anchor; `run-powerups.mjs` re-checks
// them against `_work/ai-driver/recovered-ai-powerups.json`.
export const RECOVERED_AI_CONTROLLER = Object.freeze({
  source: {
    pack: 'pickups.bin',
    controllerRecord: 355,
    controllerRefId: 1737121311,
    controllerPayloadAbs: 76440,
    type: 'AIPickupController',
  },
  common: Object.freeze({
    evaluateSeconds: 0.5,
    shieldEvaluateSeconds: 0.1,
    firedPerkDisableSeconds: 2.0,
    playerHitWithPerkDisableSeconds: 5.0,
    beenHitWithPerkDisableSeconds: 0.0,
    outOfRangePickDropMinSeconds: 5.0,
    outOfRangePickDropMaxSeconds: 20.0,
    fireProbabilityRatio: 1.0,
    ignoreHumanRatio: 0.0,
  }),
  difficulties: Object.freeze({
    VeryEasy: Object.freeze({ setupRecord: 447, setupRefId: 2241696437,
      setupPayloadAbs: 86920, pickupSwitchSeconds: 3.0 }),
    Easy: Object.freeze({ setupRecord: 811, setupRefId: 4063194058,
      setupPayloadAbs: 125332, pickupSwitchSeconds: 3.0 }),
    Normal: Object.freeze({ setupRecord: 153, setupRefId: 742508891,
      setupPayloadAbs: 55368, pickupSwitchSeconds: 2.0 }),
    Hard: Object.freeze({ setupRecord: 416, setupRefId: 2101837824,
      setupPayloadAbs: 83236, pickupSwitchSeconds: 1.0 }),
    HardCore: Object.freeze({ setupRecord: 482, setupRefId: 2415460375,
      setupPayloadAbs: 91452, pickupSwitchSeconds: 1.0 }),
  }),
});

// The existing driver profiles are speed-only. This mapping of a profile to a
// recovered AI difficulty row is a project choice (`provisional`): cautious and
// standard get the slower pickup-switch cadence, reference gets Hard.
export const AI_PROFILE_DIFFICULTY = Object.freeze({
  cautious: 'Easy',
  standard: 'Normal',
  reference: 'Hard',
  aggressive: 'HardCore',
});

// Serialized `PickupType.AIPickupTypes` triggers. `distance`/`angle` are the
// serialized `WeaponDistanceAdjustment` / `WeaponAngleAdjustment` degrees; the
// interpretation as a fire gate is `provisional` (runtime code).
export const RECOVERED_AI_TRIGGERS = Object.freeze({
  Nitrous: Object.freeze({ usage: 'Passive', trigger: 'empty', durationSeconds: 1.3,
    durationCheckpointSeconds: 2.5 }),
  Shock: Object.freeze({ usage: 'Aggressive',
    tiers: Object.freeze([
      Object.freeze({ distance: 50, angle: 0 }),
      Object.freeze({ distance: 80, angle: 45 }),
      Object.freeze({ distance: 200, angle: 20 }),
    ]),
    selection: 'lowest-race-position' }),
  Shunt: Object.freeze({ usage: 'Aggressive',
    tiers: Object.freeze([
      Object.freeze({ distance: 40, angle: 40 }),
      Object.freeze({ distance: 30, angle: 30 }),
      Object.freeze({ distance: 20, angle: 20 }),
    ]),
    targetRule: 'ahead-and-dot-cos45-and-under-500m' }),
  Blindfire: Object.freeze({ usage: 'Aggressive',
    tiers: Object.freeze([
      Object.freeze({ distance: 40, angle: 40 }),
      Object.freeze({ distance: 30, angle: 30 }),
      Object.freeze({ distance: 20, angle: 20 }),
    ]),
    target: 'forward-no-target' }),
  Barge: Object.freeze({ usage: 'Aggressive', radius: 7.0,
    runtimeRadiusBonus: 0.5, trigger: 'none-serialized' }),
  Bomb: Object.freeze({ usage: 'Aggressive', trigger: 'empty',
    placeBehindDistance: 5, armSeconds: 0.3, radius: 1.0, outerRadius: 3.5,
    lifespanSeconds: 60 }),
  Repair: Object.freeze({ usage: 'Passive', trigger: 'DamageLevel',
    amountToRepair: 400, healthScale: 'runtime-only' }),
  Shield: Object.freeze({ usage: 'Passive', trigger: 'none-serialized',
    health: 50, lifetimeSeconds: 6, absorbModel: 'prototype-assumption' }),
  SuperShield: Object.freeze({ usage: 'Passive', trigger: 'none-serialized',
    lifetimeSeconds: 10, extension: true }),
});

// Values the policy uses that the shipped packs do not serialize. Every one is
// emitted with `source:'provisional'` in the intent/diagnostic payload.
export const PROVISIONAL_VALUES = Object.freeze({
  aimLeadSeconds: Object.freeze({ value: 0, reason: 'no aim-lead field in pickups.bin' }),
  mineChaseDistanceMetres: Object.freeze({ value: 40, reason: 'Bomb AIPickupTypes is empty' }),
  mineChaseDot: Object.freeze({ value: -0.3, reason: 'Bomb AIPickupTypes is empty' }),
  shieldThreatRadiusMetres: Object.freeze({ value: 120, reason: 'no AI shield threat radius field' }),
  shieldBehindDistanceMetres: Object.freeze({ value: 60, reason: 'ShieldedGraph x-axis units are not serialized' }),
  nitroMinSpeedMps: Object.freeze({ value: 10, reason: 'Nitrous AIPickupType is empty' }),
  repairHealthFraction: Object.freeze({ value: 1.0, reason: 'DamageLevel labels are not a health fraction' }),
  inRangeGraphIndex: Object.freeze({ value: null,
    reason: '7 graphs are indexed by pickup class in runtime code; the order is not serialized' }),
  shieldGraphProbability: Object.freeze({ value: null,
    reason: 'ShieldedGraph distance units are not serialized' }),
});

const DEG = Math.PI / 180;
const forwardOf = (self) => {
  const heading = Number.isFinite(self.heading) ? self.heading
    : Number.isFinite(self.axisZ?.[0]) ? Math.atan2(self.axisZ[0], self.axisZ[2]) : 0;
  return { x: Math.sin(heading), z: Math.cos(heading), heading };
};
const posOf = (value) => ({
  x: value?.position?.x ?? value?.x ?? 0,
  z: value?.position?.z ?? value?.z ?? 0,
});
const dist = (a, b) => Math.hypot(posOf(a).x - posOf(b).x, posOf(a).z - posOf(b).z);

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function hashOf(value) {
  return 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function resolveProfileDifficulty(profileId, override = null) {
  if (override) {
    if (!RECOVERED_AI_CONTROLLER.difficulties[override]) {
      throw new Error(`unknown AI difficulty ${JSON.stringify(override)}`);
    }
    return override;
  }
  return AI_PROFILE_DIFFICULTY[profileId] ?? 'Normal';
}

/**
 * Build a pure policy instance. All state is derived from the supplied tick and
 * the previous `decide` calls, so an identical call sequence produces identical
 * intents and hashes.
 */
export function createAiPowerupPolicy(options = {}) {
  const profileId = options.profileId ?? options.profile?.id ?? 'reference';
  const difficulty = resolveProfileDifficulty(profileId, options.difficulty ?? null);
  const controller = RECOVERED_AI_CONTROLLER.difficulties[difficulty];
  const common = RECOVERED_AI_CONTROLLER.common;
  const capabilityList = options.capabilities?.types ?? SUPPORTED_MP_TYPES;
  const supported = new Set(capabilityList);
  if (options.capabilities?.superShield === true) supported.add('SuperShield');
  for (const type of capabilityList) {
    if (!SUPPORTED_MP_TYPES.includes(type) && type !== 'SuperShield') {
      throw new Error(`unknown pickup type in capabilities: ${type}`);
    }
  }

  const ticks = Object.freeze({
    evaluate: Math.max(1, Math.round(common.evaluateSeconds * 60)),
    shield: Math.max(1, Math.round(common.shieldEvaluateSeconds * 60)),
    fireDisable: Math.round(common.firedPerkDisableSeconds * 60),
    playerHitDisable: Math.round(common.playerHitWithPerkDisableSeconds * 60),
    pickupSwitch: Math.max(1, Math.round(controller.pickupSwitchSeconds * 60)),
    outOfRangeMin: Math.round(common.outOfRangePickDropMinSeconds * 60),
    outOfRangeMax: Math.round(common.outOfRangePickDropMaxSeconds * 60),
  });

  const state = {
    tick: null,
    nextEvaluateTick: 0,
    nextPickupTick: 0,
    fireDisableUntilTick: -1,
    hitDisableUntilTick: -1,
    heldType: null,
    heldSinceTick: null,
    unusableSince: new Map(),
    decisions: 0,
    lastHash: null,
    inactiveTicks: 0,
  };

  function isShieldActive(self) {
    return (self.effects ?? []).some((effect) =>
      (effect.kind === 'shield' || effect.kind === 'superShield') &&
      effect.ownerId === self.id && effect.expiresAt > state.tick / 60);
  }

  function aheadTargets(self, opponents, tiers, extraFilter = null) {
    const forward = forwardOf(self);
    const hits = [];
    for (const opponent of opponents) {
      if (!opponent || opponent.alive === false || opponent.id === self.id) continue;
      const target = posOf(opponent);
      const dx = target.x - posOf(self).x;
      const dz = target.z - posOf(self).z;
      const distance = Math.hypot(dx, dz);
      if (!(distance > 0)) continue;
      const dot = (dx * forward.x + dz * forward.z) / distance;
      for (const tier of tiers) {
        const maxAngle = Math.max(tier.angle, 1) * DEG;
        if (distance <= tier.distance && dot >= Math.cos(maxAngle)) {
          hits.push({ opponent, distance, dot, tier });
          break;
        }
      }
    }
    hits.sort((a, b) => {
      if (extraFilter) {
        const byFilter = extraFilter(a, b);
        if (byFilter !== 0) return byFilter;
      }
      return a.distance - b.distance;
    });
    return hits;
  }

  function opponentBehind(self, opponents, maxDistance, maxDot = -0.3) {
    const forward = forwardOf(self);
    const origin = posOf(self);
    for (const opponent of opponents) {
      if (!opponent || opponent.alive === false || opponent.id === self.id) continue;
      const target = posOf(opponent);
      const dx = target.x - origin.x;
      const dz = target.z - origin.z;
      const distance = Math.hypot(dx, dz);
      if (!(distance > 0) || distance > maxDistance) continue;
      const dot = (dx * forward.x + dz * forward.z) / distance;
      if (dot <= maxDot) return { opponent, distance, dot };
    }
    return null;
  }

  function incomingThreat(self, input) {
    const radius = PROVISIONAL_VALUES.shieldThreatRadiusMetres.value;
    const events = input.events ?? [];
    const recentWindow = 90; // 1.5 s = Shock lifetime; shield reaction cadence is separate.
    for (const event of events) {
      if (!event || !Number.isInteger(event.tick)) continue;
      if (state.tick - event.tick > recentWindow) continue;
      const owner = event.ownerId ?? event.playerId ?? event.source?.playerId ?? null;
      if (owner !== null && owner === self.id) continue;
      if (event.type === 'projectile-fired') {
        const targetId = event.targetId ?? event.projectile?.targetId ?? null;
        const position = event.projectile?.origin ?? event.position ?? null;
        if (targetId === self.id) return { kind: 'incoming-projectile', event };
        if (position && dist(position, self) <= radius) return { kind: 'incoming-projectile', event };
      }
      if (event.type === 'mine-placed') {
        const position = event.mine?.position ?? event.position ?? null;
        if (position && dist(position, self) <= 15) return { kind: 'incoming-mine', event };
      }
    }
    const behind = opponentBehind(self, input.opponents ?? [],
      PROVISIONAL_VALUES.shieldBehindDistanceMetres.value);
    if (behind) return { kind: 'opponent-behind', opponentId: behind.opponent.id };
    for (const threat of input.incoming ?? []) {
      if (threat && targetOf(threat) === self.id) return { kind: 'host-incoming', threat };
    }
    return null;
  }

  function targetOf(value) {
    return value?.targetId ?? value?.target?.id ?? null;
  }

  function tryUse(held, input, slot) {
    const self = input.self;
    const type = held.type;
    if (!supported.has(type)) {
      return { skip: {
        kind: 'skip', pickupType: type, slot,
        reason: 'unsupported-type',
        detail: {
          supportedTypes: [...supported].sort(),
          source: 'capabilities',
        },
      } };
    }
    const trigger = RECOVERED_AI_TRIGGERS[type];
    const opponents = input.opponents ?? [];

    switch (type) {
      case 'Nitrous': {
        const forward = forwardOf(self);
        const steer = Math.abs(Number.isFinite(self.steer) ? self.steer : 0);
        const minSpeed = PROVISIONAL_VALUES.nitroMinSpeedMps.value;
        if ((self.speed ?? 0) < minSpeed || steer > 0.5) {
          return { skip: { kind: 'skip', pickupType: type, slot,
            reason: 'out-of-range', detail: {
              minSpeedMps: minSpeed, speed: round6(self.speed ?? 0), steer: round6(steer),
              source: 'provisional', serializedDurationSeconds: trigger.durationSeconds } } };
        }
        return { use: { kind: 'use', pickupType: type, slot,
          reason: 'straight-and-fast', aim: { mode: 'forward', leadSeconds: 0,
            source: 'provisional', direction: forward } } };
      }
      case 'Shunt': {
        const hits = aheadTargets(self, opponents, trigger.tiers);
        const withinRange = hits.filter((hit) => hit.distance <= 500 && hit.dot >= Math.cos(45 * DEG));
        if (!withinRange.length) {
          return { skip: { kind: 'skip', pickupType: type, slot,
            reason: 'no-target', detail: { tiers: trigger.tiers, source: 'serialized-trigger' } } };
        }
        const target = withinRange[0];
        return { use: { kind: 'use', pickupType: type, slot,
          targetId: target.opponent.id, reason: 'target-ahead',
          aim: { mode: 'target', leadSeconds: PROVISIONAL_VALUES.aimLeadSeconds.value,
            source: 'provisional', distance: round6(target.distance),
            dot: round6(target.dot) },
          trigger: { tier: target.tier, source: 'serialized-trigger' } } };
      }
      case 'Blindfire': {
        const hits = aheadTargets(self, opponents, trigger.tiers);
        const forward = forwardOf(self);
        if (!hits.length) {
          return { skip: { kind: 'skip', pickupType: type, slot,
            reason: 'no-target', detail: { tiers: trigger.tiers, source: 'serialized-trigger' } } };
        }
        return { use: { kind: 'use', pickupType: type, slot, targetId: null,
          reason: 'forward-fire', triggerTargetId: hits[0].opponent.id,
          aim: { mode: 'forward', leadSeconds: PROVISIONAL_VALUES.aimLeadSeconds.value,
            source: 'provisional', direction: forward } } };
      }
      case 'Shock': {
        const hits = aheadTargets(self, opponents, trigger.tiers, (a, b) => {
          const pa = Number.isFinite(a.opponent.racePosition) ? a.opponent.racePosition : 1e9;
          const pb = Number.isFinite(b.opponent.racePosition) ? b.opponent.racePosition : 1e9;
          return pa - pb;
        });
        if (!hits.length) {
          return { skip: { kind: 'skip', pickupType: type, slot,
            reason: 'no-target', detail: { tiers: trigger.tiers,
              selection: trigger.selection, source: 'serialized-trigger' } } };
        }
        const target = hits[0];
        return { use: { kind: 'use', pickupType: type, slot,
          targetId: target.opponent.id, reason: 'ahead-lowest-race-position',
          position: posOf(target.opponent),
          trigger: { tier: target.tier, source: 'serialized-trigger' },
          runtimeNote: 'shock dome positions/width need the track spline; host owns placement' } };
      }
      case 'Barge': {
        const radius = trigger.radius + trigger.runtimeRadiusBonus;
        const hits = opponents.filter((opponent) => opponent && opponent.alive !== false &&
          opponent.id !== self.id && dist(opponent, self) <= radius);
        if (!hits.length) {
          return { skip: { kind: 'skip', pickupType: type, slot,
            reason: 'no-target', detail: { radiusMetres: radius,
              radiusSource: 'serialized Radius 7.0 + runtime +0.5' } } };
        }
        return { use: { kind: 'use', pickupType: type, slot,
          reason: 'target-inside-barge-radius',
          position: posOf(self), radiusMetres: radius,
          trigger: { source: 'serialized-radius' } } };
      }
      case 'Bomb': {
        const behind = opponentBehind(self, opponents,
          PROVISIONAL_VALUES.mineChaseDistanceMetres.value,
          PROVISIONAL_VALUES.mineChaseDot.value);
        const staleSince = state.unusableSince.get(`${slot}:${type}`);
        const trapAfterHold = staleSince !== undefined &&
          state.tick - staleSince >= ticks.outOfRangeMin;
        if (!behind && !trapAfterHold) {
          return { skip: { kind: 'skip', pickupType: type, slot,
            reason: 'no-target', detail: {
              chaseDistanceMetres: PROVISIONAL_VALUES.mineChaseDistanceMetres.value,
              chaseDot: PROVISIONAL_VALUES.mineChaseDot.value,
              source: 'provisional', serializedPlaceBehindDistance: trigger.placeBehindDistance } } };
        }
        const forward = forwardOf(self);
        const selfPos = posOf(self);
        return { use: { kind: 'use', pickupType: type, slot,
          reason: behind ? 'opponent-behind' : 'trap-after-hold',
          position: {
            x: round6(selfPos.x - forward.x * trigger.placeBehindDistance),
            z: round6(selfPos.z - forward.z * trigger.placeBehindDistance),
          },
          drop: { placeBehindDistance: trigger.placeBehindDistance,
            armSeconds: trigger.armSeconds, source: 'serialized' },
          triggerTargetId: behind?.opponent.id ?? null,
          trapAfterSeconds: trapAfterHold ? common.outOfRangePickDropMinSeconds : null } };
      }
      case 'Repair': {
        const health = Number.isFinite(self.health) ? self.health : null;
        const maxHealth = Number.isFinite(self.maxHealth) ? self.maxHealth : health;
        if (!(health < maxHealth)) {
          return { skip: { kind: 'skip', pickupType: type, slot,
            reason: 'not-needed', detail: { health, maxHealth,
              healthScale: trigger.healthScale, source: 'serialized-amount-runtime-scale' } } };
        }
        return { use: { kind: 'use', pickupType: type, slot, reason: 'damaged',
          amountToRepair: trigger.amountToRepair,
          detail: { health, maxHealth, healthScale: trigger.healthScale } } };
      }
      case 'Shield':
      case 'SuperShield': {
        if (isShieldActive(self)) {
          return { skip: { kind: 'skip', pickupType: type, slot,
            reason: 'already-active', detail: { source: 'host-state' } } };
        }
        const threat = incomingThreat(self, input);
        if (!threat) {
          return { skip: { kind: 'skip', pickupType: type, slot,
            reason: 'no-threat', detail: {
              threatRadiusMetres: PROVISIONAL_VALUES.shieldThreatRadiusMetres.value,
              source: 'provisional' } } };
        }
        return { use: { kind: 'use', pickupType: type, slot,
          reason: 'incoming-threat', threat,
          shield: { lifetimeSeconds: trigger.lifetimeSeconds,
            extension: trigger.extension === true,
            absorbModel: trigger.absorbModel ?? 'time-invulnerable' } } };
      }
      default:
        return { skip: { kind: 'skip', pickupType: type, slot,
          reason: 'unsupported-type', detail: { source: 'no-policy-case' } } };
    }
  }

  function nearestPickup(self, pickups) {
    const radius = options.capabilities?.pickupRadius ?? 2.0;
    let bestSupported = null;
    let nearestUnsupported = null;
    for (const pickup of pickups) {
      if (!pickup || pickup.state !== 'active') continue;
      const distance = dist(pickup, self);
      if (distance > radius) continue;
      if (supported.has(pickup.type)) {
        if (!bestSupported || distance < bestSupported.distance) {
          bestSupported = { pickup, distance };
        }
      } else if (!nearestUnsupported || distance < nearestUnsupported.distance) {
        nearestUnsupported = { pickup, distance };
      }
    }
    return { bestSupported, nearestUnsupported, radius };
  }

  function decide(input) {
    const tick = Number.isInteger(input.tick) ? input.tick : 0;
    state.tick = tick;
    const self = input.self;
    const diagnostics = [];
    const intents = [];
    const phase = input.finished || self?.finished ? 'finished'
      : self?.alive === false ? 'wrecked' : 'running';

    if (phase !== 'running' || !self) {
      state.inactiveTicks += 1;
      return result(tick, phase, intents, diagnostics);
    }

    for (const event of input.events ?? []) {
      if (!event) continue;
      const targetId = event.targetId ?? event.target?.id ?? null;
      if ((event.type === 'damage' || event.type === 'wrecked' ||
          event.type === 'projectile-hit') && targetId === self.id) {
        state.hitDisableUntilTick = Math.max(state.hitDisableUntilTick,
          tick + ticks.playerHitDisable);
      }
    }

    const inventory = Array.isArray(self.inventory) ? self.inventory : [];
    const capacity = self.inventoryCapacity ?? 1;
    const slotKey = (slot, item) => `${slot}:${item?.type ?? 'empty'}`;

    // Forget unusable timers for slots that no longer hold the same item.
    for (const key of [...state.unusableSince.keys()]) {
      const [slotText, type] = key.split(':');
      const slot = Number(slotText);
      if (!inventory[slot] || inventory[slot].type !== type) state.unusableSince.delete(key);
    }

    // Pickup is proximity-triggered by the host, not a 0.5 s "use" decision.
    // The AI still honours PickupSwitchTime between attempts.
    if (inventory.length < capacity && tick >= state.nextPickupTick) {
      const near = nearestPickup(self, input.pickups ?? []);
      if (near.bestSupported) {
        intents.push({
          kind: 'pickup',
          pickupId: near.bestSupported.pickup.id,
          pickupType: near.bestSupported.pickup.type,
          distance: round6(near.bestSupported.distance),
          radiusMetres: near.radius,
          reason: 'proximity',
        });
        state.nextPickupTick = tick + ticks.pickupSwitch;
      } else if (near.nearestUnsupported) {
        diagnostics.push({
          kind: 'skip', pickupType: near.nearestUnsupported.pickup.type,
          pickupId: near.nearestUnsupported.pickup.id,
          reason: 'unsupported-type',
          detail: { supportedTypes: [...supported].sort(), source: 'capabilities' },
        });
        state.nextPickupTick = tick + ticks.pickupSwitch;
      }
    }

    // Shield reacts on the 0.1 s cadence, not the 0.5 s offensive cadence.
    const shieldSlot = inventory.findIndex((item) =>
      item && (item.type === 'Shield' || item.type === 'SuperShield') &&
      supported.has(item.type));
    if (shieldSlot >= 0 && tick % ticks.shield === 0 &&
        tick >= state.fireDisableUntilTick && tick >= state.hitDisableUntilTick &&
        !isShieldActive(self)) {
      const choice = tryUse(inventory[shieldSlot], input, shieldSlot);
      if (choice.use) {
        intents.push(choice.use);
        state.fireDisableUntilTick = tick + ticks.fireDisable;
        state.unusableSince.delete(slotKey(shieldSlot, inventory[shieldSlot]));
      } else if (choice.skip && choice.skip.reason !== 'no-threat') {
        diagnostics.push(choice.skip);
      }
    }

    // Offensive/utility evaluation: try every held slot so a full-health Repair
    // in slot 0 does not hide a usable weapon in slot 1.
    if (!intents.some((intent) => intent.kind === 'use') &&
        tick >= state.nextEvaluateTick && tick >= state.fireDisableUntilTick &&
        tick >= state.hitDisableUntilTick) {
      state.nextEvaluateTick = tick + ticks.evaluate;
      let used = false;
      for (let slot = 0; slot < inventory.length && !used; slot++) {
        const item = inventory[slot];
        if (!item) continue;
        const choice = tryUse(item, input, slot);
        const key = slotKey(slot, item);
        if (choice.use) {
          intents.push(choice.use);
          state.fireDisableUntilTick = tick + ticks.fireDisable;
          state.unusableSince.delete(key);
          used = true;
        } else if (choice.skip) {
          diagnostics.push(choice.skip);
          if (!state.unusableSince.has(key)) state.unusableSince.set(key, tick);
        }
      }
    }

    // Recovered OutOfRangePickDropTimeMin/Max: if an item has been unusable for
    // the minimum window, emit a drop intent (host extension) so the AI can pick
    // a new item. The window is serialized; using `min` deterministically is a
    // project choice labelled `provisional`.
    if (!intents.some((intent) => intent.kind === 'use' || intent.kind === 'pickup')) {
      for (let slot = 0; slot < inventory.length; slot++) {
        const item = inventory[slot];
        if (!item) continue;
        const since = state.unusableSince.get(slotKey(slot, item));
        if (since !== undefined && tick - since >= ticks.outOfRangeMin) {
          intents.push({
            kind: 'drop', slot, pickupType: item.type,
            reason: 'out-of-range-timeout',
            detail: {
              dropAfterSeconds: common.outOfRangePickDropMinSeconds,
              serializedMinSeconds: common.outOfRangePickDropMinSeconds,
              serializedMaxSeconds: common.outOfRangePickDropMaxSeconds,
              source: 'serialized-window/provisional-min-choice',
            },
          });
          state.unusableSince.delete(slotKey(slot, item));
          break;
        }
      }
    }

    // At most one use intent per tick is an invariant of the policy; the host
    // also rejects a second use from the same player in one tick.
    return result(tick, phase, intents, diagnostics);
  }

  function result(tick, phase, intents, diagnostics) {
    state.decisions += 1;
    const decision = {
      kind: AI_POWERUP_POLICY_KIND,
      version: AI_POWERUP_POLICY_VERSION,
      tick,
      profile: profileId,
      difficulty,
      controller: {
        setupRecord: controller.setupRecord,
        setupRefId: controller.setupRefId,
        pickupSwitchSeconds: controller.pickupSwitchSeconds,
      },
      phase,
      intents,
      diagnostics,
      timers: {
        nextEvaluateTick: state.nextEvaluateTick,
        nextPickupTick: state.nextPickupTick,
        fireDisableUntilTick: state.fireDisableUntilTick,
        hitDisableUntilTick: state.hitDisableUntilTick,
      },
    };
    decision.hash = hashOf(decision);
    state.lastHash = decision.hash;
    return decision;
  }

  return {
    kind: AI_POWERUP_POLICY_KIND,
    version: AI_POWERUP_POLICY_VERSION,
    profileId,
    difficulty,
    controller,
    supported: [...supported].sort(),
    ticks,
    decide,
    snapshot: () => ({
      kind: AI_POWERUP_POLICY_KIND,
      profile: profileId,
      difficulty,
      supported: [...supported].sort(),
      decisions: state.decisions,
      lastHash: state.lastHash,
      heldType: state.heldType,
      heldSinceTick: state.heldSinceTick,
      nextEvaluateTick: state.nextEvaluateTick,
      nextPickupTick: state.nextPickupTick,
      fireDisableUntilTick: state.fireDisableUntilTick,
      hitDisableUntilTick: state.hitDisableUntilTick,
    }),
  };
}

export const policyHashOf = hashOf;
