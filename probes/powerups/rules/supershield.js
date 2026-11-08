/**
 * Typed SuperShield rules model (SS1).
 *
 * Values come from `_work/powerups/supershield.json`, built from the shipped PAK
 * and the extracted retail source. This file does not hard-code a game value:
 * every serialized number is read from `manifest.balancing.fields`; runtime
 * constants (ram cooldown, Ultra weight class, fake-speed mode) are read from
 * `manifest.runtime` and carry their source citations in the manifest.
 *
 * Two things are deliberately NOT modelled as if they were retail:
 *   1. `Health=50` is serialized but unused by C_PickupSuperShield. It is never
 *      used as a damage cap. `absorb()` is a time-limited, unlimited absorb.
 *   2. An optional `provisionalAbsorbCap` can be supplied by the caller. It is a
 *      project extension, labelled `provisional:true` on the event.
 *
 * This is a deterministic rules/event prototype, not a retail-physics claim.
 */

export const MODEL_VERSION = 'ss1-supershield/1';

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function clone(v) {
  return { x: v.x, y: v.y, z: v.z };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function field(manifest, name) {
  const row = manifest?.balancing?.fields?.[name];
  if (!row) throw new Error(`missing serialized field ${name}`);
  return row.value;
}

function fieldStatus(manifest, name) {
  return manifest?.balancing?.fields?.[name]?.status ?? 'unknown';
}

function buildIndex(manifest) {
  if (!manifest || manifest.schema !== 'blur-powerups-supershield/1') {
    throw new Error('supershield manifest is missing or has an unexpected schema');
  }
  return manifest;
}

export function recoveredValues(manifest) {
  buildIndex(manifest);
  return Object.fromEntries(
    Object.entries(manifest.balancing.fields).map(([name, row]) => [name, row.value]));
}

export function createSuperShieldModel(manifest, options = {}) {
  buildIndex(manifest);
  const authority = options.authorityId ?? 'host';
  const runtime = manifest.runtime;
  const pickupType = manifest.entity.pickupLabel;
  const model = manifest.multiplayer?.wire?.pickupFiredTypeNibble ?? null;
  let nextSeq = 0;
  let nextId = 0;

  const world = {
    manifest,
    authority,
    now: 0,
    events: [],
    cars: new Map(),
    shields: new Map(),
    ramCooldowns: new Map(),

    emit(type, data = {}) {
      const event = { seq: ++nextSeq, type, at: this.now, authority, ...data };
      this.events.push(event);
      return event;
    },

    addCar(id, config = {}) {
      const health = config.health ?? 100;
      const car = {
        id,
        health,
        maxHealth: config.maxHealth ?? health,
        massKg: config.massKg ?? null,
        position: config.position ? clone(config.position) : { x: 0, y: 0, z: 0 },
        alive: config.alive ?? true,
      };
      this.cars.set(id, car);
      return car;
    },

    car(id) {
      const car = this.cars.get(id);
      if (!car) throw new Error(`unknown car ${id}`);
      return car;
    },

    shield(ownerId) {
      return this.shields.get(ownerId) ?? null;
    },

    // --------------------------------------------------------------- activate
    activate(ownerId, request = {}) {
      const car = this.car(ownerId);
      const active = this.shields.get(ownerId);
      if (active?.active) {
        return this.emit('supershield-replaced', {
          ownerId,
          pickupId: request.pickupId ?? null,
          reason: 'already-active',
          refreshed: false,
          remainingSeconds: active.remainingSeconds,
          source: runtime.activation.source,
        });
      }

      const massBefore = request.massKg ?? car.massKg;
      if (massBefore == null) {
        return this.emit('supershield-rejected', {
          ownerId,
          reason: 'missing-original-mass',
          missing: {
            status: 'runtime-engine-data',
            field: 'massKg',
            reason: 'C_PickupSuperShield stores the body mass and reverts it on expiry; engine data is not in these packs.',
            source: 'PickupSuperShield.cpp:61-67,192',
          },
        });
      }
      if (!(massBefore > 0)) throw new Error('activate() needs a positive massKg');

      const lifetime = field(manifest, 'Lifetime');
      const provisionalAbsorbCap = request.provisionalAbsorbCap ?? null;
      if (provisionalAbsorbCap != null && !(provisionalAbsorbCap > 0)) {
        throw new Error('provisionalAbsorbCap must be positive or null');
      }

      const shield = {
        id: `shield-${++nextId}`,
        ownerId,
        pickupId: request.pickupId ?? null,
        level: request.level ?? 'Normal',
        active: true,
        lifetimeSeconds: lifetime,
        remainingSeconds: lifetime,
        expiresAt: this.now + lifetime,
        massBeforeKg: massBefore,
        massActiveKg: field(manifest, 'IncreasedMass'),
        weightClass: runtime.collision.weightClass,
        absorbModel: runtime.absorb.model,
        healthField: {
          value: field(manifest, 'Health'),
          status: fieldStatus(manifest, 'Health'),
        },
        provisionalAbsorbCap,
        absorbedTotal: 0,
      };
      car.massKg = shield.massActiveKg;
      this.shields.set(ownerId, shield);

      this.emit('supershield-activated', {
        ownerId,
        pickupId: shield.pickupId,
        pickupType,
        typeId: manifest.entity.refId,
        level: shield.level,
        lifetimeSeconds: lifetime,
        delaySeconds: field(manifest, 'Delay'),
        massKgBefore: shield.massBeforeKg,
        massActiveKg: shield.massActiveKg,
        weightClass: shield.weightClass,
        absorbModel: shield.absorbModel,
        healthField: shield.healthField,
        nitro: {
          enabled: field(manifest, 'NitroOnStartup'),
          mode: runtime.nitro.mode,
          targetMph: runtime.nitro.targetMph,
          targetMps: runtime.nitro.targetMps,
          status: 'event-only-fake-speed',
        },
        boosts: {
          enabled: field(manifest, 'BoostDuringUse'),
          steeringBoost: field(manifest, 'SteeringBoost'),
          accelerationBoost: field(manifest, 'AccelerationBoost'),
          brakingBoost: {
            value: field(manifest, 'BrakingBoost'),
            status: fieldStatus(manifest, 'BrakingBoost'),
          },
          downForceBoost: field(manifest, 'DownForceBoost'),
          minimumTriggerValue: field(manifest, 'MinimumTriggerValue'),
        },
        hud: {
          key: manifest.hud.key,
          textureIndex: manifest.hud.entry.texture_index,
        },
        audio: {
          status: manifest.audio.status,
          entity: manifest.audio.superShieldEntity,
          fxDurationMessageType: manifest.audio.fxDurationMessageType,
        },
        wireTypeNibble: model,
        source: runtime.activation.source,
      });
      return shield;
    },

    // ----------------------------------------------------------------- absorb
    absorb(ownerId, amount, source = {}) {
      if (!(amount >= 0)) throw new Error('absorb() needs a non-negative amount');
      const shield = this.shields.get(ownerId);
      if (!shield?.active) {
        return { absorbed: 0, leaked: amount, status: 'not-active' };
      }

      let absorbed = amount;
      let leaked = 0;
      const cap = shield.provisionalAbsorbCap;
      if (cap != null) {
        const left = Math.max(0, cap - shield.absorbedTotal);
        absorbed = Math.min(amount, left);
        leaked = amount - absorbed;
      }
      shield.absorbedTotal += absorbed;

      if (leaked > 0) {
        this.damage(ownerId, leaked, {
          kind: 'supershield-overflow',
          shieldId: shield.id,
          provisional: cap != null,
        });
      }

      this.emit('supershield-absorbed', {
        ownerId,
        shieldId: shield.id,
        sourcePickupType: source.pickupType ?? null,
        attemptedDamage: amount,
        absorbedDamage: absorbed,
        leakedDamage: leaked,
        shieldRemainingSeconds: shield.remainingSeconds,
        healthUnchanged: leaked === 0,
        absorbModel: shield.absorbModel,
        cap: cap == null ? null : { value: cap, status: 'provisional' },
        provisional: cap != null,
        source: runtime.absorb.source,
      });

      if (cap != null && shield.absorbedTotal >= cap) {
        this.expire(ownerId, 'provisional-damage-cap');
      }
      return { absorbed, leaked, remaining: shield.remainingSeconds, status: 'absorbed' };
    },

    // -------------------------------------------------------------------- hit
    hit(targetId, amount, source = {}) {
      const car = this.car(targetId);
      if (!car.alive) {
        return { absorbed: 0, leaked: 0, status: 'not-alive' };
      }
      if (source.pickupType === 'Nitrous') {
        this.emit('supershield-bypassed', {
          targetId,
          pickupType: source.pickupType,
          reason: 'nitrous-excluded',
          source: runtime.absorb.source,
        });
        return { absorbed: 0, leaked: 0, status: 'bypassed' };
      }
      if (this.shields.get(targetId)?.active) {
        return this.absorb(targetId, amount, source);
      }
      this.damage(targetId, amount, source);
      return { absorbed: 0, leaked: amount, status: 'damaged' };
    },

    // -------------------------------------------------------------------- ram
    ram(ownerId, rammerId, request = {}) {
      const shield = this.shields.get(ownerId);
      if (!shield?.active) {
        return this.emit('supershield-ram-ignored', {
          ownerId, rammerId, reason: 'no-active-shield',
        });
      }
      if (this.shields.get(rammerId)?.active) {
        return this.emit('supershield-ram-ignored', {
          ownerId, rammerId, reason: 'both-shielded', damage: 0,
        });
      }
      const readyAt = this.ramCooldowns.get(rammerId) ?? 0;
      if (this.now < readyAt) {
        return this.emit('supershield-ram-ignored', {
          ownerId, rammerId, reason: 'cooldown',
          cooldownRemainingSeconds: readyAt - this.now,
        });
      }
      if (request.relativeDotLeft == null) {
        return this.emit('supershield-ram-rejected', {
          ownerId, rammerId, reason: 'missing-relative-dot',
          missing: {
            status: 'runtime-only',
            field: 'relativeDotLeft',
            reason: 'Retail picks jink left/right from dot(rammer->shield vector, rammer local left axis); the model will not invent a side.',
            source: 'VLC_Pickups.cpp:2320-2329',
          },
        });
      }
      const damage = field(manifest, 'DamagePointsOnImpact');
      const jink = request.relativeDotLeft < 0 ? 'jink-shield-left' : 'jink-shield-right';
      this.ramCooldowns.set(rammerId, this.now + runtime.ram.cooldownSeconds);
      this.emit('supershield-rammed', {
        ownerId,
        shieldId: shield.id,
        rammerId,
        damage,
        damageCap: runtime.ram.damageCap,
        jink,
        cooldownSeconds: runtime.ram.cooldownSeconds,
        shieldRemainingSeconds: shield.remainingSeconds,
        source: runtime.ram.source,
      });
      this.damage(rammerId, damage, {
        kind: 'SuperShieldRam',
        ownerId,
        shieldId: shield.id,
        jink,
      });
      return damage;
    },

    // ----------------------------------------------------------------- boosts
    applyBoosts(ownerId, request = {}) {
      const shield = this.shields.get(ownerId);
      if (!shield?.active) return null;
      if (!field(manifest, 'BoostDuringUse')) {
        return this.emit('supershield-boost-suppressed', {
          ownerId, reason: 'BoostDuringUse=false',
        });
      }
      const car = this.car(ownerId);
      const axes = request.axes ?? {
        left: { x: 1, y: 0, z: 0 },
        forward: { x: 0, y: 0, z: 1 },
        up: { x: 0, y: 1, z: 0 },
      };
      const steeringInput = clamp(request.steeringInput ?? 0, -1, 1);
      const accelerator = clamp(request.throttleInput ?? 0, 0, 1);
      const brake = clamp(request.brakeInput ?? 0, 0, 1);
      const min = field(manifest, 'MinimumTriggerValue');
      const normalise = (input) => {
        if (!(input > min)) return 0;
        return min < 1 ? (input - min) / (1 - min) : input;
      };
      const throttleNormalised = accelerator > 0 ? normalise(accelerator) : -normalise(brake);
      const steeringImpulse = scale(axes.left, steeringInput * field(manifest, 'SteeringBoost'));
      const accelerationImpulse = scale(
        axes.forward, field(manifest, 'AccelerationBoost') * throttleNormalised);
      const downForceImpulse = scale(axes.up, -field(manifest, 'DownForceBoost'));
      const applicationPoint = add(
        car.position, scale(axes.forward, field(manifest, 'SteeringForwardOffset')));

      this.emit('supershield-boost-applied', {
        ownerId,
        shieldId: shield.id,
        steeringImpulse,
        accelerationImpulse,
        downForceImpulse,
        steeringApplicationPoint: applicationPoint,
        steeringInput,
        throttleInput: accelerator,
        brakeInput: brake,
        throttleNormalised,
        brakingBoostStatus: fieldStatus(manifest, 'BrakingBoost'),
        localPlayerOnly: runtime.boosts.localPlayerOnly,
        source: runtime.boosts.source,
      });
      return {
        steeringImpulse, accelerationImpulse, downForceImpulse,
        steeringApplicationPoint: applicationPoint, throttleNormalised,
      };
    },

    // ------------------------------------------------------------------ expire
    expire(ownerId, reason = 'lifetime') {
      const shield = this.shields.get(ownerId);
      if (!shield?.active) return null;
      shield.active = false;
      shield.remainingSeconds = 0;
      const car = this.car(ownerId);
      car.massKg = shield.massBeforeKg;
      this.emit('supershield-expired', {
        ownerId,
        shieldId: shield.id,
        pickupId: shield.pickupId,
        reason,
        lifetimeSeconds: shield.lifetimeSeconds,
        massKgRevertedTo: shield.massBeforeKg,
        absorbedTotal: shield.absorbedTotal,
        source: runtime.expiry?.source ?? 'PickupSuperShield.cpp:182-195',
      });
      return shield;
    },

    // ----------------------------------------------------------------- damage
    damage(targetId, amount, source = {}) {
      if (!(amount >= 0)) throw new Error('damage() needs a non-negative amount');
      const car = this.cars.get(targetId);
      if (!car) return this.emit('damage-rejected', { targetId, reason: 'no-car' });
      if (!car.alive) return this.emit('damage-rejected', { targetId, reason: 'not-alive' });
      car.health = Math.max(0, car.health - amount);
      this.emit('damage', {
        targetId,
        amount,
        health: car.health,
        maxHealth: car.maxHealth,
        source,
      });
      if (car.health === 0) {
        car.alive = false;
        this.emit('wrecked', { targetId, source });
      }
      return car.health;
    },

    // ---------------------------------------------------------------- advance
    advance(dt) {
      if (!(dt >= 0)) throw new Error('advance() needs a non-negative dt');
      const start = this.events.length;
      this.now += dt;
      for (const shield of this.shields.values()) {
        if (!shield.active) continue;
        shield.remainingSeconds -= dt;
        if (shield.remainingSeconds <= 0) this.expire(shield.ownerId, 'lifetime');
      }
      return this.events.slice(start);
    },

    snapshot() {
      return {
        at: this.now,
        authority,
        model: MODEL_VERSION,
        cars: [...this.cars.values()]
          .map((car) => ({
            id: car.id,
            health: car.health,
            maxHealth: car.maxHealth,
            massKg: car.massKg,
            alive: car.alive,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        shields: [...this.shields.values()]
          .filter((shield) => shield.active)
          .map((shield) => ({
            id: shield.id,
            ownerId: shield.ownerId,
            pickupId: shield.pickupId,
            remainingSeconds: shield.remainingSeconds,
            lifetimeSeconds: shield.lifetimeSeconds,
            massBeforeKg: shield.massBeforeKg,
            massActiveKg: shield.massActiveKg,
            weightClass: shield.weightClass,
            absorbedTotal: shield.absorbedTotal,
            provisionalAbsorbCap: shield.provisionalAbsorbCap,
          }))
          .sort((a, b) => a.ownerId.localeCompare(b.ownerId)),
        eventCount: this.events.length,
      };
    },
  };

  return world;
}
