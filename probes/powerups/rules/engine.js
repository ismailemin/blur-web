/**
 * Blur power-up rules prototype (standalone, no engine, no game binaries).
 *
 * The numbers come from `_work/powerups/powerups.json`, which is produced by
 * `probes/powerups/tools/build_powerups.py` from the shipped XT packs. This file
 * never hard-codes a game value and never invents one: where the shipped data has
 * no field (charges, projectile lifetime, normal respawn seconds, damage falloff),
 * the value is exposed as a typed unknown and the resolver refuses to guess.
 *
 * This is a rules prototype for the future e1-drive/multiplayer layer, not a
 * retail-behaviour claim.
 */

export const UNKNOWNS = Object.freeze({
  charges: {
    status: 'absent-from-schema',
    reason: 'pickups.bin has no charge/ammo/count field; HUD only names blindfire1..3.',
  },
  projectileLifetime: {
    status: 'not-serialized',
    reason: 'Blindfire/Shunt balancing data has Speed and DamageInflicted but no lifetime.',
  },
  humanTargeting: {
    status: 'runtime-only',
    reason: 'Only AI trigger data is serialized; human target selection is runtime code.',
  },
  damageFalloff: {
    status: 'not-serialized',
    reason: 'Bomb has Radius and OuterRadius; the falloff law between them is not in the data.',
  },
  normalRespawnSeconds: {
    status: 'not-serialized',
    reason: 'MpPowerupRespawn.Normal has no seconds; only Long=5.0 and VeryLong=20.0 are stored.',
  },
  pickupInventoryCapacity: {
    status: 'runtime-only',
    reason: 'NetPlayerVehicle carries a 16-bit pickupSlots mask; held-item capacity is code.',
  },
  healthScale: {
    status: 'runtime-only',
    reason: 'Repair.AmountToRepair is 400 but no max-health field is in these packs.',
  },
  shieldAbsorbModel: {
    status: 'prototype-assumption',
    reason: 'ShieldBalancingData.Health is treated as shield hit points in this prototype.',
  },
  respawnEnumSemantics: {
    status: 'prototype-assumption',
    reason: 'AlwaysOn is modelled as 0 s and None as no respawn; the enum labels are data, '
          + 'the timing interpretation is not.',
  },
});

const MODE_ALIAS = {
  nitro: 'Nitrous',
  nitrous: 'Nitrous',
  shock: 'Shock',
  shunt: 'Shunt',
  bolt: 'Blindfire',
  blindfire: 'Blindfire',
  barge: 'Barge',
  mine: 'Bomb',
  bomb: 'Bomb',
  repair: 'Repair',
  shield: 'Shield',
  supershield: 'SuperShield',
};

function scalars(value) {
  const out = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    if (key.startsWith('$')) continue;
    if (typeof item === 'number' || typeof item === 'boolean' || typeof item === 'string') {
      out[key] = item;
    }
  }
  return out;
}

export function buildCatalog(manifest) {
  const entities = new Map();
  for (const entity of manifest.entities) {
    const levels = {};
    for (const [slot, level] of Object.entries(entity.levels)) {
      levels[slot] = {
        record: level.record,
        balancingType: level.balancingType,
        values: scalars(level.balancing),
        graph: level.balancingGraph.keyframes.map(scalars),
      };
    }
    entities.set(entity.pickupLabel, {
      label: entity.pickupLabel,
      record: entity.record,
      refId: entity.refId,
      baseProbability: entity.baseProbability,
      doNotRandomise: entity.doNotRandomise,
      levels,
      hudKeys: entity.hud.key,
      audio: entity.audio.entities.map((row) => row.name),
      multiplayerAlias: entity.multiplayer?.multiplayer ?? null,
    });
  }

  const config = manifest.modes.config;
  const respawn = {
    Normal: null,
    Long: config.powerupRespawnToggleLong,
    VeryLong: config.powerupRespawnToggleVeryLong,
    AlwaysOn: 0,
    None: Infinity,
  };

  const alias = new Map();
  for (const [key, value] of Object.entries(MODE_ALIAS)) alias.set(key, value);

  return {
    schema: manifest.schema,
    manifestHash: manifest.hashes.manifestContent,
    system: {
      radius: manifest.pickupSystem.parameters.PickupRadius,
      deactivateSeconds: manifest.pickupSystem.parameters.PickupDeactivateTimer,
      awardCooldownSeconds: manifest.pickupSystem.parameters.PostPickupAwardCoolDownTimer,
      destroyExistingOnNew: manifest.pickupSystem.parameters.DestroyExistingPickupOnNewPickup,
      maximumXpMultiplier: manifest.pickupSystem.parameters.MaximumXPMultiplication,
      record: manifest.pickupSystem.record,
    },
    online: manifest.modes.onlinePickupParameters,
    respawnDelays: respawn,
    respawnSemantics: UNKNOWNS.respawnEnumSemantics,
    damageMultipliers: config.damageMultipliers,
    entities,
    alias,
  };
}

function distance(a, b) {
  const dx = (a?.x ?? 0) - (b?.x ?? 0);
  const dz = (a?.z ?? 0) - (b?.z ?? 0);
  return Math.hypot(dx, dz);
}

export function createWorld(manifest, options = {}) {
  const catalog = buildCatalog(manifest);
  const authority = options.authorityId ?? 'host';
  let nextId = 0;

  const world = {
    catalog,
    authority,
    mode: options.mode ?? 'Normal',
    normalRespawnSeconds: options.normalRespawnSeconds ?? null,
    now: 0,
    events: [],
    players: new Map(),
    pickups: new Map(),
    mines: [],
    effects: [],
    nextId: () => ++nextId,

    emit(type, data = {}) {
      const event = {
        seq: this.events.length + 1,
        type,
        at: this.now,
        authority: this.authority,
        ...data,
      };
      this.events.push(event);
      return event;
    },

    addPlayer(id, config = {}) {
      const health = config.health ?? 100;
      const player = {
        id,
        health,
        maxHealth: config.maxHealth ?? health,
        inventory: [],
        inventoryCapacity: config.inventoryCapacity ?? 1,
        position: config.position ?? { x: 0, z: 0 },
        nextUseAt: 0,
        fans: 0,
        stopwatchSeconds: 0,
        score: 0,
        alive: true,
      };
      this.players.set(id, player);
      this.emit('player-joined', { playerId: id, health: player.health });
      return player;
    },

    spawnPickup(typeLabel, position, options_ = {}) {
      const definition = catalog.entities.get(typeLabel);
      if (!definition) throw new Error(`unknown pickup type ${typeLabel}`);
      const id = `pickup-${this.nextId()}`;
      const item = {
        id,
        type: typeLabel,
        position,
        state: 'active',
        respawnAt: null,
        respawnMode: options_.mode ?? this.mode,
        respawnUnresolvedEmitted: false,
        sourceRecord: definition.record,
      };
      this.pickups.set(id, item);
      this.emit('pickup-spawned', { pickupId: id, pickupType: typeLabel, position });
      return item;
    },

    pickup(pickupId, playerId) {
      const item = this.pickups.get(pickupId);
      const player = this.players.get(playerId);
      if (!item || item.state !== 'active') {
        return this.emit('pickup-rejected', { pickupId, playerId, reason: 'not-active' });
      }
      if (!player) {
        return this.emit('pickup-rejected', { pickupId, playerId, reason: 'no-player' });
      }
      if (player.inventory.length >= player.inventoryCapacity) {
        return this.emit('pickup-rejected', {
          pickupId, playerId, reason: 'inventory-full',
          capacityIsRuntimeOnly: UNKNOWNS.pickupInventoryCapacity,
        });
      }

      player.inventory.push({ type: item.type, level: 'Normal' });
      item.state = 'deactivated';

      const delay = catalog.respawnDelays[item.respawnMode];
      const configured = delay === undefined || delay === null
        ? (item.respawnMode === 'Normal' ? this.normalRespawnSeconds : null)
        : delay;
      if (configured === undefined || configured === null) {
        item.respawnAt = null;
        return this.emit('pickup', {
          pickupId, playerId, pickupType: item.type,
          respawn: {
            status: 'unresolved', mode: item.respawnMode,
            field: 'normalRespawnSeconds',
            resolution: UNKNOWNS.normalRespawnSeconds.status,
            reason: UNKNOWNS.normalRespawnSeconds.reason,
          },
        });
      }
      item.respawnAt = this.now + catalog.system.deactivateSeconds + configured;
      return this.emit('pickup', {
        pickupId, playerId, pickupType: item.type,
        respawn: {
          status: 'scheduled',
          mode: item.respawnMode,
          deactivateSeconds: catalog.system.deactivateSeconds,
          modeDelaySeconds: configured,
          at: item.respawnAt,
        },
      });
    },

    use(playerId, request = {}) {
      const player = this.players.get(playerId);
      if (!player) return this.emit('use-rejected', { playerId, reason: 'no-player' });
      if (this.now < player.nextUseAt) {
        return this.emit('use-rejected', {
          playerId, reason: 'cooldown', nextUseAt: player.nextUseAt,
        });
      }
      if (!player.inventory.length) {
        return this.emit('use-rejected', { playerId, reason: 'empty-inventory' });
      }
      const slot = request.slot ?? 0;
      const item = player.inventory.splice(slot, 1)[0];
      const definition = catalog.entities.get(item.type);
      const level = definition.levels[item.level] ?? definition.levels.Normal;
      if (!level) {
        return this.emit('use-rejected', {
          playerId, pickupType: item.type, reason: 'no-balancing-level',
        });
      }
      const balancing = level.values;
      player.nextUseAt = this.now + (balancing.Delay ?? 0);
      const base = {
        playerId,
        pickupType: item.type,
        level: item.level,
        balancingType: level.balancingType,
        balancingRecord: level.record,
      };

      switch (item.type) {
        case 'Shield': {
          const effect = {
            id: `effect-${this.nextId()}`,
            kind: 'shield',
            ownerId: playerId,
            expiresAt: this.now + balancing.Lifetime,
            capacity: balancing.Health,
            maxCapacity: balancing.Health,
            damageModel: UNKNOWNS.shieldAbsorbModel,
          };
          this.effects.push(effect);
          return this.emit('shield-activated', { ...base, effect });
        }
        case 'SuperShield': {
          const effect = {
            id: `effect-${this.nextId()}`,
            kind: 'superShield',
            ownerId: playerId,
            expiresAt: this.now + balancing.Lifetime,
            capacity: balancing.Health,
            maxCapacity: balancing.Health,
            nitroOnStartup: balancing.NitroOnStartup,
            nitroTargetSpeedInMPH: balancing.NitroTargetSpeedInMPH,
            boostDuringUse: balancing.BoostDuringUse,
            steeringBoost: balancing.SteeringBoost,
            accelerationBoost: balancing.AccelerationBoost,
            brakingBoost: balancing.BrakingBoost,
            downForceBoost: balancing.DownForceBoost,
            damagePointsOnImpact: balancing.DamagePointsOnImpact,
            increasedMass: balancing.IncreasedMass,
            damageModel: UNKNOWNS.shieldAbsorbModel,
          };
          this.effects.push(effect);
          return this.emit('super-shield-activated', { ...base, effect });
        }
        case 'Nitrous': {
          const duration = request.checkpoint && balancing.DurationCheckpoint > balancing.Duration
            ? balancing.DurationCheckpoint
            : balancing.Duration;
          const effect = {
            id: `effect-${this.nextId()}`,
            kind: 'nitro',
            ownerId: playerId,
            expiresAt: this.now + duration,
            duration,
            slowDownGraphValue: request.checkpoint
              ? balancing.SlowDownGraphValueCheckpoint
              : balancing.SlowDownGraphValue,
            classModifiers: {
              A: balancing.ClassAModifier,
              B: balancing.ClassBModifier,
              C: balancing.ClassCModifier,
              D: balancing.ClassDModifier,
            },
          };
          this.effects.push(effect);
          return this.emit('nitro-activated', { ...base, effect });
        }
        case 'Repair': {
          const before = player.health;
          player.health = Math.min(player.maxHealth, player.health + balancing.AmountToRepair);
          return this.emit('repaired', {
            ...base, amount: player.health - before, health: player.health,
            healthScale: UNKNOWNS.healthScale,
          });
        }
        case 'Bomb': {
          const mine = {
            id: `mine-${this.nextId()}`,
            ownerId: playerId,
            position: request.position ?? player.position,
            radius: balancing.Radius,
            outerRadius: balancing.OuterRadius,
            damage: balancing.DamageInflicted,
            armAt: this.now + (balancing.MasterMinePrimeTimer ?? 0),
            expiresAt: this.now + balancing.Lifespan,
            falloff: UNKNOWNS.damageFalloff,
            record: level.record,
          };
          this.mines.push(mine);
          return this.emit('mine-placed', { ...base, mine });
        }
        case 'Shock': {
          const effect = {
            id: `effect-${this.nextId()}`,
            kind: 'shock',
            ownerId: playerId,
            position: request.position ?? player.position,
            expiresAt: this.now + balancing.Lifetime,
            innerRadius: balancing.InnerRadius,
            outerRadius: balancing.OuterRadius,
            damage: balancing.DamageInflicted,
            heightDiff: balancing.HeightDiff,
          };
          this.effects.push(effect);
          return this.emit('shock-activated', { ...base, effect });
        }
        case 'Barge': {
          const effect = {
            id: `effect-${this.nextId()}`,
            kind: 'barge',
            ownerId: playerId,
            expiresAt: this.now + balancing.Duration,
            radius: balancing.Radius,
            damage: balancing.DamageInflicted,
            minMinePushForce: balancing.MinMinePushForce,
            minePushForceMultiplier: balancing.MinePushForceMultiplier,
          };
          this.effects.push(effect);
          return this.emit('barge-activated', { ...base, effect });
        }
        case 'Shunt':
        case 'Blindfire': {
          const projectile = {
            id: `projectile-${this.nextId()}`,
            kind: 'projectile',
            projectileType: item.type,
            ownerId: playerId,
            targetId: request.targetId ?? null,
            damage: balancing.DamageInflicted,
            speed: balancing.Speed,
            radius: balancing.Radius,
            expiresAt: null,
            lifetime: UNKNOWNS.projectileLifetime,
            record: level.record,
          };
          this.effects.push(projectile);
          return this.emit('projectile-fired', { ...base, projectile });
        }
        case 'Fan': {
          player.fans += balancing.FansToGain;
          return this.emit('fans-gained', { ...base, amount: balancing.FansToGain, fans: player.fans });
        }
        case 'Stopwatch': {
          player.stopwatchSeconds += balancing.TimeToGain;
          return this.emit('stopwatch-gained', {
            ...base, amount: balancing.TimeToGain, total: player.stopwatchSeconds,
          });
        }
        default:
          return this.emit('use-rejected', {
            playerId, pickupType: item.type, reason: 'no-prototype-handler',
          });
      }
    },

    damage(targetId, amount, source = {}) {
      const player = this.players.get(targetId);
      if (!player) {
        this.emit('damage-rejected', { targetId, reason: 'no-player' });
        return { absorbed: 0, remaining: 0, health: null, events: [] };
      }
      const start = this.events.length;
      let remaining = amount;
      let absorbedTotal = 0;
      const shield = this.effects.find((e) => e.ownerId === targetId
        && (e.kind === 'shield' || e.kind === 'superShield') && e.expiresAt > this.now);
      if (shield) {
        const absorbed = Math.min(shield.capacity, remaining);
        shield.capacity -= absorbed;
        remaining -= absorbed;
        absorbedTotal = absorbed;
        this.emit('shield-absorbed', {
          targetId, source, absorbed, remaining, capacity: shield.capacity,
          effectId: shield.id, damageModel: UNKNOWNS.shieldAbsorbModel,
        });
        if (shield.capacity <= 0) {
          this.effects = this.effects.filter((e) => e !== shield);
          this.emit('shield-broken', { targetId, effectId: shield.id, source });
        }
      }
      if (remaining > 0) {
        player.health = Math.max(0, player.health - remaining);
        this.emit('damage', {
          targetId, source, amount: remaining, health: player.health,
          healthScale: UNKNOWNS.healthScale,
        });
        if (player.health === 0 && player.alive) {
          player.alive = false;
          this.emit('wrecked', { targetId, source });
        }
      }
      return {
        absorbed: absorbedTotal,
        remaining,
        health: player.health,
        events: this.events.slice(start),
      };
    },

    resolveProjectile(projectileId, targetId) {
      const projectile = this.effects.find((e) => e.id === projectileId && e.kind === 'projectile');
      if (!projectile) {
        return this.emit('projectile-rejected', { projectileId, reason: 'not-found' });
      }
      this.effects = this.effects.filter((e) => e !== projectile);
      this.emit('projectile-hit', {
        projectileId, targetId, projectileType: projectile.projectileType,
        damage: projectile.damage,
      });
      this.damage(targetId, projectile.damage, { kind: projectile.projectileType, projectileId });
      return this.events[this.events.length - 1];
    },

    advance(dt) {
      if (!(dt >= 0)) throw new Error('advance() needs a non-negative dt');
      this.now += dt;
      const start = this.events.length;

      for (const item of this.pickups.values()) {
        if (item.state !== 'deactivated') continue;
        if (item.respawnAt === null) {
          if (!item.respawnUnresolvedEmitted) {
            item.respawnUnresolvedEmitted = true;
            this.emit('respawn-unresolved', {
              pickupId: item.id, pickupType: item.type, mode: item.respawnMode,
              status: UNKNOWNS.normalRespawnSeconds.status,
              field: 'normalRespawnSeconds',
              reason: UNKNOWNS.normalRespawnSeconds.reason,
            });
          }
          continue;
        }
        if (this.now >= item.respawnAt) {
          item.state = 'active';
          item.respawnAt = null;
          item.respawnUnresolvedEmitted = false;
          this.emit('pickup-respawn', { pickupId: item.id, pickupType: item.type });
        }
      }

      for (const mine of [...this.mines]) {
        if (this.now < mine.armAt) continue;
        if (this.now >= mine.expiresAt) {
          this.mines = this.mines.filter((m) => m !== mine);
          this.emit('mine-expired', { mineId: mine.id, mineType: 'Bomb', at: mine.expiresAt });
          continue;
        }
        const inside = [...this.players.values()]
          .filter((p) => p.alive && distance(p.position, mine.position) <= mine.radius);
        const near = [...this.players.values()]
          .filter((p) => p.alive && distance(p.position, mine.position) <= mine.outerRadius);
        if (!near.length) continue;
        this.mines = this.mines.filter((m) => m !== mine);
        this.emit('mine-detonated', {
          mineId: mine.id, position: mine.position,
          directHits: inside.map((p) => p.id), nearMisses: near.filter((p) => !inside.includes(p)).map((p) => p.id),
        });
        for (const target of inside) {
          this.damage(target.id, mine.damage, { kind: 'Bomb', mineId: mine.id });
        }
        for (const target of near) {
          if (!inside.includes(target)) {
            this.emit('mine-near-miss', {
              mineId: mine.id, targetId: target.id, falloff: UNKNOWNS.damageFalloff,
            });
          }
        }
      }

      for (const effect of [...this.effects]) {
        if (effect.expiresAt !== null && effect.expiresAt <= this.now) {
          this.effects = this.effects.filter((e) => e !== effect);
          this.emit('effect-expired', {
            effectId: effect.id, kind: effect.kind, ownerId: effect.ownerId,
            at: effect.expiresAt,
          });
        }
      }

      return this.events.slice(start);
    },

    snapshot() {
      return {
        at: this.now,
        authority: this.authority,
        mode: this.mode,
        players: [...this.players.values()]
          .map((p) => ({
            id: p.id, health: p.health, maxHealth: p.maxHealth,
            inventory: p.inventory.map((i) => `${i.type}:${i.level}`),
            position: p.position, alive: p.alive, nextUseAt: p.nextUseAt,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        pickups: [...this.pickups.values()]
          .map((p) => ({ id: p.id, type: p.type, state: p.state, respawnAt: p.respawnAt }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        mines: this.mines.map((m) => ({ id: m.id, ownerId: m.ownerId, armAt: m.armAt,
                                        expiresAt: m.expiresAt, position: m.position })),
        effects: this.effects.map((e) => ({ id: e.id, kind: e.kind, ownerId: e.ownerId,
                                            expiresAt: e.expiresAt })),
        eventCount: this.events.length,
      };
    },
  };

  return world;
}
