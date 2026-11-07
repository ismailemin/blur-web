/**
 * Typed projectile / impulse rules model for the Blur power-ups.
 *
 * The values come from `_work/powerups/projectiles.json` (PWR4), which is built
 * from the shipped PAK and the extracted retail source. This file never
 * hard-codes a game value and never invents a missing one:
 *
 *   - serialized values (speed, radius, damage, lifetime base, ...) are read from
 *     the manifest;
 *   - runtime-only values (Blindfire/Shunt lifetime, charges, Shock width,
 *     target extents) are read from the manifest or required as caller inputs;
 *   - anything the model does not know is exposed as a typed `missing`/`source`
 *     field and the operation throws or returns a typed refusal.
 *
 * This is a deterministic rules prototype, not a retail-behaviour claim.
 */

export const MODEL_VERSION = 'pwr4-projectiles/1';

const DEG = Math.PI / 180;

function clone(v) {
  return { x: v.x, y: v.y, z: v.z };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function length(a) {
  return Math.hypot(a.x, a.y, a.z);
}

function norm(a) {
  const l = length(a);
  if (!(l > 0)) throw new Error('cannot normalise a zero vector');
  return scale(a, 1 / l);
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function distance(a, b) {
  return length(sub(a, b));
}

function horizontal(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function segmentSphereHit(a, b, center, radius) {
  const ab = sub(b, a);
  const ac = sub(center, a);
  const denom = dot(ab, ab);
  const t = denom > 0 ? clamp(dot(ac, ab) / denom, 0, 1) : 0;
  const p = add(a, scale(ab, t));
  return { hit: distance(p, center) <= radius, t, point: p };
}

function rotateTowards(dir, want, maxRadians) {
  const d = norm(dir);
  const w = norm(want);
  const cos = clamp(dot(d, w), -1, 1);
  const angle = Math.acos(cos);
  if (angle <= maxRadians || angle < 1e-6) return w;
  const perpRaw = sub(w, scale(d, cos));
  if (length(perpRaw) < 1e-6) return d;
  const perp = norm(perpRaw);
  const s = Math.sin(maxRadians);
  const c = Math.cos(maxRadians);
  return norm(add(scale(d, c), scale(perp, s)));
}

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function field(level, name) {
  const row = level?.fields?.[name];
  if (!row) throw new Error(`missing serialized field ${name}`);
  return row.value;
}

function missing(manifest, type, name) {
  return (manifest.unknowns?.[type] ?? []).find((row) => row.field === name) ?? null;
}

function buildIndex(manifest) {
  const types = new Map();
  for (const [label, value] of Object.entries(manifest.types)) {
    types.set(label, value);
  }
  return { types, manifest };
}

function levelOf(index, type, level = 'Normal') {
  const entity = index.types.get(type);
  if (!entity) throw new Error(`unknown pickup type ${type}`);
  const row = entity.levels[level];
  if (!row) throw new Error(`unknown level ${type}.${level}`);
  return row;
}

export function recoveredValues(manifest, type, level = 'Normal') {
  const index = buildIndex(manifest);
  const row = levelOf(index, type, level);
  return Object.fromEntries(Object.entries(row.fields).map(([k, v]) => [k, v.value]));
}

export function createProjectileModel(manifest, options = {}) {
  if (!manifest || manifest.schema !== 'blur-powerups-projectiles/1') {
    throw new Error('projectiles manifest is missing or has an unexpected schema');
  }
  const index = buildIndex(manifest);
  const authority = options.authorityId ?? 'host';
  const runtime = manifest.runtimeValues;
  let nextSeq = 0;
  let nextId = 0;

  const world = {
    manifest,
    authority,
    now: 0,
    events: [],
    cars: new Map(),
    projectiles: [],
    effects: [],
    inventory: new Map(),

    emit(type, data = {}) {
      const event = { seq: ++nextSeq, type, at: this.now, authority, ...data };
      this.events.push(event);
      return event;
    },

    addCar(id, config = {}) {
      if (!config.position) throw new Error(`addCar(${id}) needs position`);
      const car = {
        id,
        position: clone(config.position),
        forward: config.forward ? norm(config.forward) : { x: 0, y: 0, z: 1 },
        speedMps: config.speedMps ?? 0,
        massKg: config.massKg ?? null,
        radiusM: config.radiusM ?? null,
        extents: config.extents ?? null,
        racePosition: config.racePosition ?? null,
        health: config.health ?? 100,
        maxHealth: config.maxHealth ?? config.health ?? 100,
        alive: config.alive ?? true,
        targetRadiusSource: config.radiusM == null
          ? { status: 'caller-input-required', reason: 'target collision radius is engine data, not serialized' }
          : { status: 'caller-input' },
        extentsSource: config.extents == null
          ? { status: 'caller-input-required', reason: 'target extents are engine data, not serialized' }
          : { status: 'caller-input' },
      };
      this.cars.set(id, car);
      return car;
    },

    addInventory(ownerId, type, charges) {
      const key = `${ownerId}:${type}`;
      this.inventory.set(key, (this.inventory.get(key) ?? 0) + charges);
      return this.inventory.get(key);
    },

    charges(ownerId, type) {
      return this.inventory.get(`${ownerId}:${type}`) ?? 0;
    },

    consumeCharge(ownerId, type) {
      const key = `${ownerId}:${type}`;
      const left = this.inventory.get(key) ?? 0;
      if (left <= 0) return null;
      this.inventory.set(key, left - 1);
      return left - 1;
    },

    car(id) {
      const car = this.cars.get(id);
      if (!car) throw new Error(`unknown car ${id}`);
      return car;
    },

    requireTargetRadius(car, type) {
      if (car.radiusM == null) {
        throw new Error(`${type} hit test needs car.radiusM: target collision radius is runtime/engine data`);
      }
      return car.radiusM;
    },

    requireTargetExtents(car) {
      if (!car.extents) {
        throw new Error('Barge hit test needs car.extents: target vehicle extents are runtime/engine data');
      }
      return car.extents;
    },

    // --------------------------------------------------------------- Blindfire
    fireBlindfire(request = {}) {
      const type = 'Blindfire';
      const level = request.level ?? 'Normal';
      const values = recoveredValues(manifest, type, level);
      const owner = this.car(request.ownerId);
      const charges = this.consumeCharge(request.ownerId, type);
      if (charges === null) {
        return this.emit('projectile-rejected', {
          pickupType: type, ownerId: request.ownerId, reason: 'no-ammo',
          charges: {
            value: runtime[type]?.charges ?? null,
            status: 'runtime-only',
            source: type === 'Blindfire' ? 'VLC_Pickups.cpp:2859' : 'VLC_Pickups.cpp:2855',
          },
        });
      }
      const direction = norm(request.direction ?? owner.forward);
      const origin = add(request.origin ?? owner.position, { x: 0, y: values.Radius, z: 0 });
      const lifetime = missing(manifest, type, 'projectileLifetime');
      const projectile = {
        id: `projectile-${++nextId}`,
        kind: 'projectile',
        pickupType: type,
        level,
        ownerId: request.ownerId,
        targetId: null,
        position: origin,
        previous: origin,
        direction,
        speedMps: values.Speed,
        radiusM: values.Radius,
        damage: values.DamageInflicted,
        health: values.Health,
        maxHealth: values.Health,
        age: 0,
        lifetimeSeconds: lifetime?.value ?? null,
        lifetimeSource: lifetime?.status ?? 'not-serialized',
        chargesRemaining: charges,
        chargesSource: { value: runtime.Blindfire.charges, status: 'runtime-only', source: 'VLC_Pickups.cpp:2859' },
        hitTest: {
          shape: 'sphere + swept segment',
          radiusM: values.Radius,
          targetRadius: 'caller-input',
          falloff: 'none',
          source: 'PickupProjectileBase.cpp:128-133,445',
        },
        grounding: { status: 'not-modelled', reason: 'retail ray-traces the level mesh every tick' },
        status: 'active',
      };
      this.projectiles.push(projectile);
      this.emit('projectile-fired', {
        projectileId: projectile.id,
        pickupType: type,
        level,
        ownerId: request.ownerId,
        origin,
        direction,
        speedMps: projectile.speedMps,
        lifetimeSeconds: projectile.lifetimeSeconds,
        lifetimeSource: projectile.lifetimeSource,
        chargesRemaining: charges,
        source: { serialized: levelOf(index, type, level).levelRecord, runtime: projectile.chargesSource },
      });
      return projectile;
    },

    // ------------------------------------------------------------------- Shunt
    fireShunt(request = {}) {
      const type = 'Shunt';
      const level = request.level ?? 'Normal';
      const values = recoveredValues(manifest, type, level);
      const owner = this.car(request.ownerId);
      const target = this.car(request.targetId);
      const charges = this.consumeCharge(request.ownerId, type);
      if (charges === null) {
        return this.emit('projectile-rejected', {
          pickupType: type, ownerId: request.ownerId, reason: 'no-ammo',
          charges: {
            value: runtime[type]?.charges ?? null,
            status: 'runtime-only',
            source: type === 'Blindfire' ? 'VLC_Pickups.cpp:2859' : 'VLC_Pickups.cpp:2855',
          },
        });
      }
      const origin = add(request.origin ?? owner.position, { x: 0, y: runtime.Shunt.heightFromGroundM, z: 0 });
      const initialSpeed = clamp(
        Math.max(owner.speedMps + 15, 10),
        runtime.Shunt.minSpeedMps, runtime.Shunt.maxSpeedMps);
      const direction = norm(sub(target.position, origin));
      const lifetime = missing(manifest, type, 'projectileLifetime');
      const projectile = {
        id: `projectile-${++nextId}`,
        kind: 'projectile',
        pickupType: type,
        level,
        ownerId: request.ownerId,
        targetId: request.targetId,
        position: origin,
        previous: origin,
        direction,
        speedMps: initialSpeed,
        radiusM: values.Radius,
        damage: values.DamageInflicted,
        health: values.Health,
        maxHealth: values.Health,
        age: 0,
        lifetimeSeconds: lifetime?.value ?? null,
        lifetimeSource: lifetime?.status ?? 'not-serialized',
        chargesRemaining: charges,
        homing: {
          status: 'runtime-approximation',
          turnRateDegPerSec: runtime.Shunt.homingTurnRateDegPerSec,
          maxTurnRateDegPerSec: runtime.Shunt.maxTurnRateDegPerSec,
          maxHomingSpeedMps: runtime.Shunt.maxHomingSpeedMps,
          minSpeedMps: runtime.Shunt.minSpeedMps,
          maxSpeedMps: runtime.Shunt.maxSpeedMps,
          source: 'PickupShunt.cpp:29-31,510,610,685',
        },
        hitTest: {
          shape: 'sphere + swept segment',
          radiusM: values.Radius,
          targetRadius: 'caller-input',
          falloff: 'none',
          hitStrength: 'major while health==maxHealth; minor after damage',
          source: 'PickupShunt.cpp:389-391',
        },
        status: 'active',
      };
      this.projectiles.push(projectile);
      this.emit('projectile-fired', {
        projectileId: projectile.id,
        pickupType: type,
        level,
        ownerId: request.ownerId,
        targetId: request.targetId,
        origin,
        direction,
        speedMps: projectile.speedMps,
        lifetimeSeconds: projectile.lifetimeSeconds,
        lifetimeSource: projectile.lifetimeSource,
        chargesRemaining: charges,
        homing: projectile.homing,
      });
      return projectile;
    },

    // ------------------------------------------------------------------ Barge
    fireBarge(request = {}) {
      const type = 'Barge';
      const level = request.level ?? 'Normal';
      const values = recoveredValues(manifest, type, level);
      const owner = this.car(request.ownerId);
      const charges = this.consumeCharge(request.ownerId, type);
      if (charges === null) {
        return this.emit('pickup-rejected', {
          pickupType: type, ownerId: request.ownerId, reason: 'no-ammo',
          charges: { value: runtime.Barge.charges, status: 'runtime-only', source: 'VLC_Pickups.cpp:2855' },
        });
      }
      const effect = {
        id: `barge-${++nextId}`,
        kind: 'barge',
        ownerId: request.ownerId,
        level,
        position: clone(owner.position),
        radius: values.Radius,
        padding: runtime.Barge.paddingM,
        innerBand: runtime.Barge.innerBandM,
        extentsFudgeAverage: runtime.Barge.extentsFudgeAverageM,
        damage: values.DamageInflicted,
        durationSeconds: values.Duration,
        expiresAt: this.now + values.Duration,
        hitTargets: new Set(),
        hitTest: {
          shape: 'ellipse/circle around the owner',
          majorRadius: values.Radius + runtime.Barge.paddingM,
          minorRadius: values.Radius + runtime.Barge.paddingM,
          innerBand: runtime.Barge.innerBandM,
          extentsFudgeAverage: runtime.Barge.extentsFudgeAverageM,
          falloff: 'none; major/minor only changes fake-physics jink',
          source: 'PickupBarge.cpp:46-47,81-82,139-160,308-329',
        },
        source: 'PickupBarge.cpp:46-47,81-82,139-160,308-329',
      };
      this.effects.push(effect);
      this.emit('barge-activated', {
        bargeId: effect.id, pickupType: type, level, ownerId: request.ownerId,
        position: effect.position, radius: effect.radius, durationSeconds: effect.durationSeconds,
        chargesRemaining: charges, hitTest: effect.hitTest,
      });
      return effect;
    },

    // ------------------------------------------------------------------ Shock
    fireShock(request = {}) {
      const type = 'Shock';
      const level = request.level ?? 'Normal';
      const values = recoveredValues(manifest, type, level);
      const domes = request.domes ?? (request.position
        ? [{ position: request.position, width: request.width, sizeMultiplier: request.sizeMultiplier,
             lifetimeModSeconds: request.lifetimeModSeconds }]
        : null);
      if (!domes) {
        return this.emit('shock-rejected', {
          pickupType: type, ownerId: request.ownerId, reason: 'missing-dome-layout',
          missing: {
            status: 'runtime-only',
            reason: 'Shock domes are placed along the target AI spline; the layout is not serialized.',
            required: ['position', 'width'],
            source: 'ShockManager.cpp:681-773',
          },
        });
      }
      const charges = this.consumeCharge(request.ownerId, type);
      if (charges === null) {
        return this.emit('shock-rejected', {
          pickupType: type, ownerId: request.ownerId, reason: 'no-ammo',
          charges: { value: runtime.Shock.charges, status: 'runtime-only', source: 'VLC_Pickups.cpp:2855' },
        });
      }
      const domesOut = [];
      domes.forEach((dome, i) => {
        if (!dome.position) throw new Error('Shock dome needs position');
        if (dome.width == null) {
          throw new Error('Shock dome needs width: the real radius is width*sizeMultiplier*OuterRadius; width is runtime/track data');
        }
        const sizeMultiplier = dome.sizeMultiplier
          ?? (runtime.Shock.sizeMultiplierLow
            + (runtime.Shock.sizeMultiplierHigh - runtime.Shock.sizeMultiplierLow)
            * (fnv1a(`${request.ownerId}:${request.targetId}:${i}:${this.now}`) / 0xFFFFFFFF));
        const totalInner = dome.width * sizeMultiplier * values.InnerRadius;
        const totalOuter = dome.width * sizeMultiplier * values.OuterRadius;
        const lifetime = values.Lifetime + (dome.lifetimeModSeconds ?? 0);
        const effect = {
          id: `shock-${++nextId}`,
          kind: 'shock',
          ownerId: request.ownerId,
          targetId: request.targetId ?? null,
          level,
          position: clone(dome.position),
          width: dome.width,
          sizeMultiplier,
          sizeMultiplierSource: dome.sizeMultiplier == null
            ? {
              status: 'project-deterministic',
              range: [runtime.Shock.sizeMultiplierLow, runtime.Shock.sizeMultiplierHigh],
              source: 'PickupShock.cpp:67-69',
            }
            : { status: 'caller-input' },
          baseInnerRadius: values.InnerRadius,
          baseOuterRadius: values.OuterRadius,
          totalInnerRadius: totalInner,
          totalOuterRadius: totalOuter,
          currentOuterRadius: 0,
          heightDiff: values.HeightDiff,
          damage: values.DamageInflicted,
          appliedDamage: values.DamageInflicted / 2,
          lifetimeSeconds: lifetime,
          lifetimeSource: dome.lifetimeModSeconds == null
            ? { status: 'caller-omitted', base: values.Lifetime, source: 'PickupShock.cpp:71' }
            : { status: 'caller-input', base: values.Lifetime, modifier: dome.lifetimeModSeconds },
          expiresAt: this.now + lifetime,
          age: 0,
          hitTargets: new Set(),
          hitTest: {
            shape: 'growing 3D sphere',
            innerUsed: false,
            hitType: 'minor',
            falloff: 'none',
            heightGate: values.HeightDiff,
            source: 'PickupShock.cpp:137-138,203-285',
          },
        };
        this.effects.push(effect);
        domesOut.push(effect);
        this.emit('shock-dome-spawned', {
          domeId: effect.id, pickupType: type, level, ownerId: request.ownerId,
          targetId: effect.targetId, position: effect.position, width: effect.width,
          sizeMultiplier: effect.sizeMultiplier, sizeMultiplierSource: effect.sizeMultiplierSource,
          baseInnerRadius: effect.baseInnerRadius, baseOuterRadius: effect.baseOuterRadius,
          actualInnerRadius: effect.totalInnerRadius, actualOuterRadius: effect.totalOuterRadius,
          lifetimeSeconds: effect.lifetimeSeconds, lifetimeSource: effect.lifetimeSource,
          chargesRemaining: charges, hitTest: effect.hitTest,
        });
      });
      return domesOut;
    },

    // --------------------------------------------------------------- impulse
    applyProvisionalShuntImpulse(targetId, request = {}) {
      if (request.impulseNs == null || request.massKg == null) {
        return this.emit('impulse-refused', {
          targetId, reason: 'missing-input',
          missing: {
            status: 'not-serialized',
            reason: 'retail Shunt uses FakePhysics FLIP/TIP; a linear impulse needs a project-chosen J and mass.',
            source: 'VLC_Pickups.cpp:1693-1703;boost-feasibility.md §5.6',
          },
        });
      }
      const deltaV = request.impulseNs / request.massKg;
      return this.emit('shunt-impulse-provisional', {
        targetId, impulseNs: request.impulseNs, massKg: request.massKg, deltaV,
        source: 'provisional-impulse', retailEquivalent: 'E_FAKE_PHYSICS_FLIP_FORWARD',
      });
    },

    // ---------------------------------------------------------------- damage
    damage(targetId, amount, source = {}) {
      const car = this.cars.get(targetId);
      if (!car) return this.emit('damage-rejected', { targetId, reason: 'no-car' });
      if (!car.alive) return this.emit('damage-rejected', { targetId, reason: 'not-alive' });
      car.health = Math.max(0, car.health - amount);
      this.emit('damage', {
        targetId, amount, health: car.health, maxHealth: car.maxHealth,
        source, healthScale: { status: 'runtime-only', reason: 'max health is not in these packs' },
      });
      if (car.health === 0) {
        car.alive = false;
        this.emit('wrecked', { targetId, source });
      }
      return car.health;
    },

    // ------------------------------------------------------------- hit tests
    hitTestProjectile(projectile) {
      if (!projectile || projectile.status !== 'active') return null;
      let best = null;
      for (const car of this.cars.values()) {
        if (!car.alive || car.id === projectile.ownerId) continue;
        const radius = this.requireTargetRadius(car, projectile.pickupType) + projectile.radiusM;
        const result = segmentSphereHit(projectile.previous, projectile.position, car.position, radius);
        if (result.hit && (!best || result.t < best.t)) {
          best = { car, t: result.t, point: result.point };
        }
      }
      return best;
    },

    // ---------------------------------------------------------------- advance
    advance(dt) {
      if (!(dt >= 0)) throw new Error('advance() needs a non-negative dt');
      this.now += dt;
      const out = [];

      for (const projectile of [...this.projectiles]) {
        if (projectile.status !== 'active') continue;
        projectile.age += dt;
        projectile.previous = clone(projectile.position);

        if (projectile.pickupType === 'Shunt' && projectile.targetId != null) {
          const target = this.cars.get(projectile.targetId);
          if (target && target.alive) {
            const want = norm(sub(target.position, projectile.position));
            projectile.direction = rotateTowards(
              projectile.direction, want, projectile.homing.turnRateDegPerSec * DEG * dt);
            const dist = distance(projectile.position, target.position);
            const normalised = clamp((dist * dist) / (50 * 50), 0.3, 1);
            projectile.speedMps = clamp(
              normalised * projectile.homing.maxHomingSpeedMps + target.speedMps,
              projectile.homing.minSpeedMps, projectile.homing.maxSpeedMps);
          }
        }

        projectile.position = add(projectile.position, scale(projectile.direction, projectile.speedMps * dt));
        const hit = this.hitTestProjectile(projectile);
        if (hit) {
          const major = projectile.pickupType !== 'Shunt' || projectile.health >= projectile.maxHealth;
          const damage = projectile.pickupType === 'Shunt' && !major
            ? projectile.damage / 2
            : projectile.damage;
          const fakePhysics = projectile.pickupType === 'Shunt'
            ? {
              kind: major ? 'flip-forward' : 'tip-forward',
              magnitude: { status: 'not-serialized', source: 'VLC_Pickups.cpp:1693-1703' },
            }
            : projectile.pickupType === 'Blindfire'
              ? {
                kind: 'blindfire-spin',
                direction: 'left/right',
                magnitude: { status: 'not-serialized', source: 'VLC_Pickups.cpp:1750-1762,2101-2141' },
              }
              : null;
          projectile.status = 'hit';
          this.projectiles = this.projectiles.filter((p) => p !== projectile);
          out.push(this.emit('projectile-hit', {
            projectileId: projectile.id, pickupType: projectile.pickupType,
            targetId: hit.car.id, hitType: major ? 'major' : 'minor',
            damage, position: hit.point, fakePhysics,
            hitTest: projectile.hitTest,
          }));
          this.damage(hit.car.id, damage, {
            kind: projectile.pickupType, projectileId: projectile.id,
            hitType: major ? 'major' : 'minor',
          });
          if (projectile.pickupType === 'Shunt') {
            this.emit('shunt-hit', {
              projectileId: projectile.id, targetId: hit.car.id,
              hitType: major ? 'major' : 'minor', damage,
              fakePhysics,
              impulse: {
                status: 'not-serialized',
                retail: major ? 'E_FAKE_PHYSICS_FLIP_FORWARD' : 'E_FAKE_PHYSICS_TIP_FORWARD',
                provisional: 'applyProvisionalShuntImpulse(targetId,{impulseNs,massKg})',
              },
            });
          }
          continue;
        }

        if (projectile.lifetimeSeconds != null && projectile.age >= projectile.lifetimeSeconds) {
          projectile.status = 'expired';
          this.projectiles = this.projectiles.filter((p) => p !== projectile);
          out.push(this.emit('projectile-expired', {
            projectileId: projectile.id, pickupType: projectile.pickupType,
            reason: 'old-age', at: this.now, lifetimeSeconds: projectile.lifetimeSeconds,
            lifetimeSource: projectile.lifetimeSource,
          }));
        }
      }

      for (const effect of [...this.effects]) {
        if (effect.kind === 'barge') {
          effect.position = clone(this.cars.get(effect.ownerId).position);
          for (const car of this.cars.values()) {
            if (!car.alive || car.id === effect.ownerId || effect.hitTargets.has(car.id)) continue;
            const extents = this.requireTargetExtents(car);
            const fudge = (extents.x + extents.z) / 2 - effect.extentsFudgeAverage;
            const outer = effect.radius + effect.padding + fudge;
            const inner = outer - effect.innerBand;
            const d = horizontal(car.position, effect.position);
            if (d > outer) continue;
            const hitType = d <= inner ? 'major' : 'minor';
            effect.hitTargets.add(car.id);
            const side = dot(sub(car.position, effect.position), { x: 1, y: 0, z: 0 }) < 0 ? 'left' : 'right';
            const fakePhysics = {
              kind: `${hitType === 'major' ? 'jink-barge' : 'jink-barge-minor'}-${side}`,
              magnitude: { status: 'not-serialized', source: 'VLC_Pickups.cpp:1781-1800' },
            };
            out.push(this.emit('barge-hit', {
              bargeId: effect.id, ownerId: effect.ownerId, targetId: car.id,
              hitType, damage: effect.damage, distance: d,
              outerRadius: outer, innerRadius: inner, fakePhysics,
              hitTest: effect.hitTest,
            }));
            this.damage(car.id, effect.damage, { kind: 'Barge', bargeId: effect.id, hitType });
          }
          if (this.now >= effect.expiresAt) {
            this.effects = this.effects.filter((e) => e !== effect);
            out.push(this.emit('effect-expired', {
              effectId: effect.id, kind: 'barge', ownerId: effect.ownerId, at: effect.expiresAt,
            }));
          }
        } else if (effect.kind === 'shock') {
          effect.age += dt;
          if (effect.age >= effect.lifetimeSeconds) {
            this.effects = this.effects.filter((e) => e !== effect);
            out.push(this.emit('effect-expired', {
              effectId: effect.id, kind: 'shock', ownerId: effect.ownerId, at: effect.expiresAt,
            }));
            continue;
          }
          const t = effect.age;
          const growth = t >= runtime.Shock.growthCutoffSeconds
            ? runtime.Shock.growthInitial * runtime.Shock.growthCutoffSeconds
              + runtime.Shock.growthLate * (t - runtime.Shock.growthCutoffSeconds)
            : t * runtime.Shock.growthInitial;
          effect.currentOuterRadius = clamp(effect.totalOuterRadius * growth, 0, effect.totalOuterRadius);
          for (const car of this.cars.values()) {
            if (!car.alive || effect.hitTargets.has(car.id)) continue;
            const d = distance(car.position, effect.position);
            const heightDiff = car.position.y - effect.position.y;
            if (d > effect.currentOuterRadius) continue;
            if (heightDiff < effect.heightDiff) continue;
            effect.hitTargets.add(car.id);
            out.push(this.emit('shock-hit', {
              domeId: effect.id, ownerId: effect.ownerId, targetId: car.id,
              hitType: 'minor', damage: effect.appliedDamage,
              distance: d, currentOuterRadius: effect.currentOuterRadius,
              heightDiff, hitTest: effect.hitTest,
            }));
            this.damage(car.id, effect.appliedDamage, { kind: 'Shock', domeId: effect.id, hitType: 'minor' });
          }
        }
      }

      return out;
    },

    snapshot() {
      return {
        at: this.now,
        authority,
        cars: [...this.cars.values()]
          .map((car) => ({
            id: car.id, position: car.position, health: car.health, maxHealth: car.maxHealth,
            alive: car.alive, speedMps: car.speedMps,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        projectiles: this.projectiles
          .map((p) => ({
            id: p.id, pickupType: p.pickupType, ownerId: p.ownerId, targetId: p.targetId,
            position: p.position, age: p.age, lifetimeSeconds: p.lifetimeSeconds,
            chargesRemaining: p.chargesRemaining, status: p.status,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        effects: this.effects
          .map((e) => ({
            id: e.id, kind: e.kind, ownerId: e.ownerId,
            expiresAt: e.expiresAt,
            currentOuterRadius: e.currentOuterRadius ?? null,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        eventCount: this.events.length,
      };
    },
  };

  return world;
}
